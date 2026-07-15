// theme.js — shared light/dark theme toggle, used by both index.html and
// login.html. The *initial* theme is applied synchronously by a small inline
// script in each page's <head> (before this file loads) so the correct
// theme is set before first paint — this file only handles the toggle
// button click and persisting the choice.

const THEME_KEY = "ragChatTheme";

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
}

const themeToggle = document.getElementById("themeToggle");
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  });
}
