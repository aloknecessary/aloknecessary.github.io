---
title: "Ordering and Partitioning in Event-Driven Systems"
published: false
description: "Process events in order" hides two decisions — in order relative to what, and at what throughput cost. Here's how ordering scopes work across SQS FIFO, Service Bus, Kafka, Event Hubs and Kinesis, and where order breaks even when the broker is doing its job.
tags: distributed-systems, event-driven-architecture, kafka, messaging
canonical_url: https://aloknecessary.in/blogs/ordering-and-partitioning-in-event-driven-systems/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=ordering-and-partitioning-in-event-driven-systems
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of event streams being partitioned and routed across parallel lanes. Multiple glowing data streams flow from a single source, each splitting into distinct colour-coded channels that converge into separate consumer nodes. The visual suggests controlled parallelism — order preserved within each lane, independent across lanes. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

"The events must be processed in order." It sounds like a requirement. It is actually an unfinished sentence: in order *relative to what*, and at what cost?

A common outcome of leaving it unfinished: a team puts every payment event into an SQS FIFO queue with a single `MessageGroupId`. Within a message group, SQS will not hand out the next message until the previous one is deleted or its visibility timeout expires. With one group, the whole system is a single lane — five messages per second if a handler takes 200 ms, and adding consumers changes nothing. The queue behaves exactly as designed. The requirement was the problem.

What the team needed was ordering *per payment*. Event 7 for account A must not overtake event 6 for account A, but it has no relationship to anything that happens to account B. That is a much weaker guarantee, and it is the only kind that scales.

---

## Ordering is a scope, not a global property

Every broker that offers ordering offers it within a unit — and that same unit is your unit of parallelism. You cannot have one without choosing the other.

| Service | Ordering unit | Set by | Parallelism unit |
| --- | --- | --- | --- |
| SQS FIFO / SNS FIFO | Message group | `MessageGroupId` | Number of distinct active groups |
| Service Bus (sessions) | Session | `SessionId` | Concurrent sessions |
| Kafka / MSK | Partition | Message key hashed to partition | Consumers in group, up to partition count |
| Event Hubs | Partition | Partition key hashed to partition | Consumers per consumer group |
| Kinesis Data Streams | Shard | Partition key hashed to shard | Shards (one active reader per shard) |
| SQS Standard, EventBridge, Event Grid | None | n/a | n/a |

If you ask for "global order," you are asking for one lane. That is a legitimate choice for a tiny, low-volume stream, and a trap for anything else.

---

## Pick the narrowest key that protects your invariant

The key is the answer to the unfinished sentence. Ask which state transitions must be applied sequentially, and key on the entity that owns that state.

| Invariant you need | Key |
| --- | --- |
| Order lifecycle events apply in sequence | `orderId` |
| Account balance changes never apply out of order | `accountId` |
| Saga steps for one workflow execute in sequence | `sagaId` |
| Per-tenant processing isolation | `tenantId` |
| Nothing depends on order | No key, or a random one |

Two habits help. First, key on the **aggregate whose state you mutate**, not on a convenient field. Keying on `tenantId` because it is on every message is how one large customer ends up pinning a single partition while the rest sit idle. Second, treat a hot key as a design signal — either choose a finer-grained key (only valid if the invariant allows it), or accept that this entity's throughput is bounded by one lane and make its handler faster.

A null key is the silent version of this mistake. In Kafka, a message without a key is spread across partitions, so two events for the same order can land in different partitions and be consumed in any relative order.

---

## One decision, three syntaxes

### AWS: SQS FIFO

```ts
await sqs.send(new SendMessageCommand({
  QueueUrl: queueUrl,
  MessageBody: JSON.stringify(event),
  MessageGroupId: event.orderId,        // ordering key; also your parallelism unit
  MessageDeduplicationId: event.eventId // 5-minute dedup window
}));
```

High-cardinality keys like `orderId` are what make a FIFO queue scale — parallelism comes from having many distinct active group IDs.

### Azure: Service Bus sessions

```csharp
var msg = new ServiceBusMessage(payload) { SessionId = orderId, MessageId = eventId };
await sender.SendMessageAsync(msg);

var processor = client.CreateSessionProcessor("order-events", "billing",
    new ServiceBusSessionProcessorOptions
    {
        MaxConcurrentSessions = 8,
        MaxConcurrentCallsPerSession = 1, // keep at 1 to preserve per-session order
        SessionIdleTimeout = TimeSpan.FromSeconds(30)
    });
```

A session-enabled queue rejects messages with no `SessionId`, and `requiresSession` is fixed at creation — decide before you deploy.

### Kafka / MSK and Event Hubs

```properties
enable.idempotence=true
acks=all
max.in.flight.requests.per.connection=5
```

Without idempotence, a retried batch can land behind a later one when more than one request is in flight — a transient network error silently reorders your events. Set it explicitly so a config change or an older client cannot quietly remove it.

---

## The parallelism ceiling is a design decision

Per-key ordering means your maximum parallelism is the number of lanes. A thirteenth consumer on a twelve-partition Kafka topic sits idle. Partition count is hard to change safely — adding partitions changes the key-to-partition mapping, so events for the same key can land in a different partition than their predecessors.

Size partitions for the parallelism you will want in a year: take your target peak throughput divided by what one consumer sustains, add headroom, and round up.

---

## Where order still breaks with the right key

Choosing the key correctly gets you broker-level order. The other places it breaks are all in your code and configuration:

1. **Producer retries without idempotence** — the broker preserves the order it received, not the order you intended.
2. **Several producers for one entity** — arrival order at the broker decides the sequence, and no setting fixes that.
3. **Rebalances and lock expiry** — the old consumer may still be finishing a message when the new one starts the next.
4. **Dead-letter behavior differs by broker** — SQS FIFO lets later messages in a group proceed after a DLQ move; Kafka blocks the partition instead.
5. **Events spread across topics or queues** — ordering is defined inside one lane, never between lanes.
6. **Concurrency inside your handler** — the broker delivered in order, and your code destroyed it:

```ts
// Broken: Promise.all applies in whatever order finishes first
await Promise.all(batch.messages.map(m => handle(m)));

// Correct: sequential per key, concurrent across keys
const byKey = new Map<string, typeof batch.messages>();
for (const m of batch.messages) {
  const k = m.key!.toString();
  byKey.set(k, [...(byKey.get(k) ?? []), m]);
}
await Promise.all([...byKey.values()].map(async msgs => {
  for (const m of msgs) await handle(m);
}));
```

---

## Read the Full Article

The full post covers:

- A complete broker comparison table with all five services side by side
- The version-check pattern that makes ordering a consumer-side guarantee rather than a broker-side assumption — and how it gives you idempotency for free
- A property-based test strategy that catches ordering bugs in CI before production does, using seeded randomness and many iterations
- The integration-level test approach for rebalance and lock-handoff paths that unit tests cannot reach
- A concise decision table mapping each ordering requirement to the right mechanism

**👉 [Ordering and Partitioning in Event-Driven Systems — Full Article](https://aloknecessary.in/blogs/ordering-and-partitioning-in-event-driven-systems/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=ordering-and-partitioning-in-event-driven-systems)**
