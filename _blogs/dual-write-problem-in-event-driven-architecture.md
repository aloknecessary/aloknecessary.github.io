---
title: "Event-Driven Architecture: The Dual Write Problem and How to Solve It"
date: 2026-05-29
last_modified_at: 2026-05-29
author: Alok Ranjan Daftuar
description: "A deep dive into the dual write problem in event-driven microservices — why writing to a database and publishing an event without atomicity fails silently, and how to fix it with the Outbox Pattern, Change Data Capture, and Event Sourcing."
excerpt: "Writing to a database and publishing an event in the same operation without a transaction boundary is one of the most common correctness bugs in microservices. This post covers why it happens, the three solutions (Outbox Pattern, CDC with Debezium, Event Sourcing), and the operational concerns that determine which to choose."
keywords: "dual write problem, transactional outbox, change data capture, debezium, event sourcing, event-driven architecture, microservices, data consistency, kafka, distributed systems"
twitter_card: summary_large_image
categories:
  - architecture
  - system-design
tags: [event-driven, microservices, outbox-pattern, change-data-capture, distributed-systems, architecture, patterns, data-consistency, kafka, system-design]
series: "Distributed Systems"
series_order: 6
---

> Writing to a database and publishing an event in the same operation without a transaction boundary is one of the most common correctness bugs in microservices. Here is why it happens, why it is hard to see, and how to fix it permanently.

## The Bug That Looks Like Infrastructure

You have a well-designed order service. When an order is placed, it writes the order to the database and publishes an `OrderPlaced` event to Kafka so downstream services — fulfillment, billing, notifications — can react. Clean, decoupled, event-driven. Textbook architecture.

Then, at 2am on a Tuesday, your Kafka broker has a brief network hiccup. The database write succeeds. The event publish fails. The order exists in the database. Fulfillment never hears about it. The customer receives a confirmation email but their order never ships.

You investigate the next morning. The database looks fine. Kafka looks fine. The order is there. The event is not. No exception was thrown that anyone saw. No alert fired. Just a quietly broken order sitting in the database, going nowhere.

This is the dual write problem — and it is not a Kafka problem, a network problem, or an infrastructure problem. It is an **architectural correctness problem** that you introduced the moment you wrote to two separate systems in the same operation without a coordination mechanism.

> **Article context:** The reconciliation patterns in the [previous blog](/blogs/ai_assisted_data_reconciliation/) are often the downstream symptom of dual write failures upstream. Fix the dual write problem and you dramatically reduce the volume of inconsistencies that require AI-assisted reconciliation later.

### Table of Contents

