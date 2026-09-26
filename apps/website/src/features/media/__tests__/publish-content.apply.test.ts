/**
 * @file `media`'s publish-content `apply()` — the write path that replaced Task 12's deliberate
 * stub (`../publish-content.ts`'s `apply()` used to throw "is not wired yet").
 *
 * The two decisions Task 12's stub deliberately refused to make, and which these tests pin:
 *
 *  1. **Where the raw bytes come from:** the destination's OWN `BlobStorePort`, addressed by
 *     `computeBlobStorageKey({workspaceId, sha256})` — Task 6's blob pre-flight route
 *     (`routes/publish-content/blob-put.ts`) put them there before any apply ever runs. A sha the
 *     destination never received is a REPORTED, non-destructive block
 *     (`MediaApplyBlockedError` / `blocked:missing-blob`) that writes nothing — never a silent skip
 *     and never a partial write.
 *  2. **The command gateway:** yes — media's `apply()` routes through `executeCommand` exactly like
 *     `features/post/publish-content.ts`'s does, so every media import is an auditable, revertible
 *     `change_sets` row. This matters MORE for media than for posts: `asset_blobs` has no revision
 *     ledger, so an overwrite there would be genuinely unrecoverable.
 *
 * Every test here was confirmed RED against the unimplemented `apply()` before the implementation
 * landed, and tests 1/3/5 were additionally re-confirmed RED against a deliberately broken
 * implementation (see the report) rather than trusted on a first GREEN.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "@jini-ai/cms/core";

import { InMemoryChangeSetRepo } from "#src/contracts/core/commands/index";
import { InMemoryOutbox } from "#src/contracts/core/events/index";
import {
  computeBlobStorageKey,
  InMemoryAssetBlobRepo,
  InMemoryBlobStore,
  InMemoryVersionedMediaRepo,
  type AssetBlobRecord,
  type BlobStorePort,
  type MediaRecord,
  type VersionedMediaRepoPort,
} from "#src/features/media/index";
import { openContentDb } from "#src/platform/db/sqlite/content-db";
import { SqliteMediaRepo } from "#src/platform/db/sqlite/media-repo.sqlite";
import { contentHash, CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import type { PublishContentDeps } from "#src/features/publish-content/type-registry";
import { renderDocNode, type MediaAssetRenderMeta } from "#src/server/inbound/public-http/http/site/render";

import { contributeMediaPublish, MediaApplyBlockedError, MediaApplyConflictError } from "../publish-content.js";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const OPERATOR_ID = "operator-principal-1";

/** Real sha256 of these exact bytes, pinned as a literal rather than recomputed at test time so a
 *  regression in the hashing itself cannot quietly rubber-stamp its own assertion (same discipline
 *  as `import-media-entity.test.ts`'s own pinned digest). */
const PHOTO_BYTES = new TextEncoder().encode("a real imported photo's bytes");
const PHOTO_SHA256 = "86d9075d85c1cce55da0605a557dceaea6c27f18df8702ce86accccce8a41aa9";

function makeMediaRecord(overrides: Partial<MediaRecord> = {}): MediaRecord {
  return {
    id: "source-system-asset-42",
    workspaceId: WORKSPACE_ID,
    title: "Team Photo",
    slug: "team-photo",
    alt: "The whole team",
    caption: "",
    credit: "",
    source: { sha256: PHOTO_SHA256 },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 7, // deliberately NOT 1 — the destination computes its own; the source's must be ignored.
    width: 800,
    height: 600,
    cssClass: "rounded",
    htmlAttributes: null,
    ...overrides,
  };
}

function packedFrom(record: MediaRecord) {
  return {
    entityType: "media",
    id: record.id,
    schemaVersion: 1,
    contentHash: contentHash("media", { ...record }),
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: [record.source.sha256],
    state: { ...record } as unknown as Record<string, unknown>,
  };
}

