import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createApp, createRouteDeps } from "#src/server/runtime/composition/app";
import { CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import { PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION } from "#src/features/publish-content/artifact-format";
import { loadActiveBundle } from "#src/features/publish-content/bundle-staging";

/**
 * @file Task 6 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 6.
 *
 * Route-level tests for `POST .../publish-content/bundles`, against the hermetic in-memory
 * composition root, mirroring `publish-content-export.test.ts`'s own harness.
 *
 * The "a bundle past its `expiresAt` is refused" property is proved directly, at the unit level,
 * against `loadActiveBundle` in `features/publish-content/__tests__/bundle-staging.test.ts` — this
 * file re-proves it end-to-end through the real HTTP route + real `deps.publishContentBundleRepo`
 * wiring, so a regression that breaks composition (not the pure function itself) is also caught here.
 */

const WORKSPACE = "workspace-local";

async function startServer(deps: ReturnType<typeof createRouteDeps> = createRouteDeps()) {
  const server = createServer(createApp(deps));
  server.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { deps, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function loginAs(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login failed for ${username}: ${await res.text()}`);
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function loginAsOwner(baseUrl: string): Promise<string> {
  return loginAs(baseUrl, "admin", "tovu-dev");
}

function validBundleBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION,
    hashVersion: CONTENT_HASH_VERSION,
    sourceLabel: "peer instance",
    entities: [
      {
        entityType: "post",
        id: "p-1",
        schemaVersion: 2,
        contentHash: "abc",
        hashVersion: CONTENT_HASH_VERSION,
        requiredBlobs: [],
        state: {},
      },
    ],
    blobManifest: [],
    ...overrides,
  };
}

test("POST .../publish-content/bundles 404s when the URL workspace does not match this composition's own workspace", async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const cookie = await loginAsOwner(baseUrl);
  const res = await fetch(`${baseUrl}/api/admin/v1/workspaces/some-other-workspace/publish-content/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(validBundleBody()),
  });
  assert.equal(res.status, 404);
});

test("POST .../publish-content/bundles is 401 without a credential", async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const res = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBundleBody()),
  });
  assert.equal(res.status, 401);
});

test("POST .../publish-content/bundles stages a bundle and returns {bundleId, expiresAt} in the future", async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const cookie = await loginAsOwner(baseUrl);
  const before = Date.now();
  const res = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(validBundleBody()),
  });
  const raw = await res.text();
  assert.equal(res.status, 201, raw);
  const body = JSON.parse(raw) as { bundleId: string; expiresAt: string };
  assert.ok(body.bundleId);
  assert.ok(new Date(body.expiresAt).getTime() > before, "expiresAt must be in the future, never caller-supplied");
});

test("POST .../publish-content/bundles rejects a malformed body (wrong shape for hashVersion/entities/blobManifest)", async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const cookie = await loginAsOwner(baseUrl);

  const badHashVersion = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(validBundleBody({ hashVersion: "not-a-number" })),
  });
  assert.equal(badHashVersion.status, 400);

  const badEntities = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(validBundleBody({ entities: "not-an-array" })),
  });
  assert.equal(badEntities.status, 400);

  const badBlobManifest = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(validBundleBody({ blobManifest: [123] })),
  });
  assert.equal(badBlobManifest.status, 400);
});

test("POST .../publish-content/bundles explicitly rejects unknown artifact and entity schema versions", async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const cookie = await loginAsOwner(baseUrl);
  const url = `${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/bundles`;
  const headers = { "content-type": "application/json", cookie };

  const unknownArtifact = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(validBundleBody({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION + 1 })),
  });
  assert.equal(unknownArtifact.status, 400);
  assert.match(await unknownArtifact.text(), /unsupported artifactFormatVersion 2/);

  const entity = (validBundleBody().entities as Array<Record<string, unknown>>)[0];
  const unknownSchema = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(validBundleBody({ entities: [{ ...entity, schemaVersion: 1 }] })),
  });
  assert.equal(unknownSchema.status, 400);
  assert.match(await unknownSchema.text(), /unsupported schemaVersion 1 for entity type 'post'; this instance supports 2/);
});

test("a staged bundle is retrievable via the real repo wiring, and ignores a caller-supplied expiresAt-like field", async (t) => {
  const { deps, server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const cookie = await loginAsOwner(baseUrl);
  const res = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    // `expiresAt` is not part of the accepted body shape at all — this proves it is silently
    // ignored (never adopted as the row's real expiry), not merely "not required".
    body: JSON.stringify(validBundleBody({ expiresAt: "1999-01-01T00:00:00.000Z" })),
  });
  const raw = await res.text();
  assert.equal(res.status, 201, raw);
  const { bundleId, expiresAt } = JSON.parse(raw) as { bundleId: string; expiresAt: string };
  assert.notEqual(expiresAt, "1999-01-01T00:00:00.000Z");

  const active = await loadActiveBundle({
    repo: deps.publishContentBundleRepo,
    workspaceId: WORKSPACE,
    id: bundleId,
    now: deps.clock.nowIso(),
  });
  assert.ok(active, "the freshly staged bundle must be active immediately after staging");
  assert.equal(active?.id, bundleId);
});
