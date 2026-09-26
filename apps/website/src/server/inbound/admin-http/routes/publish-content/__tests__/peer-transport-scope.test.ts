import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";

import { InMemoryKeyring } from "#src/features/webhooks/keyring.memory";
import { AesGcmSecretSealer } from "#src/features/webhooks/secret-sealer.aesgcm";
import { InMemoryPublishContentPeerRepo } from "#src/features/publish-content/peers";
import { CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import { collectBodyReferences } from "#src/features/publish-content/content-references";
import {
  registerPublishContentContributor,
  resetPublishContentContributorsForTests,
  type PackedEntity,
  type PublishContentContributor,
  type PublishContentHandler,
} from "#src/features/publish-content/type-registry";
import type { HttpClientPort } from "#src/platform/http/index";
import { startTestServer } from "#src/server/__tests__/helpers/http-test-server";
import type { PublishContentRouteDeps } from "../deps.js";
import { registerPublishContentPeerRoutes } from "../peers.js";
import { registerPublishContentPeerTransportRoutes } from "../peer-transport.js";

/**
 * @file `plan-publish-sections-2026-09-25.md` S1 — the `push/plan` route honours an optional `scope`
 * body field (`readPublishScope`), narrowing what is staged BEFORE the peer ever plans it (same
 * "narrow before staging, never after" property `selectedEntityKeys` already has). Two synthetic
 * contributors (`page`, `theme-files`) stand in for real ones, following `peer-transport-file-blob-
 * index.test.ts`'s registration pattern — `theme-files` is not wired to `publish-content-manifest.ts`
 * in this test's fixture, so a real registration is the only way to exercise a second type plus a
 * `listSkipped` refusal without depending on the full theme feature.
 */

const WORKSPACE_ID = "workspace-local";
const BASE = `/api/admin/v1/workspaces/${WORKSPACE_ID}/publish-content/peers`;
const API_KEY = "tovu_live_0123456789abcdef";

function entity(entityType: string, id: string): PackedEntity {
  return {
    entityType,
    id,
    schemaVersion: 1,
    contentHash: `hash-${entityType}-${id}`,
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: [],
    state: {},
  };
}

function registerFixtureContributors(): void {
  resetPublishContentContributorsForTests();

  const pageEntities = [entity("page", "p1"), entity("page", "p2")];
  const pageContributor: PublishContentContributor = {
    entityType: "page",
    dependsOn: [],
    build: () => ({
      entityType: "page",
      schemaVersion: 1,
      permission: "publish_content.read",
      dependsOn: [],
      async *pack() {
        for (const e of pageEntities) yield e;
      },
      inspect: async () => null,
      precheck: async () => null,
      apply: async () => {
        throw new Error("not exercised by this test");
      },
    }),
  };

  const themeEntities = [entity("theme-files", "static/basic")];
  const themeContributor: PublishContentContributor = {
    entityType: "theme-files",
    dependsOn: [],
    build: () => ({
      entityType: "theme-files",
      schemaVersion: 1,
      permission: "publish_content.read",
      dependsOn: [],
      async *pack() {
        for (const e of themeEntities) yield e;
      },
      async listSkipped() {
        return [
          {
            entityType: "theme-files",
            id: "static/refused",
            label: "Theme: static/refused",
            reason: "Can't publish: contains a video file (x.mp4)",
          },
        ];
      },
      inspect: async () => null,
      precheck: async () => null,
      apply: async () => {
        throw new Error("not exercised by this test");
      },
    }),
  };

  registerPublishContentContributor(pageContributor);
  registerPublishContentContributor(themeContributor);
}

function buildApp(httpClient: HttpClientPort): { app: express.Express } {
  const repo = new InMemoryPublishContentPeerRepo();
  const keyring = new InMemoryKeyring();
  let n = 0;

  const deps = {
    workspaceId: WORKSPACE_ID,
    authorize: async () => ({ allowed: true, reason: "matched" }),
    clock: { nowIso: () => "2026-09-25T00:00:00.000Z" },
    idGen: { newId: () => `peer-${++n}` },
    publishContentPeerRepo: repo,
    siteAssistantSecretSealer: new AesGcmSecretSealer(keyring),
    siteAssistantSecretKeyring: keyring,
    publishContentPeerHttpClient: httpClient,
    workspaceRepo: { findById: async () => ({ id: WORKSPACE_ID, name: "Local Site" }) },
    blobStore: { exists: async () => false, get: async () => new Uint8Array() },
    publishContentBundleRepo: { save: async () => {}, findById: async () => null },
    postRepo: {},
    outbox: {},
    pluginBeforeSaveHook: undefined,
  } as unknown as PublishContentRouteDeps;

  const app = express();
  app.use(express.json());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.principal = { id: "test-principal" };
    res.locals.authCredentialKind = "session";
    next();
  });
  registerPublishContentPeerRoutes(app, deps);
  registerPublishContentPeerTransportRoutes(app, deps);
  return { app };
}

