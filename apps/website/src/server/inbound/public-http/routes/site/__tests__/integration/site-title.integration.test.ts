import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import { resolveDefinitionRaw } from "#src/features/settings/index";
import { resolveStorefrontProducts } from "#src/server/inbound/public-http/routes/site/products";
import { createApp, createRouteDeps } from "#src/server/runtime/composition/app";
import type { RouteDeps } from "#src/server/routes/types";
import { bootAuthenticated } from "#src/server/__tests__/helpers/http-test-server";

/**
 * @file SPEC-050 v0.2.0 (`core.site.title`), Wiring Order Step 1: the setting is registered with
 * the legacy literal as its default and read at every render call site. Every assertion goes over
 * real HTTP against `createApp`, one surface at a time. The defect this spec guards against
 * repeats per call site, so one representative route would prove nothing about the others.
 *
 * Since Step 2 the in-memory composition root is a new site with no site directory (EC-03): with no
 * owner value it renders `workspaces.name`. The pre-existing-site pin (AC-01/AC-02 on a pinned
 * site) is asserted against a real SQLite database in `site-title-preservation.integration.test.ts`.
 */

// Same saturated-machine guard as `seo-site-serving.test.ts`: a loaded box can push a real theme
// render past the product's 5s sandbox budget. Raised here only, never in the product default.
process.env.TOVU_THEME_RENDER_TIMEOUT_MS ??= "60000";

const LEGACY_TITLE = "Tovu Demo Site";
/** `seededWorkspace.name`, the in-memory root's no-owner-title value (REQ-05 fallback, EC-03). */
const IN_MEMORY_WORKSPACE_NAME = "Local Tovu Workspace";
const OWNER_TITLE = "Acme Field Notes";

/** Every real `<title>` text, with HTML comments stripped first (see `seo-site-serving.test.ts`'s
 *  `countRealTitleTags` for why a comment can mention the tag by name). */
function realTitles(html: string): string[] {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  return [...withoutComments.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((match) => match[1] ?? "");
}

function assertSingleTitle(html: string, expected: string, surface: string): void {
  assert.deepEqual(realTitles(html), [expected], `${surface}: expected exactly one <title>${expected}</title>`);
}

/** `/pricing` ships unpublished; flip it on in memory only, exactly as `seo-site-serving.test.ts` T045b does. */
function publishPricingPage(deps: RouteDeps): void {
  const basic = deps.themes.find((theme) => theme.manifest.id === "tovu-theme");
  if (!basic) throw new Error("expected the built-in 'tovu-theme' theme to be discovered");
  basic.manifest.publishedPages = [...(basic.manifest.publishedPages ?? []), "pricing"];
}

/** S1 needs a home with no published Page claiming `/`; the seed ships one ("Home"). */
async function unpublishHomePage(deps: RouteDeps): Promise<void> {
  const page = await deps.postRepo.findBySlug({ workspaceId: deps.workspaceId, slug: "/" });
  assert.ok(page, "expected the seeded Page claiming '/'");
  await deps.postRepo.save({ ...page, status: "draft" });
}

async function bootSite(t: TestContext): Promise<{ deps: RouteDeps; baseUrl: string; cookie: string }> {
  const deps = createRouteDeps();
  publishPricingPage(deps);
  const { baseUrl, cookie } = await bootAuthenticated(createApp(deps), t);
  await deps.siteTitleReady;
  return { deps, baseUrl, cookie };
}

async function putSiteTitle(
  site: { deps: RouteDeps; baseUrl: string; cookie: string },
  value: unknown,
  scope: "global" | "workspace" | "user" = "workspace"
): Promise<Response> {
  return fetch(`${site.baseUrl}/api/admin/v1/workspaces/${site.deps.workspaceId}/settings/value`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: site.cookie },
    body: JSON.stringify({ namespace: "core.site", key: "title", scope, valueJson: value }),
  });
}

async function getHtml(baseUrl: string, pathname: string): Promise<string> {
  const res = await fetch(`${baseUrl}${pathname}`);
  assert.equal(res.status, 200, `GET ${pathname} must render, got ${res.status}`);
  return res.text();
}

test("EC-03 (REQ-05): the in-memory root is a new site with no site directory, so S1-S3 and the header/footer chrome render workspaces.name", async (t) => {
  const site = await bootSite(t);
  await unpublishHomePage(site.deps);

  assertSingleTitle(await getHtml(site.baseUrl, "/"), IN_MEMORY_WORKSPACE_NAME, "S1 GET /");
  assertSingleTitle(await getHtml(site.baseUrl, "/pricing"), IN_MEMORY_WORKSPACE_NAME, "S2 GET /pricing");
  const products = await getHtml(site.baseUrl, "/products");
  assertSingleTitle(products, IN_MEMORY_WORKSPACE_NAME, "S3 GET /products");
  assert.ok(products.includes(`<a class="wordmark" href="/">${IN_MEMORY_WORKSPACE_NAME}</a>`), "B: header wordmark");
  assert.ok(products.includes(`<span>${IN_MEMORY_WORKSPACE_NAME} — powered by Tovu</span>`), "B: footer");
});

