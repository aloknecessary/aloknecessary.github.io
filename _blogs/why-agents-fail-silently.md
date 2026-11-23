---
title: "Why Agents Fail Silently (and APM Won't Catch It)"
date: 2026-11-23
last_modified_at: 2026-11-23T17:16:57+05:30
author: Alok Ranjan Daftuar
description: "APM dashboards stay green while agents loop, wander, truncate, or overspend tokens. This post explains why per-request observability misses agent failures and shows how one structured log line per step, with hashes instead of payloads and budgets enforced inside the loop, gives you the first honest picture of how your agent behaves in production."
excerpt: "An agent can loop forty times, burn a day's token budget, and return a clean 200. Your APM dashboard will stay green. Here is a failure taxonomy for agent runs and the structured-log setup that catches each one, with no new tooling."
keywords: "agent observability, ai agents, structured logging, apm, cloudwatch logs insights, azure monitor, mcp, runaway loop detection, token budget, agent monitoring"
twitter_card: "summary_large_image"
categories:
  - ai-engineering
tags: [ai-agents, observability, structured-logging, mcp, cloudwatch, azure-monitor]
series: "Agent Observability"
series_order: 1
---

## Green dashboards, broken agent

A ticket-triage agent runs on a Tuesday. One run takes eleven minutes instead of the usual forty seconds. It calls the same search tool forty-three times with identical arguments, consumes sixty times the normal token count, and finally returns an answer that reads well and is wrong. The HTTP response is a 200. (The numbers are illustrative; the shape is common.)

Nothing in the standard dashboard moves. Error rate is zero. Median latency is unchanged, because this is one run among thousands. The pod never failed a health check. By every measure the monitoring stack was built around, the system is healthy, and an agent spent eleven minutes going nowhere.

The assumption that breaks here is old and reasonable: if latency and error rate are green, the service is working. It holds for a request/response service because success and failure are properties of a single exchange. An agent run is a loop of decisions, and the failure lives in the sequence rather than in any one step. Every individual call in that loop can succeed.

[Why Agent Infrastructure Is Its Own Discipline](/blogs/why-agent-infrastructure-is-its-own-discipline/) made the infrastructure side of this argument: a pod can be alive and passing probes while the agent inside it makes no useful progress, and the platform can't tell the difference. This series works one layer up. The question isn't whether the process is running but whether the run is getting anywhere, and the starting point needs nothing beyond the logs you already collect.

## Six ways a run goes wrong without an error

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

## One log line per step

The minimum viable setup is three kinds of JSON line written to stdout: one per model call, one per tool call, and one summary at the end of each run. Every line carries the same `run_id`. Stdout is deliberate: on EKS and AKS the cluster's log agent already ships it to CloudWatch Logs or Log Analytics, so there's no new pipeline to run.

Two design decisions matter more than the field list. First, log fingerprints, not payloads. Prompts, tool arguments, and tool results routinely contain customer data and secrets, and a log line is a long-lived, widely readable copy of whatever you put in it. A hash of the arguments and the byte size of the result carry the signal without the exposure. Second, the hash has to be computed over a canonical form, because `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same call and must produce the same fingerprint, or the repeat detector will miss exactly the loops it exists to find:

```typescript
import { createHash } from "node:crypto";

type StepLog = {
  kind: "model_call" | "tool_call";
  run_id: string;
  step: number;
  ts: string;
  tool?: string;
  args_hash?: string;
  status?: "ok" | "error";
  result_bytes?: number;
  finish_reason?: string;
  tokens_in?: number;
  tokens_out?: number;
  duration_ms: number;
};

type RunSummary = {
  kind: "run_summary";
  run_id: string;
  ts: string;
  outcome: "completed" | "budget_exceeded" | "loop_detected";
  steps: number;
  tool_calls: number;
  tool_errors: number;
  empty_results: number;
  total_tokens: number;
  duration_ms: number;
};

const emit = (line: StepLog | RunSummary) =>
  process.stdout.write(JSON.stringify(line) + "\n");

// Sorted keys, recursively: key order must not change the fingerprint
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

Sixteen hex characters is plenty to distinguish calls within one run. The point isn't cryptographic strength but a stable, short key that's safe to store.

## Put the budget in the loop

Detecting a runaway after the fact tells you what it cost. Stopping it costs nothing, so the same counters that feed the logs should also bound the run. The loop below is deliberately framework-agnostic: `callModel` and `callTool` are whatever your MCP client and model SDK provide.

