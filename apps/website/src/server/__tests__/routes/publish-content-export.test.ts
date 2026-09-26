import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createApp, createRouteDeps } from "#src/server/runtime/composition/app";
import {
  registerPublishContentContributor,
  resetPublishContentContributorsForTests,
} from "#src/features/publish-content/type-registry";
import { installFirstPartyPublishContentTypes } from "#src/server/runtime/composition/publish-content-manifest";
import { CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import { PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION } from "#src/features/publish-content/artifact-format";
import type { PublishContentContributor, PackedEntity } from "#src/features/publish-content/type-registry";

/**
 * @file Task 4 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §1.1/§4 task 4.
 *
 * Route-level tests for `GET /publish-content/export`, against the hermetic in-memory composition
 * root (`createApp()`/`createRouteDeps()` — no filesystem, no `content.db`), mirroring
 * `content-post-get-by-slug.test.ts`/`pages-update-expected-version.test.ts`'s own harness.
 *
 * The exhaustive "no sensitive table's data can ever reach a bundle" property is proved separately,
 * against a REAL SQLite db, in `../integration/publish-content-export-no-leak.integration.test.ts`
 * — that property needs real rows in real tables (sessions, api_keys, credential sets, …), which this
 * hermetic harness has no schema for at all. This file instead covers the route's own contract: the
 * mount-path guard, the two-permission-check shape (route-level `publish_content.read` vs.
 * per-type `permission`), and the allowlist mechanism itself (registered types only, read fresh).
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

/** Logs in as the seeded owner ("admin"/"tovu-dev") — holds the wildcard `*` (identity/seed.ts), so
 *  every permission check in this file passes for it regardless of whether Task 9's grant exists. */
async function loginAsOwner(baseUrl: string): Promise<string> {
  return loginAs(baseUrl, "admin", "tovu-dev");
}

/** A logged-in principal holding EXACTLY `permissions`, via a hand-built non-builtin policy — same
 *  construction `api-key-routes.test.ts`'s `INV-07` test uses to prove an issuer-clamp case, reused
 *  here to prove the export route's own per-permission branches without touching Task 9's (not yet
 *  built) `publish_content.read` builtin-role grant. */
async function loginWithPermissions(
  deps: ReturnType<typeof createRouteDeps>,
  baseUrl: string,
  args: { username: string; permissions: readonly string[] }
): Promise<string> {
  await deps.identityReady;
  const principalId = `${args.username}-principal`;
  await deps.principalRepo.save({
    id: principalId,
    workspaceId: WORKSPACE,
    kind: "user",
    displayName: args.username,
    status: "active",
    createdAt: deps.clock.nowIso(),
  });
  await deps.userRepo.save({
    principalId,
    workspaceId: WORKSPACE,
    username: args.username,
    passwordHash: await deps.passwordHasher.hash("p4ssw0rd-not-secret!"),
  });
  if (args.permissions.length > 0) {
    const policyId = `${args.username}-policy`;
    await deps.policyRepo.save({ id: policyId, workspaceId: WORKSPACE, name: policyId, isBuiltin: false, isFrozen: false });
    for (const [index, permission] of args.permissions.entries()) {
      await deps.policyPermissionRepo.save({
        id: `${policyId}-perm-${index}`,
        workspaceId: WORKSPACE,
        policyId,
        permission,
        resourceType: null,
        constraintJson: null,
      });
    }
    await deps.principalPolicyRepo.save({ id: `${policyId}-attachment`, workspaceId: WORKSPACE, principalId, policyId });
  }
  return loginAs(baseUrl, args.username, "p4ssw0rd-not-secret!");
}

async function createPost(baseUrl: string, cookie: string, title: string) {
  const res = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title }),
  });
  const raw = await res.text();
  assert.equal(res.status, 201, `creating a post fixture failed: ${raw}`);
  return (JSON.parse(raw) as { post: { id: string; slug: string } }).post;
}

async function createPage(baseUrl: string, cookie: string, title: string) {
  const res = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title }),
  });
  const raw = await res.text();
  assert.equal(res.status, 201, `creating a page fixture failed: ${raw}`);
  return (JSON.parse(raw) as { post: { id: string; slug: string } }).post;
}

interface ExportBundle {
  artifactFormatVersion: number;
  hashVersion: number;
  sourceLabel: string;
  entities: Array<{ entityType: string; id: string; schemaVersion: number; contentHash: string; hashVersion: number; requiredBlobs: string[] }>;
  blobManifest: string[];
}

async function fetchExport(baseUrl: string, cookie: string): Promise<{ status: number; raw: string }> {
  const res = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/export`, { headers: { cookie } });
  return { status: res.status, raw: await res.text() };
}

test("GET .../publish-content/export 404s when the URL workspace does not match this composition's own workspace", async (t) => {
  const { server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const cookie = await loginAsOwner(baseUrl);
  const res = await fetch(`${baseUrl}/api/admin/v1/workspaces/some-other-workspace/publish-content/export`, { headers: { cookie } });
  assert.equal(res.status, 404);
});

test("GET .../publish-content/export is 401 without a credential and 403 for an authenticated principal lacking publish_content.read", async (t) => {
  const { deps, server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const anonymous = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/export`);
  assert.equal(anonymous.status, 401);

  const bareCookie = await loginWithPermissions(deps, baseUrl, { username: "bare-transport", permissions: [] });
  const forbidden = await fetchExport(baseUrl, bareCookie);
  assert.equal(forbidden.status, 403);
  assert.equal((JSON.parse(forbidden.raw) as { code: string }).code, "FORBIDDEN");
});

