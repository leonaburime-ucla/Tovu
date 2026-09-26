/**
 * @file Regression suite for the publish-content round-trip FIDELITY defect (2026-09-19 dispatch).
 *
 * The defect: `features/post/publish-content.ts` decided whether an entity had changed by hashing
 * the ENTIRE `PostRecord`, but its `apply()` wrote back only a SUBSET of that record's fields
 * (create: `title`/`slug`/`bodyJson`/`status`/`kind`/`actorId`; update: those minus `kind`/`actorId`
 * plus `templateChoice`/`overridesThemePage`). Every other content field — `bodyFormat`/`bodyHtml`
 * (a bespoke-HTML Page's whole body), `seoExtJson`, `memberAccessJson`, `deletedAt` — was hashed but
 * never applied, so publishing silently dropped or replaced it and still reported success.
 *
 * `memberAccessJson` is the sharp one: it carries a post's member-gating rules, so a members-only
 * post could publish to production as a PUBLICLY READABLE row. That is content exposure, not data
 * loss, and `members_only_post_publishes_as_public` below is its dedicated regression.
 *
 * The property every test here asserts is one invariant: **a field that is part of the content hash
 * must survive `pack -> apply -> pack` unchanged.** Asserting on the repacked HASH rather than on
 * individual fields is deliberate — a field-by-field assertion only ever covers the fields whoever
 * wrote it remembered, which is exactly the failure mode being regressed. The hash covers the whole
 * canonicalized state by construction, so a field added to `PostRecord` later and then dropped by
 * `apply()` fails these tests without anyone having to remember to extend them.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryChangeSetRepo } from "#src/contracts/core/commands/index";
import { InMemoryOutbox } from "#src/contracts/core/events/index";
import { contentHash } from "#src/features/publish-content/content-hash";

import { InMemoryPostRepo } from "../repo.memory.js";
import type { PostKind, PostRecord } from "../post.js";
import { contributePagePublish, contributePostPublish } from "../publish-content.js";
import type { PackedEntity } from "#src/features/publish-content/type-registry";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const IMPORTING_OPERATOR = "operator-running-the-import";

function makeDeps(rows: PostRecord[]) {
  const outbox = new InMemoryOutbox();
  const postRepo = new InMemoryPostRepo(rows);
  return {
    workspaceId: WORKSPACE_ID,
    postRepo,
    clock: { nowIso: () => "2026-09-19T12:00:00.000Z" },
    idGen: (() => {
      let n = 0;
      return { newId: () => `generated-id-${++n}` };
    })(),
    outbox,
    changeSets: new InMemoryChangeSetRepo([], [], outbox),
    authorize: async () => ({ allowed: true, reason: "test-always-allow" }),
    // Required by `apply()`'s guard: its rollback restores through `restorePostForward`, which
    // needs the Trash-index forget. Nothing in this file trashes a post, so it never fires.
    forgetRemovedPost: async () => {},
    ports: { post: { repo: postRepo, forgetRemoved: async () => {} } },
  };
}

/**
 * A post carrying a distinctive, non-default value in EVERY `PostRecord` field the publish
 * transport is expected to carry. `bodyFormat`/`bodyHtml` stay `"doc"`/`null` here because the two
 * are a matched pair — an `"html"` row is its own scenario below, with its own test.
 */
function fullyPopulatedPost(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    workspaceId: WORKSPACE_ID,
    title: "Fully Populated",
    slug: "fully-populated",
    bodyJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] },
    status: "published",
    kind: "post",
    bodyFormat: "doc",
    bodyHtml: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 7,
    seoExtJson: JSON.stringify({ title: "SEO title", description: "SEO description", noindex: true }),
    ext: { "plugin-a": { flagged: true } },
    deletedAt: null,
    templateChoice: "blog-post.html",
    overridesThemePage: true,
    memberAccessJson: JSON.stringify({ visibility: "members_only" }),
    createdByPrincipalId: "original-author-on-the-source",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Packs every entity the handler for `kind` yields out of a repo seeded with `rows`. */
async function packAll(kind: PostKind, rows: PostRecord[]): Promise<PackedEntity[]> {
  const contributor = kind === "post" ? contributePostPublish() : contributePagePublish();
  const handler = contributor.build(makeDeps(rows));
  const packed: PackedEntity[] = [];
  for await (const entity of handler.pack()) packed.push(entity);
  return packed;
}

/**
 * The whole round trip: pack `source` out of one instance, apply it into a second instance seeded
 * with `destinationRows`, then repack the destination and hand back both the source entity and the
 * one the destination now produces.
 */
