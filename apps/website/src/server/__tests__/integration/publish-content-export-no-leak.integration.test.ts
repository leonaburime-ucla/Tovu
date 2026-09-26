import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { listPublishContentContributors } from "#src/features/publish-content/type-registry";
import { createApp } from "#src/server/runtime/composition/app";
import { createSqliteRouteDeps } from "#src/server/runtime/composition/deps";
import { openContentDb } from "#src/platform/db/sqlite/content-db";
import * as schema from "#src/platform/db/schema.sqlite";

/**
 * @file Task 4 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §1.1/§4 task 4, plan §5
 * risk #8 ("operational data leaking to a peer").
 *
 * The property under test: the export route's type filter is an ALLOWLIST of registered
 * publish-content types, never a deny-list — so a table nobody thought to exclude cannot leak
 * "by omission". `publish-content-export.test.ts` proves the MECHANISM (registry read fresh,
 * empty registry -> empty bundle) against the hermetic in-memory harness, which has no schema for
 * the sensitive tables named in the task brief at all. This file proves the DATA-LEVEL consequence
 * against a REAL, fully-migrated SQLite db: one canary row, with a unique marker value nothing else
 * in this process could produce, planted directly in EVERY table the task brief names as
 * sensitive — `sessions`, `principals`, `api_keys`, a representative `*credential*` table
 * (`publish_credential_sets`), `change_sets` (+ `change_set_items`), `outbox_events`,
 * `analytics_events`, `commerce_products` (representative `commerce_*`), `members` (representative
 * `member*`), `form_submissions`, and all four `publish_content_*` tables themselves (plan §5 risk
 * #13's own staging tables must not leak their own bookkeeping back out through the export they
 * feed). The assertion is exhaustive over that named list, not a spot-check of a couple of table
 * names picked to be reassuring: every marker below is asserted absent from the raw response body,
 * and the run FAILS LOUDLY (via `assert.ok` per marker, not a single aggregate check) naming exactly
 * which table's marker leaked if the allowlist is ever bypassed.
 *
 * Uses `createSqliteRouteDeps(undefined, {db, workspaceId})` (`create-sqlite-route-deps-overrides.
 * integration.test.ts`'s own established pattern) against an `openContentDb(":memory:")` handle, so
 * the canary rows are written directly via Drizzle table objects — bypassing every repo/port
 * entirely, which is the point: this proves the ROUTE never reads these tables, independent of
 * whether any repo would even expose a way to read them.
 */

const WORKSPACE = "workspace-local";
const NOW = new Date().toISOString();
const RUN_ID = randomUUID();

/** One canary value per sensitive table, each unique enough that its presence in the export
 *  response could only mean that table's row leaked through — never a coincidental substring match
 *  against something legitimate (post/page content, the workspace's own label, etc). */
function marker(table: string): string {
  return `LEAK-CANARY-${table}-${RUN_ID}`;
}

/** Plants one row in every table the task brief names as sensitive, each carrying that table's own
 *  {@link marker}. `foreign_keys = ON` (`content-db.ts`) is real on this connection, so the three
 *  tables with a declared `workspaces` FK (`commerce_products`, `publish_credential_sets`,
 *  `publish_content_peers`) need a real workspace row first — inserted here for exactly that
 *  reason, not because the route needs it (a missing workspace row degrades `sourceLabel` to the
 *  raw workspace id, nothing more; see `export.ts`'s own `?? deps.workspaceId` fallback). */