interface Fixture {
  readonly deps: PublishContentDeps;
  readonly mediaRepo: VersionedMediaRepoPort;
  readonly assetBlobRepo: InMemoryAssetBlobRepo;
  readonly blobStore: InMemoryBlobStore;
  readonly changeSets: InMemoryChangeSetRepo;
}

/** A fully wired deps bag — what a real `apply-loop.ts` composition supplies. `authorize` always
 *  allows: these tests exercise `apply()`'s own write path, not `executeCommand`'s authorization
 *  gate (covered by the gateway's own suite).
 *
 *  `mediaRepo` is overridable (2026-09-20, media optimistic-concurrency fix) so the same fixture
 *  can be parameterized over BOTH `VersionedMediaRepoPort` adapters — `InMemoryVersionedMediaRepo`
 *  (the default, used by every test below except the concurrency race tests) and `SqliteMediaRepo`
 *  — proving the atomic compare-and-set write holds on the real production adapter too, not just
 *  the in-memory double. When a caller supplies one, `mediaRows` is seeded onto it via `save()`
 *  (async) rather than a bulk constructor, since `SqliteMediaRepo` has no such constructor. */
async function makeFixture(
  options: { mediaRows?: MediaRecord[]; blobRows?: AssetBlobRecord[]; mediaRepo?: VersionedMediaRepoPort } = {}
): Promise<Fixture> {
  const mediaRepo = options.mediaRepo ?? new InMemoryVersionedMediaRepo(options.mediaRows ? [...options.mediaRows] : []);
  if (options.mediaRepo && options.mediaRows) {
    for (const row of options.mediaRows) await mediaRepo.save(row);
  }
  const assetBlobRepo = new InMemoryAssetBlobRepo(options.blobRows ? [...options.blobRows] : []);
  const blobStore = new InMemoryBlobStore();
  const outbox = new InMemoryOutbox();
  const changeSets = new InMemoryChangeSetRepo([], [], outbox);
  let n = 0;
  const deps: PublishContentDeps = {
    workspaceId: WORKSPACE_ID,
    clock: { nowIso: () => "2026-09-18T12:00:00.000Z" },
    idGen: { newId: () => `generated-id-${++n}` },
    outbox,
    changeSets,
    authorize: async () => ({ allowed: true, reason: "test-always-allow" }),
    ports: { media: { repo: mediaRepo, assetBlobRepo, blobStore } },
  };
  return { deps, mediaRepo, assetBlobRepo, blobStore, changeSets };
}

/** Puts `bytes` where Task 6's blob pre-flight PUT route would already have put them. */
async function stageBlobBytes(blobStore: InMemoryBlobStore, sha256: string, bytes: Uint8Array): Promise<void> {
  await blobStore.putIfAbsent({ workspaceId: WORKSPACE_ID, sha256, bytes });
}

function handlerFor(deps: PublishContentDeps) {
  return contributeMediaPublish().build(deps);
}

// ---------------------------------------------------------------------------
// 1. A media entity applies end to end and keeps the SOURCE id
// ---------------------------------------------------------------------------

