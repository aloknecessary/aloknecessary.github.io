---
title: "LLM Evaluation in Production: Building the Eval Pipeline That Runs on Every Deploy"
date: 2026-06-11
last_modified_at: 2026-06-11
author: Alok Ranjan Daftuar
description: "A production engineering guide to LLM evaluation — faithfulness scoring, answer relevance, hallucination detection, LLM-as-Judge patterns, golden dataset management, RAGAS integration, and wiring it all into a CI/CD pipeline that catches quality regressions before they reach users."
excerpt: "Everyone ships the RAG system. Almost nobody ships the eval system that tells them when the RAG system starts lying. This post covers the four metrics that matter, LLM-as-Judge calibration, RAGAS integration, golden dataset management, GitHub Actions eval pipeline, and production sampling for continuous quality monitoring."
keywords: "LLM evaluation, RAG evaluation, RAGAS, faithfulness, hallucination detection, LLM-as-Judge, golden dataset, CI/CD eval pipeline, answer relevance, production AI"
twitter_card: summary_large_image
categories:
  - ai
  - architecture
tags: [ai, rag, llm, evaluation, observability, ci-cd, github-actions, production, ragas, architecture]
series: "RAG and AI Engineering"
series_order: 3
---

{% raw %}

> Everyone ships the RAG system. Almost nobody ships the eval system that tells them when the RAG system starts lying.

## The Invisible Regression Problem

Your RAG pipeline is in production. Retrieval looks healthy — Recall@K is strong, MRR is stable, latency is within SLA. You updated the embedding model last week to get better semantic coverage. You tweaked the system prompt to reduce verbosity. The re-ranker was swapped for a lighter model to cut p99 latency.

The metrics look fine. Users have not filed critical bugs. You ship with confidence.

Three weeks later, a support ticket arrives. Then five more. The system is giving answers that are technically grounded — the retrieved chunks are correct — but the generated responses are drawing inferences the source documents never made. The embedding model upgrade changed which chunks surface for certain query patterns. The system prompt change relaxed a grounding constraint you did not realize was load-bearing. The lighter re-ranker is letting through marginally relevant chunks that poison the context.

No alarm fired. No test failed. The system drifted, and you had no instrumentation to catch it.

This is not a model quality problem. It is an evaluation infrastructure problem. You shipped changes to an LLM-based system without a test suite that could detect quality regressions. You would never deploy a service change without unit tests and integration tests. LLM output quality is no different — except that the failure mode is silent, gradual, and invisible to traditional monitoring.

This post covers how to build the eval pipeline that runs on every deploy.

> **Article context:** This post is part of the RAG and AI Engineering series. The [Building Reliable RAG Pipelines](/blogs/rag_prototype_to_production/) post covers retrieval evaluation (Recall@K, MRR) and pipeline instrumentation. This post picks up where that one ends — at the generation layer — and covers how to evaluate *what the LLM produces*, not just *what the retrieval returns*.

### Table of Contents

