---
title: "AI-Assisted Data Reconciliation at Scale: Patterns for Distributed Systems"
date: 2026-05-20
last_modified_at: 2026-05-20
author: Alok Ranjan Daftuar
description: "A practical architecture guide to AI-assisted data reconciliation — embedding-based similarity for schema-agnostic matching, LLM classification for ambiguous cases, observation windows for eventual consistency, and the boundaries where AI should never make the call."
excerpt: "Traditional reconciliation breaks at the seams of distributed ownership. This post covers where rule-based reconciliation fails, how embedding similarity and LLM classification fill the gap, the observation window pattern for eventual consistency, and the hard boundaries where AI should never be trusted to auto-resolve."
keywords: "data reconciliation, AI reconciliation, embedding similarity, LLM classification, distributed systems, data consistency, schema drift, vector search, data quality, system design"
twitter_card: summary_large_image
categories:
  - architecture
  - system-design
tags: [ai, distributed-systems, data-reconciliation, vector-search, llm, architecture, patterns, observability, cloud-native, system-design]
---

> Traditional reconciliation breaks at the seams of distributed ownership. Here is how AI fills the gaps — and where it should never be trusted to.

## The Reconciliation Problem Nobody Wants to Own

In any sufficiently large distributed system, data reconciliation is the dark matter of engineering — invisible, pervasive, and holding everything together through mechanisms nobody fully understands.

You have an order service, a billing service, an inventory service, and a customer profile service. Each owns its slice of truth. Each has its own database, its own schema, its own release cadence. And over time, because of eventual consistency windows, failed events, schema drift, partial writes, and midnight hotfixes, those slices of truth start to diverge.

The traditional answer is rule-based reconciliation: scheduled jobs that diff tables, compare checksums, flag mismatches, and either auto-correct or route to a human queue. This works — until it doesn't. Rule engines break on ambiguity. They cannot handle semantic equivalence across schema versions. They generate false positives at scale that overwhelm operations teams. And they are blind to the *why* behind a mismatch, which means every resolution is a manual investigation.

This is where AI — specifically embedding-based similarity and LLM-assisted classification — starts to earn its place in the data engineering stack. Not as a replacement for deterministic reconciliation, but as a layer that handles what rules cannot.

> **Article context:** This blog builds directly on the [CAP Theorem](/blogs/cap_theorem_architecture/) and [Partial Failure](/blogs/designing_for_partial_failure/) posts in this series. The consistency trade-offs and failure modes discussed there are the upstream causes of the reconciliation problems addressed here.

