---
title: "Event-Driven Architecture: The Dual Write Problem and How to Solve It"
published: false
description: Why writing to a database and publishing an event without atomicity fails silently in microservices — and the three solutions that fix it permanently
tags: microservices, architecture, distributedsystems, eventdriven
canonical_url: https://aloknecessary.github.io/blogs/event-driven-architecture-the-dual-write-problem-and-how-to-solve-it/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=dual-write-problem
cover_image: 
---

You have a well-designed order service. It writes to the database and publishes an event to Kafka. Clean, decoupled, event-driven. Then Kafka has a brief network hiccup. The database write succeeds. The event publish fails. The order exists. Fulfillment never hears about it. No alert fires. Just a quietly broken order going nowhere.

This is the dual write problem — an **architectural correctness problem** that exists the moment you write to two separate systems without a coordination mechanism.

---

## The Problem

A dual write occurs when your application writes to two separate systems as part of a single logical operation without atomicity across both. The dangerous failure modes are silent — the HTTP response returns 200, the client gets a success, and nothing downstream happens.

The naive fixes don't work:
- **Try/catch with retry** — introduces duplicate events; consumers must be idempotent
- **Publish first, then write DB** — just reverses which failure mode you're exposed to
- **Distributed transactions (2PC)** — sacrifices availability and introduces distributed locking

The real solution: **reduce to a single atomic write and derive the event from it**.

---

## Solution 1: Transactional Outbox Pattern

Write the event as a row in an `outbox` table in the same database transaction as your business data. A separate relay process reads from the outbox and publishes to the broker.

- Both writes succeed or fail together (single DB transaction)
- Relay publishes and marks messages as published
- Guarantees at-least-once delivery — consumers must be idempotent

**Best for:** greenfield services, full control over event schema, teams wanting simplicity.

---

## Solution 2: Change Data Capture (Debezium)

Read directly from the database's transaction log (WAL/binlog). Every committed write is captured and streamed to Kafka automatically. No application code changes required.

- Sub-second publish latency (WAL-based, no polling)
- Captures all state changes including DB migrations and admin tools
- Requires infrastructure for Kafka Connect + Debezium

**Best for:** legacy systems, high-throughput services, capturing all state changes without code modification.

---

## Solution 3: Event Sourcing

The event log is the source of truth. The database is a derived projection. There is no dual write because there is only one write — appending events to the event store.

- Eliminates the problem entirely
- Introduces significant complexity (schema versioning, aggregate rehydration, eventual consistency)

**Best for:** domains where history of state changes matters (financial systems, audit-heavy domains).

---

## Operational Non-Negotiables

- **Consumer idempotency** — at-least-once delivery means duplicates will arrive. Deduplicate on event ID.
- **Outbox housekeeping** — purge published messages; don't let the table grow unbounded.
- **Replication slot monitoring** — for CDC, a stuck connector causes WAL accumulation and disk exhaustion.

---

## Read the Full Article

This is a summary of my deep dive into the dual write problem. The full article covers all three solutions with production implementation examples:

**👉 [The Dual Write Problem and How to Solve It — Full Article](https://aloknecessary.github.io/blogs/event-driven-architecture-the-dual-write-problem-and-how-to-solve-it/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=dual-write-problem)**

The full article includes:
- Four failure scenarios with a dual write matrix
- Transactional Outbox Pattern implementation (.NET with EF Core)
- Polling relay vs log-tailing relay comparison
- Debezium PostgreSQL connector configuration
- Event Sourcing with aggregate pattern (C#)
- Decision matrix for choosing between the three solutions
- Operational concerns: housekeeping, replication slot monitoring, consumer idempotency
- Production deployment checklist