test("AC-03 (REQ-02, INV-06): entry routes keep the entry's own title, with and without an owner title", async (t) => {
  const site = await bootSite(t);
  assertSingleTitle(await getHtml(site.baseUrl, "/welcome"), "Welcome to Tovu", "S5 GET /welcome (no owner title)");
  assertSingleTitle(await getHtml(site.baseUrl, "/"), "Home", "S5 GET / with the seeded Page (no owner title)");

  assert.equal((await putSiteTitle(site, OWNER_TITLE)).status, 200, "the owner write must be accepted");
  assertSingleTitle(await getHtml(site.baseUrl, "/welcome"), "Welcome to Tovu", "S5 GET /welcome (owner title set)");
  assertSingleTitle(await getHtml(site.baseUrl, "/"), "Home", "S5 GET / with the seeded Page (owner title set)");
});

test("AC-04/AC-11 (REQ-02, REQ-03, T-W2): an owner title written through the generic settings route reaches every S1-S3 surface and the chrome", async (t) => {
  const site = await bootSite(t);
  await unpublishHomePage(site.deps);

  assert.equal((await putSiteTitle(site, OWNER_TITLE)).status, 200, "the owner write must be accepted");

  // `createRouteDeps()` wires no storefront catalog, so the product-detail surface needs one product.
  // `resolveStorefrontProducts` reads `deps.store` per request, so assigning it after boot is enough.
  site.deps.store = {
    listProducts: () => [{ id: "prod-site-title", slug: "prod-site-title", title: "Title Probe", price: 100, stock: 1, version: 0 }],
  } as unknown as RouteDeps["store"];
  const [product] = await resolveStorefrontProducts(site.deps);
  assert.ok(product, "expected the injected storefront product for the product-detail surface");
  const surfaces: Array<[string, string]> = [
    ["S1", "/"],
    ["S2", "/pricing"],
    ["S3", "/products"],
    ["S3", `/products/${encodeURIComponent(product.id)}`],
  ];
  for (const [surface, pathname] of surfaces) {
    const html = await getHtml(site.baseUrl, pathname);
    assertSingleTitle(html, OWNER_TITLE, `${surface} GET ${pathname}`);
    assert.ok(!html.includes(LEGACY_TITLE), `${surface} GET ${pathname} must not still carry the legacy literal anywhere`);
  }
  const products = await getHtml(site.baseUrl, "/products");
  assert.ok(products.includes(`<a class="wordmark" href="/">${OWNER_TITLE}</a>`), "B: header wordmark");
  assert.ok(products.includes(`<span>${OWNER_TITLE} — powered by Tovu</span>`), "B: footer");
});

test("AC-05 (REQ-02): an owner title is HTML-escaped in <title>", async (t) => {
  const site = await bootSite(t);
  assert.equal((await putSiteTitle(site, "Acme & Co")).status, 200);
  assertSingleTitle(await getHtml(site.baseUrl, "/products"), "Acme &amp; Co", "S3 GET /products");
});

test("AC-14 (REQ-08): a padded title is stored and rendered trimmed; a blank or over-200-character write is rejected and the previous title keeps rendering", async (t) => {
  const site = await bootSite(t);
  // `workspaceId` is load-bearing: without it the ledger returns only platform-wide revisions, never
  // a workspace value's, and the no-revision assertion below could not fail.
  const revisionCount = async () =>
    (await site.deps.settingsRepo.listRevisionsSince({ sinceSeq: 0, limit: 10_000, workspaceId: site.deps.workspaceId })).length;
  const beforeAccepted = await revisionCount();

  const accepted = await putSiteTitle(site, "  My Site  ");
  assert.equal(accepted.status, 200, "the padded owner write must be accepted");
  assert.equal(((await accepted.json()) as { value: unknown }).value, "My Site", "the stored value is the trimmed string");
  assertSingleTitle(await getHtml(site.baseUrl, "/products"), "My Site", "trimmed owner title");

  const before = await revisionCount();
  assert.equal(before, beforeAccepted + 1, "the revision count must see this workspace's value writes");
  for (const invalid of ["", "   ", "x".repeat(201)]) {
    const label = `invalid value ${JSON.stringify(invalid.slice(0, 8))} (length ${invalid.length})`;
    const res = await putSiteTitle(site, invalid);
    assert.equal(res.status, 400, `${label} must be rejected`);
    assert.deepEqual(
      await res.json(),
      { error: "value for 'core.site.title' must be 1..200 characters after trimming", code: "VALUE_VALIDATION_FAILED" },
      label
    );
    assertSingleTitle(await getHtml(site.baseUrl, "/products"), "My Site", `${label}: the previous title keeps rendering`);
  }
  assert.equal(await revisionCount(), before, "a rejected write must append no revision");
});