async function createPeer(server: string) {
  return fetch(`${server}${BASE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "production",
      baseUrl: "https://tovu.example.com",
      remoteWorkspaceId: "remote-ws-9",
      apiKey: API_KEY,
    }),
  });
}

function fakePeerHttpClient(onBundle: (entities: PackedEntity[]) => void): HttpClientPort {
  return {
    send: async (request) => {
      if (request.url.includes("/capabilities")) {
        return { status: 200, headers: {}, bodyText: JSON.stringify({ entityTypes: ["page", "theme-files"], features: [] }) };
      }
      if (request.url.includes("/bundles")) {
        const body = JSON.parse(String(request.body ?? "{}")) as { entities?: PackedEntity[] };
        onBundle(body.entities ?? []);
        return { status: 201, headers: {}, bodyText: JSON.stringify({ bundleId: "remote-bundle-1" }) };
      }
      if (request.url.includes("/import/plan")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            domain: "publish_content.import",
            planId: "p1",
            planHash: "h1",
            details: { refused: false, refusalReason: null, applyOrder: [], rows: [] },
          }),
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    },
  };
}

test("push/plan with scope.entityTypes:['page'] stages only pages", async (t) => {
  registerFixtureContributors();
  t.after(() => resetPublishContentContributorsForTests());

  let stagedEntities: PackedEntity[] = [];
  const { app } = buildApp(fakePeerHttpClient((entities) => (stagedEntities = entities)));
  const server = await startTestServer(app, t);
  await createPeer(server);

  const res = await fetch(`${server}${BASE}/peer-1/push/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: { entityTypes: ["page"] } }),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  assert.deepEqual(
    stagedEntities.map((e) => e.id).sort(),
    ["p1", "p2"],
    "only page entities may be staged to the peer"
  );
});

test("a refused theme-files tree is absent from a page-scoped plan and present under its own scope", async (t) => {
  registerFixtureContributors();
  t.after(() => resetPublishContentContributorsForTests());

  const { app } = buildApp(fakePeerHttpClient(() => {}));
  const server = await startTestServer(app, t);
  await createPeer(server);

  const pageScoped = await fetch(`${server}${BASE}/peer-1/push/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: { entityTypes: ["page"] } }),
  });
  const pageBody = (await pageScoped.json()) as { details: { rows: Array<{ entityType: string }> } };
  assert.equal(
    pageBody.details.rows.some((row) => row.entityType === "theme-files"),
    false,
    "a refused theme-files row must not appear in a pages-only plan"
  );

  const themeScoped = await fetch(`${server}${BASE}/peer-1/push/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: { entityTypes: ["theme-files"] } }),
  });
  const themeBody = (await themeScoped.json()) as { details: { rows: Array<{ entityType: string; entityId: string; outcome: string }> } };
  const refusedRow = themeBody.details.rows.find((row) => row.entityId === "static/refused");
  assert.ok(refusedRow, "the refused theme tree must appear in a theme-files-scoped plan");
  assert.equal(refusedRow?.outcome, "blocked");
});

