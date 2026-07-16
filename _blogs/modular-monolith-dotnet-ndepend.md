---
title: "Enforcing Modular Monolith Boundaries in .NET: NDepend, Parallel Pipelines, and the Architecture That Holds"
date: 2026-07-16
last_modified_at: 2026-07-16
author: Alok Ranjan Daftuar
description: "A production implementation guide to building a .NET modular monolith with enforced boundaries — solution structure, NDepend CQLinq rules, module-scoped DbContext, MediatR in-process events, parallel GitHub Actions pipelines per module, and Quality Gates that fail the build before boundary violations reach main."
excerpt: "A modular monolith without enforcement is not an architecture — it is a monolith with good intentions. This post covers the full .NET implementation: solution structure, NDepend CQLinq rules, module-scoped DbContext, MediatR events, parallel CI pipelines, and Quality Gates that block boundary violations before they reach main."
keywords: "modular monolith, dotnet, ndepend, cqlinq, mediatr, github actions, clean architecture, module boundaries, parallel pipelines, quality gates"
categories:
  - architecture
  - dotnet
tags: [dotnet, modular-monolith, ndepend, architecture, csharp, github-actions, ci-cd, mediatr, clean-architecture, production]
---

## Introduction

The [Microservices by Default](/blogs/microservices-by-default/) post made the case for the modular monolith as the correct starting architecture for most .NET teams in 2026. The argument rests on one critical qualifier: *enforced* boundaries. A modular monolith without enforcement is not an architecture. It is a monolith with good intentions that will be a distributed monolith in eighteen months, when the team has taken enough shortcuts across module lines that decomposing it requires untangling a dependency graph no single engineer can hold in their head.

The difference between a well-structured modular monolith and a mess is not about deployment — it is about whether the boundaries are maintained by tooling or by convention. Convention fails. Tooling enforces.

This post covers the full implementation: how to structure a .NET solution so that the compiler enforces module boundaries, how to use NDepend's CQLinq rules to catch violations the compiler cannot, how to wire parallel GitHub Actions pipelines that build and test each module independently, and how to configure Quality Gates that block a merge before a boundary violation reaches main. The result is a single deployable that gives your team the structural discipline of microservices with none of the operational overhead — and a clean extraction path if and when a specific module genuinely warrants independence.

> **Related reading:** [Microservices by Default: The Organisational Constraints Nobody Puts in the Architecture Diagram](/blogs/microservices-by-default/) — the architectural decision framework that precedes this implementation guide. [Platform Engineering: Building the Internal Developer Platform](/blogs/platform-engineering/) — the platform layer that consumes this deployment model.

### Table of Contents