test("apply() writes the media row under the SOURCE id — the id a post's embed already points at", async () => {
  const fixture = await makeFixture();
  const record = makeMediaRecord();
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

  const result = await handlerFor(fixture.deps).apply({
    entity: packedFrom(record),
    expectedVersion: undefined,
    principalId: OPERATOR_ID,
  });

  assert.ok(result.changeSetId, "apply() must return the change set it recorded");

  const landed = await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "source-system-asset-42" });
  assert.ok(landed, "the destination row must be findable by the SOURCE id, never a freshly minted one");
  assert.equal(landed.id, "source-system-asset-42");
  assert.equal(landed.title, "Team Photo");
  assert.equal(landed.source.sha256, PHOTO_SHA256);
  // Destination-local write bookkeeping is recomputed, never carried over from the source's own row.
  assert.equal(landed.version, 1, "a brand-new destination row starts at version 1, not the source's 7");
  assert.equal(landed.updatedAt, "2026-09-18T12:00:00.000Z");

  const blob = await fixture.assetBlobRepo.findByHash({ workspaceId: WORKSPACE_ID, sha256: PHOTO_SHA256 });
  assert.ok(blob, "the asset_blobs row must exist so the bytes are reachable");
  assert.equal(blob.createdByPrincipal, OPERATOR_ID, "a brand-new blob row is attributed to the importing operator");

  const recorded = await fixture.changeSets.findById({ workspaceId: WORKSPACE_ID, id: result.changeSetId });
  assert.ok(recorded, "the write must be recorded as a change set — media has no revision ledger of its own");
  assert.equal(recorded.changeSet.actorId, OPERATOR_ID);
  assert.equal(recorded.items[0]?.entityType, "media");
  assert.equal(recorded.items[0]?.entityId, "source-system-asset-42");
  assert.equal(recorded.items[0]?.operation, "create");
  assert.equal(recorded.items[0]?.entityVersionAtApply, 1);
});

// ---------------------------------------------------------------------------
// 2. A post importing alongside it renders its embed (the user-visible property)
// ---------------------------------------------------------------------------

test("apply() + renderDocNode: a post's embed authored against the SOURCE asset id renders a real <img>, never the placeholder", async () => {
  const fixture = await makeFixture();
  const record = makeMediaRecord();
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

  await handlerFor(fixture.deps).apply({ entity: packedFrom(record), expectedVersion: undefined, principalId: OPERATOR_ID });

  // Resolve the way a real render caller does — look the row back up by the id the post's doc node
  // carries, and build the render maps from what is actually there.
  const imported = await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "source-system-asset-42" });
  assert.ok(imported, "the imported row must be findable by the source id");
  const mediaAssetMetadata = new Map<string, MediaAssetRenderMeta>([
    [
      imported.id,
      { width: imported.width, height: imported.height, cssClass: imported.cssClass, htmlAttributes: imported.htmlAttributes, contentType: null },
    ],
  ]);
  const mediaTransformVersions = new Map<string, number>([["public", 1]]);

  const postBodyDoc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "source-system-asset-42", transformName: "public", alt: "The whole team" } }],
  };
  const html = renderDocNode(postBodyDoc, undefined, mediaTransformVersions, mediaAssetMetadata);

  assert.match(
    html,
    /<img src="\/m\/source-system-asset-42\/public\.v1\/image\.jpg" alt="The whole team" width="800" height="600" class="rounded"/
  );
  assert.doesNotMatch(html, /media-ph/, "must render the real image, never the missing-asset placeholder");
});

// ---------------------------------------------------------------------------
// 3. A sha the destination never received: reported, and NOTHING written
// ---------------------------------------------------------------------------

test("apply() blocks with 'blocked:missing-blob' when the bundle names a sha this destination never received — and writes nothing", async () => {
  const fixture = await makeFixture();
  const record = makeMediaRecord();
  // Deliberately NOT staged — this is the exact "bundle manifest lists a sha we never got" case.

  const thrown = await handlerFor(fixture.deps)
    .apply({ entity: packedFrom(record), expectedVersion: undefined, principalId: OPERATOR_ID })
    .then(
      () => null,
      (error: unknown) => error
    );

  assert.ok(thrown instanceof MediaApplyBlockedError, "must be the typed blocked error, not a generic crash");
  assert.equal(thrown.code, "blocked:missing-blob");
  assert.equal(
    thrown.message,
    `media 'source-system-asset-42' cannot be applied — required blob '${PHOTO_SHA256}' was never received by this destination`
  );

  assert.equal(await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "source-system-asset-42" }), null, "no media row");
  assert.equal(await fixture.assetBlobRepo.findByHash({ workspaceId: WORKSPACE_ID, sha256: PHOTO_SHA256 }), null, "no asset_blobs row");
  assert.deepEqual(
    await fixture.changeSets.listByWorkspace({ workspaceId: WORKSPACE_ID }),
    [],
    "no change set recorded for a write that never happened"
  );
});

