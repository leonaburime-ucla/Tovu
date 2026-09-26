import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { describeRejection, markersOfType, scanEmbedMarkers, withAddedId } from "../marker.js";

/**
 * @file CANARIES for the unified `data-embed-config` marker spine (2026-08-10).
 *
 * These run against the REAL theme files on disk, not fixtures, and they exist to answer one
 * question before any consumer is rewired: does the one shared parser actually understand every
 * marker the 93 migrated theme files contain? A fixture suite can only prove the parser understands
 * markup the same author wrote for it.
 *
 * They are deliberately cheap and blunt. If a canary fails, the migration is wrong somewhere and no
 * amount of consumer-side work is worth doing yet.
 */

const THEMES = path.join(process.cwd(), "content/themes/static");
const read = (rel: string): string => readFileSync(path.join(THEMES, rel), "utf8");

/**
 * Mirrors `theme.ts`'s own `apiVersion === 2` branch (`loadStaticTierAssets`, lines ~610/629): v1
 * keeps `pages/` at the theme root plus root-level `nav.html`/`footer*.html`; v2 nests both under
 * `render/` (`theme-authoring-guide-v2.md` §3). Reading each theme's OWN `theme.json` rather than
 * hardcoding one layout keeps this canary correct for whichever schema version a theme actually
 * declares — today that is all 7 static themes on v2, but the canary should not silently start
 * lying the day a v1 theme (built-in or site-installed) exists again.
 */
function apiVersionOf(themeId: string): number | undefined {
  const manifest = JSON.parse(readFileSync(path.join(THEMES, themeId, "theme.json"), "utf8")) as { apiVersion?: number };
  return manifest.apiVersion;
}

/** A theme page's real on-disk path, relative to `THEMES`, e.g. `basic/render/pages/index.html`
 * (v2) or `basic/pages/index.html` (v1). `page` is the filename stem, no `.html`. */
function pagePath(themeId: string, page: string): string {
  const pagesDir = apiVersionOf(themeId) === 2 ? "render/pages" : "pages";
  return `${themeId}/${pagesDir}/${page}.html`;
}

/** A theme partial's real on-disk path — v2 nests partials under `render/partials/`; v1 keeps them
 * at the theme root alongside `theme.json`. `partial` is the filename stem, no `.html`. */
function partialPath(themeId: string, partial: string): string {
  const partialsDir = apiVersionOf(themeId) === 2 ? `${themeId}/render/partials` : themeId;
  return `${partialsDir}/${partial}.html`;
}

test("canary: every marker in every migrated theme file parses, with zero rejections", () => {
  // The whole point of the sweep. One unparseable marker anywhere means a broken page in production
  // AND a reference silently missing from the entry_refs index that safe-delete trusts.
  const files = [
    pagePath("tovu-theme", "index"),
    pagePath("tovu-theme", "signin"),
    pagePath("tovu-theme", "blog-sidebar-template"),
    pagePath("tovu-theme", "blog-post"),
    partialPath("tovu-theme", "nav"),
    partialPath("tovu-theme", "footer"),
    pagePath("tailark-quartz-libre", "index"),
    pagePath("tailark-quartz-libre", "blog-post"),
    pagePath("tailark-dusk", "index"),
    pagePath("tailark-quartz-dark", "index"),
  ];
  const problems: string[] = [];
  let total = 0;
  for (const file of files) {
    const { markers, rejected } = scanEmbedMarkers(read(file));
    total += markers.length;
    for (const r of rejected) problems.push(`${file} — ${describeRejection(r)}`);
  }
  assert.deepEqual(problems, [], `unparseable markers found:\n${problems.join("\n")}`);
  assert.ok(total > 20, `expected the real themes to contain many markers, found ${total}`);
});

test("canary: no theme still carries an attribute from the retired vocabularies", () => {
  // The migration is only real if the OLD spellings are gone. A file carrying both would parse fine
  // here and still render through a stale code path somewhere else.
  const retired = [
    "data-embed-type=",
    "data-embed-id=",
    "data-embed-variant=",
    "data-tovu-slot=",
    "data-slot-variant=",
    "data-nav-current=",
  ];
  const files = [pagePath("tovu-theme", "index"), partialPath("tovu-theme", "nav"), pagePath("tovu-theme", "signin"), pagePath("tailark-dusk", "index")];
  for (const file of files) {
    // Comments legitimately mention the old names; only live markup matters, so strip comments first.
    const live = read(file).replace(/<!--[\s\S]*?-->/g, "");
    for (const attr of retired) {
      assert.ok(!live.includes(attr), `${file} still carries a retired attribute: ${attr}`);
    }
  }
});

test("canary: the nav partial marker carries type, id, and its current-page key", () => {
  const { markers } = scanEmbedMarkers(read(pagePath("tovu-theme", "index")));
  const nav = markers.find((m) => m.type === "partial" && m.id === "nav");
  assert.ok(nav, "basic/index.html must reference the nav partial");
  assert.equal(nav.config.current, "index", "the current-page hint must survive the migration into config");
});

