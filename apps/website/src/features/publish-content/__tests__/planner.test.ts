/**
 * @file Task 5 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 5.
 *
 * `planImport()` is pure planning with ZERO writes — this file's dominant concern is proving that
 * literally, not just asserting "no exception thrown". Every fixture that reaches a `conflict`,
 * `blocked`, or `refused` outcome snapshots its destination store BEFORE calling `planImport` and
 * asserts it is byte-identical AFTER (`assertUnchanged` below) — and, since `planImport` never
 * writes for ANY outcome (only a LATER apply pass, Task 8, would), every fixture in this file uses
 * that same assertion, not only the three the dispatch called out explicitly.
 *
 * Section 1 exercises the seven outcomes plus the whole-run refusal against a hand-built fake
 * handler (`makeFakeHandler`), so every branch — including ones the real post/page handler can never
 * produce today (a required blob, a stale baseline `hashVersion`) — is directly constructible.
 * Section 2 re-proves `created`/`unchanged`/`blocked` end-to-end against the REAL
 * `contributePostPublish()` handler (Task 2) plus a real `InMemoryPostRepo`, through the REAL
 * registry (`registerPublishContentContributor`), so this planner is shown to actually compose
 * with Task 2's own contract, not just with a fake built to match it. Section 3 covers
 * catalog ordering through `planImport`; invalid catalog cases live in `type-registry.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { CONTENT_HASH_VERSION, contentHash } from "../content-hash.js";
import { PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION } from "../artifact-format.js";
import {
  registerPublishContentContributor,
  resetPublishContentContributorsForTests,
  type PublishContentContributor,
  type PublishContentHandler,
  type PackedEntity,
} from "../type-registry.js";
import {
  entityDisplayLabel,
  entityKey,
  planImport,
  type BaselineRecord,
  type PlanImportDeps,
  type PublishContentBundle,
  type RetireTarget,
  type ReferenceHolder,
} from "../planner.js";

test.beforeEach(() => {
  resetPublishContentContributorsForTests();
});

// ---------------------------------------------------------------------------
// Shared fixture plumbing
// ---------------------------------------------------------------------------

interface FakeDestinationRow {
  readonly version: number;
  readonly hash: string;
}

/** A minimal, hand-built handler for constructing every outcome directly and precisely — see this
 *  file's header. `apply()` throws unconditionally: if `planImport` ever called it, that would be a
 *  write during planning, which is exactly the property this whole file exists to rule out. */
function makeFakeHandler(options: {
  entityType: string;
  dependsOn?: readonly string[];
  destination: Map<string, FakeDestinationRow>;
  blockedIds?: ReadonlySet<string>;
  blockReason?: string;
  /** S2 (publish-overwrite-live-plan §4) — a fake handler opts into the retire-offer branch of
   *  `planEntity` by supplying this; a handler built WITHOUT it has no `planRetire` property at all
   *  (not even `undefined` explicitly), matching every real handler before S4 lands. */
  planRetire?: (entity: PackedEntity) => Promise<RetireTarget | null>;
  /** S-F4 (publish-files-plan §4) — a fake handler opts into the handler-level seed fallback by
   *  supplying this; omitted means no `seedHash` property at all, like every row-backed handler. */
  seedHash?: (id: string) => Promise<string | null>;
  /** R2 (publish-repoint-menus-plan §2.1/§2.2) — a fake handler opts into the planner's
   *  `referencedBy` post-pass by supplying this; omitted means no `referencesTo` property at all,
   *  matching every handler before this change. */
  referencesTo?: (ids: readonly string[]) => Promise<readonly ReferenceHolder[]>;
}): PublishContentHandler {
  const handler = {
    entityType: options.entityType,
    schemaVersion: 1,
    permission: "content.write",
    dependsOn: options.dependsOn ?? [],
    pack: async function* () {},
    inspect: async (id: string) => options.destination.get(id) ?? null,
    precheck: async (entity: PackedEntity) =>
      options.blockedIds?.has(entity.id) ? (options.blockReason ?? `blocked: ${entity.id}`) : null,
    apply: async () => {
      throw new Error(`planImport must never call apply() — it is pure planning (entityType=${options.entityType})`);
    },
    ...(options.planRetire ? { planRetire: options.planRetire } : {}),
    ...(options.seedHash ? { seedHash: options.seedHash } : {}),
    ...(options.referencesTo ? { referencesTo: options.referencesTo } : {}),
  };
  return handler;
}

function fakeContributor(handler: PublishContentHandler): PublishContentContributor {
  return { entityType: handler.entityType, dependsOn: handler.dependsOn, build: () => handler };
}

function makeEntity(overrides: Partial<PackedEntity> & { entityType: string; id: string }): PackedEntity {
  return {
    schemaVersion: 1,
    contentHash: contentHash(overrides.entityType, { title: overrides.id }),
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: [],
    state: { title: overrides.id },
    ...overrides,
  };
}

/** Builds `PlanImportDeps` backed by plain maps/sets — no real `PublishContentDeps` is needed
 *  because every contributor in these tests supplies its own fake handler via `build: () => handler`
 *  and ignores the argument. */