// ---------------------------------------------------------------------------
// 4. Existing blob attribution is preserved AND reported; a new blob gets the operator
// ---------------------------------------------------------------------------

test("apply() never re-stamps an existing asset_blobs row's createdByPrincipal, and reports the reuse as blobWritten:false", async () => {
  const existingBlob: AssetBlobRecord = {
    id: "pre-existing-blob",
    workspaceId: WORKSPACE_ID,
    sha256: PHOTO_SHA256,
    storageKey: computeBlobStorageKey({ workspaceId: WORKSPACE_ID, sha256: PHOTO_SHA256 }),
    createdByPrincipal: "the-original-uploader",
    createdAt: "2025-05-05T00:00:00.000Z",
    status: "active",
  };
  const fixture = await makeFixture({ blobRows: [existingBlob] });
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

  const result = await handlerFor(fixture.deps).apply({
    entity: packedFrom(makeMediaRecord()),
    expectedVersion: undefined,
    principalId: OPERATOR_ID,
  });

  assert.equal(result.blobWritten, false, "the reuse must be reported so a caller can tell a preserved row from a written one");
  const blob = await fixture.assetBlobRepo.findByHash({ workspaceId: WORKSPACE_ID, sha256: PHOTO_SHA256 });
  assert.ok(blob);
  assert.equal(blob.createdByPrincipal, "the-original-uploader", "the original attribution must survive the import untouched");
  assert.equal(blob.id, "pre-existing-blob", "the existing row itself must not be replaced");
  assert.equal(blob.createdAt, "2025-05-05T00:00:00.000Z");

  // Reuse is normal and expected — it must never surface as a conflict or a warning. The media row
  // still lands, and the change set still records an ordinary successful import.
  const recorded = await fixture.changeSets.findById({ workspaceId: WORKSPACE_ID, id: result.changeSetId });
  assert.ok(recorded);
  assert.match(recorded.changeSet.summary, /existing blob .* reused/);
  assert.doesNotMatch(recorded.changeSet.summary, /conflict|warning/i);
});

test("apply() attributes a BRAND-NEW asset_blobs row to the importing operator, and reports blobWritten:true", async () => {
  const fixture = await makeFixture();
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

  const result = await handlerFor(fixture.deps).apply({
    entity: packedFrom(makeMediaRecord()),
    expectedVersion: undefined,
    principalId: OPERATOR_ID,
  });

  assert.equal(result.blobWritten, true);
  const blob = await fixture.assetBlobRepo.findByHash({ workspaceId: WORKSPACE_ID, sha256: PHOTO_SHA256 });
  assert.equal(blob?.createdByPrincipal, OPERATOR_ID);
  const recorded = await fixture.changeSets.findById({ workspaceId: WORKSPACE_ID, id: result.changeSetId });
  assert.match(recorded!.changeSet.summary, /new blob/);
});

// ---------------------------------------------------------------------------
// 5. blocked:slug-taken writes nothing — no blob row AND no media row
// ---------------------------------------------------------------------------

