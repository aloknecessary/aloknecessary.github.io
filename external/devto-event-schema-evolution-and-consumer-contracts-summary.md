---
title: "Event Schema Evolution and Contracts"
published: false
description: Adding a field is not always safe, and compatible depends on who upgrades first. Compatibility modes, tolerant readers, CI gates with schema registries on AWS and Azure, and how to ship a breaking change without a flag day.
tags: kafka, distributed-systems, devops, architecture
canonical_url: https://aloknecessary.in/blogs/event-schema-evolution-and-consumer-contracts/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=event-schema-evolution-and-consumer-contracts
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of an event schema versioning system. Multiple glowing schema versions branching outward from a central event stream, with producer and consumer nodes connected by directional arrows showing compatibility directions. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

A producer team adds a new value to an enum — `PARTIALLY_REFUNDED`. Nothing was removed, nothing was renamed. An hour after deployment, the billing consumer starts failing on every refund event. Its deserializer maps `status` to a strict enum, the new value isn't in it, and the handler throws before any business logic runs.

The assumption that failed is "additive changes are safe." Whether a change is safe is not a property of the change — it depends on who reads the data, which version they were built against, and whether the reader is strict or tolerant. An event schema is a public API with consumers you may not know about, and unlike an HTTP API, its old versions never fully go away.

---

## Why event contracts are harder than API contracts

Three properties make events less forgiving than HTTP APIs:

- **Producers and consumers deploy independently.** There is no moment at which every consumer is on the new schema, so any producer change has to be safe for readers on the previous version.
- **Data outlives code.** A log with seven days of retention, a dead-letter queue holding week-old messages, or an archive in object storage means a new consumer will read data written under old schemas.
- **Replay multiplies versions.** Rebuilding a projection from the beginning means one consumer reading every schema version ever published.

Compatibility is therefore two questions: can new code read old data, and can old code read new data?

---

## Compatibility modes: who upgrades first

```text
BACKWARD: new reader, old data          FORWARD: old reader, new data
  consumer v2 --- data from v1 (OK)       consumer v1 --- data from v2 (OK)
  => upgrade CONSUMERS first              => upgrade PRODUCERS first

FULL: both hold  =>  any upgrade order
```

| Mode | Guarantee | Typical use |
| --- | --- | --- |
| BACKWARD | New schema can read data written with the previous one | Upgrade consumers before producers |
| BACKWARD_TRANSITIVE | Same, against all earlier versions | Logs with retention or replay |
| FORWARD | Old schema can read data written with the new one | Many consumers you can't upgrade on demand |
| FULL / FULL_TRANSITIVE | Both directions | Shared events with unknown consumers |

The non-transitive modes only compare against the previous version — a schema can drift incompatibly across three versions while passing every individual check. For an event stream with replay or unknown consumers, `FULL_TRANSITIVE` is the safe default.

---

## What each kind of change actually does

| Change | Result |
| --- | --- |
| Add a field with a default | Safe in both directions |
| Add a field without a default | Breaks BACKWARD |
| Remove a field that had a default | Safe; without a default it breaks FORWARD |
| Rename a field | Breaking in Avro; wire-safe in Protobuf but breaks JSON mapping |
| Add an enum value | Breaks old strict readers unless a fallback is reserved |
| Change what a field means | Passes every check — the one no registry can catch |

The last row is the dangerous one. If `amount` changes from cents to dollars, the type is still `long` and every compatibility mode says yes. The only defence is discipline: never change the meaning of an existing field — add `amountMinor`, deprecate `amount`, and let consumers move.

Reserve an `UNKNOWN` enum symbol from version 1 so new values never become a deserialization failure:

```json
{
  "type": "record", "name": "OrderEvent",
  "fields": [
    { "name": "status", "type": {
        "type": "enum", "name": "OrderStatus",
        "symbols": ["UNKNOWN", "PLACED", "PAID", "SHIPPED", "PARTIALLY_REFUNDED"],
        "default": "UNKNOWN"
    }}
  ]
}
```

---

## Tolerant readers: the other half of the contract

A schema registry protects the producer side. The consumer side is code you write. The rule: be strict about what you need and tolerant about everything else.

```ts
const OrderStatus = z.enum(["PLACED", "PAID", "SHIPPED", "PARTIALLY_REFUNDED"]).catch("UNKNOWN");

const OrderEvent = z.object({
  eventId: z.string(),
  orderId: z.string(),
  status: OrderStatus,
});

const event = OrderEvent.parse(JSON.parse(body));
if (event.status === "UNKNOWN") return; // skip, don't fail
```

Unknown enum values become `"UNKNOWN"` instead of a thrown error. Unknown fields are stripped silently. An event this consumer doesn't understand should be skipped or logged — never turned into a poison message.

---

## Enforce it in CI

A policy nobody checks is a wish. For Confluent-compatible registries, a pull-request gate:

```yaml
- name: Schema compatibility gate
  run: |
    jq -Rs '{schema: .}' schemas/order-events.avsc > payload.json
    ok=$(curl -sf -X POST \
      "$SCHEMA_REGISTRY_URL/compatibility/subjects/order-events-value/versions/latest" \
      -H "Content-Type: application/vnd.schemaregistry.v1+json" \
      -d @payload.json | jq -r .is_compatible)
    test "$ok" = "true"
```

On AWS, Glue Schema Registry enforces the compatibility mode at registration time — an incompatible version fails to register. On Azure, Schema Registry in Event Hubs namespaces stores versioned schemas by group; Service Bus has no registry, so the CI check is the only gate.

Registries check structure, not usage. To catch "someone still reads `legacyCode`," add consumer-driven contract tests: each consumer publishes the fields it relies on, and the producer's CI verifies those expectations. Pact supports message-based contracts, not only HTTP ones.

---

## Shipping a breaking change without a flag day

Sometimes a change can't be made compatible. Treat it as a migration:

1. **Publish the new version alongside the old.** Introduce `order-placed.v2` as a new event type. The producer emits both.
2. **Migrate consumers at their own pace.** Each moves to v2 when ready, no coordination needed.
3. **Measure, don't assume.** Have consumers emit a metric labeled with the schema version they read. When v1 reads reach zero, you know.
4. **Retire v1 last — and consider the data.** Keep the v1 schema registered even when no producer emits it. A future replay may still need a reader that understands it.

---

## Read the Full Article

The summary covers the core patterns. The full article goes deeper on:

- Protobuf-specific rules: reserved field numbers, the `optional` keyword, and why the zero value of every enum must be the unknown case
- The CloudEvents envelope pattern for SQS, SNS, Service Bus, and EventBridge — brokers with no built-in registry hook
- Subject naming strategies in Confluent-style registries and why the default topic-name strategy breaks when a topic carries multiple event types
- Ownership and deprecation policy: who owns the schema, how consumers contribute through contract tests rather than PRs, and what a written deprecation timeline looks like

**👉 [Event Schema Evolution and Contracts — Full Article](https://aloknecessary.in/blogs/event-schema-evolution-and-consumer-contracts/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=event-schema-evolution-and-consumer-contracts)**
