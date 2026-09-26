import assert from "node:assert/strict";
import test from "node:test";

import express from "express";
import type { NextFunction, Request, Response } from "express";

import { createRouteDeps } from "#src/server/runtime/composition/app";
import { InMemoryPresentationSettingsRepo } from "#src/features/presentation/index";
import { NO_THEME_ID, type DiscoveredTheme } from "#src/features/theme/index";
import {
  createCapturingResponse,
  extractRouteHandler,
  startTestServer,
} from "#src/server/__tests__/helpers/http-test-server";
import { registerAdminPresentationPatchRoute } from "../patch-active-theme.js";
import type { ContentRouteDeps } from "../../content/deps.js";

/**
 * @file Unit-tier branch coverage for `PATCH .../presentation` (`registerAdminPresentationPatchRoute`).
 * Same bare-app + stubbed-principal + real-in-memory-repo pattern as
 * `admin/seo/__tests__/put-entry.test.ts` / this directory's own `get.test.ts`. The happy path (an
 * existing workspace, switching to a real seeded theme) is already exercised end-to-end by
 * `packet-one-routes.test.ts`; this file targets exactly what that leaves uncovered: the
 * workspace-mismatch 404, the `req.body?.activeThemeId ?? ""` fallback (which doubles as the
 * validation-error catch branch), the not-found catch branch, an unexpected repo failure, and the
 * "active theme vanished out from under a validated id" fallback (see that test's own comment for
 * why this is a real race, not dead code).
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
  registerAdminPresentationPatchRoute(app, deps);
  return app;
}

async function patch(t: import("node:test").TestContext, app: express.Express, body: unknown, path = PATH) {
  const baseUrl = await startTestServer(app, t);
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test("presentation patch: mismatched workspaceId 404s", async (t) => {
  const app = buildApp();
  const { status, json } = await patch(t, app, { activeThemeId: "tovu-theme" }, "/api/admin/v1/workspaces/not-real/presentation");
  assert.equal(status, 404);
  assert.deepEqual(json, { error: "workspace was not found" });
});

test("presentation patch: a body with no activeThemeId falls back to '' via `req.body?.activeThemeId ?? \"\"`, which is never an allowed theme id -> 400 PresentationSettingsValidationError", async (t) => {
  const app = buildApp();
  const { status, json } = await patch(t, app, {});
  assert.equal(status, 400);
  assert.deepEqual(json, { error: "theme '' is not supported" });
});

test("presentation patch: no presentation_settings row for the workspace surfaces PresentationSettingsNotFoundError as a 404, even for a validly-shaped theme id", async (t) => {
  const base = createRouteDeps();
  const app = buildApp({ presentationRepo: new InMemoryPresentationSettingsRepo([]), themes: base.themes });
  const { status, json } = await patch(t, app, { activeThemeId: "tovu-theme" });
  assert.equal(status, 404);
  assert.deepEqual(json, {
    error: `presentation settings for workspace '${WORKSPACE_ID}' were not found`,
  });
});

test("presentation patch: a theme that vanishes from `deps.themes` between validation and the post-save lookup still 200s, with empty template/page lists -- a real race (an operator's concurrent theme rescan removing the folder), not dead code: `setActiveTheme`'s own id check runs before its repo call, so the id is proven valid at validation time but `deps.themes` is read again, fresh, after the awaited save", async (t) => {
  const base = createRouteDeps();
  const themes: DiscoveredTheme[] = [...base.themes];
  const app = buildApp({
    themes,
    // `InMemoryPresentationSettingsRepo`'s methods live on its prototype, not as own properties, so
    // `{ ...base.presentationRepo, findByWorkspaceId: ... }` would silently drop `save`/`listAll` --
    // every method below explicitly calls through to the real instance instead.
    presentationRepo: {
      findByWorkspaceId: async (workspaceId: string) => {
        const existing = await base.presentationRepo.findByWorkspaceId(workspaceId);
        // Simulates a concurrent `POST .../themes/rescan` (rescan-themes.ts's `rescanThemes` mutates
        // this exact array in place via `themes.length = 0; themes.push(...)`) landing mid-request,
        // after `setActiveTheme`'s synchronous `allowed.includes(...)` check already passed but
        // before this route's own post-save `findStoredTheme(...)` lookup runs.
        themes.length = 0;
        return existing;
      },
      save: (record) => base.presentationRepo.save(record),
      listAll: () => base.presentationRepo.listAll(),
    },
  });
  const { status, json } = await patch(t, app, { activeThemeId: "tovu-theme" });
  assert.equal(status, 200, JSON.stringify(json));
  const body = json as {
    settings: { activeThemeId: string };
    activeThemeTemplates: string[];
    activeThemeStaticPageIds: string[];
  };
  assert.equal(body.settings.activeThemeId, "tovu-theme");
  assert.deepEqual(body.activeThemeTemplates, []);
  assert.deepEqual(body.activeThemeStaticPageIds, []);
});

test("presentation patch: an unexpected repo failure 500s", async (t) => {
  const base = createRouteDeps();
  const app = buildApp({
    // Same explicit-passthrough shape as the race test above -- spreading the class instance would
    // drop `findByWorkspaceId` (a prototype method) and 500 for the wrong reason (a missing method,
    // not the `save` failure this test claims to exercise).
    presentationRepo: {
      findByWorkspaceId: (workspaceId: string) => base.presentationRepo.findByWorkspaceId(workspaceId),
      save: async () => {
        throw new Error("boom");
      },
      listAll: () => base.presentationRepo.listAll(),
    },
  });
  const { status, json } = await patch(t, app, { activeThemeId: "tovu-theme" });
  assert.equal(status, 500);
  assert.deepEqual(json, { error: "internal error" });
});

test("presentation patch: workspaceId param can never actually be undefined through this app's real composition (a matched `:param` segment is always a populated string) -- its `?? \"\"` fallback is reached by calling the real handler directly, the same type-bypass technique put-entry.test.ts's own equivalent test uses", async (t) => {
  const app = buildApp();
  const handler = extractRouteHandler(app, "patch", "/api/admin/v1/workspaces/:workspaceId/presentation");

  const { res, capture } = createCapturingResponse();
  const req = { params: { workspaceId: undefined }, body: { activeThemeId: "tovu-theme" } } as unknown as Parameters<
    typeof handler
  >[0];
  await handler(req, res);
  assert.equal(capture.statusCode, 404);
  assert.deepEqual(capture.jsonBody, { error: "workspace was not found" });
});

/**
 * The write allowlist vs. the read catalogue. `patch-active-theme.ts` and `get.ts` used to pass a
 * character-for-character identical `availableThemeIds: validThemeIds(deps.themes)` — same
 * expression, same field name, same import, sibling files in one directory — while meaning two
 * different things. The write allowlist must now carry the no-theme sentinel; the read catalogue
 * must never, because it is echoed to the admin as `AdminPresentation.availableThemeIds` and feeds
 * the theme picker, where the sentinel would render as a blank card.
 *
 * Nothing in the type system, and no other gate, distinguishes them. These two tests are it.
 */