test("apply() blocks with 'blocked:slug-taken' when the slug is held by a DIFFERENT id — and writes neither a blob row nor a media row", async () => {
  const squatter = makeMediaRecord({ id: "a-different-local-asset", slug: "team-photo", source: { sha256: "f".repeat(64) } });
  const fixture = await makeFixture({ mediaRows: [squatter] });
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

  const thrown = await handlerFor(fixture.deps)
    .apply({ entity: packedFrom(makeMediaRecord()), expectedVersion: undefined, principalId: OPERATOR_ID })
    .then(
      () => null,
      (error: unknown) => error
    );

  assert.ok(thrown instanceof MediaApplyBlockedError);
  assert.equal(thrown.code, "blocked:slug-taken");
  assert.equal(
    thrown.message,
    "media 'source-system-asset-42' cannot be applied — slug 'team-photo' is already held by a different media ('a-different-local-asset')"
  );

  assert.equal(
    await fixture.assetBlobRepo.findByHash({ workspaceId: WORKSPACE_ID, sha256: PHOTO_SHA256 }),
    null,
    "a slug collision must never leave a dangling blob row behind"
  );
  assert.equal(await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "source-system-asset-42" }), null, "no media row");
  const squatterAfter = await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "a-different-local-asset" });
  assert.equal(squatterAfter?.source.sha256, "f".repeat(64), "the row holding the slug must be untouched");
  assert.deepEqual(await fixture.changeSets.listByWorkspace({ workspaceId: WORKSPACE_ID }), []);
});

// ---------------------------------------------------------------------------
// Update path + the optimistic-concurrency guard the handler contract requires
// ---------------------------------------------------------------------------

test("apply() updates an existing row when expectedVersion matches, recording the prior record as the change set's inverse", async () => {
  const existing = makeMediaRecord({ title: "Old Title", version: 3, updatedAt: "2026-02-02T00:00:00.000Z" });
  const fixture = await makeFixture({ mediaRows: [existing] });
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

  const result = await handlerFor(fixture.deps).apply({
    entity: packedFrom(makeMediaRecord({ title: "New Title" })),
    expectedVersion: 3,
    principalId: OPERATOR_ID,
  });

  const landed = await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "source-system-asset-42" });
  assert.equal(landed?.title, "New Title");
  assert.equal(landed?.version, 4);
  assert.equal(landed?.createdAt, "2026-01-01T00:00:00.000Z", "createdAt is write-once — the existing row keeps its own");

  const recorded = await fixture.changeSets.findById({ workspaceId: WORKSPACE_ID, id: result.changeSetId });
  assert.equal(recorded?.items[0]?.operation, "update");
  assert.equal(recorded?.items[0]?.entityVersionAtApply, 4);
  assert.equal(
    (recorded?.items[0]?.inversePayload as Record<string, unknown> | undefined)?.title,
    "Old Title",
    "the inverse must carry the pre-write record — media has no revision ledger, so this IS the revert path"
  );
});

test("apply() refuses to overwrite a destination row that moved on from expectedVersion", async () => {
  const existing = makeMediaRecord({ title: "Edited Locally", version: 9 });
  const fixture = await makeFixture({ mediaRows: [existing] });
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

  const thrown = await handlerFor(fixture.deps)
    .apply({ entity: packedFrom(makeMediaRecord({ title: "Incoming" })), expectedVersion: 3, principalId: OPERATOR_ID })
    .then(
      () => null,
      (error: unknown) => error
    );

  assert.ok(thrown instanceof MediaApplyConflictError);
  assert.equal(
    (thrown as Error).message,
    "media 'source-system-asset-42' changed on the destination during apply: expected version 3, found version 9"
  );
  const untouched = await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "source-system-asset-42" });
  assert.equal(untouched?.title, "Edited Locally", "the losing write must never land");
  assert.equal(untouched?.version, 9);
});

test("apply() refuses a 'created' row when the destination grew one between plan and apply", async () => {
  const fixture = await makeFixture({ mediaRows: [makeMediaRecord({ title: "Created By Someone Else", version: 2 })] });
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

  const thrown = await handlerFor(fixture.deps)
    .apply({ entity: packedFrom(makeMediaRecord()), expectedVersion: undefined, principalId: OPERATOR_ID })
    .then(
      () => null,
      (error: unknown) => error
    );

  assert.ok(thrown instanceof MediaApplyConflictError);
  assert.equal(
    (thrown as Error).message,
    "media 'source-system-asset-42' changed on the destination during apply: expected no existing row, found version 2"
  );
  const untouched = await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "source-system-asset-42" });
  assert.equal(untouched?.title, "Created By Someone Else");
});