```typescript
import { randomUUID } from "node:crypto";

type Budget = { maxSteps: number; maxTokens: number; maxRepeats: number };

export async function runAgent(task: string, deps: Deps, budget: Budget) {
  const runId = randomUUID();
  const started = Date.now();
  const seen = new Map<string, number>();
  const messages: Message[] = [{ role: "user", content: task }];
  let step = 0, tokens = 0, toolCalls = 0, toolErrors = 0, emptyResults = 0;
  let outcome: RunSummary["outcome"] = "completed";

  while (true) {
    if (++step > budget.maxSteps) { outcome = "budget_exceeded"; break; }

    const t0 = Date.now();
    const turn = await deps.callModel(messages);
    tokens += turn.tokensIn + turn.tokensOut;
    emit({
      kind: "model_call", run_id: runId, step, ts: new Date().toISOString(),
      finish_reason: turn.finishReason,
      tokens_in: turn.tokensIn, tokens_out: turn.tokensOut,
      duration_ms: Date.now() - t0,
    });

    if (tokens > budget.maxTokens) { outcome = "budget_exceeded"; break; }
    if (!turn.toolCall) break;                       // the model is done

    const { name, args } = turn.toolCall;
    const hash = argsHash(args);
    const key = `${name}:${hash}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > budget.maxRepeats) { outcome = "loop_detected"; break; }

    const t1 = Date.now();
    let status: "ok" | "error" = "ok";
    let bytes = 0;
    toolCalls++;
    try {
      const result = await deps.callTool(name, args);
      bytes = Buffer.byteLength(JSON.stringify(result) ?? "");
      if (bytes === 0) emptyResults++;
      messages.push({ role: "tool", content: result });
    } catch (err) {
      status = "error";
      toolErrors++;
      messages.push({ role: "tool", content: { error: String(err) } });
    }
    emit({
      kind: "tool_call", run_id: runId, step, ts: new Date().toISOString(),
      tool: name, args_hash: hash, status, result_bytes: bytes,
      duration_ms: Date.now() - t1,
    });
  }

  emit({
    kind: "run_summary", run_id: runId, ts: new Date().toISOString(),
    outcome, steps: step, tool_calls: toolCalls, tool_errors: toolErrors,
    empty_results: emptyResults, total_tokens: tokens,
    duration_ms: Date.now() - started,
  });
}
```

Two choices in there deserve a second look. The repeat limit is per `(tool, args_hash)` pair, not per tool: calling a search tool six times with six different queries is research, while calling it six times with the same query is a loop. And `maxRepeats` should be configurable per tool, because some calls legitimately repeat, such as polling a job status. A blanket limit of three will cut off a healthy run that's waiting on a slow downstream job.

The run summary is the line the rest of this article leans on. It turns "what happened in this run" into one row, which is what makes the queries below short.

## Queries that catch each failure

Both queries below assume the JSON lines are collected from stdout and parsed into fields. On EKS that means the CloudWatch agent or Fluent Bit merging the JSON into the log event; if your pipeline nests it under another key, prefix the field names to match. On AKS, Container Insights stores the line in `ContainerLogV2`, and the KQL parses it from `LogMessage`.

**Runaway loops: identical calls repeated within a run.**

```sql
# CloudWatch Logs Insights
fields @timestamp, run_id, tool, args_hash
| filter kind = "tool_call"
| stats count(*) as calls by run_id, tool, args_hash
| filter calls >= 3
| sort calls desc
| limit 50
```

```kusto
// Azure Monitor / Log Analytics
ContainerLogV2
| where TimeGenerated > ago(1h)
| extend e = parse_json(LogMessage)
| where tostring(e.kind) == "tool_call"
| summarize calls = count() by run_id = tostring(e.run_id),
                               tool = tostring(e.tool),
                               args_hash = tostring(e.args_hash)
| where calls >= 3
| order by calls desc
```

**Wandering and cost runaway: the distribution of steps and tokens per run.** These need a baseline rather than a threshold, so the query returns percentiles over time:

```sql
# CloudWatch Logs Insights
filter kind = "run_summary"
| stats pct(steps, 50) as p50_steps, pct(steps, 95) as p95_steps,
        pct(total_tokens, 95) as p95_tokens, max(total_tokens) as max_tokens
  by bin(1h)
