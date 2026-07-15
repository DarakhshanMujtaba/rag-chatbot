// app.js
// Frontend logic for the RAG chatbot: file upload, document list, chat, and
// localStorage-backed chat sessions. No framework/build step on purpose —
// this is a small enough UI that vanilla JS keeps the whole project easy to
// run with zero tooling.

const API_BASE = ""; // same-origin (FastAPI serves this file too)

const SESSIONS_KEY = "ragChatSessions_v1";
const ACTIVE_SESSION_KEY = "ragChatActiveSession_v1";
const FILE_SIZES_KEY = "ragChatFileSizes_v1";
const TOKEN_KEY = "ragChatToken";

// ---------------------------------------------------------------------------
// Auth guard + authenticated fetch
// ---------------------------------------------------------------------------

const authToken = localStorage.getItem(TOKEN_KEY);
if (!authToken) {
  window.location.href = "/login";
}

function goToLogin() {
  localStorage.removeItem(TOKEN_KEY);
  window.location.href = "/login";
}

// Wraps fetch with the Authorization header and redirects to login if the
// token is missing/invalid/expired (401) or rejected outright (403).
async function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${authToken}` };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    goToLogin();
    throw new Error("Session expired. Redirecting to login…");
  }
  return res;
}

const SUGGESTIONS = [
  "What is this document about?",
  "Summarize the key points",
  "List the main topics covered",
];

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const docList = document.getElementById("docList");
const docCount = document.getElementById("docCount");
const chatWindow = document.getElementById("chatWindow");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const toast = document.getElementById("toast");

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebarToggle");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const newChatBtn = document.getElementById("newChatBtn");
const historyBtn = document.getElementById("historyBtn");
const sessionDropdown = document.getElementById("sessionDropdown");
const sessionList = document.getElementById("sessionList");

// Conversation history sent to the backend so follow-up questions
// ("what about section 2?") resolve correctly against prior turns.
// Mirrors the shape the backend expects: [{role: 'user'|'assistant', content}]
let history = [];
let activeSessionId = null;

// ---------------------------------------------------------------------------
// Toast helper
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4000);
}

// ---------------------------------------------------------------------------
// Sidebar (mobile) toggle
// ---------------------------------------------------------------------------

function openSidebar() {
  sidebar.classList.add("open");
  sidebarBackdrop.classList.remove("hidden");
}
function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarBackdrop.classList.add("hidden");
}
sidebarToggle.addEventListener("click", () => {
  sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
});
sidebarBackdrop.addEventListener("click", closeSidebar);

// ---------------------------------------------------------------------------
// Document list
// ---------------------------------------------------------------------------

function loadFileSizes() {
  try {
    return JSON.parse(localStorage.getItem(FILE_SIZES_KEY)) || {};
  } catch {
    return {};
  }
}

function rememberFileSize(filename, size) {
  const sizes = loadFileSizes();
  sizes[filename] = size;
  localStorage.setItem(FILE_SIZES_KEY, JSON.stringify(sizes));
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExt(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function fileIconHtml(filename) {
  const ext = fileExt(filename);
  const cls = ["pdf", "txt", "md"].includes(ext) ? ext : "txt";
  const label = ext ? ext.toUpperCase().slice(0, 3) : "DOC";
  return `<span class="doc-file-icon ${cls}">${label}</span>`;
}

async function refreshDocuments() {
  try {
    const res = await authFetch(`${API_BASE}/api/documents`);
    const data = await res.json();
    renderDocuments(data.documents || []);
  } catch (err) {
    showToast("Could not load document list.", true);
  }
}

function renderDocuments(documents) {
  docCount.textContent = documents.length;

  if (documents.length === 0) {
    docList.innerHTML = `
      <li class="doc-empty">
        <span class="doc-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h6l2 2h5A2.5 2.5 0 0 1 22 8.5v9A2.5 2.5 0 0 1 19.5 20h-13A2.5 2.5 0 0 1 4 17.5v-11z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        </span>
        No documents yet — upload one to get started.
      </li>`;
    return;
  }

  const sizes = loadFileSizes();
  docList.innerHTML = "";
  for (const doc of documents) {
    const li = document.createElement("li");
    li.className = "doc-item";
    const sizeLabel = formatBytes(sizes[doc.filename]);
    const meta = `${doc.chunks} chunk${doc.chunks === 1 ? "" : "s"}${sizeLabel ? ` · ${sizeLabel}` : ""}`;
    li.innerHTML = `
      ${fileIconHtml(doc.filename)}
      <div class="doc-item-info">
        <div class="doc-item-name" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</div>
        <div class="doc-item-meta">${meta}</div>
      </div>
      <button class="doc-delete" data-filename="${escapeHtml(doc.filename)}" title="Remove" aria-label="Remove ${escapeHtml(doc.filename)}">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    `;
    docList.appendChild(li);
  }

  docList.querySelectorAll(".doc-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteDocument(btn.dataset.filename));
  });
}

async function deleteDocument(filename) {
  try {
    const res = await authFetch(`${API_BASE}/api/documents/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Delete failed");
    }
    showToast(`Removed "${filename}"`);
    refreshDocuments();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function uploadFiles(fileList) {
  if (!fileList || fileList.length === 0) return;

  const formData = new FormData();
  for (const file of fileList) {
    formData.append("files", file);
    rememberFileSize(file.name, file.size);
  }

  showToast(`Uploading ${fileList.length} file(s)...`);

  try {
    const res = await authFetch(`${API_BASE}/api/upload`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json();

    const errors = data.results.filter((r) => r.status === "error");
    const indexed = data.results.filter((r) => r.status === "indexed");

    if (indexed.length > 0) {
      showToast(`Indexed ${indexed.length} document(s).`);
    }
    if (errors.length > 0) {
      showToast(`${errors.length} file(s) failed: ${errors.map((e) => e.detail).join(", ")}`, true);
    }

    refreshDocuments();
  } catch (err) {
    showToast("Upload failed. Is the server running?", true);
  }
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  uploadFiles(e.target.files);
  fileInput.value = "";
});

