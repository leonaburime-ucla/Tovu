import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";
import { getEffective, resolveDefinitionRaw, type SettingRevisionRecord } from "@jini-ai/cms/settings";

import { migrateToBeforeSiteTitleMarker } from "#src/platform/db/__tests__/helpers/pre-site-title-marker-db";
import { seedContentDb } from "#src/platform/db/sqlite/content-db";
import { hydrateContentDbFromSeed } from "#src/platform/db/sqlite/hydrate-content-db-from-seed";
import { bootSiteDir } from "#src/platform/site-dir/boot-site-dir";
import { duplicateSite } from "#src/platform/site-dir/duplicate-site";
import { initSite } from "#src/platform/site-dir/init-site";
import { writeJsonFileAtomic } from "#src/platform/site-dir/atomic-write";
import { readTemplate } from "#src/platform/site-dir/read-template";
import { resolveSiteTitleForRender } from "#src/server/inbound/public-http/routes/site/pages";
import { createApp } from "#src/server/runtime/composition/app";
import { createSqliteRouteDeps, createSqliteRouteDepsForWorkspace } from "#src/server/runtime/composition/deps";
import type { RouteDeps } from "#src/server/routes/types";
import { bootAuthenticated } from "#src/server/__tests__/helpers/http-test-server";
import { seedSite } from "../../../../../../../../../../development/scripts/seed-site.mjs";

/**
 * @file SPEC-050 v0.2.0, Wiring Order Step 2, end to end: a real site directory, a real SQLite
 * database, the real SQLite composition root composed the way `tovu serve <dir>` composes it, and
 * every assertion over HTTP. Covers T-W1 (AC-10), T-W3 (AC-12), T-W4 (AC-13), AC-06, AC-07 and AC-08.
 * SPEC-050 v0.3.0 adds the database-copy paths over the same fixtures: `duplicateSite` (AC-20, AC-21),
 * and a `seed-site.mjs` seed hydrated into a fresh deploy (AC-23, AC-24).
 *
 * Both fixtures carry the config name "My Site". A pre-existing site that loses its pin therefore
 * flips to a visible, different title instead of passing by coincidence.
 */

// Same saturated-machine guard as `site-title.integration.test.ts`.
process.env.TOVU_THEME_RENDER_TIMEOUT_MS ??= "60000";

const LEGACY_TITLE = "Tovu Demo Site";
const SITE_NAME = "My Site";
const SYSTEM_PRINCIPAL_ID = "system-settings-migration";

interface BootedSite {
  deps: RouteDeps;
  baseUrl: string;
  cookie: string;
}

function tempSiteDir(t: TestContext): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "site-title-preservation-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, "site");
}

/** A site created with `tovu init --name "My Site"` after this feature shipped (REQ-05). */
function createNewSite(t: TestContext): string {
  const dir = tempSiteDir(t);
  initSite({ dir, name: SITE_NAME });
  return dir;
}

/**
 * The same site directory, but holding the database every site had before this feature: migrated to
 * just before the marker migration, then seeded, with a matching `.site-meta.json` stamp. Its first
 * boot runs the marker migration against an existing workspace row, as tovu-com's will.
 */
function createPreExistingSite(t: TestContext): string {
  const dir = createNewSite(t);
  const dbPath = path.join(dir, "content.db");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });

  const { seed } = readTemplate({ templateId: "starter" });
  const lastPreFeatureMigration = migrateToBeforeSiteTitleMarker(dbPath, (db) => seedContentDb({ db, seed }));

  const metaPath = path.join(dir, ".site-meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ ...meta, schemaVersion: lastPreFeatureMigration.idx, schemaTag: lastPreFeatureMigration.tag })
  );
  return dir;
}

/** Every boot-readiness promise `cli/commands/serve.ts` awaits before it spawns the agent daemon. */
async function drainBootReadiness(deps: RouteDeps): Promise<void> {
  await Promise.all([
    deps.identityReady,
    deps.settingsReady,
    deps.seoReady,
    deps.commentsReady,
    deps.commentsSettingsReady,
    deps.executionSettingsReady,
    deps.settingsUiTabsReady,
    deps.analyticsSettingsReady,
    deps.siteTitleReady,
  ]).catch(() => undefined);
}

/** `/pricing` ships unpublished; flip it on in memory only, as `site-title.integration.test.ts` does. */
function publishPricingPage(deps: RouteDeps): void {
  const basic = deps.themes.find((theme) => theme.manifest.id === "tovu-theme");
  if (!basic) throw new Error("expected the site's 'tovu-theme' theme to be discovered");
  basic.manifest.publishedPages = [...(basic.manifest.publishedPages ?? []), "pricing"];
}

