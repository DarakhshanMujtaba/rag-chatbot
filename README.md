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
| Auth | JWT (`python-jose`) + `passlib`/`bcrypt`, SQLAlchemy + SQLite | Simple, no external auth provider, easy to self-host |
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

### 3. Configure your API key and JWT secret

```bash
cp .env.example .env
```

Edit `.env` and fill in both values:

```
GROQ_API_KEY=gsk_your_actual_key_here
JWT_SECRET_KEY=generate_your_own_random_value_here
```

Generate a secure `JWT_SECRET_KEY` with:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

This key signs login tokens — anyone who has it can mint valid tokens for
your server, so keep `.env` out of version control (it already is, via
`.gitignore`) and use a different value per deployment.

### 4. Run the server

```bash
cd backend
uvicorn main:app --reload
```

Open **http://127.0.0.1:8000** in your browser. You'll land on a login/signup
page first — see [Authentication](#authentication--multi-user) below.

> If port 8000 is already in use on your machine, run with a different port
> instead, e.g. `uvicorn main:app --reload --port 8001`, and open that port
> in your browser.

Sign up for an account, upload a PDF/TXT/MD file in the sidebar, wait for it
to appear in "Indexed Documents", then ask a question about it in the chat
box. Documents and chat answers are private to your account — see below.

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

## Authentication & multi-user

This is a multi-user app: every account has its own private set of
documents, and chat answers are only ever grounded in *that account's*
documents. Auth is deliberately simple — no OAuth, no refresh tokens, no
email verification — just JWT-protected endpoints, appropriate for a
portfolio-scale deployment.

**How it works:**
- Passwords are hashed with `bcrypt` (via `passlib`) before being stored in
  a local SQLite database (`backend/users.db`) — plain text passwords are
  never stored or logged.
- On signup/login, the backend issues a JWT access token signed with
  `JWT_SECRET_KEY`, valid for 7 days. There's no refresh token — once it
  expires, log in again.
- The frontend stores the token in `localStorage` and sends it as
  `Authorization: Bearer <token>` on every API call. If a request comes back
  `401`/`403` (missing, invalid, or expired token), the frontend clears the
  token and redirects to `/login` automatically.
  - **Trade-off:** `localStorage` is simple and survives a page refresh, but
    it's readable by any JS running on the page — so it's vulnerable if the
    app ever has an XSS bug. An in-memory JS variable avoids that exposure
    but loses the session on every refresh. For this project's scale
    (a demo, not a banking app) `localStorage`'s simplicity wins; a
    production app handling sensitive data should weigh this differently.
- Every document chunk stored in ChromaDB is tagged with the uploading
  user's `user_id` in its metadata (alongside the existing `source`
  filename tag). Retrieval, listing, and deletion all filter on
  `where={"user_id": ...}`, so one shared ChromaDB collection safely serves
  every user without cross-account leakage. Uploaded files are also stored
  in per-user folders (`data/uploads/{user_id}/...`) instead of one flat
  shared folder.

**Testing the auth flow with curl:**

```bash
# Sign up (returns an access token, effectively logs you in)
curl -X POST http://127.0.0.1:8001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "a-strong-password"}'

# Log in (same response shape)
curl -X POST http://127.0.0.1:8001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "a-strong-password"}'
# => {"access_token": "eyJhbGciOi...", "token_type": "bearer"}

# Use the token on any protected endpoint
TOKEN="eyJhbGciOi..."   # paste the access_token from above

curl http://127.0.0.1:8001/api/documents \
  -H "Authorization: Bearer $TOKEN"

curl -X POST http://127.0.0.1:8001/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@/path/to/your/file.pdf"

curl -X POST http://127.0.0.1:8001/api/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is this document about?", "history": []}'
```

To verify isolation yourself: sign up two different accounts, upload a
document with each, and confirm `GET /api/documents` (and chat answers) for
one account never shows or cites the other account's file.

> **Note on pre-existing data:** if you had documents indexed in ChromaDB
> from before this multi-user upgrade, those chunks have no `user_id` in
> their metadata and won't show up for any account under the new
> `where={"user_id": ...}` filter. They aren't deleted — just orphaned. To
> reclaim them, either re-upload the original files under an account, or
> manually back-fill `user_id` onto their existing metadata in
> `backend/chroma_db/`.

## Project structure

```
rag-chatbot/
├── backend/
│   ├── main.py              # FastAPI app, routes, serves frontend
│   ├── rag_engine.py        # chunking, embedding, retrieval, prompt construction
│   ├── document_loader.py   # PDF/txt/md parsing
│   ├── auth.py              # password hashing, JWT issuing/validation, get_current_user
│   ├── database.py          # SQLAlchemy engine/session setup (users.db)
│   ├── models.py            # SQLAlchemy User model
│   ├── requirements.txt
│   ├── users.db             # user accounts (gitignored)
│   └── chroma_db/           # persisted vector store (gitignored)
├── frontend/
│   ├── index.html
│   ├── login.html           # signup/login page shown when logged out
│   ├── style.css
│   ├── auth.css             # login page styling
│   ├── app.js
│   └── auth.js           # signup/login form logic
├── data/
│   └── uploads/
│       └── {user_id}/    # per-user uploaded source documents (gitignored)
├── .env.example
├── .gitignore
└── README.md
```

## API reference

| Method | Path | Auth required | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/signup` | No | `{email, password}` → create account, returns access token |
| `POST` | `/api/auth/login` | No | `{email, password}` → returns access token |
| `POST` | `/api/upload` | Yes | Upload one or more files, index them under the current user |
| `GET` | `/api/documents` | Yes | List the current user's indexed documents and chunk counts |
| `DELETE` | `/api/documents/{filename}` | Yes | Remove one of the current user's documents and its vectors |
| `POST` | `/api/chat` | Yes | `{message, history}` → grounded answer + sources, scoped to the current user's documents |

"Auth required" means the request needs an `Authorization: Bearer <token>`
header; without one (or with an invalid/expired one) these return `401`/`403`.

## Known limitations

This is a local-first project meant as a functioning demo/portfolio piece,
not a production deployment. Specifically:

- **Simple JWT auth, no refresh tokens** — access tokens last 7 days with no
  way to revoke a single token early (short of rotating `JWT_SECRET_KEY`,
  which invalidates every session). No password reset or email verification
  flow either.
- **Metadata-filtered isolation, not hard tenant separation** — all users'
  document chunks live in one ChromaDB collection, isolated only by a
  `user_id` filter on every query. Correct as implemented, but a bug in that
  filtering logic would leak across accounts (unlike separate
  collections/databases per tenant, which fail closed).
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

- Add refresh tokens (or short-lived access tokens + a revocation list) so a
  compromised token doesn't stay valid for a full week.
- Add password reset and email verification flows.
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
