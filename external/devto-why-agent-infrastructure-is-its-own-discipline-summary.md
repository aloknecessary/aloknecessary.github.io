---
title: "Why Agent Infrastructure Is Its Own Discipline"
published: false
description: The standard Kubernetes microservice playbook breaks in predictable ways when you run agents on it — here's exactly why, and what needs to change.
tags: kubernetes, ai, platform, devops
canonical_url: https://aloknecessary.in/blogs/why-agent-infrastructure-is-its-own-discipline/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=why-agent-infrastructure-is-its-own-discipline
cover_image:
---

Ask a platform team how they're going to run their first production agent and you'll get a confident answer within ten seconds: containerize it, put it behind an ingress, wire up a Horizontal Pod Autoscaler, done. It's the same playbook that's shipped every stateless service for the last decade, and there's no obvious reason an agent should be different. It accepts a request. It returns a response. It's just a container.

That answer is wrong — and it's wrong in a way that doesn't show up in a demo. It shows up three weeks into production, when a pod gets killed mid-reasoning because a liveness probe decided a 40-second tool call was a hang, or when the autoscaler adds five replicas because CPU spiked on a single request calling six tools in sequence, or when two "sessions" turn out to share a K8s Service without anyone having reasoned about what that means for isolation.

---

## The shape of an agent request vs. a microservice request

A typical microservice request has a shape platform engineers have spent fifteen years optimizing around: bounded latency, a single unit of compute per request, statelessness between requests, and a clear success/failure signal at the HTTP layer. An agent request breaks all four at once.

```text
Standard microservice request:
  client -> service -> [DB/cache lookup] -> response
  Duration: milliseconds to low seconds
  Compute: roughly constant per request
  State: none carried between requests
  Outcome signal: HTTP status code

Agent request:
  client -> agent -> [reason] -> tool call 1 -> [reason] -> tool call 2
        -> [reason] -> tool call N -> [reason] -> response
  Duration: seconds to minutes, highly variable
  Compute: proportional to reasoning depth and tool fan-out
  State: conversation/task context carried across the entire chain
  Outcome signal: HTTP 200 with a semantically wrong answer is common
```

That last line is the one platform teams underestimate most. An agent that loops on a tool, calls the wrong one, or returns a plausible-but-incorrect result will still return a healthy status code. The infrastructure layer has no way to distinguish a correct run from a confidently wrong one.

---

## Where the standard playbook breaks

| Microservice assumption | Agent reality | Practical implication |
| --- | --- | --- |
| Liveness = "process is alive and responsive" | A live agent can be legitimately unresponsive for 30–90 seconds mid-tool-call | Naive liveness probes kill healthy pods mid-reasoning |
| CPU/memory tracks load | Load tracks reasoning depth and tool fan-out, not CPU | HPA on CPU/memory over- or under-scales unpredictably |
| Requests are independent | A single task often spans multiple round trips carrying shared context | Session/state handling needs an explicit design, not an assumption |
| One replica serves any request | Tool credentials and context may be tenant-specific | Routing and isolation boundaries need to be architectural, not incidental |
| Timeout = failure | Timeout at 30s might just mean the agent is still reasoning | Timeout budgets have to be set per tool-call chain, not per request |

---

## The liveness probe problem, concretely

With `periodSeconds: 10` and `failureThreshold: 3`, a standard probe kills a pod if `/health` doesn't respond within roughly 30 seconds — which is an entirely normal duration for a reasoning step that includes a tool call to a slow downstream API.

The fix isn't a bigger `failureThreshold`. It's separating "the process is alive" from "the process is making forward progress":

```yaml
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

`/health` should do nothing more than confirm the process's event loop is running — never block on the status of an in-progress tool call. `/ready` reflects capacity: a pod mid-reasoning can report itself not-ready for new work without being treated as dead. For a request/response service these two questions have the same answer. For an agent, they routinely don't.

---

## Why the July 2026 MCP spec change matters for infrastructure

A large part of the awkwardness in running MCP-based agents on Kubernetes came from the original protocol design, which required persistent, pinned sessions between a client and a specific server instance — the opposite of what horizontally scaled infrastructure wants. That constraint forced teams into sticky routing and shared session stores just to keep a conversation coherent across requests.

The July 2026 MCP specification revision removed the protocol-level session entirely. Any request can now land on any server instance, and applications that need to carry state across calls do it the way HTTP APIs always have — by minting an explicit handle passed back as an ordinary argument, rather than relying on the transport to remember. That single change removes an entire category of infrastructure workaround (sticky routing, pinned sessions, shared session stores) that used to be treated as unavoidable.

---

## Why the cost of getting this wrong compounds quietly

A liveness probe that kills healthy pods doesn't fail loudly — it shows up as an elevated error rate attributed to "model flakiness" or "the tool API being unreliable," and teams spend weeks tuning retry logic against a problem that's actually a probe misconfiguration one layer down. An autoscaler tuned on the wrong signal doesn't fail either — it just runs 30% more replicas than the workload needs, indefinitely, because nobody has a reason to suspect the scaling metric itself.

Getting the infrastructure layer right doesn't guarantee correct agent behavior, but getting it wrong guarantees you can't tell the difference between an agent that's actually failing and one that's simply being run on infrastructure that wasn't built for it.

---

## Read the Full Article

The summary covers the core argument. The full article goes deeper on:

- The full breakdown of each assumption failure — autoscaling signal, session and state design, isolation boundaries, and timeout budget — with the specific production failure mode each one produces
- Why EKS and AKS don't solve the shape problem by default, and how the implementations diverge (IRSA vs. workload identity federation, ALB Ingress vs. Application Gateway) even when the underlying design goal is identical
- The complete naive vs. corrected deployment YAML side-by-side, with the exact reasoning behind each change

**👉 [Why Agent Infrastructure Is Its Own Discipline — Full Article](https://aloknecessary.in/blogs/why-agent-infrastructure-is-its-own-discipline/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=why-agent-infrastructure-is-its-own-discipline)**
