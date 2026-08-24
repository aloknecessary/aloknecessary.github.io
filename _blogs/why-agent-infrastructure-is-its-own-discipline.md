---
layout: blog
title: "Why Agent Infrastructure Is Its Own Discipline"
date: 2026-08-24
last_modified_at: 2026-08-24T14:58:46+05:30
author: Alok Ranjan Daftuar
description: "Deploying an agent on Kubernetes using the standard microservice playbook breaks in predictable ways — liveness probes kill healthy pods mid-reasoning, HPA scales on the wrong signal, and session state has no design at all. This post explains why, precisely."
excerpt: "Deploying an agent is not deploying another microservice. The assumptions baked into a decade of Kubernetes practice quietly break the moment a container starts calling tools instead of just serving requests."
keywords: "agent infrastructure, kubernetes agents, mcp, model context protocol, liveness probe, hpa autoscaling, eks, aks, agentic systems, platform engineering"
twitter_card: "summary_large_image"
categories:
  - ai-engineering
  - cloud
tags: [mcp, kubernetes, agents, platform-engineering, aws, azure, eks, aks, autoscaling, liveness-probe]
series: "Agentic Infrastructure"
series_order: 1
---

> Deploying an agent is not deploying another microservice. The assumptions baked into a decade of Kubernetes practice quietly break the moment a container starts calling tools instead of just serving requests.

Ask a platform team how they're going to run their first production agent, and you'll get a confident answer within about ten seconds: containerize it, put it behind an ingress, wire up a Horizontal Pod Autoscaler, done. It's the same playbook that's shipped every stateless service for the last decade, and there's no obvious reason an agent should be different. It accepts a request. It returns a response. It's just a container.

That answer is wrong, and it's wrong in a way that doesn't show up in a demo. It shows up three weeks into production, when a pod gets killed mid-reasoning because a liveness probe decided a 40-second tool call was a hang, or when the autoscaler adds five replicas because CPU spiked on a single request that's now calling six tools in sequence, or when two "sessions" turn out to share a K8s Service without anyone having reasoned about what that means for isolation.

None of these are exotic failures. They're the direct, predictable consequence of running something that looks like a microservice but doesn't behave like one, on infrastructure primitives designed for the thing it looks like rather than the thing it is.

This article is part of a series on the infrastructure layer underneath agentic systems — the deployment, scaling, and operational patterns that MCP-based agents need on Kubernetes, distinct from the model and application layer covered elsewhere. Before getting into any specific pattern, it's worth being precise about *why* this needs its own discipline instead of inheriting one wholesale from microservice architecture.

## What a request actually looks like

A typical microservice request has a shape platform engineers have spent fifteen years optimizing around: bounded latency, a single unit of compute per request, statelessness between requests, and a clear success/failure signal at the HTTP layer. An agent request breaks all four assumptions at once.

```text
Standard microservice request:
  client -> service -> [DB/cache lookup] -> response
  Duration: milliseconds to low seconds
  Compute: roughly constant per request
  State: none carried between requests (ideally)
  Outcome signal: HTTP status code

Agent request:
  client -> agent -> [reason] -> tool call 1 -> [reason] -> tool call 2
        -> [reason] -> tool call N -> [reason] -> response
  Duration: seconds to minutes, highly variable
  Compute: proportional to reasoning depth and tool fan-out
  State: conversation/task context carried across the entire chain
  Outcome signal: HTTP 200 with a semantically wrong answer is common
```

That last line is the one platform teams underestimate most. An agent that loops on a tool, calls the wrong one, or returns a plausible-but-incorrect result will still return a healthy status code within a normal latency window. The infrastructure layer has no way to distinguish a correct run from a confidently wrong one — that problem belongs to the observability and evaluation layer, not this one. But it's worth naming here because it explains why so many of the fixes below feel unfamiliar: you're building infrastructure for a workload whose failure modes are largely invisible to the infrastructure itself.

## Where the standard playbook breaks

