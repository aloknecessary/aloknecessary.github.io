---
title: "Event Schema Evolution and Contracts"
date: 2026-11-10
last_modified_at: 2026-11-10T18:21:42+05:30
author: Alok Ranjan Daftuar
description: "Adding a field is not always safe, and compatible depends on who upgrades first. This article covers compatibility modes, what each kind of schema change actually does to readers, tolerant reader patterns, CI gates with schema registries on AWS and Azure, and how to ship a breaking change without a flag day."
excerpt: "Whether a schema change is safe depends on who reads the data, which version they were built against, and whether the reader is strict or tolerant. An event schema is a public API with consumers you may not know about, and its old versions never fully go away."
keywords: "event schema evolution, schema registry, avro, protobuf, cloudevents, consumer contracts, backward compatibility, kafka, aws glue, azure event hubs"
twitter_card: "summary_large_image"
categories:
  - distributed-systems
tags: [event-driven-architecture, schema-evolution, avro, protobuf, schema-registry, cloudevents, contract-testing]
series: "Event-Driven Systems"
series_order: 3
---

A producer team adds a new value to an enum: `status` can now be `PARTIALLY_REFUNDED`. Nothing was removed, nothing was renamed, and the change is "purely additive." An hour after deployment, the billing consumer starts failing on every refund event. Its deserializer maps `status` to a strict enum, `PARTIALLY_REFUNDED` is not in it, and the handler throws before any business logic runs. Depending on the broker, the message is redelivered until it lands in a DLQ, or it stalls its partition and everything behind it.

The assumption that failed is "additive changes are safe." Whether a change is safe is not a property of the change. It depends on who reads the data, which version they were built against, and whether the reader is strict or tolerant. An event schema is a public API with consumers you may not know about, and unlike an HTTP API, its old versions never fully go away.

---

## Why event contracts are harder than API contracts

Three properties make events less forgiving:

- **Producers and consumers deploy independently.** There is no moment at which every consumer is on the new schema, so any producer change has to be safe for readers on the previous version.
- **Data outlives code.** A log with seven days of retention, a dead-letter queue holding week-old messages, or an archive in object storage means a *new* consumer will read data written under *old* schemas. Compatibility has to hold in both directions through time.
- **Replay multiplies versions.** Rebuilding a projection from the beginning means one consumer reading every schema version you have ever published.

Compatibility is therefore two questions: can new code read old data, and can old code read new data?

---

## Compatibility modes: who upgrades first

```text
BACKWARD: new reader, old data          FORWARD: old reader, new data
  consumer v2 ◀── data from v1 (OK)       consumer v1 ◀── data from v2 (OK)
  => upgrade CONSUMERS first              => upgrade PRODUCERS first

FULL: both hold  =>  any upgrade order
```

| Mode | Guarantee | Typical use |
| --- | --- | --- |
| BACKWARD | A reader on the new schema can read data written with the previous one | Consumers can be upgraded before producers |
| BACKWARD_TRANSITIVE | Same, against **all** earlier versions | A log with retention or replay, where new consumers read history |
| FORWARD | A reader on the old schema can read data written with the new one | Many consumers you cannot upgrade on demand |
| FULL / FULL_TRANSITIVE | Both directions, against the previous or all versions | Shared events with unknown consumers |
| NONE | No checks | Only for throwaway topics |

The non-transitive modes only compare against the previous version, so a schema can drift incompatibly across three versions while passing every individual check. For an event stream with replay or unknown consumers, `FULL_TRANSITIVE` is the safe default. It is also the most restrictive, so relax it deliberately per subject rather than by default. Mode names above follow the Confluent Schema Registry convention. AWS Glue Schema Registry uses the `_ALL` suffix for the transitive variants.

---

## What each kind of change actually does

These results hold for Avro, and mostly for Protobuf where noted:

| Change | Result | Notes |
| --- | --- | --- |
| Add a field **with a default** | Safe in both directions | Old readers ignore it; new readers fill the default for old data |
| Add a field **without a default** | Breaks BACKWARD | New readers cannot read old data that lacks the field |
| Remove a field that **had a default** | Safe | Without a default it breaks FORWARD, because old readers still expect it |
| Rename a field | Breaking | Avro aliases help readers resolve it; Protobuf is safe on the wire (fields are numbered) but breaks JSON mapping |
| Widen a type (`int` → `long`) | Allowed in Avro | Avro defines promotions; narrowing is never allowed |
| Add an enum value | Breaks old strict readers | Avro supports a reader-side enum `default` for unknown symbols; Protobuf enums are open on the wire, but your generated code or JSON mapper may still reject them |
| Make an optional field required | Breaking | Old data lacks it |
| Reuse a Protobuf field number | Corrupts data | Never reuse; mark numbers as `reserved` |
| Change what a field **means** | Passes every check | See below |

