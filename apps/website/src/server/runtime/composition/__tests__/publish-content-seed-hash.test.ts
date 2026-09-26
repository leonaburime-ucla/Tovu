import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteMenuRepo } from "#src/features/navigation/repo.sqlite";
import { SqlitePostRepo } from "#src/features/post/index";
import { buildPublishContentCatalog, resetPublishContentContributorsForTests } from "#src/features/publish-content/type-registry";
import type { PublishContentDeps } from "#src/features/publish-content/type-registry";
import type { RedirectsWriteDeps } from "#src/features/redirects/index";
import { openContentDb } from "#src/platform/db/sqlite/content-db";

import { installFirstPartyPublishContentTypes } from "../publish-content-manifest.js";
import { createSqlitePublishContentSeedHash } from "../publish-content-seed-hash.js";

/**
 * @file D1 against the REAL tracked seed (`sites/tovu-com/content.seed.db`, the file the Dockerfile
 * ships as `content/seed-sites/tovu-com/content.seed.db`). A "live" `content.db` is hydrated from
 * the same file exactly the way `hydrateContentDbFromSeed()` does it (a plain copy, then the
 * ordinary migrating `openContentDb()`), and the seed lookup must answer the live row's own
 * `inspect()` hash for an untouched row — and stop matching the moment the live row is edited.
 */

const SEED = join(process.cwd(), "sites/tovu-com/content.seed.db");
const WORKSPACE = "workspace-local";
const clock = { nowIso: () => "2026-09-24T00:00:00.000Z" };
const idGen = { newId: () => "id-1" };

function hydrateLive(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "seed-hash-live-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const livePath = join(dir, "content.db");
  copyFileSync(SEED, livePath);
  const db = openContentDb(livePath);
  const menuRepo = new SqliteMenuRepo(db);
  const liveDeps: PublishContentDeps = {
    workspaceId: WORKSPACE,
    clock,
    idGen,
    ports: { post: { repo: new SqlitePostRepo(db) }, menu: { repo: menuRepo, bindingRepo: undefined as never } },
  };
  return { db, liveDeps, menuRepo, handlers: buildPublishContentCatalog(liveDeps).handlerByType };
}

function seedLookup() {
  return createSqlitePublishContentSeedHash({
    seedDbPath: SEED,
    workspaceId: WORKSPACE,
    clock,
    idGen,
    redirectsWriteDeps: {} as RedirectsWriteDeps,
  });
}

test("seed lookup: an untouched live header-nav and page hash exactly as the shipped seed does", async (t) => {
  resetPublishContentContributorsForTests();
  installFirstPartyPublishContentTypes();
  const { handlers } = hydrateLive(t);
  const getSeedHash = seedLookup();

  const liveMenu = await handlers.get("menu")!.inspect("menu-header-nav");
  assert.ok(liveMenu, "precondition: the seed ships menu-header-nav");
  assert.equal(await getSeedHash({ entityType: "menu", entityId: "menu-header-nav" }), liveMenu.hash);

  const livePage = await handlers.get("page")!.inspect("post-themes");
  assert.ok(livePage, "precondition: the seed ships page post-themes");
  assert.equal(await getSeedHash({ entityType: "page", entityId: "post-themes" }), livePage.hash);
});

test("seed lookup: a live row edited since seed no longer matches, and an id the seed lacks answers null", async (t) => {
  resetPublishContentContributorsForTests();
  installFirstPartyPublishContentTypes();
  const { menuRepo, handlers } = hydrateLive(t);
  const getSeedHash = seedLookup();

  const menu = await menuRepo.findById({ workspaceId: WORKSPACE, id: "menu-header-nav" });
  assert.ok(menu);
  await menuRepo.save({ ...menu, title: `${menu.title} (edited on live)`, version: menu.version + 1 });
  const edited = await handlers.get("menu")!.inspect("menu-header-nav");

  assert.notEqual(await getSeedHash({ entityType: "menu", entityId: "menu-header-nav" }), edited!.hash);
  assert.equal(await getSeedHash({ entityType: "menu", entityId: "menu-not-in-seed" }), null);
  assert.equal(await getSeedHash({ entityType: "no-such-type", entityId: "menu-header-nav" }), null);
});

test("seed lookup: an install that ships no seed answers null for everything", async () => {
  resetPublishContentContributorsForTests();
  installFirstPartyPublishContentTypes();
  const getSeedHash = createSqlitePublishContentSeedHash({
    seedDbPath: join(tmpdir(), "no-such-dir-seed-hash", "content.seed.db"),
    workspaceId: WORKSPACE,
    clock,
    idGen,
    redirectsWriteDeps: {} as RedirectsWriteDeps,
  });
  assert.equal(await getSeedHash({ entityType: "menu", entityId: "menu-header-nav" }), null);
});
