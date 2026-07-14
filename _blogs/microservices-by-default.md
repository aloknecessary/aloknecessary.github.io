---
title: "Microservices by Default: The Organisational Constraints Nobody Puts in the Architecture Diagram"
date: 2026-07-10
last_modified_at: 2026-07-10
author: Alok Ranjan Daftuar
description: "Microservices optimise for team autonomy and independent deployability — but only deliver those benefits when the organisational conditions exist to exploit them. This post examines the distributed system tax, Conway's Law as a constraint not a suggestion, the modular monolith as a production-viable default, and the signals that indicate a codebase is actually ready to decompose."
excerpt: "More than 40% of organisations regret at least some of their microservices decisions. The problem is not implementation — it is applying a technical pattern without the organisational prerequisites. This post covers the distributed system tax, Conway's Law, the modular monolith as the correct default, and a decomposition decision framework."
keywords: "microservices, modular monolith, conways law, distributed systems, architecture, team topology, service decomposition, cloud native, strangler fig"
twitter_card: summary_large_image
categories:
  - architecture
  - distributed-systems
tags: [microservices, architecture, modular-monolith, conways-law, distributed-systems, cloud-native, devops, production, trade-offs, team-topology]
series: "Cloud Defaults Reconsidered"
series_order: 4
---

## Introduction

"We're moving to microservices" has been the architectural ambition of engineering teams for the better part of a decade. The reasoning sounds compelling: independent deployability, technology diversity, isolated failure domains, the ability for teams to move without coordinating with everyone else. It appears in every architecture review, every platform strategy document, and every technical roadmap for teams that have outgrown their initial design.

What rarely appears in those documents: the organisational prerequisites that determine whether microservices deliver those benefits, or simply distribute the same complexity across a network boundary where it becomes significantly harder to reason about.

The data from 2026 is unambiguous. More than 40% of organisations report regretting at least some of their microservices decisions, citing operational complexity and cost. A January 2026 case study documented one team's consolidation from a distributed microservices system back to a monolith: response times improved from 1.2 seconds to 89 milliseconds — a 13x improvement — AWS costs dropped from $18,000 per month to $2,400 per month, and deployment time fell from 45 minutes to 6 minutes. These are not teams that failed to implement microservices correctly. They are teams that implemented microservices correctly and discovered that the operational premium was not proportional to the benefit, because the organisational conditions that make microservices worth it were never in place.

This post is not a microservices rejection. Microservices solve real problems at the right scale. The argument is more specific: microservices are an organisational pattern that happens to have technical expression — and applying the technical pattern without the organisational conditions is the most common and most expensive mistake in modern cloud architecture.

> **Article context:** This is the fourth post in the Cloud Defaults Reconsidered series. The [Private Endpoints Everywhere?](/blogs/hidden-cost-of-private-endpoints-everywhere/) post examined reflexive network privatisation. The [Multi-AZ by Default](/blogs/multi-az-by-default/) post examined reflexive availability investment. The [Service Mesh Everywhere?](/blogs/service-mesh-everywhere/) post examined reflexive mesh adoption. This post applies the same analysis to the most consequential default of all — reflexive service decomposition — and the organisational constraints that determine whether decomposition delivers its promise or simply its cost.

### Table of Contents