test("presentation patch: the no-theme sentinel is ACCEPTED — this is the write allowlist", async (t) => {
  const app = buildApp();
  const { status, json } = await patch(t, app, { activeThemeId: NO_THEME_ID });

  assert.equal(status, 200, "turning the theme off must be a permitted write, not a 400");
  assert.equal((json as { settings?: { activeThemeId?: string } }).settings?.activeThemeId, NO_THEME_ID);
});

test("presentation patch: the sentinel is NOT echoed into availableThemeIds — that list is the picker's catalogue", async (t) => {
  const app = buildApp();
  const { json } = await patch(t, app, { activeThemeId: NO_THEME_ID });

  const available = (json as { availableThemeIds?: string[] }).availableThemeIds ?? [];
  assert.ok(available.length > 0, "control: the catalogue must not be empty, or this test proves nothing");
  assert.equal(
    available.includes(NO_THEME_ID),
    false,
    "the sentinel in the read catalogue renders as a blank card in the admin theme picker"
  );
});

test("presentation patch: a garbage theme id is still rejected — widening the allowlist by exactly one value", async (t) => {
  // The guard against "fixed it by accepting everything". Adding the sentinel must not turn the
  // allowlist off.
  const app = buildApp();
  const { status } = await patch(t, app, { activeThemeId: "not-a-real-theme" });
  assert.equal(status, 400);
});
