/**
 * @file Task 2 (data-only registry mechanics) AND Task 8 (the real `apply()`, 2026-09-18) of the
 * publish-content (Publish Content) feature — direct unit tests for
 * `contributePostPublish()`/`contributePagePublish()` (`../publish-content.ts`). Not required by the
 * team-lead dispatch's own test list for `pack`/`inspect`/`precheck` (that list covers only registry
 * mechanics — see `features/publish-content/__tests__/type-registry.test.ts`), but added per this
 * repo's own coverage-self-check discipline: every changed function should be directly asserted. The
 * `apply()` tests below ARE part of the dispatch's own required coverage (Task 8's create/update
 * paths, Task 15's authorship rule, and the "no changeSets/authorize wired" guard).
 *
 * Exercises `pack`/`inspect`/`precheck` against `InMemoryPostRepo` — the same double `post.test.ts`
 * itself uses. `apply()`'s own unit tests additionally wire an `InMemoryChangeSetRepo` and an
 * always-allow `authorize` stub — the apply LOOP's own race-guard/conflict-downgrade behavior
 * (re-`inspect()` before writing, baseline re-verification) is `apply-loop.ts`'s concern and is
 * tested at that level (`__tests__/apply-loop.test.ts`), not here: this file proves `apply()` itself
 * writes through `createPost`/`updatePost` correctly given a caller that already decided to call it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryChangeSetRepo, revertChangeSet } from "#src/contracts/core/commands/index";
import { InMemoryOutbox } from "#src/contracts/core/events/index";

import { InMemoryPostRepo } from "../repo.memory.js";
import { isTrashed, ROOT_SLUG, type PostRecord } from "../post.js";
import { createPostRevertRegistry } from "../reverters.js";
import { removeVia } from "./remove-post-double.js";
import { contentHash } from "#src/features/publish-content/content-hash";
import type { RetireTarget } from "#src/features/publish-content/type-registry";
import { contributePagePublish, contributePostPublish, toPublishableState } from "../publish-content.js";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

function makeClock() {
  return { nowIso: () => "2026-09-18T00:00:00.000Z" };
}

function makeIdGen() {
  let n = 0;
  return { newId: () => `generated-id-${++n}` };
}

function makePost(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: "post-1",
    workspaceId: WORKSPACE_ID,
    title: "Hello",
    slug: "hello",
    bodyJson: { type: "doc", content: [] },
    status: "draft",
    kind: "post",
    bodyFormat: "doc",
    bodyHtml: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function makeDeps(rows: PostRecord[]) {
  const postRepo = new InMemoryPostRepo(rows);
  return {
    workspaceId: WORKSPACE_ID,
    postRepo,
    clock: makeClock(),
    idGen: makeIdGen(),
    ports: { post: { repo: postRepo } },
  };
}

/** Same as {@link makeDeps} plus a real `changeSets`/`authorize`/`outbox` — what `apply()` actually
 *  requires (see its own doc). `authorize` always allows: these tests exercise `apply()`'s own write
 *  path, not `executeCommand`'s authorization gate (already covered elsewhere). */
function makeApplyDeps(rows: PostRecord[]) {
  const outbox = new InMemoryOutbox();
  const base = makeDeps(rows);
  // Required by `apply()`'s guard: its rollback restores through `restorePostForward`, which
  // needs the Trash-index forget. Nothing in `apply()`'s own tests below trashes a post, so it
  // never fires there — `retire()`'s tests (S4) are what actually exercise it.
  const forgetRemovedPost = async () => {};
  // S4 — `retire()`'s guard requires this too, bound to the SAME repo instance `apply()`'s tests
  // already read/write through (mirrors `retire-post.test.ts`'s own `removeVia(repo)` double).
  const removePost = removeVia(base.postRepo);
  return {
    ...base,
    outbox,
    changeSets: new InMemoryChangeSetRepo([], [], outbox),
    authorize: async () => ({ allowed: true, reason: "test-always-allow" }),
    forgetRemovedPost,
    removePost,
    ports: { post: { repo: base.postRepo, forgetRemoved: forgetRemovedPost, remove: removePost } },
  };
}

