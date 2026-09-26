import assert from "node:assert/strict";
import test from "node:test";

import { openContentDb } from "#src/platform/db/sqlite/content-db";
import type { TaxonomyPublishPorts } from "#src/features/publish-content/type-registry";
import { applyReport, makeSite, packAll, plan, registerOnly, roundTrip, WORKSPACE_ID } from "#src/features/publish-content/__tests__/round-trip-harness";
import { InMemoryContentLookup, InMemoryEntryTermRepo } from "../index.js";
import { contributeTaxonomyPublish, contributeTermPublish } from "../publish-content.js";
import { SqliteTaxonomyRepo, SqliteTaxonomyRevisionRepo, SqliteTermRepo } from "../repo.sqlite.js";

function ports(): TaxonomyPublishPorts & { taxonomies: SqliteTaxonomyRepo; terms: SqliteTermRepo } {
  const db = openContentDb(":memory:");
  return {
    taxonomies: new SqliteTaxonomyRepo({ db, workspaceId: WORKSPACE_ID }),
    terms: new SqliteTermRepo({ db, workspaceId: WORKSPACE_ID }),
    entryTerms: new InMemoryEntryTermRepo(),
    revisions: new SqliteTaxonomyRevisionRepo({ db, workspaceId: WORKSPACE_ID }),
    stampWatermark: () => {},
    contentLookup: new InMemoryContentLookup(),
  };
}

const at = "2026-09-01T00:00:00.000Z";

async function sites() {
  registerOnly([contributeTermPublish(), contributeTaxonomyPublish()]);
  const src = ports();
  const dst = ports();
  await src.taxonomies.insert({ id: "tx-cat", name: "Category", hierarchical: true, status: "active", updatedAt: at, version: 2 });
  await src.taxonomies.insert({ id: "tx-old", name: "Old", hierarchical: false, status: "trash", updatedAt: at, version: 1 });
  // Child inserted before its parent: pack must still put the parent first.
  await src.terms.insert({ id: "t-child", taxonomyId: "tx-cat", parentId: "t-root", name: "Espresso", status: "active", updatedAt: at, version: 1 });
  await src.terms.insert({ id: "t-root", taxonomyId: "tx-cat", parentId: null, name: "Coffee", status: "active", updatedAt: at, version: 4 });
  return { src, dst, source: makeSite({ taxonomy: src, term: src }, "src"), dest: makeSite({ taxonomy: dst, term: dst }, "dst") };
}

test("taxonomy + term round trip: taxonomy first, parent term before child, ids kept, then unchanged", async () => {
  const { dst, source, dest } = await sites();
  const { first, second, entities, destinationPack } = await roundTrip(source, dest);

  assert.deepEqual(first.applyOrder.slice(0, 2), ["taxonomy", "term"]);
  assert.deepEqual(first.rows.map((r) => [r.entityId, r.outcome]), [["tx-cat", "created"], ["t-root", "created"], ["t-child", "created"]]);
  assert.deepEqual(second.rows.map((r) => r.outcome), ["unchanged", "unchanged", "unchanged"]);
  assert.deepEqual(destinationPack.map((e) => e.contentHash), entities.map((e) => e.contentHash));
  assert.equal((await dst.terms.findByIdFull("t-child"))?.parentId, "t-root");
});

test("term: a rename and a reparent on the source update the destination in place (forced)", async () => {
  const { src, source, dest, dst } = await sites();
  await roundTrip(source, dest);
  await src.terms.insert({ id: "t-tea", taxonomyId: "tx-cat", parentId: null, name: "Tea", status: "active", updatedAt: at, version: 1 });
  await src.terms.update({ id: "t-child", taxonomyId: "tx-cat", parentId: "t-tea", name: "Matcha", status: "active", updatedAt: at, version: 2 });

  const entities = await packAll(source);
  const report = await plan(entities, dest, ["term:t-child"]);
  await applyReport(report, entities, dest);

  const moved = await dst.terms.findByIdFull("t-child");
  assert.equal(moved?.name, "Matcha");
  assert.equal(moved?.parentId, "t-tea");
  assert.deepEqual((await plan(await packAll(source), dest)).rows.map((r) => r.outcome), ["unchanged", "unchanged", "unchanged", "unchanged"]);
});

test("taxonomy: a trashed destination row and a same-named group under another id both refuse", async () => {
  const { dst, source, dest } = await sites();
  await dst.taxonomies.insert({ id: "tx-cat", name: "Category", hierarchical: true, status: "trash", updatedAt: at, version: 1 });
  const trashed = await plan(await packAll(source), dest);
  assert.equal(trashed.rows[0]?.outcome, "blocked");
  assert.match(trashed.rows[0]?.reason ?? "", /trash/i);

  const again = await sites();
  await again.dst.taxonomies.insert({ id: "tx-dupe", name: "Category", hierarchical: true, status: "active", updatedAt: at, version: 1 });
  const clash = await plan(await packAll(again.source), again.dest);
  assert.equal(clash.rows[0]?.outcome, "blocked");
  assert.match(clash.rows[0]?.reason ?? "", /tx-dupe/);
});

test("taxonomy: the same id created at the destination after the plan is a conflict", async () => {
  const { dst, source, dest } = await sites();
  const entities = await packAll(source);
  const report = await plan(entities, dest);
  await dst.taxonomies.insert({ id: "tx-cat", name: "Category", hierarchical: true, status: "active", updatedAt: at, version: 1 });
  await assert.rejects(applyReport(report, entities, dest), (err: Error & { rowOutcome?: string }) => err.rowOutcome === "conflict");
});
