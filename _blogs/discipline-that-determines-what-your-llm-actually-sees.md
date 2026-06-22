---
title: "Context Engineering: The Discipline That Determines What Your LLM Actually Sees"
date: 2026-06-23
last_modified_at: 2026-06-23
author: Alok Ranjan Daftuar
description: "The emerging engineering discipline between retrieval and generation — context window budgeting, memory architecture, structured injection patterns, conversation compression, and the systematic failures that happen when context assembly is treated as an afterthought."
excerpt: "Prompt engineering asks how to phrase an instruction. Context engineering asks what information the model needs, in what form, in what order, and how much of it. This post covers token budgeting, four-type memory architecture, structured injection patterns, conversation compression, lost-in-the-middle mitigation, contradiction detection, and testing context assembly as a first-class system."
keywords: "context engineering, context window, LLM context, memory architecture, token budget, conversation compression, lost in the middle, RAG context assembly, structured prompting, context quality"
twitter_card: summary_large_image
categories:
  - ai
  - architecture
tags: [ai, llm, context-engineering, rag, prompt-engineering, memory, architecture, production, observability, patterns]
series: "RAG Production"
series_order: 5
---

{% raw %}

> Prompt engineering asks: how do I phrase this instruction? Context engineering asks: what information does the model need, in what form, in what order, and how much of it — to produce a correct answer?

## The Problem With "Stuff It in the Prompt"

For a long time, the implicit mental model for working with LLMs was: give it more context and it performs better. More chunks, longer conversation history, richer system prompt, more examples. When the model gave a wrong answer, the instinct was to add more information.

This mental model is wrong, and in production it is expensive to learn that it is wrong.

Context windows are not neutral containers where more is always better. They are constrained, structured spaces where what you include, what you exclude, where you place things, and how you format them all materially affect output quality. An LLM given a 20,000-token context window stuffed with weakly relevant content will often produce worse answers than one given a 4,000-token window with precisely curated, well-ordered information. The model is not reading your context the way a human reads a brief. It is attending across it in ways that are sensitive to position, structure, repetition, and noise.

Context engineering is the discipline of designing what goes into that window intentionally — treating context assembly as a first-class engineering problem with architecture, testing, and optimization, rather than an implementation detail solved with f-strings and `"\n\n".join(chunks)`.

This distinction matters more in 2026 than it did two years ago, for a specific reason: context windows have grown dramatically (128K, 200K, 1M tokens are commonplace), and that growth creates an illusion that the problem is solved. It is not. Larger windows do not eliminate context quality problems — they amplify them, because the surface area for noise, contradiction, and positional degradation grows with the window size. The teams winning with LLMs are the ones that fill smaller, well-engineered windows rather than the ones that throw everything into the largest available window and hope for the best.

> **Article context:** This post is part of the RAG production series and sits at the intersection of the two prior articles in the series. The [LLM Evaluation in Production](/blogs/llm-evaluation-in-production/) post established the four RAGAS metrics — faithfulness, answer relevance, context precision, and answer correctness — and the CI/CD pipeline that tracks them. Context precision in particular is the direct diagnostic signal for context assembly quality: when it drops, the assembly layer is the first place to look. The [Agentic RAG](/blogs/designing-self-correcting-retrieval-loops-for-production/) post covered how iterative retrieval loops accumulate context across multiple passes — producing an `AgenticRetrievalResult` with `accumulated_context` and a `termination_reason`. That accumulated context does not go directly to the LLM. It goes through the assembly layer this post describes: budgeted, deduplicated, ordered, and structured before the model ever sees it. This post covers that layer — how you take everything the retrieval system collected and turn it into a context window the LLM can actually use effectively.

### Table of Contents

