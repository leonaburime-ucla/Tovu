import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { renderHtmlPageBody } from "#src/server/inbound/public-http/http/site/render";
import { injectCurrentEntityContentId, injectPageTitle, renderStaticPage, resolveTemplate } from "../static-render.js";
import type { DiscoveredTheme, StaticMenuItem } from "../index.js";

/**
 * @file Canaries for the unified template render pipeline, against the REAL `basic` theme on disk.
 *
 * Replaces `post-template-render.canary.test.ts` + `page-template-render.canary.test.ts` (2026-08-11
 * unification). The headline property these canaries exist to prove is the one the whole unification
 * was built for: **a Post and a Page render correctly through the SAME template file**, via the SAME
 * `theme.manifest.templates` array and the SAME `{"type":"content"}` marker — not two parallel
 * pipelines that happen to look similar.
 *
 * Kept as a canary against the real, on-disk theme (not a hand-authored fixture) for the same reason
 * the predecessors were: a fixture only ever proves the code understands markup its own author wrote
 * in the same spelling. `basic`'s `theme.json`/`blog-post.html`/`blog-sidebar-template.html`/
 * `page-shell.html` are read directly off disk, so a canary failure means the render pipeline (or the
 * theme's own migration to the unified marker) is wrong, never the test's fixture.
 *
 * Pure and I/O-free beyond reading theme files: menus and the "resolved entity" arrive as pre-built
 * data, exactly as the route layer supplies them, so no DB or server is involved. The recursive
 * `"html"`-format content-splice pre-pass (guard 3) is NOT exercised here — it needs a real
 * `postRepo`/`RouteDeps`-shaped I/O and is covered directly by `pages/__tests__/
 * resolve-html-format-content-markers.test.ts` instead.
 */

const THEME_DIR = path.resolve(import.meta.dirname, "../../../../../../content/themes/static/tovu-theme");

function read(relative: string): string {
  return fs.readFileSync(path.join(THEME_DIR, relative), "utf8");
}

/** The real `basic` theme, assembled from its own files the way `loadTheme` assembles it — pages and
 * partials keyed by filename stem, manifest straight off `theme.json`. Built here rather than via
 * `loadTheme` so a canary failure can only ever mean the render pipeline changed, never the loader.
 *
 * apiVersion-branched (2026-08-18, matching `theme-pages-render.canary.test.ts`'s own `readTheme()`
 * fix, commit `7095d7de`) the same way `theme.ts`'s `pagesDirName`/`partialsDir` are: v1 keeps `pages/`
 * and root-level `nav.html`/`footer*.html`; v2 nests both under `render/`. `basic` migrated to v2
 * (`render/pages/`, `render/partials/`) after this helper was first written, so the hardcoded v1 paths
 * broke for good rather than being staging-directory flakiness — the same trap, same fix shape. */
function basicTheme(): DiscoveredTheme {
  const manifest = JSON.parse(read("theme.json")) as DiscoveredTheme["manifest"];
  const isV2 = (manifest as { apiVersion?: number }).apiVersion === 2;
  const pagesDirName = isV2 ? "render/pages" : "pages";
  const pages = Object.fromEntries(
    fs.readdirSync(path.join(THEME_DIR, pagesDirName)).map((file) => [file.replace(/\.html$/, ""), read(`${pagesDirName}/${file}`)])
  );
  const partials = isV2
    ? {
        nav: read("render/partials/nav.html"),
        footer: read("render/partials/footer.html"),
        "footer-minimal": read("render/partials/footer-minimal.html"),
      }
    : { nav: read("nav.html"), footer: read("footer.html"), "footer-minimal": read("footer-minimal.html") };
  return {
    manifest,
    dir: THEME_DIR,
    tokens: JSON.parse(read("tokens.json")),
    tokensLight: JSON.parse(read("tokens.light.json")),
    templates: {},
    liquidTemplates: {},
    handlebarsTemplates: {},
    pages,
    partials,
    css: "",
    source: "builtin",
    status: "valid",
    errors: [],
  } as unknown as DiscoveredTheme;
}

function items(...entries: Array<Partial<StaticMenuItem> & { label: string }>): StaticMenuItem[] {
  return entries.map((e) => ({ href: null, available: true, isCurrent: false, children: [], ...e }));
}

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";

