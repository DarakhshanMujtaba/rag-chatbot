# RAG Chatbot

A chatbot that answers questions grounded in documents you upload (PDF, TXT, MD).
It retrieves relevant passages from your files before answering, and tells you
which source document each answer came from — it will not make things up when
the answer isn't in your documents.

## What it does

1. You upload PDFs / TXT / MD files through the web UI.
2. The backend splits each document into overlapping chunks, embeds them
   locally, and stores the vectors in a persistent ChromaDB collection.
3. When you ask a question, the backend embeds your question, retrieves the
   most similar chunks, and sends them to a Groq-hosted LLM along with a
   system prompt that forces it to answer only from that context.
4. The answer is returned along with the filenames it was grounded in.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend | FastAPI + Uvicorn | Fast to write, async, serves both the API and the static frontend |
| LLM | Groq API (`llama-3.3-70b-versatile`, falls back to `llama-3.1-8b-instant`) | Free tier, very low latency, OpenAI-compatible SDK |
| Embeddings | `sentence-transformers` (`all-MiniLM-L6-v2`) | Runs locally, free, no API key or network call needed to embed |
| Vector store | ChromaDB (persistent, local) | Zero external services, just a folder on disk |
| Frontend | Vanilla HTML/CSS/JS | No build step — clone and open a browser, nothing to compile |

## Setup

### 1. Get a free Groq API key
Sign up at [console.groq.com](https://console.groq.com/keys) and create an API key. It's free.

### 2. Create a virtual environment and install dependencies

```bash
cd rag-chatbot
python -m venv venv

# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r backend/requirements.txt
```

### 3. Configure your API key

```bash
cp .env.example .env
```

Edit `.env` and paste your key:

```
GROQ_API_KEY=gsk_your_actual_key_here
```

### 4. Run the server

```bash
cd backend
uvicorn main:app --reload
```

Open **http://127.0.0.1:8000** in your browser.

> If port 8000 is already in use on your machine, run with a different port
> instead, e.g. `uvicorn main:app --reload --port 8001`, and open that port
> in your browser.

Upload a PDF/TXT/MD file in the sidebar, wait for it to appear in "Indexed
Documents", then ask a question about it in the chat box.

## How it works (the RAG pipeline, in plain language)

**Indexing (on upload):**
- The file's text is extracted (`pypdf` for PDFs, plain read for text/markdown).
- The text is split into ~400-word chunks with ~40-word overlap between
  consecutive chunks, so a fact sitting near a chunk boundary still appears
  intact in at least one chunk.
- Each chunk is converted into a 384-dimension embedding vector by a local
  sentence-transformers model (no API call, runs on your CPU).
- Chunks + vectors + metadata (source filename, chunk index) are stored in a
  ChromaDB collection persisted to `backend/chroma_db/`.

**Answering (on each chat message):**
- Your question is embedded with the same local model.
- ChromaDB does a similarity search and returns the top 4 most relevant
  chunks across all indexed documents.
- Those chunks are formatted into a context block, each one labeled with its
  source filename, and inserted into a prompt along with a system message
  that instructs the model: *only answer from this context, and say you
  don't have the information if the context doesn't cover the question.*
- The last few turns of conversation are included too, so follow-ups like
  "what about the second point?" resolve correctly — but the system prompt
  makes clear that history never overrides the document grounding.
- The prompt is sent to Groq's chat completion endpoint. If the primary
  model (`llama-3.3-70b-versatile`) is rate-limited, the backend
  automatically retries with the smaller `llama-3.1-8b-instant`.
- The answer and the list of source filenames used are returned to the UI.

## Project structure

```
rag-chatbot/
├── backend/
│   ├── main.py              # FastAPI app, routes, serves frontend
│   ├── rag_engine.py        # chunking, embedding, retrieval, prompt construction
│   ├── document_loader.py   # PDF/txt/md parsing
│   ├── requirements.txt
│   └── chroma_db/           # persisted vector store (gitignored)
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── data/
│   └── uploads/              # uploaded source documents (gitignored)
├── .env.example
├── .gitignore
└── README.md
```

## API reference

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Upload one or more files, index them |
| `GET` | `/api/documents` | List indexed documents and chunk counts |
| `DELETE` | `/api/documents/{filename}` | Remove a document and its vectors |
| `POST` | `/api/chat` | `{message, history}` → grounded answer + sources |

## Known limitations

This is a single-user, local-first project meant as a functioning demo/portfolio
piece, not a production deployment. Specifically:

- **No authentication** — anyone who can reach the server can upload files,
  delete documents, and chat.
- **No multi-tenancy** — one shared document store for everyone using the
  instance; no per-user isolation.
- **No streaming responses** — answers are returned in one shot rather than
  token-by-token (Groq supports streaming; `rag_engine._call_groq` would need
  to switch to `stream=True` and `main.py`'s `/api/chat` would need to return
  a `StreamingResponse`).
- **Local disk storage only** — uploaded files and the ChromaDB index live on
  the server's filesystem, so it won't work as-is on stateless/ephemeral
  hosting (e.g. most serverless platforms) without moving to persistent disk
  or S3 + a hosted vector DB.
- **No file size/type validation beyond extension** — a malicious or huge
  file could still be uploaded and slow things down.
- **No tests.**

### To make this production-ready / deployable (e.g. Render, Railway)

- Add auth (even simple API-key or session-based auth) in front of upload/delete.
- Move uploads to persistent storage (Render/Railway disks, or S3) and pin
  a persistent volume for `backend/chroma_db/` — without a persistent disk,
  your index disappears on every redeploy.
- Add rate limiting on `/api/chat` and `/api/upload`.
- Add request size limits and stricter file validation (magic-byte checks,
  not just extension).
- Add streaming responses for a better perceived latency on longer answers.
- Add structured logging + basic monitoring (Groq errors, embedding time).
- Pin dependency versions more strictly and add a Dockerfile for reproducible
  deploys.