test("scope intersects with selectedEntityKeys — a key naming a type outside scope stages nothing extra", async (t) => {
  registerFixtureContributors();
  t.after(() => resetPublishContentContributorsForTests());

  let stagedEntities: PackedEntity[] = [];
  const { app } = buildApp(fakePeerHttpClient((entities) => (stagedEntities = entities)));
  const server = await startTestServer(app, t);
  await createPeer(server);

  const res = await fetch(`${server}${BASE}/peer-1/push/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: { entityTypes: ["page"] },
      selectedEntityKeys: ["page:p1", "theme-files:static/basic"],
    }),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  assert.deepEqual(stagedEntities.map((e) => e.id), ["p1"], "the theme-files key is outside scope and must not be staged");
});

test("push/plan 400s on a malformed scope.entityTypes with the exact validation text", async (t) => {
  registerFixtureContributors();
  t.after(() => resetPublishContentContributorsForTests());
  const { app } = buildApp(fakePeerHttpClient(() => {}));
  const server = await startTestServer(app, t);

  for (const scope of [{ entityTypes: [] }, { entityTypes: "page" }, { entityTypes: [1, 2] }]) {
    const res = await fetch(`${server}${BASE}/peer-1/push/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(scope)} must be refused`);
    assert.deepEqual(await res.json(), {
      error: "'scope.entityTypes' must be a non-empty array of strings",
      code: "VALIDATION_ERROR",
    });
  }
});

test("push/plan 400s on a malformed scope.entityKeys with the exact validation text", async (t) => {
  registerFixtureContributors();
  t.after(() => resetPublishContentContributorsForTests());
  const { app } = buildApp(fakePeerHttpClient(() => {}));
  const server = await startTestServer(app, t);

  for (const scope of [{ entityKeys: [] }, { entityKeys: "page:p1" }, { entityKeys: [1] }]) {
    const res = await fetch(`${server}${BASE}/peer-1/push/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(scope)} must be refused`);
    assert.deepEqual(await res.json(), {
      error: "'scope.entityKeys' must be a non-empty array of strings",
      code: "VALIDATION_ERROR",
    });
  }
});

test("push/plan 400s on a scope array over the 1000-entry cap", async (t) => {
  registerFixtureContributors();
  t.after(() => resetPublishContentContributorsForTests());
  const { app } = buildApp(fakePeerHttpClient(() => {}));
  const server = await startTestServer(app, t);

  const tooMany = Array.from({ length: 1001 }, (_, i) => `page:p${i}`);
  const res = await fetch(`${server}${BASE}/peer-1/push/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: { entityKeys: tooMany } }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "'scope.entityKeys' must be a non-empty array of strings",
    code: "VALIDATION_ERROR",
  });
});

// A scope that names no field it understands must never widen to "everything": a typo'd key
// (`types` for `entityTypes`) or a bare string would otherwise publish every section from a dialog
// the operator opened for one. Refused, and nothing is staged.
test("push/plan 400s, staging nothing, on a scope that is not an object or names neither field", async (t) => {
  registerFixtureContributors();
  t.after(() => resetPublishContentContributorsForTests());
  let stagedCount = 0;
  const { app } = buildApp(fakePeerHttpClient(() => (stagedCount += 1)));
  const server = await startTestServer(app, t);
  await createPeer(server);

  for (const scope of ["page", ["page"], {}, { types: ["page"] }]) {
    const res = await fetch(`${server}${BASE}/peer-1/push/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(scope)} must be refused`);
    assert.deepEqual(await res.json(), {
      error: "'scope' must be an object with 'entityTypes' and/or 'entityKeys'",
      code: "VALIDATION_ERROR",
    });
  }
  assert.equal(stagedCount, 0, "a refused scope must not stage anything");
});

test("push/plan treats an absent scope as 'everything' — both types are staged", async (t) => {
  registerFixtureContributors();
  t.after(() => resetPublishContentContributorsForTests());

  let stagedEntities: PackedEntity[] = [];
  const { app } = buildApp(fakePeerHttpClient((entities) => (stagedEntities = entities)));
  const server = await startTestServer(app, t);
  await createPeer(server);

  const res = await fetch(`${server}${BASE}/peer-1/push/plan`, { method: "POST" });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  assert.deepEqual(
    stagedEntities.map((e) => `${e.entityType}:${e.id}`).sort(),
    ["page:p1", "page:p2", "theme-files:static/basic"]
  );
});

/**
 * Owner decision 2026-09-25 — "images go along with pages and posts". A pages-scoped push stages the
 * media its pages reference (and only those), and the report shows a carried-along media row ONLY
 * when live would change — created or updated — tagged with the pages that use it.
 */
function registerPagesWithMedia(): void {
  resetPublishContentContributorsForTests();
  const withState = (entityType: string, id: string, state: Record<string, unknown>): PackedEntity => ({
    ...entity(entityType, id),
    state,
  });
  const fixture = (
    entityType: string,
    dependsOn: string[],
    rows: PackedEntity[],
    references?: PublishContentHandler["references"]
  ): PublishContentContributor => ({
    entityType,
    dependsOn,
    build: () => ({
      entityType,
      schemaVersion: 1,
      permission: "publish_content.read",
      dependsOn,
      ...(references ? { references } : {}),
      async *pack() {
        for (const e of rows) yield e;
      },
      inspect: async () => null,
      precheck: async () => null,
      apply: async () => {
        throw new Error("not exercised by this test");
      },
    }),
  });
  registerPublishContentContributor(
    fixture("media", [], [
      withState("media", "m-new", { slug: "new-shot" }),
      withState("media", "m-same", { slug: "same-shot" }),
      withState("media", "m-unused", { slug: "unused-shot" }),
    ])
  );
  registerPublishContentContributor(
    fixture("page", ["media"], [
      withState("page", "p1", {
        bodyJson: { type: "doc", content: [{ type: "image", attrs: { assetId: "m-new" } }] },
        bodyHtml: null,
      }),
      withState("page", "p2", { bodyJson: null, bodyHtml: `<img src="/m/same-shot/original">` }),
    ], (e) => collectBodyReferences(e.state))
  );
}

