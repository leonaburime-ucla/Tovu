/**
 * Docs sidebar scroll-spy.
 *
 * Why this exists at all: the engine computes `isCurrent`/`isActive` server-side by comparing each
 * item's resolved href against the request's ROUTE PATH. That is exactly right for a menu of links
 * to other pages, and useless for a menu of `#anchor` links into the page you are already on —
 * every one of them shares the same path, and the server cannot know how far you have scrolled.
 * So in-page section highlighting is necessarily client work; this only ever touches items whose
 * href starts with `#`, leaving server-decided state on real page links untouched.
 *
 * Applies the same `is-current`/`is-active` classes the tree renderer emits, so the CSS is shared
 * and there is no second visual vocabulary to keep in sync.
 */
(function () {
  "use strict";

  var nav = document.querySelector(".docs-nav");
  if (!nav) return;

  var links = Array.prototype.filter.call(nav.querySelectorAll("a[href^='#']"), function (a) {
    return a.getAttribute("href").length > 1;
  });
  if (links.length === 0) return;

  var targets = links
    .map(function (link) {
      var el = document.getElementById(decodeURIComponent(link.getAttribute("href").slice(1)));
      return el ? { link: link, el: el } : null;
    })
    .filter(Boolean);
  if (targets.length === 0) return;

  /**
   * Clear everything, then mark the current item and its ancestors.
   *
   * Deliberately two passes rather than one toggle-per-target loop. In a single pass each sibling
   * also toggles the SHARED parent, so a later sibling's `false` wipes the `is-active` the current
   * item just set — which made the highlight work only when the current item happened to be the
   * last child of its section, and silently fail for every first or middle child.
   */
  function setActive(entry) {
    nav.querySelectorAll(".menu-item.is-current, .menu-item.is-active").forEach(function (li) {
      li.classList.remove("is-current", "is-active");
    });
    nav.querySelectorAll("a[aria-current]").forEach(function (a) {
      a.removeAttribute("aria-current");
    });
    if (!entry) return;

    // setAttribute, NOT toggleAttribute: the latter writes `aria-current=""`, which is both
    // meaningless to a screen reader and misses the theme's own `[aria-current="page"]` rule.
    entry.link.setAttribute("aria-current", "page");
    var li = entry.link.closest(".menu-item");
    if (li) li.classList.add("is-current");
    // Walk every enclosing section, not just the immediate one, so nesting deeper than two levels
    // keeps the whole path to the current item open.
    var ancestor = li && li.parentElement ? li.parentElement.closest(".menu-item") : null;
    while (ancestor) {
      ancestor.classList.add("is-active");
      ancestor = ancestor.parentElement ? ancestor.parentElement.closest(".menu-item") : null;
    }
  }

  // A click scrolls the page, which fires the observer mid-flight and lands the highlight on
  // whichever heading the scroll happened to pass through — so a click on "Color modes" would end
  // up highlighting the next section instead. The click sets the answer directly and holds the
  // observer off until the scroll settles.
  var lockedUntil = 0;

  // `rootMargin`'s large negative bottom means a heading counts as "current" once it reaches the
  // upper band of the viewport, rather than the moment it appears at the very bottom.
  var observer = new IntersectionObserver(
    function (entries) {
      if (Date.now() < lockedUntil) return;
      var visible = entries.filter(function (e) {
        return e.isIntersecting;
      });
      if (visible.length === 0) return;
      var top = visible.reduce(function (a, b) {
        return a.boundingClientRect.top < b.boundingClientRect.top ? a : b;
      });
      var match = targets.filter(function (t) {
        return t.el === top.target;
      })[0];
      if (match) setActive(match);
    },
    { rootMargin: "-88px 0px -70% 0px", threshold: 0 }
  );

  targets.forEach(function (t) {
    observer.observe(t.el);
  });

  // Clicking a link whose section is ALREADY on screen produces no intersection change at all, so
  // the observer alone would leave the highlight on the previous section — the one case a reader is
  // most likely to notice, since they just clicked. Set it directly and hold the observer off while
  // the jump settles; it resumes on the next scroll.
  targets.forEach(function (t) {
    t.link.addEventListener("click", function () {
      lockedUntil = Date.now() + 700;
      setActive(t);
    });
  });
})();
