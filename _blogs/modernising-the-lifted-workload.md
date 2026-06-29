---
title: "Modernising the Lifted Workload: The Architectural Decisions That Separate Cloud-Native from Cloud-Hosted"
date: 2026-07-03
last_modified_at: 2026-07-03
author: Alok Ranjan Daftuar
description: "A modernisation roadmap for lifted workloads — covering workload assessment, managed service substitution, stateless redesign, the strangler fig pattern, Kubernetes readiness criteria, and autoscaling that reflects real load."
excerpt: "Kubernetes does not make your architecture better automatically. This post covers the graduation path from 'it's running on VMs' to genuinely cloud-native."
keywords: "kubernetes, cloud-native, modernisation, strangler-fig, stateless, autoscaling, KEDA, managed services, cloud architecture"
twitter_card: "summary_large_image"
categories:
  - architecture
  - cloud
tags: [kubernetes, cloud, architecture, modernisation, container-architecture, cloud-native, azure, aws, devops, production, strangler-fig]
series: "Cloud Architecture"
series_order: 3
---

Kubernetes does not make your architecture better automatically. This post covers the graduation path from "it's running on VMs" to genuinely cloud-native — the strangler fig pattern, stateless redesign, managed service substitution, autoscaling that reflects real load, and the criteria for knowing when Kubernetes is the right next step and when it isn't.

<!--more-->

## Table of Contents