// ---------------------------------------------------------------------------
// Concurrency race — two writers planned against the SAME basis cannot both land
// (2026-09-20, media optimistic-concurrency fix)
// ---------------------------------------------------------------------------

/** A manually resolved deferred promise — never a timer, per this repo's race-test convention. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Wraps `store` so its `get()` PARKS after `expected` concurrent callers have all called in, and
 * releases every parked caller only once `release()` is invoked. This is what lets a test start two
 * `apply()` calls, wait until BOTH have passed Guard 1's version compare and are blocked on fetching
 * blob bytes (the real `await` gap the disclosed limitation named), and only then let either one's
 * write actually run — reproducing the race deterministically instead of hoping for unlucky
 * scheduling.
 */
function gateBlobGets(store: InMemoryBlobStore, expected: number) {
  const release = deferred();
  const allParked = deferred();
  let parked = 0;
  const gated: BlobStorePort = {
    put: (i) => store.put(i),
    putIfAbsent: (i) => store.putIfAbsent(i),
    exists: (i) => store.exists(i),
    remove: (i) => store.remove(i),
    get: async (i) => {
      parked += 1;
      if (parked === expected) allParked.resolve();
      await release.promise;
      return store.get(i);
    },
  };
  return { gated, allParked: allParked.promise, release: release.resolve };
}

for (const [label, makeRepo] of [
  ["sqlite", () => new SqliteMediaRepo(openContentDb(":memory:"))],
  ["memory", () => new InMemoryVersionedMediaRepo()],
] as const) {
  test(`[${label}] apply(): two concurrent updates planned against the same version cannot both land — one wins, the other is a conflict`, async () => {
    const seeded = makeMediaRecord({ title: "Old Title", version: 3 });
    const fixture = await makeFixture({ mediaRepo: makeRepo(), mediaRows: [seeded] });
    await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

    const gate = gateBlobGets(fixture.blobStore, 2);
    const handler = handlerFor({ ...fixture.deps, ports: { media: { ...fixture.deps.ports.media!, blobStore: gate.gated } } });

    const a = handler.apply({
      entity: packedFrom(makeMediaRecord({ title: "Title From A" })),
      expectedVersion: 3,
      principalId: OPERATOR_ID,
      idempotencyKey: "race-a",
    });
    const b = handler.apply({
      entity: packedFrom(makeMediaRecord({ title: "Title From B" })),
      expectedVersion: 3,
      principalId: OPERATOR_ID,
      idempotencyKey: "race-b",
    });

    // Both calls are now blocked on `blobStore.get()`, past Guard 1's compare, neither has written.
    await gate.allParked;
    gate.release();
    const settled = await Promise.allSettled([a, b]);

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one writer must win");
    assert.equal(rejected.length, 1, "exactly one writer must be refused as a conflict");

    const rejection = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(rejection instanceof MediaApplyConflictError, `expected MediaApplyConflictError, got ${rejection}`);
    assert.equal(
      (rejection as Error).message,
      "media 'source-system-asset-42' changed on the destination during apply: expected version 3, found version 4"
    );

    const landed = await fixture.mediaRepo.findById({ workspaceId: WORKSPACE_ID, id: "source-system-asset-42" });
    assert.equal(landed?.version, 4, "the row must land at exactly version 4 — never both writes, never neither");
    // Derive the winner's title from `settled` rather than assuming which of a/b won — the whole
    // point of this test is that interleaving is not something the caller controls.
    const winnerIndex = settled.findIndex((s) => s.status === "fulfilled");
    const winnerTitle = winnerIndex === 0 ? "Title From A" : "Title From B";
    assert.equal(landed?.title, winnerTitle);

    assert.equal((await fixture.changeSets.listByWorkspace({ workspaceId: WORKSPACE_ID })).length, 1);
  });

  test(`[${label}] apply(): two concurrent creates of the same id cannot both land`, async () => {
    const fixture = await makeFixture({ mediaRepo: makeRepo() });
    await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);

    const gate = gateBlobGets(fixture.blobStore, 2);
    const handler = handlerFor({ ...fixture.deps, ports: { media: { ...fixture.deps.ports.media!, blobStore: gate.gated } } });

    const a = handler.apply({
      entity: packedFrom(makeMediaRecord({ title: "Title From A" })),
      expectedVersion: undefined,
      principalId: OPERATOR_ID,
      idempotencyKey: "race-a",
    });
    const b = handler.apply({
      entity: packedFrom(makeMediaRecord({ title: "Title From B" })),
      expectedVersion: undefined,
      principalId: OPERATOR_ID,
      idempotencyKey: "race-b",
    });

    await gate.allParked;
    gate.release();
    const settled = await Promise.allSettled([a, b]);

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one create must win");
    assert.equal(rejected.length, 1, "exactly one create must be refused as a conflict");

    const rejection = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(rejection instanceof MediaApplyConflictError, `expected MediaApplyConflictError, got ${rejection}`);
    assert.equal(
      (rejection as Error).message,
      "media 'source-system-asset-42' changed on the destination during apply: expected no existing row, found version 1"
    );

    assert.equal((await fixture.changeSets.listByWorkspace({ workspaceId: WORKSPACE_ID })).length, 1);
  });
}

