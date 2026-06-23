---
title: "Building Reliable RAG Pipelines: From Prototype to Production"
date: 2026-06-04
last_modified_at: 2026-06-04
author: Alok Ranjan Daftuar
description: "A production engineering guide to RAG pipelines — chunking strategies, hybrid retrieval with RRF, re-ranking, context assembly, prompt grounding, retrieval evaluation, observability, and the failure handling that separates a demo from a system."
excerpt: "Most teams get RAG working in a notebook over a weekend. Very few get it working reliably in production. This post covers the full pipeline — chunking strategy, hybrid retrieval, re-ranking, context assembly, prompt construction, retrieval evaluation, production observability, and graceful degradation."
keywords: "RAG pipeline, retrieval augmented generation, vector search, hybrid retrieval, chunking strategy, LLM production, re-ranking, context assembly, AI engineering, observability"
twitter_card: summary_large_image
categories:
  - architecture
  - ai
tags: [ai, rag, vector-search, llm, information-retrieval, architecture, observability, system-design, production, patterns]
series: "RAG and AI Engineering"
series_order: 2
---

> Most teams get RAG working in a notebook over a weekend. Very few get it working reliably in production. The gap between the two is not model quality — it is engineering discipline.

## The Prototype Trap

The RAG prototype is deceptively easy to build. Chunk your documents, embed them, store in a vector database, retrieve on query, stuff into a prompt, call the LLM. Fifty lines of Python. It works. The demo impresses stakeholders. You get sign-off to productionize.

Then production happens.

Users ask questions the prototype never saw. The retrieval surface degrades as the document corpus grows and goes stale. Latency spikes unpredictably. The model confidently answers from the wrong context. Someone asks a question that retrieves six chunks from three different document versions and the LLM synthesizes them into a plausible but entirely incorrect answer — and nobody knows, because there is no instrumentation to catch it.

This is the prototype trap: RAG is easy to build and hard to build *well*. The gap is not the LLM. It is every engineering decision between the user's query and the model's response — retrieval strategy, chunking, context assembly, evaluation, observability, and failure handling. This blog covers all of it.

> **Article context:** The [BM25 vs. Vector Search](/blogs/bm25_vs_vector_search/) post in this series covers the retrieval layer in depth. This post builds on that foundation and covers the full pipeline — from document ingestion through production observability.

### Table of Contents

