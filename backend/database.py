"""
database.py

SQLAlchemy engine/session setup for the user account store (users.db,
SQLite). Kept separate from the vector store — ChromaDB holds document
chunks, this holds accounts and login credentials.
"""

import os
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

BACKEND_DIR = Path(__file__).resolve().parent

# DATA_DIR points at a mounted persistent disk in production (e.g. Render);
# locally it's unset, so this falls back to the existing backend/ location.
DATA_DIR = os.getenv("DATA_DIR")
DB_PATH = Path(DATA_DIR) / "users.db" if DATA_DIR else BACKEND_DIR / "users.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI dependency: yields a session, closes it after the request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