### Table of Contents
- [The Reconciliation Problem Nobody Wants to Own](#the-reconciliation-problem-nobody-wants-to-own)
- [1. Where Traditional Reconciliation Breaks Down](#1-where-traditional-reconciliation-breaks-down)
- [2. The AI-Assisted Reconciliation Architecture](#2-the-ai-assisted-reconciliation-architecture)
- [3. Embedding-Based Similarity for Schema-Agnostic Matching](#3-embedding-based-similarity-for-schema-agnostic-matching)
- [4. LLM-Based Classification for Ambiguous Cases](#4-llm-based-classification-for-ambiguous-cases)
- [5. Handling Eventual Consistency — The Timing Problem](#5-handling-eventual-consistency--the-timing-problem)
- [6. Where AI Should Not Be in the Reconciliation Loop](#6-where-ai-should-not-be-in-the-reconciliation-loop)
- [7. Observability for AI-Assisted Reconciliation](#7-observability-for-ai-assisted-reconciliation)
- [The Reconciliation Checklist](#the-reconciliation-checklist)
- [Closing: AI as a Judgment Layer, Not a Trust Layer](#closing-ai-as-a-judgment-layer-not-a-trust-layer)

---

## 1. Where Traditional Reconciliation Breaks Down

Before reaching for AI, it is worth being precise about *where* rule-based reconciliation fails. Applying AI to a problem that a well-written SQL query solves is not architecture — it is over-engineering.

### Eventual Consistency Windows

In an AP system, two services reading the same logical entity at the same moment will return different values — not because of a bug, but because replication has not caught up. A naive reconciliation job that diffs at a point in time will generate thousands of false positives that are self-healing within seconds.

The rule engine cannot distinguish between *a legitimate divergence that requires intervention* and *a transient inconsistency that will resolve on its own*. It either misses real problems by waiting too long, or drowns the ops team in noise by checking too early.

### Cross-Service Schema Drift

Service A stores a customer's address as `{ street, city, state, zip }`. Service B, after a schema migration, stores it as `{ addressLine1, addressLine2, municipality, postalCode, countryCode }`. The data is semantically equivalent. A field-level comparator will flag every record as mismatched because the structure has changed, even though no data has been lost or corrupted.

Rule engines require explicit mapping rules for every schema permutation. In an organization with dozens of services and continuous delivery, maintaining those mappings is a full-time job that nobody is hired to do.

### Semantic Equivalence Across Free-Text Fields

Service A stores a company name as `"Acme Corporation"`. Service B, populated from a different integration, stores it as `"ACME Corp."`. A string comparator flags this as a mismatch. A fuzzy matcher might catch it with enough tuning. But what about `"Acme Corp (formerly Roadrunner Supplies)"` vs `"Acme Corporation"`? Rule-based systems cannot reason about semantic identity across free-text fields at scale.

### Volume-Driven False Positive Fatigue

At millions of records per day, even a 0.1% false positive rate generates thousands of alerts. Operations teams learn to ignore the queue. Real issues — the ones that affect revenue or compliance — get buried under noise. The reconciliation system becomes theater: running, alerting, and achieving nothing.

---

## 2. The AI-Assisted Reconciliation Architecture

The architecture is not AI-first — it is **rules-first, AI at the boundary**. Deterministic checks handle the high-confidence majority. AI handles the ambiguous remainder that rules cannot classify with confidence.

```
Raw Mismatch Detection (deterministic)
          │
          ▼
 High-Confidence Match?
    ├── YES → Auto-resolve (no AI needed)
    └── NO  ▼
 High-Confidence Mismatch?
    ├── YES → Route to correction pipeline (no AI needed)
    └── AMBIGUOUS ▼
         ┌─────────────────────────────┐
         │   AI Classification Layer   │
         │  ┌─────────────────────┐   │
         │  │ Embedding Similarity │   │  ← semantic match detection
         │  └─────────────────────┘   │
         │  ┌─────────────────────┐   │
         │  │  LLM Classification  │   │  ← intent and context reasoning
         │  └─────────────────────┘   │
         └────────────┬────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
   Auto-Resolve             Human Review Queue
   (high AI confidence)     (low AI confidence)
```

The AI layer has two responsibilities:

1. **Embedding-based similarity** — detect semantic equivalence across schema variations and free-text fields
2. **LLM-based classification** — reason about *why* a mismatch exists and whether it is a data quality issue, a timing artifact, or a genuine corruption

Neither replaces human judgment for low-confidence cases. Both dramatically reduce the volume of cases that reach human review.

---

## 3. Embedding-Based Similarity for Schema-Agnostic Matching

The core insight: if two records describe the same real-world entity, their embedded representations should be geometrically close — regardless of schema differences, field naming, or minor textual variation.

### Implementation Pattern

Serialize each record into a normalized text representation before embedding. Do not embed raw JSON — the structural tokens add noise. Extract the semantically meaningful fields and construct a consistent prose representation:

```python
def serialize_for_embedding(record: dict, schema_version: str) -> str:
    """
    Normalize a record to a schema-agnostic text representation
    before embedding. Field names are dropped; values are retained.
    """
    if schema_version == "v1":
        return (
            f"Customer: {record['name']}. "
            f"Address: {record['street']}, {record['city']}, "
            f"{record['state']} {record['zip']}. "
            f"Email: {record['email']}."
        )
    elif schema_version == "v2":
        return (
            f"Customer: {record['fullName']}. "
            f"Address: {record['addressLine1']}, {record['municipality']}, "
            f"{record['postalCode']}. "
            f"Email: {record['contactEmail']}."
        )
```

Embed both serialized representations using the same model and compute cosine similarity:

```python
import numpy as np
from openai import OpenAI

client = OpenAI()

def get_embedding(text: str, model="text-embedding-3-large") -> list[float]:
    return client.embeddings.create(
        input=text,
        model=model
    ).data[0].embedding

def cosine_similarity(a: list[float], b: list[float]) -> float:
    a, b = np.array(a), np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

def classify_record_pair(record_a: dict, schema_a: str,
                          record_b: dict, schema_b: str) -> dict:
    text_a = serialize_for_embedding(record_a, schema_a)
    text_b = serialize_for_embedding(record_b, schema_b)

    embedding_a = get_embedding(text_a)
    embedding_b = get_embedding(text_b)

    similarity = cosine_similarity(embedding_a, embedding_b)

    return {
        "similarity": similarity,
        "classification": (
            "match"    if similarity >= 0.95 else
            "review"   if similarity >= 0.80 else
            "mismatch"
        )
    }
```

### Threshold Calibration

The similarity thresholds (0.95, 0.80) are not universal — they must be calibrated against a labeled sample of your actual data. Run a calibration exercise with 500–1000 manually classified record pairs before setting production thresholds. Expect to revisit them after schema migrations or embedding model upgrades.

| Similarity Range | Classification | Action |
|---|---|---|
| ≥ 0.95 | High-confidence match | Auto-resolve as equivalent |
| 0.80 – 0.95 | Ambiguous | Route to LLM classification |
| < 0.80 | High-confidence mismatch | Route to correction pipeline |

---

## 4. LLM-Based Classification for Ambiguous Cases

Embedding similarity tells you *how similar* two records are. It does not tell you *why* they differ or whether the difference is meaningful. For the ambiguous middle band, an LLM can reason about context that a vector distance cannot capture.

### The Classification Prompt Pattern

```python
from anthropic import Anthropic

anthropic_client = Anthropic()

RECONCILIATION_SYSTEM_PROMPT = """
You are a data reconciliation specialist. You will be given two records 
from different systems representing the same logical entity. Your job is 
to classify the relationship between them and explain your reasoning.

Respond ONLY in valid JSON with this structure:
{
  "classification": "equivalent" | "stale_copy" | "legitimate_divergence" | "data_corruption",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<one sentence explanation>",
  "recommended_action": "auto_resolve" | "human_review" | "flag_for_correction"
}

Classifications:
- equivalent: records describe the same entity; differences are cosmetic or schema-related
- stale_copy: one record is an older version of the other; the newer one is authoritative  
- legitimate_divergence: records differ for a valid business reason (e.g. regional pricing)
- data_corruption: one record contains invalid or corrupted data
"""

def classify_with_llm(record_a: dict, source_a: str,
                       record_b: dict, source_b: str) -> dict:
    prompt = f"""
Compare these two records from different systems:

SOURCE A ({source_a}):
{record_a}

SOURCE B ({source_b}):
{record_b}

Classify the relationship between these records.
"""
    response = anthropic_client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        system=RECONCILIATION_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}]
    )

    import json
    return json.loads(response.content[0].text)
```

### Cost Management

LLM calls are not free. Route only the ambiguous band (0.80–0.95 similarity) to the LLM. At scale, this might be 5–15% of your total mismatch volume — a manageable subset. Batch calls where latency allows, and cache results for record pairs that are re-evaluated in subsequent reconciliation cycles.

---

## 5. Handling Eventual Consistency — The Timing Problem

The most dangerous false positives in AI-assisted reconciliation are timing artifacts — records that look mismatched because one system has processed an event and the other hasn't yet. Sending these to an LLM is expensive and pointless; the LLM has no way to know the record will self-heal.

### The Observation Window Pattern

Before any AI classification, apply a deterministic delay filter:

```python
from datetime import datetime, timedelta

def should_evaluate(mismatch_event: dict, observation_window_seconds: int = 30) -> bool:
    """
    Only evaluate mismatches that have persisted beyond the observation window.
    Transient eventual consistency gaps self-heal within this window.
    """
    detected_at = datetime.fromisoformat(mismatch_event["detected_at"])
    age = (datetime.utcnow() - detected_at).total_seconds()
    return age >= observation_window_seconds
```

Tune the observation window based on your system's p99 replication lag — not a fixed value. If your event pipeline has a p99 lag of 8 seconds, a 30-second window eliminates virtually all transient false positives. If you have a cross-region pipeline with p99 lag of 4 minutes, adjust accordingly and instrument that lag as a first-class metric.

---

## 6. Where AI Should Not Be in the Reconciliation Loop

Knowing when *not* to use AI is as important as knowing when to use it. There are categories of reconciliation decisions that must remain deterministic:

**Financial and compliance records** — revenue figures, transaction amounts, regulatory reporting data. If two systems disagree on a dollar amount, that is not an ambiguous semantic question. It is a correctness error that requires a deterministic audit trail. An LLM classification is not auditable and is not appropriate here.

**Primary key and identity resolution** — whether two records represent the same entity is a foundational question that downstream systems depend on. Getting it wrong propagates errors across the entire data graph. AI-assisted suggestions are acceptable; AI-driven auto-resolution without human sign-off is not.

**High-velocity, low-value records** — clickstream events, telemetry data, log aggregates. The reconciliation cost exceeds the business value. Apply statistical sampling and anomaly detection instead.

**Any decision that must be explainable to a regulator** — GDPR data subject requests, SOX audit trails, PCI compliance records. "The model classified it as equivalent with 87% confidence" is not an audit-compliant explanation.

---

## 7. Observability for AI-Assisted Reconciliation

An AI component in your data pipeline is only as trustworthy as your ability to measure its behavior over time.

**Track per-classification-band volumes** — what percentage of mismatches fall into auto-resolve, LLM review, and human review? A shift in these ratios signals a data quality change or a model drift issue.

**Measure AI classification accuracy against human overrides** — when a human reviewer overrides an AI recommendation, log it. Build a feedback loop that periodically re-evaluates your thresholds and prompt against a growing labeled dataset.

**Alert on human review queue depth** — a growing human review queue means the AI confidence boundary is not calibrated correctly, or a new category of mismatch has emerged that the model hasn't seen before.

**Log every LLM decision with full context** — classification, confidence, reasoning, record IDs, model version, and prompt version. When a downstream audit asks why two records were merged, you need a complete, reproducible answer.

```typescript
// Structured log entry for every AI reconciliation decision
logger.info({
  event: 'reconciliation_decision',
  record_id_a: recordA.id,
  record_id_b: recordB.id,
  source_a: 'order-service',
  source_b: 'billing-service',
  embedding_similarity: 0.87,
  llm_classification: 'stale_copy',
  llm_confidence: 'high',
  llm_model: 'claude-sonnet-4-20250514',
  prompt_version: 'v2.1',
  action_taken: 'auto_resolve',
  resolved_at: new Date().toISOString(),
});
```

---

## The Reconciliation Checklist

Before deploying AI-assisted reconciliation to production:

- [ ] **Observation window configured** — transient eventual consistency gaps are filtered before AI evaluation
- [ ] **Similarity thresholds calibrated** on a labeled sample of your actual data, not defaults
- [ ] **LLM prompt versioned and tested** — prompt changes are treated as code changes with regression tests
- [ ] **Financial and compliance records excluded** from AI auto-resolution; deterministic rules only
- [ ] **Human review queue alarmed** — queue depth growth triggers an alert, not just a dashboard metric
- [ ] **Every AI decision logged** with full context — record IDs, model version, prompt version, confidence
- [ ] **Feedback loop instrumented** — human overrides are captured and used to recalibrate thresholds
- [ ] **Cost per classification tracked** — LLM call volume and cost are monitored as operational metrics

---

## Closing: AI as a Judgment Layer, Not a Trust Layer

The temptation when adding AI to any pipeline is to treat it as a trust layer — something that makes decisions so you don't have to. In data reconciliation, this is the wrong mental model. AI is a **judgment layer** — it handles the ambiguous cases that rules cannot, reduces the volume that reaches human review, and provides structured reasoning for the decisions it makes.

The deterministic foundation must remain intact. Rules handle the clear cases. Humans handle the genuinely uncertain ones. AI fills the gap in between — but it does so with explicit confidence levels, full audit trails, and a feedback loop that makes it measurably better over time.

A reconciliation system you cannot audit is worse than one that generates false positives. Build the observability before you build the AI.

> **📌 Key Takeaway**
>
> AI-assisted reconciliation is not about replacing rule engines. It is about extending them into the ambiguous territory where rules break — semantic equivalence, schema drift, and free-text matching. Keep deterministic checks in the majority path. Use AI at the boundary. Never use AI for decisions that require an auditable, reproducible explanation.

---

*Further Reading: Brewer — CAP Theorem (2000), Kleppmann — Designing Data-Intensive Applications Ch. 5 (Replication), Google — Zanzibar: Google's Consistent, Global Authorization System (2019), Databricks — Delta Lake: High-Performance ACID Table Storage*
