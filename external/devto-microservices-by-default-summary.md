---
title: "Microservices by Default: The Organisational Constraints Nobody Puts in the Architecture Diagram"
published: false
description: Microservices are an organisational pattern that happens to have technical expression. Applying the technical pattern without the organisational conditions is the most expensive mistake in modern cloud architecture.
tags: microservices, architecture, distributedsystems, devops
canonical_url: https://aloknecessary.github.io/blogs/microservices-by-default/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=microservices-by-default
cover_image: 
---

"We're moving to microservices" has been the architectural ambition of engineering teams for a decade. More than 40% of organisations now report regretting at least some of those decisions. One team's consolidation back to a monolith: response times improved 13x, AWS costs dropped from $18K to $2.4K/month, deployment time fell from 45 minutes to 6 minutes.

These are not teams that failed at microservices. They implemented them correctly — and discovered the operational premium was not proportional to the benefit.

---

## The Distributed System Tax

Every network boundary introduces failure modes that don't exist in-process: retries, circuit breakers, idempotency, distributed tracing, timeout budgets, schema versioning. This tax consumes 30–50% of engineering capacity once you cross the process boundary.

```text
What you pay per service boundary:

Network:      Retries, circuit breakers, timeouts, idempotency keys
Observability: Distributed tracing, per-service dashboards, N on-call rotations
Deployment:   N pipelines, N rollback procedures, compatibility windows
Data:         No foreign keys, eventual consistency, data duplication, sagas

Multiply by number of services. Then ask: does the benefit justify this?
```

---

## Conway's Law Is a Constraint, Not a Suggestion

Microservices deliver their promise only when the team structure supports end-to-end ownership without cross-team coordination for routine changes.

```text
Developer:  "We're splitting into order-service, inventory-service,
             and payment-service."
Architect:  "Which team owns each?"
Developer:  "The same team. Us."
Architect:  "So you're paying the distributed system tax for three
             services, with no autonomy dividend, because one team
             owns all three."
Developer:  "..."
Architect:  "How many engineers do you have?"
Developer:  "Seven."
```

The Inverse Conway Maneuver: restructure teams first. The architecture follows. Decomposing architecture first and hoping teams catch up is how seven engineers end up debugging a distributed trace across five services for a bug that would have been a five-line stack trace in a monolith.

---

## When Microservices Are Premature

- **Fewer than three independent teams** — communication overhead of service boundaries exceeds coordination overhead of a shared codebase
- **Domains still evolving** — wrong service boundaries require data migration and interface deprecation; wrong module boundaries are a refactoring task
- **Primary bottleneck isn't deployment frequency** — microservices won't fix slow tests, hiring, or infrastructure cost

---

## When Microservices ARE Worth It

- Multiple autonomous teams with clear domain ownership
- Genuinely divergent scaling requirements (>5x difference between components)
- Compliance isolation requirements (PCI-DSS, HIPAA)
- High deployment frequency at scale (dozens of deploys/day across teams)

---

## The Modular Monolith — The Default That Gets Skipped

A single deployable with enforced module boundaries aligned to business domains. Not a monolith with good intentions — a monolith where boundaries are enforced by build tooling.

```text
/src/modules
  /orders/api          ← public interface (what other modules may call)
  /orders/domain       ← internal (not accessible from other modules)
  /payments/api
  /payments/domain
  /inventory/api
  /inventory/domain

Rule: orders may only import from payments/api
      Enforced by ArchUnit, NDepend, or equivalent

Benefit: when you extract payments into a service,
         the boundary is already clean. The API is already defined.
         The migration is a deployment change, not a redesign.
```

---

## The Decomposition Decision Framework

```text
Step 1: What specific problem is decomposition solving?
Step 2: Do the organisational prerequisites exist?
        - Team exists to own the service end-to-end?
        - Team can deploy without coordinating with others?
        - Service interface is stable?
Step 3: Use the strangler fig — extract one bounded context at a time
```

---

## Warning Signs

**You have a distributed monolith:**

- Services deployed together in fixed order
- Changes to Service A always require changes to Service B
- Production incidents involve debugging 4+ services simultaneously

**Your monolith doesn't need decomposing:**

- Deploy in under 10 minutes
- Teams work in clearly separated namespaces
- On-call incidents debuggable with a single log stream
- Can scale horizontally without issues

---

## Read the Full Article

This is a summary of the fourth post in the Cloud Defaults Reconsidered series. The full article includes the complete distributed system tax breakdown, Conway's Law analysis, modular monolith implementation patterns, and the full decomposition decision framework:

**👉 [Microservices by Default — Full Article](https://aloknecessary.github.io/blogs/microservices-by-default/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=microservices-by-default)**

The full article includes:

- Complete distributed system tax enumeration (network, observability, deployment, data)
- Conway's Law and the Inverse Conway Maneuver in depth
- Three common misconceptions debunked (scaling, deployment safety, "get boundaries right later")
- Modular monolith implementation with enforcement tooling
- Warning signs for distributed monolith vs well-structured monolith
- Full decomposition decision framework (pain point identification, prerequisite checklist, strangler fig extraction)
- Key takeaways with actionable thresholds
