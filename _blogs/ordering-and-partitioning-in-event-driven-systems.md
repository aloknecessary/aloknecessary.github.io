---
title: "Ordering and Partitioning in Event-Driven Systems"
date: 2026-10-27
last_modified_at: 2026-10-27T14:10:58+05:30
author: Alok Ranjan Daftuar
description: "'Process events in order' hides two decisions: in order relative to what, and at what throughput cost. How ordering scopes work in SQS FIFO, Service Bus sessions, Kafka, Event Hubs and Kinesis, how to pick the partition key, and where order still breaks."
excerpt: "'The events must be processed in order' is an unfinished sentence. This post covers how ordering scopes work across SQS FIFO, Service Bus sessions, Kafka, Event Hubs and Kinesis — how to pick the right partition key, size your lanes, and defend against the six places order breaks even when the broker is doing its job."
keywords: "event ordering, partition key, SQS FIFO, Service Bus sessions, Kafka partitioning, Event Hubs, Kinesis, event-driven architecture, message ordering, distributed systems"
twitter_card: "summary_large_image"
categories:
  - distributed-systems
tags: [event-driven-architecture, messaging, ordering, partitioning, sqs-fifo, service-bus-sessions, kafka, event-hubs, kinesis, distributed-systems]
series: "Event-Driven Systems"
series_order: 2
---

"The events must be processed in order." It sounds like a requirement. It is actually an unfinished sentence: in order *relative to what*, and at what cost?

A common outcome of leaving it unfinished: a team puts every payment event into an SQS FIFO queue with a single `MessageGroupId`, because "payments must be ordered." Within a message group, SQS will not hand out the next message until the previous one is deleted or its visibility timeout expires. With one group, the whole system is a single lane. If a handler takes 200 ms, throughput is roughly five messages per second, and adding consumers changes nothing because there is only one message in flight at a time. The queue behaves exactly as designed. The requirement was the problem.

What the payments team needed was ordering *per payment*, or per account. Event 7 for account A must not overtake event 6 for account A, but it has no relationship to anything that happens to account B. That is a much weaker guarantee, and it is the only kind that scales.

## Table of Contents