function makeDeps(options: {
  baselines?: Map<string, BaselineRecord | null>;
  availableBlobs?: ReadonlySet<string>;
  forcedEntityKeys?: ReadonlySet<string>;
  /** D1 (2026-09-24 owner decision) — when supplied, backs the new optional `getSeedHash` dep;
   *  a missing entry resolves `null` (not in the seed at all), matching a real seed-db lookup's own
   *  "no row for this id" case. Omitted entirely (`undefined`) means `getSeedHash` is not wired at
   *  all, the same as today's one production call site (`gated-hooks.ts`) until it is. */
  seedHashes?: Map<string, string | null>;
}): PlanImportDeps {
  const baselines = options.baselines ?? new Map();
  const availableBlobs = options.availableBlobs ?? new Set();
  return {
    publishContentDeps: {} as PlanImportDeps["publishContentDeps"],
    getBaseline: async ({ entityType, entityId }) => baselines.get(entityKey(entityType, entityId)) ?? null,
    hasBlob: async (sha256) => availableBlobs.has(sha256),
    forcedEntityKeys: options.forcedEntityKeys,
    ...(options.seedHashes
      ? { getSeedHash: async ({ entityType, entityId }: { entityType: string; entityId: string }) => options.seedHashes!.get(entityKey(entityType, entityId)) ?? null }
      : {}),
  };
}

/** Snapshots a destination store's exact contents; two snapshots deep-equal iff the store is
 *  byte-identical — the property every fixture in this file proves, not merely "no throw". */
function snapshot(destination: Map<string, FakeDestinationRow>): string {
  return JSON.stringify([...destination.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function assertUnchanged(destination: Map<string, FakeDestinationRow>, before: string, label: string): void {
  assert.equal(snapshot(destination), before, `${label}: destination must be byte-identical after planImport`);
}

// ---------------------------------------------------------------------------
// 1. The seven outcomes + whole-run refusal (fake handler, precise construction)
// ---------------------------------------------------------------------------

test("created: no destination row for the id", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const bundle: PublishContentBundle = { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [makeEntity({ entityType: "widget", id: "w1" })] };
  const report = await planImport(bundle, makeDeps({}));

  assert.equal(report.refused, false);
  assert.deepEqual(report.rows, [{ entityType: "widget", entityId: "w1", entityLabel: "w1", outcome: "created", writes: true, reason: null, canOverwrite: false, retires: null }]);
  assertUnchanged(destination, before, "created");
});

test("unchanged: destination hash equals source hash", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 3, hash: "same-hash" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "same-hash" });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({}));

  assert.deepEqual(report.rows, [{ entityType: "widget", entityId: "w1", entityLabel: "w1", outcome: "unchanged", writes: false, reason: null, canOverwrite: false, retires: null }]);
  assertUnchanged(destination, before, "unchanged");
});

test("applied: destination hash differs from source but matches the recorded baseline (untouched since last sync)", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 5, hash: "baseline-hash" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const baselines = new Map<string, BaselineRecord | null>([
    [entityKey("widget", "w1"), { hashAtLastSync: "baseline-hash", hashVersion: CONTENT_HASH_VERSION }],
  ]);
  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({ baselines }));

  assert.deepEqual(report.rows, [{ entityType: "widget", entityId: "w1", entityLabel: "w1", outcome: "applied", writes: true, reason: null, canOverwrite: false, retires: null }]);
  assertUnchanged(destination, before, "applied");
});

test("conflict: destination hash differs from BOTH source and the recorded baseline — edited on the destination", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 5, hash: "edited-on-destination" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const baselines = new Map<string, BaselineRecord | null>([
    [entityKey("widget", "w1"), { hashAtLastSync: "old-baseline-hash", hashVersion: CONTENT_HASH_VERSION }],
  ]);
  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({ baselines }));

  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].outcome, "conflict");
  assert.equal(report.rows[0].writes, false);
  assert.match(report.rows[0].reason ?? "", /edited on the destination since the last sync/);
  assert.equal(report.rows[0].canOverwrite, true, "a conflict row is always offered for override");
  assert.equal(report.rows[0].retires, null);
  assertUnchanged(destination, before, "conflict (edited on destination)");
});

test("conflict: no baseline exists at all for this peer+entity — never a free pass to overwrite", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 1, hash: "already-here" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "incoming-hash" });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({}));

  assert.equal(report.rows[0].outcome, "conflict");
  assert.equal(report.rows[0].writes, false);
  assert.match(report.rows[0].reason ?? "", /no prior sync baseline/);
  assert.equal(report.rows[0].canOverwrite, true, "a conflict row is always offered for override");
  assertUnchanged(destination, before, "conflict (no baseline)");
});

// ---------------------------------------------------------------------------
// 1b. D1 (2026-09-24 owner decision) — the shipped seed as a virtual baseline when no REAL
// baseline has been recorded yet, so the very first publish can overwrite a destination row
// nobody has touched since the seed hydrated it (the owner's worked example: the header nav).
// ---------------------------------------------------------------------------

test("applied (D1): no recorded baseline, but the destination hash matches the shipped seed's hash — untouched since seed, not a conflict", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 1, hash: "seed-hash" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const seedHashes = new Map<string, string | null>([[entityKey("widget", "w1"), "seed-hash"]]);
  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ seedHashes })
  );

  assert.deepEqual(report.rows, [{ entityType: "widget", entityId: "w1", entityLabel: "w1", outcome: "applied", writes: true, reason: null, canOverwrite: false, retires: null }]);
  assertUnchanged(destination, before, "applied (D1 seed match)");
});