["dragover", "dragenter"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });
});
dropzone.addEventListener("drop", (e) => {
  uploadFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------------------
// Chat sessions (localStorage) — documents live entirely on the backend and
// are unaffected by switching/clearing sessions here.
// ---------------------------------------------------------------------------

function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY)) || [];
  } catch {
    return [];
  }
}

function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function makeSessionId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function newEmptySession() {
  return {
    id: makeSessionId(),
    title: "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}

let currentSession = null;

function persistCurrentSession() {
  if (!currentSession || currentSession.messages.length === 0) return;
  const sessions = loadSessions();
  const idx = sessions.findIndex((s) => s.id === currentSession.id);
  currentSession.updatedAt = Date.now();
  if (idx >= 0) {
    sessions[idx] = currentSession;
  } else {
    sessions.push(currentSession);
  }
  saveSessions(sessions);
}

function titleFromMessages(messages) {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const text = firstUser.content.trim();
  return text.length > 42 ? text.slice(0, 42) + "…" : text;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function renderSessionDropdown() {
  const sessions = loadSessions().sort((a, b) => b.updatedAt - a.updatedAt);
  if (sessions.length === 0) {
    sessionList.innerHTML = `<li class="session-list-empty">No past chats yet.</li>`;
    return;
  }
  sessionList.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    li.className = "session-item" + (s.id === activeSessionId ? " active" : "");
    li.innerHTML = `
      <div class="session-item-text">
        <div class="session-item-title">${escapeHtml(s.title || "New chat")}</div>
        <div class="session-item-time">${relativeTime(s.updatedAt)}</div>
      </div>
      <button class="session-item-delete" title="Delete chat" aria-label="Delete chat">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    `;
    li.querySelector(".session-item-text").addEventListener("click", () => {
      switchSession(s.id);
      closeSessionDropdown();
    });
    li.querySelector(".session-item-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });
    sessionList.appendChild(li);
  }
}

function openSessionDropdown() {
  renderSessionDropdown();
  sessionDropdown.classList.remove("hidden");
}
function closeSessionDropdown() {
  sessionDropdown.classList.add("hidden");
}
historyBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  sessionDropdown.classList.contains("hidden") ? openSessionDropdown() : closeSessionDropdown();
});
document.addEventListener("click", (e) => {
  if (!sessionDropdown.contains(e.target) && e.target !== historyBtn) {
    closeSessionDropdown();
  }
});

function switchSession(id) {
  const sessions = loadSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  currentSession = session;
  activeSessionId = session.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  history = session.messages.map((m) => ({ role: m.role, content: m.content }));
  renderSessionMessages(session.messages);
}

function deleteSession(id) {
  let sessions = loadSessions();
  sessions = sessions.filter((s) => s.id !== id);
  saveSessions(sessions);
  if (id === activeSessionId) {
    if (sessions.length > 0) {
      switchSession(sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
    } else {
      startNewChat();
    }
  }
  renderSessionDropdown();
}

function startNewChat() {
  currentSession = newEmptySession();
  activeSessionId = currentSession.id;
  localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  history = [];
  renderSessionMessages([]);
  closeSessionDropdown();
}

newChatBtn.addEventListener("click", startNewChat);

document.getElementById("logoutBtn").addEventListener("click", goToLogin);

function initSessions() {
  const sessions = loadSessions();
  const savedActiveId = localStorage.getItem(ACTIVE_SESSION_KEY);
  const found = sessions.find((s) => s.id === savedActiveId);
  if (found) {
    currentSession = found;
    activeSessionId = found.id;
    history = found.messages.map((m) => ({ role: m.role, content: m.content }));
    renderSessionMessages(found.messages);
  } else {
    startNewChat();
  }
}

// ---------------------------------------------------------------------------
// Chat rendering
// ---------------------------------------------------------------------------

function renderWelcome() {
  const block = document.createElement("div");
  block.className = "welcome-block";
  block.innerHTML = `
    <div class="message bot">
      <div class="message-col">
        <div class="bubble">
          👋 Hi! Upload a document on the left, then ask me anything about it.
          I'll only answer from what's in your documents and cite my sources.
        </div>
      </div>
    </div>
    <div class="suggestions">
      ${SUGGESTIONS.map((s) => `<button type="button" class="suggestion-chip">${escapeHtml(s)}</button>`).join("")}
    </div>
  `;
  chatWindow.appendChild(block);
  block.querySelectorAll(".suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => sendMessage(chip.textContent));
  });
}

function renderMessageBubble(role, text, sources = [], animate = true) {
  const msg = document.createElement("div");
  msg.className = `message ${role === "user" ? "user" : "bot"}`;
  if (!animate) msg.style.animation = "none";

  const col = document.createElement("div");
  col.className = "message-col";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "error") bubble.classList.add("error-bubble");
  bubble.textContent = text;
  col.appendChild(bubble);

  if (sources.length > 0) {
    const sourcesEl = document.createElement("div");
    sourcesEl.className = "sources";
    sourcesEl.innerHTML = sources
      .map(
        (s) => `<span class="source-chip">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none"><path d="M14 3v5h5M6 4h8l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          <span>${escapeHtml(s)}</span>
        </span>`
      )
      .join("");
    col.appendChild(sourcesEl);
  }

  msg.appendChild(col);
  chatWindow.appendChild(msg);
  chatWindow.scrollTo({ top: chatWindow.scrollHeight, behavior: "smooth" });
  return msg;
}

