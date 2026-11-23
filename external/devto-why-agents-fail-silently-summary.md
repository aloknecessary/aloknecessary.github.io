---
title: "Why Agents Fail Silently (and APM Won't Catch It)"
published: false
description: APM dashboards stay green while agents loop, wander, truncate, or overspend tokens — here is the structured-log setup that catches each failure with no new tooling.
tags: ai-agents, observability, cloudwatch, azure-monitor
canonical_url: https://aloknecessary.in/blogs/why-agents-fail-silently/
cover_image:
cover_image_prompt: >
  A dark, cinematic tech illustration of an autonomous agent run spiraling into a silent loop — glowing log lines stream downward in a dark terminal, a circular arrow traces the same path repeatedly, and a green status indicator stays lit despite the chaos beneath. No humans, no hands, no text. Deep dark background (#0d1117), neon accent colors (electric blue, violet, soft cyan). Wide banner format, 16:9 aspect ratio. Flat-meets-glow aesthetic, suitable for a technical blog header.
---

A ticket-triage agent runs on a Tuesday. One run takes eleven minutes instead of the usual forty seconds. It calls the same search tool forty-three times with identical arguments, consumes sixty times the normal token count, and finally returns an answer that reads well — and is wrong. The HTTP response is a 200.

Nothing in the standard dashboard moves. Error rate is zero. Median latency is unchanged. The pod never failed a health check. By every measure the monitoring stack was built around, the system is healthy.

The assumption that breaks here is old and reasonable: if latency and error rate are green, the service is working. It holds for a request/response service because success and failure are properties of a single exchange. An agent run is a loop of decisions, and the failure lives in the sequence rather than in any one step. Every individual call in that loop can succeed.

---

## Six Ways a Run Goes Wrong Without an Error

APM sees one request with a status code and a duration. Each of these failures is invisible at that granularity and obvious at the granularity of a run:

| Failure | What APM sees | What actually happened | Signal that catches it |
| --- | --- | --- | --- |
| **Runaway loop** | One slow 200 | Same tool, same arguments, repeated | Identical `(tool, args)` count per run |
| **Wandering** | One slow 200 | Many steps, no repeats, no progress | Steps per run against a baseline |
| **Silent tool failure** | A 200 | Tool errors absorbed and retried until something worked | Tool error rate per run |
| **Empty result, confident answer** | A 200 | Tool returned nothing; the model answered anyway | Completed run with empty tool results |
| **Truncation** | A 200 | Output or context cut off mid-thought | `finish_reason` of `length` |
| **Cost runaway** | A 200 | Normal-looking run, abnormal token spend | Tokens per run against a baseline |

Four of the six produce no repeated call at all, which is why a single "loop detector" isn't enough. The signals are different, but they all come from the same raw material: a record of each step in a run, tied together by a run identifier.

## One Log Line Per Step

The minimum viable setup is three kinds of JSON line written to stdout: one per model call, one per tool call, and one summary at the end of each run. Every line carries the same `run_id`. Stdout is deliberate — on EKS and AKS the cluster's log agent already ships it to CloudWatch Logs or Log Analytics, so there's no new pipeline to run.

Two design decisions matter more than the field list. First, log fingerprints, not payloads. Prompts, tool arguments, and tool results routinely contain customer data and secrets. A hash of the arguments and the byte size of the result carry the signal without the exposure. Second, the hash must be computed over a canonical form — `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same call and must produce the same fingerprint, or the repeat detector will miss exactly the loops it exists to find:

```typescript
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const argsHash = (args: unknown) =>
  createHash("sha256").update(canonicalJson(args)).digest("hex").slice(0, 16);
```

## Put the Budget in the Loop

Detecting a runaway after the fact tells you what it cost. Stopping it costs nothing, so the same counters that feed the logs should also bound the run. The repeat limit is per `(tool, args_hash)` pair, not per tool — calling a search tool six times with six different queries is research, while calling it six times with the same query is a loop.

```typescript
const key = `${name}:${hash}`;
const count = (seen.get(key) ?? 0) + 1;
seen.set(key, count);
if (count > budget.maxRepeats) { outcome = "loop_detected"; break; }
```

The run summary is the line everything else leans on — it turns "what happened in this run" into one row, which is what makes the queries short.

## Queries That Catch Each Failure

**Runaway loops** — identical calls repeated within a run:

```sql
-- CloudWatch Logs Insights
fields @timestamp, run_id, tool, args_hash
| filter kind = "tool_call"
| stats count(*) as calls by run_id, tool, args_hash
| filter calls >= 3
| sort calls desc
```

```kusto
// Azure Monitor / Log Analytics
ContainerLogV2
| extend e = parse_json(LogMessage)
| where tostring(e.kind) == "tool_call"
| summarize calls = count() by run_id = tostring(e.run_id),
                               tool = tostring(e.tool),
                               args_hash = tostring(e.args_hash)
| where calls >= 3
```

**Wandering and cost runaway** — percentile distribution of steps and tokens per run, run weekly before setting any thresholds.

**Empty results with a confident answer** — completed runs where `empty_results > 0` in the summary line.

## Baseline Before You Alert

Run the distribution query for a week before setting any thresholds. A step budget of 10 is wrong for an agent whose healthy runs use 14. Set `maxSteps` and `maxTokens` at two to three times the observed p95, then revisit whenever the tool set changes.

A safer rollout is to run limits in log-only mode first — emit `would_have_stopped: true` on the summary line without actually breaking, and compare against the baseline for a few days. Once the false-positive rate is acceptable, switch to enforcing.

On AWS, a metric filter turns non-completed outcomes into a CloudWatch alarm:

```bash
aws logs put-metric-filter \
  --log-group-name /aws/containerinsights/<cluster>/application \
  --filter-name agent-budget-exceeded \
  --filter-pattern '{ $.kind = "run_summary" && $.outcome != "completed" }' \
  --metric-transformations \
      metricName=AgentRunsNotCompleted,metricNamespace=Agents,metricValue=1,defaultValue=0
```

Alert on the *rate* of non-completed runs rather than on any single one — a lone `loop_detected` is the guard doing its job, while a rising rate means something upstream changed.

## What Logs Can't Tell You

This setup catches the six failures above, but it has real limits. A step log says a tool call happened at step 7; it doesn't say which model decision caused it, how its latency nested inside the step, or what happened downstream when the call crossed a service boundary. The `run_id` ties records together and nothing more — there's no parent-child structure and no propagation across processes. That gap is real, and closing it is where this series goes next.

---

## Read the Full Article

The full post covers:

- Complete TypeScript type definitions for `StepLog` and `RunSummary`
- The full framework-agnostic agent loop with budget enforcement wired in
- Why `maxRepeats` should be configurable per tool (polling vs. search)
- The `AsyncLocalStorage` pattern for threading `run_id` across async calls without polluting every function signature
- Full CloudWatch Logs Insights and KQL queries for all six failure modes
- The cost considerations for high-traffic systems

**👉 [Why Agents Fail Silently (and APM Won't Catch It) — Full Article](https://aloknecessary.in/blogs/why-agents-fail-silently/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=why-agents-fail-silently)**
