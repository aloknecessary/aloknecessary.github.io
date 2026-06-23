---
title: "Context Engineering: The Discipline That Determines What Your LLM Actually Sees"
published: false
description: Context window budgeting, four-type memory architecture, structured injection patterns, conversation compression, lost-in-the-middle mitigation, and treating context assembly as a testable system
tags: ai, architecture, machinelearning, python
canonical_url: https://aloknecessary.github.io/blogs/discipline-that-determines-what-your-llm-actually-sees/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=context-engineering
cover_image: 
---

Prompt engineering asks: how do I phrase this instruction? Context engineering asks: what information does the model need, in what form, in what order, and how much of it — to produce a correct answer?

For a long time, the implicit mental model was: give the LLM more context and it performs better. This is wrong. A 20,000-token window stuffed with weakly relevant content produces worse answers than a 4,000-token window with precisely curated information. Larger windows do not eliminate context quality problems — they amplify them.

---

## The Context Window Is a Budget

Treat it as a budget with competing line items, not a container you fill. Start with the total window, subtract fixed allocations (system prompt, output reserve, safety margin), and what remains is your dynamic budget split across retrieved chunks, conversation history, and memory.

The first question should always be: "can we get better at selecting less, rather than including more?"

---

## Four Memory Types, Four Purposes

- **Episodic** — conversation history. Highest priority for continuity. Grows unbounded — needs compression.
- **Semantic** — durable facts about the user (role, team, preferences). Compact, injected in system prompt before retrieved content.
- **Procedural** — reusable workflows and SOPs. Retrieved selectively when the query type matches.
- **Working** — intermediate results within a single request (agentic loop output). Ephemeral, request-scoped.

Each type has different durability, update frequency, and token cost. Conflating them into a single undifferentiated store is the most common memory architecture mistake.

---

## Structured Injection Patterns

- **XML tags** for section boundaries (`<documents>`, `<user_context>`, `<instructions>`) — gives the model clear anchors for where information types begin and end
- **Indexed documents** — label chunks with indices so citations can be traced
- **Ordering matters** — most relevant content first (primacy effect), user query last (recency effect)
- **Grounding instruction is not optional** — explicit instruction to use only provided context and signal when insufficient

---

## Lost-in-the-Middle

Models attend more strongly to content near the beginning and end of the context window. Information buried in the middle receives less attention. Mitigations:

1. Relevance-ordered injection (highest score first)
2. Sandwich pattern (critical content at both start and end)
3. Active relevance filtering (exclude low-scoring chunks even if they fit)
4. Smaller, tighter windows (fewer high-quality chunks > more mediocre chunks)

---

## Conversation Compression

A 100-turn conversation consumes your entire retrieved context budget. Naive truncation loses critical early constraints. Solutions:

- **Sliding window with pinned turns** — critical turns (user constraints, decisions) never truncated
- **Progressive summarization** — compress old segments into 3-5 sentence summaries using Haiku (cheap, mechanical task)

---

## Context Assembly Is Testable

Unit test your assembly layer: budget compliance, ordering preserved, critical turns survive truncation, no mid-chunk truncation. Every assembly failure produces a predictable RAGAS metric signature — context precision drops point to noisy inclusion, faithfulness drops point to contradictions.

---

## Read the Full Article

This is a summary of my deep dive into context engineering. The full article covers the complete discipline with production implementations:

**👉 [Context Engineering: The Discipline That Determines What Your LLM Actually Sees — Full Article](https://aloknecessary.github.io/blogs/discipline-that-determines-what-your-llm-actually-sees/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=context-engineering)**

The full article includes:
- Context window budget accounting with Python dataclasses
- Four memory types with implementation patterns (episodic, semantic, procedural, working)
- Working memory bridge from agentic retrieval loops
- XML-structured injection with document indexing
- Primacy/recency ordering strategy
- Progressive summarization with critical turn pinning
- Lost-in-the-middle mitigation (4 strategies with code)
- Contradiction detection and resolution
- Noise taxonomy (stale, tangential, redundant, over-retrieved)
- Unit testing context assembly
- AssemblyMetadata integration with RAGAS eval pipeline
- RAGAS metric → assembly failure mapping table
- Production checklist (19 items)