test("conflict (D1): no recorded baseline AND the destination hash differs from the seed hash too — genuinely edited since seed, stays a conflict", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 1, hash: "edited-since-seed" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const seedHashes = new Map<string, string | null>([[entityKey("widget", "w1"), "seed-hash"]]);
  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ seedHashes })
  );

  assert.equal(report.rows[0].outcome, "conflict");
  assert.equal(report.rows[0].writes, false);
  assert.match(report.rows[0].reason ?? "", /no prior sync baseline/);
  assertUnchanged(destination, before, "conflict (D1 seed mismatch too)");
});

test("conflict (D1): getSeedHash resolves null for this entity (not in the seed at all) — falls through to the ordinary no-baseline conflict", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 1, hash: "already-here" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));

  const seedHashes = new Map<string, string | null>(); // no entry for w1 -> resolves null
  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "incoming-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ seedHashes })
  );

  assert.equal(report.rows[0].outcome, "conflict");
  assert.match(report.rows[0].reason ?? "", /no prior sync baseline/);
});

test("applied (S-F4): no baseline, no deps.getSeedHash, but the destination matches handler.seedHash — untouched since seed", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 0, hash: "original-hash" }]]);
  const seedHash = async (id: string) => (id === "w1" ? "original-hash" : null);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination, seedHash })));

  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({})
  );

  assert.deepEqual(report.rows, [{ entityType: "widget", entityId: "w1", entityLabel: "w1", outcome: "applied", writes: true, reason: null, canOverwrite: false, retires: null }]);
});

test("applied (S-F4): deps.getSeedHash answers null, so handler.seedHash is consulted and matches", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 0, hash: "original-hash" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination, seedHash: async () => "original-hash" })));

  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ seedHashes: new Map() })
  );

  assert.equal(report.rows[0].outcome, "applied");
});

test("conflict (S-F4): no baseline and the destination differs from handler.seedHash — edited on live, offered as an overwrite", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 0, hash: "edited-on-live" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination, seedHash: async () => "original-hash" })));

  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({})
  );

  assert.deepEqual(report.rows, [{
    entityType: "widget",
    entityId: "w1",
    entityLabel: "w1",
    outcome: "conflict",
    writes: false,
    reason: "no prior sync baseline for widget 'w1' with this peer — the destination already holds different content",
    canOverwrite: true,
    retires: null,
  }]);
});

test("conflict (S-F4): a recorded baseline wins over handler.seedHash, which is never consulted", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 0, hash: "original-hash" }]]);
  let seedCalls = 0;
  const seedHash = async () => { seedCalls += 1; return "original-hash"; };
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination, seedHash })));

  const baselines = new Map<string, BaselineRecord | null>([[entityKey("widget", "w1"), { hashAtLastSync: "last-synced-hash", hashVersion: CONTENT_HASH_VERSION }]]);
  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ baselines })
  );

  assert.equal(report.rows[0].outcome, "conflict");
  assert.equal(report.rows[0].reason, "widget 'w1' has been edited on the destination since the last sync with this peer");
  assert.equal(seedCalls, 0);
});

test("conflict (D1): a REAL recorded baseline always wins — getSeedHash is a fallback for 'no baseline yet' only, never consulted once one exists", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 5, hash: "edited-on-destination" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));

  const baselines = new Map<string, BaselineRecord | null>([
    [entityKey("widget", "w1"), { hashAtLastSync: "old-baseline-hash", hashVersion: CONTENT_HASH_VERSION }],
  ]);
  // The destination's CURRENT hash happens to equal the seed hash too — if getSeedHash were
  // consulted here it would wrongly turn a real edited-since-last-sync conflict into `applied`.
  const seedHashes = new Map<string, string | null>([[entityKey("widget", "w1"), "edited-on-destination"]]);
  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ baselines, seedHashes })
  );

  assert.equal(report.rows[0].outcome, "conflict");
  assert.match(report.rows[0].reason ?? "", /edited on the destination since the last sync/);
});

test("blocked: precheck fails (e.g. slug taken) — never caught as a write-time constraint violation", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const handler = makeFakeHandler({ entityType: "widget", destination, blockedIds: new Set(["w1"]), blockReason: "slug 'x' is already held by a different widget" });
  registerPublishContentContributor(fakeContributor(handler));
  const before = snapshot(destination);

  const entity = makeEntity({ entityType: "widget", id: "w1" });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({}));

  assert.deepEqual(report.rows, [
    { entityType: "widget", entityId: "w1", entityLabel: "w1", outcome: "blocked", writes: false, reason: "slug 'x' is already held by a different widget", canOverwrite: false, retires: null },
  ]);
  assertUnchanged(destination, before, "blocked (precheck)");
});

test("blocked: a required blob is not available on this instance", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const entity = makeEntity({ entityType: "widget", id: "w1", requiredBlobs: ["deadbeef"] });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({ availableBlobs: new Set() }));

  assert.equal(report.rows[0].outcome, "blocked");
  assert.match(report.rows[0].reason ?? "", /required blob 'deadbeef' is not available/);
  assertUnchanged(destination, before, "blocked (missing blob)");
});

test("NOT blocked when the required blob IS available", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));

  const entity = makeEntity({ entityType: "widget", id: "w1", requiredBlobs: ["deadbeef"] });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({ availableBlobs: new Set(["deadbeef"]) }));

  assert.equal(report.rows[0].outcome, "created");
});

