import { entityDisplayLabel, entityKey } from "./planner.js";
import type { PackedEntity, SkippedPackEntity } from "./type-registry.js";

/**
 * @file Naming the rows of a report THIS instance did not produce.
 *
 * A push plans on the DESTINATION: this instance builds a bundle, stages it there, and renders the
 * report that comes back. The destination names each row from the entity state it was given
 * (`planner.ts`'s `entityDisplayLabel`) — but only if it is running a build that knows to. A live
 * site deployed before that field existed answers rows with no label at all, and the dialog then
 * falls back to a short id for content this machine can name perfectly well.
 *
 * So the source labels the report itself, from the very bundle it just sent. Every row in a push
 * report corresponds to an entity in that bundle by {@link entityKey}, so the mapping needs no
 * lookup, no extra request and no agreement from the far side.
 *
 * ## Why the destination's own label still wins when it has one
 *
 * It is the destination's report. A label it supplied was derived from the same packed state this
 * side holds, so the two agree in every normal case — and where they could not (a row for an entity
 * that is somehow not in this bundle), the side that produced the row is the one with the context.
 * This module only ever FILLS IN a label, never overwrites one.
 *
 * Nothing here is load-bearing for safety: a label is display text. Every field a publish decision
 * actually turns on — `outcome`, `writes`, `reason`, the plan hash — is passed through untouched, and
 * a report whose shape is not what this module expects is returned exactly as it arrived rather than
 * being reshaped into something that parses.
 */

/** A plan envelope as `push/plan` receives it from a peer: `{planId, planHash, details, …}`, where
 *  `details` is the report. Deliberately `unknown`-shaped — this came off the network. */
type PeerPlanEnvelope = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fills in `entityLabel` on every row of a peer's plan from the local bundle that produced it.
 *
 * Returns the envelope unchanged when it is not the expected shape — a peer that answered something
 * this side does not recognize is the route's problem to report, not this function's to paper over.
 *
 * @complexity O(e + r) time in the bundle's entity count and the report's row count (one map build,
 * one pass); O(e + r) space for the map and the copied rows.
 */
export function labelPeerPlanRows(plan: PeerPlanEnvelope, entities: readonly PackedEntity[]): PeerPlanEnvelope {
  const details = plan.details;
  if (!isRecord(details) || !Array.isArray(details.rows)) return plan;

  const labelByKey = new Map<string, string | null>();
  for (const entity of entities) {
    labelByKey.set(entityKey(entity.entityType, entity.id), entityDisplayLabel(entity.state));
  }

  const rows = details.rows.map((row) => {
    if (!isRecord(row)) return row;
    if (typeof row.entityLabel === "string" && row.entityLabel.length > 0) return row;
    const local = labelByKey.get(entityKey(String(row.entityType ?? ""), String(row.entityId ?? "")));
    return local === undefined || local === null ? row : { ...row, entityLabel: local };
  });

  return { ...plan, details: { ...details, rows } };
}

/**
 * Appends one non-writing `blocked` row per locally-known skip to a peer's plan — the other half of
 * this file's "this side has context the destination's report doesn't" job.
 *
 * A push plans on the DESTINATION, but a whole unit `file-tree-policy.ts` refused at THIS instance's
 * own export step (`export-bundle.ts`'s `SkippedPackEntity`) never reaches the peer's bundle at all —
 * it was excluded before packing, so the peer's own `planImport` has nothing to report it from. This
 * function is where that locally-known refusal joins the SAME `rows` array the admin dialog already
 * renders a non-selectable `blocked` row from (`ui/report-rows.ts`'s `DISPOSITION_BY_OUTCOME`), so no
 * new rendering path is needed for it to show up with its reason.
 *
 * Returns the envelope unchanged when it is not the expected shape (mirrors {@link labelPeerPlanRows}
 * — a peer that answered something unrecognized is the route's problem to report), when there is
 * nothing to append, or when the report is `refused`: a refused report's `rows` is always empty by
 * construction (`planner.ts`'s own invariant), and this function must never be what breaks that.
 *
 * @complexity O(s) in the skipped-unit count; O(r + s) space for the copied `rows` array.
 */
export function appendSkippedRowsToPeerPlan(plan: PeerPlanEnvelope, skipped: readonly SkippedPackEntity[]): PeerPlanEnvelope {
  if (skipped.length === 0) return plan;
  const details = plan.details;
  if (!isRecord(details) || !Array.isArray(details.rows) || details.refused === true) return plan;

  const skippedRows = skipped.map((entity) => ({
    entityType: entity.entityType,
    entityId: entity.id,
    entityLabel: entity.label,
    outcome: "blocked" as const,
    writes: false,
    reason: entity.reason,
    canOverwrite: false,
    retires: null,
  }));

  return { ...plan, details: { ...details, rows: [...details.rows, ...skippedRows] } };
}

/** The planner outcomes that change live: a brand-new row, an update to one live already holds, or
 *  an operator-ticked overwrite of one live holds differently (`forced`). */
const CHANGING_OUTCOMES: ReadonlySet<string> = new Set(["created", "applied", "forced"]);

/**
 * Owner decision 2026-09-25 — the report half of "images go along with pages and posts", generalized
 * by plan G3 (`export-bundle.ts`'s `includeReferencedEntities` is the bundle half). For a row that was
 * carried along for in-scope rows (an image, an embedded widget, an entry's collection, ...):
 * - created, updated or forced: kept and tagged `includedFor` (the referrer keys), which the dialog
 *   renders as a pre-ticked, untickable row noting who uses it;
 * - unchanged: dropped — live already holds exactly this, so there is nothing to say;
 * - anything else (conflict, blocked): kept UNTAGGED, exactly as it arrived. Live would not take this
 *   row, so a page using it would publish pointing at an image (or widget, ...) live lacks or holds
 *   differently — it must show as an ordinary skipped row with its plain reason and, when
 *   `canOverwrite`, the "Overwrite on live" box, the same as any conflicting row. Hiding it hid the
 *   problem.
 *
 * A row NOT carried along — including an ordinary media row — passes through exactly as it arrived.
 * Returns the envelope unchanged when it is not the expected shape (mirrors {@link labelPeerPlanRows})
 * or when nothing was carried along.
 *
 * @complexity O(r) in the report's row count; O(r) space for the copied `rows` array.
 */
export function keepChangingIncludedEntities(
  plan: PeerPlanEnvelope,
  includedFor: ReadonlyMap<string, readonly string[]>
): PeerPlanEnvelope {
  if (includedFor.size === 0) return plan;
  const details = plan.details;
  if (!isRecord(details) || !Array.isArray(details.rows)) return plan;

  const rows: unknown[] = [];
  for (const row of details.rows) {
    if (!isRecord(row)) {
      rows.push(row);
      continue;
    }
    const referrers = includedFor.get(entityKey(String(row.entityType ?? ""), String(row.entityId ?? "")));
    const outcome = String(row.outcome);
    if (referrers === undefined) rows.push(row);
    else if (CHANGING_OUTCOMES.has(outcome)) rows.push({ ...row, includedFor: referrers });
    else if (outcome !== "unchanged") rows.push(row);
  }
  return { ...plan, details: { ...details, rows } };
}
