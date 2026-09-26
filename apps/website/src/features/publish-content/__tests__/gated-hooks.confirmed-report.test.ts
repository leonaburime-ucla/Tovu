/**
 * @file Regression cover for sol's 2026-09-20 review, High finding 1 — "the report applied can
 * differ from the report the operator confirmed".
 *
 * `gateway.execute()` re-derives the plan and hash-compares it against the confirmed token
 * (`gateway.ts` step 4, CIC U-001-B3), redeems the token, and only then calls
 * `hooks.executeMutation()`. `gated-hooks.ts`'s `executeMutation()` then captures a restore point
 * — a whole-workspace snapshot, classed `cheap | expensive | unavailable` by `execute-import.ts`,
 * so a slow one is an expected state, not a pathology — and `execute-import.ts:14` records that
 * this ceremony deliberately takes NO cross-domain operation lock.
 *
 * That leaves a real window between the verified report and the applied one. The test below drives
 * exactly that window: `captureRestorePoint` mutates the destination out from under the run, the
 * same way a concurrent restore or a second admin's edit would. Before the fix, the report handed
 * to `applyReport` was re-derived AFTER the mutation and classified the row `applied` (writes) —
 * while the operator had confirmed, and the gateway had verified, `conflict` (no write).
 *
 * The invariant this file pins: whatever `applyReport` receives is the report `gateway.execute()`
 * verified against the token, never a second derivation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION } from "../artifact-format.js";
import { CONTENT_HASH_VERSION, contentHash } from "../content-hash.js";
import { InMemoryPublishContentBaselineRepo } from "../baseline-repo.js";
import { InMemoryPublishContentBundleRepo } from "../bundle-staging.js";
import type { StagedBundleRecord } from "../bundle-staging.js";
import {
  buildPublishContentImportHooks,
  type PublishContentApplyPort,
  type PublishContentDbOpsPort,
  type PublishContentRestorePointSavePort,
} from "../gated-hooks.js";
import type { PublishContentReport } from "../planner.js";
import { InMemoryPostRepo } from "../../post/repo.memory.js";
import {
  registerPublishContentContributor,
  resetPublishContentContributorsForTests,
  type PackedEntity,
  type PublishContentHandler,
} from "../type-registry.js";
import { InMemoryTokenStore } from "../../../contracts/core/gated-mutations/token.js";
import { confirm, execute, plan } from "../../../contracts/core/gated-mutations/gateway.js";

const WORKSPACE_ID = "ws-1";
const BUNDLE_ID = "bundle-1";
const ACTOR_ID = "user-1";
const PEER_ID = "peer-1";
const ENTITY_TYPE = "thing";
const ENTITY_ID = "thing-1";

/** The hash the bundle carries (what the peer wants written). */
const INCOMING_HASH = contentHash(ENTITY_TYPE, { title: "incoming" });
/** The hash both sides agreed on at the last sync. */
const BASELINE_HASH = contentHash(ENTITY_TYPE, { title: "baseline" });
/** The destination's hash at plan/confirm time — differs from the baseline, so the row is a
 *  `conflict`: the destination has been edited since the last sync and must not be overwritten
 *  without an explicit force. */
const DRIFTED_HASH = contentHash(ENTITY_TYPE, { title: "drifted" });

test.beforeEach(() => {
  resetPublishContentContributorsForTests();
});

interface DestinationRow {
  readonly version: number;
  readonly hash: string;
}

/** Same hand-built handler shape `planner.test.ts` uses, over a MUTABLE destination map so a test
 *  can change the destination mid-ceremony. `apply()` throws: this file never reaches a real apply
 *  (the apply port is a spy), so a call here would mean the ceremony took a path it must not. */
function registerFakeHandler(destination: Map<string, DestinationRow>): void {
  const handler: PublishContentHandler = {
    entityType: ENTITY_TYPE,
    schemaVersion: 1,
    permission: "content.write",
    dependsOn: [],
    pack: async function* () {},
    inspect: async (id) => destination.get(id) ?? null,
    precheck: async () => null,
    apply: async () => {
      throw new Error("this fixture's apply() must never run — applyReport is spied, not executed");
    },
  };
  registerPublishContentContributor({ entityType: ENTITY_TYPE, dependsOn: [], build: () => handler });
}

