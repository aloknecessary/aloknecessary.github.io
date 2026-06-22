---
title: "Multi-Agent Systems Architecture: Patterns, Pitfalls, and Production Reality"
published: false
description: The four coordination patterns, orchestration vs choreography, state persistence, inter-agent contracts, cost controls, and the observability that detects "wrong" as distinct from "down"
tags: ai, architecture, distributedsystems, python
canonical_url: https://aloknecessary.github.io/blogs/multi-agent-systems-architecture/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=multi-agent-systems-architecture
cover_image: 
---

An agent stuck in an infinite retry loop doesn't show up in your error rate. It shows up in your AWS bill — eleven days later.

A team ran a multi-agent system for eleven days. Latency normal. Error rate 0.0%. Every dashboard green. Cloud bill: $47,000. The agents were stuck in an infinite retry loop the entire time — because "wrong" doesn't show up in Grafana.

This incident is representative of a failure class unique to multi-agent architecture: agents operating correctly by every infrastructure metric while producing incorrect, looping, or redundant behavior at the application layer.

---

## When Multi-Agent Is Not the Answer

Most teams reach for multi-agent too early. Stay with a single agent when:
- The task fits in one context window (200K Claude / 1M Gemini)
- Latency SLA is under 10 seconds
- Your single-agent baseline isn't tuned yet
- The work is sequential (no parallelism gain)
- You don't have observability infrastructure

Multi-agent earns its complexity for: parallel subtasks, distinct tool access requirements, or failure isolation needs.

---

## The Four Coordination Patterns

**Orchestrator-Worker** (~70% of production deployments): central planner decomposes tasks, dispatches to specialist workers, synthesizes results. Single point of failure but best observability.

**Sequential Pipeline**: fixed linear chain. Deterministic, easy to debug, but latency stacks.

**Dynamic Handoff (Swarm)**: no central coordinator — agents decide who handles what at runtime. Flexible but prone to infinite handoff loops.

**Hierarchical**: orchestrators managing sub-orchestrators. For large-scale decomposition where a single orchestrator can't hold the full planning state.

---

## State Persistence: Demo vs Production

The single capability that separates them: persisting intermediate results so workflows can pause, resume, and retry individual failed agents without restarting from scratch. Checkpoint at every task-level status transition to durable storage (Postgres, Temporal).

---

## Inter-Agent Contracts

**MCP** for agent-to-tool communication. **A2A** for agent-to-agent. Beyond protocols: every handoff needs a typed, validated Pydantic model. Validation runs at the boundary — not three agents downstream when bad data causes inscrutable errors.

---

## Cost Controls

- **Budget per workflow run** — total token budget tracked and enforced across all agents
- **Model tier routing** — frontier model only for reasoning-heavy steps; Haiku for routing/classification/formatting
- **Hard retry ceiling** — `attempt_count >= 3` terminates, not retries forever
- **Sequential before parallel** — fan-out increases total spend even when it reduces latency

---

## Observability: Detecting "Wrong"

Standard metrics detect whether agents are *running*. Multi-agent systems need metrics that detect whether agents are *making progress*:

- **Workflow completion rate** — not error rate
- **Retry anomaly detection** — total retries significantly exceeding task count = stuck loop
- **Cost per workflow run** — token counts aggregated per workflow ID
- **Per-agent failure rate** — which role is the common failure point

The $47K alert: flag any workflow where `sum(attempt_count) > 2 * len(tasks)`.

---

## Read the Full Article

This is a summary of my deep dive into multi-agent production architecture. The full article covers all patterns with implementation examples:

**👉 [Multi-Agent Systems Architecture — Full Article](https://aloknecessary.github.io/blogs/multi-agent-systems-architecture/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=multi-agent-systems-architecture)**

The full article includes:
- When multi-agent is NOT the answer (5 heuristics)
- Four coordination patterns with architecture diagrams
- Orchestration vs choreography comparison table
- WorkflowState persistence with checkpoint-level granularity (Python dataclasses)
- Inter-agent contracts with Pydantic validation
- MCP and A2A protocol roles explained
- Circuit breaker implementation for agent calls
- Saga pattern for side-effectful agent workflows
- Cost control patterns (budget caps, model tiers, retry ceilings)
- OTel tracing decorator for agent calls
- Retry anomaly detection alert logic
- Production deployment checklist (15 items)