- [Introduction](#introduction)
- [The Wrong Way to Start: Converting Configuration Files](#the-wrong-way-to-start-converting-configuration-files)
- [1. Workload Assessment — Four Categories, Four Paths](#1-workload-assessment--four-categories-four-paths)
- [2. The Managed Service Substitution Question](#2-the-managed-service-substitution-question)
- [3. Stateless Redesign — The Non-Negotiable First Step](#3-stateless-redesign--the-non-negotiable-first-step)
- [4. The Strangler Fig Pattern — Decomposing Without a Big-Bang Rewrite](#4-the-strangler-fig-pattern--decomposing-without-a-big-bang-rewrite)
- [5. Kubernetes Readiness — What Needs to Be True Before You Containerise](#5-kubernetes-readiness--what-needs-to-be-true-before-you-containerise)
- [6. Autoscaling That Reflects Real Load — HPA, VPA, and KEDA](#6-autoscaling-that-reflects-real-load--hpa-vpa-and-keda)
- [7. The Modernisation Sequencing Problem](#7-the-modernisation-sequencing-problem)
- [The Modernisation Readiness Checklist](#the-modernisation-readiness-checklist)
- [Closing: Modernisation Is a Process, Not a Platform Switch](#closing-modernisation-is-a-process-not-a-platform-switch)

## Introduction

The [previous post in this series](/blogs/lift-and-shift-fails-quietly/) ended with a specific forward pointer: lift-and-shift is a phase, not a destination. The architectural debt it accumulates — chatty services, stateful assumptions, observability voids, distributed monoliths — doesn't get resolved by migrating to the cloud. It gets resolved by modernising what you migrated.

For most teams, "modernisation" means Kubernetes. And for many of them, that turns out to be the second mistake after lift-and-shift.

Kubernetes is exceptional infrastructure. It is also genuinely complex, operationally demanding, and misapplied to a surprisingly large fraction of workloads that would run better — cheaper, simpler, with less operational overhead — on managed services or even well-configured container platforms without the full orchestration layer. The instinct to reach for Kubernetes is understandable: it's the CNCF-blessed default, it has deep ecosystem support, and 66% of organisations are now running production workloads on it. But "everyone uses it" is not the same as "it's the right tool for your specific lifted workload right now."

This post is not a Kubernetes criticism. It's a modernisation roadmap. The questions it addresses: how do you assess a lifted workload for its cloud-native readiness, what is the graduation path from VM-based hosting to genuine cloud-native architecture, when does Kubernetes earn its complexity for a specific workload, and when is a managed service the better answer? The goal is a workload that's genuinely easier to operate, scale, and reason about — not one that's traded its on-premises complexity for Kubernetes YAML complexity with a Helm chart on top.

> **Article context:** This is the third post in the Cloud Architecture series. The [Why Lift-and-Shift Fails Quietly](/blogs/lift-and-shift-fails-quietly/) post identified the six architectural smells that surface after migration and ended with a pre-migration checklist. The [Designing Cloud-Native Systems That Survive Region-Level Failures](/blogs/cloud_native_region_failure_architecture/) post covered resilience architecture. This post covers the modernisation work that addresses the smells Post 1 diagnosed — the "what do you actually do next" that the series has been building toward.

---

## The Wrong Way to Start: Converting Configuration Files

The most common modernisation anti-pattern is also the most intuitive one: take the application that's running on a VM, containerise it, write a Deployment manifest, apply it to a Kubernetes cluster, and declare the workload modernised. The application is now in Kubernetes. The architecture is not.

This is lift-and-shift at the container level. The same stateful assumptions from Post 1 are still there — the app still writes to local disk, still expects a specific hostname, still has session state baked into the process. The chatty service pattern is unchanged — internal calls that were sub-millisecond on a LAN are now pod-to-pod across a CNI overlay. The observability void persists — the app logs to stdout only when it feels like it, and nobody configured a sidecar or log aggregation pipeline. All the architectural debt is still there. It just now has a `kind: Deployment` header above it.

The conversion of configuration files is the beginning of a containerisation task, not the beginning of a modernisation programme. Before touching a `Dockerfile` or writing a `values.yaml`, the questions that need answers are architectural — not operational.

---

## 1. Workload Assessment — Four Categories, Four Paths

The first step in any modernisation programme is an honest inventory. Not all lifted workloads have the same modernisation path, and treating them uniformly is how teams end up running a stateful legacy application in a StatefulSet when it should have been moved to a managed database and decommissioned.

Categorise each workload by two axes: how much the application's architecture needs to change, and how much business value justifies the investment.

| Category | Description | Recommended Path |
| --- | --- | --- |
| **Stateless, well-behaved** | Already twelve-factor compliant, no local state, configuration via environment variables | Containerise directly, target Kubernetes Deployment |
| **Stateful, extractable** | Holds state that can be externalised — sessions, file uploads, scheduled jobs | Externalise state first, then containerise |
| **Tightly coupled monolith** | Multiple concerns baked into one deployable; can be decomposed | Strangler fig pattern — extract bounded contexts incrementally |
| **Low-ROI legacy** | Aging system with no modernisation path and no active development | Managed service substitution or decommission; do not invest in containerisation |

The fourth category is the one most modernisation planning documents skip. Running a legacy application in Kubernetes because it's in the modernisation backlog is worse than leaving it on a VM — the operational overhead of Kubernetes increases, the workload cannot take advantage of any cloud-native capabilities, and the team that owns it now has to learn Kubernetes YAML to maintain something that was stable before. If a workload is in this category, the right answer is almost always a managed replacement or a documented sunset timeline, not a container image.

> **The key diagnostic question for every workload:** If we modernise this, what specifically becomes easier to operate, scale, or change? If the answer is "nothing in particular," the workload probably belongs in category four.

---

## 2. The Managed Service Substitution Question

Before containerising anything, ask a harder question: does this workload need to run as a custom-deployed service at all, or does a managed cloud service exist that removes the operational burden entirely?

This question is uncomfortable in organisations with strong engineering cultures, because it implies that the better answer is sometimes to not build the infrastructure. But the operational economics are real: a self-hosted RabbitMQ cluster in Kubernetes requires cluster provisioning, persistent volume management, pod disruption budget configuration, Helm chart upgrades, TLS rotation, and on-call coverage for failure modes that SQS, Azure Service Bus, or Cloud Pub/Sub simply handle for you. The engineering investment in running that cluster is an investment that does not improve your product.

The substitution assessment for common lifted components:

| Self-Hosted Component | Managed Alternative | When Self-Hosted Still Wins |
| --- | --- | --- |
| Message broker (RabbitMQ, ActiveMQ) | SQS, Azure Service Bus, Cloud Pub/Sub | Complex routing topologies, very high throughput with cost sensitivity |
| Cache (Redis, Memcached) | ElastiCache, Azure Cache for Redis | Specific Redis module requirements, multi-cloud portability |
| Search (Elasticsearch) | OpenSearch Service, Elastic Cloud | Index control requirements, cost at very large scale |
| Scheduled jobs (cron containers) | Lambda + EventBridge, Azure Functions | Complex job orchestration, very short cold-start tolerance |
| SMTP relay | SES, SendGrid, Postmark | On-premises mail server regulatory requirements |
| Secrets management | AWS Secrets Manager, Azure Key Vault | Cross-cloud secret sharing, Vault's dynamic secrets |

The right framing: managed services transfer operational complexity to the provider in exchange for reduced control and a usage-based cost model. That trade is almost always worth it for infrastructure that is not a source of competitive differentiation. The application's business logic is differentiation. The message broker is not.

---

## 3. Stateless Redesign — The Non-Negotiable First Step

Of the six architectural smells identified in Post 1, stateful assumptions are the one that must be resolved before Kubernetes adds any value — because Kubernetes's core operational model depends on pods being disposable. Pods are evicted for node pressure, killed for rolling updates, rescheduled during node maintenance. An application that holds session state in process memory, writes user-uploaded files to a local path, or expects a consistent hostname across restarts will behave incorrectly in Kubernetes in ways that are hard to reproduce in staging and visible to users in production.

Stateless redesign has three standard moves, applied in order of how much they require changing the application code:

**Externalise session state.** Replace in-process session stores with a distributed cache. In .NET, this means moving from in-memory `IDistributedCache` or cookie-based sessions to Redis or a database-backed session provider. In Node.js, replacing `express-session` with a Redis store adapter. The application code change is usually small — the session interface doesn't change, only the backing store.

**Externalise file storage.** Replace local filesystem writes with object storage. Any code that does `File.WriteAllBytes(path, data)` or `fs.writeFileSync(path, data)` needs to target an S3 bucket, Azure Blob container, or GCS bucket instead. The blast radius of missing this is subtle: the application works fine with one pod, and breaks intermittently with three — because uploads land on pod A, and subsequent reads hit pod B or C, which have no access to pod A's local filesystem.

**Externalise scheduled jobs.** Replace in-process schedulers (Quartz.NET, `node-cron`, `IHostedService` timers) with cluster-level job scheduling. A timer that fires in every pod simultaneously produces duplicate side effects. The right replacement is a Kubernetes CronJob with a single replica, or a managed scheduler like EventBridge or Azure Logic Apps, keeping the application pods stateless and the scheduling concern out of the application process.

```yaml
# Replace in-process timers with a dedicated CronJob — one scheduler, no duplicates
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-reconciliation
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid        # prevents overlap if a previous run is still executing
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: reconciler
            image: your-registry/reconciler:latest
            env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: database-url
```

`concurrencyPolicy: Forbid` is the field most teams miss. Without it, if the previous run is still executing when the next schedule fires — because the job ran long, or because it errored and hit the retry backoff — two instances run simultaneously, both modifying the same data. `Forbid` skips the new run rather than creating a duplicate. That's almost always the right behaviour for reconciliation jobs, report generation, or any job with external side effects.

---

## 4. The Strangler Fig Pattern — Decomposing Without a Big-Bang Rewrite

If the workload assessment in Section 1 placed an application in the "tightly coupled monolith" category, the modernisation path is the strangler fig pattern — the only widely proven technique for decomposing a monolith into services without a big-bang rewrite that freezes feature development and carries a high failure rate.

The pattern is named after the strangler fig tree, which grows around a host tree and gradually replaces it. Applied to software: place a routing layer in front of the monolith, extract one bounded context at a time into a standalone service, route that context's traffic to the new service, validate, and repeat — until the monolith handles nothing and can be decommissioned.

```text
Phase 1: Monolith only
[Client] ──────────────────────────────────▶ [Monolith]

Phase 2: Routing layer introduced
[Client] ──▶ [API Gateway / Reverse Proxy] ──▶ [Monolith]

Phase 3: First extraction
[Client] ──▶ [API Gateway] ──┬──▶ [User Service (new)]
                             └──▶ [Monolith (everything else)]

Phase 4: Progressive extraction
[Client] ──▶ [API Gateway] ──┬──▶ [User Service]
                             ├──▶ [Order Service]
                             └──▶ [Monolith (remaining)]

Phase 5: Monolith retired
[Client] ──▶ [API Gateway] ──┬──▶ [User Service]
                             ├──▶ [Order Service]
                             └──▶ [Product Service]
```

The routing layer is the linchpin. It must be in place before the first extraction, because it's what allows traffic to be split between the monolith and new services without a client-side change or a hard cutover. In AWS this is typically an Application Load Balancer with path-based routing rules or an API Gateway with Lambda authorisers. In Azure, API Management or an Application Gateway. For Kubernetes-only deployments, an Ingress controller (NGINX, Traefik) with path-based routing achieves the same thing.

Three rules that govern which bounded context to extract first:

**Start with the least risky, not the most valuable.** The first extraction is about proving the process — the routing layer, the deployment pipeline, the monitoring setup, the anti-corruption layer between old and new. If it breaks, you want the blast radius to be small. Extract a read-heavy, low-traffic, non-critical context first. Save the payment service for extraction four.

**Never share a database between the monolith and an extracted service.** Direct database sharing creates an invisible coupling that defeats the purpose of extraction. The new service should own its data and communicate with the monolith through its API, not through the same schema. If the data model is tightly coupled, the extraction sequence needs to address data separation as part of the work — not skip it.

**Validate under production traffic before decommissioning the monolith implementation.** Route a small percentage of traffic to the new service alongside the monolith implementation, compare outputs, and only decommission the monolith code path when the new service has proven stable under real load. Shadow traffic or canary deployments achieve this without user exposure to a broken extraction.

---

## 5. Kubernetes Readiness — What Needs to Be True Before You Containerise

Once a workload has been assessed, stateless redesign applied, and extraction sequenced, the question of containerisation becomes concrete rather than theoretical. The criteria for Kubernetes readiness are operational, not just technical:

**Health probes are meaningful, not placeholder.** The single most common Kubernetes misconfiguration in lifted workloads is a readiness probe that returns 200 before the application is actually ready to serve traffic — because the health endpoint was added to satisfy the probe definition without being connected to real application state. A readiness probe that doesn't reflect actual readiness causes rolling updates to route traffic to pods that are still initialising, producing 5xx errors during deployments.

```yaml
readinessProbe:
  httpGet:
    path: /health/ready     # must check: DB connection, cache connection, dependent services
    port: 8080
  initialDelaySeconds: 10   # give the app time to initialise before first check
  periodSeconds: 5
  failureThreshold: 3       # remove from load balancer after 3 consecutive failures
livenessProbe:
  httpGet:
    path: /health/live      # should only check: is the process alive and not deadlocked
    port: 8080              # do NOT check external dependencies here — liveness restarts the pod
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 5
```

The liveness and readiness probes check different things deliberately. Readiness gates traffic — a pod that fails readiness is removed from the load balancer but not restarted. Liveness gates existence — a pod that fails liveness is killed and replaced. Putting external dependency checks (database connectivity, downstream service health) in the liveness probe causes cascading restarts: if the database is briefly unreachable, every pod restarts simultaneously, which is far worse than temporarily removing them from load balancing rotation.

**Resource requests and limits are set and validated.** Running pods without resource requests in a shared cluster means the scheduler cannot make good placement decisions, and one misbehaving workload can exhaust node resources and evict other pods. Limits without appropriate values cause OOMKilled events under normal load, which surface as random pod restarts with no obvious cause. Both require real measurement from staging or initial production runs — not guesses.

**Graceful shutdown is implemented.** Kubernetes sends SIGTERM before killing a pod. An application that doesn't handle SIGTERM will be hard-killed after the `terminationGracePeriodSeconds` expires, dropping any in-flight requests it was processing. For .NET applications, `IHostApplicationLifetime.ApplicationStopping` is the hook. For Node.js, `process.on('SIGTERM', ...)`. This is not a Kubernetes-specific concern — it matters anywhere pods are evicted — but it's invisible until the first rolling update drops requests in production.

---

## 6. Autoscaling That Reflects Real Load — HPA, VPA, and KEDA

The default horizontal pod autoscaler scales on CPU utilisation. For most lifted workloads, CPU is a poor proxy for load — an I/O-bound service or a queue consumer can be fully saturated at 20% CPU, and a CPU-heavy background worker can be idle at 80% CPU when there's nothing in the queue. Scaling on CPU produces systems that either over-provision (scaling up while lightly loaded) or under-respond (not scaling when genuinely overloaded).

The autoscaling model should match the workload's actual scaling signal:

**CPU-based HPA** is appropriate for compute-bound workloads that scale linearly with CPU — mathematical computation, image processing, CPU-heavy serialisation. For these, the default HPA is the right tool.

**Custom metrics HPA** is appropriate for request-rate-driven workloads where the correct signal is HTTP requests per second, queue depth, or active connection count — not CPU. This requires exposing custom metrics through the Kubernetes metrics API (Prometheus Adapter is the standard approach).

**KEDA (Kubernetes Event-Driven Autoscaler)** is the right tool for queue consumers, event processors, and anything that should scale to zero when idle and scale up proportionally to queue depth. KEDA integrates directly with SQS, Azure Service Bus, Kafka, RabbitMQ, and dozens of other event sources, removing the need to build a custom metrics pipeline.

```yaml
# KEDA ScaledObject: scale an order processor based on SQS queue depth
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaler
spec:
  scaleTargetRef:
    name: order-processor
  minReplicaCount: 0          # scale to zero when queue is empty — cost savings in dev/staging
  maxReplicaCount: 20
  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.eu-west-1.amazonaws.com/123456789/order-queue
      queueLength: "5"        # target: 5 messages per pod replica
      awsRegion: eu-west-1
    authenticationRef:
      name: keda-aws-credentials
```

`minReplicaCount: 0` is the configuration that makes KEDA worth the setup investment in non-production environments. A queue consumer scaled to zero when idle costs nothing. The same consumer running at minimum two replicas in a development cluster, across ten services, across twelve months, is a material infrastructure cost with no benefit.

---

## 7. The Modernisation Sequencing Problem

The hardest operational question in any modernisation programme is not technical — it is sequencing. How do you make architectural progress while continuing to ship product features, without triggering a rewrite freeze that stalls the team for six months?

The answer is the same answer the strangler fig pattern gives for decomposition: never stop shipping, always have something deployable, extract and validate incrementally rather than rewriting comprehensively.

In practice, this means modernisation work needs to live alongside feature development, not replace it. The typical approach: allocate a consistent fraction of each sprint — commonly 20 to 30 percent — to modernisation tasks, keep a backlog of extraction candidates prioritised by risk and dependency order, and treat each extraction as a feature that gets planned, estimated, reviewed, and deployed like any other. The alternative — a dedicated modernisation sprint or a two-month "platform quarter" — routinely produces a half-migrated system when business priorities reassert themselves, which is the worst possible state: neither the old architecture nor the new one, with undefined ownership of the boundary between them.

The sequencing order that works for most lifted workloads:

1. **Stateless redesign** (session externalisation, file storage, scheduled jobs) — unblocks Kubernetes deployment, no service boundary changes required
2. **Observability pipeline** — structured logging, distributed tracing, metrics emission — because you cannot safely extract services you cannot observe
3. **Managed service substitutions** — remove the lowest-ROI self-hosted infrastructure first; reduces operational burden before you increase it with Kubernetes
4. **Routing layer** — API gateway or ingress controller in front of the monolith; must precede any extraction
5. **First bounded context extraction** — lowest-risk, highest-confidence domain; validates the extraction process end-to-end
6. **Progressive extraction** — repeat with increasing confidence and increasing bounded context size

Observability comes second, not last. The instinct is to add monitoring "once things are stable." The reality is that service extraction without distributed tracing produces debugging situations where a request fails across three services and nobody can tell which hop is the failure point. Instrument before you extract.

---

## The Modernisation Readiness Checklist

Before containerising any lifted workload and before making any Kubernetes investment:

- [ ] **Workload categorised** — stateless/stateful/monolith/low-ROI assessed for every application in scope; category four workloads have a managed service replacement or decommission plan, not a containerisation plan
- [ ] **Managed service substitution evaluated** — every self-hosted infrastructure component assessed against its managed equivalent; substitution chosen where the operational trade is worth it
- [ ] **Session state externalised** — no in-process session stores; all session data in Redis or database-backed provider
- [ ] **File storage externalised** — no local filesystem writes for user data; all file operations target object storage
- [ ] **Scheduled jobs externalised** — no in-process timers; CronJobs or managed schedulers handle scheduling with `concurrencyPolicy: Forbid` where overlapping runs are unsafe
- [ ] **Routing layer in place** — API gateway or Ingress controller fronts the monolith before first extraction begins
- [ ] **Strangler fig sequencing documented** — extraction order decided by risk, not value; database sharing forbidden at extraction boundaries
- [ ] **Health probes meaningful** — readiness checks application readiness including dependencies; liveness checks only process health
- [ ] **Resource requests and limits measured** — set from actual profiling, not guesses; OOMKilled events in staging caught before production
- [ ] **Graceful shutdown implemented** — SIGTERM handled; in-flight requests complete before pod exits
- [ ] **Autoscaling signal correct** — CPU-based HPA only for compute-bound workloads; KEDA for queue consumers; custom metrics for request-rate-driven services
- [ ] **Observability pipeline running** — structured logging, distributed tracing, and metrics in place before first service extraction
- [ ] **Modernisation sequencing in sprint backlog** — extraction work allocated per sprint alongside feature development, not deferred to a dedicated modernisation sprint

---

## Closing: Modernisation Is a Process, Not a Platform Switch

The mistake at the centre of most failed cloud modernisation programmes is a category error: treating "move to Kubernetes" as the goal rather than as a potential means to a goal. The actual goal is a workload that is easier to scale, safer to deploy, and cheaper to operate than what you had before. Kubernetes can deliver that — for workloads that are architected to use it. For workloads that aren't, it adds operational overhead to architectural debt that was already there, and it makes both harder to address.

The graduation path from lifted workload to cloud-native architecture is not a migration event. It is a sequence of architectural decisions, each of which makes the next one easier: externalise state before containerising, containerise before extracting services, extract services before optimising autoscaling. Skip steps in that sequence and you create dependencies that block later work — you cannot safely extract services from a monolith that still holds session state in process memory, and you cannot tune autoscaling for a service you cannot observe.

The teams that succeed at cloud modernisation in 2026 are not the ones that moved fastest to Kubernetes. They are the ones that were honest about what each of their workloads actually needed — and chose the managed service, the CronJob, the strangler fig extraction, or the decommission path deliberately rather than defaulting to containerisation because it was the obvious next step.

---

> **📌 Key Takeaway**
>
> Kubernetes does not fix lifted workloads — it exposes their architectural assumptions under a new set of operational constraints. The modernisation sequence that works is: categorise workloads honestly and route low-ROI applications to managed services or decommission rather than Kubernetes; redesign for statelessness before containerising; instrument observability before extracting services; use the strangler fig pattern to decompose monoliths incrementally rather than rewriting them; and choose autoscaling signals that match actual load patterns rather than defaulting to CPU. The goal is a workload that's genuinely easier to operate. Kubernetes is one path to that goal, not the destination itself.

***Further Reading: Newman — Building Microservices (O'Reilly, 2021), Fowler — Strangler Fig Application (martinfowler.com, 2004), CNCF — Annual Survey 2025, KEDA — Kubernetes Event-Driven Autoscaling Documentation, Microsoft — Azure Kubernetes Service Best Practices***