/** What `resolveContentTypeEmbeds` returns for a `"doc"`-format entity, regardless of `kind` — RAW
 * data, rendered at `renderWidgetIr`'s `"post-content"` dispatch (reused unchanged for `content`, see
 * `resolver-service.ts`'s own doc). Supplied in full rather than stubbed, because `renderWidgetPostContent`
 * degrades to the same widget placeholder an UNRESOLVED embed produces when `title`/`bodyJson` are
 * missing — a canary that asserts "no placeholder anywhere" has to be fed a genuinely resolvable
 * entity or it proves nothing about the marker stage it is actually testing. */
const ENTITY_PROPS = {
  title: "Theme Authoring",
  updatedAt: "2026-08-10T21:04:48.919Z",
  bodyJson: {
    type: "doc",
    content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Menus" }] }],
  },
};

/** The route's own sequence (`pages.ts`'s `renderViaTemplate`), minus the I/O and the "html"-format
 * recursive pre-splice (not exercised by this canary — see the file header): resolve the template,
 * fill in the current entity's title and id, run the page-embed stage against a hand-built resolved
 * map, then the static-theme stage. One function for BOTH kinds now — the whole point. */
function renderThroughTemplate(
  theme: DiscoveredTheme,
  templateChoice: string | null,
  title: string,
  menus: Readonly<Record<string, readonly StaticMenuItem[]>>
): string {
  const resolution = resolveTemplate({ theme, templateChoice });
  assert.equal(resolution.kind, "template", "the real theme must offer a usable template");
  if (resolution.kind !== "template") throw new Error("unreachable");

  const withTitle = injectPageTitle(resolution.html, title);
  const withId = injectCurrentEntityContentId(withTitle, ENTITY_ID);
  const resolved = new Map([["content", new Map([[ENTITY_ID, { componentId: "post-content", props: ENTITY_PROPS }]])]]);
  const bodyResolved = renderHtmlPageBody(withId, resolved as never);
  return renderStaticPage({ theme, pageId: resolution.pageId, htmlOverride: bodyResolved, menus }) ?? "";
}

test("canary: every template in the real theme's templates array is still recognized as having a content slot", () => {
  const theme = basicTheme();
  for (const choice of theme.manifest.templates ?? []) {
    const resolution = resolveTemplate({ theme, templateChoice: choice });
    assert.equal(
      resolution.kind,
      "template",
      `${choice} must resolve to a template — a miss here sends every row referencing it to the diagnostic page at HTTP 200`
    );
  }
});

test("canary: an unset templateChoice falls back to the theme's first template, never the diagnostic page", () => {
  const resolution = resolveTemplate({ theme: basicTheme(), templateChoice: null });
  assert.equal(resolution.kind, "template");
});

test("canary: the page-embed stage leaves theme-owned markers untouched", () => {
  // The whole bug in one assertion: `partial` and `menu` belong to a LATER stage. Substituting
  // anything over them here — placeholder included — deletes the nav, sidebar, and footer.
  const theme = basicTheme();
  const template = injectCurrentEntityContentId(theme.pages["blog-sidebar-template"], ENTITY_ID);
  const out = renderHtmlPageBody(template, undefined);

  assert.ok(out.includes(`'{"type":"partial","id":"nav"`), "the nav partial marker must survive this stage");
  // `docs-current-page-sidebar` (2026-08-31 docs-nav restructure) is the reserved sentinel id the
  // template now carries in place of the old fixed `docs-themes-menu` literal — see
  // `pages.ts`'s `resolveStaticMenusForRender` for why a shared template can carry one literal id
  // and still give every doc page its own sidebar menu.
  assert.ok(out.includes(`"type":"menu","id":"docs-current-page-sidebar"`), "the docs menu marker must survive this stage");
  assert.ok(out.includes(`'{"type":"partial","id":"footer"}'`), "the footer partial marker must survive this stage");
});

test("canary: an OWNED marker with nothing resolved still degrades to the REQ-28 placeholder", () => {
  // The other half of the ownership rule. `content` IS this stage's, so an unresolvable one must not
  // be left as raw marker markup for a visitor to see — the two halves fail in opposite directions
  // and a check for only one of them would pass against a stage that substitutes nothing at all.
  const out = renderHtmlPageBody(injectCurrentEntityContentId(basicTheme().pages["blog-post"], ENTITY_ID), undefined);
  assert.ok(out.includes("widget-placeholder"), "an unresolved content embed must degrade to the placeholder");
  assert.ok(!out.includes('"type":"content"'), "and must not leave its own marker markup in the output");
});