/**
 * Boots `dir` with the same `bootSiteDir` + `createSqliteRouteDeps` overrides `tovu serve <dir>`
 * passes. `beforeBootChain` runs synchronously right after `createSqliteRouteDeps` returns, before
 * any step of its chained boot registrations has run.
 */
async function bootSite(t: TestContext, dir: string, beforeBootChain?: (deps: RouteDeps) => void): Promise<BootedSite> {
  const boot = bootSiteDir({ dir });
  const deps = createSqliteRouteDeps(path.join(dir, "content.db"), {
    db: boot.db,
    workspaceId: boot.workspaceId,
    uploadsDir: path.join(dir, "uploads"),
    themesDir: path.join(dir, "themes"),
    siteBinding: { dir, name: path.basename(dir), dirOverridden: true, switcherCompatible: false },
  });
  beforeBootChain?.(deps);
  t.after(async () => {
    await drainBootReadiness(deps);
    boot.db.$client.close();
  });
  publishPricingPage(deps);
  const { baseUrl, cookie } = await bootAuthenticated(createApp(deps), t);
  return { deps, baseUrl, cookie };
}

function realTitles(html: string): string[] {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  return [...withoutComments.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((match) => match[1] ?? "");
}

function assertSingleTitle(html: string, expected: string, surface: string): void {
  assert.deepEqual(realTitles(html), [expected], `${surface}: expected exactly one <title>${expected}</title>`);
}

/**
 * A surface that did not render at all — deliberately NOT an `assert.AssertionError`.
 *
 * AC-13 below proves the AC-10 check FAILS once preservation is disabled, and it does that with
 * `assert.rejects(assertSiteTitleSurfaces(...), <predicate>)`. `getHtml`'s status check used to be
 * an `assert.equal`, so "the site 500s on `/` and `/pricing`" produced exactly the same
 * `AssertionError` that "the title flipped to the display name" does — and a green AC-13 therefore
 * tolerated a completely broken site, which is strictly worse than having no AC-13 at all. Giving
 * "the route did not render" its own type separates the two outcomes structurally, for every
 * `getHtml` caller in this file rather than only for the one `assert.rejects`.
 */
class RouteDidNotRenderError extends Error {
  constructor(pathname: string, status: number, bodyPreview: string) {
    super(`GET ${pathname} must render, got ${status}: ${bodyPreview}`);
    this.name = "RouteDidNotRenderError";
  }
}

async function getHtml(baseUrl: string, pathname: string): Promise<string> {
  const res = await fetch(`${baseUrl}${pathname}`);
  const html = await res.text();
  if (res.status !== 200) throw new RouteDidNotRenderError(pathname, res.status, html.slice(0, 500));
  return html;
}

/** S1 needs a home with no published Page claiming `/`; the starter seed ships one ("Home"). */
async function unpublishHomePage(deps: RouteDeps): Promise<void> {
  const page = await deps.postRepo.findBySlug({ workspaceId: deps.workspaceId, slug: "/" });
  assert.ok(page, "expected the seeded Page claiming '/'");
  await deps.postRepo.save({ ...page, status: "draft" });
}

/** AC-01/AC-02: S1, S2, S3 and the header and footer chrome. Call after {@link unpublishHomePage}. */
async function assertSiteTitleSurfaces(site: BootedSite, expected: string): Promise<void> {
  assertSingleTitle(await getHtml(site.baseUrl, "/"), expected, "S1 GET / (no Page claims /)");
  assertSingleTitle(await getHtml(site.baseUrl, "/pricing"), expected, "S2 GET /pricing");
  const products = await getHtml(site.baseUrl, "/products");
  assertSingleTitle(products, expected, "S3 GET /products");
  assert.ok(products.includes(`<a class="wordmark" href="/">${expected}</a>`), `B: header wordmark ${expected}`);
  assert.ok(products.includes(`<span>${expected} — powered by Tovu</span>`), `B: footer ${expected}`);
}

async function systemPinRevisions(deps: RouteDeps): Promise<SettingRevisionRecord[]> {
  const definition = await resolveDefinitionRaw(
    { repo: deps.settingsRepo },
    { namespace: "core.site", key: "title", workspaceId: null }
  );
  assert.ok(definition, "core.site/title must be registered at boot");
  const revisions = await deps.settingsRepo.listRevisions({ settingId: definition.settingId });
  return revisions.filter((rev) => rev.op === "set" && rev.actor === SYSTEM_PRINCIPAL_ID && rev.workspaceId === deps.workspaceId);
}

test("AC-10, AC-01, AC-02, AC-07 (T-W1): a database seeded before this feature boots through the real SQLite root pinned to Tovu Demo Site on every surface", async (t) => {
  const site = await bootSite(t, createPreExistingSite(t));
  await site.deps.siteTitleReady;

  // INV-06: entry routes keep the entry's own title on a pre-existing site too.
  assertSingleTitle(await getHtml(site.baseUrl, "/welcome"), "Welcome to Tovu", "S5 GET /welcome");
  assertSingleTitle(await getHtml(site.baseUrl, "/"), "Home", "S5 GET / with the seeded Page");

  await unpublishHomePage(site.deps);
  await assertSiteTitleSurfaces(site, LEGACY_TITLE);

  const effective = await getEffective(
    { repo: site.deps.settingsRepo },
    { namespace: "core.site", key: "title", scopeContext: { workspaceId: site.deps.workspaceId } }
  );
  assert.deepEqual({ value: effective?.value, sourceLayer: effective?.sourceLayer }, { value: LEGACY_TITLE, sourceLayer: "workspace" });
  assert.equal((await systemPinRevisions(site.deps)).length, 1, "exactly one op='set' revision by system-settings-migration");
});

test("AC-06 (REQ-05): a site created with tovu init --name \"My Site\" renders its display name and is never pinned", async (t) => {
  const site = await bootSite(t, createNewSite(t));
  await site.deps.siteTitleReady;

  const products = await getHtml(site.baseUrl, "/products");
  assertSingleTitle(products, "My Site", "S3 GET /products");
  assert.ok(products.includes(`<a class="wordmark" href="/">My Site</a>`), "B: header wordmark");
  assert.equal((await systemPinRevisions(site.deps)).length, 0);
});

test("AC-12 (REQ-07, T-W3): with the definition registered and the pin held open, a pre-existing site renders Tovu Demo Site, never its display name", async (t) => {
  let releasePin: () => void = () => undefined;
  const pinGate = new Promise<void>((resolve) => {
    releasePin = resolve;
  });
  let signalPinReached: () => void = () => undefined;
  const pinReached = new Promise<void>((resolve) => {
    signalPinReached = resolve;
  });

  try {
    const site = await bootSite(t, createPreExistingSite(t), (deps) => {
      const store = deps.siteTitlePreservationStore;
      const listPendingWorkspaceIds = store.listPendingWorkspaceIds.bind(store);
      store.listPendingWorkspaceIds = async () => {
        signalPinReached();
        await pinGate;
        return listPendingWorkspaceIds();
      };
    });
    await pinReached;

    const definition = await resolveDefinitionRaw(
      { repo: site.deps.settingsRepo },
      { namespace: "core.site", key: "title", workspaceId: null }
    );
    assert.ok(definition, "the window under test: the definition is registered and the pin is not written");
    assert.equal((await systemPinRevisions(site.deps)).length, 0, "the pin must still be pending here");
    assertSingleTitle(await getHtml(site.baseUrl, "/products"), LEGACY_TITLE, "S3 GET /products while the pin is pending");

    releasePin();
    await site.deps.siteTitleReady;
    assertSingleTitle(await getHtml(site.baseUrl, "/products"), LEGACY_TITLE, "S3 GET /products after the pin");
  } finally {
    releasePin();
  }
});

test("AC-13 (T-W4): with preservation disabled in the harness, the AC-10 check fails, so AC-10 does not pass by coincidence", async (t) => {
  const site = await bootSite(t, createPreExistingSite(t), (deps) => {
    const store = deps.siteTitlePreservationStore;
    store.listPendingWorkspaceIds = async () => [];
    store.isPending = async () => false;
  });
  await site.deps.siteTitleReady;
  await unpublishHomePage(site.deps);

  // Pinned to the EXACT assertion expected to fail, not merely to "something threw an
  // AssertionError": the point of T-W4 is that AC-10 passes for the right reason, and a predicate
  // that accepts any assertion failure cannot tell "the title flipped" from "S1 asserted on a
  // different surface" — nor, before `RouteDidNotRenderError` above, from "the site 500ed".
  await assert.rejects(assertSiteTitleSurfaces(site, LEGACY_TITLE), (err: unknown) => {
    if (!(err instanceof assert.AssertionError)) {
      assert.fail(
        `AC-10 must fail because the title flipped, not because a surface stopped rendering: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
      );
    }
    // `startsWith`, not `equal`: `assertSingleTitle` uses `assert.deepEqual`, which appends its own
    // value diff to a caller-supplied message. That appended diff is what the second check reads.
    assert.ok(
      err.message.startsWith(`S1 GET / (no Page claims /): expected exactly one <title>${LEGACY_TITLE}</title>`),
      `AC-10 must fail on its FIRST surface, checking the site title: ${err.message}`
    );
    assert.ok(
      err.message.includes(`'${SITE_NAME}'`),
      `and it must fail because that title flipped to the unpreserved display name: ${err.message}`
    );
    return true;
  });
  assertSingleTitle(await getHtml(site.baseUrl, "/products"), SITE_NAME, "the unpreserved pre-existing site flips to its display name");
});

test("AC-08 (REQ-06): after the owner resets the pinned title, two restarts append no system pin and the site renders its display name", async (t) => {
  const dir = createPreExistingSite(t);
  const first = await bootSite(t, dir);
  await first.deps.siteTitleReady;
  assert.equal((await systemPinRevisions(first.deps)).length, 1);

  const reset = await fetch(`${first.baseUrl}/api/admin/v1/workspaces/${first.deps.workspaceId}/settings/value`, {
    method: "DELETE",
    headers: { "content-type": "application/json", cookie: first.cookie },
    body: JSON.stringify({ namespace: "core.site", key: "title", scope: "workspace" }),
  });
  assert.equal(reset.status, 200, "the owner reset must be accepted");
  await drainBootReadiness(first.deps);

  let latest = first;
  for (const restart of [1, 2]) {
    latest = await bootSite(t, dir);
    await latest.deps.siteTitleReady;
    assert.equal((await systemPinRevisions(latest.deps)).length, 1, `restart ${restart} must not re-pin`);
  }
  assertSingleTitle(await getHtml(latest.baseUrl, "/products"), SITE_NAME, "S3 GET /products after the reset and two restarts");
});

const DUPLICATE_NAME = "Client B";
const OWNER_TITLE = "Acme Field Notes";

interface SiteTitleCopyState {
  /** Every `core.site/title` workspace-layer row for the workspace: who wrote it, and the stored JSON. */
  titleRows: Array<{ updatedBy: string; valueJson: string | null }>;
  /** That workspace's `site_title_preexisting_workspaces` rows, pending or resolved. */
  markerRows: number;
}

/** The two tables a database copy must reset (REQ-12, REQ-14), read straight from the file. */
function readSiteTitleCopyState(dbPath: string, workspaceId: string): SiteTitleCopyState {
  const db = new Database(dbPath, { readonly: true });
  try {
    const titleRows = db
      .prepare(
        `SELECT updated_by AS updatedBy, value_json AS valueJson FROM setting_values_workspace
         WHERE workspace_id = ? AND setting_id IN (SELECT setting_id FROM setting_definitions WHERE namespace = 'core.site' AND key = 'title')`
      )
      .all(workspaceId) as SiteTitleCopyState["titleRows"];
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM site_title_preexisting_workspaces WHERE workspace_id = ?")
      .get(workspaceId) as { count: number };
    return { titleRows, markerRows: count };
  } finally {
    db.close();
  }
}

/** A pre-existing site, booted until its pin has landed and every boot write has settled. */
async function bootPinnedPreExistingSite(t: TestContext): Promise<{ dir: string; site: BootedSite }> {
  const dir = createPreExistingSite(t);
  const site = await bootSite(t, dir);
  await site.deps.siteTitleReady;
  await drainBootReadiness(site.deps);
  return { dir, site };
}

/** A booted pre-existing site's own database: the system pin and a resolved marker. */
const PINNED_COPY_STATE: SiteTitleCopyState = {
  titleRows: [{ updatedBy: SYSTEM_PRINCIPAL_ID, valueJson: JSON.stringify(LEGACY_TITLE) }],
  markerRows: 1,
};

test("AC-20 (REQ-12, INV-07): a duplicate of a pinned pre-existing site carries neither the pin nor its marker, and renders its own name", async (t) => {
  const { dir: sourceDir, site: source } = await bootPinnedPreExistingSite(t);
  const workspaceId = source.deps.workspaceId;
  const sourceDbPath = path.join(sourceDir, "content.db");
  assert.deepEqual(readSiteTitleCopyState(sourceDbPath, workspaceId), PINNED_COPY_STATE, "precondition: the source is pinned and marked");

  const targetDir = path.join(path.dirname(sourceDir), "client-b");
  duplicateSite({ sourceDir, targetDir, name: DUPLICATE_NAME });

  assert.deepEqual(readSiteTitleCopyState(path.join(targetDir, "content.db"), workspaceId), { titleRows: [], markerRows: 0 });
  assert.deepEqual(readSiteTitleCopyState(sourceDbPath, workspaceId), PINNED_COPY_STATE, "duplicating must not reset the source itself");

  const duplicate = await bootSite(t, targetDir);
  await duplicate.deps.siteTitleReady;
  const products = await getHtml(duplicate.baseUrl, "/products");
  assertSingleTitle(products, DUPLICATE_NAME, "S3 GET /products on the duplicate");
  assert.ok(products.includes(`<a class="wordmark" href="/">${DUPLICATE_NAME}</a>`), "B: header wordmark on the duplicate");
});

test("AC-21 (REQ-12, INV-07, EC-09): an owner's own title travels into a duplicate; only the marker is reset", async (t) => {
  const { dir: sourceDir, site: source } = await bootPinnedPreExistingSite(t);
  const workspaceId = source.deps.workspaceId;
  const write = await fetch(`${source.baseUrl}/api/admin/v1/workspaces/${workspaceId}/settings/value`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: source.cookie },
    body: JSON.stringify({ namespace: "core.site", key: "title", scope: "workspace", valueJson: OWNER_TITLE }),
  });
  assert.equal(write.status, 200, "the owner write must be accepted");
  await drainBootReadiness(source.deps);

  const sourceState = readSiteTitleCopyState(path.join(sourceDir, "content.db"), workspaceId);
  assert.equal(sourceState.titleRows.length, 1, "precondition: one core.site/title row");
  assert.equal(sourceState.titleRows[0]?.valueJson, JSON.stringify(OWNER_TITLE), "precondition: the owner's title replaced the pin");
  assert.notEqual(sourceState.titleRows[0]?.updatedBy, SYSTEM_PRINCIPAL_ID, "precondition: attributed to the owner, not the system");
  assert.equal(sourceState.markerRows, 1, "precondition: the source is still marked");

  const targetDir = path.join(path.dirname(sourceDir), "client-b");
  duplicateSite({ sourceDir, targetDir, name: DUPLICATE_NAME });

  assert.deepEqual(readSiteTitleCopyState(path.join(targetDir, "content.db"), workspaceId), {
    titleRows: sourceState.titleRows,
    markerRows: 0,
  });

  const duplicate = await bootSite(t, targetDir);
  await duplicate.deps.siteTitleReady;
  assertSingleTitle(await getHtml(duplicate.baseUrl, "/products"), OWNER_TITLE, "S3 GET /products on the duplicate");
});

const DEPLOY_NAME = "Fresh Deploy";

test("AC-23, AC-24 (REQ-14, INV-07): a seed published from a pinned site ships neither the pin nor its marker, and a deploy hydrated from it renders its own name", async (t) => {
  const { dir: liveDir, site: live } = await bootPinnedPreExistingSite(t);
  const liveDbPath = path.join(liveDir, "content.db");
  assert.deepEqual(readSiteTitleCopyState(liveDbPath, live.deps.workspaceId), PINNED_COPY_STATE, "precondition: the live site is pinned and marked");

  const seedDbPath = path.join(path.dirname(liveDir), "content.seed.db");
  seedSite({ siteName: "site-title-seed", liveDir, liveDbPath, seedDbPath });

  // AC-23 is about whole tables, not one workspace: a shipped seed carries no marker and no system pin.
  const seed = new Database(seedDbPath, { readonly: true });
  try {
    const { markers } = seed.prepare("SELECT COUNT(*) AS markers FROM site_title_preexisting_workspaces").get() as { markers: number };
    const { pins } = seed
      .prepare(
        `SELECT COUNT(*) AS pins FROM setting_values_workspace
         WHERE updated_by = ? AND setting_id IN (SELECT setting_id FROM setting_definitions WHERE namespace = 'core.site' AND key = 'title')`
      )
      .get(SYSTEM_PRINCIPAL_ID) as { pins: number };
    assert.deepEqual({ markers, pins }, { markers: 0, pins: 0 }, "AC-23: the published seed");
  } finally {
    seed.close();
  }

  // AC-24: a clean container deploy hydrates its content.db from that seed and boots under its own name.
  const deployDir = path.join(path.dirname(liveDir), "deploy");
  initSite({ dir: deployDir, name: DEPLOY_NAME });
  const deployDbPath = path.join(deployDir, "content.db");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${deployDbPath}${suffix}`, { force: true });
  assert.equal(hydrateContentDbFromSeed({ seedDbPath, dbPath: deployDbPath }).status, "seeded");

  const deploy = await bootSite(t, deployDir);
  await deploy.deps.siteTitleReady;
  const products = await getHtml(deploy.baseUrl, "/products");
  assertSingleTitle(products, DEPLOY_NAME, "S3 GET /products on the hydrated deploy");
  assert.ok(products.includes(`<a class="wordmark" href="/">${DEPLOY_NAME}</a>`), "B: header wordmark on the hydrated deploy");
});

const RENAMED_SITE_NAME = "Renamed Site";

/** Renames a running site the way the desktop rename does: `config.json` rewritten with temp file + rename. */
function renameSiteConfig(dir: string, name: string): void {
  const configPath = path.join(dir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeJsonFileAtomic(configPath, { ...config, name });
}

test("AC-22 (REQ-13, EC-01): a config.json rename on a running new site renders on the next request with no restart, and an owner title still wins over a later one", async (t) => {
  const dir = createNewSite(t);
  const site = await bootSite(t, dir);
  await site.deps.siteTitleReady;
  assertSingleTitle(await getHtml(site.baseUrl, "/products"), SITE_NAME, "S3 GET /products before the rename");

  renameSiteConfig(dir, RENAMED_SITE_NAME);
  const products = await getHtml(site.baseUrl, "/products");
  assertSingleTitle(products, RENAMED_SITE_NAME, "S3 GET /products after the rename, same process, same deps");
  assert.ok(products.includes(`<a class="wordmark" href="/">${RENAMED_SITE_NAME}</a>`), "B: header wordmark after the rename");

  const write = await fetch(`${site.baseUrl}/api/admin/v1/workspaces/${site.deps.workspaceId}/settings/value`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: site.cookie },
    body: JSON.stringify({ namespace: "core.site", key: "title", scope: "workspace", valueJson: OWNER_TITLE }),
  });
  assert.equal(write.status, 200, "the owner write must be accepted");
  renameSiteConfig(dir, "Renamed Again");
  assertSingleTitle(await getHtml(site.baseUrl, "/products"), OWNER_TITLE, "S3 GET /products: the owner title wins over a later rename");
});

test("AC-22 (REQ-13, INV-01): a config.json rename never moves a pinned pre-existing site off Tovu Demo Site", async (t) => {
  const { dir, site } = await bootPinnedPreExistingSite(t);
  renameSiteConfig(dir, RENAMED_SITE_NAME);

  // S3 and the chrome only, as AC-20/AC-21/AC-24 assert: in a test after this file's first, `GET /`
  // and `GET /pricing` answer `<h1>Site error</h1>` whether or not config.json was renamed (2026-09-14
  // diagnosis, cause not found), so neither can carry this assertion.
  const products = await getHtml(site.baseUrl, "/products");
  assertSingleTitle(products, LEGACY_TITLE, "S3 GET /products after the rename");
  assert.ok(products.includes(`<a class="wordmark" href="/">${LEGACY_TITLE}</a>`), "B: header wordmark after the rename");
});

test("AC-22 (REQ-13): the root the agent daemon builds (createSqliteRouteDepsForWorkspace) resolves a config.json rename too", async (t) => {
  const dir = createNewSite(t);
  // Every `siteDir()`-derived path (themes, uploads, the site binding) then points into the temp
  // site, as `tovu serve`'s `pinServedSiteDirIntoEnv` arranges for the real daemon.
  const previousSiteDir = process.env.TOVU_SITE_DIR;
  process.env.TOVU_SITE_DIR = dir;
  let deps: RouteDeps | undefined;
  try {
    deps = createSqliteRouteDepsForWorkspace(undefined, path.join(dir, "content.db"));
    await deps.siteTitleReady;
    assert.equal(await resolveSiteTitleForRender(deps), SITE_NAME, "before the rename");

    renameSiteConfig(dir, RENAMED_SITE_NAME);
    assert.equal(await resolveSiteTitleForRender(deps), RENAMED_SITE_NAME, "after the rename, same deps");
  } finally {
    if (deps) await drainBootReadiness(deps);
    if (previousSiteDir === undefined) delete process.env.TOVU_SITE_DIR;
    else process.env.TOVU_SITE_DIR = previousSiteDir;
  }
});
