import assert from "node:assert/strict";
import test from "node:test";

import { CONTENT_HASH_VERSION } from "../content-hash.js";
import { appendSkippedRowsToPeerPlan, keepChangingIncludedEntities, labelPeerPlanRows } from "../report-labels.js";
import type { PackedEntity, SkippedPackEntity } from "../type-registry.js";

/**
 * @file `labelPeerPlanRows` — the source side naming the rows of a report the DESTINATION produced.
 *
 * The case this exists for is live: production is a build that predates `entityLabel`, so its plan
 * rows arrive unlabelled and the dialog would fall back to short ids for content this machine can
 * name exactly. These tests pin that the fill-in happens, that it never overwrites a label the peer
 * did supply, and that an unrecognized envelope is passed through rather than reshaped.
 */

function entity(over: { entityType: string; id: string; state: Record<string, unknown> }): PackedEntity {
  return {
    entityType: over.entityType,
    id: over.id,
    schemaVersion: 1,
    contentHash: `hash-${over.id}`,
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: [],
    state: over.state,
  };
}

const ENTITIES: readonly PackedEntity[] = [
  entity({ entityType: "post", id: "p1", state: { slug: "spring-sale", title: "Spring Sale" } }),
  entity({ entityType: "media", id: "m1", state: { slug: "logo-png", title: "Logo" } }),
  entity({ entityType: "media", id: "m2", state: { caption: "nothing nameable here" } }),
];

function planWith(rows: unknown[]): Record<string, unknown> {
  return { planId: "plan-1", planHash: "hash-1", details: { refused: false, refusalReason: null, applyOrder: ["media", "post"], rows } };
}

function rowsOf(plan: Record<string, unknown>): Array<Record<string, unknown>> {
  return (plan.details as { rows: Array<Record<string, unknown>> }).rows;
}

test("names an unlabelled peer row from the bundle this side sent", () => {
  const labelled = labelPeerPlanRows(
    planWith([
      { entityType: "post", entityId: "p1", outcome: "applied", writes: true, reason: null },
      { entityType: "media", entityId: "m1", outcome: "unchanged", writes: false, reason: null },
    ]),
    ENTITIES
  );

  assert.deepEqual(
    rowsOf(labelled).map((r) => [r.entityId, r.entityLabel]),
    [["p1", "spring-sale"], ["m1", "logo-png"]]
  );
});

test("leaves every decision-bearing field of the peer's row exactly as it arrived", () => {
  const labelled = labelPeerPlanRows(
    planWith([{ entityType: "post", entityId: "p1", outcome: "conflict", writes: false, reason: "edited on the live site" }]),
    ENTITIES
  );

  assert.deepEqual(rowsOf(labelled)[0], {
    entityType: "post",
    entityId: "p1",
    entityLabel: "spring-sale",
    outcome: "conflict",
    writes: false,
    reason: "edited on the live site",
  });
  assert.equal((labelled as { planHash: string }).planHash, "hash-1", "the plan hash the token binds to is untouched");
});

test("never overwrites a label the peer supplied itself", () => {
  const labelled = labelPeerPlanRows(
    planWith([{ entityType: "post", entityId: "p1", entityLabel: "the-peers-own-name", outcome: "applied", writes: true, reason: null }]),
    ENTITIES
  );

  assert.equal(rowsOf(labelled)[0].entityLabel, "the-peers-own-name");
});

test("leaves a row it cannot name alone rather than inventing one", () => {
  const labelled = labelPeerPlanRows(
    planWith([
      { entityType: "media", entityId: "m2", outcome: "blocked", writes: false, reason: "required blob is absent" },
      { entityType: "widget", entityId: "not-in-this-bundle", outcome: "blocked", writes: false, reason: "no handler" },
    ]),
    ENTITIES
  );

  assert.equal("entityLabel" in rowsOf(labelled)[0], false, "an entity with no human field stays unlabelled");
  assert.equal("entityLabel" in rowsOf(labelled)[1], false, "an entity absent from the bundle stays unlabelled");
});

test("passes an envelope it does not recognize straight through", () => {
  for (const plan of [{}, { details: null }, { details: { rows: "not an array" } }, { details: {} }]) {
    assert.equal(labelPeerPlanRows(plan, ENTITIES), plan, `${JSON.stringify(plan)} must be returned by identity`);
  }
});

test("passes a refused report through with no rows invented", () => {
  const refused = { planId: "p", planHash: "h", details: { refused: true, refusalReason: "version mismatch", applyOrder: [], rows: [] } };
  const labelled = labelPeerPlanRows(refused, ENTITIES);
  assert.deepEqual(rowsOf(labelled), []);
  assert.equal((labelled.details as { refusalReason: string }).refusalReason, "version mismatch");
});

/**
 * @file `appendSkippedRowsToPeerPlan` — the other half of "this side has local context the
 * destination's report doesn't": a whole theme tree refused by `file-tree-policy.ts` at THIS
 * instance's own export step never reaches the peer's bundle at all (`export-bundle.ts`'s
 * `SkippedPackEntity`), so the peer's plan can never report it. This is where those locally-known
 * refusals join the same `rows` array the dialog already renders a non-selectable `blocked` row from.
 */
