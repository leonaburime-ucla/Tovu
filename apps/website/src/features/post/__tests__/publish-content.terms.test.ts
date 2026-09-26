/**
 * @file Plan §3.7: a post's categories/tags (`termIds`) travel inside the post. Pins that an
 * untagged post keeps its exact pre-termIds hash, that assignments round-trip and sync exactly
 * (assign and unassign), that a missing term blocks the row before the post is written, and that an
 * instance still on schemaVersion 1 refuses the bundle cleanly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { contributeTaxonomyPublish, contributeTermPublish } from "#src/features/taxonomy/publish-content";
import { contributeMediaPublish } from "#src/features/media/publish-content";
import {
  applyReport,
  makeSite,
  packAll,
  plan,
  registerOnly,
  roundTrip,
  sqliteContentSite,
  WORKSPACE_ID,
} from "#src/features/publish-content/__tests__/round-trip-harness";
import { registerPublishContentContributor, type PackedEntity } from "#src/features/publish-content/type-registry";

import type { PostRecord } from "../post.js";
import { contributePostPublish } from "../publish-content.js";
import { InMemoryPostRepo } from "../repo.memory.js";

const at = "2026-09-01T00:00:00.000Z";

function post(overrides: Partial<PostRecord> & { id: string; slug: string }): PostRecord {
  return {
    workspaceId: WORKSPACE_ID,
    title: "Untagged",
    bodyJson: { type: "doc", content: [] },
    status: "published",
    kind: "post",
    bodyFormat: "doc",
    bodyHtml: null,
    updatedAt: at,
    version: 3,
    seoExtJson: null,
    deletedAt: null,
    createdAt: at,
    createdByPrincipalId: "author",
    ...overrides,
  } as PostRecord;
}

/** This row's hash under schemaVersion 1 (captured before `termIds` existed). */
const UNTAGGED_V1_HASH = "f9eb860f27a1e0d1c8a19ec5f1fcf20c101e84aef31a1a354c24fdc92bd488d3";

async function seedTerms(site: ReturnType<typeof sqliteContentSite>) {
  await site.taxonomies.insert({ id: "tx-tags", name: "Tags", hierarchical: false, status: "active", updatedAt: at, version: 1 });
  for (const [id, name] of [["t-a", "Alpha"], ["t-b", "Beta"], ["t-c", "Gamma"]]) {
    await site.terms.insert({ id, taxonomyId: "tx-tags", parentId: null, name, status: "active", updatedAt: at, version: 1 });
  }
}

const tag = (site: ReturnType<typeof sqliteContentSite>, contentId: string, termId: string) =>
  site.entryTerms.upsert({ contentType: "post", contentId, termId, addedAt: at });

const assigned = async (site: ReturnType<typeof sqliteContentSite>, contentId: string) =>
  (await site.entryTerms.listForContent({ contentType: "post", contentId })).map((r) => r.termId).sort();

async function sites() {
  registerOnly([contributeTaxonomyPublish(), contributeTermPublish(), contributePostPublish()]);
  const src = sqliteContentSite();
  const dst = sqliteContentSite();
  await seedTerms(src);
  await src.posts.save(post({ id: "p-tagged", slug: "tagged", title: "Tagged" }));
  await tag(src, "p-tagged", "t-b");
  await tag(src, "p-tagged", "t-a");
  return { src, dst, source: makeSite(src.ports, "src"), dest: makeSite(dst.ports, "dst") };
}

test("an untagged post keeps its schemaVersion-1 hash byte-for-byte, with or without taxonomy ports", async () => {
  registerOnly([contributePostPublish()]);
  const row = post({ id: "p-untagged", slug: "untagged" });
  const bare = contributePostPublish().build(makeSite({ post: { repo: new InMemoryPostRepo([row]) } }));
  const withTerms = sqliteContentSite();
  const tagged = contributePostPublish().build(makeSite({ ...withTerms.ports, post: { repo: new InMemoryPostRepo([row]) } }));

  for (const handler of [bare, tagged]) {
    const packed: PackedEntity[] = [];
    for await (const entity of handler.pack()) packed.push(entity);
    assert.equal(packed[0]?.contentHash, UNTAGGED_V1_HASH);
    assert.equal("termIds" in (packed[0]?.state ?? {}), false);
    assert.equal(packed[0]?.schemaVersion, 2);
  }
});