- [Introduction](#introduction)
- [1. Solution Structure — Physical Boundaries the Compiler Enforces](#1-solution-structure--physical-boundaries-the-compiler-enforces)
- [2. Module Contracts — The Only Cross-Module Dependency Allowed](#2-module-contracts--the-only-cross-module-dependency-allowed)
- [3. Module-Scoped DbContext — No Cross-Module Data Access](#3-module-scoped-dbcontext--no-cross-module-data-access)
- [4. In-Process Events With MediatR — Decoupled Cross-Module Communication](#4-in-process-events-with-mediatr--decoupled-cross-module-communication)
- [5. NDepend — Enforcing What the Compiler Cannot](#5-ndepend--enforcing-what-the-compiler-cannot)
- [6. Parallel CI/CD Pipelines Per Module](#6-parallel-cicd-pipelines-per-module)
- [7. The Extraction Path — When a Module Becomes a Service](#7-the-extraction-path--when-a-module-becomes-a-service)
- [Production Checklist](#production-checklist)

---

## 1. Solution Structure — Physical Boundaries the Compiler Enforces

The first enforcement layer is the solution structure itself. Each module is a set of .NET projects, not a folder within a single project. The compiler enforces project reference rules — a project that has no reference to another project cannot import its types, regardless of what a developer intends.

The structure that provides this enforcement:

```text
YourApp.sln
│
├── src/
│   ├── Host/
│   │   └── YourApp.Host/              ← single entry point; references all Module.Api projects
│   │
│   ├── Modules/
│   │   ├── Orders/
│   │   │   ├── YourApp.Orders/        ← internal: domain, application, infrastructure
│   │   │   └── YourApp.Orders.Contracts/  ← public: DTOs, interfaces, events
│   │   │
│   │   ├── Payments/
│   │   │   ├── YourApp.Payments/
│   │   │   └── YourApp.Payments.Contracts/
│   │   │
│   │   └── Inventory/
│   │       ├── YourApp.Inventory/
│   │       └── YourApp.Inventory.Contracts/
│   │
│   └── Shared/
│       └── YourApp.Shared/            ← cross-cutting: logging, auth, base classes only
│
└── tests/
    ├── YourApp.Orders.Tests/
    ├── YourApp.Payments.Tests/
    └── YourApp.Architecture.Tests/    ← NetArchTest boundary enforcement tests
```

**The rules this structure enforces physically:**

- `YourApp.Orders` has no project reference to `YourApp.Payments` or `YourApp.Inventory` — the compiler prevents any direct type reference between module internals
- `YourApp.Orders` may reference `YourApp.Payments.Contracts` — the Contracts project is the explicitly public interface
- `YourApp.Host` references all Contracts projects and wires modules via DI registration — it is the only project that sees all modules
- `YourApp.Shared` contains only truly cross-cutting concerns: logging abstractions, base entity types, auth middleware. It is not a dumping ground for anything a module does not want to own

The Contracts project pattern is the key decision. Every module exposes a Contracts project containing:

- DTOs for cross-module communication (what other modules can receive and return)
- Integration event definitions (what the module publishes — not the handlers)
- Public service interfaces (what other modules can depend on via DI)

Everything else — entities, repositories, domain services, EF DbContext, internal command/query handlers — lives in the module's non-Contracts project, marked `internal` wherever possible.

```csharp
// YourApp.Orders.Contracts — PUBLIC surface only
// DTOs, integration event types, and service interfaces that other modules may reference

namespace YourApp.Orders.Contracts;

public record OrderSummary(Guid OrderId, decimal Total, string Status);
public record OrderPlaced(Guid OrderId, Guid CustomerId, decimal Total, DateTime PlacedAt);
public interface IOrderService
{
    Task<OrderSummary?> GetOrderSummaryAsync(Guid orderId, CancellationToken ct = default);
}

// ---

// YourApp.Orders (implementation) — everything here is internal
// The compiler prevents any other project from importing these types
// unless that project has an explicit project reference to YourApp.Orders — which none do

namespace YourApp.Orders.Domain;

internal class Order
{
    public Guid Id { get; private set; }
    public decimal Total { get; private set; }
    public OrderStatus Status { get; private set; }
}
```

---

## 2. Module Contracts — The Only Cross-Module Dependency Allowed

The boundary rule is simple to state and easy to violate without enforcement: modules may only depend on each other's Contracts projects, never on their implementation projects.

NetArchTest provides the lightweight assertion library to codify this rule as a test that fails the build:

```csharp
// YourApp.Architecture.Tests/ModuleBoundaryTests.cs
public class ModuleBoundaryTests
{
    private static readonly string[] Modules =
        ["YourApp.Orders", "YourApp.Payments", "YourApp.Inventory"];

    [Fact]
    public void NoModule_ShouldReference_AnotherModule_Implementation()
    {
        foreach (var source in Modules)
        foreach (var target in Modules.Where(m => m != source))
        {
            var result = Types
                .InNamespace(source)
                .Should()
                .NotHaveDependencyOn(target)   // implementation namespace — not .Contracts
                .GetResult();

            Assert.True(result.IsSuccessful,
                $"{source} illegally depends on {target} internals. " +
                $"Use {target}.Contracts instead.");
        }
    }
}
```

These tests run in `YourApp.Architecture.Tests` as part of the standard test suite — no special tooling, no separate pipeline step. A boundary violation fails the test run the same way a failing unit test does. The feedback loop is immediate.

---

## 3. Module-Scoped DbContext — No Cross-Module Data Access

The single most violated boundary rule in practice: direct database access across module lines. One module's repository querying another module's tables. This produces implicit coupling at the data layer that is invisible to the compiler and invisible to NetArchTest — it shows up only as unexpected behaviour when one module's schema change breaks another module's queries.

Each module owns a dedicated `DbContext` scoped to its own schema prefix:

```csharp
// YourApp.Orders/Infrastructure/OrdersDbContext.cs
namespace YourApp.Orders.Infrastructure;

internal class OrdersDbContext : DbContext
{
    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options) { }

    internal DbSet<Order> Orders { get; set; } = null!;
    internal DbSet<OrderItem> OrderItems { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema("orders");   // all Orders tables: orders.*
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(OrdersDbContext).Assembly);
    }
}

// YourApp.Orders/OrdersModule.cs — module DI registration
public static class OrdersModule
{
    public static IServiceCollection AddOrdersModule(
        this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<OrdersDbContext>(options =>
            options.UseSqlServer(configuration.GetConnectionString("DefaultConnection")));
        services.AddScoped<IOrderService, OrderService>();
        return services;
    }
}

// YourApp.Host/Program.cs — the only place that sees all modules
app.Services
   .AddOrdersModule(configuration)
   .AddPaymentsModule(configuration)
   .AddInventoryModule(configuration);
```

The schema-per-module convention (`orders.*`, `payments.*`, `inventory.*`) makes cross-module data access visible in code review even without automated enforcement: a query against `payments.Transactions` in a class inside `YourApp.Orders` is immediately obviously wrong. Combined with the `internal` access modifier on DbContext, the compiler prevents another module's code from instantiating `OrdersDbContext` directly — it would need a project reference that the solution structure forbids.

---

## 4. In-Process Events With MediatR — Decoupled Cross-Module Communication

When Orders needs to notify Payments that an order has been placed, it cannot call `IPaymentService` directly — that would create a runtime dependency between modules that is invisible at compile time and makes extraction harder. Instead, modules communicate via in-process integration events, published through MediatR and consumed by whichever modules subscribe.

```csharp
// Publishing: Orders publishes an event without knowing who listens
namespace YourApp.Orders.Application;

internal class PlaceOrderCommandHandler : IRequestHandler<PlaceOrderCommand, Guid>
{
    private readonly OrdersDbContext _db;
    private readonly IPublisher _publisher;  // MediatR IPublisher — not a module reference

    public PlaceOrderCommandHandler(OrdersDbContext db, IPublisher publisher)
    {
        _db = db;
        _publisher = publisher;
    }

    public async Task<Guid> Handle(PlaceOrderCommand command, CancellationToken ct)
    {
        var order = Order.Create(command.CustomerId, command.Items);
        _db.Orders.Add(order);
        await _db.SaveChangesAsync(ct);

        // Publish the integration event defined in Orders.Contracts
        // Orders has no reference to Payments — it does not know Payments exists
        await _publisher.Publish(new OrderPlaced(order.Id, command.CustomerId,
            order.Total, DateTime.UtcNow), ct);

        return order.Id;
    }
}
```

```csharp
// Consuming: Payments subscribes without Orders knowing
namespace YourApp.Payments.Application;

// Payments references YourApp.Orders.Contracts to get the OrderPlaced event type
// It does NOT reference YourApp.Orders (the implementation)
internal class OrderPlacedHandler : INotificationHandler<OrderPlaced>
{
    private readonly PaymentsDbContext _db;

    public OrderPlacedHandler(PaymentsDbContext db) => _db = db;

    public async Task Handle(OrderPlaced notification, CancellationToken ct)
    {
        var pendingPayment = PendingPayment.CreateFor(
            notification.OrderId, notification.Total);
        _db.PendingPayments.Add(pendingPayment);
        await _db.SaveChangesAsync(ct);
    }
}
```

The dependency direction is correct: Payments depends on `YourApp.Orders.Contracts` (for the `OrderPlaced` event type) — not on `YourApp.Orders`. Orders depends on nothing from Payments. The event is the contract; MediatR is the in-process bus.

This pattern is also the extraction seam: when Payments is eventually extracted into a service, the in-process MediatR publish/subscribe is replaced by an outbox pattern publishing to a real message broker, and the `OrderPlaced` event definition stays in `YourApp.Orders.Contracts` and becomes the message schema. The event handler in Payments becomes a consumer of a topic rather than a MediatR notification handler. The contract is unchanged; only the transport changes.

---

## 5. NDepend — Enforcing What the Compiler Cannot

The compiler and NetArchTest enforce project-level dependency rules. NDepend enforces rules the compiler cannot see: namespace-level coupling that slips through even with correct project references, dependency cycles that are technically legal but architecturally damaging, and boundary rules expressed as CQLinq queries against the full dependency graph.

NDepend 2026 fully integrates with Visual Studio 2026, supports .NET 10.0 and C# 14, and introduces the concept of attribute tags — enabling queries against attribute argument values, not just attribute presence. The NDepend MCP Server is new in 2026: it enables AI coding assistants including Claude Code, GitHub Copilot, and JetBrains Junie to detect, browse, and automatically fix NDepend-identified violations.

### CQLinq Rules for Module Boundaries

NDepend's query language lets you write boundary rules as LINQ queries over the dependency graph. These run in CI via the NDepend GitHub Action and fail the build when violated:

```csharp
// NDepend CQLinq Rule: No direct dependency between module implementations
// Add these to your NDepend project (.ndproj) as custom rules

// Rule 1: Module implementations must not depend on each other
// (they may only depend on each other's .Contracts assemblies)
warnif count > 0
from t in JustMyCode.Types
where t.IsNotPublic  // internal types — the implementation layer
let modulePrefix = t.ParentNamespace?.Name?.Split('.').Take(2).Last()
from dependency in t.TypesUsed
where dependency.IsNotPublic
let depModulePrefix = dependency.ParentNamespace?.Name?.Split('.').Take(2).Last()
where modulePrefix != depModulePrefix
   && !dependency.ParentAssembly.Name.EndsWith(".Contracts")
   && !dependency.ParentAssembly.Name.EndsWith(".Shared")
select new { Type = t, IllegalDependency = dependency,
             Message = $"{t.FullName} depends on {dependency.FullName} — cross-module internal dependency" }

// Rule 2: No dependency cycles between modules
warnif count > 0
from a in Application.Assemblies
where a.Name.StartsWith("YourApp.") && !a.Name.EndsWith(".Contracts")
from cycle in a.AssembliesInCycle
select new { Assembly = a, Cycle = cycle,
             Message = $"Dependency cycle: {a.Name} ↔ {cycle.Name}" }
```

### Quality Gates

NDepend Quality Gates are the CI enforcement mechanism: a gate is a CQLinq query that must pass before a build is considered clean. The gates that matter for boundary enforcement:

```csharp
// Quality Gate: Zero new boundary violations since baseline
// Fails the build if any new cross-module internal dependency is introduced
failif count > 0
from i in Issues
where i.IsNew()   // new since the last analysis baseline
   && i.Rule.Name.Contains("Module")
select i

// Quality Gate: No new dependency cycles
failif count > 0
from a in Application.Assemblies
where a.IsNew() || a.WasChanged()
from cycle in a.AssembliesInCycle
select new { Assembly = a, CycleWith = cycle }
```

The `IsNew()` filter is the key. It means the gate fires on regressions, not on existing technical debt. A new join on a legacy boundary violation does not block the build — a new violation introduced in this PR does. This allows teams to incrementally clean up existing issues without being blocked by debt they inherited.

### Running NDepend in GitHub Actions

```yaml
# .github/workflows/ndepend-analysis.yml
name: NDepend Architecture Analysis

on:
  pull_request:
    paths:
      - 'src/**'
      - '**.cs'
      - '**.csproj'

jobs:
  ndepend:
    runs-on: windows-latest    # NDepend CLI requires Windows
    steps:
      - uses: actions/checkout@v6

      - name: Setup .NET
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'

      - name: Build solution
        run: dotnet build YourApp.sln --configuration Release

      - name: Run NDepend Analysis
        uses: ndepend/ndepend-action@v1
        with:
          licensekey: ${{ secrets.NDEPEND_LICENSE_KEY }}
          projectpath: 'YourApp.ndproj'
          coverageFiles: 'tests/**/coverage.opencover.xml'

      - name: Upload NDepend Report
        uses: actions/upload-artifact@v6
        if: always()
        with:
          name: ndepend-report-${{ github.run_id }}
          path: NDependOut/
          retention-days: 30
```

The NDepend action returns a non-zero exit code when Quality Gates fail, which fails the GitHub Actions job and blocks the PR merge. The uploaded report contains the full dependency graph, the specific violations, and the trend over time — useful for the architecture review that follows any Quality Gate failure.

---

## 6. Parallel CI/CD Pipelines Per Module

The deployment pipeline for a modular monolith does not need to be monolithic. Each module has its own tests, and those tests are independent — Orders tests do not need the Payments build to complete first. Running them in parallel recovers the CI speed that multi-project solutions lose as they grow.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  # Matrix strategy: each module tests in its own parallel runner
  test-modules:
    name: Test ${{ matrix.module }} Module
    runs-on: ubuntu-latest
    strategy:
      matrix:
        module: [Orders, Payments, Inventory]
      fail-fast: false   # don't cancel other modules if one fails
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      - name: Test ${{ matrix.module }}
        run: |
          dotnet test tests/YourApp.${{ matrix.module }}.Tests \
            --configuration Release \
            --collect:"XPlat Code Coverage" \
            --results-directory ./coverage/${{ matrix.module }}

  # Architecture tests run after all module tests pass
  architecture-tests:
    name: Architecture Boundary Tests
    runs-on: ubuntu-latest
    needs: [test-modules]
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      - run: dotnet build YourApp.sln --configuration Release
      - run: dotnet test tests/YourApp.Architecture.Tests --configuration Release

  # Single build and publish — one deployable for all modules
  build-and-publish:
    name: Build and Publish
    runs-on: ubuntu-latest
    needs: [architecture-tests]
    if: github.ref == 'refs/heads/main'
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      - run: |
          dotnet publish src/Host/YourApp.Host \
            --configuration Release --output ./publish
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: your-registry/your-app:${{ github.sha }}
```

The parallel test strategy is the practical payoff. If each module's test suite takes three minutes and you have five modules, sequential execution takes 15 minutes. Parallel execution takes three minutes regardless of how many modules you add — the CI time scales with the slowest module, not the total count.

The constraint: module tests must be genuinely independent. A test in `YourApp.Orders.Tests` that seeds data into the Payments schema violates module isolation and forces sequential execution. Each module's tests use their own DbContext, their own in-memory or testcontainer database instance, and mock the Contracts interfaces of any modules they interact with.

```csharp
// Correct: Orders tests mock Payments via the Contracts interface
// They do NOT spin up the Payments module or access the Payments schema
public class PlaceOrderCommandHandlerTests
{
    [Fact]
    public async Task PlaceOrder_PublishesOrderPlacedEvent()
    {
        // Arrange
        var dbContext = CreateInMemoryOrdersDbContext();
        var publisher = Substitute.For<IPublisher>();  // NSubstitute mock

        var handler = new PlaceOrderCommandHandler(dbContext, publisher);

        // Act
        var orderId = await handler.Handle(
            new PlaceOrderCommand(CustomerId: Guid.NewGuid(), Items: []),
            CancellationToken.None);

        // Assert
        await publisher.Received(1).Publish(
            Arg.Is<OrderPlaced>(e => e.OrderId == orderId),
            Arg.Any<CancellationToken>());
    }
}
```

---

## 7. The Extraction Path — When a Module Becomes a Service

The modular monolith is the starting architecture, not the permanent one. When a module genuinely meets the extraction criteria from the [Microservices by Default](/blogs/microservices-by-default/) post — an independent team, divergent scaling profile, or compliance isolation requirement — the extraction path is clean precisely because the boundaries were enforced from the start.

The steps are infrastructure work, not redesign work:

1. **Add an outbox table to the module's schema** — `orders.OutboxMessages` — and modify the domain event publisher to write to the outbox rather than publishing via MediatR in-process
2. **Deploy a message relay** — a background worker that reads the outbox and publishes to a real broker (Azure Service Bus, SQS, Kafka)
3. **Wire consumers in other modules** — replace MediatR `INotificationHandler<OrderPlaced>` with a message broker consumer of the same event type
4. **Run both paths in parallel** — in-process and broker-based — until the broker path is validated under production traffic
5. **Extract the module** — deploy `YourApp.Orders` as a separate service; remove its DI registration from the Host
6. **Update the Contracts reference** — other modules now reference a published NuGet package containing `YourApp.Orders.Contracts` rather than a project reference

Step 6 is where the Contracts pattern pays off. The event schema and service interfaces that other modules depend on are already in a separate assembly. Publishing that assembly as a NuGet package is a packaging change, not a redesign. The boundary was already there; the extraction makes it a network boundary rather than a project boundary.

---

## Production Checklist

Before considering the modular monolith architecture complete:

**Solution structure:**

- [ ] Each module is a pair of projects: `Module` (internal) and `Module.Contracts` (public)
- [ ] No project references between module implementation projects — only to `*.Contracts`
- [ ] `YourApp.Shared` contains only cross-cutting concerns; not a shared services dumping ground
- [ ] `YourApp.Host` is the only project that references all modules; it wires DI only

**Boundary enforcement:**

- [ ] All internal module types marked `internal` — DbContext, repositories, domain entities, handlers
- [ ] NetArchTest architecture tests assert no cross-module implementation dependencies
- [ ] Architecture tests run in CI as part of the standard test suite — not as a separate optional step
- [ ] NDepend CQLinq rules configured for namespace-level boundary enforcement
- [ ] NDepend Quality Gates block PRs that introduce new boundary violations

**Data isolation:**

- [ ] Each module has its own `DbContext` with a schema prefix (`orders.*`, `payments.*`)
- [ ] No module queries another module's schema directly — verified in code review and NDepend rules
- [ ] Module test suites use isolated database instances; no cross-module data seeding in tests

**Cross-module communication:**

- [ ] Cross-module communication uses integration events via MediatR `IPublisher`/`INotificationHandler`
- [ ] Event types are defined in the publishing module's `*.Contracts` project
- [ ] No synchronous service-to-service calls between modules; only event-driven communication

**CI/CD:**

- [ ] Module test suites run in parallel jobs — `needs:` only used between parallel fan-out and convergence points
- [ ] Architecture tests run after module tests, before build-and-publish
- [ ] Single `dotnet publish` on `YourApp.Host` produces the one deployable artefact
- [ ] NDepend analysis runs on every PR touching `.cs` or `.csproj` files

**Extraction readiness:**

- [ ] Outbox pattern identified as the extraction seam for each module's event publishing
- [ ] `*.Contracts` projects are self-contained — no transitive dependencies on implementation projects
- [ ] Module test suites mock `*.Contracts` interfaces rather than depending on other modules' implementations