- [The Invisible Regression Problem](#the-invisible-regression-problem)
- [1. The Evaluation Stack, Layer by Layer](#1-the-evaluation-stack-layer-by-layer)
- [2. The Four Metrics That Actually Matter](#2-the-four-metrics-that-actually-matter)
- [3. LLM-as-Judge — The Pattern, the Pitfalls, and the Calibration](#3-llm-as-judge--the-pattern-the-pitfalls-and-the-calibration)
- [4. RAGAS — Production-Ready Eval Without Building from Scratch](#4-ragas--production-ready-eval-without-building-from-scratch)
- [5. Building and Maintaining Your Golden Dataset](#5-building-and-maintaining-your-golden-dataset)
- [6. Wiring Evals into CI/CD — GitHub Actions Pipeline](#6-wiring-evals-into-cicd--github-actions-pipeline)
- [7. Eval Observability — Tracking Quality Over Time](#7-eval-observability--tracking-quality-over-time)
- [8. Failure Modes in Eval Systems](#8-failure-modes-in-eval-systems)
- [The Eval Checklist](#the-eval-checklist)
- [Closing: Eval Is Not a QA Step — It Is a First-Class System](#closing-eval-is-not-a-qa-step--it-is-a-first-class-system)

---

## 1. The Evaluation Stack, Layer by Layer

Before building anything, establish a precise mental model of *what* you are evaluating. A RAG system has two independently failing components, and most teams conflate them.

```text
User Query
    │
    ▼
[RETRIEVAL LAYER]          ← Evaluated by: Recall@K, MRR, Context Relevance
    │  BM25 + Vector → RRF → Re-rank → Context Assembly
    ▼
[GENERATION LAYER]         ← Evaluated by: Faithfulness, Answer Relevance,
    │  LLM(prompt + context) → Response           Completeness, Hallucination Rate
    ▼
Response
```

Retrieval evaluation asks: *Did the right information enter the context window?*
Generation evaluation asks: *Given that context, did the LLM produce an accurate, grounded, and useful response?*

A system can have excellent retrieval and catastrophic generation — if the prompt grounding is weak, the model will synthesize plausible-sounding content beyond what the context supports. Conversely, strong generation cannot compensate for bad retrieval — the model cannot cite information it never received.

You need both evaluation layers. This post focuses on generation evaluation, which is harder to measure, less commonly instrumented, and the more frequent source of production failures in teams that have already done the retrieval work.

---

## 2. The Four Metrics That Actually Matter

Generation evaluation has a proliferation problem — there are dozens of proposed metrics, many of which are correlated, expensive to compute, or not meaningfully actionable. In production, you need a small set of metrics that are cheap to run on every deploy, sensitive to the regressions you actually care about, and explainable enough to debug when they fire.

These are the four that earn their place.

### Faithfulness

**Definition:** Of the claims made in the generated response, what fraction are directly supported by the retrieved context?

This is your primary hallucination guard. A faithfulness score of 1.0 means every factual claim in the response traces back to a specific passage in the retrieved chunks. A score of 0.6 means 40% of the response's claims have no grounding — the model is confabulating.

Faithfulness is query-independent — it does not require knowing the "correct" answer. It only requires the context and the response. This makes it practical for large-scale production evaluation where ground truth answers are expensive to maintain.

```python
from ragas.metrics import faithfulness
from ragas import evaluate
from datasets import Dataset

def evaluate_faithfulness(
    questions: list[str],
    contexts: list[list[str]],
    answers: list[str]
) -> float:
    """
    Compute faithfulness score across a batch of question-context-answer triples.
    Returns mean faithfulness score in [0, 1].
    """
    data = {
        "question": questions,
        "contexts": contexts,
        "answer": answers,
    }
    dataset = Dataset.from_dict(data)
    result = evaluate(dataset, metrics=[faithfulness])
    return result["faithfulness"]
```

### Answer Relevance

**Definition:** How directly does the generated response address the user's question?

A response can be fully faithful to the context — every claim grounded — and still fail to answer the question asked. Answer relevance catches the "technically correct but useless" failure mode where the model retrieves and summarizes adjacent information rather than the specific answer requested.

Answer relevance is computed without reference to the ground truth answer, which makes it suitable for online evaluation against real user queries.

```python
from ragas.metrics import answer_relevancy

def evaluate_answer_relevance(
    questions: list[str],
    contexts: list[list[str]],
    answers: list[str]
) -> float:
    data = {
        "question": questions,
        "contexts": contexts,
        "answer": answers,
    }
    dataset = Dataset.from_dict(data)
    result = evaluate(dataset, metrics=[answer_relevancy])
    return result["answer_relevancy"]
```

### Context Precision

**Definition:** Of the retrieved chunks passed to the LLM, what fraction were actually relevant to generating the answer?

Low context precision means you are filling the context window with noise. Even if the model ignores the irrelevant chunks, they consume token budget that could be used for genuinely relevant content, and they increase the risk of the model drawing spurious connections across unrelated passages.

Context precision requires ground truth — you need to know which chunks *should* have been relevant. This is why it belongs in your offline eval pipeline (against a golden dataset) rather than online production scoring.

```python
from ragas.metrics import context_precision

def evaluate_context_precision(
    questions: list[str],
    contexts: list[list[str]],
    answers: list[str],
    ground_truths: list[str]
) -> float:
    data = {
        "question": questions,
        "contexts": contexts,
        "answer": answers,
        "ground_truth": ground_truths,
    }
    dataset = Dataset.from_dict(data)
    result = evaluate(dataset, metrics=[context_precision])
    return result["context_precision"]
```

### Answer Correctness

**Definition:** How factually accurate is the generated answer compared to the ground truth answer?

This is the closest metric to "is the system giving right answers?" — but it is also the most expensive, because it requires curated ground truth answers for every query in your eval set. Do not attempt to use answer correctness as your primary production metric; it belongs in your pre-deploy regression suite against a fixed golden dataset.

```python
from ragas.metrics import answer_correctness

def evaluate_answer_correctness(
    questions: list[str],
    contexts: list[list[str]],
    answers: list[str],
    ground_truths: list[str]
) -> float:
    data = {
        "question": questions,
        "contexts": contexts,
        "answer": answers,
        "ground_truth": ground_truths,
    }
    dataset = Dataset.from_dict(data)
    result = evaluate(dataset, metrics=[answer_correctness])
    return result["answer_correctness"]
```

### The Metric Selection Matrix

| Metric | Requires Ground Truth | Suitable for Online Eval | Regression Sensitivity |
| --- | --- | --- | --- |
| Faithfulness | No | Yes | Hallucination, prompt changes |
| Answer Relevance | No | Yes | Retrieval drift, query handling |
| Context Precision | Yes | No | Retrieval changes, chunking |
| Answer Correctness | Yes | No | End-to-end quality baseline |

The operational rule: **Faithfulness and Answer Relevance run on every deploy and on sampled production traffic. Context Precision and Answer Correctness run in the CI pipeline against the golden dataset.**

---

## 3. LLM-as-Judge — The Pattern, the Pitfalls, and the Calibration

RAGAS computes most of its metrics by using an LLM to evaluate LLM output. This is the LLM-as-Judge pattern — and it is the only practical way to evaluate semantic quality at scale without hiring a room full of human annotators.

The pattern: given a question, a context, and a response, construct a structured prompt that asks the judge LLM to assess a specific quality dimension and return a structured score.

```python
import anthropic
import json

client = anthropic.Anthropic()

FAITHFULNESS_JUDGE_PROMPT = """You are an evaluation assistant assessing whether a generated answer
is faithful to the provided context.

Faithfulness means: every factual claim in the answer is directly supported by the context.
An answer is NOT faithful if it introduces facts, inferences, or conclusions not present in the context.

Context:
{context}

Generated Answer:
{answer}

Evaluate faithfulness. For each claim in the answer, identify whether it is supported by the context.

Respond ONLY with valid JSON in this exact format:
{{
  "claims": [
    {{"claim": "...", "supported": true/false, "evidence": "quote from context or null"}}
  ],
  "faithfulness_score": 0.0-1.0,
  "reasoning": "brief explanation"
}}"""

def judge_faithfulness(context: str, answer: str) -> dict:
    prompt = FAITHFULNESS_JUDGE_PROMPT.format(
        context=context,
        answer=answer
    )

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}]
    )

    raw = response.content[0].text.strip()
    # Strip markdown fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())
```

### The Pitfalls You Will Hit

**Positional bias.** LLM judges tend to score options presented first or last higher than middle options. In pairwise comparison scenarios, always randomize order and average across orderings.

**Verbosity bias.** Judge LLMs consistently rate longer, more detailed answers higher — even when the shorter answer is more accurate. Explicitly instruct the judge to evaluate *accuracy*, not *completeness*, and provide examples of high-scoring short answers.

**Self-preference.** If you use Claude to judge output produced by Claude, the judge will systematically prefer its own generation style. For high-stakes eval, use a different model family as judge than the one producing answers. Claude judging GPT-4o output, or vice versa, produces less biased scores.

**Calibration drift.** Judge scoring is not absolute — it reflects the judge model's current behavior. If Anthropic or OpenAI updates the judge model, your score baselines shift even if your RAG system did not change. Pin your judge model to a specific version and treat model upgrades as a baseline reset event.

```python
# Always pin the judge model version. Never use an alias like "claude-sonnet-latest".
JUDGE_MODEL = "claude-sonnet-4-20250514"  # pinned — update intentionally, not automatically
```

### Calibrating Against Human Labels

Before trusting LLM-as-Judge scores as a regression gate, calibrate them against human judgments on a sample of 50–100 examples. Measure inter-annotator agreement between the LLM judge and your human raters using Cohen's Kappa. A Kappa above 0.6 is acceptable for production use. Below 0.4 means your judge prompt needs revision.

```python
from sklearn.metrics import cohen_kappa_score

def calibrate_judge(
    llm_scores: list[int],   # binarized: 1 = faithful, 0 = not
    human_scores: list[int]
) -> float:
    kappa = cohen_kappa_score(human_scores, llm_scores)
    print(f"Cohen's Kappa: {kappa:.3f}")
    if kappa < 0.4:
        print("WARNING: LLM judge is poorly calibrated. Revise judge prompt.")
    elif kappa < 0.6:
        print("CAUTION: Moderate agreement. Acceptable with awareness of uncertainty.")
    else:
        print("OK: Strong agreement. Judge is production-calibrated.")
    return kappa
```

---

## 4. RAGAS — Production-Ready Eval Without Building from Scratch

RAGAS (Retrieval Augmented Generation Assessment) is the most mature open-source framework for RAG evaluation. It implements faithfulness, answer relevance, context precision, context recall, and answer correctness — all using LLM-as-Judge under the hood — with a clean interface that integrates directly into Python pipelines.

### Installation and Configuration

```bash
pip install ragas langchain-anthropic
```

```python
from ragas import evaluate
from ragas.metrics import (
    faithfulness,
    answer_relevancy,
    context_precision,
    answer_correctness,
)
from langchain_anthropic import ChatAnthropic
from ragas.llms import LangchainLLMWrapper

# Configure RAGAS to use Claude as the judge model
judge_llm = LangchainLLMWrapper(
    ChatAnthropic(
        model="claude-sonnet-4-20250514",
        anthropic_api_key=os.environ["ANTHROPIC_API_KEY"]
    )
)

# Apply to all metrics
for metric in [faithfulness, answer_relevancy, context_precision, answer_correctness]:
    metric.llm = judge_llm
```

### Running a Full Evaluation Batch

```python
from datasets import Dataset
import pandas as pd

def run_ragas_evaluation(eval_records: list[dict]) -> dict:
    """
    eval_records: list of dicts with keys:
        - question (str)
        - contexts (list[str])  — the chunks passed to the LLM
        - answer (str)           — the LLM's generated response
        - ground_truth (str)     — the reference answer (for offline metrics)
    """
    dataset = Dataset.from_list(eval_records)

    results = evaluate(
        dataset,
        metrics=[
            faithfulness,
            answer_relevancy,
            context_precision,
            answer_correctness,
        ]
    )

    scores = {
        "faithfulness": results["faithfulness"],
        "answer_relevancy": results["answer_relevancy"],
        "context_precision": results["context_precision"],
        "answer_correctness": results["answer_correctness"],
    }

    print(f"Faithfulness:       {scores['faithfulness']:.3f}")
    print(f"Answer Relevancy:   {scores['answer_relevancy']:.3f}")
    print(f"Context Precision:  {scores['context_precision']:.3f}")
    print(f"Answer Correctness: {scores['answer_correctness']:.3f}")

    return scores
```

### Setting Regression Thresholds

Every score needs a threshold that, when breached, blocks the deploy. These are not absolute values — they are relative to your baseline. Establish your baseline on the first eval run and define thresholds as deltas from it.

```python
# thresholds.json — committed to the repository, updated intentionally
EVAL_THRESHOLDS = {
    "faithfulness":      {"min_absolute": 0.80, "max_regression": 0.05},
    "answer_relevancy":  {"min_absolute": 0.75, "max_regression": 0.05},
    "context_precision": {"min_absolute": 0.70, "max_regression": 0.08},
    "answer_correctness":{"min_absolute": 0.70, "max_regression": 0.05},
}

def check_thresholds(scores: dict, thresholds: dict, baseline: dict) -> list[str]:
    """Return list of failure reasons. Empty list = all checks passed."""
    failures = []

    for metric, score in scores.items():
        t = thresholds[metric]
        b = baseline.get(metric)

        if score < t["min_absolute"]:
            failures.append(
                f"{metric}: {score:.3f} below minimum threshold {t['min_absolute']}"
            )
        if b is not None and (b - score) > t["max_regression"]:
            failures.append(
                f"{metric}: {score:.3f} regressed {b - score:.3f} from baseline {b:.3f} "
                f"(max allowed: {t['max_regression']})"
            )

    return failures
```

---

## 5. Building and Maintaining Your Golden Dataset

The eval pipeline is only as good as the dataset it runs against. A golden dataset is your ground truth: a curated set of questions, expected context sources, and reference answers that represents the full range of real user queries your system must handle.

### Minimum Viable Golden Dataset

For a RAG system going to production, 100 records is the minimum. Fewer than that and your regression detection has too little statistical power — a 5-point score drop on 20 examples is noise; on 100 examples it is signal.

Distribute records across:

- Query types (factual lookup, multi-hop reasoning, summarization, comparison)
- Difficulty tiers (direct answer in single chunk, requires synthesis across chunks, edge cases where context is insufficient)
- Domain coverage (all major topic areas your corpus covers)

### Synthetic Dataset Generation (with Human Curation)

Generating ground truth manually at scale is impractical. Use an LLM to generate candidate questions and reference answers from your document corpus, then have a human review and curate them. The LLM accelerates — the human validates.

```python
DATASET_GENERATION_PROMPT = """You are creating an evaluation dataset for a RAG system.

Given the following document chunk, generate {n_questions} questions that a real user might ask,
along with the reference answer grounded strictly in this chunk.

For each question:
- Make it a natural question a real user would ask (not academic)
- Vary the question types: direct lookup, inference requiring, edge cases
- The reference answer must be directly traceable to the chunk text

Document chunk:
{chunk_text}

Source: {source_id}

Respond ONLY with valid JSON:
{{
  "questions": [
    {{
      "question": "...",
      "ground_truth_answer": "...",
      "source_chunk_id": "{source_id}",
      "difficulty": "easy|medium|hard",
      "query_type": "factual|inferential|edge_case"
    }}
  ]
}}"""

async def generate_eval_candidates(
    chunk: dict,
    n_questions: int = 3
) -> list[dict]:
    prompt = DATASET_GENERATION_PROMPT.format(
        chunk_text=chunk["text"],
        source_id=chunk["id"],
        n_questions=n_questions
    )

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}]
    )

    raw = response.content[0].text.strip()
    parsed = json.loads(raw)
    return parsed["questions"]
```

### Dataset Versioning

Your golden dataset must be versioned. When you add new questions, update reference answers for document changes, or remove stale questions, those changes must be tracked — not overwritten.

```text
eval/
├── golden_dataset_v1.jsonl     # initial baseline, never deleted
├── golden_dataset_v2.jsonl     # added coverage for new product area
├── golden_dataset_current.jsonl  # symlink to active version
└── changelog.md                # what changed between versions and why
```

When the dataset changes, the baseline scores must be re-established. A score drop after a dataset expansion is expected — you may have added harder questions — and should not trigger a regression alert. Track dataset version alongside scores in your eval history.

```python
@dataclass
class EvalRecord:
    run_id: str
    timestamp: str
    git_commit: str
    dataset_version: str          # critical — scores are only comparable within version
    scores: dict[str, float]
    threshold_failures: list[str]
    passed: bool
```

---

## 6. Wiring Evals into CI/CD — GitHub Actions Pipeline

The eval pipeline needs to run automatically on every pull request that touches anything that could affect generation quality: prompt changes, embedding model configuration, re-ranker swap, chunking strategy, LLM model version, or the RAG system prompt.

```yaml
# .github/workflows/llm-eval.yml

name: LLM Quality Evaluation

on:
  pull_request:
    paths:
      - 'src/rag/**'           # retrieval and generation pipeline
      - 'prompts/**'           # system prompts
      - 'config/models.yaml'   # model configuration
      - 'eval/**'              # eval dataset changes trigger re-baseline check

jobs:
  llm-eval:
    runs-on: ubuntu-latest
    timeout-minutes: 30        # eval pipelines must be time-boxed

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: pip install -r requirements-eval.txt

      - name: Run RAG pipeline against golden dataset
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          VECTOR_STORE_URL: ${{ secrets.EVAL_VECTOR_STORE_URL }}
        run: |
          python eval/run_pipeline.py \
            --dataset eval/golden_dataset_current.jsonl \
            --output eval/results/pr-${{ github.event.pull_request.number }}.json

      - name: Run RAGAS evaluation
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          python eval/run_ragas.py \
            --input eval/results/pr-${{ github.event.pull_request.number }}.json \
            --baseline eval/baseline/current_baseline.json \
            --thresholds eval/thresholds.json \
            --output eval/results/scores-${{ github.event.pull_request.number }}.json

      - name: Check thresholds and post PR comment
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const scores = JSON.parse(
              fs.readFileSync(`eval/results/scores-${{ github.event.pull_request.number }}.json`)
            );

            const passed = scores.threshold_failures.length === 0;
            const emoji = passed ? '✅' : '❌';

            const body = `## ${emoji} LLM Eval Results

            | Metric | Score | Baseline | Status |
            |--------|-------|----------|--------|
            | Faithfulness | ${scores.faithfulness.toFixed(3)} | ${scores.baseline.faithfulness.toFixed(3)} | ${scores.faithfulness >= scores.thresholds.faithfulness.min_absolute ? '✅' : '❌'} |
            | Answer Relevancy | ${scores.answer_relevancy.toFixed(3)} | ${scores.baseline.answer_relevancy.toFixed(3)} | ${scores.answer_relevancy >= scores.thresholds.answer_relevancy.min_absolute ? '✅' : '❌'} |
            | Context Precision | ${scores.context_precision.toFixed(3)} | ${scores.baseline.context_precision.toFixed(3)} | ${scores.context_precision >= scores.thresholds.context_precision.min_absolute ? '✅' : '❌'} |
            | Answer Correctness | ${scores.answer_correctness.toFixed(3)} | ${scores.baseline.answer_correctness.toFixed(3)} | ${scores.answer_correctness >= scores.thresholds.answer_correctness.min_absolute ? '✅' : '❌'} |

            ${scores.threshold_failures.length > 0
              ? '**Failures:**\n' + scores.threshold_failures.map(f => `- ${f}`).join('\n')
              : '**All thresholds passed.**'
            }

            Dataset: \`${scores.dataset_version}\` | Commit: \`${{ github.sha }}\``;

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            });

            if (!passed) {
              core.setFailed('LLM quality evaluation failed. See PR comment for details.');
            }

      - name: Upload eval artifacts
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: eval-results-pr-${{ github.event.pull_request.number }}
          path: eval/results/
          retention-days: 30
```

### The Eval Runner

The pipeline above calls two scripts. The first runs your actual RAG pipeline against every question in the golden dataset and captures what the system produced — questions, retrieved contexts, and generated answers:

```python
# eval/run_pipeline.py
import argparse
import json
import asyncio
from pathlib import Path
from src.rag.pipeline import RAGPipeline

async def main(dataset_path: str, output_path: str):
    pipeline = RAGPipeline.from_config("config/models.yaml")
    records = []

    with open(dataset_path) as f:
        eval_items = [json.loads(line) for line in f]

    for item in eval_items:
        result = await pipeline.run(item["question"])
        records.append({
            "question": item["question"],
            "ground_truth": item["ground_truth_answer"],
            "contexts": [c["text"] for c in result.retrieved_chunks],
            "answer": result.generated_answer,
            "source_chunk_ids": [c["id"] for c in result.retrieved_chunks],
            "had_sufficient_context": result.had_sufficient_context,
            "retrieval_mode": result.retrieval_mode,
        })

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(records, f, indent=2)

    print(f"Ran pipeline on {len(records)} eval items → {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.dataset, args.output))
```

### Managing Eval Cost

Running RAGAS on 100 questions uses approximately 200–400 LLM calls (each metric makes multiple judge calls per question). At Claude Sonnet pricing, a full eval run costs roughly $0.50–$2.00. That is acceptable for a pre-deploy gate — but you should not run the full suite on every commit.

A practical cost-tiering strategy:

```yaml
on:
  pull_request:
    paths: ['src/rag/**', 'prompts/**', 'config/models.yaml']
  # Run full eval nightly regardless of changes
  schedule:
    - cron: '0 2 * * *'   # 2 AM UTC daily
```

On PRs: run faithfulness and answer relevance only (the two metrics that do not require ground truth and are cheapest to compute). On nightly schedule: run the full four-metric suite against the golden dataset and update the baseline if the main branch scores have shifted.

---

## 7. Eval Observability — Tracking Quality Over Time

CI eval tells you whether a specific change broke something. Production sampling tells you whether the system is drifting over time in ways no single change caused — corpus staleness, query distribution shift, or gradual model behavior change.

### Online Sampling Pipeline

Sample a fraction of production traffic for async evaluation. Do not evaluate synchronously — LLM-as-Judge calls add 2–5 seconds per request, which is unacceptable on the critical path.

```python
import asyncio
from dataclasses import dataclass
import random

@dataclass
class ProductionSample:
    request_id: str
    question: str
    contexts: list[str]
    answer: str
    timestamp: str

async def sample_for_evaluation(
    request: ProductionSample,
    sample_rate: float = 0.05   # evaluate 5% of production traffic
) -> None:
    """
    Push to async evaluation queue. Never called synchronously.
    """
    if random.random() > sample_rate:
        return

    await eval_queue.put(request)   # non-blocking; queue worker handles evaluation

async def eval_queue_worker():
    """Background worker — runs continuously, consumes from the queue."""
    while True:
        sample = await eval_queue.get()
        try:
            scores = await run_faithfulness_and_relevance(sample)
            await metrics_store.record({
                "request_id": sample.request_id,
                "timestamp": sample.timestamp,
                "faithfulness": scores["faithfulness"],
                "answer_relevancy": scores["answer_relevancy"],
            })
        except Exception as e:
            logger.error({"event": "eval_worker_error", "error": str(e)})
        finally:
            eval_queue.task_done()
```

### Metrics to Alert On in Production

| Signal | Alert Condition | Interpretation |
| --- | --- | --- |
| 7-day rolling faithfulness | Drops > 0.05 from monthly baseline | Prompt drift, corpus contamination, model update |
| 7-day rolling answer relevancy | Drops > 0.05 | Query distribution shift, retrieval degradation |
| `had_sufficient_context` rate | Falls below 80% | Corpus gap or retrieval regression |
| Faithfulness variance | Spikes week-over-week | Inconsistent chunking or stale embeddings |
| Eval p99 latency | Grows > 500ms | Judge model rate limiting or quota pressure |

### Dashboard Schema

Store eval scores in a time-series-friendly schema for trending:

```sql
CREATE TABLE eval_scores (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source          TEXT NOT NULL,  -- 'ci_pipeline' | 'production_sample' | 'nightly_run'
    git_commit      TEXT,
    dataset_version TEXT,
    question_hash   TEXT NOT NULL,  -- for deduplication and per-question trending
    faithfulness    FLOAT,
    answer_relevancy FLOAT,
    context_precision FLOAT,
    answer_correctness FLOAT,
    had_sufficient_context BOOLEAN,
    retrieval_mode  TEXT            -- 'hybrid' | 'bm25_fallback'
);

-- Index for time-series queries
CREATE INDEX idx_eval_scores_time ON eval_scores (recorded_at DESC);
CREATE INDEX idx_eval_scores_source ON eval_scores (source, recorded_at DESC);
```

---

## 8. Failure Modes in Eval Systems

Eval infrastructure has its own failure modes. These are the ones that silently invalidate your results.

### Dataset Contamination

If your eval questions are generated from the same document corpus that is indexed in your vector store, the system has an unfair advantage — it will retrieve the exact source documents for every eval query, inflating all scores. Maintain a held-out eval corpus: a subset of documents never indexed in production, used exclusively for generating eval questions.

### Judge Model Drift

As noted in Section 3, judge model behavior changes across API versions. A scoring baseline established with one model version is not comparable to scores established with a different version. When Anthropic or OpenAI ships a model update:

1. Run your golden dataset against both the old and new judge model versions
2. Quantify the score shift
3. Update your baseline to the new model's scores before using it for regression detection
4. Record the baseline reset in your changelog

### Latency Creep in the Eval Pipeline

RAGAS evaluation is IO-bound — most of the time is waiting on LLM API responses. As your golden dataset grows and your eval metrics expand, the CI pipeline will slow down. The moment eval takes longer than 15 minutes in CI, engineers start skipping it.

Enforce a hard time budget:

```python
async def run_eval_with_timeout(
    eval_records: list[dict],
    timeout_seconds: int = 600   # 10 minutes — fail the pipeline if exceeded
) -> dict:
    try:
        return await asyncio.wait_for(
            run_ragas_evaluation_async(eval_records),
            timeout=timeout_seconds
        )
    except asyncio.TimeoutError:
        raise RuntimeError(
            f"Eval pipeline exceeded {timeout_seconds}s time budget. "
            "Reduce dataset size, parallelize judge calls, or increase timeout."
        )
```

### Gaming the Eval

A subtler failure mode: optimizing the RAG system specifically against the golden dataset rather than against real user behavior. If your prompt engineers know the exact eval questions and tune the system prompt to perform well on them, your eval scores become meaningless.

Mitigate this by keeping a holdout partition of your golden dataset that is never used in CI — only run for quarterly audit evaluations. If CI scores and holdout scores diverge significantly, your system is overfit to the eval set.

---

## The Eval Checklist

Before shipping an LLM system to production — and before every significant change to an existing one:

- [ ] **Golden dataset exists** — minimum 100 curated question/context/answer triples covering the full query distribution
- [ ] **Dataset is versioned** — every change is tracked; baseline resets are recorded
- [ ] **Held-out eval corpus** — a subset of documents never indexed in production, reserved for eval question generation
- [ ] **RAGAS configured** with pinned judge model version — not an alias
- [ ] **Baseline scores established** on main branch before enabling regression detection
- [ ] **Thresholds defined** — both absolute minimums and maximum regression deltas
- [ ] **CI pipeline configured** — faithfulness + answer relevance on every PR touching RAG code or prompts
- [ ] **Nightly full eval** — all four metrics against golden dataset; scores written to metrics store
- [ ] **Production sampling** — async evaluation of 5% of live traffic; dashboard tracking 7-day rolling scores
- [ ] **Alert rules configured** — on rolling score drops and `had_sufficient_context` rate degradation
- [ ] **Judge calibration documented** — Cohen's Kappa against human labels, last calibration date recorded
- [ ] **Holdout partition maintained** — quarterly audit eval to detect dataset overfitting

---

## Closing: Eval Is Not a QA Step — It Is a First-Class System

The instinct is to treat evaluation as a phase — something you do before launch, maybe after a major change, when the team has bandwidth. That instinct is wrong, and it is expensive.

LLM systems do not have a stable, deterministic behavior that stays constant between your last eval run and the user's next query. They drift — through corpus changes, model updates, prompt evolution, and query distribution shift. Evaluation is not a checkpoint you reach. It is continuous infrastructure, running alongside the system it measures.

The teams that get LLM systems right in production are not the ones with the best models or the most sophisticated retrieval pipelines. They are the ones that treated generation quality as a first-class engineering concern from day one — built the eval dataset before optimizing the pipeline, wired the CI gate before the first deploy, and invested in production sampling before they had a quality incident to justify it.

Build the eval system before you need it. By the time you need it, it is already too late to build it from a clean state — you will be debugging a production quality regression with no historical baseline and no automated detection. That is the scenario this entire post exists to prevent.

> **📌 Key Takeaway**
>
> Retrieval metrics tell you whether the right information entered the context window. Generation metrics — faithfulness, answer relevance, context precision, answer correctness — tell you whether the LLM produced an accurate, grounded response from that context. You need both layers evaluated continuously: in CI on every deploy, and via async sampling on production traffic. The eval infrastructure is not optional scaffolding. It is the difference between a system you can confidently ship and one you can only hope is working.

---

*Further Reading: Es et al. — RAGAS: Automated Evaluation of Retrieval Augmented Generation (2023), Zheng et al. — Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena (2023), Anthropic — Claude Model API Documentation, LlamaIndex — Evaluation Modules Documentation, OpenAI — Evals Framework (GitHub)*

{% endraw %}