function packedFrom(entityType: "post" | "page", post: PostRecord) {
  return {
    entityType,
    id: post.id,
    schemaVersion: 1,
    contentHash: contentHash(entityType, toPublishableState(post)),
    hashVersion: 1,
    requiredBlobs: [],
    state: toPublishableState(post),
  };
}

// ---------------------------------------------------------------------------
// contributePostPublish / contributePagePublish — data-only contract
// ---------------------------------------------------------------------------

test("contributePostPublish returns data only — entityType/dependsOn are plain values, build is deferred", () => {
  const contributor = contributePostPublish();
  assert.equal(contributor.entityType, "post");
  assert.deepEqual(contributor.dependsOn, ["media", "term"]);
  assert.equal(typeof contributor.build, "function");
});

test("contributePagePublish returns data only, distinguished from post only by entityType", () => {
  const contributor = contributePagePublish();
  assert.equal(contributor.entityType, "page");
  assert.deepEqual(contributor.dependsOn, ["media", "term"]);
});

test("both built handlers declare the resource's own content.write permission", () => {
  const deps = makeDeps([]);
  assert.equal(contributePostPublish().build(deps).permission, "content.write");
  assert.equal(contributePagePublish().build(deps).permission, "content.write");
});

// ---------------------------------------------------------------------------
// pack() — kind-filtered, canonicalized, hashed
// ---------------------------------------------------------------------------

test("post.pack() yields only kind:'post' rows, each hashed with contentHash('post', ...)", async () => {
  const post = makePost({ id: "post-1", kind: "post", title: "A Post" });
  const page = makePost({ id: "page-1", kind: "page", slug: "a-page", title: "A Page" });
  const handler = contributePostPublish().build(makeDeps([post, page]));

  const packed = [];
  for await (const entity of handler.pack()) packed.push(entity);

  assert.equal(packed.length, 1);
  assert.equal(packed[0].id, "post-1");
  assert.equal(packed[0].entityType, "post");
  assert.deepEqual(
    Object.keys(packed[0].state).sort(),
    [
      "bodyFormat",
      "bodyHtml",
      "bodyJson",
      "createdAt",
      "createdByPrincipalId",
      "kind",
      "memberAccessJson",
      "overridesThemePage",
      "seoExtJson",
      "slug",
      "status",
      "templateChoice",
      "title",
    ],
    "the packed wire shape changed — every field here is one publish is expected to carry, and a " +
      "field that leaves this list must also leave the content hash (see POST_FIELD_DISPOSITIONS)"
  );
  assert.equal(packed[0].contentHash, contentHash("post", packed[0].state));
  assert.deepEqual(packed[0].requiredBlobs, []);
});

test("page.pack() yields only kind:'page' rows", async () => {
  const post = makePost({ id: "post-1", kind: "post" });
  const page = makePost({ id: "page-1", kind: "page", slug: "a-page" });
  const handler = contributePagePublish().build(makeDeps([post, page]));

  const packed = [];
  for await (const entity of handler.pack()) packed.push(entity);

  assert.equal(packed.length, 1);
  assert.equal(packed[0].id, "page-1");
  assert.equal(packed[0].entityType, "page");
});