That last row is the one no registry can catch. If `amount` changes from cents to dollars, the type is still `long` and every compatibility mode says yes. The only defense is discipline: never change the meaning of an existing field. Add `amountMinor`, deprecate `amount`, and let consumers move.

The enum row is worth acting on from day one. Reserve an `UNKNOWN` symbol in version 1 and set it as the enum default, so new values never become a deserialization failure:

```json
{
  "type": "record", "name": "OrderEvent", "namespace": "com.example.orders",
  "fields": [
    { "name": "eventId", "type": "string" },
    { "name": "orderId", "type": "string" },
    { "name": "status", "type": {
        "type": "enum", "name": "OrderStatus",
        "symbols": ["UNKNOWN", "PLACED", "PAID", "SHIPPED", "PARTIALLY_REFUNDED"],
        "default": "UNKNOWN"
    }},
    { "name": "couponCode", "type": ["null", "string"], "default": null }
  ]
}
```

Here `PARTIALLY_REFUNDED` and `couponCode` are the two additions in version 2. Both are safe for old readers, because the enum has a reader-side default and the new field has a default of `null`.

Protobuf expresses the same ideas differently. Fields are identified by number, so renames are wire-safe, but deleting a field leaves a trap: a later developer reuses the number, and old data is silently decoded into the wrong field. Retire numbers explicitly, and make the zero value of every enum the "unknown" case, because Protobuf decodes an unrecognised enum value as its numeric value and an unset one as zero:

```proto
syntax = "proto3";

message OrderEvent {
  reserved 4;                  // was legacy_code
  reserved "legacy_code";      // block the name as well as the number

  string      event_id    = 1;
  string      order_id    = 2;
  OrderStatus status      = 3;
  optional string coupon_code = 5;   // added in v2; absent on old data
}

enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;      // the "unknown" fallback
  ORDER_STATUS_PLACED = 1;
  ORDER_STATUS_PAID = 2;
  ORDER_STATUS_PARTIALLY_REFUNDED = 3;
}
```

`optional` matters on `coupon_code`: it lets a reader distinguish "not sent" from "sent as empty," which a plain proto3 string cannot.

---

## Tolerant readers: the other half of the contract

A schema registry protects the producer side. The consumer side is code you write, and the rule is simple: be strict about what you need and tolerant about everything else. Ignore unknown fields. Map unknown enum values to a fallback instead of throwing. Fail only when a field you actually depend on is missing.

```ts
import { z } from "zod";

// Unknown values become "UNKNOWN" instead of a thrown error.
const OrderStatus = z.enum(["PLACED", "PAID", "SHIPPED", "PARTIALLY_REFUNDED"]).catch("UNKNOWN");

// z.object strips unrecognised keys by default, so new fields never break this reader.
const OrderEvent = z.object({
  eventId: z.string(),
  orderId: z.string(),
  status: OrderStatus,
});

const event = OrderEvent.parse(JSON.parse(body));
if (event.status === "UNKNOWN") return; // not a state this service reacts to: skip, don't fail
```

In .NET, `System.Text.Json`'s enum converter throws on unrecognised names, so deserialize the field as a `string` and use `Enum.TryParse` with an explicit `Unknown` member. The principle is identical: an event this consumer does not understand should be skipped or logged, never turned into a poison message.

---

## Carry the version with every message

You cannot decode historical events if the message does not say which schema wrote it. Two common mechanisms:

- **Registry wire format.** Confluent-style serializers prefix each message with a magic byte and a schema ID, and the deserializer fetches the schema by ID. This works across Kafka, MSK, and Event Hubs' Kafka endpoint.
- **An envelope.** For SQS, SNS, Service Bus, and EventBridge, which have no built-in registry hook, put the version in the message itself. CloudEvents defines a standard envelope for this:

```json
{
  "specversion": "1.0",
  "id": "evt-7f3a",
  "source": "/orders-service",
  "type": "com.example.orders.order-placed.v2",
  "time": "2026-11-09T10:15:00Z",
  "dataschema": "https://schemas.example.com/orders/order-placed/2.json",
  "datacontenttype": "application/json",
  "data": { "orderId": "o-123", "status": "PLACED" }
}
```