- [Ordering is a scope, never a global property](#ordering-is-a-scope-never-a-global-property)
- [Pick the narrowest key that protects your invariant](#pick-the-narrowest-key-that-protects-your-invariant)
- [One decision, three syntaxes](#one-decision-three-syntaxes)
- [The parallelism ceiling is a design decision](#the-parallelism-ceiling-is-a-design-decision)
- [Where order still breaks with the right key](#where-order-still-breaks-with-the-right-key)
- [Do not rely on order alone](#do-not-rely-on-order-alone)
- [Prove it before production does](#prove-it-before-production-does)
- [What do you actually need ordered?](#what-do-you-actually-need-ordered)

---

## Ordering is a scope, never a global property

Every broker that offers ordering offers it within a unit, and that same unit is also your unit of parallelism. You cannot have one without choosing the other.

| Service | Ordering unit | Set by | Parallelism unit |
| --- | --- | --- | --- |
| SQS FIFO / SNS FIFO | Message group | `MessageGroupId` | Number of distinct active groups |
| Service Bus (sessions) | Session | `SessionId` (entity needs `requiresSession`) | Concurrent sessions |
| Kafka / MSK | Partition | Message key hashed to a partition | Consumers in the group, up to partition count |
| Event Hubs | Partition | Partition key hashed to a partition | Consumers per consumer group, up to partition count |
| Kinesis Data Streams | Shard | Partition key hashed to a shard | Shards (one active reader per shard per consumer) |
| SQS Standard, SNS Standard, EventBridge, Event Grid | None | n/a | n/a |

```text
 events:  A1 B1 A2 C1 B2 A3          key = accountId

 hash(key) → partition / group / session

 partition 0:  A1 ─ A2 ─ A3   ──▶ consumer 1   (A's events in order)
 partition 1:  B1 ─ B2        ──▶ consumer 2   (B's events in order)
 partition 2:  C1             ──▶ consumer 3

 Order across A, B and C: not defined. Throughput: 3 lanes.
```

If you ask for "global order," what you are asking for is one lane: a single partition, a single message group, a single session. That is a legitimate choice for a tiny, low-volume stream, and a trap for anything else.

---

## Pick the narrowest key that protects your invariant

The key is the answer to the unfinished sentence. Ask which state transitions must be applied sequentially, and key on the entity that owns that state.

| Invariant you need | Key | Watch out for |
| --- | --- | --- |
| Order lifecycle events apply in sequence | `orderId` | Fine-grained, spreads evenly |
| Account balance changes never apply out of order | `accountId` | A few very active accounts become hot keys |
| Saga steps for one workflow execute in sequence ([see the saga article](/blogs/saga-orchestration-vs-choreography/)) | `sagaId` | Short-lived keys are fine |
| Per-tenant processing isolation | `tenantId` | One large tenant saturates one lane |
| Nothing depends on order | No key, or a random one | Use a standard queue or an unkeyed stream |

Two habits help. First, key on the **aggregate whose state you mutate**, not on a convenient field. Keying on `tenantId` because it is on every message is how one large customer ends up pinning a single partition while the rest sit idle. Second, treat a hot key as a design signal. If one key carries a disproportionate share of traffic, you can either choose a finer-grained key, which is only valid if the invariant allows it, or accept that this entity's throughput is bounded by one lane and make its handler faster. Salting a key (`accountId` + random suffix) spreads load but removes per-entity ordering, so only use it where order for that key genuinely does not matter.

A null key is the silent version of this mistake. In Kafka a message without a key is spread across partitions, so two events for the same order can land in different partitions and be consumed in any relative order.

---

## One decision, three syntaxes

### AWS: SQS FIFO

```ts
await sqs.send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify(event),
  MessageGroupId: event.orderId,        // ordering key; also your parallelism unit
  MessageDeduplicationId: event.eventId // 5-minute dedup window; or enable content-based dedup
}));
```

SQS FIFO queues have lower throughput ceilings than standard queues. High throughput mode raises them, but check current quotas before assuming a number. Parallelism comes from having many distinct active group IDs, so a high-cardinality key like `orderId` is what makes a FIFO queue scale.

### Azure: Service Bus sessions

```csharp
// Publisher: SessionId is the ordering key; MessageId feeds duplicate detection.
var msg = new ServiceBusMessage(payload) { SessionId = orderId, MessageId = eventId };
await sender.SendMessageAsync(msg);

// Consumer
var processor = client.CreateSessionProcessor("order-events", "billing",
    new ServiceBusSessionProcessorOptions
    {
        MaxConcurrentSessions = 8,        // parallelism = distinct sessions processed at once
        MaxConcurrentCallsPerSession = 1, // keep at 1: higher values process one session's messages concurrently
        SessionIdleTimeout = TimeSpan.FromSeconds(30)
    });
processor.ProcessMessageAsync += async args =>
{
    await Handle(args.Message);
    await args.CompleteMessageAsync(args.Message);
};
```

Two operational points. A session-enabled queue or subscription rejects messages that have no `SessionId`, and `requiresSession` should be treated as fixed at creation, so decide before you deploy. Also, a session is locked by one receiver at a time. If that receiver dies, the lock expires and another takes the session over, which is where duplicates come from.

### Kafka / MSK and Event Hubs

```properties
# Producer: ordering survives retries only if idempotence is on
enable.idempotence=true
acks=all
max.in.flight.requests.per.connection=5   # the maximum that stays order-safe with idempotence
```

The producer then sends with a key (`orderId`), and the default partitioner hashes it to a partition. Without idempotence, a retried batch can land behind a later one when more than one request is in flight, so a transient network error reorders your events. Recent Kafka clients enable idempotence by default, but set it explicitly so a config change or an older client cannot quietly remove it.

Event Hubs works the same way with a partition key. Prefer the partition key to addressing a partition ID directly: a fixed partition ID ties your producer's availability to that one partition. Kinesis follows the same shape, with the added detail that after a shard split, consumers must finish the parent shard before reading the children to keep per-key order, which the KCL does for you and hand-rolled readers often do not.

---

## The parallelism ceiling is a design decision

Per-key ordering means your maximum parallelism is the number of lanes:

- **Kafka and Event Hubs:** a consumer group can have at most as many active consumers as partitions. A thirteenth consumer on a twelve-partition topic sits idle.
- **SQS FIFO and Service Bus:** parallelism is the number of distinct active groups or sessions, so it depends on key cardinality at that moment, not on a setting.
- **Partition count is hard to change safely.** Kafka can add partitions but never remove them, and adding partitions changes the key-to-partition mapping, so events for the same key can now land in a different partition than their predecessors. Event Hubs Basic and Standard fix the count at creation.

Size partitions for the parallelism you will want in a year, not the parallelism you need this quarter: take your target peak throughput divided by what one consumer sustains, add headroom, and round up. If you must add partitions to a live Kafka topic, pause producers and let consumers drain first so no in-flight key straddles the change.

---

## Where order still breaks with the right key

Choosing the key correctly gets you broker-level order. The other places it can break are all in your code and configuration.

1. **Producer retries without idempotence** (above): the broker preserves the order it received, not the order you intended.
2. **Several producers for one entity.** Ordering is defined per producer connection. If two services publish events for the same `orderId`, arrival order at the broker decides the sequence, and no setting fixes that. Give each entity one owning publisher, or carry a version in the event.
3. **Rebalances and lock expiry.** When a partition moves or a session lock expires, the old consumer may still be finishing a message when the new one starts the next. You can get overlap or a repeat for the same key.
4. **Dead-letter behavior differs by broker.** In SQS FIFO, moving a message to the DLQ after `maxReceiveCount` lets later messages in that group proceed, so that one message is now out of order. In a log, the failing message blocks the partition instead. Decide which of those you prefer before you hit it in production.
5. **Events spread across topics or queues.** Ordering is defined inside one lane, never between lanes. If `OrderPlaced` goes through one topic and `PaymentCaptured` through another, no key setting makes the second arrive after the first. Either put causally related events on the same keyed stream, or make the consumer tolerate arriving early, for example by parking the event until its prerequisite state exists.
6. **Concurrency inside your handler.** The broker delivered in order, and your code destroyed it. This one is the most common:

```ts
// Broken: the batch arrives in order, Promise.all applies it in whatever order finishes first
await consumer.run({
  eachBatch: async ({ batch }) => {
    await Promise.all(batch.messages.map(m => handle(m)));
  },
});

// Correct: sequential per key, concurrent across keys
await consumer.run({
  eachBatch: async ({ batch }) => {
    const byKey = new Map<string, typeof batch.messages>();
    for (const m of batch.messages) {
      const k = m.key!.toString();
      byKey.set(k, [...(byKey.get(k) ?? []), m]);
    }
    await Promise.all([...byKey.values()].map(async msgs => {
      for (const m of msgs) await handle(m); // order within a key preserved
    }));
  },
});
```

---

## Do not rely on order alone

Because several of those failure modes sit outside the broker, the strongest design assumes order can occasionally break and checks for it. Put a monotonically increasing version on each entity's events and have the consumer apply an event only if it is the next one:

```sql
-- $1 = order_id, $2 = new status, $3 = event version
UPDATE order_projection
SET    status = $2, version = $3
WHERE  order_id = $1 AND version = $3 - 1;
-- 0 rows affected means either a duplicate (version <= current)
-- or a gap (version > current + 1): ignore the first, park or retry the second.
```

This turns "events must arrive in order" into "events must be applied in order, and anything else is detected." It also gives you the idempotency check from [the idempotency article](/blogs/idempotency-distributed-systems/) for free, since a redelivered event has a version that is no longer `current + 1`. The cost is that every event carries a per-entity sequence, so someone has to own generating it, usually the service that owns the aggregate.

---

## Prove it before production does

Ordering bugs rarely appear in a test environment, because one consumer, low load and no rebalances is the friendliest possible setup. The test that catches them does not need a broker. It feeds your handler the failure modes directly: for each entity, take a valid in-order sequence, shuffle it, duplicate some events, and check the final state.

```ts
test.each(range(200))("converges under reordering and duplication (seed %i)", async (seed) => {
  const rng = seeded(seed);
  const events = buildOrderLifecycle("order-1");            // versions 1..n, in order
  const delivered = shuffle(duplicateSome(events, rng), rng);

  for (const e of delivered) await applyWithRetryOnGap(e);  // gap => retried later, as in production

  expect(await loadProjection("order-1")).toEqual(finalStateOf(events));
});
```

The helpers are yours to write, but the shape matters: seeded randomness so a failure reproduces, many iterations because ordering bugs are probabilistic, and an assertion on the final state rather than on the sequence of calls. If the version check from the previous section is in place, this passes. If the consumer trusts the broker's order, it fails within a few seeds, and you find out in CI instead of from a customer with a negative balance.

Run the same idea at the integration level occasionally: kill a consumer mid-batch, or force a rebalance by scaling the group, while a producer keeps publishing keyed events. That exercises the rebalance and lock-handoff path, which is the one unit tests cannot reach.

---

## What do you actually need ordered?

| Requirement | Mechanism |
| --- | --- |
| Nothing depends on order | Standard queue or unkeyed stream; maximum throughput |
| Events for one entity apply in sequence | Key on the entity ID: message group, session, or partition key |
| Order must survive duplicates, retries and rebalances | Per-entity version check in the consumer, on top of keyed ordering |
| One strict global sequence | A single lane. Confirm the throughput budget first, then accept it knowingly |

---

> 📌 **Key Takeaway:** Ordering is a scope, and the scope is also your parallelism. Finish the sentence ("in order per what?"), key on the aggregate that owns the state, size the lanes for future parallelism, and assume order can still break in producers, rebalances and handlers. A version check in the consumer makes the guarantee yours instead of the broker's.
