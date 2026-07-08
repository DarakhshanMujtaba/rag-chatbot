"""
document_loader.py

Turns uploaded files (PDF, TXT, MD) into plain text.
Kept separate from rag_engine.py so the parsing logic can be swapped or
extended (e.g. add .docx support) without touching chunking/embedding code.
"""

from pathlib import Path
from pypdf import PdfReader


SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md"}


def is_supported(filename: str) -> bool:
    """Check extension before we bother saving/parsing a file."""
    return Path(filename).suffix.lower() in SUPPORTED_EXTENSIONS


def load_text_from_file(file_path: Path) -> str:
    """
    Extract raw text from a file on disk based on its extension.

    PDFs are parsed page by page and joined with newlines so page
    boundaries roughly align with paragraph boundaries (helps chunking
    later produce more coherent chunks).
    """
    suffix = file_path.suffix.lower()

    if suffix == ".pdf":
        return _load_pdf(file_path)
    elif suffix in (".txt", ".md"):
        return file_path.read_text(encoding="utf-8", errors="ignore")
    else:
        raise ValueError(f"Unsupported file type: {suffix}")


def _load_pdf(file_path: Path) -> str:
    """Extract text from every page of a PDF, skipping unreadable pages
    instead of failing the whole upload (scanned/image-only pages have
    no extractable text and would otherwise raise)."""
    reader = PdfReader(str(file_path))
    pages_text = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if text.strip():
            pages_text.append(text)
    return "\n\n".join(pages_text)