| Microservice assumption | Agent reality | Practical implication |
| --- | --- | --- |
| Liveness = "process is alive and responsive" | A live agent can be legitimately unresponsive for 30–90 seconds mid-tool-call | Naive liveness probes kill healthy pods mid-reasoning |
| CPU/memory tracks load | Load tracks reasoning depth and tool fan-out, not CPU | HPA on CPU/memory over- or under-scales unpredictably |
| Requests are independent | A single task often spans multiple round trips carrying shared context | Session/state handling needs an explicit design, not an assumption |
| One replica serves any request | Tool credentials and context may be tenant-specific | Routing and isolation boundaries need to be architectural, not incidental |
| Timeout = failure | Timeout at 30s might just mean the agent is still reasoning | Timeout budgets have to be set per tool-call chain, not per request |

Each row in that table is a full article later in this series, so this isn't the place to solve any of them fully — but it's worth walking through why each one is a real design problem and not just a tuning exercise.

**Liveness.** A standard liveness probe answers one question: is the process still responding to the network? For a request/response service, that's a reasonable proxy for "is this instance healthy." For an agent, a process can be completely healthy and still not touch its health endpoint for the better part of a minute, because it's blocked on an outbound call to a tool, a vector store, or another model. Treating that silence as a failure and killing the pod doesn't just lose the in-flight request — it can leave a tool call half-executed against an external system with no agent left to reconcile it.

**Autoscaling signal.** CPU and memory utilization correlate reasonably well with load for a service doing computation locally. An agent spends most of its wall-clock time waiting on I/O — model inference calls, tool invocations, retrieval lookups — during which CPU usage looks idle even though the pod is fully occupied with a task. Scale on CPU and you'll under-provision during exactly the bursts that matter, then over-correct once the backlog clears and utilization spikes as queued tasks all execute at once.