test("post termIds: packed sorted, applied after taxonomy and term, then everything unchanged", async () => {
  const { dst, source, dest } = await sites();
  const { first, second, entities, destinationPack } = await roundTrip(source, dest);

  assert.deepEqual(first.applyOrder.indexOf("term") < first.applyOrder.indexOf("post"), true);
  assert.deepEqual(entities.find((e) => e.id === "p-tagged")?.state.termIds, ["t-a", "t-b"]);
  assert.deepEqual(await assigned(dst, "p-tagged"), ["t-a", "t-b"]);
  assert.deepEqual(second.rows.map((r) => r.outcome), second.rows.map(() => "unchanged"));
  assert.deepEqual(destinationPack.map((e) => e.contentHash).sort(), entities.map((e) => e.contentHash).sort());
});

test("post termIds: a changed set syncs exactly — added assigned, removed unassigned; none left clears all", async () => {
  const { src, dst, source, dest } = await sites();
  await roundTrip(source, dest);
  await src.entryTerms.remove({ contentType: "post", contentId: "p-tagged", termId: "t-a" });
  await tag(src, "p-tagged", "t-c");

  let entities = await packAll(source);
  await applyReport(await plan(entities, dest, ["post:p-tagged"]), entities, dest);
  assert.deepEqual(await assigned(dst, "p-tagged"), ["t-b", "t-c"]);

  await src.entryTerms.deleteByContent({ workspaceId: WORKSPACE_ID, contentType: "post", contentId: "p-tagged" });
  entities = await packAll(source);
  assert.equal("termIds" in (entities.find((e) => e.id === "p-tagged")?.state ?? {}), false);
  await applyReport(await plan(entities, dest, ["post:p-tagged"]), entities, dest);
  assert.deepEqual(await assigned(dst, "p-tagged"), []);
  assert.deepEqual((await plan(await packAll(source), dest)).rows.map((r) => r.outcome).filter((o) => o !== "unchanged"), []);
});

test("post termIds: a term missing at the destination blocks the row before the post is written", async () => {
  const { dst, source, dest } = await sites();
  const handler = contributePostPublish().build(dest);
  const entity = (await packAll(source)).find((e) => e.id === "p-tagged")!;

  await assert.rejects(
    handler.apply({ entity, expectedVersion: undefined, principalId: "owner", idempotencyKey: "idem-missing" }),
    (err: Error & { rowOutcome?: string }) =>
      err.rowOutcome === "blocked" && /^post 'p-tagged' is tagged with term 't-a', which is missing at this destination/.test(err.message)
  );
  assert.equal(await dst.posts.findById({ workspaceId: WORKSPACE_ID, id: "p-tagged" }), null);
});

test("post termIds: without admin.taxonomy.manage a tag change is blocked and nothing is written", async () => {
  const { source, dst } = await sites();
  await seedTerms(dst);
  const dest = { ...makeSite(dst.ports, "dst"), authorize: async ({ permission }: { permission: string }) => ({ allowed: permission !== "admin.taxonomy.manage", reason: "role" }) };
  const entity = (await packAll(source)).find((e) => e.id === "p-tagged")!;

  await assert.rejects(
    contributePostPublish().build(dest).apply({ entity, expectedVersion: undefined, principalId: "editor", idempotencyKey: "idem-perm" }),
    (err: Error & { rowOutcome?: string }) => err.rowOutcome === "blocked" && /admin\.taxonomy\.manage/.test(err.message)
  );
  assert.equal(await dst.posts.findById({ workspaceId: WORKSPACE_ID, id: "p-tagged" }), null);
});

test("an instance still on post schemaVersion 1 refuses the whole bundle, writing nothing", async () => {
  const { source, dst } = await sites();
  const entities = await packAll(source);
  // The old live site: same types, but its post handler is the schemaVersion-1 one.
  registerOnly([contributeTaxonomyPublish(), contributeTermPublish(), contributeMediaPublish()]);
  const current = contributePostPublish();
  registerPublishContentContributor({ ...current, build: (deps) => ({ ...current.build(deps), schemaVersion: 1 }) });

  const report = await plan(entities, makeSite(dst.ports, "old-live"));
  assert.equal(report.refused, true);
  assert.equal(report.refusalReason, "post 'p-tagged' uses schema version 2, but this instance supports version 1 for that type");
  assert.deepEqual(report.rows, []);
});