test("forced: a conflict (edited on destination) the operator explicitly selected becomes 'forced' and would write", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 5, hash: "edited-on-destination" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const baselines = new Map<string, BaselineRecord | null>([
    [entityKey("widget", "w1"), { hashAtLastSync: "old-baseline-hash", hashVersion: CONTENT_HASH_VERSION }],
  ]);
  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "new-source-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ baselines, forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  assert.equal(report.rows[0].outcome, "forced");
  assert.equal(report.rows[0].writes, true);
  assert.match(report.rows[0].reason ?? "", /edited on the destination/);
  assert.equal(report.rows[0].canOverwrite, false, "a row already forced is not still being offered");
  assert.equal(report.rows[0].retires, null, "the plain conflict-forcing path never resolves a retire target");
  assertUnchanged(destination, before, "forced (planImport itself still never writes)");
});

test("forced: the 'no baseline at all' conflict variant can also be forced", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 1, hash: "already-here" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));

  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "incoming-hash" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  assert.equal(report.rows[0].outcome, "forced");
  assert.equal(report.rows[0].writes, true);
});

// ---------------------------------------------------------------------------
// 1c. publish-overwrite-live-plan §4/S2 — a slug-clash `blocked` row whose handler can resolve WHO
// holds the address gets offered for overwrite (`canOverwrite:true` + the `RetireTarget`), and an
// operator's own `forcedEntityKeys` tick turns a valid offer into `forced`, exactly like a plain
// conflict — UNLESS the holder is itself part of this same bundle.
// ---------------------------------------------------------------------------

test("a forced key on a slug-blocked row with a resolvable retire target becomes 'forced' with the target attached", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const target: RetireTarget = { entityType: "widget", entityId: "holder-1", entityLabel: "Holder", hash: "holder-hash" };
  const handler = makeFakeHandler({
    entityType: "widget",
    destination,
    blockedIds: new Set(["w1"]),
    blockReason: "slug 'x' is already held by a different widget",
    planRetire: async () => target,
  });
  registerPublishContentContributor(fakeContributor(handler));

  const entity = makeEntity({ entityType: "widget", id: "w1" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  assert.deepEqual(report.rows[0], {
    entityType: "widget",
    entityId: "w1",
    entityLabel: "w1",
    outcome: "forced",
    writes: true,
    reason: "slug 'x' is already held by a different widget",
    canOverwrite: true,
    retires: target,
  });
});

test("the SAME slug-blocked row, with no forced key, stays 'blocked' but is offered (canOverwrite:true) with the target attached", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const target: RetireTarget = { entityType: "widget", entityId: "holder-1", entityLabel: "Holder", hash: "holder-hash" };
  const handler = makeFakeHandler({
    entityType: "widget",
    destination,
    blockedIds: new Set(["w1"]),
    blockReason: "slug 'x' is already held by a different widget",
    planRetire: async () => target,
  });
  registerPublishContentContributor(fakeContributor(handler));
  const before = snapshot(destination);

  const entity = makeEntity({ entityType: "widget", id: "w1" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({})
  );

  assert.equal(report.rows[0].outcome, "blocked");
  assert.equal(report.rows[0].writes, false);
  assert.equal(report.rows[0].canOverwrite, true);
  assert.deepEqual(report.rows[0].retires, target);
  assertUnchanged(destination, before, "blocked, offered (no forced key yet)");
});

test("a retire target that is ALSO part of this bundle is never offered — publishing the holder would move its own slug mid-run", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const target: RetireTarget = { entityType: "widget", entityId: "w2", entityLabel: "Holder", hash: "holder-hash" };
  const handler = makeFakeHandler({
    entityType: "widget",
    destination,
    blockedIds: new Set(["w1"]),
    blockReason: "slug 'x' is already held by a different widget",
    planRetire: async () => target,
  });
  registerPublishContentContributor(fakeContributor(handler));

  const blockedEntity = makeEntity({ entityType: "widget", id: "w1" });
  const holderEntity = makeEntity({ entityType: "widget", id: "w2" }); // the holder itself is in THIS bundle
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [blockedEntity, holderEntity] },
    // Even an operator who already ticked "overwrite" for w1 must not get a forced retire here —
    // the in-bundle case is refused regardless of forcedEntityKeys.
    makeDeps({ forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  const row = report.rows.find((r) => r.entityId === "w1")!;
  assert.equal(row.outcome, "blocked");
  assert.equal(row.writes, false);
  assert.equal(row.canOverwrite, false);
  assert.equal(row.retires, null);
});

test("a forced key never turns a missing-blob block into an overwrite offer", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));

  const entity = makeEntity({ entityType: "widget", id: "w1", requiredBlobs: ["deadbeef"] });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ availableBlobs: new Set(), forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  assert.equal(report.rows[0].outcome, "blocked");
  assert.match(report.rows[0].reason ?? "", /required blob 'deadbeef' is not available/);
  assert.equal(report.rows[0].canOverwrite, false);
  assert.equal(report.rows[0].retires, null);
});

