---
title: "Modernising the Lifted Workload: The Architectural Decisions That Separate Cloud-Native from Cloud-Hosted"
published: false
description: A modernisation roadmap for lifted workloads — workload assessment, managed service substitution, stateless redesign, the strangler fig pattern, Kubernetes readiness criteria, and autoscaling that reflects real load
tags: kubernetes, cloud, architecture, devops
canonical_url: https://aloknecessary.github.io/blogs/modernising-the-lifted-workload/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=modernising-the-lifted-workload
cover_image: 
---

Kubernetes does not make your architecture better automatically. Moving a lifted workload into a Deployment manifest without addressing stateful assumptions, chatty patterns, and observability voids is lift-and-shift at the container level.

This post covers the graduation path from "it's running on VMs" to genuinely cloud-native.

---

## 1. Workload Assessment — Four Categories, Four Paths

Not all lifted workloads have the same modernisation path:

- **Stateless, well-behaved** → containerise directly
- **Stateful, extractable** → externalise state first, then containerise
- **Tightly coupled monolith** → strangler fig pattern
- **Low-ROI legacy** → managed service substitution or decommission

The key diagnostic: if we modernise this, what specifically becomes easier to operate, scale, or change? If the answer is "nothing in particular," don't containerise it.

---

## 2. Managed Service Substitution

Before containerising anything: does this workload need to run as a custom-deployed service at all?

A self-hosted RabbitMQ cluster in Kubernetes requires provisioning, PV management, PDB configuration, Helm upgrades, TLS rotation, and on-call coverage. SQS or Azure Service Bus handles all of that for you.

The rule: managed services transfer operational complexity to the provider in exchange for reduced control. That trade is almost always worth it for infrastructure that is not a source of competitive differentiation.

---

## 3. Stateless Redesign — The Non-Negotiable First Step

Kubernetes's core model depends on pods being disposable. Three standard moves:

- **Externalise session state** — replace in-process stores with Redis
- **Externalise file storage** — replace local filesystem writes with object storage
- **Externalise scheduled jobs** — replace in-process timers with CronJobs (`concurrencyPolicy: Forbid`)

An application that holds state in process memory will behave incorrectly in Kubernetes in ways that are hard to reproduce in staging.

---

## 4. The Strangler Fig Pattern

The only widely proven technique for decomposing a monolith without a big-bang rewrite:

1. Place a routing layer in front of the monolith
2. Extract one bounded context at a time
3. Route that context's traffic to the new service
4. Validate under production traffic
5. Repeat until the monolith handles nothing

Three rules: start with the least risky extraction (not the most valuable), never share a database between monolith and extracted service, validate under real traffic before decommissioning the old code path.

---

## 5. Kubernetes Readiness Criteria

Before containerising:

- **Health probes are meaningful** — readiness checks actual application state, liveness checks only process health (never external dependencies in liveness)
- **Resource requests and limits measured** — from real profiling, not guesses
- **Graceful shutdown implemented** — SIGTERM handled, in-flight requests complete before pod exits

---

## 6. Autoscaling That Reflects Real Load

CPU is a poor proxy for load in most lifted workloads:

- **CPU-based HPA** — only for compute-bound workloads
- **Custom metrics HPA** — for request-rate-driven services
- **KEDA** — for queue consumers and event processors; scales to zero when idle

`minReplicaCount: 0` in non-production environments means queue consumers cost nothing when idle.

---

## 7. The Modernisation Sequencing

Never stop shipping. Allocate 20–30% of each sprint to modernisation. The order that works:

1. Stateless redesign
2. Observability pipeline
3. Managed service substitutions
4. Routing layer
5. First bounded context extraction
6. Progressive extraction

Observability comes second, not last — you cannot safely extract services you cannot observe.

---

## Read the Full Article

This is a summary of the third post in the Cloud Architecture series. The full article includes workload assessment matrices, managed service substitution tables, strangler fig architecture diagrams, Kubernetes probe configuration, KEDA ScaledObject manifests, and a comprehensive modernisation readiness checklist:

**👉 [Modernising the Lifted Workload — Full Article](https://aloknecessary.github.io/blogs/modernising-the-lifted-workload/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=modernising-the-lifted-workload)**

The full article includes:

- Four-category workload assessment with recommended paths
- Managed service substitution table (message brokers, caches, search, schedulers, secrets)
- Stateless redesign patterns with CronJob manifest (concurrencyPolicy: Forbid)
- Strangler fig pattern with five-phase ASCII architecture diagram
- Kubernetes readiness/liveness probe configuration with anti-patterns
- KEDA ScaledObject for SQS-driven autoscaling with scale-to-zero
- Modernisation sequencing order with sprint allocation guidance
- Complete modernisation readiness checklist (13 items)
