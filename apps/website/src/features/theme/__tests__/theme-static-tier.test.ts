import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTheme } from "../theme.js";

/**
 * @file `loadTheme()`'s static tier — the one tier that ships complete `pages/*.html` documents plus
 * root partials instead of a `templates/` route map, and whose loading therefore shares no branch
 * with any other tier.
 *
 * These certify the tier GATE as much as the reading: a static theme must be exempt from the
 * home+entry template requirement every other tier is held to, and a non-static theme must get no
 * pages, partials, or light tokens even when files with those exact names sit in its folder.
 */

const STATIC_THEMES_DIR = path.join(process.cwd(), "content/themes/static");

function makeStaticThemeDir(
  files: Record<string, string>,
  tier = "static",
  manifestExtra: Record<string, unknown> = {}
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tovu-static-theme-"));
  fs.writeFileSync(
    path.join(dir, "theme.json"),
    JSON.stringify({ id: "t", name: "T", version: "1.0.0", tier, engine: 1, ...manifestExtra }),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "tokens.json"), "{}", "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

test("the real static/basic theme loads valid with its pages, partials, light tokens and css", () => {
  const theme = loadTheme({
    themeDir: path.join(STATIC_THEMES_DIR, "tovu-theme"),
    id: "tovu-theme",
    source: "built-in",
  });

  assert.deepEqual(theme.errors, []);
  assert.equal(theme.status, "valid");
  assert.ok(theme.pages.index, "pages are keyed by filename minus .html");
  assert.ok(theme.pages["blog-post"]);
  // nav.html, footer.html and the footer-* variant are picked up from the theme ROOT, not pages/.
  assert.deepEqual(Object.keys(theme.partials).sort(), ["footer", "footer-minimal", "nav"]);
  assert.ok(Object.keys(theme.tokensLight).length > 0, "tokens.light.json is read for this tier");
  assert.ok(theme.css.length > 0, "static css comes from css/styles.css, not a root styles.css");
});

test("a static theme is exempt from the home+entry template requirement", () => {
  // Every other tier fails without templates/home + templates/entry. A static theme has no
  // templates/ route map at all, so holding it to that check would fail every static theme.
  const dir = makeStaticThemeDir({ "pages/index.html": "<html></html>" });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.deepEqual(theme.errors, []);
  assert.equal(theme.status, "valid");
});

test("a static theme with no pages/index.html is invalid", () => {
  const dir = makeStaticThemeDir({ "pages/about.html": "<html></html>" });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.equal(theme.status, "invalid");
  assert.ok(theme.errors.includes("pages/index.html is required"));
  assert.ok(theme.pages.about, "the readable pages are still returned alongside the error");
});

test("a missing tokens.light.json is not an error — the theme just has no light variant", () => {
  const dir = makeStaticThemeDir({ "pages/index.html": "<html></html>" });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.deepEqual(theme.errors, []);
  assert.deepEqual(theme.tokensLight, {});
});

test("a malformed tokens.light.json is reported without losing the rest of the theme", () => {
  const dir = makeStaticThemeDir({
    "pages/index.html": "<html></html>",
    "nav.html": "<nav></nav>",
    "tokens.light.json": "{ not json",
  });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.equal(theme.status, "invalid");
  assert.ok(theme.errors.some((e) => e.startsWith("tokens.light.json:")));
  assert.ok(theme.pages.index, "pages still load");
  assert.ok(theme.partials.nav, "partials still load");
});

test("a non-static theme gets no pages, partials or light tokens even when those files exist", () => {
  // The tier gate, asserted from the outside: these files are present on disk and must be ignored,
  // because only the static tier has any renderer that knows what to do with them.
  const dir = makeStaticThemeDir(
    {
      "pages/index.html": "<html></html>",
      "nav.html": "<nav></nav>",
      "tokens.light.json": JSON.stringify({ "--bg": "#fff" }),
      "templates/home.json": "{}",
      "templates/entry.json": "{}",
    },
    "declarative"
  );
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.deepEqual(theme.errors, []);
  assert.deepEqual(theme.pages, {});
  assert.deepEqual(theme.partials, {});
  assert.deepEqual(theme.tokensLight, {});
});

/**
 * The load-time content-marker guard (2026-08-11 owner decision, `ADS-memory/reports/continuity/
 * 2026-08-11-pages-template-decisions.md`, extended by the same-day unification — `ADS-memory/
 * reports/design/2026-08-11-unified-content-marker-and-templates.md`): a declared `templates` entry
 * that ships no `"content"` slot renders a structurally fine page with its actual content silently
 * missing — caught here, at load, rather than on a visitor's page view.
 *
 * Was two symmetric checks (`pageTemplate`/`"content"` and `postTemplate`/`"post"`) before the
 * unification collapsed both the manifest array and the marker type into one of each — now there is
 * only one field and one marker to check, so `validateTemplateDeclarations` (`theme.ts`) dropped its
 * `fieldName`/`slotMarkerType` parameters entirely rather than keeping them for a single always-the-
 * same-value caller.
 */
test("a templates entry naming a file that does not exist is invalid, naming the entry", () => {
  const dir = makeStaticThemeDir({ "pages/index.html": "<html></html>" }, "static", {
    templates: ["missing-shell.html"],
  });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.equal(theme.status, "invalid");
  assert.ok(theme.errors.includes("theme.json templates entry 'missing-shell.html' has no matching pages/missing-shell.html file"));
});

test("a templates entry whose file has no {\"type\":\"content\"} marker is invalid, naming the file", () => {
  const dir = makeStaticThemeDir(
    {
      "pages/index.html": "<html></html>",
      "pages/page-shell.html": "<html><body><p>No content slot here</p></body></html>",
    },
    "static",
    { templates: ["page-shell.html"] }
  );
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.equal(theme.status, "invalid");
  assert.ok(
    theme.errors.includes('pages/page-shell.html is declared in theme.json templates but has no {"type":"content"} marker')
  );
});

test("a templates entry whose file DOES carry a content marker loads valid", () => {
  const dir = makeStaticThemeDir(
    {
      "pages/index.html": "<html></html>",
      "pages/page-shell.html": "<html><body><div data-embed-config='{\"type\":\"content\"}'></div></body></html>",
    },
    "static",
    { templates: ["page-shell.html"] }
  );
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.deepEqual(theme.errors, []);
  assert.equal(theme.status, "valid");
});

test("two templates entries are each checked independently — one bad entry does not hide the other's error", () => {
  const dir = makeStaticThemeDir(
    {
      "pages/index.html": "<html></html>",
      "pages/blog-post.html": "<html><body><div data-embed-config='{\"type\":\"content\"}'></div></body></html>",
      "pages/slotless.html": "<html><body><p>No content slot here</p></body></html>",
    },
    "static",
    { templates: ["blog-post.html", "slotless.html"] }
  );
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.equal(theme.status, "invalid");
  assert.ok(theme.errors.includes('pages/slotless.html is declared in theme.json templates but has no {"type":"content"} marker'));
});

test("a legacy postTemplate/pageTemplate manifest field is silently ignored — no back-compat alias", () => {
  // 2026-08-11 owner's standing rule: strictness over compat code. A manifest that still carries the
  // retired field names loads with no templates at all, same as one that never declared any — this is
  // exactly what `check:embed-marker-drift` (not `loadTheme`) exists to catch and report loudly.
  const dir = makeStaticThemeDir({ "pages/index.html": "<html></html>" }, "static", {
    postTemplate: ["blog-post.html"],
    pageTemplate: ["page-shell.html"],
  });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.deepEqual(theme.errors, [], "an unrecognized manifest key is not itself a load error");
  assert.equal(theme.status, "valid");
  assert.equal(theme.manifest.templates, undefined, "the retired field names are not read into `templates`");
});

test("a theme declaring no templates at all is unaffected by the guard", () => {
  const dir = makeStaticThemeDir({ "pages/index.html": "<html></html>" });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.deepEqual(theme.errors, []);
  assert.equal(theme.status, "valid");
});

test("a defaultMode not listed in modes fails the theme loudly instead of silently rendering the base :root block", () => {
  // Characterization test written for the loadTheme complexity-reduction refactor (2026-08-20) —
  // this cross-field check (now validateManifestCrossFields/validateCompiledBuildManifest) had no
  // direct test anywhere in this suite before, confirmed by c8 line coverage on theme.ts.
  const dir = makeStaticThemeDir({ "pages/index.html": "<html></html>" }, "static", {
    modes: ["dark"],
    defaultMode: "light",
  });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.equal(theme.status, "invalid");
  assert.ok(
    theme.errors.includes("theme.json defaultMode 'light' is not listed in modes [dark]"),
    `expected the defaultMode error, got: ${JSON.stringify(theme.errors)}`
  );
});

test("a defaultMode listed in modes loads valid — the positive side of the same check", () => {
  const dir = makeStaticThemeDir({ "pages/index.html": "<html></html>" }, "static", {
    modes: ["dark", "light"],
    defaultMode: "light",
  });
  const theme = loadTheme({ themeDir: dir, id: "t", source: "site" });

  assert.deepEqual(theme.errors, []);
  assert.equal(theme.status, "valid");
  assert.equal(theme.manifest.defaultMode, "light");
});