test("canary: a POST-style template (blog-sidebar-template.html) renders nav, tree menu, footer, and body together", () => {
  // Keyed by `docs-current-page-sidebar` (2026-08-31 docs-nav restructure), the reserved sentinel
  // id the real template now carries in its menu marker — see `resolveStaticMenusForRender`'s own
  // doc. A hand-built `menus` map keyed by the OLD `docs-themes-menu` literal would no longer match
  // that marker at all, so this fixture's key has to track the template's real marker id, not name
  // a specific stored menu.
  const html = renderThroughTemplate(basicTheme(), "blog-sidebar-template.html", "Theme Authoring", {
    "menu-header-nav": items({ label: "About", href: "/about" }),
    "docs-current-page-sidebar": items({
      label: "Menus",
      href: "#menus",
      isCurrent: true,
      children: items({ label: "Menu embeds", href: "#menu-embeds" }),
    }),
  });

  assert.ok(!html.includes("widget-placeholder"), "no marker may render as an empty widget placeholder");
  assert.ok(html.includes('<nav class="main-nav"'), "the nav partial must be spliced in");
  assert.ok(html.includes('<a href="/about">About</a>'), "the header menu must resolve to real links");
  assert.ok(html.includes("<footer"), "the footer partial must be spliced in");
  assert.ok(html.includes("<h1>Theme Authoring</h1>"), "the resolved entity must render into the template's slot");
  assert.ok(html.includes('<h2 id="menus">Menus</h2>'), "including its body, with the slugified anchor id");
});

test("canary: a PAGE-style template (page-shell.html) renders through the SAME pipeline, with its own title substituted", () => {
  const html = renderThroughTemplate(basicTheme(), "page-shell.html", "Terms of Service", {
    "menu-header-nav": items({ label: "About", href: "/about" }),
  });

  assert.ok(!html.includes("widget-placeholder"), "no marker may render as an empty widget placeholder");
  assert.ok(!html.includes("{{title}}"), "the title placeholder must be gone, replaced by the real title");
  assert.ok(html.includes("<title>Terms of Service</title>"), "the real title must render into the <title> tag");
  assert.ok(html.includes('<nav class="main-nav"'), "the nav partial must be spliced in");
  assert.ok(html.includes("<footer"), "the footer partial must be spliced in");
  assert.ok(html.includes("<h1>Theme Authoring</h1>"), "the resolved entity must render into the template's content slot");
});

test("canary: a Post and a Page resolve to DIFFERENT templates by explicit choice, but through the identical resolve/render pipeline", () => {
  // The property the whole unification exists to prove — not that they render IDENTICAL output (they
  // don't; the templates differ), but that reaching that output takes the same function calls
  // (resolveTemplate -> injectPageTitle -> injectCurrentEntityContentId -> resolveHtmlPageEmbeds ->
  // renderHtmlPageBody -> renderStaticPage) regardless of which kind the row is.
  //
  // Per-post `<title>` fix (2026-08-11): `blog-post.html`/`blog-sidebar-template.html` used to carry
  // one hardcoded fixed string apiece (a disclosed limitation, asserted here as expected behavior
  // until this date) — every post sharing either template shared one tab/SEO title. Both now carry the
  // same `{{title}}` placeholder `page-shell.html` already used, so BOTH templates substitute the
  // real entity title through the identical `injectPageTitle` call — the assertion below changed from
  // "kept its own fixed title" to "substitutes", which is the exact property this test's own docstring
  // says it exists to prove.
  const theme = basicTheme();
  const postHtml = renderThroughTemplate(theme, "blog-post.html", "A Post", {});
  const pageHtml = renderThroughTemplate(theme, "page-shell.html", "A Page", {});

  assert.ok(postHtml.includes("<title>A Post</title>"), "blog-post.html now substitutes the real title, same as page-shell.html");
  assert.ok(pageHtml.includes("<title>A Page</title>"), "page-shell.html substitutes the real title");
  assert.ok(!postHtml.includes("widget-placeholder") && !pageHtml.includes("widget-placeholder"));
});

test("canary: an unresolved menu keeps the theme's authored fallback rather than blanking", () => {
  // Passing NO menus is the deleted-menu / wrong-workspace / authoring-typo case. An active theme
  // must render as it did before menus existed, never an empty nav.
  const html = renderThroughTemplate(basicTheme(), "blog-sidebar-template.html", "Theme Authoring", {});
  assert.ok(html.includes("No docs menu bound yet"), "the authored fallback content must survive");
  assert.ok(html.includes('<nav class="docs-nav"'), "and the marker element itself must survive with it");
  assert.ok(html.includes('aria-label="Documentation"'), "including its authored accessible name");
});
