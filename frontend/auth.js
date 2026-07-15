// auth.js — login/signup page logic.
//
// Token storage trade-off: this stores the JWT in localStorage rather than
// an in-memory JS variable. localStorage is simpler (survives a page
// refresh, no extra state-restoration logic needed) but is readable by any
// JS that runs on the page, so it's vulnerable if the app ever has an XSS
// bug. An in-memory variable avoids that exposure but loses the session on
// every refresh. For this project's scale (portfolio demo, not handling
// sensitive financial/health data) localStorage's simplicity wins.

const TOKEN_KEY = "ragChatToken";

const authForm = document.getElementById("authForm");
const authTabs = document.querySelectorAll(".auth-tab");
const authSubmit = document.getElementById("authSubmit");
const authSubmitLabel = document.getElementById("authSubmitLabel");
const authError = document.getElementById("authError");
const passwordInput = document.getElementById("password");
const togglePasswordBtn = document.getElementById("togglePassword");

togglePasswordBtn.addEventListener("click", () => {
  const isVisible = passwordInput.type === "text";
  passwordInput.type = isVisible ? "password" : "text";
  togglePasswordBtn.setAttribute("aria-pressed", String(!isVisible));
  togglePasswordBtn.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
});

let mode = "login"; // "login" | "signup"

// If already holding a token, skip straight to the app — index.html will
// verify it's still valid and bounce back here if not.
if (localStorage.getItem(TOKEN_KEY)) {
  window.location.href = "/";
}

function setMode(newMode) {
  mode = newMode;
  authTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  authSubmitLabel.textContent = mode === "login" ? "Log in" : "Sign up";
  passwordInput.autocomplete = mode === "login" ? "current-password" : "new-password";
  hideError();
}

authTabs.forEach((tab) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
});

function showError(message) {
  authError.textContent = message;
  authError.classList.remove("hidden");
}

function hideError() {
  authError.classList.add("hidden");
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();

  const email = document.getElementById("email").value.trim();
  const password = passwordInput.value;

  authSubmit.disabled = true;
  const originalLabel = authSubmitLabel.textContent;
  authSubmitLabel.textContent = mode === "login" ? "Logging in…" : "Signing up…";

  try {
    const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.detail || "Something went wrong.");
    }

    localStorage.setItem(TOKEN_KEY, data.access_token);
    window.location.href = "/";
  } catch (err) {
    showError(err.message);
  } finally {
    authSubmit.disabled = false;
    authSubmitLabel.textContent = originalLabel;
  }
});