- [The Problem With "Stuff It in the Prompt"](#the-problem-with-stuff-it-in-the-prompt)
- [1. What Context Engineering Actually Is](#1-what-context-engineering-actually-is)
- [2. The Context Window as a Budget](#2-the-context-window-as-a-budget)
- [3. Memory Architecture — Four Types, Four Purposes](#3-memory-architecture--four-types-four-purposes)
- [4. Structured Context Injection Patterns](#4-structured-context-injection-patterns)
- [5. Conversation Compression — Keeping History Without Paying For All of It](#5-conversation-compression--keeping-history-without-paying-for-all-of-it)
- [6. The Lost-in-the-Middle Problem — Position Matters](#6-the-lost-in-the-middle-problem--position-matters)
- [7. Contradiction and Noise — When Context Hurts](#7-contradiction-and-noise--when-context-hurts)
- [8. Context Assembly as a Testable System](#8-context-assembly-as-a-testable-system)
- [The Context Engineering Checklist](#the-context-engineering-checklist)
- [Closing: The Window Is the Product](#closing-the-window-is-the-product)

---

## 1. What Context Engineering Actually Is

Before the engineering, the definition. Context engineering is the systematic design of everything that enters an LLM's context window for a given request. That includes:

```text
┌─────────────────────────────────────────────────────────┐
│                    CONTEXT WINDOW                       │
│                                                         │
│  ┌─────────────────┐   Budget: fixed token limit        │
│  │  SYSTEM PROMPT  │   Role, persona, instructions,     │
│  │                 │   output format, constraints       │
│  └────────┬────────┘                                    │
│           │                                             │
│  ┌────────▼────────┐                                    │
│  │  MEMORY LAYER   │   Episodic: prior conversation     │
│  │                 │   Semantic: user/entity facts      │
│  │                 │   Procedural: how-to patterns      │
│  └────────┬────────┘                                    │
│           │                                             │
│  ┌────────▼────────┐                                    │
│  │ RETRIEVED FACTS │   Chunks from RAG pipeline         │
│  │                 │   Tool call results                │
│  │                 │   External API responses           │
│  └────────┬────────┘                                    │
│           │                                             │
│  ┌────────▼────────┐                                    │
│  │    FEW-SHOT     │   Examples of desired behavior     │
│  │    EXAMPLES     │   Input/output pairs               │
│  └────────┬────────┘                                    │
│           │                                             │
│  ┌────────▼────────┐                                    │
│  │  USER MESSAGE   │   The actual query or instruction  │
│  └─────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
```

Each layer competes for the same finite token budget. Context engineering is the discipline of deciding what each layer contains, how large each layer is, in what order layers appear, and how they are formatted — such that the model attends to the right information at the right weight.

This is distinct from prompt engineering in a meaningful way. Prompt engineering is primarily about phrasing — how you word an instruction to elicit a desired behavior. Context engineering is about information architecture — what information the model has access to and how it is organized. You can have excellent prompt engineering and catastrophic context engineering. The reverse is also true.

The two disciplines are complementary. You need both. But the industry spent three years obsessing over prompts and largely ignored context architecture, which is why "my model knows the right answer but gives the wrong one" is such a common complaint. The model cannot give the right answer if the right information was not in the window — or if it was buried under noise that diluted the signal.

---

## 2. The Context Window as a Budget

The first shift context engineering requires is treating the context window as a budget, not a container. A budget has a hard limit, line items that compete against each other, and an allocation strategy that reflects priorities. A container is just a place you put things.

### Token Budget Accounting

Start with the total context window and subtract the non-negotiable fixed costs — system prompt, output reserve, few-shot examples, and a safety margin against estimation error. What remains is your dynamic budget: the pool you actively allocate across retrieved chunks, conversation history, and memory at request time.

```python
from dataclasses import dataclass

@dataclass
class ContextBudget:
    total_tokens: int            # model's context window limit
    system_prompt_tokens: int    # measured once; update if prompt changes
    output_reserve_tokens: int   # reserved for the model's response
    safety_margin_tokens: int    # buffer against estimation error (~5%)

    @property
    def available_for_dynamic_content(self) -> int:
        fixed = self.system_prompt_tokens + self.output_reserve_tokens + self.safety_margin_tokens
        return self.total_tokens - fixed

# Claude Sonnet, 200K window → ~197K available for dynamic content.
# Don't spend it all — see Section 6 on positional degradation.
BUDGET = ContextBudget(total_tokens=200_000, system_prompt_tokens=800,
                        output_reserve_tokens=1_500, safety_margin_tokens=500)
```

How that dynamic pool gets split across retrieved context, conversation history, and semantic memory depends on the query pattern, not a fixed formula. A stateless knowledge-base Q&A system can afford to spend most of the pool on retrieved chunks — 6,000 tokens of chunks against 1,000 tokens of recent history. A long-running multi-turn assistant needs the opposite balance: 4,000 tokens of chunks against 8,000 tokens of compressed history (Section 5), because continuity matters more than depth per turn. Define this allocation explicitly per system — do not let it emerge by accident from whatever the retrieval layer happens to return.

### Token Estimation and Budget-Aware Selection

Estimate tokens *before* assembly, not after. Assembling the full context and truncating afterward is wasteful and produces unpredictable quality — you want to know which chunks fit before you commit to including them.

```python
import tiktoken

_encoder = tiktoken.get_encoding("cl100k_base")  # covers Claude and GPT-4 family

def estimate_tokens(text: str) -> int:
    return len(_encoder.encode(text))

def select_chunks_within_budget(chunks: list[dict], token_budget: int) -> list[dict]:
    """
    Greedily select chunks in descending relevance order until the budget is exhausted.
    Never truncates a chunk mid-sentence — a chunk that doesn't fit whole is excluded entirely.
    """
    ordered = sorted(chunks, key=lambda c: c.get("score", 0), reverse=True)
    selected, used = [], 0
    for chunk in ordered:
        chunk_tokens = estimate_tokens(chunk["text"])
        if used + chunk_tokens <= token_budget:
            selected.append(chunk)
            used += chunk_tokens
    return selected
```

The "never truncate mid-chunk" rule matters more than it looks. A chunk cut off halfway through a sentence is worse than no chunk at all — it gives the model a fragment that looks complete but is missing its conclusion, which is a more dangerous failure mode than an honest gap.

---

## 3. Memory Architecture — Four Types, Four Purposes

Memory is the most underspecified component in most LLM systems. Teams either have no memory (every request is stateless) or use a single undifferentiated store that conflates what the user said five minutes ago with what their job title is. These are fundamentally different types of information with different update frequencies, different retrieval patterns, and different impacts on output quality.

A production context engineering system distinguishes four memory types:

### Episodic Memory — What Happened in This Conversation

Episodic memory is the conversation history: what the user said, what the model said, in what order. It is the highest-priority memory type for multi-turn systems because it provides continuity — without it, the model treats every message as a fresh interaction with no prior context.

Episodic memory is also the most expensive memory type by token cost, because it grows without bound as a conversation continues. Managing it is covered in Section 5.

It is the highest-priority memory type for multi-turn systems because it provides continuity — without it, the model treats every message as a fresh interaction with no prior context. It is also the most expensive memory type by token cost, because it grows without bound as a conversation continues. The standard handling: keep the most recent turns that fit the allocated token budget, always preserving the current user message, and truncate from the oldest end first. Section 5 covers a better approach than raw truncation once conversations get long.

### Semantic Memory — Facts About the User and Their World

Semantic memory stores durable facts: who the user is, what their role is, what projects they are working on, what preferences they have expressed. Unlike episodic memory, it does not grow with conversation length — it is updated when facts change, not when turns happen. It belongs in the system prompt or immediately after it, before retrieved content, because it frames how the model should interpret everything that follows. The model needs to know it is talking to a senior engineer on the platform team before it sees the retrieved technical documentation. A compact key-value block is sufficient — `<user_context>\n- role: Senior Engineer\n- team: Platform\n</user_context>` — there is no need for elaborate formatting; semantic memory is cheap precisely because it stays small.

### Procedural Memory — How To Do Things

Procedural memory stores reusable patterns: common workflows, formatting templates, standard operating procedures for your domain. It is relatively static — it changes when your processes change, not when users interact.

Procedural memory is best stored externally and retrieved selectively, not included in every context window. Treat it like specialized documentation: inject it when the current query type matches a known workflow, leave it out otherwise.

```python
PROCEDURAL_MEMORY_STORE = {
    "incident_response": """
When helping with an incident:
1. Ask for the error message and stack trace first
2. Identify the service and deployment version affected
3. Check if a recent deployment or config change correlates
4. Suggest rollback before suggesting a fix if blast radius is unknown
""",
    "code_review": """
When reviewing code:
- Flag security issues first (auth, input validation, secrets exposure)
- Then correctness issues
- Then performance issues
- Style comments last
- Reference specific line numbers
""",
}

def get_procedural_context(query: str, store: dict) -> str:
    """
    Simple keyword-based procedural memory retrieval.
    For larger stores, use vector retrieval over procedure descriptions.
    """
    q = query.lower()
    if any(kw in q for kw in ["incident", "outage", "down", "error", "alert"]):
        return store.get("incident_response", "")
    if any(kw in q for kw in ["review", "pr", "pull request", "diff", "code"]):
        return store.get("code_review", "")
    return ""
```

### Working Memory — Intermediate Results Within a Request

Working memory holds intermediate state within a single complex request: the output of a prior reasoning step, the result of a tool call that informs the next tool call, or the chunks accumulated across iterations of an agentic retrieval loop.

The [Agentic RAG](/blogs/designing-self-correcting-retrieval-loops-for-production/) post introduced the `AgenticRetrievalResult` dataclass — the object the agentic loop produces before generation. Its `accumulated_context` field is working memory: chunks collected across up to four retrieval iterations, deduplicated, and bounded by `AGENTIC_LOOP_LIMITS.max_accumulated_chunks`. What that post left implicit is that `accumulated_context` is *not* what goes directly into the LLM's context window. It is the raw working memory that feeds *this* layer — the assembly layer — which then applies budget constraints, ordering, and structural formatting before the model ever sees it.

This distinction matters because the agentic loop's deduplication guard (`_deduplicate_chunks`) and the assembly layer's deduplication logic (`deduplicate_by_content`) serve different purposes. The loop deduplicates by chunk ID and text hash to prevent the same document surfacing on multiple retrieval passes. The assembly layer deduplicates by semantic similarity to prevent near-duplicate paraphrases of the same fact from different source documents both entering the context window. You need both, and they are not interchangeable.

```python
@dataclass
class WorkingMemory:
    """Bridges AgenticRetrievalResult (loop output) to context assembly (this layer's input)."""
    chunks: list[dict] = field(default_factory=list)
    termination_reason: str = "not_started"   # mirrors AgenticRetrievalResult.termination_reason

    @classmethod
    def from_agentic_result(cls, result) -> "WorkingMemory":
        return cls(chunks=result.accumulated_context, termination_reason=result.termination_reason)

    def to_assembly_input(self, token_budget: int) -> list[dict]:
        deduped = deduplicate_by_content(self.chunks)   # semantic dedup, not just ID dedup
        return select_chunks_within_budget(deduped, token_budget)
```

Working memory is ephemeral — it exists only within a single request lifecycle and must be re-populated from scratch on every request. But it needs an explicit budget allocation, because in agentic paths it can accumulate 10–20 chunks across iterations and easily consume 6,000–8,000 tokens — crowding out the conversation history budget that episodic memory needs.

The key budget decision for agentic systems: when `termination_reason` is `"sufficient"`, working memory is likely dense and high-quality, so allocate it the full retrieved-context budget. When it is `"max_iterations"` or `"timeout"`, the chunks are likely noisier — cut the effective budget to roughly 60% and apply stricter relevance filtering (Section 6) before assembly, while including the caveat text in the generation prompt as described in the agentic post. `"no_new_content"` terminations get the full budget too — the loop stalled, but what it gathered was not necessarily noisy.

The four memory types, their properties, and where they originate in the series:

| Memory Type | Durability | Update Frequency | Token Cost | Priority | Series Origin |
|---|---|---|---|---|---|
| Episodic | Session | Every turn | High (growing) | Highest for continuity | This post, Section 5 |
| Semantic | Persistent | Fact changes | Low (compact) | High for personalization | This post, Section 3 |
| Procedural | Persistent | Process changes | Medium (selective) | Medium (task-specific) | This post, Section 3 |
| Working | Request-scoped | Every agentic step | Variable (0–8K) | Highest within agentic loops | [Agentic RAG](/blogs/designing-self-correcting-retrieval-loops-for-production/) → this post |

---

## 4. Structured Context Injection Patterns

How you format the information you inject into the context window matters. The model does not parse context the way a database parses a schema — but it does respond to structure in consistent, predictable ways that you can engineer for.

### XML Tags for Section Boundaries

Use XML-style tags to delineate distinct context sections. This is not because models parse XML — they do not — but because it gives the model clear visual anchors for where one type of information ends and another begins, which reduces cross-contamination between sections.

```python
def build_context_block(
    user_context: str,
    retrieved_chunks: list[dict],
    procedural_context: str = ""
) -> str:
    chunks_text = "\n\n".join([
        f'<document index="{i+1}" source="{c.get("source", "unknown")}">\n{c["text"]}\n</document>'
        for i, c in enumerate(retrieved_chunks)
    ])

    sections = []

    if user_context:
        sections.append(f"<user_context>\n{user_context}\n</user_context>")

    if procedural_context:
        sections.append(f"<instructions>\n{procedural_context}\n</instructions>")

    if chunks_text:
        sections.append(f"<documents>\n{chunks_text}\n</documents>")

    return "\n\n".join(sections)
```

Index your documents in the context block. When the model generates a response that cites document 3, you can trace exactly which chunk produced that claim — essential for faithfulness verification and debugging.

### Ordering: Primacy and Recency

Models attend more strongly to content near the beginning and end of the context window. This is not a speculation — it is a documented behavioral pattern confirmed in multiple evaluation studies. The implications for context ordering are concrete:

- **System prompt:** always first. Never bury behavioral instructions in the middle.
- **User context (semantic memory):** immediately after system prompt. Establishes the frame for everything that follows.
- **Most relevant retrieved documents:** first in the documents section — not last.
- **User's current message:** last. The recency effect means the model exits the context window with the user's query freshest in its attention.
- **Conversation history:** just before the current message, in chronological order.

The implementation is mechanical once the ordering is decided: the system field carries the prompt plus semantic memory plus any procedural context, in that order; the messages array carries conversation history chronologically, followed by a final user message that wraps the assembled `<documents>` block around the current question. The `build_context_block` function above already produces that wrapped block — assembly is just concatenation in the right sequence, not new logic.

### Explicit Grounding Instructions

The system prompt must explicitly instruct the model to use the provided context and signal when context is insufficient. Without this, models will blend context information with parametric knowledge — the information baked into their weights — in ways that are hard to predict and even harder to audit.

```python
GROUNDING_SYSTEM_PROMPT = """You are a knowledgeable assistant for {product_name}.

Answer questions using ONLY the information provided in the <documents> section below.
Do not use prior knowledge or make inferences beyond what the documents explicitly state.

If the documents do not contain sufficient information to answer the question:
- Say so clearly and specifically: identify what information is missing
- Do not guess or extrapolate
- Suggest where the user might find the missing information

When referencing information, cite the document index: "According to document [2]..."

{user_context_placeholder}"""
```

The grounding instruction is not optional. Every production RAG system that skips it will eventually produce a confident answer that mixes retrieved facts with parametric confabulation — and the user will have no way to distinguish the two.

---

## 5. Conversation Compression — Keeping History Without Paying For All of It

Conversation history is the fastest-growing element in any multi-turn system. A 20-turn conversation at 200 tokens per turn consumes 4,000 tokens before you have added a single retrieved document. A 100-turn conversation consumes the entire allocation you budgeted for retrieved context.

Naive truncation — keeping only the last N turns — is simple but loses important context from earlier in the conversation. A user who specified their constraints in turn 3 expects those constraints to still apply at turn 47.

### Sliding Window With Pinned Turns

The simplest upgrade over raw truncation: pin turns that contain critical information and apply the sliding window only to unpinned turns.

```python
from enum import Enum

class TurnImportance(Enum):
    CRITICAL = "critical"   # must always be in context; never truncated
    NORMAL = "normal"       # included if space permits; truncated from oldest first

@dataclass
class ConversationTurn:
    role: str
    content: str
    importance: TurnImportance = TurnImportance.NORMAL
    summary: str | None = None   # populated if this turn was compressed

def build_conversation_context(
    turns: list[ConversationTurn],
    token_budget: int
) -> list[dict]:
    """
    Build conversation history for context injection.
    Always includes critical turns; fills remaining budget with recent normal turns.
    """
    critical = [t for t in turns if t.importance == TurnImportance.CRITICAL]
    normal = [t for t in turns if t.importance == TurnImportance.NORMAL]

    critical_tokens = sum(estimate_tokens(t.content) for t in critical)
    remaining_budget = token_budget - critical_tokens

    # Fill from most recent normal turns backward
    selected_normal = []
    used = 0
    for turn in reversed(normal):
        t = estimate_tokens(turn.content)
        if used + t > remaining_budget:
            break
        selected_normal.insert(0, turn)
        used += t

    # Reconstruct chronological order: critical in their original positions
    all_turns = sorted(
        critical + selected_normal,
        key=lambda t: turns.index(t)
    )

    return [{"role": t.role, "content": t.content} for t in all_turns]
```

### Progressive Summarization

For long sessions, summarize older conversation segments rather than discarding them. The summary costs far fewer tokens than the original turns while preserving the semantic content.

```python
SUMMARIZATION_PROMPT = """Summarize the following conversation segment.
Preserve:
- All specific facts, numbers, constraints, or requirements the user stated
- Decisions that were made
- Problems that were identified but not yet resolved
- Context that would affect how to interpret future messages

Discard:
- Pleasantries and acknowledgments
- Repeated or redundant information
- Intermediate reasoning steps that led to a resolved conclusion

Segment to summarize:
{conversation_segment}

Produce a compact summary in 3-5 sentences maximum."""

async def compress_old_turns(
    turns: list[ConversationTurn],
    turns_to_keep_verbatim: int = 6
) -> list[ConversationTurn]:
    """
    Compress turns older than `turns_to_keep_verbatim` into a single summary turn.
    Recent turns are always kept verbatim for accuracy.
    """
    if len(turns) <= turns_to_keep_verbatim:
        return turns

    old_turns = turns[:-turns_to_keep_verbatim]
    recent_turns = turns[-turns_to_keep_verbatim:]

    # Only summarize if there are old turns to compress
    if not old_turns:
        return recent_turns

    segment_text = "\n".join([
        f"{t.role.upper()}: {t.content}" for t in old_turns
    ])

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",   # Haiku — this is compression, not reasoning
        max_tokens=300,
        messages=[{
            "role": "user",
            "content": SUMMARIZATION_PROMPT.format(conversation_segment=segment_text)
        }]
    )

    summary_text = response.content[0].text.strip()
    summary_turn = ConversationTurn(
        role="user",
        content=f"[Summary of earlier conversation: {summary_text}]",
        importance=TurnImportance.CRITICAL   # summaries are always pinned
    )

    return [summary_turn] + recent_turns
```

Use Haiku for compression. Summarization is a mechanical extraction task — it does not require the full reasoning capability of Sonnet, and it runs on every turn in long sessions, so cost compounds quickly.

---

## 6. The Lost-in-the-Middle Problem — Position Matters

In 2023, Liu et al. published research demonstrating that LLMs perform significantly worse on information presented in the middle of a long context window compared to information at the beginning or end. This is the "lost-in-the-middle" effect.

The practical implication: if your most relevant retrieved chunk is the fourth of six chunks in a flat context block, it may receive less attention than the first or last chunk — even if it is the most relevant by retrieval score. At small context sizes (4K–8K tokens), this effect is modest. At large context sizes (32K+), it becomes a measurable quality degradation.

Your mitigation strategies, ordered by implementation effort:

**1. Relevance-ordered injection (low effort).** Always inject retrieved chunks in descending relevance score order. The most relevant content goes first. This is already in the `select_chunks_within_budget` function — sort by score before injecting.

**2. Sandwich pattern (low effort).** Put the most critical content both at the top and bottom of the context block. Redundancy costs tokens but benefits from both primacy and recency effects.

**2. Sandwich pattern (low effort).** Put the most critical chunk both at the top and bottom of the context block — repeat the document, with a label like "PRIMARY" on the first occurrence. The token cost of repeating one chunk (~400 tokens) is justified for high-stakes queries because it benefits from both the primacy and recency effects simultaneously.

**3. Active context pruning (medium effort).** Before final injection, use a lightweight model to score each chunk's relevance to the specific query and exclude low-scoring chunks rather than including everything the retrieval system returned:

```python
RELEVANCE_FILTER_PROMPT = """Rate how relevant this document is to answering the question.
Score 1 (irrelevant) to 5 (directly answers the question). Respond with only the integer.

Question: {question}
Document: {document_text}"""

async def filter_chunks_by_relevance(query: str, chunks: list[dict], min_score: int = 3) -> list[dict]:
    async def score_chunk(chunk: dict) -> tuple[dict, int]:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",   # cheap classification, not reasoning
            max_tokens=5,
            messages=[{"role": "user", "content": RELEVANCE_FILTER_PROMPT.format(
                question=query, document_text=chunk["text"][:500])}]
        )
        try:
            score = int(response.content[0].text.strip())
        except ValueError:
            score = 3   # default to include on parse failure
        return chunk, score

    scored = await asyncio.gather(*[score_chunk(c) for c in chunks])
    return [c for c, score in scored if score >= min_score]
```

**4. Smaller, tighter context windows (high impact, counter-intuitive).** The most reliable mitigation for lost-in-the-middle is to use less context. Fewer, higher-quality chunks in a 4K context window consistently outperform more chunks in a 20K window on tasks that fit within the smaller window. Be skeptical of instincts to expand the context budget — the first question should always be "can we get better at selecting less, rather than including more?"

---

## 7. Contradiction and Noise — When Context Hurts

The most pernicious context quality failure is not missing information — it is contradictory information. A context window containing two chunks that make conflicting claims about the same fact will produce responses that are inconsistent, confused, or that confidently synthesize the contradiction into a plausible-sounding but wrong answer.

```python
CONTRADICTION_DETECTION_PROMPT = """Identify factual contradictions between these document chunks.
Ignore phrasing differences — only flag genuine conflicting claims about the same subject.

Chunks:
{chunks_text}

Respond with JSON: {{"has_contradictions": bool, "contradictions": [
  {{"chunk_indices": [1, 3], "claim_a": "...", "claim_b": "..."}}
]}}"""

async def detect_and_resolve_contradictions(chunks: list[dict]) -> list[dict]:
    """Detect contradictions and resolve by preferring the more recently indexed chunk."""
    if len(chunks) < 2:
        return chunks

    chunks_text = "\n\n".join(
        f"[Chunk {i+1}] (indexed: {c.get('indexed_at', 'unknown')})\n{c['text'][:300]}"
        for i, c in enumerate(chunks)
    )
    response = client.messages.create(
        model="claude-haiku-4-5-20251001", max_tokens=400,
        messages=[{"role": "user", "content": CONTRADICTION_DETECTION_PROMPT.format(chunks_text=chunks_text)}]
    )
    result = json.loads(response.content[0].text.strip())
    if not result.get("has_contradictions"):
        return chunks

    to_remove = set()
    for conflict in result.get("contradictions", []):
        idx_a, idx_b = conflict["chunk_indices"][0] - 1, conflict["chunk_indices"][1] - 1
        older = idx_a if chunks[idx_a].get("indexed_at", "") < chunks[idx_b].get("indexed_at", "") else idx_b
        to_remove.add(older)

    return [c for i, c in enumerate(chunks) if i not in to_remove]
```

### Noise Taxonomy

Not all context quality failures are contradictions. The full taxonomy of context noise:

**Stale content** — chunks from outdated document versions that contradict current information. Mitigation: index with `last_modified` timestamp; apply recency filters in metadata filtering at retrieval time.

**Tangentially relevant content** — chunks that match the query topic but do not contain information relevant to the specific question asked. Mitigation: active relevance filtering (Section 6, Pattern 3).

**Redundant content** — multiple chunks covering the same information. Wastes token budget without adding signal. Mitigation: deduplication by text hash and by semantic similarity in the assembly layer.

**Over-retrieved context** — correct information diluted across too many chunks, reducing the signal density in the window. Mitigation: stricter top-K limits; prefer 4 high-quality chunks over 12 mediocre ones.

```python
from difflib import SequenceMatcher

def deduplicate_by_content(chunks: list[dict], similarity_threshold: float = 0.85) -> list[dict]:
    """Remove near-duplicate chunks by text overlap. Swap in embedding similarity if compute permits."""
    unique = []
    for candidate in chunks:
        if not any(
            SequenceMatcher(None, candidate["text"][:500], existing["text"][:500]).ratio() >= similarity_threshold
            for existing in unique
        ):
            unique.append(candidate)
    return unique
```

---

## 8. Context Assembly as a Testable System

The final and most important shift context engineering requires: treating context assembly as a system that can be tested, not a function that is trusted.

The context assembly layer sits between retrieval and generation. Every retrieval improvement you make is mediated by context assembly before it reaches the model. A poor assembly layer can undo excellent retrieval. And because it operates silently — the model still produces an answer regardless — its failures are invisible without deliberate instrumentation.

### Unit Testing Context Assembly

```python
import pytest

def test_critical_turns_never_truncated():
    """The highest-value invariant to test: a constraint the user stated must survive
    truncation even under a tight budget, while normal turns are dropped from the oldest end."""
    critical_turn = ConversationTurn(
        role="user",
        content="My constraint: only discuss options under $10,000.",
        importance=TurnImportance.CRITICAL
    )
    normal_turns = [
        ConversationTurn(role="user", content=f"message {i}", importance=TurnImportance.NORMAL)
        for i in range(50)
    ]
    result = build_conversation_context([critical_turn] + normal_turns, token_budget=500)
    contents = [t["content"] for t in result]
    assert critical_turn.content in contents, "Critical turns must survive truncation"
```

The same discipline applies to every invariant this post has introduced: budget compliance (`select_chunks_within_budget` never returns content exceeding the budget), relevance ordering (selected chunks remain sorted by score), and no mid-chunk truncation (a chunk is either included whole or excluded entirely — never partial). None of these are complex to test, but each one is a real production failure mode if it silently breaks after a refactor. Write the assertion, not the explanation — these are exactly the kind of regressions that pass code review and fail in production three weeks later.

### Eval Integration

Context assembly quality directly affects the RAGAS metrics established in the [LLM Evaluation in Production](/blogs/llm-evaluation-in-production/) post. The connection is not abstract — each assembly failure mode produces a predictable signature in the metric scores:

| Assembly Failure | Primary RAGAS Signal | Secondary Signal |
|---|---|---|
| Low-relevance chunks included | Context Precision ↓ | Answer Correctness ↓ |
| Contradictory chunks in context | Faithfulness ↓ | Answer Correctness ↓ |
| Most relevant chunk buried mid-window | Answer Relevance ↓ | Faithfulness stable |
| Budget exceeded → truncated context | All metrics ↓ | `had_sufficient_context` rate ↓ |
| Stale chunks (old document versions) | Faithfulness ↓ | Context Precision ↓ |
| Near-duplicate chunks | Context Precision ↓ | Answer Relevance stable |

This table is your diagnostic entry point. When the CI pipeline fires a threshold failure, the RAGAS metric that failed tells you which assembly failure to investigate first — before you look at retrieval, before you look at the LLM, before you look at the prompt.

The bridge between the eval pipeline and the assembly layer is the `AssemblyMetadata` dataclass, which extends the `EvalRecord` from the eval post. The eval post's `EvalRecord` captures what the system produced. `AssemblyMetadata` captures *why* the context window looked the way it did:

```python
from dataclasses import dataclass

# Extends the EvalRecord schema from the eval post — attach to every record
@dataclass
class AssemblyMetadata:
    total_chunks_retrieved: int           # raw output from retrieval layer
    chunks_after_relevance_filter: int    # after active relevance scoring (Section 6)
    chunks_after_dedup: int               # after semantic deduplication
    chunks_included_in_context: int       # final count injected into window
    chunks_excluded_by_budget: int        # fit retrieval criteria but didn't fit budget
    estimated_context_tokens: int
    contradictions_detected: int
    working_memory_termination_reason: str  # from AgenticRetrievalResult; "n/a" for single-pass

    def to_eval_record_extension(self) -> dict:
        return {
            "assembly_funnel_ratio": self.chunks_included_in_context / max(self.total_chunks_retrieved, 1),
            "dedup_removal_rate": 1.0 - self.chunks_after_dedup / max(self.chunks_after_relevance_filter, 1),
            "context_tokens_used": self.estimated_context_tokens,
            "contradictions_detected": self.contradictions_detected,
            "budget_constrained": self.chunks_excluded_by_budget > 0,
            "agentic_termination": self.working_memory_termination_reason,
        }
```

In the RAGAS eval runner from the eval post, extend `run_pipeline.py` to capture and emit assembly metadata alongside each eval record:

```python
# In eval/run_pipeline.py — extend the existing pipeline runner
for item in eval_items:
    result, assembly_meta = await pipeline.run_with_assembly_metadata(item["question"])

    records.append({
        "question": item["question"],
        "ground_truth": item["ground_truth_answer"],
        "contexts": [c["text"] for c in result.retrieved_chunks],
        "answer": result.generated_answer,
        # New: assembly diagnostics alongside the generation outputs
        "assembly_metadata": assembly_meta.to_eval_record_extension(),
        "had_sufficient_context": result.had_sufficient_context,
        "agentic_termination_reason": assembly_meta.working_memory_termination_reason,
    })
```

This closes the diagnostic loop: when the GitHub Actions pipeline posts a PR comment showing context precision dropped from 0.82 to 0.71, you open the eval artifacts, filter records where `assembly_funnel_ratio > 0.8` (many chunks passing through) and cross-reference with `dedup_removal_rate` and `contradictions_detected`. The assembly metadata tells you whether the drop was caused by the retrieval layer passing noisier chunks, the dedup logic failing to catch near-duplicates, or budget constraints forcing inclusion of lower-quality chunks. Without it, a context precision drop is just a number. With it, it is a diagnostic with a specific fix.

The `eval_scores` table from the eval post should be extended with an `assembly_metadata` JSONB column to enable this cross-dimensional analysis in your dashboard:

```sql
-- Extension to the eval_scores table from LLM Evaluation in Production
ALTER TABLE eval_scores ADD COLUMN assembly_metadata JSONB;

-- Query: find eval records where context precision dropped AND assembly was budget-constrained
SELECT
    recorded_at,
    context_precision,
    assembly_metadata->>'context_tokens_used' AS tokens_used,
    assembly_metadata->>'budget_constrained' AS was_budget_constrained,
    assembly_metadata->>'contradictions_detected' AS contradictions,
    assembly_metadata->>'agentic_termination' AS agentic_termination
FROM eval_scores
WHERE
    source = 'ci_pipeline'
    AND context_precision < 0.75
ORDER BY recorded_at DESC
LIMIT 50;
```

---

## The Context Engineering Checklist

Before shipping any system where an LLM generates from assembled context:

- [ ] **Token budget defined** — total window, fixed allocations measured, dynamic budget calculated
- [ ] **Memory types separated** — episodic, semantic, procedural, and working memory have distinct stores and injection logic
- [ ] **Semantic memory in system prompt** — user/entity facts injected before retrieved content, not after
- [ ] **Working memory bridged from agentic loop** — `AgenticRetrievalResult.accumulated_context` passes through `WorkingMemory.to_assembly_input()` before injection; not passed raw to the LLM
- [ ] **Agentic termination reason respected** — `"max_iterations"` and `"timeout"` cases apply stricter relevance filtering and reduced token budget before assembly
- [ ] **Chunks selected within budget** — greedy selection by score; no mid-chunk truncation
- [ ] **Chunks ordered by relevance** — highest score first in the documents section
- [ ] **XML section boundaries used** — `<documents>`, `<user_context>`, `<instructions>` tags delineating sections
- [ ] **Grounding instruction in system prompt** — explicit instruction to use only provided context and signal when insufficient
- [ ] **Document indices in context** — every chunk labeled so citations can be traced back to their source
- [ ] **Conversation compression active** — long sessions use progressive summarization + critical turn pinning, not raw truncation
- [ ] **Semantic deduplication before injection** — near-duplicate paraphrases across sources removed (distinct from loop-level ID dedup)
- [ ] **Contradiction detection for high-stakes queries** — conflicting chunks resolved by recency before injection
- [ ] **Active relevance filtering** — chunks below relevance threshold excluded even if they fit in budget
- [ ] **Assembly unit tested** — budget compliance, ordering, critical turn preservation, no truncation
- [ ] **`AssemblyMetadata` emitted per eval record** — funnel ratio, dedup rate, budget constraints, contradiction count, agentic termination reason all logged
- [ ] **Assembly metadata attached to eval pipeline** — `run_pipeline.py` extended to capture `AssemblyMetadata` alongside RAGAS inputs
- [ ] **`assembly_metadata` JSONB column in `eval_scores` table** — enables cross-dimensional analysis of context precision drops vs. assembly decisions
- [ ] **Assembly failure → RAGAS metric mapping documented** — team knows which metric drop points to which assembly failure class

---

## Closing: The Window Is the Product

LLM capabilities have advanced dramatically in the past two years. Context windows have grown by two orders of magnitude. Model reasoning has improved substantially. But the gains from better models are contingent on giving those models well-constructed context to reason over.

The model you are calling is not the bottleneck in most production LLM quality failures. The bottleneck is almost always in what you decided to put in front of it — what you included, what you excluded, how you ordered it, and whether the information was coherent, fresh, and relevant to the query at hand.

Context engineering does not replace good retrieval. It does not replace good prompt engineering. It is the layer between them that determines whether your work on both translates into quality at the output. A retrieval system that returns the right chunks, assembled by context logic that positions them poorly, dilutes them with noise, or exceeds the effective attention range of the model, produces worse answers than simpler retrieval with disciplined assembly.

Treat the context window as the product your architecture delivers to the model. Design it. Budget it. Test it. Monitor it. The teams that get LLM systems right in production are the ones who understand that the model is not magic — it is a function, and context is its input. Garbage in, garbage out has not stopped being true. It has just become more expensive.

> **📌 Key Takeaway**
>
> Context engineering is the assembly layer between retrieval and generation — and the one most commonly skipped. The [Agentic RAG](/blogs/designing-self-correcting-retrieval-loops-for-production/) post produces `AgenticRetrievalResult.accumulated_context`: chunks collected across iterative retrieval passes, bounded, and deduplicated at the loop level. Context engineering takes that output and applies a second layer of decisions: token budget allocation across episodic, semantic, procedural, and working memory; semantic deduplication to remove near-paraphrases the loop's ID-based dedup missed; relevance filtering to exclude noise; ordering to exploit primacy and recency effects; and structural formatting so the model attends to the right information at the right weight. The [LLM Evaluation in Production](/blogs/llm-evaluation-in-production/) post then closes the loop: `AssemblyMetadata` attached to every `EvalRecord` maps each RAGAS metric drop to its assembly cause — context precision falling points to noisy chunk inclusion, faithfulness falling points to contradiction or stale content, answer relevance falling points to ordering or positional degradation. Retrieval gives you candidate information. Context engineering decides what the model actually sees. Evaluation tells you when the assembly decisions were wrong. All three layers are required. None is optional.

---

*Further Reading: Liu et al. — Lost in the Middle: How Language Models Use Long Contexts (2023), Anthropic — Prompt Engineering Documentation, Lilian Weng — Prompt Engineering (Lil'Log, 2023), Shi et al. — Large Language Models Can Be Easily Distracted by Irrelevant Context (2023), Guo et al. — Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (2020)*

{% endraw %}
