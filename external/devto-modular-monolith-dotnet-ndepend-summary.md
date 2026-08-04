---
title: "Enforcing Modular Monolith Boundaries in .NET: NDepend, Parallel Pipelines, and the Architecture That Holds"
published: false
description: "A production guide to .NET modular monoliths with enforced boundaries — solution structure, NDepend CQLinq rules, module-scoped DbContext, MediatR events, parallel CI pipelines, and Quality Gates."
canonical_url: "https://aloknecessary.github.io/blogs/modular-monolith-dotnet-ndepend/?utm_source=devto&utm_medium=crosspost&utm_campaign=modular-monolith-dotnet"
tags: dotnet, architecture, csharp, devops
cover_image:
---

> A modular monolith without enforcement is not an architecture — it is a monolith with good intentions.

## The Problem

Most teams skip the modular monolith and jump straight to microservices. The ones that do attempt a modular monolith rely on convention — "don't cross module boundaries" — which fails the moment deadlines hit.

The difference between a well-structured modular monolith and a mess is whether boundaries are maintained by **tooling** or by convention.

## The Solution Structure

Each module is a pair of .NET projects:

```text
src/Modules/
  Orders/
    YourApp.Orders/              ← internal: domain, application, infrastructure
    YourApp.Orders.Contracts/    ← public: DTOs, interfaces, events
  Payments/
    YourApp.Payments/
    YourApp.Payments.Contracts/
```

**The rule**: modules may only reference each other's `*.Contracts` projects. The compiler enforces this physically — no project reference means no type access.

## Four Layers of Enforcement

1. **Compiler** — project references prevent cross-module type access
2. **NetArchTest** — architecture tests fail the build on namespace-level violations
3. **NDepend CQLinq** — catches dependency cycles and coupling the compiler can't see
4. **Quality Gates** — block PRs that introduce *new* boundary violations

## Module-Scoped Data

Each module owns a dedicated `DbContext` with a schema prefix (`orders.*`, `payments.*`). No module queries another module's tables.

## Cross-Module Communication

Modules communicate via MediatR in-process events. Orders publishes `OrderPlaced`; Payments subscribes — without Orders knowing Payments exists.

This is also the extraction seam: when you eventually extract a module into a service, MediatR becomes a message broker. The event contract stays the same.

## Parallel CI

```yaml
strategy:
  matrix:
    module: [Orders, Payments, Inventory]
  fail-fast: false
```

Each module's tests run in parallel. CI time scales with the slowest module, not the total count.

## The Extraction Path

When a module genuinely needs independence:

1. Add outbox table → publish to real broker
2. Replace MediatR handlers with broker consumers
3. Deploy module as separate service
4. Publish `*.Contracts` as NuGet package

The boundary was already clean. Extraction is a deployment change, not a redesign.

---

The full post covers NDepend CQLinq rule examples, Quality Gate configuration, GitHub Actions pipeline YAML, test isolation patterns, and a production checklist.

👉 [Read the complete implementation guide](https://aloknecessary.github.io/blogs/modular-monolith-dotnet-ndepend/?utm_source=devto&utm_medium=crosspost&utm_campaign=modular-monolith-dotnet)