const SKIPPED: readonly SkippedPackEntity[] = [
  {
    entityType: "theme-files",
    id: "static/kuinetic-showcase",
    label: "static/kuinetic-showcase",
    reason: "Can't publish: contains a video file (video.mp4)",
  },
];

test("appendSkippedRowsToPeerPlan adds one non-writing blocked row per skipped unit", () => {
  const withSkipped = appendSkippedRowsToPeerPlan(planWith([{ entityType: "post", entityId: "p1", outcome: "applied", writes: true, reason: null }]), SKIPPED);

  assert.deepEqual(rowsOf(withSkipped), [
    { entityType: "post", entityId: "p1", outcome: "applied", writes: true, reason: null },
    {
      entityType: "theme-files",
      entityId: "static/kuinetic-showcase",
      entityLabel: "static/kuinetic-showcase",
      outcome: "blocked",
      writes: false,
      reason: SKIPPED[0]!.reason,
      canOverwrite: false,
      retires: null,
    },
  ]);
});

test("appendSkippedRowsToPeerPlan is a no-op with an empty skipped list", () => {
  const plan = planWith([{ entityType: "post", entityId: "p1", outcome: "applied", writes: true, reason: null }]);
  assert.equal(appendSkippedRowsToPeerPlan(plan, []), plan);
});

test("appendSkippedRowsToPeerPlan passes an envelope it does not recognize straight through", () => {
  for (const plan of [{}, { details: null }, { details: { rows: "not an array" } }]) {
    assert.equal(appendSkippedRowsToPeerPlan(plan, SKIPPED), plan);
  }
});

test("appendSkippedRowsToPeerPlan adds nothing to a refused report", () => {
  const refused = { planId: "p", planHash: "h", details: { refused: true, refusalReason: "version mismatch", applyOrder: [], rows: [] } };
  const withSkipped = appendSkippedRowsToPeerPlan(refused, SKIPPED);
  assert.deepEqual(rowsOf(withSkipped), []);
});

/**
 * `keepChangingIncludedEntities` — owner decision 2026-09-25: media carried along with a scoped
 * pages/posts run shows ONLY when live would actually change (created or updated). Every other
 * outcome for such a row is dropped from the report; every row that was not carried along is left
 * exactly as it arrived.
 */
function mediaRow(id: string, outcome: string, writes: boolean): Record<string, unknown> {
  return { entityType: "media", entityId: id, outcome, writes, reason: null };
}

test("keepChangingIncludedEntities tags created/updated/overwritten carried-along media with who uses it, and drops unchanged", () => {
  const plan = planWith([
    mediaRow("m-new", "created", true),
    mediaRow("m-upd", "applied", true),
    mediaRow("m-forced", "forced", true),
    mediaRow("m-same", "unchanged", false),
    { entityType: "page", entityId: "pg1", outcome: "unchanged", writes: false, reason: null },
  ]);
  const includedFor = new Map([
    ["media:m-new", ["page:pg1"]],
    ["media:m-upd", ["page:pg1"]],
    ["media:m-forced", ["page:pg1"]],
    ["media:m-same", ["page:pg1"]],
  ]);

  const rows = rowsOf(keepChangingIncludedEntities(plan, includedFor));

  assert.deepEqual(
    rows.map((row) => [row.entityId, row.includedFor ?? null]),
    [
      ["m-new", ["page:pg1"]],
      ["m-upd", ["page:pg1"]],
      ["m-forced", ["page:pg1"]],
      ["pg1", null],
    ]
  );
});

/**
 * A carried-along media row live reports as conflict/blocked is NOT hidden: the page would otherwise
 * publish pointing at an image live doesn't have (or holds differently). It shows as an ordinary row
 * — untagged, reason and `canOverwrite` intact — exactly like any conflicting media row, so the
 * dialog gives it the plain reason and the "Overwrite on live" box.
 */
test("keepChangingIncludedEntities keeps a conflicting or blocked carried-along media row as an ordinary row", () => {
  const conflict = { ...mediaRow("m-conf", "conflict", false), reason: "Edited on live", canOverwrite: true };
  const blocked = { ...mediaRow("m-block", "blocked", false), reason: "Slug taken", canOverwrite: false };
  const plan = planWith([conflict, blocked]);
  const includedFor = new Map([
    ["media:m-conf", ["page:pg1"]],
    ["media:m-block", ["post:po1"]],
  ]);

  const rows = rowsOf(keepChangingIncludedEntities(plan, includedFor));

  assert.deepEqual(rows, [conflict, blocked]);
});

test("keepChangingIncludedEntities leaves an ordinary media row alone whatever its outcome", () => {
  const plan = planWith([mediaRow("m-own", "unchanged", false)]);
  const rows = rowsOf(keepChangingIncludedEntities(plan, new Map()));
  assert.deepEqual(rows, [mediaRow("m-own", "unchanged", false)]);
});

test("keepChangingIncludedEntities passes an envelope it does not recognize straight through", () => {
  const odd = { planId: "x", details: "not a report" };
  assert.equal(keepChangingIncludedEntities(odd, new Map([["media:m1", ["page:p"]]])), odd);
});
