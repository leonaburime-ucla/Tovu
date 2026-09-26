import assert from "node:assert/strict";
import test from "node:test";

import type Database from "better-sqlite3";

import { InMemoryContentTypeRepo } from "#src/features/content-types/index";
import { applyReport, makeSite, packAll, plan, registerOnly, roundTrip, WORKSPACE_ID } from "#src/features/publish-content/__tests__/round-trip-harness";
import { openContentDb } from "#src/platform/db/sqlite/content-db";
import type { EntryRecord } from "../../index.js";
import { contributeCollectionEntryPublish } from "../../publish-content.js";
import { SqliteEntryRepo } from "../../repo.sqlite.js";

const at = "2026-09-01T00:00:00.000Z";

function entry(overrides: Partial<EntryRecord> & { id: string; slug: string }): EntryRecord {
  return {
    workspaceId: WORKSPACE_ID,
    type: "recipe",
    status: "published",
    title: overrides.slug,
    bodyJson: { type: "doc", content: [] },
    fieldsJson: { ext: { site: { servings: 2 } } },
    publishedAt: at,
    createdAt: at,
    updatedAt: at,
    version: 3,
    ...overrides,
  };
}

async function instance() {
  const db = openContentDb(":memory:");
  const entries = new SqliteEntryRepo(db);
  const contentTypes = new InMemoryContentTypeRepo();
  await contentTypes.save({
    workspaceId: WORKSPACE_ID,
    key: "recipe",
    label: "Recipes",
    fields: [{ name: "servings", kind: "integer", required: false, queryable: false }],
    status: "active",
    version: 1,
    tombstonedAt: null,
  });
  const trash = (id: string) =>
    (db as unknown as { $client: Database.Database }).$client.prepare("UPDATE entries SET deleted_at = ? WHERE id = ?").run(at, id);
  return { entries, contentTypes, trash };
}

async function sites() {
  registerOnly([contributeCollectionEntryPublish()]);
  const src = await instance();
  const dst = await instance();
  await src.entries.save(entry({ id: "e-soup", slug: "soup" }));
  await src.entries.save(entry({ id: "e-cake", slug: "cake", status: "draft", publishedAt: null, bodyJson: null }));
  await src.entries.save(entry({ id: "e-gone", slug: "gone" }));
  src.trash("e-gone");
  await src.entries.save(entry({ id: "w-1", slug: "hero", type: "widget", fieldsJson: { ext: { site: {} } } }));
  const site = (i: typeof src, name: string) => makeSite({ "collection-entry": { entries: i.entries, contentTypes: i.contentTypes } }, name);
  return { src, dst, source: site(src, "src"), dest: site(dst, "dst") };
}

test("collection-entry round trip: ids, status and publishedAt kept; widgets and trashed rows never pack; then unchanged", async () => {
  const { dst, source, dest } = await sites();
  const { first, second, entities, destinationPack } = await roundTrip(source, dest);

  assert.deepEqual(first.rows.map((r) => [r.entityId, r.outcome]).sort(), [["e-cake", "created"], ["e-soup", "created"]]);
  assert.deepEqual(second.rows.map((r) => r.outcome), ["unchanged", "unchanged"]);
  assert.deepEqual(destinationPack.map((e) => e.contentHash).sort(), entities.map((e) => e.contentHash).sort());
  const soup = await dst.entries.findById({ workspaceId: WORKSPACE_ID, id: "e-soup" });
  assert.equal(soup?.status, "published");
  assert.equal(soup?.publishedAt, at);
  assert.equal((await dst.entries.findById({ workspaceId: WORKSPACE_ID, id: "e-cake" }))?.status, "draft");
});

test("collection-entry: an edit on the source updates the destination row in place (forced)", async () => {
  const { src, dst, source, dest } = await sites();
  await roundTrip(source, dest);
  await src.entries.save(entry({ id: "e-soup", slug: "soup", title: "Tomato soup", version: 4 }));

  const entities = await packAll(source);
  const report = await plan(entities, dest, ["collection-entry:e-soup"]);
  await applyReport(report, entities, dest);

  const soup = await dst.entries.findById({ workspaceId: WORKSPACE_ID, id: "e-soup" });
  assert.equal(soup?.title, "Tomato soup");
  assert.equal(soup?.version, 2);
  assert.deepEqual((await plan(await packAll(source), dest)).rows.map((r) => r.outcome), ["unchanged", "unchanged"]);
});

test("collection-entry: a trashed destination row with the same id is refused at precheck, not planned as created", async () => {
  const { dst, source, dest } = await sites();
  await dst.entries.save(entry({ id: "e-soup", slug: "soup" }));
  dst.trash("e-soup");

  const report = await plan(await packAll(source), dest);
  const soup = report.rows.find((r) => r.entityId === "e-soup");
  assert.equal(soup?.outcome, "blocked");
  assert.match(soup?.reason ?? "", /trash/i);
});

test("collection-entry: the same (type, slug) under another id is refused and names the holder", async () => {
  const { dst, source, dest } = await sites();
  await dst.entries.save(entry({ id: "e-other", slug: "soup" }));

  const soup = (await plan(await packAll(source), dest)).rows.find((r) => r.entityId === "e-soup");
  assert.equal(soup?.outcome, "blocked");
  assert.match(soup?.reason ?? "", /e-other/);
});

test("collection-entry: a trashed destination row holding the same (type, slug) under another id is refused at precheck", async () => {
  const { dst, source, dest } = await sites();
  await dst.entries.save(entry({ id: "e-old-soup", slug: "soup" }));
  dst.trash("e-old-soup");

  const soup = (await plan(await packAll(source), dest)).rows.find((r) => r.entityId === "e-soup");
  assert.equal(soup?.outcome, "blocked");
  assert.match(soup?.reason ?? "", /^collection-entry 'e-old-soup' is in the trash at this destination and still holds slug 'soup'/);
});

test("collection-entry: the same id created at the destination after the plan is a conflict", async () => {
  const { dst, source, dest } = await sites();
  const entities = await packAll(source);
  const report = await plan(entities, dest);
  await dst.entries.save(entry({ id: "e-cake", slug: "cake" }));
  await dst.entries.save(entry({ id: "e-soup", slug: "soup" }));
  await assert.rejects(applyReport(report, entities, dest), (err: Error & { rowOutcome?: string }) => err.rowOutcome === "conflict");
});