test("pack()'s contentHash is stable across two rows with identical content but different id/version/updatedAt", async () => {
  const rowA = makePost({ id: "post-a", version: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
  const rowB = makePost({ id: "post-b", version: 9, updatedAt: "2026-09-01T00:00:00.000Z" });
  const handler = contributePostPublish().build(makeDeps([rowA, rowB]));

  const packed = [];
  for await (const entity of handler.pack()) packed.push(entity);

  assert.equal(packed.length, 2);
  assert.equal(packed[0].contentHash, packed[1].contentHash);
});

// ---------------------------------------------------------------------------
// inspect() — destination lookup, kind-guarded
// ---------------------------------------------------------------------------

test("inspect() returns {version, hash} for an existing row of the matching kind", async () => {
  const post = makePost({ id: "post-1", version: 3 });
  const handler = contributePostPublish().build(makeDeps([post]));

  const packed = [];
  for await (const entity of handler.pack()) packed.push(entity);

  const result = await handler.inspect("post-1");
  assert.deepEqual(
    result,
    { version: 3, hash: packed[0].contentHash },
    "inspect() and pack() must hash the same row identically, or a destination can never be " +
      "compared against a source"
  );
});

test("inspect() returns null for a row that does not exist", async () => {
  const handler = contributePostPublish().build(makeDeps([]));
  assert.equal(await handler.inspect("missing"), null);
});

test("inspect() returns null for a row that exists but is the WRONG kind — a page's id must not resolve through the post handler", async () => {
  const page = makePost({ id: "page-1", kind: "page", slug: "a-page" });
  const handler = contributePostPublish().build(makeDeps([page]));
  assert.equal(await handler.inspect("page-1"), null);
});

// ---------------------------------------------------------------------------
// precheck() — pure precondition check, never writes (plan §5 risk #4)
// ---------------------------------------------------------------------------

test("precheck() allows an entity whose slug is free", async () => {
  const handler = contributePostPublish().build(makeDeps([]));
  const result = await handler.precheck({
    entityType: "post",
    id: "new-post",
    schemaVersion: 1,
    contentHash: "irrelevant",
    hashVersion: 1,
    requiredBlobs: [],
    state: { slug: "free-slug" },
  });
  assert.equal(result, null);
});

test("precheck() allows an entity claiming ITS OWN current slug (updating in place is not a collision)", async () => {
  const existing = makePost({ id: "post-1", slug: "hello" });
  const handler = contributePostPublish().build(makeDeps([existing]));
  const result = await handler.precheck({
    entityType: "post",
    id: "post-1",
    schemaVersion: 1,
    contentHash: "irrelevant",
    hashVersion: 1,
    requiredBlobs: [],
    state: { slug: "hello" },
  });
  assert.equal(result, null);
});

test("precheck() blocks an entity whose slug is held by a DIFFERENT id — never auto-renames (plan §5 risk #4)", async () => {
  const existing = makePost({ id: "post-1", slug: "taken" });
  const handler = contributePostPublish().build(makeDeps([existing]));
  const result = await handler.precheck({
    entityType: "post",
    id: "post-2",
    schemaVersion: 1,
    contentHash: "irrelevant",
    hashVersion: 1,
    requiredBlobs: [],
    state: { slug: "taken" },
  });
  assert.match(result ?? "", /already held by a different post \('post-1'\)/);
});

test("precheck() blocks an entity with no usable slug rather than throwing", async () => {
  const handler = contributePostPublish().build(makeDeps([]));
  const result = await handler.precheck({
    entityType: "post",
    id: "post-1",
    schemaVersion: 1,
    contentHash: "irrelevant",
    hashVersion: 1,
    requiredBlobs: [],
    state: {},
  });
  assert.match(result ?? "", /no usable slug/);
});

test("precheck() no longer blocks a body-format difference — D2 (2026-09-24 owner decision) lets publishing replace it instead of refusing", async () => {
  const existing = makePost({ id: "post-1", slug: "hello", bodyFormat: "html", bodyHtml: "<p>live</p>" });
  const handler = contributePostPublish().build(makeDeps([existing]));
  const result = await handler.precheck({
    entityType: "post",
    id: "post-1",
    schemaVersion: 1,
    contentHash: "irrelevant",
    hashVersion: 1,
    requiredBlobs: [],
    state: { slug: "hello", bodyFormat: "doc" },
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// apply() — deliberately unimplemented (Task 7/8), must fail loudly, never silently no-op
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// apply() — Task 8's real write path
// ---------------------------------------------------------------------------

test("apply() throws when changeSets/authorize/outbox are not wired — never silently no-ops", async () => {
  const handler = contributePostPublish().build(makeDeps([]));
  await assert.rejects(
    () =>
      handler.apply({
        entity: { entityType: "post", id: "x", schemaVersion: 1, contentHash: "h", hashVersion: 1, requiredBlobs: [], state: {} },
        expectedVersion: undefined,
        principalId: "p1",
      }),
    /requires PublishContentDeps.changeSets\/authorize\/outbox/
  );
});

test("apply() 'created' path: writes through createPost and copies the SOURCE author, never the operator's id (Task 15)", async () => {
  const deps = makeApplyDeps([]);
  const handler = contributePostPublish().build(deps);
  const source = makePost({ id: "post-new", title: "Imported", slug: "imported", createdByPrincipalId: "source-author-1" });

  const { changeSetId } = await handler.apply({
    entity: packedFrom("post", source),
    expectedVersion: undefined,
    principalId: "operator-1",
  });

  assert.ok(changeSetId);
  const saved = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-new" });
  assert.equal(saved?.createdByPrincipalId, "source-author-1", "created row's author must be the SOURCE's, not the operator's");
});

test("apply() 'created' path: a null source author imports as null, not the operator's id (Task 15)", async () => {
  const deps = makeApplyDeps([]);
  const handler = contributePostPublish().build(deps);
  const source = makePost({ id: "post-new-2", slug: "imported-2", createdByPrincipalId: null });

  await handler.apply({ entity: packedFrom("post", source), expectedVersion: undefined, principalId: "operator-1" });

  const saved = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-new-2" });
  assert.equal(saved?.createdByPrincipalId, null);
});

test("apply() 'created' path: a change-set failure removes the row outright — an undone create must leave nothing behind", async () => {
  const deps = makeApplyDeps([]);
  // Fails only on the RECORD, after `createPost` has already written the row — the exact window
  // `CommandMutation.rollback` exists for.
  deps.changeSets.insert = async () => {
    throw new Error("change-set store is down");
  };
  const handler = contributePostPublish().build(deps);
  const source = makePost({ id: "post-orphan", title: "Orphan", slug: "orphan" });

  await assert.rejects(
    () => handler.apply({ entity: packedFrom("post", source), expectedVersion: undefined, principalId: "operator-1" }),
    /change-set store is down/
  );

  assert.equal(
    await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-orphan" }),
    null,
    "a create has no pre-image, so the only correct undo is removal — trashing it instead records a creation the system decided had not happened, and leaves a row a user can find and restore"
  );
  assert.equal(
    await deps.postRepo.findBySlug({ workspaceId: WORKSPACE_ID, slug: "orphan" }),
    null,
    "and the slug it took must be released, so a retry of the same import is not blocked by its own failed attempt"
  );
  assert.deepEqual(
    await deps.postRepo.listRevisions({ workspaceId: WORKSPACE_ID, postId: "post-orphan" }),
    [],
    "the create's revision goes with it — nothing in the ledger may point at a row that never happened"
  );
});

test("apply() 'applied' path: writes through updatePost with expectedVersion, actor is the OPERATOR", async () => {
  const existing = makePost({ id: "post-1", version: 3, title: "Old title", createdByPrincipalId: "source-author-1" });
  const deps = makeApplyDeps([existing]);
  const handler = contributePostPublish().build(deps);
  const source = makePost({ ...existing, title: "New title from peer" });

  await handler.apply({ entity: packedFrom("post", source), expectedVersion: 3, principalId: "operator-1" });

  const saved = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-1" });
  assert.equal(saved?.title, "New title from peer");
  assert.equal(saved?.createdByPrincipalId, "source-author-1", "update must never touch createdByPrincipalId (write-once)");
});

test("apply() 'applied' path: a stale expectedVersion rejects with PostVersionConflictError, never overwrites", async () => {
  const existing = makePost({ id: "post-1", version: 5, title: "Someone else's edit" });
  const deps = makeApplyDeps([existing]);
  const handler = contributePostPublish().build(deps);
  const source = makePost({ ...existing, title: "Stale import" });

  await assert.rejects(
    () => handler.apply({ entity: packedFrom("post", source), expectedVersion: 3, principalId: "operator-1" }),
    /was modified by another save|version/i
  );
  const saved = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-1" });
  assert.equal(saved?.title, "Someone else's edit", "a version conflict must never overwrite the destination");
});

// ---------------------------------------------------------------------------
// planRetire() / retire() — S4's overwrite-live primitive
// (publish-overwrite-live-plan-2026-09-24.md §4/§5 S4)
// ---------------------------------------------------------------------------

test("planRetire() returns the live holder with the exact hash inspect() gives", async () => {
  const holder = makePost({ id: "post-1", slug: "about", title: "About (live)" });
  const deps = makeDeps([holder]);
  const handler = contributePostPublish().build(deps);

  const target = await handler.planRetire!({
    entityType: "post",
    id: "post-2",
    schemaVersion: 1,
    contentHash: "irrelevant",
    hashVersion: 1,
    requiredBlobs: [],
    state: { slug: "about" },
  });

  const inspected = await handler.inspect("post-1");
  assert.ok(target, "a slug held by a different id must return a retire target");
  assert.equal(target?.entityType, "post");
  assert.equal(target?.entityId, "post-1");
  assert.equal(target?.entityLabel, "About (live)");
  assert.equal(target?.hash, inspected?.hash, "planRetire()'s hash must be the SAME hash inspect() gives for the same row");
});

test("planRetire() returns null when the incoming id already exists at the destination — a same-id collision is not an address clash", async () => {
  const holder = makePost({ id: "post-1", slug: "about" });
  const existingHere = makePost({ id: "post-2", slug: "post-2-slug" });
  const handler = contributePostPublish().build(makeDeps([holder, existingHere]));

  const target = await handler.planRetire!({
    entityType: "post",
    id: "post-2",
    schemaVersion: 1,
    contentHash: "irrelevant",
    hashVersion: 1,
    requiredBlobs: [],
    state: { slug: "about" },
  });

  assert.equal(target, null);
});

test("planRetire() returns null for the home page slug — there is no other address to move it to", async () => {
  const home = makePost({ id: "home", slug: ROOT_SLUG, kind: "page" });
  const handler = contributePostPublish().build(makeDeps([home]));

  const target = await handler.planRetire!({
    entityType: "page",
    id: "post-2",
    schemaVersion: 1,
    contentHash: "irrelevant",
    hashVersion: 1,
    requiredBlobs: [],
    state: { slug: ROOT_SLUG },
  });

  assert.equal(target, null);
});

test("retire() records a change set whose revert un-trashes the row", async () => {
  const holder = makePost({ id: "post-1", slug: "about", version: 3, status: "published" });
  const deps = makeApplyDeps([holder]);
  const handler = contributePostPublish().build(deps);

  const target: RetireTarget = {
    entityType: "post",
    entityId: "post-1",
    entityLabel: "About",
    hash: (await handler.inspect("post-1"))!.hash,
  };

  const { changeSetId } = await handler.retire!({ target, principalId: "operator-1", idempotencyKey: "retire-1" });

  const retired = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-1" });
  assert.equal(isTrashed(retired!), true, "retire() must trash the holder");
  assert.equal(retired?.slug, "about-replaced-20260918");

  const registry = createPostRevertRegistry({
    postRepo: deps.postRepo,
    clock: deps.clock,
    outbox: deps.outbox,
    forgetRemoved: deps.forgetRemovedPost,
  });
  await revertChangeSet({
    deps: { changeSets: deps.changeSets, registry, clock: deps.clock, idGen: deps.idGen },
    input: { workspaceId: WORKSPACE_ID, changeSetId },
  });

  const reverted = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-1" });
  assert.equal(isTrashed(reverted!), false, "the standard revert path (the same one every other publish write gets) must un-trash the retired row");
});

test("retire of an already-trashed holder: revert leaves it in the Trash", async () => {
  const holder = makePost({
    id: "post-1",
    slug: "about",
    version: 3,
    status: "published",
    deletedAt: "2026-09-10T00:00:00.000Z",
  });
  const deps = makeApplyDeps([holder]);
  let forgetRemovedCalls = 0;
  const forgetRemovedSpy = async (input: Parameters<typeof deps.forgetRemovedPost>[0]) => {
    forgetRemovedCalls += 1;
    return deps.forgetRemovedPost(input);
  };
  const handler = contributePostPublish().build(deps);

  const target: RetireTarget = {
    entityType: "post",
    entityId: "post-1",
    entityLabel: "About",
    hash: (await handler.inspect("post-1"))!.hash,
  };

  const { changeSetId } = await handler.retire!({
    target,
    principalId: "operator-1",
    idempotencyKey: "retire-already-trashed",
  });

  const registry = createPostRevertRegistry({
    postRepo: deps.postRepo,
    clock: deps.clock,
    outbox: deps.outbox,
    forgetRemoved: forgetRemovedSpy,
  });
  await revertChangeSet({
    deps: { changeSets: deps.changeSets, registry, clock: deps.clock, idGen: deps.idGen },
    input: { workspaceId: WORKSPACE_ID, changeSetId },
  });

  const reverted = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-1" });
  assert.equal(
    isTrashed(reverted!),
    true,
    "a holder that was already in the Trash must stay there after a revert"
  );
  assert.equal(
    forgetRemovedCalls,
    0,
    "a holder that was already trashed before this retire must keep its Trash index row"
  );
});

test("retire()'s undo() restores the holder live, at its original slug — the address-clash rollback, not the standard revert", async () => {
  const holder = makePost({ id: "post-1", slug: "about", version: 3, status: "published" });
  const deps = makeApplyDeps([holder]);
  const handler = contributePostPublish().build(deps);

  const target: RetireTarget = {
    entityType: "post",
    entityId: "post-1",
    entityLabel: "About",
    hash: (await handler.inspect("post-1"))!.hash,
  };

  const { undo } = await handler.retire!({ target, principalId: "operator-1", idempotencyKey: "retire-2" });
  await undo();

  const restored = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-1" });
  assert.equal(isTrashed(restored!), false);
  assert.equal(restored?.slug, "about", "undo() must restore the ORIGINAL slug, unlike a standard revert which only clears the trash marker");
});

test("retire() refuses a target whose live content no longer matches the planned hash, and leaves the holder live", async () => {
  const holder = makePost({ id: "post-1", slug: "about", version: 3, status: "published" });
  const deps = makeApplyDeps([holder]);
  const handler = contributePostPublish().build(deps);
  const target: RetireTarget = {
    entityType: "post",
    entityId: "post-1",
    entityLabel: "About",
    hash: (await handler.inspect("post-1"))!.hash,
  };
  await deps.postRepo.save({ ...holder, title: "Edited on live after the check", version: 4 });

  await assert.rejects(
    () => handler.retire!({ target, principalId: "operator-1", idempotencyKey: "retire-stale" }),
    { message: "the live post at this address changed after this run's plan was built" }
  );

  const after = await deps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: "post-1" });
  assert.equal(isTrashed(after!), false);
  assert.equal(after?.slug, "about");
});

test("retire() throws when removePost is not wired — never silently no-ops", async () => {
  const holder = makePost({ id: "post-1", slug: "about" });
  const base = makeApplyDeps([holder]);
  const deps = { ...base, ports: { post: { ...base.ports.post, remove: undefined } } };
  const handler = contributePostPublish().build(deps);

  await assert.rejects(
    () =>
      handler.retire!({
        target: { entityType: "post", entityId: "post-1", entityLabel: "About", hash: "h" },
        principalId: "operator-1",
        idempotencyKey: "retire-3",
      }),
    /requires PublishContentDeps.changeSets\/authorize\/outbox and ports\.post\.repo\/forgetRemoved\/remove/
  );
});
