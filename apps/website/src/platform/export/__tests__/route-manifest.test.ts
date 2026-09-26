import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createRouteDeps } from "#src/server/runtime/composition/app";
import { InMemoryPostRepo } from "#src/features/post/index";
import { NO_THEME_ID, type DiscoveredTheme } from "#src/features/theme/index";
import { InMemoryRedirectRepo } from "#src/features/redirects/index";
import type { RedirectRecord } from "#src/features/redirects/index";
import { buildRouteManifest, createRouteManifestReader, type RouteManifestDeps } from "../route-manifest.js";

/** Minimal hand-built {@link DiscoveredTheme} fixture — every field `buildThemePageRoutes` /
 *  `resolveActiveTheme` actually reads, with `overrides.manifest` merged shallowly over a valid
 *  base manifest rather than replaced wholesale, so a test only names the manifest fields it cares
 *  about (e.g. just `tier`). */
function makeTheme(overrides: Partial<DiscoveredTheme> & { manifest?: Partial<DiscoveredTheme["manifest"]> } = {}): DiscoveredTheme {
  const { manifest: manifestOverrides, ...rest } = overrides;
  return {
    manifest: {
      id: "hand-built-theme",
      name: "Hand-Built Theme",
      version: "1.0.0",
      tier: "static",
      engine: 1,
      ...manifestOverrides,
    },
    dir: "/tmp/hand-built-theme",
    tokens: {},
    tokensLight: {},
    templates: {},
    liquidTemplates: {},
    handlebarsTemplates: {},
    pages: {},
    partials: {},
    css: "",
    source: "site",
    status: "valid",
    errors: [],
    ...rest,
  };
}

/**
 * @file Regression coverage for `buildRouteManifest` (SPEC — static site exporter, 2026-08-15).
 *
 * Deliberately built against `server/app.ts`'s own `createRouteDeps()` fixture (the seeded demo
 * workspace/posts/theme every other route test in this repo already trusts) rather than hand-rolled
 * fakes — that fixture is real production seed data (`server/seed.ts`), so a manifest that is wrong
 * against it would also be wrong against a freshly-installed real site.
 */

/**
 * Returns a shallow copy of `theme` with `manifest.publishedPages` set to exactly `pages` — used
 * only to opt a real, disk-loaded theme fixture (the seeded "basic" theme) into the publish
 * allow-list for one test, without touching the real on-disk `theme.json`, which deliberately ships
 * no `publishedPages` (`ThemeManifest.publishedPages`'s own doc, 2026-08-30 owner correction: absent
 * means every ordinary page is unpublished by default, retroactively, for every theme on disk).
 */
function withPublishedPages(theme: DiscoveredTheme, pages: string[]): DiscoveredTheme {
  return { ...theme, manifest: { ...theme.manifest, publishedPages: pages } };
}

/** MUTATES the object `createRouteDeps()` returns rather than spreading a copy — deliberately,
 *  since 2026-08-20 (RouteDeps-narrowing pass 2): `resolveStorefrontProducts` is a closure bound to
 *  ONE object identity, at construction time, inside `createRouteDeps()` itself (same shape and same
 *  gotcha as `RouteDeps.exportSiteBound` — see that field's doc in `server/routes/types.ts`,
 *  generalized). A spread (`{ ...deps, ...overrides }`) would return a logically-overridden but
 *  DIFFERENT object identity that closure never sees; none of the overrides this file actually
 *  passes (`postRepo`) affect what `resolveStorefrontProducts` itself reads, so a spread would not
 *  have failed any assertion here today — but it would have been silently inert for a future
 *  override that DID matter, which is the exact failure mode worth refusing on principle rather than
 *  by luck. */
function baseDeps(overrides: Partial<RouteManifestDeps> = {}): RouteManifestDeps {
  const deps = createRouteDeps();
  return Object.assign(deps, overrides);
}

