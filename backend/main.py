"""
main.py

FastAPI application: exposes the upload/documents/chat API and serves the
static frontend. Kept thin on purpose — all RAG logic lives in
rag_engine.py and document_loader.py so this file only wires HTTP to it.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env before anything reads os.getenv (rag_engine reads GROQ_API_KEY
# lazily on first Groq call, but loading here guarantees it's available
# regardless of import order).
load_dotenv()

from fastapi import Depends, FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from groq import APIStatusError, APIConnectionError, APITimeoutError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import auth
import document_loader
import rag_engine
from database import Base, engine, get_db
from models import User

# Creates users.db / the users table on first run; no-op if it already exists.
Base.metadata.create_all(bind=engine)

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# DATA_DIR points at a mounted persistent disk in production (e.g. Render);
# locally it's unset, so this falls back to the existing data/uploads/ location.
DATA_DIR = os.getenv("DATA_DIR")
UPLOADS_DIR = Path(DATA_DIR) / "uploads" if DATA_DIR else PROJECT_ROOT / "data" / "uploads"

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="RAG Chatbot")

# CORS: allows the frontend to be served from a different origin during
# development (e.g. a Vite/live-server preview) instead of only from
# FastAPI's own static file route.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

@app.post("/api/auth/signup", response_model=auth.TokenResponse)
async def signup(request: auth.SignupRequest, db: Session = Depends(get_db)):
    """Create a new user account and return an access token, logged in."""
    user = User(email=request.email, hashed_password=auth.hash_password(request.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="An account with this email already exists.")
    db.refresh(user)
    return auth.TokenResponse(access_token=auth.create_access_token(user.id, user.email))


@app.post("/api/auth/login", response_model=auth.TokenResponse)
async def login(request: auth.LoginRequest, db: Session = Depends(get_db)):
    """Verify credentials and return an access token."""
    user = db.query(User).filter(User.email == request.email).first()
    if user is None or not auth.verify_password(request.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    return auth.TokenResponse(access_token=auth.create_access_token(user.id, user.email))


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.post("/api/upload")
async def upload_documents(
    files: list[UploadFile] = File(...),
    current_user: User = Depends(auth.get_current_user),
):
    """Save uploaded files, parse them, chunk + embed + index each one."""
    results = []
    user_upload_dir = UPLOADS_DIR / str(current_user.id)
    user_upload_dir.mkdir(parents=True, exist_ok=True)

    for upload in files:
        filename = upload.filename
        if not document_loader.is_supported(filename):
            results.append({
                "filename": filename,
                "status": "error",
                "detail": "Unsupported file type. Use PDF, TXT, or MD.",
            })
            continue

        dest_path = user_upload_dir / filename
        try:
            contents = await upload.read()
            dest_path.write_bytes(contents)

            text = document_loader.load_text_from_file(dest_path)
            if not text.strip():
                results.append({
                    "filename": filename,
                    "status": "error",
                    "detail": "No extractable text found (file may be empty or a scanned image).",
                })
                continue

            chunk_count = rag_engine.add_document(filename, text, current_user.id)
            results.append({
                "filename": filename,
                "status": "indexed",
                "chunks": chunk_count,
            })
        except Exception as e:
            results.append({
                "filename": filename,
                "status": "error",
                "detail": str(e),
            })

    return {"results": results}


@app.get("/api/documents")
async def get_documents(current_user: User = Depends(auth.get_current_user)):
    """List documents currently in the vector store, scoped to the current user."""
    return {"documents": rag_engine.list_documents(current_user.id)}


@app.delete("/api/documents/{filename}")
async def delete_document(filename: str, current_user: User = Depends(auth.get_current_user)):
    """Remove one of the current user's documents (vectors + file on disk)."""
    removed = rag_engine.delete_document(filename, current_user.id)
    if removed == 0:
        raise HTTPException(status_code=404, detail=f"'{filename}' not found in index.")

    file_path = UPLOADS_DIR / str(current_user.id) / filename
    if file_path.exists():
        file_path.unlink()

    return {"filename": filename, "chunks_removed": removed}


@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest, current_user: User = Depends(auth.get_current_user)):
    """Run one RAG turn: retrieve context, call Groq, return grounded answer."""
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    docs = rag_engine.list_documents(current_user.id)
    if not docs:
        return JSONResponse(
            status_code=200,
            content={
                "answer": "I don't have any documents to search yet. Please upload "
                          "a PDF, TXT, or MD file first.",
                "sources": [],
            },
        )

    try:
        history = [turn.model_dump() for turn in request.history]
        result = rag_engine.chat(request.message, history, current_user.id)
        return result
    except RuntimeError as e:
        # Raised by rag_engine when GROQ_API_KEY is missing.
        raise HTTPException(status_code=500, detail=str(e))
    except APIStatusError as e:
        if e.status_code == 429:
            raise HTTPException(
                status_code=429,
                detail="Groq rate limit reached on all models. Please wait a moment and try again.",
            )
        raise HTTPException(status_code=502, detail=f"Groq API error: {e.message}")
    except (APIConnectionError, APITimeoutError):
        raise HTTPException(
            status_code=503,
            detail="Could not reach Groq API. Check your internet connection and try again.",
        )


# ---------------------------------------------------------------------------
# Frontend static files
# ---------------------------------------------------------------------------
# Mounted after the /api routes so they take precedence. StaticFiles serves
# style.css/app.js; the root path explicitly returns index.html.
#
# StaticFiles/FileResponse only set Last-Modified/ETag by default — no
# Cache-Control — so without an explicit header, browsers are free to reuse
# a stale copy of app.js/index.html from disk cache without even asking the
# server, which silently hides frontend changes (e.g. a newly wired-up
# button) behind an old cached script. `no-cache` forces a revalidation
# request (cheap 304 if unchanged) on every load instead.

NO_CACHE_HEADERS = {"Cache-Control": "no-cache"}


class NoCacheStaticFiles(StaticFiles):
    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", NoCacheStaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def serve_index():
    return FileResponse(str(FRONTEND_DIR / "index.html"), headers=NO_CACHE_HEADERS)


@app.get("/login")
async def serve_login():
    return FileResponse(str(FRONTEND_DIR / "login.html"), headers=NO_CACHE_HEADERS)
