"""
rag_engine.py

The core of the RAG pipeline:
  1. Chunk document text into overlapping windows.
  2. Embed chunks locally with sentence-transformers (no API cost/latency).
  3. Store/query embeddings in a persistent ChromaDB collection.
  4. Build a grounded prompt from retrieved chunks and call Groq for the answer.

Kept as plain functions (not a class) because there is only ever one
embedding model / one Chroma collection per process — a singleton class
would just add ceremony around the same module-level state.
"""

import os
import uuid
from pathlib import Path

import chromadb
from chromadb.config import Settings
from sentence_transformers import SentenceTransformer
from groq import Groq, APIStatusError, APIConnectionError, APITimeoutError

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BACKEND_DIR = Path(__file__).resolve().parent
CHROMA_PATH = BACKEND_DIR / "chroma_db"
COLLECTION_NAME = "documents"

EMBEDDING_MODEL_NAME = "all-MiniLM-L6-v2"

# Word-based approximation of "~500 tokens with ~50 token overlap".
# We avoid a tokenizer dependency (tiktoken/etc.) purely for chunking —
# 1 token is roughly 0.75 words in English, so 500 tokens ≈ 375 words.
# Rounding up slightly keeps chunks from being too small.
CHUNK_SIZE_WORDS = 400
CHUNK_OVERLAP_WORDS = 40

TOP_K = 4
MAX_HISTORY_TURNS = 6  # keep last N user/assistant turn *pairs*

PRIMARY_MODEL = "llama-3.3-70b-versatile"
FALLBACK_MODEL = "llama-3.1-8b-instant"

SYSTEM_PROMPT = (
    "You are a helpful assistant that answers questions strictly using the "
    "provided document excerpts (context). Rules:\n"
    "1. Only use information found in the context below to answer.\n"
    "2. If the context does not contain the answer, respond exactly with: "
    "\"I don't have that information in the uploaded documents.\"\n"
    "3. Do not use outside knowledge, even if you know the answer.\n"
    "4. When you answer, be concise and cite the source filename(s) you used.\n"
    "5. Conversation history is provided only to help interpret follow-up "
    "questions (e.g. resolving 'it' or 'that') — it never overrides the "
    "document context."
)

# ---------------------------------------------------------------------------
# Lazy singletons — the embedding model and Chroma client are expensive to
# create, so we build them once on first use rather than at import time
# (keeps module import fast, e.g. for tests).
# ---------------------------------------------------------------------------

_embedding_model = None
_chroma_client = None
_collection = None
_groq_client = None


def get_embedding_model() -> SentenceTransformer:
    global _embedding_model
    if _embedding_model is None:
        _embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME)
    return _embedding_model


def get_collection():
    global _chroma_client, _collection
    if _collection is None:
        CHROMA_PATH.mkdir(parents=True, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(
            path=str(CHROMA_PATH),
            settings=Settings(anonymized_telemetry=False),
        )
        _collection = _chroma_client.get_or_create_collection(name=COLLECTION_NAME)
    return _collection


def get_groq_client() -> Groq:
    global _groq_client
    if _groq_client is None:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GROQ_API_KEY is not set. Copy .env.example to .env and add your key."
            )
        _groq_client = Groq(api_key=api_key)
    return _groq_client


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE_WORDS,
               overlap: int = CHUNK_OVERLAP_WORDS) -> list[str]:
    """
    Split text into overlapping word-count windows.

    Overlap prevents context from being lost when a fact is split exactly
    at a chunk boundary — the sentence containing it will fully appear in
    at least one chunk.
    """
    words = text.split()
    if not words:
        return []

    chunks = []
    start = 0
    step = max(chunk_size - overlap, 1)  # guard against overlap >= chunk_size
    while start < len(words):
        chunk_words = words[start:start + chunk_size]
        chunks.append(" ".join(chunk_words))
        if start + chunk_size >= len(words):
            break
        start += step
    return chunks


# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------

def add_document(filename: str, text: str) -> int:
    """
    Chunk, embed, and store a document's text in ChromaDB.
    Returns the number of chunks stored.
    """
    chunks = chunk_text(text)
    if not chunks:
        return 0

    model = get_embedding_model()
    embeddings = model.encode(chunks, show_progress_bar=False).tolist()

    ids = [f"{filename}::{uuid.uuid4().hex[:8]}::{i}" for i in range(len(chunks))]
    metadatas = [{"source": filename, "chunk_index": i} for i in range(len(chunks))]

    collection = get_collection()
    collection.add(ids=ids, embeddings=embeddings, documents=chunks, metadatas=metadatas)
    return len(chunks)