// ---------------------------------------------------------------------------
// Wiring guards — apply() must never silently no-op when its deps are absent
// ---------------------------------------------------------------------------

test("apply() throws a named error when changeSets/authorize/outbox are not wired", async () => {
  const fixture = await makeFixture();
  const deps: PublishContentDeps = { ...fixture.deps, changeSets: undefined, authorize: undefined, outbox: undefined };
  await assert.rejects(
    () => handlerFor(deps).apply({ entity: packedFrom(makeMediaRecord()), expectedVersion: undefined, principalId: OPERATOR_ID }),
    /media\.apply\(\) requires PublishContentDeps\.changeSets\/authorize\/outbox.*apply-loop\.ts/s
  );
});

test("apply() throws a named error when ports.media is not wired", async () => {
  const fixture = await makeFixture();
  const deps: PublishContentDeps = { ...fixture.deps, ports: {} };
  await assert.rejects(
    () => handlerFor(deps).apply({ entity: packedFrom(makeMediaRecord()), expectedVersion: undefined, principalId: OPERATOR_ID }),
    /media\.apply\(\) requires PublishContentDeps\.ports\.media.*apply-loop\.ts/s
  );
});

test("apply() no longer throws Task 12's 'not wired yet' stub error", async () => {
  const fixture = await makeFixture();
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);
  const result = await handlerFor(fixture.deps).apply({
    entity: packedFrom(makeMediaRecord()),
    expectedVersion: undefined,
    principalId: OPERATOR_ID,
  });
  assert.ok(result.changeSetId);
});

// ---------------------------------------------------------------------------
// precheck() — the planner-facing report channel for the same two blocks
// ---------------------------------------------------------------------------

test("precheck() reports a missing blob so the planner can emit a 'blocked' row before any apply is attempted", async () => {
  const fixture = await makeFixture();
  const reason = await handlerFor(fixture.deps).precheck(packedFrom(makeMediaRecord()));
  assert.equal(reason, `required blob '${PHOTO_SHA256}' is not available on this destination`);
});

test("precheck() returns null once the blob has been staged and no slug holds the name", async () => {
  const fixture = await makeFixture();
  await stageBlobBytes(fixture.blobStore, PHOTO_SHA256, PHOTO_BYTES);
  assert.equal(await handlerFor(fixture.deps).precheck(packedFrom(makeMediaRecord())), null);
});
