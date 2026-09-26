import assert from "node:assert/strict";
import test from "node:test";

import { applyReport, makeSite, packAll, plan, registerOnly, roundTrip, WORKSPACE_ID } from "#src/features/publish-content/__tests__/round-trip-harness";
import { InMemoryContentTypeRepo, NoopContentTypeIndexProvisioner, type ContentTypeRecord } from "../index.js";
import { contributeContentTypePublish } from "../publish-content.js";

function contentType(overrides: Partial<ContentTypeRecord> = {}): ContentTypeRecord {
  return {
    workspaceId: WORKSPACE_ID,
    key: "recipe",
    label: "Recipes",
    fields: [{ name: "servings", kind: "integer", required: false, queryable: true }],
    status: "active",
    version: 3,
    tombstonedAt: null,
    ...overrides,
  };
}

async function sites(sourceRows: ContentTypeRecord[]) {
  registerOnly([contributeContentTypePublish()]);
  const sourceRepo = new InMemoryContentTypeRepo();
  for (const row of sourceRows) await sourceRepo.save(row);
  const destRepo = new InMemoryContentTypeRepo();
  const indexProvisioner = new NoopContentTypeIndexProvisioner();
  return {
    source: makeSite({ "content-type": { repo: sourceRepo, indexProvisioner } }, "src"),
    dest: makeSite({ "content-type": { repo: destRepo, indexProvisioner } }, "dst"),
    sourceRepo,
    destRepo,
  };
}

test("content-type round trip: created, then unchanged; seeded widget keys and tombstones never pack", async () => {
  const { source, dest, destRepo } = await sites([
    contentType(),
    contentType({ key: "event", label: "Events", status: "deprecated" }),
    contentType({ key: "widget", label: "Widget" }),
    contentType({ key: "widget_area", label: "Widget area" }),
    contentType({ key: "gone", status: "tombstone", tombstonedAt: "2026-09-01T00:00:00.000Z" }),
  ]);
  const { first, second, entities, destinationPack } = await roundTrip(source, dest);

  assert.deepEqual(first.rows.map((r) => [r.entityId, r.outcome]), [["recipe", "created"], ["event", "created"]]);
  assert.deepEqual(second.rows.map((r) => r.outcome), ["unchanged", "unchanged"]);
  assert.deepEqual(destinationPack.map((e) => e.contentHash), entities.map((e) => e.contentHash));
  assert.equal((await destRepo.findByKey({ workspaceId: WORKSPACE_ID, key: "event" }))?.status, "deprecated");
});

test("content-type: a changed label and fields update in place (forced past the no-baseline conflict)", async () => {
  const { source, dest, sourceRepo, destRepo } = await sites([contentType()]);
  await roundTrip(source, dest);
  const fields = [...contentType().fields, { name: "cuisine", kind: "text", required: false, queryable: false } as const];
  await sourceRepo.save(contentType({ label: "Dishes", fields, status: "deprecated", version: 4 }));

  const entities = await packAll(source);
  const report = await plan(entities, dest, ["content-type:recipe"]);
  await applyReport(report, entities, dest);

  const landed = await destRepo.findByKey({ workspaceId: WORKSPACE_ID, key: "recipe" });
  assert.equal(landed?.label, "Dishes");
  assert.equal(landed?.fields.length, 2);
  assert.equal(landed?.status, "deprecated");
  assert.deepEqual((await plan(await packAll(source), dest)).rows.map((r) => r.outcome), ["unchanged"]);
});

test("content-type: a tombstoned destination type refuses; a key registered after the plan is a conflict", async () => {
  const { source, dest, destRepo } = await sites([contentType()]);
  await destRepo.save(contentType({ status: "tombstone", tombstonedAt: "2026-09-02T00:00:00.000Z" }));
  const blocked = await plan(await packAll(source), dest);
  assert.equal(blocked.rows[0]?.outcome, "blocked");
  assert.match(blocked.rows[0]?.reason ?? "", /permanently removed/);

  const fresh = await sites([contentType()]);
  const entities = await packAll(fresh.source);
  const report = await plan(entities, fresh.dest);
  await fresh.destRepo.save(contentType({ label: "Someone else's" }));
  await assert.rejects(applyReport(report, entities, fresh.dest), (err: Error & { rowOutcome?: string }) => err.rowOutcome === "conflict");
});