- [The Prototype Trap](#the-prototype-trap)
- [1. The RAG Pipeline, Component by Component](#1-the-rag-pipeline-component-by-component)
- [2. Chunking Strategy — The Foundation Everything Else Depends On](#2-chunking-strategy--the-foundation-everything-else-depends-on)
- [3. Retrieval — Hybrid Is the Default, Not the Exception](#3-retrieval--hybrid-is-the-default-not-the-exception)
- [4. Context Assembly — Where Pipelines Quietly Break](#4-context-assembly--where-pipelines-quietly-break)
- [5. Prompt Construction — Grounding and Guardrails](#5-prompt-construction--grounding-and-guardrails)
- [6. Evaluating Retrieval Quality — Measuring Before Blaming the Model](#6-evaluating-retrieval-quality--measuring-before-blaming-the-model)
- [7. Production Observability — What to Instrument](#7-production-observability--what-to-instrument)
- [8. Failure Handling — Designing for Partial Retrieval](#8-failure-handling--designing-for-partial-retrieval)
- [The Production RAG Checklist](#the-production-rag-checklist)
- [Closing: Retrieval Is the Product](#closing-retrieval-is-the-product)

---

## 1. The RAG Pipeline, Component by Component

Before addressing reliability, establish a clear mental model of every stage in the pipeline. Each is an independent failure surface.

```text
Document Corpus
      │
      ▼
[1] Ingestion & Chunking
      │  split, clean, normalize
      ▼
[2] Embedding
      │  model: text-embedding-3-large / e5-large / domain-specific
      ▼
[3] Vector Store
      │  HNSW index, metadata filters, namespace isolation
      ▼
      │◄─────────────────────── User Query
      ▼
[4] Retrieval
      │  hybrid: BM25 + vector, RRF merge
      ▼
[5] Re-ranking
      │  cross-encoder, top-K selection
      ▼
[6] Context Assembly
      │  deduplication, ordering, token budget management
      ▼
[7] Prompt Construction
      │  system prompt, grounding instructions, context injection
      ▼
[8] LLM Generation
      │  claude-sonnet / gpt-4o / gemini-pro
      ▼
[9] Output Validation
      │  hallucination detection, citation verification, guardrails
      ▼
     Response
```

Every arrow in this diagram is a potential failure point. Most production RAG failures are not model failures — they are retrieval failures, chunking failures, or context assembly failures that the model then faithfully converts into a confident wrong answer.

---

## 2. Chunking Strategy — The Foundation Everything Else Depends On

Chunking is the most underrated decision in a RAG pipeline. A poor chunking strategy cannot be compensated for downstream. If the relevant information is split across two chunks, or diluted into a chunk so large the signal is lost, no retrieval algorithm or re-ranker will recover it.

### The Three Chunking Approaches

**Fixed-size chunking** splits on token count with overlap. Simple, predictable, and wrong at the boundary in ways that are hard to detect. A sentence split across two chunks produces two semantically incomplete embeddings that neither matches a reasonable query well.

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=512,        # tokens per chunk
    chunk_overlap=64,      # overlap to avoid hard boundary cuts
    separators=["\n\n", "\n", ". ", " ", ""]  # prefer paragraph breaks
)

chunks = splitter.split_text(document_text)
```

**Semantic chunking** splits on natural boundaries — paragraphs, section headers, sentence groups — preserving coherent units of meaning. Higher quality embeddings, more complex implementation.

```python
from langchain_experimental.text_splitter import SemanticChunker
from langchain_openai import OpenAIEmbeddings

semantic_splitter = SemanticChunker(
    embeddings=OpenAIEmbeddings(model="text-embedding-3-large"),
    breakpoint_threshold_type="percentile",
    breakpoint_threshold_amount=90  # split when similarity drops below 90th percentile
)

chunks = semantic_splitter.split_text(document_text)
```

**Hierarchical chunking** — the production-grade pattern — maintains both parent chunks (full sections) and child chunks (individual sentences or short paragraphs). Retrieve at the child level for precision; return the parent chunk as LLM context for completeness.

```python
class HierarchicalChunker:
    def __init__(self, parent_chunk_size=1024, child_chunk_size=256, overlap=32):
        self.parent_splitter = RecursiveCharacterTextSplitter(
            chunk_size=parent_chunk_size, chunk_overlap=overlap
        )
        self.child_splitter = RecursiveCharacterTextSplitter(
            chunk_size=child_chunk_size, chunk_overlap=overlap
        )

    def chunk(self, document: dict) -> list[dict]:
        parent_chunks = self.parent_splitter.split_text(document["content"])
        result = []

        for p_idx, parent_text in enumerate(parent_chunks):
            parent_id = f"{document['id']}::parent::{p_idx}"
            child_chunks = self.child_splitter.split_text(parent_text)

            for c_idx, child_text in enumerate(child_chunks):
                result.append({
                    "id": f"{parent_id}::child::{c_idx}",
                    "text": child_text,
                    "parent_id": parent_id,
                    "parent_text": parent_text,   # stored as metadata, not embedded
                    "metadata": document["metadata"]
                })

        return result
```

**The rule:** embed at child granularity for retrieval precision. Return parent text as LLM context for answer quality. Never embed and return at the same granularity if your documents are longer than 300 tokens.

### Metadata Is Not Optional

Every chunk must carry metadata that enables filtering, debugging, and citation:

```python
{
    "id": "doc-447::parent::3::child::1",
    "text": "The refund policy applies to purchases made within 30 days...",
    "source_document_id": "policy-v4.2",
    "source_url": "https://docs.internal/policy/refunds",
    "document_version": "4.2",
    "section": "Refund Policy",
    "last_updated": "2026-01-15",
    "content_hash": "sha256:abc123...",   # for staleness detection
    "embedding_model": "text-embedding-3-large",
    "embedding_model_version": "2024-02"
}
```

`content_hash` and `embedding_model_version` are operational metadata — not for retrieval, but for knowing when a chunk needs to be re-embedded because the source document changed or the embedding model was upgraded.

---

## 3. Retrieval — Hybrid Is the Default, Not the Exception

As covered in the BM25 vs. Vector Search post, neither retrieval strategy is universally superior. In production RAG pipelines, hybrid retrieval is the baseline — not an optimization.

### Hybrid Retrieval with RRF

```python
from qdrant_client import QdrantClient
from qdrant_client.models import SparseVector, NamedVector, NamedSparseVector

async def hybrid_retrieve(
    query: str,
    collection: str,
    top_k: int = 20,
    rrf_k: int = 60
) -> list[dict]:

    # Dense retrieval — semantic similarity
    query_embedding = await embed(query)
    dense_results = qdrant.search(
        collection_name=collection,
        query_vector=NamedVector(name="dense", vector=query_embedding),
        limit=top_k
    )

    # Sparse retrieval — BM25-style keyword matching
    sparse_query = bm25_encoder.encode_queries(query)
    sparse_results = qdrant.search(
        collection_name=collection,
        query_vector=NamedSparseVector(
            name="sparse",
            vector=SparseVector(
                indices=sparse_query.indices.tolist(),
                values=sparse_query.values.tolist()
            )
        ),
        limit=top_k
    )

    # Reciprocal Rank Fusion
    return rrf_merge(dense_results, sparse_results, k=rrf_k)

def rrf_merge(list_a: list, list_b: list, k: int = 60) -> list[dict]:
    scores = {}
    for rank, result in enumerate(list_a):
        scores[result.id] = scores.get(result.id, 0) + 1 / (k + rank + 1)
    for rank, result in enumerate(list_b):
        scores[result.id] = scores.get(result.id, 0) + 1 / (k + rank + 1)

    sorted_ids = sorted(scores, key=scores.get, reverse=True)
    id_to_result = {r.id: r for r in list_a + list_b}
    return [id_to_result[id] for id in sorted_ids if id in id_to_result]
```

### Re-ranking — The Precision Layer

Initial retrieval (top-20) optimizes for recall. The re-ranker optimizes for precision. A cross-encoder processes the query and each candidate document jointly, producing a far more accurate relevance score at higher compute cost.

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")

def rerank(query: str, candidates: list[dict], top_n: int = 5) -> list[dict]:
    pairs = [(query, c["text"]) for c in candidates]
    scores = reranker.predict(pairs)

    ranked = sorted(
        zip(candidates, scores),
        key=lambda x: x[1],
        reverse=True
    )

    return [doc for doc, score in ranked[:top_n]]
```

For production at scale, Cohere's Rerank API offloads the cross-encoder inference and provides managed scaling:

```python
import cohere

co = cohere.Client(api_key=os.environ["COHERE_API_KEY"])

def rerank_with_cohere(query: str, candidates: list[dict], top_n: int = 5) -> list[dict]:
    results = co.rerank(
        model="rerank-english-v3.0",
        query=query,
        documents=[c["text"] for c in candidates],
        top_n=top_n
    )
    return [candidates[r.index] for r in results.results]
```

---

## 4. Context Assembly — Where Pipelines Quietly Break

Retrieval gives you a ranked list of relevant chunks. Context assembly turns that list into the input the LLM actually receives. This stage has more failure modes than any other.

### Token Budget Management

Every LLM has a context window limit. Your context assembly must respect it deterministically — not hope that the top-5 chunks fit.

```python
import tiktoken

def assemble_context(
    chunks: list[dict],
    model: str = "claude-sonnet-4-20250514",
    max_context_tokens: int = 6000  # reserve headroom for prompt + response
) -> tuple[str, list[dict]]:

    encoder = tiktoken.encoding_for_model("gpt-4")  # approximate for token counting
    included_chunks = []
    total_tokens = 0
    context_parts = []

    for chunk in chunks:
        chunk_tokens = len(encoder.encode(chunk["text"]))
        if total_tokens + chunk_tokens > max_context_tokens:
            break  # hard stop — never exceed budget

        context_parts.append(
            f"[Source: {chunk['metadata']['source_document_id']}, "
            f"Section: {chunk['metadata']['section']}]\n"
            f"{chunk['text']}"
        )
        included_chunks.append(chunk)
        total_tokens += chunk_tokens

    return "\n\n---\n\n".join(context_parts), included_chunks
```

### Deduplication

Hierarchical chunking and hybrid retrieval can surface the same content via multiple paths — the same parent chunk returned through dense and sparse retrieval, or two child chunks from the same parent. Deduplicate before assembly:

```python
def deduplicate_chunks(chunks: list[dict]) -> list[dict]:
    seen_parents = set()
    seen_content_hashes = set()
    deduplicated = []

    for chunk in chunks:
        parent_id = chunk["metadata"].get("parent_id")
        content_hash = chunk["metadata"].get("content_hash")

        # Skip if we already have a chunk from this parent
        if parent_id and parent_id in seen_parents:
            continue
        # Skip exact duplicates
        if content_hash and content_hash in seen_content_hashes:
            continue

        if parent_id:
            seen_parents.add(parent_id)
        if content_hash:
            seen_content_hashes.add(content_hash)

        deduplicated.append(chunk)

    return deduplicated
```

---

## 5. Prompt Construction — Grounding and Guardrails

The system prompt for a RAG pipeline has one job above all others: instruct the model to answer *only* from the provided context and to explicitly acknowledge when the context does not contain the answer.

```python
RAG_SYSTEM_PROMPT = """You are a precise technical assistant. Answer the user's 
question using ONLY the information provided in the context sections below.

Rules:
- If the context does not contain sufficient information to answer the question,
  respond with: "I don't have enough information in the provided context to 
  answer this question accurately."
- Do not use prior knowledge or make inferences beyond what the context states.
- Cite the source document for every factual claim using [Source: <document_id>].
- If context sections conflict with each other, note the conflict explicitly 
  rather than arbitrarily choosing one.

Context:
{context}
"""

def build_prompt(query: str, context: str) -> list[dict]:
    return [
        {
            "role": "user",
            "content": RAG_SYSTEM_PROMPT.format(context=context) + f"\n\nQuestion: {query}"
        }
    ]
```

The "I don't know" instruction is not optional. Without it, LLMs will fill context gaps with plausible hallucinations. The conflict acknowledgment instruction is equally important — when document versions overlap in your corpus, the model should surface the ambiguity, not silently resolve it.

---

## 6. Evaluating Retrieval Quality — Measuring Before Blaming the Model

The most common mistake in RAG debugging is assuming a bad answer is a generation failure. In practice, the majority of bad RAG answers are **retrieval failures** — the right chunk was not in the context, or the wrong chunks were. You cannot improve what you do not measure.

### The Three Retrieval Metrics That Matter

**Recall@K** — of all the relevant documents for a query, what fraction appear in the top-K retrieved results? This is your primary retrieval health metric.

```python
def recall_at_k(retrieved_ids: list[str], relevant_ids: list[str], k: int) -> float:
    top_k = set(retrieved_ids[:k])
    relevant = set(relevant_ids)
    if not relevant:
        return 0.0
    return len(top_k & relevant) / len(relevant)
```

**Mean Reciprocal Rank (MRR)** — how high does the first relevant result rank? An MRR of 1.0 means the top result is always relevant. An MRR of 0.2 means the first relevant result is typically ranked fifth.

```python
def mean_reciprocal_rank(retrieved_ids: list[str], relevant_ids: list[str]) -> float:
    relevant = set(relevant_ids)
    for rank, doc_id in enumerate(retrieved_ids, start=1):
        if doc_id in relevant:
            return 1.0 / rank
    return 0.0
```

**Context Relevance** — of the chunks assembled into the LLM context, what fraction are actually relevant to the query? Low context relevance means you are filling the context window with noise, which degrades generation quality.

### Building an Evaluation Dataset

You cannot evaluate retrieval without a ground truth dataset. The minimum viable evaluation set:

- 50–100 representative queries covering your main use cases
- For each query: the expected source documents and relevant chunk IDs
- Run retrieval against this set weekly and track Recall@K and MRR over time

Use an LLM to accelerate ground truth creation — generate synthetic queries from your document corpus, then have a human review and curate them. This is not fully automated; human curation is non-negotiable for a trustworthy eval set.

---

## 7. Production Observability — What to Instrument

A RAG pipeline without observability is a black box that will silently degrade. These are the signals that matter:

### Per-Request Tracing

Every request should produce a structured trace capturing the full pipeline state:

```typescript
interface RAGTrace {
  requestId: string;
  query: string;
  queryEmbeddingMs: number;

  // Retrieval
  denseResultCount: number;
  sparseResultCount: number;
  rrfMergedCount: number;
  rerankTopN: number;
  retrievalMs: number;

  // Context assembly
  chunksIncluded: number;
  chunksDropped: number;         // dropped due to token budget
  contextTokens: number;
  deduplicatedCount: number;

  // Generation
  llmModel: string;
  promptTokens: number;
  completionTokens: number;
  generationMs: number;
  totalMs: number;

  // Quality signals
  sourceDocumentIds: string[];
  contextRelevanceScore?: number;  // from a lightweight eval model
  hadSufficientContext: boolean;   // did the model say "I don't know"?
}
```

### Aggregate Metrics to Alert On

| Metric | Alert Condition | What It Signals |
| --- | --- | --- |
| `hadSufficientContext` rate | Drops below 80% | Retrieval degradation or corpus gap |
| `chunksDropped` rate | Rises above 20% | Context window pressure; re-examine chunking |
| `retrievalMs` p99 | Exceeds SLA threshold | Vector index performance degradation |
| `contextRelevanceScore` avg | Drops week-over-week | Corpus staleness or embedding model drift |
| Re-embed queue depth | Grows unbounded | Document update pipeline falling behind |

### Corpus Staleness Detection

Your vector index goes stale the moment a source document changes. Track `content_hash` per chunk and run a periodic staleness job:

```python
async def detect_stale_chunks(
    vector_store: VectorStore,
    document_store: DocumentStore
) -> list[str]:
    """Return chunk IDs whose source document has changed since last embedding."""
    stale_chunk_ids = []

    async for chunk in vector_store.scroll_all():
        source_id = chunk.metadata["source_document_id"]
        stored_hash = chunk.metadata["content_hash"]

        current_doc = await document_store.get(source_id)
        current_hash = hash_content(current_doc.content)

        if current_hash != stored_hash:
            stale_chunk_ids.append(chunk.id)

    return stale_chunk_ids
```

Stale chunks are not just a quality problem — they are a trust problem. A RAG system that cites an outdated policy document as if it were current is worse than one that says "I don't know."

---

## 8. Failure Handling — Designing for Partial Retrieval

A production RAG pipeline must degrade gracefully, not fail completely, when components are unavailable.

```python
async def retrieve_with_fallback(
    query: str,
    vector_store: VectorStore,
    bm25_index: BM25Index
) -> tuple[list[dict], str]:
    """
    Attempt hybrid retrieval. Fall back to BM25-only if vector store
    is unavailable. Return retrieval mode used for observability.
    """
    try:
        results = await hybrid_retrieve(query, vector_store, bm25_index)
        return results, "hybrid"
    except VectorStoreUnavailableError:
        logger.warning({
            "event": "vector_store_unavailable",
            "fallback": "bm25_only",
            "query_hash": hash(query)
        })
        results = bm25_index.search(query, top_k=20)
        return results, "bm25_fallback"
    except Exception as e:
        logger.error({"event": "retrieval_failure", "error": str(e)})
        raise
```

Surface the retrieval mode in your response metadata so downstream monitoring can distinguish hybrid results from degraded fallback results. A sustained spike in `bm25_fallback` mode is a signal that the vector store needs attention — not something that should silently blend into your metrics.

---

## The Production RAG Checklist

Before a RAG pipeline goes to production:

- [ ] **Chunking strategy validated** on a representative sample — no critical information lost at chunk boundaries
- [ ] **Hierarchical chunks implemented** — retrieve at child granularity, return parent as context
- [ ] **Metadata complete** on every chunk — source ID, version, content hash, embedding model version
- [ ] **Hybrid retrieval configured** — BM25 + vector with RRF merge; pure vector search is not the default
- [ ] **Re-ranker in place** — cross-encoder precision pass before context assembly
- [ ] **Token budget enforced** — context assembly has a hard token ceiling, never relying on hope
- [ ] **Deduplication implemented** — same content cannot enter the context window twice
- [ ] **System prompt has "I don't know" instruction** — model must not hallucinate when context is insufficient
- [ ] **Evaluation dataset exists** — minimum 50 query/answer/source triples; Recall@K and MRR tracked
- [ ] **Per-request tracing instrumented** — full pipeline state captured for every request
- [ ] **Staleness detection running** — stale chunks are flagged and re-embedded on a defined cadence
- [ ] **Graceful degradation implemented** — vector store unavailability falls back to BM25, not a 500 error

---

## Closing: Retrieval Is the Product

In a RAG system, the LLM is a formatting and synthesis layer. The product is the retrieval pipeline. Get retrieval right and a capable model will produce good answers. Get retrieval wrong and the best model in the world will confidently synthesize garbage from bad context.

The investment is in chunking strategy, hybrid retrieval, re-ranking, context assembly discipline, and — most critically — an evaluation framework that measures retrieval quality independently before you ever look at the generated answer. Most teams skip the evaluation step and spend months tuning prompts to compensate for a retrieval problem they never diagnosed.

Build the eval set first. Measure Recall@K before you touch the system prompt. Fix retrieval before you blame the model.

> **📌 Key Takeaway**
>
> The gap between a RAG prototype and a production RAG system is not the LLM — it is every engineering decision between the user's query and the model's context window. Chunking strategy, hybrid retrieval, re-ranking, token budget management, and retrieval evaluation are not optimizations. They are the foundation. Build them before you ship.

---

*Further Reading: Karpukhin et al. — Dense Passage Retrieval for Open-Domain QA (2020), Lewis et al. — Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (2020), Cormack et al. — Reciprocal Rank Fusion (2009), LlamaIndex Documentation — Parent Document Retriever, Anthropic — Prompt Engineering Guide*
