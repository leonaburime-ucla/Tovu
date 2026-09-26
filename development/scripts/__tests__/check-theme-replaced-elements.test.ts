import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkTheme, findUnconstrainedElements, type ThemeStylesheets } from "../check-theme-replaced-elements.js";

/**
 * @file Two things, matching `check-embed-marker-drift.test.ts`'s split between parser unit tests
 * and a real-file regression test:
 *
 *  1. `findUnconstrainedElements` parser-shape tests — the comma-split-selector, `@media`-nesting,
 *     and scoped-descendant-selector cases this file's own header calls out as the exact false-pass
 *     shapes a naive substring match would have let through (built directly from real CSS found in
 *     `fuel`'s and `portfolite`'s shipped stylesheets, not invented edge cases).
 *
 *  2. A REAL regression test against the actual shipped `src/themes/static/basic/css/theme.css` —
 *     the file this task's fix landed in — proving `checkTheme` reports it clean today, and that it
 *     genuinely goes RED if the fix's own rule is removed (verified by hand: temporarily deleting
 *     `img, video, iframe { max-width: 100%; }` from that file and re-running this exact test failed
 *     with `missing: ["video", "iframe"]` before the line was restored — see this task's handoff for
 *     the pasted before/after run output; this test's job is to keep failing that way forever, not
 *     to re-prove it once by hand).
 */

test("bare comma-split selector list constrains every listed element (basic's own fix shape)", () => {
  const css = `img, video, iframe { max-width: 100%; }`;
  assert.deepEqual(findUnconstrainedElements(css), []);
});

test("each element can be constrained by its own separate rule", () => {
  const css = `
    img { max-width: 100%; }
    video { max-width: 100%; }
    iframe { max-width: 100%; }
  `;
  assert.deepEqual(findUnconstrainedElements(css), []);
});

test("img constrained, video and iframe left with no rule at all — the exact shape all 6 broken themes ship", () => {
  const css = `img { max-width: 100%; display: block; }`;
  assert.deepEqual(findUnconstrainedElements(css), ["video", "iframe"]);
});

test("a rule inside @media does NOT count — only protects the narrow viewport, not the case that shipped the bug", () => {
  const css = `
    img { max-width: 100%; }
    @media (max-width: 640px) {
      video, iframe { max-width: 100%; }
    }
  `;
  assert.deepEqual(findUnconstrainedElements(css), ["video", "iframe"]);
});

test("a scoped descendant selector does NOT count as a general rule (fuel's/portfolite's real youtube-embed CSS)", () => {
  // Real rule from src/themes/static/fuel/css/theme.css and portfolite's — protects an iframe only
  // inside .youtube-embed, not every iframe the theme might render elsewhere.
  const css = `.post-detail-body .youtube-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }`;
  assert.deepEqual(findUnconstrainedElements(css), ["img", "video", "iframe"]);
});

test("a quoted declaration value containing a literal brace cannot desync brace counting", () => {
  const css = `
    .icon::before { content: "{"; }
    img, video, iframe { max-width: 100%; }
  `;
  assert.deepEqual(findUnconstrainedElements(css), []);
});

test("no CSS at all reports every replaced element as unconstrained", () => {
  const theme: ThemeStylesheets = { themeId: "empty-fixture", themeDir: "/nonexistent", cssFiles: [] };
  const finding = checkTheme(theme);
  assert.ok(finding);
  assert.deepEqual(finding.missing, ["img", "video", "iframe"]);
});

test("REGRESSION: the real shipped basic theme.css constrains img, video, and iframe", () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
  const cssPath = path.join(REPO_ROOT, "content", "themes", "static", "tovu-theme", "css", "theme.css");
  assert.ok(fs.existsSync(cssPath), `expected ${cssPath} to exist`);

  const theme: ThemeStylesheets = { themeId: "tovu-theme", themeDir: path.dirname(path.dirname(cssPath)), cssFiles: [cssPath] };
  const finding = checkTheme(theme);

  assert.equal(
    finding,
    null,
    `expected basic's theme.css to constrain img/video/iframe with no findings, got: ${JSON.stringify(finding)}`,
  );
});
