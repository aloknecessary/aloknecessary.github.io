---
title: "Agentic RAG: Designing Self-Correcting Retrieval Loops for Production"
date: 2026-06-17
last_modified_at: 2026-06-17
author: Alok Ranjan Daftuar
description: "A production architecture guide to agentic RAG — query planning, iterative retrieval, reflection agents, tool-call orchestration, routing logic, failure isolation, and the cost and latency trade-offs that determine when agentic loops earn their complexity."
excerpt: "Standard RAG retrieves once and hopes for the best. Agentic RAG retrieves, reflects, decides it was wrong, and tries again. This post covers the full architecture — query planning, iterative retrieval loops, reflection agents, multi-tool orchestration, routing, loop bounding, cost modeling, and the observability that makes agentic systems accountable."
keywords: "agentic RAG, self-correcting retrieval, reflection agent, query planning, iterative retrieval, tool orchestration, LLM agents, production AI, retrieval loops, RAG architecture"
twitter_card: summary_large_image
categories:
  - ai
  - architecture
tags: [ai, rag, agents, llm, retrieval, architecture, observability, production, patterns, system-design]
series: "RAG and AI Engineering"
series_order: 4
---


> Standard RAG retrieves once and hopes for the best. Agentic RAG retrieves, reflects, decides it was wrong, and tries again — without being told to.

## When One Retrieval Pass Is Not Enough

Standard RAG has an architecture flaw that is easy to miss in prototypes and impossible to ignore in production: it retrieves once. The pipeline takes the user's query, fires a retrieval call, assembles whatever comes back into context, and hands it to the LLM. If the retrieval was good, the answer is good. If the retrieval was bad — wrong chunks, insufficient depth, misread query intent — the LLM produces a confident answer from inadequate evidence.

The pipeline does not know the retrieval was bad. It has no mechanism to check. It cannot say "these chunks do not actually contain the answer to this question" and try a different query. It commits to its first retrieval attempt and generates forward regardless.

This works acceptably for simple factual queries with unambiguous intent and a well-indexed corpus. It breaks on multi-hop questions that require synthesizing information across documents, ambiguous queries that need intent resolution before retrieval makes sense, analytical questions that require sequenced lookups building on each other, and edge cases where the first query formulation retrieves plausible but off-target content.

Agentic RAG is the architectural response to this limitation. Instead of a fixed retrieve-then-generate pipeline, an agentic system treats retrieval as a tool available to a reasoning loop — one the LLM can call multiple times, with different queries, in different sequences, until it judges that it has sufficient evidence to produce a grounded answer. The LLM does not just consume retrieved context. It decides what to retrieve, evaluates what came back, and determines when to stop.

This is not a marginal improvement. On complex query classes, the quality difference between single-pass RAG and agentic retrieval loops is significant enough to change whether the system is usable at all. But agentic loops introduce latency, cost, and failure modes that single-pass systems do not have. The engineering challenge is not implementing agentic retrieval — frameworks make that easy. The challenge is knowing when to use it, bounding its behavior in production, and building the observability to understand what it is actually doing.

> **Article context:** This post is part of the RAG production series. The [Building Reliable RAG Pipelines](/blogs/rag_prototype_to_production/) post covers the standard single-pass pipeline in full. The [LLM Evaluation in Production](/blogs/llm-evaluation-in-production/) post covers how to measure generation quality — both posts are relevant context for reasoning about when agentic complexity is justified and how to detect when the loops are not working.

### Table of Contents