Put the major version in `type` and the exact schema in `dataschema`. Consumers can route on `type` and validate against `dataschema`. If you publish through an outbox, serialize and stamp the schema ID when the row is written, not when it is relayed, so a deployment between write and relay cannot change what a stored event means (the write side of this is covered in [the dual write article](/blogs/dual-write-problem-in-event-driven-architecture/)).

---

## Where the contract lives, and who owns it

Two organisational decisions determine whether the technical rules hold.

**Ownership.** The producing service owns the schema, and consumers do not get to edit it. Keep schemas in a dedicated repository, or a clearly separated directory, with `CODEOWNERS` pointing at the producing team so every change gets their review. Consumers contribute through contract tests and issues, not pull requests that alter the event.

**Subject granularity.** In a Confluent-style registry, compatibility is checked per *subject*, and the subject naming strategy decides what that means. The default, topic-name strategy, gives one schema lineage per topic, which assumes a topic carries one event type. If a topic carries several event types, such as `OrderPlaced` and `OrderCancelled` on one stream to preserve ordering between them, use a record-name or topic-record-name strategy so each type evolves under its own subject. Otherwise unrelated event types are forced into one schema, and "compatible" stops meaning anything.

Deprecation also needs a written policy: a field marked deprecated stays for a stated period, consumers are told, and removal follows the migration steps below instead of a calendar date. The value of a contract is that consumers can plan around it.

---

## Enforce it where the work happens

A policy nobody checks is a wish. Put the check where schema changes are made.

**On AWS**, Glue Schema Registry (Avro, JSON Schema, Protobuf) enforces the compatibility mode you set per schema at registration time: an incompatible new version fails to register. EventBridge's schema registry is a different tool, since it discovers schemas and generates code bindings but does not act as a compatibility gate.

**On Azure**, Schema Registry in Event Hubs namespaces stores versioned schemas by group. Check which compatibility rules your tier enforces, and keep a CI check regardless of what the registry does. Service Bus has no registry, so for queue and topic traffic the schema lives in your repository and the CI check is the only gate.

For Confluent-compatible registries, a pull-request gate looks like this:

```yaml
- name: Schema compatibility gate
  # SCHEMA_REGISTRY_URL and credentials come from the job's environment
  run: |
    jq -Rs '{schema: .}' schemas/order-events.avsc > payload.json
    ok=$(curl -sf -X POST \
      "$SCHEMA_REGISTRY_URL/compatibility/subjects/order-events-value/versions/latest" \
      -H "Content-Type: application/vnd.schemaregistry.v1+json" \
      -d @payload.json | jq -r .is_compatible)
    test "$ok" = "true"
```

The registry applies the compatibility level configured on the subject, so set it to `FULL_TRANSITIVE` there and the same request becomes a check against history. The pipeline fails before the schema is registered, which is far cheaper than finding out in production.

Registries check structure, not usage. To catch "someone still reads `legacyCode`," add **consumer-driven contract tests**: each consumer publishes the fields and values it relies on, and the producer's CI verifies those expectations against what it emits. Pact supports message-based contracts, not only HTTP ones.

---

## Shipping a breaking change without a flag day

Sometimes a change cannot be made compatible: a split of one event into two, or a changed meaning. Treat it as a migration, not a deploy.

1. **Publish the new version alongside the old.** Introduce `order-placed.v2` as a new event type or topic. The producer emits both, derived from the same source of truth.
2. **Migrate consumers at their own pace.** Each moves to v2 when ready, with no coordination needed.
3. **Measure, don't assume.** Have consumers emit a metric labeled with the schema version they read. When v1 reads reach zero across all consumer groups, you know.
4. **Retire v1 last, and consider the data.** Stop publishing v1 only after consumers are off it. Keep in mind that v1 events remain in any retained log and archive. A future replay may still need a reader that understands them, so keep the v1 schema registered even when no producer emits it.

---

## What kind of change is it?

| Change | Approach |
| --- | --- |
| Add an optional field | Give it a default; ship it |
| Add an enum value | Safe only if consumers have a fallback; reserve `UNKNOWN` from v1 |
| Rename or remove a field | Add the new field, deprecate the old, remove after consumers move |
| Change a type's meaning | New field name; never redefine an existing one |
| Split, merge, or restructure events | New versioned type; publish both; migrate; retire |

---

> 📌 **Key Takeaway:** Compatibility is not a property of a change but of the pair of reader and writer versions, across time. Default to `FULL_TRANSITIVE` for shared events, write tolerant readers that skip what they do not understand, carry the schema version in every message, gate changes in CI, and handle breaking changes as a parallel-publish migration.