function plantCanaries(db: ReturnType<typeof openContentDb>): void {
  db.insert(schema.workspaces).values({ id: WORKSPACE, name: "Leak Test Site", slug: "leak-test-site", createdAt: NOW }).run();

  db.insert(schema.sessions)
    .values({
      id: "canary-session",
      workspaceId: WORKSPACE,
      principalId: "canary-principal",
      tokenHash: marker("sessions"),
      createdAt: NOW,
      expiresAt: NOW,
    })
    .run();

  db.insert(schema.principals)
    .values({
      id: "canary-principal",
      workspaceId: WORKSPACE,
      kind: "user",
      displayName: marker("principals"),
      status: "active",
      createdAt: NOW,
    })
    .run();

  db.insert(schema.apiKeys)
    .values({
      id: "canary-api-key",
      workspaceId: WORKSPACE,
      principalId: "canary-principal",
      label: marker("api_keys"),
      keyHash: marker("api_keys-hash"),
      prefix: "tovu_ak_canary",
      createdAt: NOW,
    })
    .run();

  // Representative `*credential*` table — sealed-secret shape shared by every credential table in
  // this schema (`publishCredentialSets`, `sourceControlCredentialSets`, `vendorCredentialSets`, …).
  db.insert(schema.publishCredentialSets)
    .values({
      id: "canary-publish-credential",
      workspaceId: WORKSPACE,
      providerId: "github-pages",
      label: marker("publish_credential_sets"),
      sealedKeyId: "canary-key-id",
      sealedCiphertext: marker("publish_credential_sets-ciphertext"),
      sealedNonce: "canary-nonce",
      sealedAlg: "aes-256-gcm",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();

  db.insert(schema.changeSets)
    .values({
      id: "canary-change-set",
      workspaceId: WORKSPACE,
      actorId: "canary-principal",
      status: "applied",
      summary: marker("change_sets"),
      createdAt: NOW,
    })
    .run();

  db.insert(schema.changeSetItems)
    .values({
      id: "canary-change-set-item",
      changeSetId: "canary-change-set",
      entityType: "post",
      entityId: marker("change_set_items"),
      operation: "create",
      position: 0,
    })
    .run();

  db.insert(schema.outboxEvents)
    .values({
      id: "canary-outbox-event",
      workspaceId: WORKSPACE,
      eventJson: JSON.stringify({ marker: marker("outbox_events") }),
      status: "pending",
      nextAttemptAt: NOW,
      createdAt: NOW,
    })
    .run();

  db.insert(schema.analyticsEvents)
    .values({
      workspaceId: WORKSPACE,
      occurredAt: NOW,
      kind: "pageview",
      path: `/${marker("analytics_events")}`,
      deviceClass: "desktop",
      visitorHash: "canary-visitor",
      sessionId: "canary-analytics-session",
    })
    .run();

  db.insert(schema.commerceProducts)
    .values({
      id: "canary-commerce-product",
      workspaceId: WORKSPACE,
      name: marker("commerce_products"),
      slug: "canary-commerce-product",
      kind: "one_time",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    })
    .run();

  db.insert(schema.members)
    .values({
      id: "canary-member",
      workspaceId: WORKSPACE,
      email: "canary-member@example.invalid",
      name: marker("members"),
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    })
    .run();

  db.insert(schema.formDefinitions)
    .values({
      id: "canary-form-definition",
      workspaceId: WORKSPACE,
      name: "Canary form",
      slug: "canary-form",
      fieldsJson: "[]",
      notifyJson: "[]",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  db.insert(schema.formSubmissions)
    .values({
      id: "canary-form-submission",
      workspaceId: WORKSPACE,
      formDefinitionId: "canary-form-definition",
      dataJson: JSON.stringify({ marker: marker("form_submissions") }),
      sourceIp: "203.0.113.1",
      submittedAt: NOW,
    })
    .run();

  db.insert(schema.publishContentBaselines)
    .values({
      workspaceId: WORKSPACE,
      peerPrincipalId: "canary-principal",
      entityType: "post",
      entityId: "canary-baseline-entity",
      hashAtLastSync: marker("publish_content_baselines"),
      hashVersion: 1,
      syncedAt: NOW,
      runId: "canary-run",
    })
    .run();

  db.insert(schema.publishContentRuns)
    .values({
      id: "canary-run",
      workspaceId: WORKSPACE,
      direction: "export",
      peerPrincipalId: "canary-principal",
      phase: "applied",
      actorId: "canary-principal",
      startedAt: NOW,
      reportJson: JSON.stringify({ marker: marker("publish_content_runs") }),
    })
    .run();

  db.insert(schema.publishContentBundles)
    .values({
      id: "canary-bundle",
      workspaceId: WORKSPACE,
      sourcePrincipalId: "canary-principal",
      hashVersion: 1,
      entitiesJson: JSON.stringify({ marker: marker("publish_content_bundles") }),
      blobManifestJson: "[]",
      sizeBytes: 0,
      receivedAt: NOW,
      expiresAt: NOW,
    })
    .run();

  db.insert(schema.publishContentPeers)
    .values({
      id: "canary-peer",
      workspaceId: WORKSPACE,
      label: marker("publish_content_peers"),
      baseUrl: "https://peer.example.invalid",
      remoteWorkspaceId: "remote-workspace",
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
}

const SENSITIVE_TABLES = [
  "sessions",
  "principals",
  "api_keys",
  "publish_credential_sets",
  "change_sets",
  "change_set_items",
  "outbox_events",
  "analytics_events",
  "commerce_products",
  "members",
  "form_submissions",
  "publish_content_baselines",
  "publish_content_runs",
  "publish_content_bundles",
  "publish_content_peers",
] as const;

async function loginAsOwner(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  assert.equal(res.status, 200, `owner login failed: ${await res.text()}`);
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

test("GET .../publish-content/export never leaks a row from any sensitive table, even for the most-privileged (wildcard) caller", async (t) => {
  // `createApp` → `createCoreModule` → `deriveInstallationId` (publish-trust, `112153842`,
  // 2026-09-19 — one day AFTER this test was written) now derives an installation credential from
  // the real root key on every boot, via `EnvOrFileKeyring`. This test must never read the
  // machine's own key (or write `~/.tovu/integrations-root-key.hex`), so it sets a throwaway
  // synthetic one for its own process only — the same pattern
  // `root-key-boot-notice.unit.test.ts` uses — and restores whatever was there before.
  const rootKeyBefore = process.env.TOVU_INTEGRATIONS_ROOT_KEY;
  process.env.TOVU_INTEGRATIONS_ROOT_KEY = "a".repeat(64);
  t.after(() => {
    if (rootKeyBefore === undefined) delete process.env.TOVU_INTEGRATIONS_ROOT_KEY;
    else process.env.TOVU_INTEGRATIONS_ROOT_KEY = rootKeyBefore;
  });

  const db = openContentDb(":memory:");
  plantCanaries(db);
  const deps = createSqliteRouteDeps(undefined, { db, workspaceId: WORKSPACE });
  await deps.identityReady;

  const server = createServer(createApp(deps));
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const cookie = await loginAsOwner(baseUrl);

  // Real, legitimate content — proves the route actually exports something, so an empty-by-accident
  // response (e.g. a silently-broken registry) could never be mistaken for "no leak".
  const post = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Legitimate exported content" }),
  });
  assert.equal(post.status, 201, await post.text());

  const exported = await fetch(`${baseUrl}/api/admin/v1/workspaces/${WORKSPACE}/publish-content/export`, {
    headers: { cookie },
  });
  const raw = await exported.text();
  assert.equal(exported.status, 200, raw);

  const bundle = JSON.parse(raw) as { entities: Array<{ entityType: string }> };
  assert.ok(bundle.entities.length > 0, "the legitimate post must actually be present, or this test proves nothing");
  const registered = listPublishContentContributors().map((c) => c.entityType);
  for (const entity of bundle.entities) {
    assert.ok(registered.includes(entity.entityType), `an unregistered entityType reached the bundle: ${entity.entityType}`);
  }

  // The exhaustive part: every named sensitive table's own canary, asserted absent one at a time so
  // a failure names exactly which table leaked, rather than one pass/fail bit for the whole list.
  for (const table of SENSITIVE_TABLES) {
    assert.ok(!raw.includes(marker(table)), `sensitive table '${table}' leaked into the publish-content export bundle`);
  }
});