def list_documents() -> list[dict]:
    """Return each indexed source filename with its chunk count."""
    collection = get_collection()
    data = collection.get(include=["metadatas"])
    counts: dict[str, int] = {}
    for meta in data["metadatas"]:
        source = meta["source"]
        counts[source] = counts.get(source, 0) + 1
    return [{"filename": name, "chunks": count} for name, count in sorted(counts.items())]


def delete_document(filename: str) -> int:
    """Remove all chunks belonging to a source file. Returns count removed."""
    collection = get_collection()
    existing = collection.get(where={"source": filename}, include=[])
    ids = existing["ids"]
    if ids:
        collection.delete(ids=ids)
    return len(ids)


# ---------------------------------------------------------------------------
# Retrieval + generation
# ---------------------------------------------------------------------------

def retrieve(query: str, k: int = TOP_K) -> list[dict]:
    """Embed the query and fetch the k most relevant chunks from Chroma."""
    collection = get_collection()
    if collection.count() == 0:
        return []

    model = get_embedding_model()
    query_embedding = model.encode([query], show_progress_bar=False).tolist()

    results = collection.query(
        query_embeddings=query_embedding,
        n_results=min(k, collection.count()),
        include=["documents", "metadatas", "distances"],
    )

    hits = []
    for doc, meta, distance in zip(
        results["documents"][0], results["metadatas"][0], results["distances"][0]
    ):
        hits.append({
            "text": doc,
            "source": meta["source"],
            "chunk_index": meta["chunk_index"],
            "distance": distance,
        })
    return hits


def _build_context_block(hits: list[dict]) -> str:
    """Format retrieved chunks with clear source labels so the model can
    both ground its answer and cite where each fact came from."""
    if not hits:
        return "(no relevant documents found)"
    blocks = [f"[Source: {h['source']}]\n{h['text']}" for h in hits]
    return "\n\n---\n\n".join(blocks)


def _build_messages(query: str, history: list[dict], hits: list[dict]) -> list[dict]:
    """Assemble the full message list sent to Groq: system prompt, trimmed
    history, then the current question with its retrieved context attached."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Keep only the last MAX_HISTORY_TURNS user/assistant pairs so the
    # prompt doesn't grow unbounded, and so old context can't dilute
    # grounding in the current document context.
    trimmed = history[-(MAX_HISTORY_TURNS * 2):] if history else []
    for turn in trimmed:
        role = turn.get("role")
        content = turn.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    context_block = _build_context_block(hits)
    user_content = (
        f"Context:\n{context_block}\n\n"
        f"Question: {query}"
    )
    messages.append({"role": "user", "content": user_content})
    return messages


def _call_groq(messages: list[dict]) -> tuple[str, str]:
    """Call Groq's chat completions, falling back to a smaller model if the
    primary model is rate-limited or otherwise unavailable.
    Returns (answer_text, model_used)."""
    client = get_groq_client()

    for model_name in (PRIMARY_MODEL, FALLBACK_MODEL):
        try:
            response = client.chat.completions.create(
                model=model_name,
                messages=messages,
                temperature=0.2,
                max_tokens=1024,
            )
            return response.choices[0].message.content, model_name
        except APIStatusError as e:
            # 429 = rate limited, try the fallback model; other 4xx/5xx
            # from Groq are re-raised so the caller can report them.
            if e.status_code == 429 and model_name == PRIMARY_MODEL:
                continue
            raise
        except (APIConnectionError, APITimeoutError):
            if model_name == PRIMARY_MODEL:
                continue
            raise

    raise RuntimeError("Groq API is unavailable for both primary and fallback models.")


def chat(query: str, history: list[dict]) -> dict:
    """
    Full RAG turn: retrieve relevant chunks, build a grounded prompt,
    call Groq, and return the answer along with which sources were used.
    """
    hits = retrieve(query, k=TOP_K)
    messages = _build_messages(query, history, hits)
    answer, model_used = _call_groq(messages)

    sources = sorted({h["source"] for h in hits})
    return {
        "answer": answer,
        "sources": sources,
        "model_used": model_used,
    }