test("a slug-blocked row whose handler has no planRetire at all behaves exactly as before this change", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const handler = makeFakeHandler({
    entityType: "widget",
    destination,
    blockedIds: new Set(["w1"]),
    blockReason: "slug 'x' is already held by a different widget",
    // no planRetire supplied
  });
  registerPublishContentContributor(fakeContributor(handler));

  const entity = makeEntity({ entityType: "widget", id: "w1" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  assert.equal(report.rows[0].outcome, "blocked");
  assert.equal(report.rows[0].canOverwrite, false);
  assert.equal(report.rows[0].retires, null);
});

test("a slug-blocked row whose planRetire resolves null (nothing to retire) stays blocked and unoffered", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const handler = makeFakeHandler({
    entityType: "widget",
    destination,
    blockedIds: new Set(["w1"]),
    blockReason: "the home page cannot be replaced by publishing",
    planRetire: async () => null,
  });
  registerPublishContentContributor(fakeContributor(handler));

  const entity = makeEntity({ entityType: "widget", id: "w1" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  assert.equal(report.rows[0].outcome, "blocked");
  assert.equal(report.rows[0].canOverwrite, false);
  assert.equal(report.rows[0].retires, null);
});

// ---------------------------------------------------------------------------
// 1c. R2 (publish-repoint-menus-plan-2026-09-24.md §2.2) — the planner's `referencedBy` post-pass.
// Reuses the "widget" fake handler's planRetire (above) plus a fake "ref" type whose referencesTo
// returns holders, so the pass is proven against a handler contract, not the real menu handler
// (that lands in R3).
// ---------------------------------------------------------------------------

test("referencedBy: a forced retire row gets the live holders that still link to it, from a handler with referencesTo", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const target: RetireTarget = { entityType: "widget", entityId: "holder", entityLabel: "Holder", hash: "holder-hash" };
  registerPublishContentContributor(
    fakeContributor(
      makeFakeHandler({
        entityType: "widget",
        destination,
        blockedIds: new Set(["w1"]),
        blockReason: "slug 'x' is already held by a different widget",
        planRetire: async () => target,
      })
    )
  );

  const refHolder: ReferenceHolder = { entityType: "ref", entityId: "m1", entityLabel: "Header", referencedId: "holder" };
  const referencesToCalls: (readonly string[])[] = [];
  registerPublishContentContributor(
    fakeContributor(
      makeFakeHandler({
        entityType: "ref",
        destination: new Map(),
        referencesTo: async (ids) => {
          referencesToCalls.push(ids);
          return [refHolder];
        },
      })
    )
  );

  const entity = makeEntity({ entityType: "widget", id: "w1" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({ forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  const row = report.rows.find((r) => r.entityType === "widget" && r.entityId === "w1")!;
  assert.equal(row.outcome, "forced");
  assert.deepEqual(row.referencedBy, [refHolder]);
  assert.equal(referencesToCalls.length, 1);
  assert.deepEqual(referencesToCalls[0], ["holder"]);
});

test("referencedBy: a holder whose own referencing row writes in this same bundle is dropped — the incoming tree already wins", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const target: RetireTarget = { entityType: "widget", entityId: "holder", entityLabel: "Holder", hash: "holder-hash" };
  registerPublishContentContributor(
    fakeContributor(
      makeFakeHandler({
        entityType: "widget",
        destination,
        blockedIds: new Set(["w1"]),
        blockReason: "slug 'x' is already held by a different widget",
        planRetire: async () => target,
      })
    )
  );

  const refHolder: ReferenceHolder = { entityType: "ref", entityId: "m1", entityLabel: "Header", referencedId: "holder" };
  registerPublishContentContributor(
    fakeContributor(
      makeFakeHandler({
        entityType: "ref",
        destination: new Map(), // no destination row for "m1" -> its own row outcome is "created" (writes: true)
        referencesTo: async () => [refHolder],
      })
    )
  );

  const entities = [makeEntity({ entityType: "widget", id: "w1" }), makeEntity({ entityType: "ref", id: "m1" })];
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities },
    makeDeps({ forcedEntityKeys: new Set([entityKey("widget", "w1")]) })
  );

  const widgetRow = report.rows.find((r) => r.entityType === "widget" && r.entityId === "w1")!;
  const refRow = report.rows.find((r) => r.entityType === "ref" && r.entityId === "m1")!;
  assert.equal(refRow.writes, true, "sanity: the ref/m1 row itself writes this same run");
  assert.equal("referencedBy" in widgetRow, false, "absent — a writing referencing row already carries the new id");
});

test("referencedBy: no row retires anything — referencesTo is never called, and no row gains the field", async () => {
  const destination = new Map<string, FakeDestinationRow>([["w1", { version: 1, hash: "same" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));

  let referencesToCalls = 0;
  registerPublishContentContributor(
    fakeContributor(
      makeFakeHandler({
        entityType: "ref",
        destination: new Map(),
        referencesTo: async () => {
          referencesToCalls += 1;
          return [];
        },
      })
    )
  );

  const entity = makeEntity({ entityType: "widget", id: "w1", contentHash: "same" });
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] },
    makeDeps({})
  );

  assert.equal(referencesToCalls, 0, "no retire target in the whole report -> referencesTo must never be called");
  assert.equal("referencedBy" in report.rows[0], false);
});

test("referencedBy: two retire rows collect both ids into a single referencesTo call, one per handler, not one per row", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const target1: RetireTarget = { entityType: "widget", entityId: "holder-1", entityLabel: "Holder 1", hash: "h1" };
  const target2: RetireTarget = { entityType: "widget", entityId: "holder-2", entityLabel: "Holder 2", hash: "h2" };
  registerPublishContentContributor(
    fakeContributor(
      makeFakeHandler({
        entityType: "widget",
        destination,
        blockedIds: new Set(["w1", "w2"]),
        blockReason: "slug clash",
        planRetire: async (entity) => (entity.id === "w1" ? target1 : target2),
      })
    )
  );

  const referencesToCalls: (readonly string[])[] = [];
  registerPublishContentContributor(
    fakeContributor(
      makeFakeHandler({
        entityType: "ref",
        destination: new Map(),
        referencesTo: async (ids) => {
          referencesToCalls.push(ids);
          return [];
        },
      })
    )
  );

  const entities = [makeEntity({ entityType: "widget", id: "w1" }), makeEntity({ entityType: "widget", id: "w2" })];
  await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities },
    makeDeps({})
  );

  assert.equal(referencesToCalls.length, 1, "one referencesTo call for the whole plan, not one per retire row");
  assert.deepEqual([...referencesToCalls[0]].sort(), ["holder-1", "holder-2"]);
});