```

```kusto
// Azure Monitor / Log Analytics
ContainerLogV2
| where TimeGenerated > ago(24h)
| extend e = parse_json(LogMessage)
| where tostring(e.kind) == "run_summary"
| summarize p50_steps = percentile(toint(e.steps), 50),
            p95_steps = percentile(toint(e.steps), 95),
            p95_tokens = percentile(toint(e.total_tokens), 95),
            max_tokens = max(toint(e.total_tokens))
  by bin(TimeGenerated, 1h)
```

**Empty results with a confident answer: completed runs that saw empty tool output.**

```sql
# CloudWatch Logs Insights
filter kind = "run_summary" and outcome = "completed" and empty_results > 0
| stats count(*) as runs by bin(1h)
```

```kusto
// Azure Monitor / Log Analytics
ContainerLogV2
| where TimeGenerated > ago(24h)
| extend e = parse_json(LogMessage)
| where tostring(e.kind) == "run_summary"
    and tostring(e.outcome) == "completed"
    and toint(e.empty_results) > 0
| summarize runs = count() by bin(TimeGenerated, 1h)
```

Truncation and silent tool failure need no new query: filter `model_call` lines for a `finish_reason` of `length`, and compare `tool_errors` to `tool_calls` in the run summary.

## Baseline before you alert

The distribution query is the one to run first, and for a week before setting any thresholds. A step budget of 10 is wrong for an agent whose healthy runs use 14, and it's equally wrong for one whose p95 is 4. Set `maxSteps` and `maxTokens` at two to three times the observed p95, then revisit them whenever the tool set changes, since adding one slow, chatty tool shifts the whole distribution.

Enforcing a budget on day one has a risk of its own: a limit set too low cuts off healthy runs and turns a monitoring change into a user-facing regression. A safer rollout is to run the limits in log-only mode first. Have the loop emit the outcome it *would* have produced, such as `would_have_stopped: true` on the summary line, without actually breaking, and compare that against the baseline for a few days. Once the false-positive rate is acceptable, switch the limits to enforcing.

One implementation detail is easy to get wrong in Node: the `run_id` has to follow the run through every async call, including tool handlers and retry wrappers that don't receive it as an argument. Threading it through every function signature works for a small loop and becomes brittle quickly. `AsyncLocalStorage` from `node:async_hooks` carries it implicitly across awaits, so any log line emitted anywhere inside the run picks up the same identifier without the call sites knowing about it.

Once the budgets exist, the loop reports its own failures. A run that hits a limit ends with `outcome: "budget_exceeded"` or `"loop_detected"`, and those outcomes are the cleanest alert signals the system produces. On AWS, a metric filter turns them into a CloudWatch metric you can alarm on:

```bash
aws logs put-metric-filter \
  --log-group-name /aws/containerinsights/<cluster>/application \
  --filter-name agent-budget-exceeded \
  --filter-pattern '{ $.kind = "run_summary" && $.outcome != "completed" }' \
  --metric-transformations \
      metricName=AgentRunsNotCompleted,metricNamespace=Agents,metricValue=1,defaultValue=0
```

On Azure, the equivalent is a scheduled query alert rule over the same `run_summary` filter in KQL, with a threshold on the count per evaluation window. Alert on the rate of non-completed runs rather than on any single one: a lone `loop_detected` is the guard doing its job, while a rising rate means something upstream changed, such as a tool's behavior, a prompt, or a model version.

## What logs can't tell you

This setup catches the six failures above, but it has real limits. A step log says a tool call happened at step 7; it doesn't say which model decision caused it, how its latency nested inside the step that made it, or what happened downstream when the call crossed a service boundary. The `run_id` ties records together, and nothing more: there's no parent-child structure and no propagation across processes. That gap is real, and closing it is where this series goes next.

There's also a cost question. One line per step is cheap for a modest workload and adds up at volume, and the log pipeline's retention and query pricing should be checked before turning this on for every run in a high-traffic system. Because the lines contain only hashes and counts, the volume is small per line, but the line count scales with steps.

What this does buy is immediate: you can start tonight, with the log agent already running on the cluster, and know within a day whether your agent has runaway runs you've never seen.

> 📌 **Key Takeaway:** Agent failures are properties of a run, not of a request, so APM's per-request view can stay green while an agent loops, wanders, truncates, or overspends. One structured log line per step and one summary per run, with hashes instead of payloads and budgets enforced inside the loop, gives you a baseline, a set of alertable outcomes, and the first honest picture of how your agent behaves in production.
