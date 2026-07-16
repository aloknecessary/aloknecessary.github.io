---
title: "LLM Evaluation in Production: Building the Eval Pipeline That Runs on Every Deploy"
published: true
description: Faithfulness scoring, LLM-as-Judge calibration, RAGAS integration, golden dataset management, and wiring it into CI/CD — the eval infrastructure that catches quality regressions before users do
tags: ai, machinelearning, devops, architecture
canonical_url: https://aloknecessary.github.io/blogs/llm-evaluation-in-production/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=llm-evaluation-in-production
cover_image: 
---

Everyone ships the RAG system. Almost nobody ships the eval system that tells them when the RAG system starts lying.

You updated the embedding model. Tweaked the system prompt. Swapped the re-ranker. Metrics look fine. Three weeks later, support tickets arrive — the system is drawing inferences the source documents never made. No alarm fired. No test failed. The system drifted silently.

This is not a model quality problem. It is an evaluation infrastructure problem.

---

## The Four Metrics That Matter

**Faithfulness** — of the claims in the response, what fraction are directly supported by the retrieved context? Your primary hallucination guard. Does not require ground truth.

**Answer Relevance** — how directly does the response address the user's question? Catches the "technically correct but useless" failure mode. Does not require ground truth.

**Context Precision** — of the retrieved chunks, what fraction were actually relevant? Requires ground truth. Belongs in offline CI eval.

**Answer Correctness** — how factually accurate vs the reference answer? Most expensive, requires curated ground truth. Pre-deploy regression suite only.

**Operational rule:** Faithfulness and Answer Relevance run on every deploy and on sampled production traffic. Context Precision and Answer Correctness run in CI against the golden dataset.

---

## LLM-as-Judge: The Pattern and Pitfalls

RAGAS uses an LLM to evaluate LLM output — the only practical way to evaluate semantic quality at scale.

Pitfalls to manage:

- **Positional bias** — randomize order in pairwise comparisons
- **Verbosity bias** — judge rates longer answers higher even when less accurate
- **Self-preference** — use a different model family as judge than the one generating answers
- **Calibration drift** — pin judge model to a specific version; treat upgrades as baseline resets

Calibrate against human labels using Cohen's Kappa on 50-100 examples. Below 0.4 means your judge prompt needs revision.

---

## CI/CD Integration

The eval pipeline triggers on every PR touching RAG code, prompts, or model configuration:

1. Run RAG pipeline against golden dataset (100+ curated questions)
2. Score with RAGAS (faithfulness, relevance, precision, correctness)
3. Compare against baseline — block deploy if regression exceeds threshold
4. Post results as PR comment with per-metric scores and pass/fail status

Cost: ~$0.50-$2.00 per full eval run at Claude Sonnet pricing. On PRs, run only faithfulness + relevance (cheapest). Full suite runs nightly.

---

## Production Sampling

CI catches regressions from code changes. Production sampling catches drift from corpus staleness, query distribution shift, and model behavior changes.

Sample 5% of live traffic for async evaluation. Never evaluate synchronously — judge calls add 2-5s per request. Track 7-day rolling faithfulness and answer relevance. Alert when they drop >0.05 from monthly baseline.

---

## The Key Insight

LLM systems do not have stable, deterministic behavior. They drift through corpus changes, model updates, prompt evolution, and query distribution shift. Evaluation is not a checkpoint — it is continuous infrastructure.

> Build the eval system before you need it. By the time you need it, it is already too late — you will be debugging a production quality regression with no historical baseline and no automated detection.

---

## Read the Full Article

This is a summary of my deep dive into LLM evaluation infrastructure. The full article covers the complete eval stack with implementation examples:

**👉 [LLM Evaluation in Production — Full Article](https://aloknecessary.github.io/blogs/llm-evaluation-in-production/?utm_source=devto&utm_medium=referral&utm_campaign=blog_syndication&utm_content=llm-evaluation-in-production)**

The full article includes:

- Evaluation stack architecture (retrieval layer vs generation layer)
- Four metrics with RAGAS Python implementations
- LLM-as-Judge faithfulness prompt with claim-level scoring
- Judge calibration against human labels (Cohen's Kappa)
- RAGAS configuration with Claude as judge model
- Regression threshold framework (absolute + delta from baseline)
- Golden dataset generation, versioning, and holdout partitions
- Full GitHub Actions eval pipeline (YAML + runner scripts)
- Production sampling with async eval queue worker
- Eval observability dashboard schema (PostgreSQL)
- Eight failure modes in eval systems and mitigations
- Production deployment checklist