test("refused: unknown artifact format version rejects the whole bundle before any catalog or baseline read", async () => {
  let baselineReads = 0;
  const report = await planImport(
    {
      artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION + 1,
      hashVersion: CONTENT_HASH_VERSION,
      entities: [makeEntity({ entityType: "widget", id: "w1" })],
    },
    {
      ...makeDeps({}),
      getBaseline: async () => {
        baselineReads += 1;
        return null;
      },
    }
  );

  assert.equal(report.refused, true);
  assert.deepEqual(report.rows, []);
  assert.match(report.refusalReason ?? "", /artifact format version 2/);
  assert.equal(baselineReads, 0);
});

test("refused: unknown per-type schema version rejects the whole bundle before baseline reads", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  let baselineReads = 0;
  const report = await planImport(
    {
      artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION,
      hashVersion: CONTENT_HASH_VERSION,
      entities: [makeEntity({ entityType: "widget", id: "w1", schemaVersion: 2 })],
    },
    {
      ...makeDeps({}),
      getBaseline: async () => {
        baselineReads += 1;
        return null;
      },
    }
  );

  assert.equal(report.refused, true);
  assert.deepEqual(report.rows, []);
  assert.match(report.refusalReason ?? "", /widget 'w1' uses schema version 2/);
  assert.equal(baselineReads, 0);
});

test("refused: bundle.hashVersion mismatch refuses the WHOLE run — no rows, no baseline reads", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  let baselineReads = 0;
  const deps: PlanImportDeps = {
    publishContentDeps: {} as PlanImportDeps["publishContentDeps"],
    getBaseline: async () => {
      baselineReads += 1;
      return null;
    },
    hasBlob: async () => true,
  };
  const entity = makeEntity({ entityType: "widget", id: "w1" });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION + 1, entities: [entity] }, deps);

  assert.equal(report.refused, true);
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.applyOrder, []);
  assert.match(report.refusalReason ?? "", /does not match this instance's/);
  assert.equal(baselineReads, 0, "a bundle-level version mismatch must short-circuit before any baseline read");
  assertUnchanged(destination, before, "refused (bundle version)");
});

test("refused (adversarial, aggregate): ONE stale baseline hashVersion among several entities refuses the WHOLE run, not just that entity", async () => {
  const destination = new Map<string, FakeDestinationRow>([
    ["w1", { version: 1, hash: "h1" }],
    ["w2", { version: 1, hash: "h2" }],
    ["w3", { version: 1, hash: "h3" }],
  ]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const before = snapshot(destination);

  const baselines = new Map<string, BaselineRecord | null>([
    [entityKey("widget", "w1"), { hashAtLastSync: "h1", hashVersion: CONTENT_HASH_VERSION }],
    [entityKey("widget", "w2"), { hashAtLastSync: "stale", hashVersion: CONTENT_HASH_VERSION + 1 }], // the poison entity
    [entityKey("widget", "w3"), { hashAtLastSync: "h3", hashVersion: CONTENT_HASH_VERSION }],
  ]);
  const entities = ["w1", "w2", "w3"].map((id) => makeEntity({ entityType: "widget", id, contentHash: `h${id.slice(1)}` }));
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities }, makeDeps({ baselines }));

  assert.equal(report.refused, true);
  assert.deepEqual(report.rows, [], "no partial rows for w1/w3 even though their own baselines were fine");
  assert.match(report.refusalReason ?? "", /widget 'w2'/);
  assertUnchanged(destination, before, "refused (aggregate, one poisoned baseline)");
});

test("blocked: an entity type present in the bundle with NO registered handler on this instance", async () => {
  // No contributor registered at all for "widget" — resetPublishContentContributorsForTests()
  // ran in beforeEach.
  const entity = makeEntity({ entityType: "widget", id: "w1" });
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({}));

  assert.equal(report.rows[0].outcome, "blocked");
  assert.match(report.rows[0].reason ?? "", /no registered publish-content handler for entity type 'widget'/);
});

// ---------------------------------------------------------------------------
// 2. Aggregate/batch: all seven outcomes computed together, no cross-entity interference
// ---------------------------------------------------------------------------