test("AC-15 (REQ-01): core.site/title accepts a workspace-scope write and rejects global- and user-scope writes without appending a revision", async (t) => {
  const site = await bootSite(t);
  const definition = await resolveDefinitionRaw(
    { repo: site.deps.settingsRepo },
    { namespace: "core.site", key: "title", workspaceId: null }
  );
  assert.ok(definition, "core.site/title must be registered at boot");

  // `workspaceId` is load-bearing: without it the ledger returns only platform-wide revisions, so a
  // rejected write that leaked a workspace-tagged revision would go unseen.
  const revisionCount = async () =>
    (await site.deps.settingsRepo.listRevisionsSince({ sinceSeq: 0, limit: 10_000, workspaceId: site.deps.workspaceId })).length;
  const beforeAccepted = await revisionCount();
  assert.equal((await putSiteTitle(site, OWNER_TITLE, "workspace")).status, 200, "the workspace-scope write is the one allowed shape");
  const before = await revisionCount();
  assert.equal(before, beforeAccepted + 1, "the revision count must see this workspace's value writes");

  for (const scope of ["global", "user"] as const) {
    const res = await putSiteTitle(site, OWNER_TITLE, scope);
    assert.notEqual(res.status, 200, `a ${scope}-scope write must be rejected`);
  }
  assert.equal(await revisionCount(), before, "a rejected write must append no revision");
});

test("AC-16 (REQ-09): a settings read that throws for core.site/title still renders 200 with one non-empty title", async (t) => {
  const site = await bootSite(t);
  const definition = await resolveDefinitionRaw(
    { repo: site.deps.settingsRepo },
    { namespace: "core.site", key: "title", workspaceId: null }
  );
  assert.ok(definition, "core.site/title must be registered at boot");

  const repo = site.deps.settingsRepo as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ["getWorkspaceValue", "getGlobalValue"]) {
    const original = repo[method]!.bind(repo);
    repo[method] = (...args: unknown[]) => {
      if (JSON.stringify(args).includes(definition.settingId)) throw new Error("injected core.site/title read failure");
      return original(...args);
    };
  }

  assertSingleTitle(await getHtml(site.baseUrl, "/products"), LEGACY_TITLE, "S3 GET /products under a throwing read");
});

test("AC-18 (REQ-02): the literal appears in no non-test module under apps/website/src except the site-title resolver", () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../../..");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
        if (readFileSync(full, "utf8").includes(LEGACY_TITLE)) offenders.push(path.relative(srcRoot, full));
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders.sort(), ["features/settings/site-title.ts"]);
});

test("AC-19 (REQ-02): a Liquid template's {{ site.title }} renders the owner-set title in the templated preview", async (t) => {
  const site = await bootSite(t);
  // The built-in `fashion-modern` home template writes `{{ site.title }}` into its own header brand
  // and footer, which no head contributor or chrome renderer produces, so these strings come only
  // from the Liquid data the template reads.
  const preview = async (): Promise<string> => {
    const res = await fetch(`${site.baseUrl}/theme-explore/fashion-modern/template/home`, { headers: { cookie: site.cookie } });
    assert.equal(res.status, 200, `the templated preview must render, got ${res.status}`);
    return res.text();
  };
  const liquidBrand = (title: string) => `<a class="brand" href="/">${title}</a>`;

  // Before the owner write the template shows the no-owner-title value, so the check below cannot
  // pass on a template that never reads the setting.
  assert.ok((await preview()).includes(liquidBrand(IN_MEMORY_WORKSPACE_NAME)), "Liquid brand before the owner write");

  assert.equal((await putSiteTitle(site, OWNER_TITLE)).status, 200, "the owner write must be accepted");
  const html = await preview();
  assert.ok(html.includes(liquidBrand(OWNER_TITLE)), "Liquid header brand renders the owner-set title");
  assert.ok(html.includes(`&copy; ${OWNER_TITLE}`), "Liquid footer renders the owner-set title");
  assert.ok(!html.includes(liquidBrand(IN_MEMORY_WORKSPACE_NAME)), "the no-owner-title value must be gone from the Liquid brand");
});