async function roundTrip(
  kind: PostKind,
  source: PostRecord,
  destinationRows: PostRecord[] = []
): Promise<{ sourceEntity: PackedEntity; repacked: PackedEntity | undefined }> {
  const [sourceEntity] = await packAll(kind, [source]);
  assert.ok(sourceEntity, "the source row must pack — nothing to round-trip otherwise");

  const contributor = kind === "post" ? contributePostPublish() : contributePagePublish();
  const destinationDeps = makeDeps(destinationRows);
  const destinationHandler = contributor.build(destinationDeps);
  const existing = destinationRows.find((row) => row.id === source.id);

  await destinationHandler.apply({
    entity: sourceEntity,
    expectedVersion: existing ? existing.version : undefined,
    principalId: IMPORTING_OPERATOR,
  });

  const repackedAll: PackedEntity[] = [];
  for await (const entity of destinationHandler.pack()) repackedAll.push(entity);
  return { sourceEntity, repacked: repackedAll.find((entity) => entity.id === source.id) };
}

// ---------------------------------------------------------------------------
// The core invariant: hashed => applied, on both the create and the update path
// ---------------------------------------------------------------------------

for (const kind of ["post", "page"] as const) {
  test(`${kind}: a fully populated entity survives pack -> apply -> pack onto an EMPTY destination`, async () => {
    const source = fullyPopulatedPost({ kind, slug: `fully-populated-${kind}` });
    const { sourceEntity, repacked } = await roundTrip(kind, source);

    assert.ok(repacked, `the applied ${kind} must pack again at the destination`);
    assert.equal(
      repacked.contentHash,
      sourceEntity.contentHash,
      `${kind} lost content on the create path: the destination repacks to a different hash than the source packed`
    );
  });

  test(`${kind}: a fully populated entity survives pack -> apply -> pack onto an EXISTING destination row`, async () => {
    const source = fullyPopulatedPost({ kind, slug: `fully-populated-${kind}` });
    // Every carried field differs from the source's, so any field `apply()` fails to write shows up
    // as a hash mismatch rather than accidentally already matching.
    const destinationRow: PostRecord = {
      ...source,
      title: "Stale destination title",
      bodyJson: { type: "doc", content: [] },
      status: "draft",
      version: 3,
      updatedAt: "2026-07-01T00:00:00.000Z",
      seoExtJson: null,
      templateChoice: null,
      overridesThemePage: null,
      memberAccessJson: null,
      createdByPrincipalId: "someone-else-on-the-destination",
      createdAt: "2026-06-01T00:00:00.000Z",
    };

    const { sourceEntity, repacked } = await roundTrip(kind, source, [destinationRow]);

    assert.ok(repacked, `the applied ${kind} must pack again at the destination`);
    assert.equal(
      repacked.contentHash,
      sourceEntity.contentHash,
      `${kind} lost content on the update path: the destination repacks to a different hash than the source packed`
    );
  });
}

// ---------------------------------------------------------------------------
// The security case, asserted on the field itself rather than only through the hash
// ---------------------------------------------------------------------------