- [The Bug That Looks Like Infrastructure](#the-bug-that-looks-like-infrastructure)
- [1. Understanding the Dual Write Problem](#1-understanding-the-dual-write-problem)
- [2. Solution 1 — The Transactional Outbox Pattern](#2-solution-1--the-transactional-outbox-pattern)
- [3. Solution 2 — Change Data Capture with Debezium](#3-solution-2--change-data-capture-with-debezium)
- [4. Solution 3 — Event Sourcing (When the Event Is the Truth)](#4-solution-3--event-sourcing-when-the-event-is-the-truth)
- [5. Choosing the Right Solution](#5-choosing-the-right-solution)
- [6. Operational Concerns](#6-operational-concerns)
- [The Dual Write Checklist](#the-dual-write-checklist)
- [Closing: One Write, One Truth](#closing-one-write-one-truth)

---

## 1. Understanding the Dual Write Problem

A dual write occurs any time your application writes to two separate systems as part of a single logical operation — without atomicity across both writes. The most common form in microservices:

```text
BEGIN
  INSERT INTO orders (id, status, ...) VALUES (...);   -- Write 1: Database
  kafka.publish('order.placed', { orderId, ... });      -- Write 2: Event broker
END
```

These two operations have no shared transaction boundary. They are independent network calls to independent systems. Four failure scenarios exist:

| Scenario | DB Write | Event Publish | Result |
| --- | --- | --- | --- |
| 1 — Happy path | ✅ Success | ✅ Success | Correct |
| 2 — Event failure | ✅ Success | ❌ Failure | **Silent data loss** — order exists, downstream never notified |
| 3 — DB failure | ❌ Failure | ✅ Success | **Ghost event** — event published for an order that doesn't exist |
| 4 — Process crash | ✅ Success | 💀 Never reached | Same as Scenario 2 |

Scenario 2 and 4 are the dangerous ones. They produce no error visible to the caller — the HTTP response returns 200, the client gets a success, and nothing downstream happens. Scenario 3 is equally damaging in the other direction: downstream services act on an event for an entity that does not exist in the source of truth.

### Why This Is Harder Than It Looks

The naive fix — wrap both writes in a try/catch and retry the event publish on failure — introduces a new problem: what if the DB write succeeded, the event publish failed, you retry, and now you publish the event twice? Your downstream services receive duplicate events and must be idempotent to handle them correctly. Which they often are not.

The slightly less naive fix — publish the event first, then write to the database — just reverses Scenario 2 and 3. You have not solved the problem; you have flipped which failure mode you are more exposed to.

The root cause is fundamental: **you cannot atomically commit to two independent systems without a distributed transaction**. And distributed transactions — 2-Phase Commit — are exactly the kind of coupling that microservices architecture exists to avoid, because they sacrifice availability and introduce distributed locking.

The solution is not to achieve atomicity across both systems. It is to **reduce the problem to a single atomic write and derive the event from it**.

---

## 2. Solution 1 — The Transactional Outbox Pattern

The Outbox Pattern is the most widely applicable solution. The core insight: instead of publishing an event directly to the broker, write the event as a row in an `outbox` table in the same database transaction as your business data write. A separate relay process then reads from the outbox and publishes to the broker.

```text
Application Transaction (single DB transaction)
  ├── INSERT INTO orders (id, status, ...) VALUES (...)
  └── INSERT INTO outbox (event_type, payload, created_at) VALUES ('OrderPlaced', {...}, NOW())

Outbox Relay (separate process)
  ├── SELECT * FROM outbox WHERE published = false ORDER BY created_at
  ├── kafka.publish(event_type, payload)
  └── UPDATE outbox SET published = true WHERE id = ?
```

Because both the order insert and the outbox insert happen in the same database transaction, they succeed or fail together. The dual write problem is eliminated at the application layer — there is now only one write that matters.

### Implementation — .NET with EF Core

```csharp
public class OutboxMessage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string EventType { get; set; }
    public string Payload { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool Published { get; set; } = false;
    public DateTime? PublishedAt { get; set; }
}

// In your order service command handler
public async Task Handle(PlaceOrderCommand command, CancellationToken ct)
{
    var order = Order.Create(command.CustomerId, command.Items);

    var outboxMessage = new OutboxMessage
    {
        EventType = "OrderPlaced",
        Payload = JsonSerializer.Serialize(new OrderPlacedEvent
        {
            OrderId = order.Id,
            CustomerId = order.CustomerId,
            TotalAmount = order.TotalAmount,
            PlacedAt = order.CreatedAt
        })
    };

    // Single transaction — both succeed or both fail
    await using var transaction = await dbContext.Database.BeginTransactionAsync(ct);
    try
    {
        dbContext.Orders.Add(order);
        dbContext.OutboxMessages.Add(outboxMessage);
        await dbContext.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
    }
    catch
    {
        await transaction.RollbackAsync(ct);
        throw;
    }
}
```

### The Outbox Relay — Polling vs. Log-Tailing

The relay process has two implementation strategies:

**Polling relay** — periodically queries the outbox table for unpublished messages and publishes them. Simple to implement, adds query load to the database, introduces publish latency proportional to the polling interval.

```csharp
public class OutboxRelayService : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var messages = await dbContext.OutboxMessages
                .Where(m => !m.Published)
                .OrderBy(m => m.CreatedAt)
                .Take(100)
                .ToListAsync(stoppingToken);

            foreach (var message in messages)
            {
                await kafkaProducer.ProduceAsync(
                    topic: message.EventType,
                    value: message.Payload,
                    cancellationToken: stoppingToken);

                message.Published = true;
                message.PublishedAt = DateTime.UtcNow;
            }

            await dbContext.SaveChangesAsync(stoppingToken);
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}
```

**Log-tailing relay (CDC-based)** — reads directly from the database write-ahead log (WAL) rather than polling a table. Zero-latency, no additional query load, but requires infrastructure for Change Data Capture. Covered in Solution 2 below.

### Delivery Guarantee: At-Least-Once

The Outbox Pattern guarantees **at-least-once delivery** — the relay may publish an event, crash before marking it published, and publish it again on restart. Your consumers must be idempotent. Use the `outbox.Id` as the event's idempotency key and deduplicate on the consumer side using a processed events table or an idempotency-aware message broker feature (Kafka's exactly-once semantics, SQS deduplication IDs).

---

## 3. Solution 2 — Change Data Capture with Debezium

Change Data Capture (CDC) eliminates the outbox relay entirely by reading directly from the database's transaction log. Every committed write — insert, update, delete — is captured as a change event and streamed to Kafka automatically. No application code changes required for event publishing.

### How It Works

Debezium connects to your database as a replica and tails the WAL (PostgreSQL), binlog (MySQL), or redo log (Oracle/SQL Server). Every committed transaction produces a structured change event that Debezium publishes to a Kafka topic.

```text
PostgreSQL WAL
     │
     ▼
Debezium Connector (Kafka Connect)
     │
     ▼
Kafka Topic: postgres.public.orders
     │
     ├── {op: "c", after: {id: "123", status: "placed", ...}}   ← INSERT
     ├── {op: "u", before: {...}, after: {status: "shipped"}}    ← UPDATE
     └── {op: "d", before: {id: "123", ...}}                     ← DELETE
```

### Debezium PostgreSQL Connector Configuration

```json
{
  "name": "orders-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres.internal",
    "database.port": "5432",
    "database.user": "debezium",
    "database.password": "${secret:db-password}",
    "database.dbname": "orders_db",
    "database.server.name": "orders",
    "table.include.list": "public.orders",
    "plugin.name": "pgoutput",
    "slot.name": "debezium_orders",
    "publication.name": "debezium_publication",
    "topic.prefix": "cdc",
    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",
    "heartbeat.interval.ms": "10000"
  }
}
```

### CDC Strengths and Trade-offs

| Aspect | Outbox Pattern | CDC with Debezium |
| --- | --- | --- |
| Application changes required | Yes — outbox writes in transaction | No — purely infrastructure |
| Publish latency | Polling interval (seconds) | Sub-second (WAL-based) |
| Exactly-once delivery | At-least-once | At-least-once |
| Operational complexity | Low | Medium-High |
| Works with any DB | Any ACID DB | Requires WAL access |
| Schema evolution | Controlled by app | Must handle raw DB schema |
| Event enrichment | Easy — in outbox payload | Requires stream processing |

**When to choose Outbox:** greenfield services, teams that want full control over event schema, environments where infrastructure complexity is a constraint.

**When to choose CDC:** legacy systems where adding outbox writes is impractical, high-throughput systems where polling latency is unacceptable, use cases where you need to capture all state changes including those made by DB migrations or admin tools.

---

## 4. Solution 3 — Event Sourcing (When the Event Is the Truth)

Both the Outbox Pattern and CDC treat the database as the source of truth and derive events from it. Event Sourcing inverts this entirely: **the event log is the source of truth**, and the database is a derived projection of it.

```text
Command → Aggregate → Domain Events (appended to event store)
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
             Read Model DB        Downstream Services
           (projection)           (event consumers)
```

There is no dual write problem in Event Sourcing because there is only one write: appending events to the event store. The read model and all downstream reactions are derived from that single authoritative log.

```csharp
public class OrderAggregate
{
    private readonly List<DomainEvent> _uncommittedEvents = new();

    public void PlaceOrder(Guid customerId, List<OrderItem> items)
    {
        // Validation logic...

        // Raise event — this is the only "write" that matters
        RaiseEvent(new OrderPlaced(
            OrderId: Id,
            CustomerId: customerId,
            Items: items,
            PlacedAt: DateTime.UtcNow
        ));
    }

    private void RaiseEvent(DomainEvent @event)
    {
        Apply(@event);               // update in-memory state
        _uncommittedEvents.Add(@event); // stage for persistence
    }
}

// In the command handler
var events = order.GetUncommittedEvents();
await eventStore.AppendAsync(order.Id, events, expectedVersion);
// Single atomic append — no dual write
```

### Trade-offs of Event Sourcing

Event Sourcing eliminates the dual write problem entirely but introduces significant architectural complexity — event schema versioning, aggregate rehydration from long event streams, eventual consistency in read models, and a steep learning curve for teams unfamiliar with the pattern. It is the right answer for domains where the history of state changes is as important as the current state (financial systems, audit-heavy domains, collaborative applications). It is significant over-engineering for a simple CRUD service.

---

## 5. Choosing the Right Solution

| Scenario | Recommended Solution |
| --- | --- |
| New microservice, full control over code | Outbox Pattern |
| Legacy service, cannot modify application code | CDC with Debezium |
| High-throughput, sub-second event latency required | CDC with Debezium |
| Domain requires full audit trail of state changes | Event Sourcing |
| Team already uses DDD and aggregates | Event Sourcing |
| Simple CRUD service with occasional events | Outbox Pattern |
| Multi-database transactions across services | Saga + Outbox Pattern |

---

## 6. Operational Concerns

### Outbox Table Housekeeping

Published outbox messages must be purged periodically — they are not your event log. Archive to cold storage if you need historical event data, but do not let the outbox table grow unbounded. A scheduled job or a database partition strategy (partition by `created_at`, drop old partitions) keeps it manageable.

```sql
-- Purge published messages older than 7 days
DELETE FROM outbox
WHERE published = true
  AND published_at < NOW() - INTERVAL '7 days';
```

### Debezium Replication Slot Management

PostgreSQL replication slots retain WAL segments until the consumer has processed them. A stuck or lagging Debezium connector will cause WAL accumulation and, eventually, disk exhaustion on your primary. Monitor `pg_replication_slots` lag as a first-class operational metric:

```sql
SELECT slot_name,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag_size,
       active
FROM pg_replication_slots
WHERE slot_type = 'logical';
```

Alert when lag exceeds your disk headroom threshold — not when the disk is full.

### Consumer Idempotency — The Non-Negotiable

Regardless of which solution you choose, at-least-once delivery means consumers will receive duplicates. Every consumer must implement idempotency. The simplest approach: a `processed_events` table keyed on event ID. Before processing, check if the event has been seen. After processing, record it — in the same transaction as the processing effect.

```sql
-- Consumer-side idempotency check
INSERT INTO processed_events (event_id, processed_at)
VALUES ($1, NOW())
ON CONFLICT (event_id) DO NOTHING;

-- If 0 rows affected, this event was already processed — skip
```

---

## The Dual Write Checklist

Before any event-producing service goes to production:

- [ ] **No direct dual writes** — application code never writes to DB and broker in the same operation without the Outbox Pattern
- [ ] **Outbox or CDC configured** — events are derived from a single atomic write, not two independent ones
- [ ] **Relay/connector monitored** — outbox relay lag and CDC connector health are first-class operational metrics
- [ ] **Consumer idempotency implemented** — every consumer handles duplicate events without side effects
- [ ] **Outbox housekeeping scheduled** — published messages are archived and purged on a regular cadence
- [ ] **Replication slot lag alarmed** — for CDC deployments, WAL accumulation triggers an alert before disk pressure
- [ ] **Event schema versioned** — events carry a schema version field; consumers handle backward compatibility explicitly

---

## Closing: One Write, One Truth

The dual write problem is seductive because the naive implementation is so simple. Two lines of code. It works 99.9% of the time. And the 0.1% of the time it fails, it fails silently in a way that is expensive to diagnose and expensive to recover from.

The Outbox Pattern, CDC, and Event Sourcing all solve the same underlying problem from different angles: **reduce every logical operation to a single atomic write, and derive everything else from it**. Pick the approach that fits your team's operational maturity and your service's domain complexity — but pick one deliberately, and do not leave dual writes in your critical path.

The data inconsistencies that AI-assisted reconciliation has to clean up downstream almost always trace back to a dual write that nobody caught at design time.

> **📌 Key Takeaway**
>
> You cannot reliably write to two independent systems atomically without distributed transactions. The correct solution is to eliminate the dual write entirely — commit a single atomic write to one system and derive all downstream state from it. The Outbox Pattern and CDC are the two most practical paths to get there.

---

*Further Reading: Richardson — Microservices Patterns Ch. 3 (Interprocess Communication), Kleppmann — Designing Data-Intensive Applications Ch. 11 (Stream Processing), Debezium Documentation — PostgreSQL Connector, Fowler — Event Sourcing Pattern (martinfowler.com)*