- [When One Retrieval Pass Is Not Enough](#when-one-retrieval-pass-is-not-enough)
- [1. The Agentic RAG Architecture](#1-the-agentic-rag-architecture)
- [2. Query Planning — Decomposing Before Retrieving](#2-query-planning--decomposing-before-retrieving)
- [3. Iterative Retrieval — The Core Loop](#3-iterative-retrieval--the-core-loop)
- [4. The Reflection Agent — Deciding When to Stop](#4-the-reflection-agent--deciding-when-to-stop)
- [5. Tool-Based Retrieval Orchestration](#5-tool-based-retrieval-orchestration)
- [6. Routing — When to Go Agentic and When Not To](#6-routing--when-to-go-agentic-and-when-not-to)
- [7. Failure Isolation and Loop Bounding](#7-failure-isolation-and-loop-bounding)
- [8. Cost and Latency Trade-offs](#8-cost-and-latency-trade-offs)
- [9. Observability for Agentic Loops](#9-observability-for-agentic-loops)
- [The Agentic RAG Checklist](#the-agentic-rag-checklist)
- [Closing: Agency Without Accountability Is Just Unpredictability](#closing-agency-without-accountability-is-just-unpredictability)

---

## 1. The Agentic RAG Architecture

Before implementation, establish the architecture precisely. Agentic RAG is not a single pattern — it is a family of patterns that sit on a spectrum from lightly iterative to fully autonomous. Understanding where on that spectrum your system sits is the first engineering decision.

```text
User Query
    │
    ▼
[QUERY ROUTER]
    │  Is this complex enough to warrant agentic retrieval?
    ├── NO  → Single-pass RAG (fast path)
    └── YES ▼
        [QUERY PLANNER]
            │  Decompose into sub-queries if multi-hop
            │  Identify required retrieval tools
            ▼
        ┌─────────────────────────────────────────┐
        │          AGENTIC RETRIEVAL LOOP         │
        │                                         │
        │  ┌─────────────┐    ┌─────────────────┐ │
        │  │  RETRIEVAL  │    │   REFLECTION    │ │
        │  │    AGENT    │───▶│     AGENT       │ │
        │  │             │    │                 │ │
        │  │ - BM25      │◀───│ - Sufficient?   │ │
        │  │ - Vector    │    │ - On-topic?     │ │
        │  │ - Filtered  │    │ - Gaps remain?  │ │
        │  │ - Web       │    │ - Rewrite query?│ │
        │  └─────────────┘    └────────┬────────┘ │
        │                              │          │
        │                   SUFFICIENT │          │
        └──────────────────────────────┼──────────┘
                                       ▼
                              [CONTEXT ASSEMBLY]
                                       │
                                       ▼
                              [LLM GENERATION]
                                       │
                                       ▼
                                   Response
```

The key architectural distinction from standard RAG: the reflection agent sits between retrieval and generation, and it has the authority to send the loop back to retrieval with a modified query rather than proceeding to generation. Generation only happens when the reflection agent judges the accumulated context as sufficient.

Three patterns dominate production deployments, in increasing order of complexity:

**Pattern 1 — Iterative Query Refinement.** Single retrieval tool. The loop refines the query on each pass based on what the previous pass returned. Simplest to implement and operate. Handles ambiguous queries and mild retrieval failures well.

**Pattern 2 — Multi-Tool Orchestration.** Multiple retrieval tools (keyword search, semantic search, filtered search, external lookup). The agent selects which tool to call on each iteration. Handles diverse query types and knowledge sources. Requires careful tool design to prevent the agent from making poor tool selections.

**Pattern 3 — Hierarchical Agent Decomposition.** A planner agent decomposes multi-hop queries into sub-queries and spawns child retrieval agents for each. Results are synthesized by a parent agent before generation. Highest quality for complex analytical queries. Highest latency, cost, and operational complexity.

Choose Pattern 1 as your default. Move to Pattern 2 when you have genuinely heterogeneous retrieval sources. Reserve Pattern 3 for analytical workloads where answer quality justifies 5–15 second response times.

---

{% raw %}

## 2. Query Planning — Decomposing Before Retrieving

Multi-hop queries — the class that single-pass RAG handles worst — require information from multiple, sequentially dependent retrieval steps. A query like "What was the revenue impact of the product change introduced in Q3 and how does it compare to the previous year's equivalent period?" cannot be answered from a single retrieval pass. It requires: (1) retrieve the Q3 product change, (2) retrieve Q3 revenue data, (3) retrieve prior year Q3 revenue data, (4) synthesize comparison.

A query planner turns a complex query into an explicit retrieval plan before any retrieval happens.

```python
import anthropic
import json
from dataclasses import dataclass, field

client = anthropic.Anthropic()

QUERY_PLANNER_PROMPT = """You are a query planning agent for a retrieval-augmented system.
Your job is to analyze a user query and determine the retrieval strategy.

Given the user query, output a retrieval plan as JSON with:
- query_type: "simple" | "multi_hop" | "analytical" | "ambiguous"
- requires_agentic: true/false
- reasoning: why you classified it this way
- sub_queries: list of ordered retrieval steps if multi-hop (empty for simple queries)
  Each sub_query has: id, query, depends_on (list of sub_query ids whose results inform this query)

Classification rules:
- simple: single factual lookup, clear intent, single document likely sufficient
- multi_hop: requires chaining multiple retrievals where later steps depend on earlier results
- analytical: requires retrieving, aggregating, and comparing information across multiple sources
- ambiguous: query intent is unclear; requires clarification or broad initial retrieval before narrowing

Respond ONLY with valid JSON. No preamble, no markdown fences.

User query: {query}"""

@dataclass
class SubQuery:
    id: str
    query: str
    depends_on: list[str] = field(default_factory=list)

@dataclass
class QueryPlan:
    original_query: str
    query_type: str          # simple | multi_hop | analytical | ambiguous
    requires_agentic: bool
    reasoning: str
    sub_queries: list[SubQuery] = field(default_factory=list)

def plan_query(query: str) -> QueryPlan:
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        messages=[{
            "role": "user",
            "content": QUERY_PLANNER_PROMPT.format(query=query)
        }]
    )

    raw = response.content[0].text.strip()
    parsed = json.loads(raw)

    return QueryPlan(
        original_query=query,
        query_type=parsed["query_type"],
        requires_agentic=parsed["requires_agentic"],
        reasoning=parsed["reasoning"],
        sub_queries=[
            SubQuery(
                id=sq["id"],
                query=sq["query"],
                depends_on=sq.get("depends_on", [])
            )
            for sq in parsed.get("sub_queries", [])
        ]
    )
```

The query planner's output drives the router decision. If `requires_agentic` is false, the query goes to the fast single-pass path. If true, it enters the agentic loop with the sub-query plan as its execution schedule.

### Rewriting Ambiguous Queries

For ambiguous queries, the first loop iteration should not retrieve — it should clarify. Use a broad, intent-surfacing retrieval pass to identify what the query space looks like, then use that signal to rewrite the query before doing targeted retrieval.

```python
QUERY_REWRITER_PROMPT = """You are a query rewriting agent.

The user asked: {original_query}

The initial retrieval returned these chunk summaries:
{chunk_summaries}

These chunks suggest the query may be about: {inferred_topics}

Rewrite the original query to be more specific and retrieval-effective, 
given what you now know about the available information. Preserve the user's 
intent exactly — do not change what they are asking for, only make it more precise.

Respond with only the rewritten query. No explanation."""

def rewrite_query(
    original_query: str,
    retrieved_chunks: list[dict]
) -> str:
    chunk_summaries = "\n".join([
        f"- {c['text'][:150]}..." for c in retrieved_chunks[:5]
    ])
    inferred_topics = ", ".join(set([
        c.get("metadata", {}).get("topic", "unknown")
        for c in retrieved_chunks[:5]
    ]))

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=200,
        messages=[{
            "role": "user",
            "content": QUERY_REWRITER_PROMPT.format(
                original_query=original_query,
                chunk_summaries=chunk_summaries,
                inferred_topics=inferred_topics
            )
        }]
    )

    return response.content[0].text.strip()
```

---

## 3. Iterative Retrieval — The Core Loop

The retrieval loop is the operational heart of the system. At each iteration, it executes a retrieval call, adds the results to the accumulated context, and passes control to the reflection agent. The reflection agent either terminates the loop (sufficient context) or returns a new query for the next iteration.

The shape of the loop is simple: retrieve, reflect, and either stop or rewrite the query and retrieve again. What makes it production-grade rather than a demo is the set of guards around that simple shape — context budget checks, stuck-loop detection, and timeout enforcement — covered fully in Section 7, where the complete implementation lives. Conceptually, each iteration looks like this:

```python
for i in range(max_iterations):
    chunks = await retrieval_fn(current_query)
    new_chunks = _deduplicate_chunks(chunks, accumulated_context)
    accumulated_context.extend(new_chunks)

    verdict = await reflection_fn(query, current_query, new_chunks, accumulated_context, i)
    iterations.append(RetrievalIteration(i, current_query, new_chunks, verdict["verdict"], verdict.get("next_query")))

    if verdict["verdict"] == "sufficient":
        break
    if verdict.get("next_query"):
        current_query = verdict["next_query"]
```

Two structures carry this loop's state end to end. `RetrievalIteration` records what happened on one pass — the query used, the chunks it returned, and the reflection verdict. `AgenticRetrievalResult` is the final output: the full iteration history, the accumulated context, and a `termination_reason` (`"sufficient"`, `"max_iterations"`, or `"timeout"`) that downstream consumers — generation, telemetry, and the context engineering layer — all key off of.

```python
@dataclass
class RetrievalIteration:
    iteration: int
    query_used: str
    chunks_retrieved: list[dict]
    reflection_verdict: str      # "sufficient" | "insufficient" | "off_topic" | "rewrite"
    next_query: Optional[str]

@dataclass
class AgenticRetrievalResult:
    original_query: str
    iterations: list[RetrievalIteration]
    accumulated_context: list[dict]
    total_iterations: int
    termination_reason: str

def _deduplicate_chunks(new_chunks: list[dict], existing: list[dict]) -> list[dict]:
    """Exact dedup by ID, then by text hash — catches the same document resurfacing across passes."""
    existing_ids = {c["id"] for c in existing}
    existing_hashes = {c.get("text_hash") for c in existing if "text_hash" in c}
    return [c for c in new_chunks if c["id"] not in existing_ids and c.get("text_hash") not in existing_hashes]
```

### Handling Sub-Query Dependencies

For multi-hop plans where later sub-queries depend on earlier results, the loop must inject resolved sub-query context into subsequent queries:

```python
async def execute_query_plan(plan: QueryPlan, retrieval_fn, reflection_fn) -> dict[str, AgenticRetrievalResult]:
    """Execute a multi-hop plan respecting sub-query dependencies. Returns results keyed by sub-query ID."""
    results: dict[str, AgenticRetrievalResult] = {}

    for sub_query in plan.sub_queries:   # depends_on ordering is already topological in the plan
        enriched_query = sub_query.query
        for dep_id in sub_query.depends_on:
            if dep_id in results:
                dep_context = _summarize_context(results[dep_id].accumulated_context)
                enriched_query = f"Given prior context: {dep_context}\n\nNow answer: {sub_query.query}"

        results[sub_query.id] = await run_bounded_agentic_loop(enriched_query, retrieval_fn, reflection_fn)

    return results

def _summarize_context(chunks: list[dict], max_chars: int = 800) -> str:
    combined = " ".join(c["text"] for c in chunks)
    return combined[:max_chars] + ("..." if len(combined) > max_chars else "")
```

---

## 4. The Reflection Agent — Deciding When to Stop

The reflection agent is the component that makes agentic RAG different from a naive retry loop. A naive retry loop runs N times regardless. The reflection agent evaluates the *quality and sufficiency* of accumulated context against the original query and makes a reasoned termination decision.

```python
REFLECTION_PROMPT = """You are a retrieval quality assessment agent.

Your job: evaluate whether the accumulated retrieved context is sufficient to 
accurately answer the original user query. Be critical — insufficiency that 
causes a bad answer is worse than one more retrieval pass.

Original query: {original_query}
Current retrieval query (may differ from original if refined): {current_query}
Iteration: {iteration} of maximum {max_iterations}

Newly retrieved chunks:
{new_chunks_text}

All accumulated context so far:
{accumulated_context_text}

Assess:
1. Does the accumulated context contain enough information to answer the original query accurately?
2. Are there specific gaps — missing facts, missing time periods, missing entities?
3. If insufficient, what specific query would retrieve the missing information?
4. Is the accumulated context off-topic or irrelevant to the original query?

Rules:
- If context is sufficient: verdict = "sufficient"
- If specific information is missing and another retrieval pass would help: verdict = "rewrite", provide next_query
- If context is off-topic (retrieval completely missed the intent): verdict = "off_topic", provide next_query
- If at max iterations: verdict = "sufficient" (generate with what we have, note limitations)

Respond ONLY with valid JSON:
{{
  "verdict": "sufficient" | "insufficient" | "off_topic" | "rewrite",
  "reasoning": "one sentence explanation",
  "confidence": 0.0-1.0,
  "identified_gaps": ["gap 1", "gap 2"],
  "next_query": "refined query string or null"
}}"""

async def reflect_on_retrieval(
    original_query: str, current_query: str, new_chunks: list[dict],
    accumulated_context: list[dict], iteration: int, max_iterations: int = 4
) -> dict:
    if iteration >= max_iterations - 1:   # force termination on the last allowed pass
        return {"verdict": "sufficient", "reasoning": "Max iterations reached.",
                 "confidence": 0.5, "identified_gaps": [], "next_query": None}

    new_text = "\n\n".join(f"[Chunk {i+1}] {c['text'][:400]}" for i, c in enumerate(new_chunks[:5]))
    acc_text = "\n\n".join(f"[Acc {i+1}] {c['text'][:300]}" for i, c in enumerate(accumulated_context[:8]))

    response = client.messages.create(
        model="claude-sonnet-4-20250514", max_tokens=500,
        messages=[{"role": "user", "content": REFLECTION_PROMPT.format(
            original_query=original_query, current_query=current_query,
            iteration=iteration + 1, max_iterations=max_iterations,
            new_chunks_text=new_text or "No new chunks retrieved.",
            accumulated_context_text=acc_text or "No context yet."
        )}]
    )
    return json.loads(response.content[0].text.strip())
```

### Reflection Quality Is Everything

The reflection agent's judgment quality determines the entire system's utility. A reflection agent that terminates too early produces the same quality as single-pass RAG. One that never terminates burns budget and hits timeout limits. Calibrate it against real query samples during development — log every verdict, every identified gap, every next_query rewrite, and review them.

The signal to watch: what fraction of loops terminate at each iteration count?

```text
Iteration 1:  65–75% of queries should terminate (simple queries that succeed on first pass)
Iteration 2:  15–20% (queries that needed one refinement)
Iteration 3:  5–10%  (multi-hop or genuinely ambiguous)
Iteration 4+: <5%    (max-iterations forced termination — these need investigation)
```

If you are seeing significant traffic hitting max iterations, either your query routing is sending simple queries into the agentic path (fix the router), or your corpus has coverage gaps that retrieval cannot solve (fix the corpus, not the loop).

---

## 5. Tool-Based Retrieval Orchestration

In Pattern 2, the retrieval agent selects from multiple tools rather than calling a single retrieval function. Structuring retrieval as LLM tool calls enables the agent to reason about which retrieval strategy is appropriate for each query and iteration.

Each tool is a standard Claude tool definition — name, description, and input schema. The description is what the agent uses to decide which tool fits a given query, so it needs to state clearly what the tool is best for, not just what it does mechanically:

```python
RETRIEVAL_TOOLS = [
    {
        "name": "semantic_search",
        "description": (
            "Search the document corpus using semantic/vector similarity. "
            "Best for: conceptual queries, paraphrased questions, topic exploration. "
            "Use when the query intent is clear but exact keywords may not match."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "top_k": {"type": "integer", "default": 5},
                "filter_metadata": {"type": "object", "description": "Optional: {document_type, date_range, source}"}
            },
            "required": ["query"]
        }
    },
    # keyword_search, hybrid_search, and filtered_search follow the same shape — see table below
]
```

The other three tools in the registry follow the identical name/description/input_schema shape; only the "best for" guidance and schema fields differ:

| Tool | Best for | Key schema fields beyond `query`, `top_k` |
| --- | --- | --- |
| `keyword_search` | Exact terms, product names, codes, IDs, acronyms — BM25 matching | none additional |
| `hybrid_search` | General queries; default when uncertain which search type is better | `semantic_weight` (0.6), `keyword_weight` (0.4) |
| `filtered_search` | Time-scoped ("Q3 results") or source-specific ("from the API docs") queries | `document_type`, `date_from`, `date_to`, `source_id` |

```python
async def run_tool_orchestrated_retrieval(
    query: str,
    tool_executors: dict,   # {"tool_name": async_callable}
    system_prompt: str,
    max_iterations: int = 4
) -> list[dict]:
    """Let the LLM pick which retrieval tool to call each turn. Returns accumulated chunks."""
    messages = [{"role": "user", "content": query}]
    accumulated_chunks = []

    for _ in range(max_iterations):
        response = client.messages.create(
            model="claude-sonnet-4-20250514", max_tokens=1000,
            system=system_prompt, tools=RETRIEVAL_TOOLS, messages=messages
        )

        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses:
            break   # LLM judged it has enough context — no further tool calls

        tool_results = []
        for tool_use in tool_uses:
            executor = tool_executors.get(tool_use.name)
            if not executor:
                continue
            chunks = await executor(**tool_use.input)
            new_chunks = _deduplicate_chunks(chunks, accumulated_chunks)
            accumulated_chunks.extend(new_chunks)

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tool_use.id,
                "content": json.dumps({
                    "chunks_retrieved": len(new_chunks),
                    "chunks": [
                        {"id": c["id"], "text": c["text"][:300], "score": c.get("score")}
                        for c in new_chunks[:5]
                    ]
                })
            })

        # Add assistant turn + tool results to conversation history
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})

    return accumulated_chunks
```

---

## 6. Routing — When to Go Agentic and When Not To

The most important production decision in an agentic RAG system is not the loop implementation — it is the router that decides whether to use the loop at all. Sending every query through the agentic path is the most common mistake teams make when first deploying this architecture.

Agentic retrieval adds 2–8 seconds of latency and 4–12x the LLM cost of a single-pass pipeline. On simple factual queries — which typically constitute 60–75% of traffic in most knowledge-base applications — it provides no quality improvement over a well-tuned single-pass pipeline. The router must reliably identify that majority and send it down the fast path.

```python
ROUTER_PROMPT = """Classify this user query to determine the optimal retrieval strategy.

Query: {query}

Classification rules:
- SIMPLE: Single factual question with clear intent. Answer likely in one document section.
  Examples: "What is the refund policy?", "When was version 2.3 released?", "Who is the account manager?"
  
- AGENTIC: Requires multiple retrieval steps, synthesis across sources, or intent is ambiguous.
  Examples: "How did Q3 performance compare to the same period last year after the pricing change?",
            "What are the security implications of the architecture described in the design doc?",
            "Summarize all feedback from enterprise customers in the last quarter"

Respond ONLY with valid JSON:
{{
  "route": "SIMPLE" | "AGENTIC",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence"
}}"""

async def route_query(query: str) -> dict:
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",   # Use Haiku for routing — fast and cheap
        max_tokens=150,
        messages=[{
            "role": "user",
            "content": ROUTER_PROMPT.format(query=query)
        }]
    )

    raw = response.content[0].text.strip()
    return json.loads(raw)
```

Use Haiku — not Sonnet — for the router. Routing is a classification task, not a reasoning task. Haiku adds ~100ms and costs a fraction of a Sonnet call. The router itself must not be the latency bottleneck that makes the fast path slow.

### Hybrid Router — Rules First, LLM Second

An LLM-only router adds unnecessary latency and cost to every request. Layer deterministic rules first and only fall through to LLM classification for genuinely ambiguous cases:

```python
import re

SIMPLE_PATTERNS = [
    r"^what is\b", r"^who is\b", r"^when (was|did|is)\b",
    r"^where (is|are|can)\b", r"^how (much|many|do i)\b", r"^(define|definition of)\b",
]

AGENTIC_SIGNALS = [
    "compare", "comparison", "vs", "versus", "summarize all", "across all", "over time",
    "trend", "changed", "impact of", "implications", "relationship between",
    "how does .* affect", "last quarter", "year over year", "historically"
]

def hybrid_route(query: str) -> str:
    """Returns 'SIMPLE', 'AGENTIC', or 'UNCERTAIN' (falls through to LLM classification)."""
    q = query.lower().strip()
    agentic_hits = sum(1 for signal in AGENTIC_SIGNALS if signal in q)

    for pattern in SIMPLE_PATTERNS:
        if re.search(pattern, q) and agentic_hits == 0:   # simple pattern, no agentic override
            return "SIMPLE"
    if agentic_hits >= 2:
        return "AGENTIC"
    if len(q.split()) <= 6 and agentic_hits == 0:   # short queries are usually simple
        return "SIMPLE"
    return "UNCERTAIN"

async def route(query: str) -> str:
    fast_route = hybrid_route(query)
    if fast_route != "UNCERTAIN":
        return fast_route
    verdict = await route_query(query)
    return verdict["route"]
```

---

## 7. Failure Isolation and Loop Bounding

Agentic loops introduce failure modes that single-pass pipelines do not have. Without explicit bounding, a misbehaving reflection agent or a corpus gap can send the loop into max-iteration runs on every request, driving latency and cost to unacceptable levels.

### Hard Limits — Non-Negotiable

```python
AGENTIC_LOOP_LIMITS = {
    "max_iterations": 4,          # Never exceed. 4 iterations = 4x retrieval cost.
    "timeout_seconds": 12.0,      # Wall-clock timeout for the entire loop.
    "max_accumulated_chunks": 20, # Stop accepting new chunks beyond this — context budget
    "max_context_tokens": 6000,   # Token budget for assembled context before generation
    "min_new_chunks_per_iteration": 1,  # If an iteration adds nothing new, break early
}
```

The `min_new_chunks_per_iteration` guard is important and often overlooked. If an iteration returns zero new chunks — every result was already in the accumulated context — the loop is stuck. The reflection agent may keep generating rewritten queries that retrieve the same documents. Break immediately.

This is the complete loop — the conceptual skeleton from Section 3 with every guard from `AGENTIC_LOOP_LIMITS` wired in. This is the version that actually ships:

```python
async def run_bounded_agentic_loop(
    query: str,
    retrieval_fn,
    reflection_fn,
    limits: dict = AGENTIC_LOOP_LIMITS
) -> AgenticRetrievalResult:
    accumulated_context, iterations = [], []
    current_query = query
    termination_reason = "max_iterations"

    try:
        async with asyncio.timeout(limits["timeout_seconds"]):
            for i in range(limits["max_iterations"]):

                total_tokens = sum(len(c["text"].split()) * 1.3 for c in accumulated_context)
                if total_tokens >= limits["max_context_tokens"]:
                    termination_reason = "context_budget_exhausted"
                    break

                chunks = await retrieval_fn(current_query)
                new_chunks = _deduplicate_chunks(chunks, accumulated_context)

                if len(new_chunks) < limits["min_new_chunks_per_iteration"]:
                    termination_reason = "no_new_content"
                    break

                accumulated_context.extend(new_chunks[:limits["max_accumulated_chunks"]])
                verdict = await reflection_fn(query, current_query, new_chunks, accumulated_context, i)
                iterations.append(RetrievalIteration(
                    i, current_query, new_chunks, verdict["verdict"], verdict.get("next_query")
                ))

                if verdict["verdict"] == "sufficient":
                    termination_reason = "sufficient"
                    break
                if verdict.get("next_query"):
                    current_query = verdict["next_query"]

    except asyncio.TimeoutError:
        termination_reason = "timeout"

    return AgenticRetrievalResult(query, iterations, accumulated_context, len(iterations), termination_reason)
```

### Graceful Degradation

When the agentic loop terminates for reasons other than `"sufficient"` — timeout, max iterations, no new content — do not fail the request. Generate with what was accumulated, and signal the uncertainty in the response:

```python
GENERATION_PROMPT_WITH_CONTEXT_CAVEAT = """Answer the user's question based on the provided context.

{context_caveat}

Context:
{context}

Question: {question}

Rules:
- Only use information present in the context above
- If the context is insufficient to fully answer, say so explicitly
- Do not infer or extrapolate beyond what the context states"""

def build_generation_prompt(question: str, context: list[dict], termination_reason: str) -> str:
    caveats = {
        "timeout": "NOTE: Retrieval was time-constrained. The answer may be based on partial context.",
        "max_iterations": "NOTE: Retrieval was time-constrained. The answer may be based on partial context.",
        "no_new_content": "NOTE: Retrieval converged early. The answer may not cover all aspects of your question.",
    }
    context_text = "\n\n---\n\n".join(c["text"] for c in context)
    return GENERATION_PROMPT_WITH_CONTEXT_CAVEAT.format(
        context_caveat=caveats.get(termination_reason, ""), context=context_text, question=question
    )
```

---

## 8. Cost and Latency Trade-offs

Before deploying agentic RAG, model the cost and latency impact explicitly. The numbers are not theoretical — they directly determine whether the architecture is viable for your traffic volume and SLA requirements.

### Per-Request Cost Model

```text
Single-pass RAG (baseline):
  - 1 embedding call:    ~$0.00002  (text-embedding-3-large, 200-token query)
  - 1 retrieval:         negligible (vector DB query)
  - 1 LLM generation:   ~$0.003    (Claude Sonnet, 1500-token context + 300-token output)
  Total per request:     ~$0.003

Agentic RAG (2 iterations average):
  - 1 router call:       ~$0.00005  (Claude Haiku)
  - 1 planner call:      ~$0.0005   (Claude Sonnet, simple)
  - 2 retrieval calls:   ~$0.00004
  - 2 reflection calls:  ~$0.001    (Claude Sonnet, each ~500 tokens)
  - 1 generation call:   ~$0.004    (larger context, accumulated chunks)
  Total per request:     ~$0.006    (~2x single-pass)

Agentic RAG (4 iterations, worst case):
  - 4 reflection calls:  ~$0.002
  - 1 generation call:   ~$0.005    (full context budget)
  Total per request:     ~$0.010    (~3-4x single-pass)
```

The cost multiplier is manageable if your routing correctly limits the agentic path to the minority of queries that warrant it. If 25% of traffic goes agentic at 2.5x average cost, your total cost increase is ~37% — acceptable. If 75% of traffic goes agentic, costs approximately triple — likely unacceptable without revenue justification.

### Latency Budget

```text
Single-pass RAG p50 latency:  800ms–1.2s
Agentic RAG latency breakdown (2 iterations):
  - Router:              ~150ms
  - Planner:             ~400ms  (first iteration; concurrent with router in practice)
  - Retrieval ×2:        ~200ms each
  - Reflection ×2:       ~600ms each
  - Generation:          ~1.2s
  Total p50:             ~3.5s

Agentic RAG (4 iterations, max):
  Total p50:             ~7–9s
```

At 3.5s p50, streaming the generation response becomes important for user experience. Do not wait for the full agentic loop to complete before starting the generation stream:

```python
async def stream_agentic_response(
    query: str,
    loop_result: AgenticRetrievalResult
):
    """Stream the generation response after the retrieval loop completes."""
    prompt = build_generation_prompt(
        question=query,
        context=loop_result.accumulated_context,
        termination_reason=loop_result.termination_reason
    )

    with client.messages.stream(
        model="claude-sonnet-4-20250514",
        max_tokens=800,
        messages=[{"role": "user", "content": prompt}]
    ) as stream:
        for text in stream.text_stream:
            yield text
```

---

## 9. Observability for Agentic Loops

Standard RAG observability — retrieval latency, context size, generation latency — is insufficient for agentic systems. You need visibility into the loop behavior itself: how many iterations are running, why loops terminate, which queries are hitting max iterations, and whether the reflection agent is making sound decisions.

### Structured Loop Telemetry

Every loop run must emit a structured trace:

```python
import structlog

logger = structlog.get_logger()

def emit_loop_telemetry(request_id: str, query: str, result: AgenticRetrievalResult, total_latency_ms: float) -> None:
    logger.info(
        "agentic_loop_completed",
        request_id=request_id,
        query_hash=hashlib.sha256(query.encode()).hexdigest()[:12],
        total_iterations=result.total_iterations,
        termination_reason=result.termination_reason,
        total_chunks_accumulated=len(result.accumulated_context),
        total_latency_ms=round(total_latency_ms, 1),
        iteration_verdicts=[it.reflection_verdict for it in result.iterations],
        had_query_rewrite=any(it.query_used != query for it in result.iterations)
    )
```

### Metrics to Alert On

| Metric | Alert Condition | Interpretation |
| --- | --- | --- |
| `max_iterations_rate` | > 5% of agentic requests | Router mis-classifying, corpus gaps, or reflection agent over-critical |
| `timeout_rate` | > 2% of agentic requests | Reflection calls taking too long; LLM API latency spike |
| `no_new_content_rate` | > 10% of agentic requests | Corpus coverage gap for that query class |
| `agentic_path_rate` | Drifts > 10% from baseline | Query distribution shift; router recalibration needed |
| `mean_iterations` | Rises week-over-week | Retrieval quality degrading; embedding model or index drift |
| `agentic_p95_latency` | > 10 seconds | Loop bounds not enforcing correctly; investigate timeout config |

### Per-Query Debug Trace

For any query that terminates at max iterations or timeout, log the full trace including all intermediate queries and reflection verdicts. These are your highest-value debugging artifacts. A debug trace is just the union of everything already defined in this post: the `request_id`, the original query, the route decision, the `QueryPlan` if one was generated, the full `iterations` list with chunk texts intact (not truncated, unlike the telemetry log), the `termination_reason`, and total latency. Wrap the full agentic pipeline call to capture and persist this alongside the response whenever `termination_reason` is not `"sufficient"`.

Store debug traces for max-iteration and timeout cases in a searchable store. Group by query topic or intent cluster. When a cluster consistently hits max iterations, that signals a corpus gap or chunking issue for that topic — it is not a loop problem, it is a data problem.

{% endraw %}

---

## The Agentic RAG Checklist

Before shipping an agentic retrieval system to production:

- [ ] **Router implemented** — hybrid rules-first + LLM fallback; Haiku model, not Sonnet
- [ ] **Router calibrated** — logged and reviewed against 200+ real query samples; agentic path rate < 30% of total traffic for typical knowledge-base workloads
- [ ] **Hard loop limits configured** — max_iterations ≤ 4, wall-clock timeout ≤ 12s, context token budget enforced
- [ ] **`min_new_chunks_per_iteration` guard active** — breaks loop if retrieval is stuck
- [ ] **Reflection agent calibrated** — iteration termination distribution: >65% at iteration 1, <5% at max iterations
- [ ] **Judge model pinned** — reflection uses a specific model version, not an alias
- [ ] **Graceful degradation implemented** — timeout and max-iteration cases generate with caveat, not 500 errors
- [ ] **Streaming response** — generation streams to client; loop latency is not fully blocking UX
- [ ] **Structured telemetry emitted** — every loop run logs iteration count, verdicts, termination reason, and latency
- [ ] **Alerts configured** — on max-iterations rate, timeout rate, and agentic path rate drift
- [ ] **Debug traces stored** — for max-iteration and timeout cases; searchable by intent cluster
- [ ] **Eval integrated** — RAGAS faithfulness and answer relevance running against agentic outputs in CI; regression gate active
- [ ] **Cost modeled** — per-request cost at expected agentic path rate documented and approved before launch

---

## Closing: Agency Without Accountability Is Just Unpredictability

The failure mode teams do not anticipate when adopting agentic RAG is not loop explosion or cost overruns — it is opacity. The loop runs, produces an answer, and nobody knows why it ran three iterations instead of one, why it rewrote the query the way it did, or why the reflection agent was not satisfied after the second pass. When quality drops, there is no telemetry to diagnose it. When costs spike, there is no trace to explain why.

An agentic system with no observability is not an improvement over a single-pass pipeline. It is a more expensive single-pass pipeline that is harder to debug. The retrieval loop does not deliver its quality improvement just by existing — it delivers it when it is instrumented, bounded, and its behavior is understood at the query level.

Build the router before the loop. Build the telemetry before the reflection agent. Know the expected cost per request before launch, and know which queries are hitting the agentic path and why. Agentic RAG earns its complexity when you can explain, for any query in production, exactly what the loop did and why it stopped when it did.

The teams that get this right are not the ones with the most sophisticated loop implementations. They are the ones that treated the agentic system as accountable infrastructure — with the same observability discipline they apply to every other production service.

> **📌 Key Takeaway**
>
> Agentic RAG is not a replacement for a well-engineered single-pass pipeline — it is an extension for the query classes that single-pass cannot handle: multi-hop reasoning, ambiguous intent, and queries requiring sequential synthesis across sources. The architecture is: route first (keep simple queries on the fast path), plan before retrieving, reflect before generating, and bound the loop unconditionally. The reflection agent is the critical component — calibrate it, instrument it, and review its decisions regularly. Without observability into what the loop is doing on every request, agency is indistinguishable from unpredictability.

---

*Further Reading: Asai et al. — Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection (2023), Shinn et al. — Reflexion: Language Agents with Verbal Reinforcement Learning (2023), Anthropic — Tool Use Documentation, LangGraph — Agentic Workflow Patterns, LlamaIndex — Agentic RAG Documentation*
