import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import express from "express";
import type { NextFunction, Request, Response } from "express";

import { discoverAllBuiltInThemes } from "#src/features/theme/index";
import { startTestServer } from "#src/server/__tests__/helpers/http-test-server";
import { registerAdminThemeDetailRoute, registerAdminThemeFileRenameRoute } from "../explore.js";
import type { ContentRouteDeps } from "../../content/deps.js";
import { InMemoryPostRepo } from "#src/features/post/index";

/**
 * @file 2026-08-19 architecture audit finding 2: `fileGroup`/`REQUIRED_THEME_FILES` in `explore.ts`
 * only ever recognized v1's flat `pages/`/root-`.html`-partial layout. Every real static theme on
 * disk today (`content/themes/static/basic` and its six siblings) is `apiVersion: 2`, whose pages live
 * under `render/pages/` and partials under `render/partials/` — both fell into the `other` group
 * (unclassified, read-only, preview shows raw content) before this fix.
 *
 * Runs against the REAL `basic` theme on disk (`content/themes`), not a synthetic fixture, so this
 * exercises the exact layout every operator actually sees, not a hand-built stand-in that could
 * encode the same wrong assumption the bug did.
 */

const WORKSPACE_ID = "ws-v2-explore";
const REAL_THEMES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../../../../../../../../content/themes");

function buildTestApp(): express.Express {
  const themes = discoverAllBuiltInThemes({ dir: REAL_THEMES_DIR, source: "built-in" });
  const deps = {
    workspaceId: WORKSPACE_ID,
    authorize: async () => ({ allowed: true, reason: "matched" }),
    themes,
    themesDir: REAL_THEMES_DIR,
    // The detail route now does one `postRepo.list()` per request (slug-collision signal) — an
    // empty in-memory repo, matching this fixture's lack of any posts to collide with.
    postRepo: new InMemoryPostRepo(),
  } as unknown as ContentRouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.principal = { id: "test-principal" };
    next();
  });
  registerAdminThemeDetailRoute(app, deps);
  registerAdminThemeFileRenameRoute(app, deps);
  return app;
}

const BASE = `/api/admin/v1/workspaces/${WORKSPACE_ID}/themes/tovu-theme`;

test("the real v2 'basic' theme classifies render/pages/*.html as 'page', editable", async (t) => {
  const app = buildTestApp();
  const baseUrl = await startTestServer(app, t);

  const res = await fetch(`${baseUrl}${BASE}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { files: { path: string; group: string; readable: boolean; editable: boolean }[] };

  const about = body.files.find((f) => f.path === "render/pages/about.html");
  assert.ok(about, "render/pages/about.html must appear in the listing");
  assert.equal(about!.group, "page", `expected 'page', got '${about!.group}' -- v2 pages must not fall into 'other'`);
  assert.equal(about!.readable, true);
  assert.equal(about!.editable, true);
});

test("the real v2 'basic' theme classifies render/partials/*.html as 'partial', editable", async (t) => {
  const app = buildTestApp();
  const baseUrl = await startTestServer(app, t);

  const res = await fetch(`${baseUrl}${BASE}`);
  const body = (await res.json()) as { files: { path: string; group: string; readable: boolean; editable: boolean }[] };

  const nav = body.files.find((f) => f.path === "render/partials/nav.html");
  assert.ok(nav, "render/partials/nav.html must appear in the listing");
  assert.equal(nav!.group, "partial", `expected 'partial', got '${nav!.group}' -- v2 partials must not fall into 'other'`);
  assert.equal(nav!.readable, true);
  assert.equal(nav!.editable, true);
});

test("rename hard-blocks render/pages/index.html on a real v2 theme -- REQUIRED_THEME_FILES must track apiVersion, not just pages/index.html", async (t) => {
  const app = buildTestApp();
  const baseUrl = await startTestServer(app, t);

  const res = await fetch(`${baseUrl}${BASE}/file/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "render/pages/index.html", name: "home.html" }),
  });
  assert.equal(res.status, 409, "renaming the v2 theme's required index page must be blocked, not silently allowed");
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, "REQUIRED_FILE_LOCKED");
});