test("canary: the footer variant survived as a config key, not a lost attribute", () => {
  const { markers } = scanEmbedMarkers(read(pagePath("tovu-theme", "signin")));
  const footer = markers.find((m) => m.type === "partial" && m.id === "footer");
  assert.ok(footer, "signin.html must reference the footer partial");
  assert.equal(footer.config.variant, "minimal", "signin uses the minimal footer — losing this is a silent visual regression");
});

test("canary: the docs sidebar keeps its tree variant AND its authored fallback content", () => {
  const html = read(pagePath("tovu-theme", "blog-sidebar-template"));
  const menu = markersOfType(html, "menu")[0];
  assert.ok(menu, "the docs template must reference a menu");
  // `docs-current-page-sidebar` (2026-08-31 docs-nav restructure) — the reserved sentinel id that
  // replaced the old fixed `docs-themes-menu` literal; see `pages.ts`'s `resolveStaticMenusForRender`
  // for how the route layer resolves this one id to a different real menu per page.
  assert.equal(menu.config.id, "docs-current-page-sidebar");
  assert.equal(menu.config.variant, "tree");
  // The permissive match is load-bearing: a theme marker's inner content is a real fallback shown
  // when nothing resolves. The old widgets-pipeline regex required an EMPTY div and would have
  // silently skipped this marker entirely.
  assert.ok(menu.whole.includes("No docs menu bound yet"), "authored fallback content must be captured, not skipped");
});

test("canary: the real theme's content-slot marker carries no id, and a real id can be added without breaking the JSON", () => {
  // 2026-08-11 unification retired the `{"type":"post","id":"{{post}}"}` literal-placeholder marker
  // this canary used to pin — replaced by `{"type":"content"}` with no id at all, filled in at render
  // time by `injectCurrentEntityContentId`/`withAddedId` rather than a pre-authored placeholder
  // string. The property worth canary-testing against the real file is now the ADD-an-id path itself:
  // it must produce legal, re-parseable JSON for the theme's own real (not synthetic) marker shape.
  const html = read(pagePath("tovu-theme", "blog-post"));
  const { markers, rejected } = scanEmbedMarkers(html);
  assert.deepEqual(rejected, []);
  const content = markers.find((m) => m.type === "content");
  assert.ok(content, "the template must carry a content marker");
  assert.equal(content.id, undefined, "the theme's own authored marker carries no id — that is what makes it a template slot");

  const withId = withAddedId(content, "22222222-2222-4222-8222-222222222222");
  const { markers: reparsed, rejected: reparsedRejected } = scanEmbedMarkers(withId);
  assert.deepEqual(reparsedRejected, [], "adding an id must still produce valid, parseable JSON");
  assert.equal(reparsed[0]?.type, "content");
  assert.equal(reparsed[0]?.id, "22222222-2222-4222-8222-222222222222");
});

test("canary: other authored attributes on a marker element are preserved verbatim", () => {
  // The docs nav carries class and aria-label. A substitution that rebuilds the tag from config
  // alone would drop them — losing styling and the accessible name with no test failing elsewhere.
  const html = read(pagePath("tovu-theme", "blog-sidebar-template"));
  const menu = markersOfType(html, "menu")[0];
  assert.ok(menu.attrs.includes('class="docs-nav"'), menu.attrs);
  assert.ok(menu.attrs.includes('aria-label="Documentation"'), menu.attrs);
  assert.equal(menu.tag, "nav", "the marker's own tag must be reported so a rebuild keeps it");
});

test("canary: malformed config is REJECTED, never silently treated as an empty marker", () => {
  const cases = [
    `<div data-embed-config='{"type":"menu",}'></div>`,
    `<div data-embed-config='["type","menu"]'></div>`,
    `<div data-embed-config='{"id":"no-type-key"}'></div>`,
  ];
  for (const html of cases) {
    const { markers, rejected } = scanEmbedMarkers(html);
    assert.equal(markers.length, 0, `should not yield a marker: ${html}`);
    assert.equal(rejected.length, 1, `should report exactly one rejection: ${html}`);
    assert.ok(describeRejection(rejected[0]).length > 20, "a rejection must describe itself well enough to act on");
  }
});

test("canary: occurrence numbering is stable and 1-based, for entry_refs locators", () => {
  const html = [
    `<div data-embed-config='{"type":"menu","id":"a"}'></div>`,
    `<div data-embed-config='{"type":"menu","id":"b"}'></div>`,
  ].join("");
  const { markers } = scanEmbedMarkers(html);
  assert.deepEqual(markers.map((m) => m.occurrence), [1, 2]);
  assert.deepEqual(markers.map((m) => m.id), ["a", "b"]);
});