/** A peer that plans every staged entity: `m-same` is already on live, everything else is new. */
function planningPeerHttpClient(onBundle: (entities: PackedEntity[]) => void): HttpClientPort {
  let staged: PackedEntity[] = [];
  return {
    send: async (request) => {
      if (request.url.includes("/capabilities")) {
        return { status: 200, headers: {}, bodyText: JSON.stringify({ entityTypes: ["page", "media"], features: [] }) };
      }
      if (request.url.includes("/bundles")) {
        staged = (JSON.parse(String(request.body ?? "{}")) as { entities?: PackedEntity[] }).entities ?? [];
        onBundle(staged);
        return { status: 201, headers: {}, bodyText: JSON.stringify({ bundleId: "remote-bundle-1" }) };
      }
      if (request.url.includes("/import/plan")) {
        const rows = staged.map((e) => ({
          entityType: e.entityType,
          entityId: e.id,
          outcome: e.id === "m-same" ? "unchanged" : "created",
          writes: e.id !== "m-same",
          reason: null,
        }));
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            domain: "publish_content.import",
            planId: "p1",
            planHash: "h1",
            details: { refused: false, refusalReason: null, applyOrder: ["media", "page"], rows },
          }),
        };
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    },
  };
}

test("a pages-scoped plan carries referenced media along and shows only the media live would change", async (t) => {
  registerPagesWithMedia();
  t.after(() => resetPublishContentContributorsForTests());

  let stagedEntities: PackedEntity[] = [];
  const { app } = buildApp(planningPeerHttpClient((entities) => (stagedEntities = entities)));
  const server = await startTestServer(app, t);
  await createPeer(server);

  const res = await fetch(`${server}${BASE}/peer-1/push/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: { entityTypes: ["page"] } }),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  assert.deepEqual(
    stagedEntities.map((e) => `${e.entityType}:${e.id}`).sort(),
    ["media:m-new", "media:m-same", "page:p1", "page:p2"],
    "referenced media are staged; an unreferenced one never is"
  );
  const body = JSON.parse(raw) as { details: { rows: Array<{ entityId: string; includedFor?: string[] }> } };
  assert.deepEqual(
    body.details.rows.map((row) => [row.entityId, row.includedFor ?? null]),
    [
      ["m-new", ["page:p1"]],
      ["p1", null],
      ["p2", null],
    ],
    "the already-up-to-date media row is not shown"
  );
});

test("a deselected page's media is not staged on the narrowed re-plan", async (t) => {
  registerPagesWithMedia();
  t.after(() => resetPublishContentContributorsForTests());

  let stagedEntities: PackedEntity[] = [];
  const { app } = buildApp(planningPeerHttpClient((entities) => (stagedEntities = entities)));
  const server = await startTestServer(app, t);
  await createPeer(server);

  const res = await fetch(`${server}${BASE}/peer-1/push/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: { entityTypes: ["page"] }, selectedEntityKeys: ["page:p2"] }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(stagedEntities.map((e) => `${e.entityType}:${e.id}`).sort(), ["media:m-same", "page:p2"]);
});

test("an unscoped plan adds nothing — every media row is an ordinary row", async (t) => {
  registerPagesWithMedia();
  t.after(() => resetPublishContentContributorsForTests());

  const { app } = buildApp(planningPeerHttpClient(() => {}));
  const server = await startTestServer(app, t);
  await createPeer(server);

  const res = await fetch(`${server}${BASE}/peer-1/push/plan`, { method: "POST" });
  const body = (await res.json()) as { details: { rows: Array<{ entityId: string; includedFor?: string[] }> } };
  assert.deepEqual(
    body.details.rows.map((row) => [row.entityId, row.includedFor ?? null]),
    [
      ["m-new", null],
      ["m-same", null],
      ["m-unused", null],
      ["p1", null],
      ["p2", null],
    ]
  );
});