- [Introduction](#introduction)
- [The Distributed System Tax](#the-distributed-system-tax)
- [Conway's Law Is a Constraint, Not a Suggestion](#conways-law-is-a-constraint-not-a-suggestion)
- [The Common Misconceptions](#the-common-misconceptions)
- [When Microservices Are Premature](#when-microservices-are-premature)
- [When Microservices ARE Worth It](#when-microservices-are-worth-it)
- [The Modular Monolith — The Default That Gets Skipped](#the-modular-monolith--the-default-that-gets-skipped)
- [The Warning Signs You Have the Wrong Architecture](#the-warning-signs-you-have-the-wrong-architecture)
- [The Decomposition Decision Framework](#the-decomposition-decision-framework)
- [Key Takeaways](#key-takeaways)

---

## The Distributed System Tax

Every time an in-process function call becomes a network call, a set of failure modes appears that did not exist before. The called service can be slow, unavailable, or return an unexpected response. The network can drop the call or return it out of order. The response can arrive after the caller has given up. None of these failure modes exist when the same logic runs in the same process.

Handling them correctly requires retries with exponential backoff, circuit breakers, idempotency guarantees, distributed tracing, timeouts at every call boundary, and schema versioning between services. The [Idempotency](/blogs/idempotency-distributed-systems/), [Partial Failure](/blogs/designing_for_partial_failure/), and [Saga Orchestration](/blogs/saga-orchestration-vs-choreography/) posts in the Distributed Systems series cover each of these in depth — and each one represents engineering effort that produces no user-visible feature, only resilience against failures that would not exist in a single-process deployment.

The distributed system tax — network failures, versioning, observability, sagas, and on-call burden — consumes 30 to 50% of engineering capacity once you cross the process boundary. For a team of ten engineers, that is three to five engineers' worth of capacity spent on infrastructure that a monolith simply would not need.

```text
Distributed system tax — what you pay per service boundary:

Network layer:
  - Retries with exponential backoff and jitter
  - Circuit breakers per downstream dependency
  - Timeout budgets at every call site
  - Idempotency keys for non-idempotent operations

Observability:
  - Distributed tracing (a single request now spans N services)
  - Correlation IDs propagated through every call
  - Per-service dashboards, alerts, and runbooks
  - On-call coverage for N independent failure domains

Deployment:
  - N independent pipelines
  - N independent container image builds
  - N independent rollback procedures
  - Cross-service compatibility windows during upgrades

Data:
  - No foreign keys across service boundaries
  - Eventual consistency where transactions once sufficed
  - Data duplication across service stores
  - Saga or 2PC for operations that touch multiple services

Multiply each line item by the number of services.
Then ask: does the benefit of decomposition justify this cost?
```

For a team of ten engineers at Netflix with 500 services, these costs are amortised across a platform team that builds shared infrastructure, makes circuit breaker libraries available to every service, and runs the distributed tracing platform centrally. For a team of ten engineers building their first cloud-native application, the same costs are borne by the product team — in time that does not produce features.

---

## Conway's Law Is a Constraint, Not a Suggestion

In 1967, Melvin Conway observed that organisations design systems that mirror their own communication structures. Teams organised by software layer lead to dominant presentation-domain-data layering structures. Dividing people along lifecycle activity — analysis, design, coding, testing — means lots of handoffs to get a feature from idea to production.

Microservices are an organisational pattern dressed up as a technical one. The decision to decompose is dominated by team size, deployment frequency, and cognitive load — not by request volume.

This matters because it inverts the common justification for microservices. Teams rarely say "we have the right team structure for microservices, therefore we should decompose." They say "we have outgrown our monolith, therefore we should decompose into microservices" — and then discover that the team structure does not support the ownership model microservices require.

```text
Developer:  "We're splitting the order flow into order-service,
             inventory-service, and payment-service."
Architect:  "Which team owns each?"
Developer:  "The same team. Us."
Architect:  "So one team will be making changes that require
             coordinating across three services simultaneously?"
Developer:  "Yes, but eventually we'll hire for each."
Architect:  "When?"
Developer:  "Once we have more traffic."
Architect:  "And until then, you're paying the distributed
             system tax for three services, with no autonomy
             dividend, because one team owns all three."
Developer:  "..."
Architect:  "How many engineers do you have right now?"
Developer:  "Seven."
```

Microservices deliver their promise — independent deployability, team autonomy, technology freedom — only when the team structure allows teams to own services end-to-end without requiring cross-team coordination for routine changes. When organisations hastily divide teams before understanding their domain, they end up with services that need constant cross-team coordination. The promised independence becomes an illusion, and the overhead of maintaining service boundaries becomes pure cost.

The Inverse Conway Maneuver — deliberately structuring teams to produce the desired architecture — is the correct sequencing. Restructure the teams first. The architecture will follow. Decomposing the architecture first and hoping the team structure catches up is how you end up with seven engineers debugging a distributed trace across five services for a bug that would have been a five-line stack trace in a monolith.

---

## The Common Misconceptions

### "We Need Microservices to Scale"

Scaling is the most frequently cited justification for microservices and the most frequently misapplied one. The question it requires is not "do we need to scale?" but "do different parts of the system need to scale independently at materially different rates?"

```text
E-commerce platform, Black Friday analysis:

Order submission API:    100x normal traffic  → needs independent scaling
Product catalogue:       20x normal traffic   → needs independent scaling
Admin dashboard:         0.1x normal traffic  → does NOT need independent scaling
Invoice generation:      1x normal traffic    → does NOT need independent scaling
Email notification:      5x normal traffic    → queue absorbs the burst

Conclusion: 2 of 5 components have genuinely different scaling characteristics.
The other 3 can scale vertically or share horizontal capacity.

Decompose order submission and catalogue. The rest can stay modular monolith.
Decomposing all five creates four unnecessary service boundaries.
```

A monolith can scale horizontally — run more instances behind a load balancer — and the entire application scales together. This is sufficient for the majority of scaling requirements because most components of most applications have similar traffic profiles, not wildly divergent ones. Independent scaling is worth its complexity premium when the scaling profiles genuinely diverge; it is pure overhead when they do not.

### "Microservices Improve Deployment Safety"

Independent deployability is a genuine benefit of microservices — when services have stable interfaces and minimal shared state. It is not a benefit when:

- A feature routinely requires coordinated changes to three services deployed in a specific order
- Service A's deployment cannot proceed until Service B ships a compatible interface version
- A rollback in Service C requires a compensating deployment in Services A and B

This pattern — the distributed monolith — is the most expensive architecture in existence. It combines the operational overhead of microservices with the deployment coupling of a monolith, delivering the benefits of neither. Uber grew from two monolithic services to more than 2,200 critical microservices, then spent two years imposing domain structure on top because unconstrained decomposition produced a dependency graph no single engineer could reason about.

Deployment safety from microservices requires stable, versioned interfaces between services and genuine domain isolation — changes to one service's internals do not require changes to any other. If your services cannot be deployed independently without coordination, they are not microservices. They are a distributed monolith, and you are paying the distributed system tax for a coupling that a modular monolith would have made explicit and manageable.

### "We'll Start With Microservices and Get the Boundaries Right Later"

Getting domain boundaries right is hard. It requires understanding how the business actually works, where data naturally coheres, and how responsibilities align with team structures — none of which is fully knowable at the start of a project. Fowler's Monolith First argument is precisely this: starting with a modular monolith and extracting services judiciously based on demonstrated need provides a clear migration path while avoiding premature complexity.

Wrong service boundaries in a monolith are a refactoring problem. Wrong service boundaries in a microservices architecture are a distributed system problem: data duplication across incorrect boundaries, compensating transactions for operations that should be atomic, and interface versioning nightmares for boundaries that should not exist.

Starting with microservices bets that your initial domain model is correct before you have the production experience to validate it. Starting with a modular monolith defers that bet until the evidence is available.

---

## When Microservices Are Premature

### Fewer Than Three Independent Teams

The modular monolith is the pragmatic default for teams under 100 engineers. Below that threshold, the communication overhead of coordinating across service boundaries within a single team or two tightly collaborating teams exceeds the coordination overhead of working in a shared codebase with clear module boundaries.

The threshold is not a head count. It is a team structure threshold. Three independent teams with clear domain ownership and the maturity to maintain stable service contracts can justify microservices at 30 engineers. One team of 50 engineers all working on the same product cannot.

### Domains That Are Still Evolving

The highest cost of premature decomposition: wrong service boundaries that have to be corrected after the fact. A boundary that looked correct at month three — when the domain model was still being discovered — frequently turns out to be wrong at month twelve, when production patterns reveal that two "services" are actually one cohesive domain, or that one "service" actually contains two distinct bounded contexts.

Moving a boundary in a modular monolith is a refactoring task. Moving a service boundary means migrating data between stores, coordinating the deprecation of old interfaces, managing the transition period where both old and new boundaries are live, and coordinating multiple teams through the change. The cost multiplier is significant.

### When the Primary Bottleneck Is Not Deployment Frequency

Microservices primarily optimise for deployment independence. If your primary bottleneck is something else — development speed, hiring, domain complexity, or infrastructure cost — microservices will not address it. They will add deployment infrastructure on top of the existing bottleneck.

```text
Actual primary bottleneck        → Right solution
─────────────────────────────────────────────────────
Slow tests blocking deploys      → Test parallelism, better CI, trunk-based dev
Too many engineers in one repo   → Modular monolith, clear module ownership
Infrastructure cost too high     → Rightsizing, managed services, KEDA scale-to-zero
One domain scaling differently   → Extract that domain. Leave the rest.
True team autonomy needed        → Extract per team boundary. Not per function.
```

---

## When Microservices ARE Worth It

### Multiple Autonomous Teams With Clear Domain Ownership

The clearest justification: five teams, five domains, each team fully owns their service and can deploy independently without coordinating with anyone else. Changes to the payment service do not require the order team to change anything. The checkout team can ship three times a day without touching a shared pipeline.

This is the autonomy dividend microservices promise. It is real. It requires the organisational structure to exist first.

### Genuinely Divergent Scaling or Technology Requirements

A video transcoding service needs GPU instances, a burst scaling profile, and a different capacity planning model than the user authentication service running at steady-state on standard compute. Isolating them allows each to be sized and operated independently, with appropriate infrastructure for its specific characteristics.

Similarly, a data-intensive analytics service that benefits from a columnar store has a legitimate reason to own a different database technology than the transactional order management service that needs ACID guarantees. Technology diversity is a real benefit — when the different requirements are real.

### Compliance and Isolation Requirements

Payment Card Industry Data Security Standard (PCI-DSS) requires isolating cardholder data. The Health Insurance Portability and Accountability Act (HIPAA) requires isolating protected health information. Regulatory frameworks with explicit physical isolation requirements provide an unambiguous justification for extracting regulated components into separately deployed, separately audited services — regardless of team structure or scaling profile.

### High Deployment Frequency at Scale

If your organisation deploys dozens of times per day across multiple teams, the coordination overhead of a shared pipeline becomes a genuine bottleneck. At that frequency, the deployment coupling of even a well-structured modular monolith creates queuing that slows everyone down. Independent pipelines per service remove that coupling — but only when the services themselves have stable enough interfaces that deployments are genuinely independent.

---

## The Modular Monolith — The Default That Gets Skipped

A modular monolith is a single deployable application where the internal code is organised into distinct modules aligned with business domains, with explicitly defined and enforced interfaces between them. It provides the structural discipline of microservices — clear domain boundaries, encapsulation, controlled dependencies — without the operational overhead of distributed deployment.

The key word is *enforced*. A modular monolith is not a monolith with good intentions. It is a monolith where module boundaries are enforced by build tooling, dependency rules, or access controls — modules cannot reach across boundaries into other modules' internals any more than a microservice could.

```text
Modular monolith: enforced boundaries within a single deployable

/src
  /modules
    /orders           ← owns: Order, OrderItem, OrderStatus
    │  /api           ← public interface — what other modules may call
    │  /domain        ← internal — not accessible from other modules
    │  /infrastructure
    /payments         ← owns: Payment, Refund, PaymentMethod
    │  /api
    │  /domain
    │  /infrastructure
    /inventory        ← owns: Product, Stock, Reservation
       /api
       /domain
       /infrastructure

Rule: modules/orders may only import from modules/payments/api
      It may NOT import from modules/payments/domain or modules/payments/infrastructure
      Enforced by ArchUnit (Java), NDepend (.NET), or equivalent build rules

Benefit: when you eventually extract payments into a service,
         the boundary is already clean. The API is already defined.
         The migration is a deployment change, not a redesign.
```

The modular monolith also solves the premature boundary problem: you keep the domain in one deployable while the business model stabilises, then extract services along boundaries that production has validated — not boundaries that seemed logical before you had users.

The [Modernising the Lifted Workload](/blogs/modernising-the-lifted-workload/) post's strangler fig pattern describes exactly this extraction path: the modular monolith acts as the host, the routing layer sits in front of it, and bounded contexts are extracted incrementally when the organisational conditions justify it.

---

## The Warning Signs You Have the Wrong Architecture

### You Have a Distributed Monolith

```text
Warning signs:
  - Services are deployed together in a fixed order
  - A change to Service A always requires a change to Service B
  - Services share a database or call each other synchronously in critical paths
  - A production incident always involves debugging 4+ services simultaneously
  - Cross-service API versioning is a full-time engineering concern

Diagnosis: you have microservices operationally but a monolith architecturally.
           You are paying the distributed tax with none of the autonomy dividend.

Options:
  1. Fix the boundaries (expensive, usually requires data migration)
  2. Merge tightly coupled services back into a module (often the right call)
  3. Accept the current cost and plan correctly next time
```

### Your Monolith Is Actually Well-Structured

The opposite signal, and the one teams consistently ignore:

```text
Signs your monolith does not need decomposing:
  - You can deploy in under 10 minutes
  - Different teams work in clearly separated directories/namespaces
  - Build and test runs are fast with parallelism
  - On-call incidents are debuggable with a single log stream
  - Feature development does not require cross-team coordination
  - You can scale horizontally without issues

If all of these are true: your monolith is not the problem.
Decomposing it will not make any of these better.
It will make them all worse.
```

---

## The Decomposition Decision Framework

### Step 1: Identify the Actual Pain Point

```text
What specific problem is decomposition solving?

Deployment coupling (teams blocked by shared pipeline)?
  → Measure: how often does one team block another per week?
  → Threshold: if > 2 blocks/week, decomposition may help
  → Alternative first: modular monolith + parallel pipelines per module

Scaling divergence (one component needs 10x scale of others)?
  → Measure: actual traffic ratios between components
  → Threshold: > 5x difference in steady-state scale requirements
  → Alternative first: separate scaling groups within monolith

Technology divergence (one component genuinely needs different stack)?
  → Measure: is this a real requirement or a preference?
  → Threshold: regulatory, performance, or platform requirement, not choice

Team ownership conflict (multiple teams modifying same code constantly)?
  → Measure: merge conflict rate, build queue time
  → Threshold: > 30% of PRs create merge conflicts across team boundaries
```

### Step 2: Check the Organisational Prerequisites

```text
Before extracting any service, confirm:

1. Does a team exist that will own this service end-to-end?
   YES → proceed
   NO  → extract to a module first; service extraction deferred

2. Can that team deploy this service without coordinating with another team?
   YES → proceed
   NO  → the boundary is wrong; revisit domain model

3. Does the team have the operational maturity to run a service?
   (On-call rotation, alerting, incident response, capacity planning)
   YES → proceed
   NO  → build that capability first; use modular monolith in the interim

4. Is the service interface stable enough that callers won't need
   constant updates as the service evolves?
   YES → proceed
   NO  → the domain model is still evolving; defer extraction
```

### Step 3: Use the Strangler Fig, Not a Big Bang

If prerequisites are met, extract incrementally using the strangler fig pattern from the [Modernising the Lifted Workload](/blogs/modernising-the-lifted-workload/) post. Extract one bounded context at a time, validate under production traffic, stabilise the interface, then proceed to the next. Never extract multiple services simultaneously — the coordination risk compounds and the blast radius of a wrong boundary decision expands with every parallel extraction.

---

## Key Takeaways

1. **Microservices are an organisational pattern, not a technical one.** The benefits — team autonomy, independent deployability, technology diversity — are only realisable when the team structure supports them. Technical decomposition without organisational decomposition produces a distributed monolith.

2. **The distributed system tax is real and measurable.** 30 to 50% of engineering capacity goes to infrastructure concerns that a monolith simply does not have. Quantify this cost against the benefit before decomposing.

3. **The modular monolith is the correct default for most teams.** It provides architectural discipline — enforced module boundaries, clear domain ownership, controlled dependencies — without the operational overhead of distributed deployment. It is increasingly the recommended default for 2026.

4. **Wrong service boundaries are significantly more expensive than wrong module boundaries.** A module refactoring is a single codebase change. A service boundary correction involves data migration, interface deprecation, and cross-team coordination. Start with modules, extract services when the boundary has been validated by production.

5. **Scaling is rarely the right justification for decomposition.** Most components of most applications have similar traffic profiles. Independent scaling only earns its overhead when scaling profiles genuinely diverge by a factor of 5x or more between components.

6. **Conway's Law is a constraint you cannot design around.** Your architecture will mirror your team structure whether you plan for it or not. The correct sequencing is: define team boundaries aligned with business domains first, then let the architecture follow.

7. **The strangler fig is the only safe extraction path.** Extract one bounded context at a time, validate under production traffic, stabilise the interface. Never decompose all at once.
