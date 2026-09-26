import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import type { NextFunction, Request, Response } from "express";

import { createRouteDeps } from "#src/server/runtime/composition/app";
import { InMemoryPresentationSettingsRepo } from "#src/features/presentation/index";
import {
  createCapturingResponse,
  extractRouteHandler,
  startTestServer,
} from "#src/server/__tests__/helpers/http-test-server";
import { registerAdminPresentationGetRoute } from "../get.js";
import type { ContentRouteDeps } from "../../content/deps.js";

/**
 * @file Unit-tier branch coverage for `GET .../presentation` (`registerAdminPresentationGetRoute`).
 * Same bare-app + stubbed-principal + real-in-memory-repo pattern as
 * `admin/seo/__tests__/put-entry.test.ts` — the happy path (an existing workspace, a real seeded
 * active theme) is already exercised end-to-end by `packet-one-routes.test.ts` and
 * `SPEC-006 REQ-05`'s own presentation test; this file targets exactly the branches those leave
 * uncovered: the workspace-mismatch 404, both catch-block outcomes, and the "active theme id no
 * longer among the discovered themes" fallback.
 */

const WORKSPACE_ID = "workspace-local";
const PATH = `/api/admin/v1/workspaces/${WORKSPACE_ID}/presentation`;

function buildApp(depsOverrides: Partial<ContentRouteDeps> = {}): express.Express {
  const base = createRouteDeps();
  const deps: ContentRouteDeps = {
    workspaceId: base.workspaceId,
    authorize: async () => ({ allowed: true, reason: "matched" }),
    clock: base.clock,
    idGen: base.idGen,
    postRepo: base.postRepo,
    pluginBeforeSaveHook: base.pluginBeforeSaveHook,
    pagesHtmlStore: base.pagesHtmlStore,
    changeSets: base.changeSets,
    outbox: base.outbox,
    bus: base.bus,
    revertRegistry: base.revertRegistry,
    presentationRepo: base.presentationRepo,
    themes: base.themes,
    themesDir: base.themesDir,
    entryRepo: base.entryRepo,
    mediaRepo: base.mediaRepo,
    transformDefinitionRepo: base.transformDefinitionRepo,
    menuRepo: base.menuRepo,
    ...depsOverrides,
  };
  const app = express();
  app.use(express.json());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.principal = { id: "test-principal" };
    next();
  });
  registerAdminPresentationGetRoute(app, deps);
  return app;
}

async function get(t: import("node:test").TestContext, app: express.Express, path = PATH) {
  const baseUrl = await startTestServer(app, t);
  const res = await fetch(`${baseUrl}${path}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test("presentation get: mismatched workspaceId 404s", async (t) => {
  const app = buildApp();
  const { status, json } = await get(t, app, "/api/admin/v1/workspaces/not-real/presentation");
  assert.equal(status, 404);
  assert.deepEqual(json, { error: "workspace was not found" });
});

test("presentation get: no presentation_settings row for the workspace surfaces PresentationSettingsNotFoundError as a 404", async (t) => {
  const app = buildApp({ presentationRepo: new InMemoryPresentationSettingsRepo([]) });
  const { status, json } = await get(t, app);
  assert.equal(status, 404);
  assert.deepEqual(json, {
    error: `presentation settings for workspace '${WORKSPACE_ID}' were not found`,
  });
});

test("presentation get: an active theme id no longer among the discovered themes still 200s, with empty template/page lists", async (t) => {
  const app = buildApp({
    presentationRepo: new InMemoryPresentationSettingsRepo([
      { workspaceId: WORKSPACE_ID, activeThemeId: "totally-not-a-real-theme", updatedAt: "2026-08-20T00:00:00.000Z" },
    ]),
  });
  const { status, json } = await get(t, app);
  assert.equal(status, 200, JSON.stringify(json));
  const body = json as {
    settings: { activeThemeId: string };
    activeThemeTemplates: string[];
    activeThemeStaticPageIds: string[];
  };
  assert.equal(body.settings.activeThemeId, "totally-not-a-real-theme");
  assert.deepEqual(body.activeThemeTemplates, []);
  assert.deepEqual(body.activeThemeStaticPageIds, []);
});

test("presentation get: an unexpected repo failure 500s", async (t) => {
  const base = createRouteDeps();
  const app = buildApp({
    presentationRepo: {
      ...base.presentationRepo,
      findByWorkspaceId: async () => {
        throw new Error("boom");
      },
    },
  });
  const { status, json } = await get(t, app);
  assert.equal(status, 500);
  assert.deepEqual(json, { error: "internal error" });
});

test("presentation get: workspaceId param can never actually be undefined through this app's real composition (a matched `:param` segment is always a populated string) -- its `?? \"\"` fallback is reached by calling the real handler directly, the same type-bypass technique put-entry.test.ts's own equivalent test uses", async (t) => {
  const app = buildApp();
  const handler = extractRouteHandler(app, "get", "/api/admin/v1/workspaces/:workspaceId/presentation");

  const { res, capture } = createCapturingResponse();
  const req = { params: { workspaceId: undefined } } as unknown as Parameters<typeof handler>[0];
  await handler(req, res);
  assert.equal(capture.statusCode, 404);
  assert.deepEqual(capture.jsonBody, { error: "workspace was not found" });
});

test("presentation get: a stored retired theme id (`basic`, renamed `tovu-theme`) reports the renamed theme as active", async (t) => {
  const app = buildApp({
    presentationRepo: new InMemoryPresentationSettingsRepo([
      { workspaceId: WORKSPACE_ID, activeThemeId: "basic", updatedAt: "2026-09-26T00:00:00.000Z" },
    ]),
  });
  const { status, json } = await get(t, app);
  assert.equal(status, 200, JSON.stringify(json));
  const body = json as { settings: { activeThemeId: string }; activeThemeTemplates: string[] };
  assert.equal(body.settings.activeThemeId, "tovu-theme");
  assert.ok(body.activeThemeTemplates.length > 0, "the renamed theme's own templates must be offered");
});