test("a single planImport call classifies a mixed batch correctly, each entity independently of the others", async () => {
  const destination = new Map<string, FakeDestinationRow>([
    ["unchanged-id", { version: 1, hash: "same" }],
    ["applied-id", { version: 2, hash: "baseline-hash" }],
    ["conflict-id", { version: 3, hash: "edited-elsewhere" }],
    ["forced-id", { version: 4, hash: "also-edited-elsewhere" }],
  ]);
  const handler = makeFakeHandler({ entityType: "widget", destination, blockedIds: new Set(["blocked-id"]), blockReason: "blocked reason" });
  registerPublishContentContributor(fakeContributor(handler));
  const before = snapshot(destination);

  const baselines = new Map<string, BaselineRecord | null>([
    [entityKey("widget", "applied-id"), { hashAtLastSync: "baseline-hash", hashVersion: CONTENT_HASH_VERSION }],
    [entityKey("widget", "conflict-id"), { hashAtLastSync: "old-baseline", hashVersion: CONTENT_HASH_VERSION }],
    [entityKey("widget", "forced-id"), { hashAtLastSync: "old-baseline-2", hashVersion: CONTENT_HASH_VERSION }],
  ]);
  const entities = [
    makeEntity({ entityType: "widget", id: "created-id", contentHash: "new" }),
    makeEntity({ entityType: "widget", id: "unchanged-id", contentHash: "same" }),
    makeEntity({ entityType: "widget", id: "applied-id", contentHash: "new-source" }),
    makeEntity({ entityType: "widget", id: "conflict-id", contentHash: "new-source" }),
    makeEntity({ entityType: "widget", id: "forced-id", contentHash: "new-source" }),
    makeEntity({ entityType: "widget", id: "blocked-id", contentHash: "irrelevant" }),
  ];
  const report = await planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities },
    makeDeps({ baselines, forcedEntityKeys: new Set([entityKey("widget", "forced-id")]) })
  );

  const byId = new Map(report.rows.map((row) => [row.entityId, row.outcome]));
  assert.equal(byId.get("created-id"), "created");
  assert.equal(byId.get("unchanged-id"), "unchanged");
  assert.equal(byId.get("applied-id"), "applied");
  assert.equal(byId.get("conflict-id"), "conflict");
  assert.equal(byId.get("forced-id"), "forced");
  assert.equal(byId.get("blocked-id"), "blocked");
  assert.equal(report.rows.length, 6);
  assertUnchanged(destination, before, "mixed batch");
});

// ---------------------------------------------------------------------------
// 3. dependsOn-derived apply order
// ---------------------------------------------------------------------------

test("planImport's applyOrder places a dependency's type before its dependent's, and rows follow that order", async () => {
  const mediaDestination = new Map<string, FakeDestinationRow>();
  const postDestination = new Map<string, FakeDestinationRow>();
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "media", destination: mediaDestination })));
  registerPublishContentContributor(
    fakeContributor(makeFakeHandler({ entityType: "post", destination: postDestination, dependsOn: ["media"] }))
  );

  const entities = [makeEntity({ entityType: "post", id: "p1" }), makeEntity({ entityType: "media", id: "m1" })];
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities }, makeDeps({}));

  assert.deepEqual(report.applyOrder, ["media", "post"]);
  assert.deepEqual(report.rows.map((row) => row.entityId), ["m1", "p1"], "rows must follow applyOrder, not bundle order");
});

test("a contributor registered AFTER an earlier planImport call is picked up by the very next call", async () => {
  const destination = new Map<string, FakeDestinationRow>();
  const entity = makeEntity({ entityType: "widget", id: "w1" });

  const first = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({}));
  assert.equal(first.rows[0].outcome, "blocked", "no handler registered yet");

  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));
  const second = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, makeDeps({}));
  assert.equal(second.rows[0].outcome, "created", "the newly registered contributor must be seen without recreating planImport itself");
});

// ---------------------------------------------------------------------------
// 4. End-to-end against the REAL post contributor (Task 2) + a real InMemoryPostRepo
// ---------------------------------------------------------------------------

test("real post contributor: created + byte-identical destination", async () => {
  const { InMemoryPostRepo } = await import("../../post/repo.memory.js");
  const { contributePostPublish } = await import("../../post/publish-content.js");
  const { contributeMediaPublish } = await import("../../media/publish-content.js");
  const { contributeTaxonomyPublish, contributeTermPublish } = await import("../../taxonomy/publish-content.js");
  registerPublishContentContributor(contributeMediaPublish());
  registerPublishContentContributor(contributeTaxonomyPublish());
  registerPublishContentContributor(contributeTermPublish());
  registerPublishContentContributor(contributePostPublish());

  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const existing = {
    id: "post-1",
    workspaceId,
    title: "Existing",
    slug: "existing",
    bodyJson: { type: "doc", content: [] },
    status: "draft" as const,
    kind: "post" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
  };
  const repo = new InMemoryPostRepo([existing]);
  const before = JSON.stringify(await repo.list({ workspaceId }));

  const newPostState = { ...existing, id: "post-2", slug: "new-post", title: "New Post" };
  const entity: PackedEntity = {
    entityType: "post",
    id: "post-2",
    schemaVersion: 2, // post's current version (termIds, plan §3.7)
    contentHash: contentHash("post", newPostState),
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: [],
    state: newPostState,
  };
  const deps: PlanImportDeps = {
    publishContentDeps: { workspaceId, clock: { nowIso: () => "2026-09-18T00:00:00.000Z" }, idGen: { newId: () => "unused" }, ports: { post: { repo } } },
    getBaseline: async () => null,
    hasBlob: async () => true,
  };
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, deps);

  assert.equal(report.rows[0].outcome, "created");
  assert.equal(JSON.stringify(await repo.list({ workspaceId })), before, "real repo must be byte-identical after planImport");
});