**Session and state.** A conversational or multi-step agent task frequently spans several requests that need to share context — prior tool results, intermediate reasoning, user-provided constraints. Standard microservices sidestep this by pushing state into a database and treating every request as independent. Agents can do the same thing, but only if that decision is made deliberately; left unexamined, teams either bolt on sticky sessions (which fights Kubernetes' scheduling model) or silently lose context between hops.

**Isolation boundary.** In a typical multi-tenant service, isolation is usually a data-layer concern — row-level security, tenant IDs in a WHERE clause. An agent's tool layer means isolation has to extend further: which tools a given request is even allowed to see, which credentials it can use to call them, and whether one tenant's conversation context can ever be visible to another's request landing on the same pod. That's an infrastructure-and-application-layer problem jointly, not a database concern alone.

**Timeout budget.** A flat request timeout works when duration is roughly constant. An agent's duration is a function of how many tool calls a given task happens to need, which isn't known in advance. A timeout tuned for the median case kills the tail; one tuned for the tail leaves genuinely stuck requests holding resources for minutes.

None of these are unsolvable — they're solved throughout this series — but each one requires a decision that wouldn't need to be made at all in a conventional service, which is precisely the point: the infrastructure has to be designed for the workload, not adapted after the fact.

It's worth looking at the liveness probe example concretely first, because it's the one that bites teams fastest and is the easiest to demonstrate.

A deployment written with the standard playbook in mind looks like this:

```yaml
# Naive agent deployment — inherited unmodified from microservice conventions
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-agent
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: agent
          image: registry.example.com/mcp-agent:1.4.0
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            periodSeconds: 5
```

With `periodSeconds: 10` and `failureThreshold: 3`, this pod gets killed if `/health` doesn't respond within roughly 30 seconds — which is an entirely normal duration for a single reasoning step that includes a tool call to a slow downstream API. The fix isn't a bigger `failureThreshold`; it's separating "the process is alive" from "the process is making forward progress," which changes what the probe checks, not just its timing.

A more honest version separates those two questions explicitly:

```yaml
# Liveness decoupled from in-flight work
livenessProbe:
  httpGet:
    path: /health          # answers: is the process itself alive?
    port: 8080
  periodSeconds: 15
  timeoutSeconds: 5
  failureThreshold: 3      # ~45s of true unresponsiveness before restart

readinessProbe:
  httpGet:
    path: /ready            # answers: can this pod accept new work right now?
    port: 8080
  periodSeconds: 5
  failureThreshold: 2
```

`/health` here should do nothing more than confirm the process's event loop is running — it should never block on the status of an in-progress tool call. `/ready` is the one that reflects capacity: a pod mid-reasoning on an existing task can report itself not-ready for *new* work without being treated as dead. That distinction — alive versus accepting new work — is what standard microservice health checks conflate by default, because for a request/response service the two questions usually have the same answer. For an agent, they routinely don't, and the deployment needs to say so explicitly rather than inherit a template that assumes they do.

## Why this doesn't split neatly by cloud

It's tempting to treat this as a Kubernetes-versus-managed-service question and let the cloud provider pick the defaults — run agents on EKS with Karpenter handling node provisioning, or lean on AKS with its tighter integration into Azure AD for workload identity. Both are legitimate starting points, and this series will show worked examples on both throughout, but neither vendor's defaults solve the shape problem described above. Karpenter provisions nodes faster and can bin-pack more efficiently than the cluster autoscaler, which helps with the bursty compute pattern of agent workloads — but it still needs a scaling signal that actually reflects agent load, not CPU. AKS's tighter Entra ID integration simplifies workload identity for tool credentials, which helps directly with the isolation boundary problem — but it doesn't change how a liveness probe should be shaped for a process that's legitimately silent for 40 seconds.

The pattern across this series will be to establish the underlying principle first — what the workload actually needs — and then show how that principle gets implemented on EKS and on AKS, because the implementations diverge (IAM roles for service accounts versus workload identity federation, ALB Ingress Controller versus Application Gateway Ingress Controller, EKS managed node groups versus AKS node pools) even when the underlying design goal is identical.

## The piece that changed a month ago

There's a reason this series is starting now rather than a year ago: a large part of the awkwardness in running MCP-based agents on Kubernetes came from the original protocol design, which required persistent, pinned sessions between a client and a specific server instance — the opposite of what horizontally scaled infrastructure wants. That constraint forced teams into sticky routing and shared session stores just to keep a conversation coherent across requests, which is exactly the kind of stateful-transport problem Kubernetes networking wasn't built to make easy.

The July 2026 MCP specification revision removed the protocol-level session entirely. Any request can now land on any server instance, and applications that still need to carry state across calls do it the way HTTP APIs always have — by minting an explicit handle and having it passed back as an ordinary argument on the next call, rather than relying on the transport to remember. That single change is why deployment, routing, and autoscaling patterns for MCP servers look meaningfully different at the end of 2026 than they did a year earlier — it removes an entire category of infrastructure workaround (sticky routing, pinned sessions, shared session stores) that used to be treated as unavoidable.

## Why this matters more than it looks like it should

It's fair to ask whether any of this justifies a full series rather than a paragraph in an existing one. The honest answer is that the cost of getting it wrong compounds quietly. A liveness probe that kills healthy pods doesn't fail loudly — it shows up as an elevated error rate that gets attributed to "model flakiness" or "the tool API being unreliable," and teams spend weeks tuning retry logic and backoff strategies against a problem that's actually a probe misconfiguration one layer down. An autoscaler tuned on the wrong signal doesn't fail either — it just runs 30% more replicas than the workload needs, indefinitely, because nobody has a reason to suspect the scaling metric itself.

This is also why the infrastructure layer deserves separate treatment from the observability layer, even though the two are closely related and will eventually connect. Observability tells you *that* an agent did something wrong — a bad tool call, a hallucinated result, a broken reasoning chain. Infrastructure determines whether the agent had a fair chance to do the right thing in the first place: whether it was killed mid-task, starved of compute during a burst, or given a timeout budget that didn't match the work. Getting the infrastructure layer right doesn't guarantee correct agent behavior, but getting it wrong guarantees you can't tell the difference between an agent that's actually failing and one that's simply being run on infrastructure that wasn't built for it.

> 📌 **Key Takeaway:** An agent is not a slower microservice — it's a workload with a fundamentally different shape (variable-duration, multi-hop, context-carrying, and semantically opaque to the infrastructure layer). Every piece of the standard Kubernetes playbook needs to be re-examined against that shape before it's trusted in production, not inherited by default.
