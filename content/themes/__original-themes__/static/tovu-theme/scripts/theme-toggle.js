(function () {
  var STORAGE_KEY = "tovu-theme:relay";
  var root = document.documentElement;

  function apply(mode) {
    if (mode === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
  }

  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
  if (saved === "light" || saved === "dark") apply(saved);

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.querySelector("[data-theme-toggle]");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      apply(next);
      btn.setAttribute("aria-label", next === "light" ? "Switch to dark mode" : "Switch to light mode");
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    });
  });
})();