test("GET .../publish-content/export streams registered post/page entities for a principal holding publish_content.read and content.write", async (t) => {
  const { deps, server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const ownerCookie = await loginAsOwner(baseUrl);
  const post = await createPost(baseUrl, ownerCookie, "Export me — post");
  const page = await createPage(baseUrl, ownerCookie, "Export me — page");

  const cookie = await loginWithPermissions(deps, baseUrl, {
    username: "full-transport",
    permissions: ["publish_content.read", "content.write"],
  });
  const { status, raw } = await fetchExport(baseUrl, cookie);
  assert.equal(status, 200, raw);
  const bundle = JSON.parse(raw) as ExportBundle;

  assert.equal(bundle.artifactFormatVersion, PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION);
  assert.equal(bundle.hashVersion, CONTENT_HASH_VERSION);
  assert.equal(typeof bundle.sourceLabel, "string");
  assert.deepEqual(bundle.blobManifest, []);

  const byId = new Map(bundle.entities.map((entity) => [entity.id, entity]));
  assert.equal(byId.get(post.id)?.entityType, "post");
  assert.equal(byId.get(page.id)?.entityType, "page");
  for (const entity of bundle.entities) {
    assert.ok(["post", "page"].includes(entity.entityType), `unexpected entityType in bundle: ${entity.entityType}`);
    assert.equal(entity.schemaVersion, 2);
    assert.equal(entity.hashVersion, CONTENT_HASH_VERSION);
    assert.equal(typeof entity.contentHash, "string");
  }
});

test("GET .../publish-content/export omits a type the principal lacks — 200 with entities: [], never a 500", async (t) => {
  const { deps, server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const ownerCookie = await loginAsOwner(baseUrl);
  await createPost(baseUrl, ownerCookie, "Should be omitted");

  // Holds the ROUTE-level permission but not the per-type one (`content.write`, both post's and
  // page's declared `permission` — see `features/post/publish-content.ts`'s `buildHandler`).
  const cookie = await loginWithPermissions(deps, baseUrl, {
    username: "read-only-transport",
    permissions: ["publish_content.read"],
  });
  const { status, raw } = await fetchExport(baseUrl, cookie);
  assert.equal(status, 200, raw);
  const bundle = JSON.parse(raw) as ExportBundle;
  assert.deepEqual(bundle.entities, [], "a type whose own permission is missing must be omitted, not error");
});

test("GET .../publish-content/export is an ALLOWLIST: an empty contributor registry yields an empty bundle even though real posts exist", async (t) => {
  const { deps, server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  t.after(() => installFirstPartyPublishContentTypes()); // restore for any later test in this process

  const ownerCookie = await loginAsOwner(baseUrl);
  await createPost(baseUrl, ownerCookie, "Real content that must not leak by omission");
  await createPage(baseUrl, ownerCookie, "Real content that must not leak by omission (page)");

  resetPublishContentContributorsForTests();
  const { status, raw } = await fetchExport(baseUrl, ownerCookie);
  assert.equal(status, 200, raw);
  const bundle = JSON.parse(raw) as ExportBundle;
  assert.deepEqual(bundle.entities, [], "no registered contributor -> nothing exported, regardless of what the DB holds");
});

test("GET .../publish-content/export reads the contributor registry FRESH per request — a type registered after the first call is present on the very next one", async (t) => {
  const { deps, server, baseUrl } = await startServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  t.after(() => installFirstPartyPublishContentTypes()); // restore the real registry for any later test

  const ownerCookie = await loginAsOwner(baseUrl);
  resetPublishContentContributorsForTests();

  const before = await fetchExport(baseUrl, ownerCookie);
  assert.deepEqual((JSON.parse(before.raw) as ExportBundle).entities, []);

  const canaryEntity: PackedEntity = {
    entityType: "canary",
    id: "canary-1",
    schemaVersion: 1,
    contentHash: "canary-hash",
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: [],
    state: { marker: "fresh-read-proof" },
  };
  const canaryContributor: PublishContentContributor = {
    entityType: "canary",
    dependsOn: [],
    build: () => ({
      entityType: "canary",
      schemaVersion: 1,
      permission: "publish_content.read", // trivially satisfied by the caller in this test
      dependsOn: [],
      async *pack() {
        yield canaryEntity;
      },
      inspect: async () => null,
      precheck: async () => null,
      apply: async () => {
        throw new Error("not exercised by this test");
      },
    }),
  };
  registerPublishContentContributor(canaryContributor);

  const after = await fetchExport(baseUrl, ownerCookie);
  const bundle = JSON.parse(after.raw) as ExportBundle;
  assert.deepEqual(bundle.entities, [canaryEntity], "a contributor registered after the first request must appear on the next one");
});