test("buildRouteManifest: includes home and every seeded published post/page, and does not depend on sitemap.ts", async () => {
  const manifest = await buildRouteManifest(baseDeps());

  const home = manifest.routes.find((r) => r.path === "/");
  assert.ok(home, "expected a '/' route");
  // `server/seed.ts`'s `seededPosts` now includes a `kind: "page"` row claiming "/" (2026-09-04,
  // `tovu init`'s content-owned-homepage seed) — see the dedicated test below ("a published page
  // claiming slug '/' replaces the seeded home entry...") for the mechanism this exercises against
  // real seed data instead of a hand-built fixture.
  assert.equal(home?.kind, "page");

  // `server/seed.ts`'s `seededPosts` includes a published post at slug "welcome" — asserted by
  // path+kind (not by importing `seo/sitemap.ts` in any form) so this test can never pass merely
  // because the two modules happen to agree; `buildRouteManifest` never imports `seo/sitemap.ts` at
  // all (verified by this file's import list above), so there is no seam for their behavior to leak
  // into each other through.
  const welcome = manifest.routes.find((r) => r.path === "/welcome");
  assert.ok(welcome, "expected the seeded 'welcome' post to be enumerated");
  assert.equal(welcome?.kind, "post");
});

test("buildRouteManifest: a published PostRecord with kind 'page' is enumerated with route kind 'page', not 'post'", async () => {
  const base = createRouteDeps();
  const pageRecord = {
    id: "post-kind-page-test",
    workspaceId: base.workspaceId,
    title: "A Real Page",
    slug: "a-real-page",
    bodyJson: { type: "doc", content: [] },
    status: "published" as const,
    kind: "page" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  const postRepo = new InMemoryPostRepo([pageRecord]);
  const manifest = await buildRouteManifest(baseDeps({ postRepo }));

  const route = manifest.routes.find((r) => r.path === "/a-real-page");
  assert.ok(route, "expected the published page to be enumerated");
  assert.equal(route?.kind, "page", "a PostRecord.kind of 'page' must map to ManifestRoute.kind 'page', not 'post'");
});

// Content-owned homepage (SPEC-0XX) — a `kind: "page"` row may claim the reserved "/" slug
// (`post.ts`'s `ROOT_SLUG`). The manifest always seeds a `{ path: "/", kind: "home" }` entry up
// front (this file's own `buildRouteManifest`); without folding the page's route into that seeded
// entry, `buildPostRoutes` would push a SECOND "/" entry alongside it — a duplicate, not a "//".
test("buildRouteManifest: a published page claiming slug '/' replaces the seeded home entry instead of duplicating it", async () => {
  const base = createRouteDeps();
  const rootPage = {
    id: "root-page-test",
    workspaceId: base.workspaceId,
    title: "Home",
    slug: "/",
    bodyJson: { type: "doc", content: [] },
    status: "published" as const,
    kind: "page" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  const postRepo = new InMemoryPostRepo([rootPage]);
  const manifest = await buildRouteManifest(baseDeps({ postRepo }));

  const rootRoutes = manifest.routes.filter((r) => r.path === "/");
  assert.equal(rootRoutes.length, 1, "exactly one '/' entry — never a duplicate alongside the seeded home entry");
  assert.equal(rootRoutes[0]?.kind, "page", "the '/' entry must describe the claiming page, not the generic 'home' placeholder");
  assert.equal(rootRoutes[0]?.label, "Home");
  assert.ok(!manifest.routes.some((r) => r.path === "//"), "no route path may ever be '//'");
});

test("buildRouteManifest: always includes the convention routes robots.txt/sitemap.xml/llms.txt, and reports the missing favicon/manifest route", async () => {
  const manifest = await buildRouteManifest(baseDeps());

  const robots = manifest.routes.find((r) => r.path === "/robots.txt");
  assert.ok(robots, "expected /robots.txt — no HTML page links to it, so a crawl alone would never find it");
  assert.equal(robots?.kind, "well-known");

  const sitemap = manifest.routes.find((r) => r.path === "/sitemap.xml");
  assert.ok(sitemap, "expected /sitemap.xml — always registered regardless of the sitemapEnabled setting");
  assert.equal(sitemap?.kind, "well-known");

  const llmsTxt = manifest.routes.find((r) => r.path === "/llms.txt");
  assert.ok(llmsTxt, "expected /llms.txt — no HTML page links to it, so a crawl alone would never find it (registerLlmsTxtRoute is always mounted, see modules/seo.ts)");
  assert.equal(llmsTxt?.kind, "well-known");

  assert.ok(
    manifest.skipped.some((s) => s.reason === "no-favicon-or-manifest-route"),
    "Tovu has no favicon/manifest route today — the gap must be named, not silently absent"
  );
});

test("buildRouteManifest: resolves and returns the active theme's id + on-disk dir", async () => {
  const manifest = await buildRouteManifest(baseDeps());
  assert.equal(manifest.activeTheme?.id, "tovu-theme");
  assert.ok(manifest.activeTheme?.dir.endsWith(`${path.sep}tovu-theme`));
});

test("buildRouteManifest: enumerates the active theme's own static pages, excluding index/404 and template shells", async () => {
  // seeded active theme is "basic" (server/seed.ts's seededPresentation), a static-tier theme whose
  // theme.json declares "pricing" as a real page and "page-shell"/"blog-post" as template shells
  // (theme.manifest.templates) a post picks via templateChoice, never their own route. Its real
  // theme.json ships no `publishedPages`, so "pricing" is unpublished by default — published here,
  // for this test only, via `withPublishedPages` (see that helper's own doc) so the
  // index/404/template-shell exclusion this test targets can still be proven against the theme's
  // real page content.
  const publishedBasicThemes = createRouteDeps().themes.map((t) =>
    t.manifest.id === "tovu-theme" ? withPublishedPages(t, ["pricing"]) : t
  );
  const manifest = await buildRouteManifest(baseDeps({ themes: publishedBasicThemes }));

  const pricing = manifest.routes.find((r) => r.path === "/pricing");
  assert.ok(pricing, "expected the theme's own 'pricing' static page to be enumerated");
  assert.equal(pricing?.kind, "theme-page");

  assert.equal(
    manifest.routes.some((r) => r.path === "/page-shell" || r.path === "/blog-post"),
    false,
    "a template shell (theme.manifest.templates) must never be enumerated as its own route"
  );
  assert.equal(
    manifest.routes.some((r) => r.path === "/index" || r.path === "/404"),
    false,
    "'index' is home ('/') and '404' is the not-found probe — neither is its own route"
  );
});

test("buildRouteManifest: a post that overridesThemePage wins over the theme's same-slug static page", async () => {
  const base = createRouteDeps();
  const overridingPost = {
    id: "post-override-test",
    workspaceId: base.workspaceId,
    title: "Custom Pricing",
    slug: "pricing", // collides with basic theme's pages/pricing.html
    bodyJson: { type: "doc", content: [] },
    status: "published" as const,
    kind: "post" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: new Date().toISOString(),
    version: 1,
    overridesThemePage: true,
  };
  const postRepo = new InMemoryPostRepo([overridingPost]);
  const manifest = await buildRouteManifest(baseDeps({ postRepo }));

  const pricingRoutes = manifest.routes.filter((r) => r.path === "/pricing");
  assert.equal(pricingRoutes.length, 1, "exactly one route at the shared slug, never two");
  assert.equal(pricingRoutes[0]?.kind, "post");
});

test("buildRouteManifest: a post that never decided (overridesThemePage omitted) still wins by default (tri-state, 2026-08-15)", async () => {
  const base = createRouteDeps();
  // Deliberately no `overridesThemePage` key at all — the same shape `createPost` produces for
  // every post today (see `CreatePostInput`'s own doc for why it stays absent), not a hand-picked
  // edge case. Must resolve exactly like the explicit-`true` test above: the exported manifest has
  // to agree with what the live site actually serves for this row.
  const neverDecidedPost = {
    id: "post-never-decided-test",
    workspaceId: base.workspaceId,
    title: "Custom Pricing (never decided)",
    slug: "pricing", // collides with basic theme's pages/pricing.html
    bodyJson: { type: "doc", content: [] },
    status: "published" as const,
    kind: "post" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  const postRepo = new InMemoryPostRepo([neverDecidedPost]);
  const manifest = await buildRouteManifest(baseDeps({ postRepo }));

  const pricingRoutes = manifest.routes.filter((r) => r.path === "/pricing");
  assert.equal(pricingRoutes.length, 1, "exactly one route at the shared slug, never two");
  assert.equal(pricingRoutes[0]?.kind, "post", "the new default (post wins) must apply here too, not just in the live resolver");
});

test("buildRouteManifest: a post explicitly kept at false still loses to the theme's same-slug static page (tri-state, 2026-08-15)", async () => {
  const base = createRouteDeps();
  // "pricing" ships unpublished by default on the real on-disk "basic" theme (`ThemeManifest.publishedPages`,
  // 2026-08-30 owner correction) — published here, for this test only, so the theme page actually
  // contends for the slug; otherwise `buildThemePageRoutes` skips it before `overridesThemePage` is
  // ever consulted, and the post would win vacuously rather than by the tri-state rule this test targets.
  const publishedBasicThemes = base.themes.map((t) => (t.manifest.id === "tovu-theme" ? withPublishedPages(t, ["pricing"]) : t));
  const explicitlyKeptPost = {
    id: "post-explicit-false-test",
    workspaceId: base.workspaceId,
    title: "Custom Pricing (explicitly kept theme page)",
    slug: "pricing",
    bodyJson: { type: "doc", content: [] },
    status: "published" as const,
    kind: "post" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: new Date().toISOString(),
    version: 1,
    overridesThemePage: false,
  };
  const postRepo = new InMemoryPostRepo([explicitlyKeptPost]);
  const manifest = await buildRouteManifest(baseDeps({ postRepo, themes: publishedBasicThemes }));

  const pricingRoutes = manifest.routes.filter((r) => r.path === "/pricing");
  assert.equal(pricingRoutes.length, 1, "exactly one route at the shared slug, never two");
  assert.equal(pricingRoutes[0]?.kind, "theme-page", "an explicit false is a permanent choice and must still win over the default");
});

test("buildRouteManifest: enumerates products only when the storefront actually has any", async () => {
  const withoutStore = await buildRouteManifest(baseDeps());
  assert.equal(
    withoutStore.routes.some((r) => r.kind === "product-list" || r.kind === "product"),
    false,
    "no store/commerce wired in the base fixture — no product routes should appear"
  );

  const store = {
    listProducts: () => [{ id: "mug-01", slug: "mug-01", title: "Mug", price: 1200, stock: 5, version: 1 }],
    checkout: () => ({ ok: false as const, reason: "not-found" as const, retries: 0 }),
  };
  // `store` is read only by `resolveStorefrontProducts`'s own real implementation
  // (`server/routes/site/products.ts`), never by `buildRouteManifest` directly — correctly absent
  // from `RouteManifestDeps` (2026-08-20 RouteDeps-narrowing pass 2), so `baseDeps`'s narrow
  // `Partial<RouteManifestDeps>` override param can't name it. Goes through `createRouteDeps()`
  // directly instead, mutated in place for the same closure-identity reason `baseDeps` itself now
  // mutates rather than spreads (see that function's own doc above) — `deps` here is structurally a
  // superset of `RouteManifestDeps`, so passing it to `buildRouteManifest` needs no cast.
  const deps = createRouteDeps();
  deps.store = store;
  const withStore = await buildRouteManifest(deps);
  assert.ok(withStore.routes.find((r) => r.path === "/products" && r.kind === "product-list"));
  assert.ok(withStore.routes.find((r) => r.path === "/products/mug-01" && r.kind === "product"));
});

test("buildRouteManifest: an exact-match active redirect is enumerated; a prefix rule is reported as skipped, not silently dropped", async () => {
  const now = new Date().toISOString();
  const exactRule: RedirectRecord = {
    id: "redir-exact",
    workspaceId: "workspace-local",
    matchType: "exact",
    fromPattern: "/old-page",
    toTarget: "/welcome",
    statusCode: 301,
    status: "active",
    override: false,
    priority: 0,
    source: "manual",
    createdByPrincipal: "system",
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const prefixRule: RedirectRecord = { ...exactRule, id: "redir-prefix", matchType: "prefix", fromPattern: "/old" };
  const redirectRepo = new InMemoryRedirectRepo([exactRule, prefixRule]);

  const manifest = await buildRouteManifest(baseDeps({ redirectRepo }));

  const exact = manifest.routes.find((r) => r.path === "/old-page");
  assert.ok(exact, "expected the exact-match redirect to be enumerated as a route");
  assert.equal(exact?.kind, "redirect");
  assert.equal(exact?.redirectTarget, "/welcome");
  assert.equal(exact?.redirectStatusCode, 301);

  assert.equal(
    manifest.routes.some((r) => r.path === "/old"),
    false,
    "a prefix rule matches a family of paths and must not appear as one route"
  );
  assert.ok(
    manifest.skipped.some((s) => s.reason === "non-exact-redirect" && s.detail.includes("/old")),
    "the prefix rule must be named in `skipped`, never silently absent from the report"
  );
});

test("buildRouteManifest: the not-found probe path never collides with a real enumerated route", async () => {
  const manifest = await buildRouteManifest(baseDeps());
  const probe = manifest.routes.find((r) => r.kind === "not-found");
  assert.ok(probe, "expected a not-found probe route");

  const realPaths = manifest.routes.filter((r) => r.kind !== "not-found").map((r) => r.path);
  assert.equal(realPaths.includes(probe?.path ?? ""), false);
});

test("buildRouteManifest: a non-static-tier active theme contributes no theme-page routes (buildThemePageRoutes' early return)", async () => {
  const templatedTheme = makeTheme({ manifest: { id: "templated-theme", tier: "templated" } });
  const manifest = await buildRouteManifest(baseDeps({ themes: [templatedTheme] }));

  assert.equal(manifest.activeTheme?.id, "templated-theme", "a valid non-static theme is still resolved as active");
  assert.equal(
    manifest.routes.some((r) => r.kind === "theme-page"),
    false,
    "only a static-tier theme owns pages/*.html routes to enumerate"
  );
  // The seeded post must still appear (unshadowed — a non-static theme claims no slugs).
  assert.ok(manifest.routes.find((r) => r.path === "/welcome" && r.kind === "post"));
});

test("buildRouteManifest: a static theme whose manifest omits `templates` still enumerates its pages (the `templates ?? []` fallback)", async () => {
  const themeWithNoTemplatesField = makeTheme({
    manifest: {
      id: "no-templates-field-theme", // tier defaults to "static" via makeTheme's base
      // Published explicitly — `ThemeManifest.publishedPages`'s off-by-default gate (2026-08-30
      // owner correction) is independent of the `templates ?? []` fallback this test targets; left
      // absent, the fixture's page would be excluded by the publish gate before `templates ?? []`
      // is ever reached, for a reason unrelated to what this test is proving.
      publishedPages: ["no-templates-field-theme-fallback-page"],
    },
    // A deliberately unusual slug so it cannot collide with any seeded post (the tri-state
    // overridesThemePage rule would otherwise let a same-slug post win, same as the
    // "post explicitly kept at false" test above — irrelevant to what this test targets).
    pages: { index: "<html>home</html>", "no-templates-field-theme-fallback-page": "<html>fallback</html>" },
  });
  const manifest = await buildRouteManifest(baseDeps({ themes: [themeWithNoTemplatesField] }));

  assert.equal(manifest.activeTheme?.id, "no-templates-field-theme");
  const fallbackPage = manifest.routes.find((r) => r.path === "/no-templates-field-theme-fallback-page");
  assert.ok(fallbackPage, "a real page must still be enumerated when manifest.templates is absent, not just empty");
  assert.equal(fallbackPage?.kind, "theme-page");
  assert.equal(
    manifest.routes.some((r) => r.path === "/index"),
    false,
    "'index' is home, never its own route, regardless of the templates field"
  );
});

test("buildRouteManifest: no theme discovered is a real, reportable state — 'no-theme' skip, no theme-page OR post routes, undefined activeTheme", async () => {
  // Every other test in this file trusts the seeded fixture's active theme; this is the one place
  // that deliberately removes it (`resolveActiveTheme` falls through to `deps.themes[0] ?? null`,
  // which is `null` for an empty list), exercising resolveThemeAndPostRoutes's own `!theme` branch —
  // documented at length in this module's own file header as a real state, not a crash.
  //
  // `resolveThemeAndPostRoutes` returns `{ routes: [] }` on this branch — posts are enumerated
  // TOGETHER with theme pages (the post loop needs the theme's shadowed-slug set), so losing the
  // theme loses BOTH, not just theme-owned pages. Matches this function's own skip detail string
  // verbatim: "only '/' and the 404 probe could be enumerated" — an earlier version of this test
  // wrongly asserted the seeded post still appeared, contradicting that documented contract.
  const manifest = await buildRouteManifest(baseDeps({ themes: [] }));

  assert.equal(manifest.activeTheme, undefined);
  assert.equal(
    manifest.routes.some((r) => r.kind === "theme-page" || r.kind === "post" || r.kind === "page"),
    false,
    "no theme means neither theme-owned pages nor posts can be enumerated"
  );
  assert.ok(
    manifest.skipped.some((s) => s.reason === "no-theme" && s.detail.includes("only '/' and the 404 probe")),
    "the gap must be named in skipped, not silently absent"
  );
  // robots.txt/sitemap.xml/404 are convention routes, unaffected by theme resolution — must survive.
  assert.ok(manifest.routes.some((r) => r.path === "/"));
  assert.ok(manifest.routes.some((r) => r.path === "/robots.txt"));
  assert.ok(manifest.routes.some((r) => r.kind === "not-found"));
});

test("buildRouteManifest: the 404 probe retries past a collision when a real route already claims its base slug", async () => {
  const base = createRouteDeps();
  // Deliberately the exact literal `route-manifest.ts`'s own private NOT_FOUND_PROBE_BASE uses
  // (verified against that module's source) — forces chooseNotFoundProbePath's retry-on-collision
  // loop to actually run at least once, not just pass vacuously the way every other fixture in this
  // file does (per that function's own doc: collision is "vanishingly unlikely" otherwise).
  const collidingPost = {
    id: "post-404-probe-collision-test",
    workspaceId: base.workspaceId,
    title: "Collides With The 404 Probe Slug",
    slug: "tovu-export-404-check",
    bodyJson: { type: "doc", content: [] },
    status: "published" as const,
    kind: "post" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  const postRepo = new InMemoryPostRepo([collidingPost]);
  const manifest = await buildRouteManifest(baseDeps({ postRepo }));

  const realPaths = new Set(manifest.routes.filter((r) => r.kind !== "not-found").map((r) => r.path));
  assert.ok(realPaths.has("/tovu-export-404-check"), "the colliding real post must itself be enumerated");

  const probe = manifest.routes.find((r) => r.kind === "not-found");
  assert.ok(probe, "expected a not-found probe route even with the base slug taken");
  assert.notEqual(probe?.path, "/tovu-export-404-check", "the retry loop must have appended a suffix rather than colliding");
  assert.equal(realPaths.has(probe?.path ?? ""), false, "the retried probe path must still not collide with anything real");
});

test("createRouteManifestReader: build() delegates to buildRouteManifest against the SAME bound deps, not a snapshot", async () => {
  const deps = baseDeps();
  const reader = createRouteManifestReader(deps);

  const viaReader = await reader.build();
  const viaFreeFunction = await buildRouteManifest(deps);

  assert.deepEqual(viaReader, viaFreeFunction, "the port must produce the identical manifest the free function does for the same deps");

  // "Bound", not a one-time snapshot: mutating the same deps object between calls (the established
  // in-place-mutation pattern this file's own baseDeps/store tests rely on, since createSiteApp-style
  // closures elsewhere in this composition root are bound to ONE object identity) must be visible on
  // the next build() call, proving the reader re-reads deps rather than freezing them at construction.
  const overridingPost = {
    id: "post-reader-rebind-test",
    workspaceId: deps.workspaceId,
    title: "Reader Rebind Check",
    slug: "reader-rebind-check",
    bodyJson: { type: "doc", content: [] },
    status: "published" as const,
    kind: "post" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  deps.postRepo = new InMemoryPostRepo([overridingPost]);

  const rebuilt = await reader.build();
  assert.ok(
    rebuilt.routes.some((r) => r.path === "/reader-rebind-check"),
    "the same reader instance must reflect a later mutation of the deps it was constructed with"
  );
});

test("buildRouteManifest: the theme turned OFF is a distinct skip from no theme being discovered — same reason, different detail", async (t) => {
  // Two states, two remedies. "No valid theme discovered" tells an operator something is broken and
  // to reinstall a theme; under a deliberate `NO_THEME_ID` that sentence is simply FALSE — nothing
  // is broken and there is nothing to fix. The `reason` stays `no-theme` so every existing consumer
  // of the skip list keeps working; only the human-readable `detail` distinguishes them.
  const deliberate = await buildRouteManifest(baseDeps({ resolveActiveThemeId: async () => NO_THEME_ID }));
  const discovered = await buildRouteManifest(baseDeps({ themes: [] }));

  const deliberateSkip = deliberate.skipped.find((s) => s.reason === "no-theme");
  const discoveredSkip = discovered.skipped.find((s) => s.reason === "no-theme");

  assert.ok(deliberateSkip, "turning the theme off must still be reported, not silently absent");
  assert.ok(discoveredSkip);
  assert.notEqual(
    deliberateSkip?.detail,
    discoveredSkip?.detail,
    "one shared string would tell an operator their site is broken when they turned the theme off themselves"
  );
  assert.doesNotMatch(
    deliberateSkip?.detail ?? "",
    /no valid theme discovered/,
    "the deliberate case must not claim discovery failed"
  );
  assert.equal(deliberate.activeTheme, undefined);
});