function renderSessionMessages(messages) {
  chatWindow.innerHTML = "";
  if (messages.length === 0) {
    renderWelcome();
    return;
  }
  for (const m of messages) {
    renderMessageBubble(m.role === "user" ? "user" : "bot", m.content, m.sources || [], false);
  }
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function appendTypingIndicator() {
  const msg = document.createElement("div");
  msg.className = "message bot";
  msg.id = "typingIndicator";
  msg.innerHTML = `
    <div class="message-col">
      <div class="bubble">
        <div class="typing"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
  chatWindow.appendChild(msg);
  chatWindow.scrollTo({ top: chatWindow.scrollHeight, behavior: "smooth" });
}

function removeTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

async function sendMessage(text) {
  // First real message in this session — clear the welcome/suggestions block.
  if (currentSession.messages.length === 0) {
    chatWindow.innerHTML = "";
  }

  currentSession.messages.push({ role: "user", content: text });
  currentSession.title = titleFromMessages(currentSession.messages);
  renderMessageBubble("user", text);
  history.push({ role: "user", content: text });

  chatInput.value = "";
  chatInput.disabled = true;
  sendBtn.disabled = true;
  sendBtn.classList.add("loading");
  appendTypingIndicator();

  try {
    const res = await authFetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history }),
    });

    removeTypingIndicator();

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Chat request failed.");
    }

    const data = await res.json();
    currentSession.messages.push({ role: "assistant", content: data.answer, sources: data.sources || [] });
    renderMessageBubble("bot", data.answer, data.sources || []);
    history.push({ role: "assistant", content: data.answer });
    persistCurrentSession();
  } catch (err) {
    removeTypingIndicator();
    renderMessageBubble("error", `⚠️ ${err.message}`);
    persistCurrentSession();
  } finally {
    chatInput.disabled = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove("loading");
    chatInput.focus();
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendMessage(text);
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

if (authToken) {
  refreshDocuments();
  initSessions();
}