test("real post contributor: blocked on a genuine slug collision against a DIFFERENT existing post", async () => {
  const { InMemoryPostRepo } = await import("../../post/repo.memory.js");
  const { contributePostPublish } = await import("../../post/publish-content.js");
  const { contributeMediaPublish } = await import("../../media/publish-content.js");
  const { contributeTaxonomyPublish, contributeTermPublish } = await import("../../taxonomy/publish-content.js");
  registerPublishContentContributor(contributeMediaPublish());
  registerPublishContentContributor(contributeTaxonomyPublish());
  registerPublishContentContributor(contributeTermPublish());
  registerPublishContentContributor(contributePostPublish());

  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const existing = {
    id: "post-1",
    workspaceId,
    title: "Existing",
    slug: "taken-slug",
    bodyJson: { type: "doc", content: [] },
    status: "draft" as const,
    kind: "post" as const,
    bodyFormat: "doc" as const,
    bodyHtml: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
  };
  const repo = new InMemoryPostRepo([existing]);
  const before = JSON.stringify(await repo.list({ workspaceId }));

  const incomingState = { ...existing, id: "post-2", slug: "taken-slug" };
  const entity: PackedEntity = {
    entityType: "post",
    id: "post-2",
    schemaVersion: 2, // post's current version (termIds, plan §3.7)
    contentHash: contentHash("post", incomingState),
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: [],
    state: incomingState,
  };
  const deps: PlanImportDeps = {
    publishContentDeps: { workspaceId, clock: { nowIso: () => "2026-09-18T00:00:00.000Z" }, idGen: { newId: () => "unused" }, ports: { post: { repo } } },
    getBaseline: async () => null,
    hasBlob: async () => true,
  };
  const report = await planImport({ artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] }, deps);

  assert.equal(report.rows[0].outcome, "blocked");
  assert.match(report.rows[0].reason ?? "", /already held by a different post \('post-1'\)/);
  assert.equal(JSON.stringify(await repo.list({ workspaceId })), before, "real repo must be byte-identical after a blocked plan");
});

// ---------------------------------------------------------------------------
// 5. entityKey — trivial but load-bearing (forced-selection matching depends on it being stable)
// ---------------------------------------------------------------------------

test("entityKey joins entityType and id with a stable separator", () => {
  assert.equal(entityKey("post", "abc"), "post:abc");
});

// ---------------------------------------------------------------------------
// 4. The human identifier a report row is named by (owner-directed, 2026-09-19)
// ---------------------------------------------------------------------------

test("entityDisplayLabel prefers the slug, then the title, then name/filename", () => {
  assert.equal(entityDisplayLabel({ slug: "spring-sale", title: "Spring Sale", name: "n", filename: "f.png" }), "spring-sale");
  assert.equal(entityDisplayLabel({ title: "Spring Sale", name: "n" }), "Spring Sale");
  assert.equal(entityDisplayLabel({ name: "n", filename: "f.png" }), "n");
  assert.equal(entityDisplayLabel({ filename: "f.png" }), "f.png");
});

test("entityDisplayLabel names a content type by its label and a widget area by its region", () => {
  assert.equal(entityDisplayLabel({ key: "recipe", label: "Recipes", fields: [] }), "Recipes");
  assert.equal(entityDisplayLabel({ regionKey: "sidebar-primary", placements: [] }), "sidebar-primary");
  assert.equal(entityDisplayLabel({ name: "Category", label: "Categories" }), "Category", "name still outranks label");
});

test("entityDisplayLabel returns null rather than an unusable label", () => {
  assert.equal(entityDisplayLabel({}), null, "no candidate field at all");
  assert.equal(entityDisplayLabel({ slug: "" }), null, "an empty slug is not a label");
  assert.equal(entityDisplayLabel({ slug: "   " }), null, "a whitespace-only slug is not a label");
  assert.equal(entityDisplayLabel({ slug: 42, title: "Fallback" }), "Fallback", "a non-string slug is skipped, not coerced");
  assert.equal(entityDisplayLabel({ slug: null }), null);
});

test("every planned row carries the label its own packed state named it, whatever the outcome", async () => {
  // Both a writing outcome and a non-writing one: the entity column must be readable for a row the
  // operator is being asked to skip just as much as for one they are being asked to publish.
  const destination = new Map<string, FakeDestinationRow>([["m2", { version: 1, hash: "same" }]]);
  registerPublishContentContributor(fakeContributor(makeFakeHandler({ entityType: "widget", destination })));

  const report = await planImport(
    {
      artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION,
      hashVersion: CONTENT_HASH_VERSION,
      entities: [
        makeEntity({ entityType: "widget", id: "m1", state: { slug: "spring-sale", title: "Spring Sale" } }),
        makeEntity({ entityType: "widget", id: "m2", contentHash: "same", state: { title: "Already There" } }),
        makeEntity({ entityType: "widget", id: "m3", state: { caption: "no identifier here" } }),
      ],
    },
    makeDeps({})
  );

  assert.deepEqual(
    report.rows.map((row) => [row.entityId, row.outcome, row.entityLabel]),
    [
      ["m1", "created", "spring-sale"],
      ["m2", "unchanged", "Already There"],
      ["m3", "created", null],
    ]
  );
});