function packedEntity(): PackedEntity {
  return {
    entityType: ENTITY_TYPE,
    id: ENTITY_ID,
    schemaVersion: 1,
    contentHash: INCOMING_HASH,
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: [],
    state: { title: "incoming" },
  };
}

function stagedBundle(): StagedBundleRecord {
  return {
    id: BUNDLE_ID,
    workspaceId: WORKSPACE_ID,
    sourcePrincipalId: PEER_ID,
    artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION,
    hashVersion: CONTENT_HASH_VERSION,
    entitiesJson: JSON.stringify([packedEntity()]),
    blobManifestJson: JSON.stringify([]),
    sizeBytes: 128,
    receivedAt: "2026-09-20T00:00:00.000Z",
    expiresAt: "2026-09-21T00:00:00.000Z",
  };
}

test("publish-content applies the report the gateway verified, not one re-derived after the destination moved", async () => {
  const destination = new Map<string, DestinationRow>([[ENTITY_ID, { version: 1, hash: DRIFTED_HASH }]]);
  registerFakeHandler(destination);

  const bundleRepo = new InMemoryPublishContentBundleRepo();
  await bundleRepo.save(stagedBundle());

  const baselineRepo = new InMemoryPublishContentBaselineRepo();
  await baselineRepo.upsert({
    workspaceId: WORKSPACE_ID,
    peerPrincipalId: PEER_ID,
    entityType: ENTITY_TYPE,
    entityId: ENTITY_ID,
    hashAtLastSync: BASELINE_HASH,
    hashVersion: CONTENT_HASH_VERSION,
    syncedAt: "2026-09-19T00:00:00.000Z",
    runId: "run-0",
  });

  let nextId = 0;
  const idGen = { newId: () => `id-${++nextId}` };
  const clock = { nowIso: () => "2026-09-20T12:00:00.000Z" };

  // The concurrent writer. Fires during the restore-point capture — inside the window between the
  // gateway's verified re-derivation and `executeMutation()`'s own, exactly as sol describes.
  const dbOps: PublishContentDbOpsPort = {
    captureRestorePoint: async () => {
      destination.set(ENTITY_ID, { version: 2, hash: BASELINE_HASH });
      return { artifactRef: "artifact-1", watermarkAtCapture: 1 };
    },
  };
  const restorePointsRepo: PublishContentRestorePointSavePort = { save: async () => {} };

  let applied: PublishContentReport | null = null;
  const applyPort: PublishContentApplyPort = {
    applyReport: async ({ report }) => {
      applied = report;
      return { runId: "run-1", changeSetIds: [] };
    },
  };

  const hooks = buildPublishContentImportHooks({
    workspaceId: WORKSPACE_ID,
    bundleId: BUNDLE_ID,
    actorId: ACTOR_ID,
    clock,
    idGen,
    publishContentDeps: { workspaceId: WORKSPACE_ID, clock, idGen, ports: { post: { repo: new InMemoryPostRepo() } } },
    bundleRepo,
    baselineRepo,
    blobStore: { exists: async () => true },
    dbOps,
    restorePointsRepo,
    applyPort,
  });

  const deps = {
    clock,
    idGen,
    authorize: async () => ({ allowed: true, reason: "ok" }),
    tokens: new InMemoryTokenStore(),
  };

  const planned = await plan({ deps, principalId: ACTOR_ID, principalKind: "user", hooks });
  const plannedReport = planned.details as PublishContentReport;
  assert.equal(
    plannedReport.rows[0]?.outcome,
    "conflict",
    "fixture precondition: the operator must be shown a conflict row, which does NOT write"
  );
  assert.equal(plannedReport.rows[0]?.writes, false);

  const token = await confirm({
    deps,
    principalId: ACTOR_ID,
    principalKind: "user",
    hooks,
    planId: planned.planId,
    planHash: planned.planHash,
  });

  await execute({ deps, principalId: ACTOR_ID, principalKind: "user", hooks, confirmationToken: token.confirmationToken });

  assert.notEqual(applied, null, "applyReport was never called");
  const appliedReport = applied as unknown as PublishContentReport;
  assert.equal(
    appliedReport.rows[0]?.outcome,
    "conflict",
    "the applied report must be the confirmed/verified one — a row confirmed as 'conflict' must never reach apply as 'applied'"
  );
  assert.equal(appliedReport.rows[0]?.writes, false, "a row the operator confirmed as non-writing must not become a write");
});