test("a members-only post does NOT publish to the destination as publicly readable", async () => {
  const source = fullyPopulatedPost({ memberAccessJson: JSON.stringify({ visibility: "members_only" }) });
  const destinationDeps = makeDeps([]);
  const handler = contributePostPublish().build(destinationDeps);
  const [sourceEntity] = await packAll("post", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: undefined, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.ok(landed, "the post must exist at the destination");
  assert.equal(
    landed.memberAccessJson,
    source.memberAccessJson,
    "member-access rules were dropped on publish — the post is now readable by the public at the destination"
  );
});

test("publishing over an existing PUBLIC destination row still applies the source's member gating", async () => {
  const source = fullyPopulatedPost({ memberAccessJson: JSON.stringify({ visibility: "members_only" }) });
  const publicDestinationRow: PostRecord = { ...source, memberAccessJson: null, version: 2 };
  const destinationDeps = makeDeps([publicDestinationRow]);
  const handler = contributePostPublish().build(destinationDeps);
  const [sourceEntity] = await packAll("post", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: 2, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.equal(
    landed?.memberAccessJson,
    source.memberAccessJson,
    "the destination row stayed public after a members-only post was published over it"
  );
});

// ---------------------------------------------------------------------------
// Individually-dropped fields, named so a failure says WHICH field regressed
// ---------------------------------------------------------------------------

test("seoExtJson survives publish onto an empty destination", async () => {
  const source = fullyPopulatedPost();
  const destinationDeps = makeDeps([]);
  const handler = contributePostPublish().build(destinationDeps);
  const [sourceEntity] = await packAll("post", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: undefined, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.equal(landed?.seoExtJson, source.seoExtJson, "per-entry SEO overrides were dropped on publish");
});

test("templateChoice and overridesThemePage survive publish onto an empty destination", async () => {
  const source = fullyPopulatedPost();
  const destinationDeps = makeDeps([]);
  const handler = contributePostPublish().build(destinationDeps);
  const [sourceEntity] = await packAll("post", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: undefined, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.equal(landed?.templateChoice, "blog-post.html", "the chosen template was dropped on publish");
  assert.equal(landed?.overridesThemePage, true, "the theme-page override decision was dropped on publish");
});

test("an html-format Page keeps its bodyHtml and its format through a publish", async () => {
  const source = fullyPopulatedPost({
    kind: "page",
    slug: "bespoke-html-page",
    bodyFormat: "html",
    bodyHtml: "<section><h1>Generated</h1></section>",
  });
  const destinationDeps = makeDeps([]);
  const handler = contributePagePublish().build(destinationDeps);
  const [sourceEntity] = await packAll("page", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: undefined, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.equal(landed?.bodyFormat, "html", "the Page's bespoke-HTML format was flattened to 'doc' on publish");
  assert.equal(landed?.bodyHtml, source.bodyHtml, "the Page's whole generated body was discarded on publish");
});

// ---------------------------------------------------------------------------
// D2 (2026-09-24 owner decision) — publishing REPLACES an existing destination row whose body
// format differs from the source, instead of refusing (`features/post/post.ts`'s
// `importPostEntity` used to throw `PostConflictError` on this; `precheck()`'s own mirror of the
// same block is covered in `__tests__/publish-content.test.ts`).
// ---------------------------------------------------------------------------

test("D2: publishing replaces an existing doc-format destination row with the source's html format", async () => {
  const source = fullyPopulatedPost({ kind: "page", slug: "doc-to-html", bodyFormat: "html", bodyHtml: "<section>New bespoke HTML</section>" });
  const destinationRow: PostRecord = { ...source, bodyFormat: "doc", bodyHtml: null, version: 3 };
  const destinationDeps = makeDeps([destinationRow]);
  const handler = contributePagePublish().build(destinationDeps);
  const [sourceEntity] = await packAll("page", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: 3, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.equal(landed?.bodyFormat, "html", "publishing must convert the destination to the source's format, not refuse");
  assert.equal(landed?.bodyHtml, source.bodyHtml);
});

test("D2: publishing replaces an existing html-format destination row with the source's doc format", async () => {
  const source = fullyPopulatedPost({ kind: "page", slug: "html-to-doc", bodyFormat: "doc", bodyHtml: null });
  const destinationRow: PostRecord = { ...source, bodyFormat: "html", bodyHtml: "<section>Stale generated HTML</section>", version: 3 };
  const destinationDeps = makeDeps([destinationRow]);
  const handler = contributePagePublish().build(destinationDeps);
  const [sourceEntity] = await packAll("page", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: 3, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.equal(landed?.bodyFormat, "doc", "publishing must convert the destination to the source's format, not refuse");
  assert.equal(landed?.bodyHtml, null);
  assert.deepEqual(landed?.bodyJson, source.bodyJson);
});

// ---------------------------------------------------------------------------
// Authorship — already correct on create (Task 15); pinned so the DTO rework cannot regress it
// ---------------------------------------------------------------------------

test("create preserves the SOURCE author and never re-stamps it with the importing operator", async () => {
  const source = fullyPopulatedPost();
  const destinationDeps = makeDeps([]);
  const handler = contributePostPublish().build(destinationDeps);
  const [sourceEntity] = await packAll("post", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: undefined, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.equal(landed?.createdByPrincipalId, "original-author-on-the-source");
});

test("update never overwrites the destination row's write-once authorship", async () => {
  const source = fullyPopulatedPost();
  const destinationRow: PostRecord = {
    ...source,
    version: 2,
    createdByPrincipalId: "destination-original-author",
    createdAt: "2026-05-01T00:00:00.000Z",
  };
  const destinationDeps = makeDeps([destinationRow]);
  const handler = contributePostPublish().build(destinationDeps);
  const [sourceEntity] = await packAll("post", [source]);
  assert.ok(sourceEntity);

  await handler.apply({ entity: sourceEntity, expectedVersion: 2, principalId: IMPORTING_OPERATOR });

  const landed = await destinationDeps.postRepo.findById({ workspaceId: WORKSPACE_ID, id: source.id });
  assert.equal(landed?.createdByPrincipalId, "destination-original-author");
  assert.equal(landed?.createdAt, "2026-05-01T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Trash — the safest reading of a locally-deleted post (see this dispatch's open product question)
// ---------------------------------------------------------------------------

test("a trashed source row is not packed at all, so publish can never resurrect it as live content", async () => {
  const trashed = fullyPopulatedPost({ deletedAt: "2026-09-10T00:00:00.000Z" });
  const live = fullyPopulatedPost({ id: "33333333-3333-3333-3333-333333333333", slug: "live-one", deletedAt: null });

  const packed = await packAll("post", [trashed, live]);

  assert.deepEqual(
    packed.map((entity) => entity.id),
    [live.id],
    "a trashed post was packed for publish — applying it would resurrect trash as live content at the destination"
  );
});

test("publishing over a TRASHED destination row is refused rather than silently resurrecting it", async () => {
  const source = fullyPopulatedPost();
  const trashedAtDestination: PostRecord = { ...source, version: 2, deletedAt: "2026-09-10T00:00:00.000Z" };
  const destinationDeps = makeDeps([trashedAtDestination]);
  const handler = contributePostPublish().build(destinationDeps);
  const [sourceEntity] = await packAll("post", [source]);
  assert.ok(sourceEntity);

  const reason = await handler.precheck(sourceEntity);
  assert.match(
    String(reason),
    /trash/i,
    "precheck accepted an entity whose destination row is in the trash — applying it would resurrect it"
  );
});
