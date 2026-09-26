import { createHash } from "node:crypto";

import type { ClockPort, IdGeneratorPort } from "@jini-ai/cms/core";

import { PostConflictError, PostNotFoundError } from "../post/post.js";
import { PublishContentApplyRowError } from "./apply-errors.js";
import { loadActiveBundle } from "./bundle-staging.js";
import type { PublishContentBundleRepoPort } from "./bundle-staging.js";
import type { PublishContentBaselineRepoPort } from "./baseline-repo.js";
import type {
  PublishContentRunItemState,
  PublishContentRunRepoPort,
  PublishContentRunRecord,
} from "./run-repo.js";
import { PublishContentBundleNotFoundError } from "./gated-hooks.js";
import type { PublishContentApplyPort } from "./gated-hooks.js";
import { entityKey } from "./planner.js";
import { NO_PUBLISH_CONTENT_SEED_HASH } from "./seed-hash.js";
import type { PublishContentSeedHashFn } from "./seed-hash.js";
import type { PublishContentOutcomeRow, PublishContentReport } from "./planner.js";
import { buildPublishContentCatalog } from "./type-registry.js";
import type {
  EntityReplacement,
  PublishContentDeps,
  PublishContentHandler,
  PublishContentPorts,
  PackedEntity,
} from "./type-registry.js";

/**
 * @file Task 8 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 8 / §5 risks
 * #1–#3, #6, #7, #9.
 *
 * `createPublishContentApplyPort` builds the real {@link PublishContentApplyPort} — the
 * implementation of the seam declared by `gated-hooks.ts`, wired at both composition roots.
 *
 * ## The property this file exists to hold — read before changing the per-row loop
 *
 * A destination edit landing in the narrow window between `gated-hooks.ts`'s own fresh
 * `buildReport()` (called twice already — once by `gateway.execute()`'s `PLAN_STALE` re-check, once
 * again inside `executeMutation()` right before this port is called) and THIS function's own
 * per-row write must downgrade that ONE row to `conflict`, never overwrite it and never abort the
 * whole run. Three checks close that window, in order, per writing row: (1) `created` + a row now
 * existing at apply time -> `conflict` (a true "someone else created it first" race — `save()`'s
 * `INSERT … ON CONFLICT DO UPDATE` has NO version/existence guard of its own, so this loop's own
 * `inspect()` re-check is the only thing standing between an import and a silent overwrite of a
 * concurrently-created row); (2) `applied`/`forced` + the row now GONE -> `conflict`; (3) `applied`
 * specifically (never `forced` — an operator forcing past a conflict already accepted overriding
 * whatever is there) + the destination's hash no longer matching its recorded baseline -> `conflict`.
 * Beyond those, `handler.apply()` itself is called with a freshly re-read `expectedVersion`, so
 * `updatePost`'s own `saveIfVersion` (`UPDATE … WHERE version = ?`) is a second, authoritative guard
 * against the same class of race: a `PostConflictError`/`PostNotFoundError` thrown from inside
 * `handler.apply()` is caught here and ALSO downgrades to `conflict` rather than aborting the run.
 *
 * This loop's per-row failure handling was originally scoped to `post`'s own error hierarchy
 * (`PostConflictError` and its `PostVersionConflictError` subclass, `PostNotFoundError`) with a
 * disclosed note that "a future non-post type either reuses these classes or this catch needs
 * widening when that type lands". `media` was that type, and the catch was widened rather than
 * reusing post's classes from an unrelated feature: any type may now raise
 * `PublishContentApplyRowError` (`apply-errors.ts`) to downgrade ONE row instead of aborting the run,
 * and a new content type needs no edit here at all. See that file's header for why the base class
 * lives outside `type-registry.ts` and why post's two classes keep a named special case.
 *
 * The two sides are phrased differently on purpose: a `PublishContentApplyRowError`'s message is the
 * row's `reason` VERBATIM (the type owns its own operator-facing wording), while post's legacy
 * errors — whose messages are terse and contextless — keep the "changed on the destination during
 * apply" prefix they have always had.
 *
 * ## Authorship — `principalId` passed to every `handler.apply()` call is ALWAYS the operator
 *
 * This loop never swaps `principalId` for the source entity's own author before calling
 * `handler.apply()` — that would also hand the source author's (frequently non-existent-on-this-
 * instance) id to `executeCommand`'s own `authorize()` check as `command.actor.id` inside the
 * handler, which is a live authorization bug, not a style choice. Task 15's "the importer must copy
 * the source's author, never the operator's" rule is instead satisfied entirely INSIDE
 * `features/post/publish-content.ts`'s own `apply()` — it reads `entity.state.createdByPrincipalId`
 * directly for the `created` case, decoupled from whatever `principalId` this loop passes. See that
 * function's own doc for the full explanation, including the plan's own draft wording this disclosed
 * deviation corrects.
 */

/** Stable command key for one source principal's exact serialized entity version. */
export function publishContentItemIdempotencyKey(input: {
  workspaceId: string;
  sourcePrincipalId: string;
  entity: PackedEntity;
}): string {
  const exactVersion = JSON.stringify([
    input.workspaceId,
    input.sourcePrincipalId,
    input.entity.entityType,
    input.entity.id,
    input.entity.schemaVersion,
    input.entity.hashVersion,
    input.entity.contentHash,
  ]);
  return `publish-content:v1:${createHash("sha256").update(exactVersion).digest("hex")}`;
}

/**
 * Every port some registered type's `apply()` needs, with `ports` made EXHAUSTIVE (every registered
 * type's own port, not just the ones a particular caller happens to use) — the apply bag is the one
 * bag that has to be complete.
 *
 * `ports` stays `Partial` on {@link PublishContentDeps} because an export/plan caller genuinely has
 * no use for every type's ports, and each type degrades quietly when its own port is absent. That is
 * right for `pack` and catastrophic for `apply`: an incomplete bag reaches a handler's `apply()` and
 * throws a bare `Error`, which `applyOneRow` cannot downgrade to a row outcome, so it aborts the
 * whole run.
 *
 * This type exists so that failure is impossible to ship. A composition root that forgets a type's
 * port now fails to COMPILE at {@link toPublishContentApplyDeps} instead of failing at run time —
 * which is what happened when `media` landed: both roots kept building a bag from the fields `post`
 * needed, media's `pack()` silently returned nothing, and the type could not travel at all.
 */
export type PublishContentApplyDeps = Omit<PublishContentDeps, "ports"> &
  Required<Pick<PublishContentDeps, "outbox" | "changeSets" | "authorize">> & {
    readonly ports: PublishContentPorts;
  };

/**
 * The composition roots' one way to build {@link createPublishContentApplyPort}'s deps bag.
 *
 * Identity in behaviour, load-bearing in TYPE: it is the single place the apply bag's completeness
 * contract is stated, so `server/runtime/composition/deps.ts` (SQLite) and
 * `server/runtime/composition/app.ts` (in-memory) cannot drift apart or silently skip a type's
 * ports. Adding a port to {@link PublishContentApplyDeps} makes every root that has not supplied it
 * a compile error — the whole point.
 *
 * @complexity O(1) — no work; the type checking is the function.
 */
export function toPublishContentApplyDeps(required: PublishContentApplyDeps): PublishContentApplyDeps {
  return required;
}

export interface CreatePublishContentApplyPortInput {
  readonly workspaceId: string;
  readonly bundleRepo: PublishContentBundleRepoPort;
  readonly baselineRepo: PublishContentBaselineRepoPort;
  readonly runRepo: PublishContentRunRepoPort;
  /** Must include `changeSets`/`authorize` populated — this factory is the one caller responsible
   *  for supplying them (`features/post/publish-content.ts`'s `apply()` throws loudly if they are
   *  missing when it is actually reached). Composition roots build this through
   *  {@link toPublishContentApplyDeps}, which makes the completeness requirement a compile-time one;
   *  the parameter itself stays the wider {@link PublishContentDeps} so focused apply-loop tests can
   *  still supply only the ports the type under test actually reads. */
  readonly publishContentDeps: PublishContentDeps;
  readonly clock: ClockPort;
  readonly idGen: IdGeneratorPort;
  /** D1 — the SAME seed-version lookup the plan was built with (`seed-hash.ts`). The apply-time
   *  re-verification below must accept the seed as a virtual baseline exactly where the planner
   *  did, or every seed-matched `applied` row is silently downgraded to `conflict` at execute.
   *  Omitted means "no seed", the pre-D1 behaviour; both composition roots pass
   *  `RouteDeps.publishContentSeedHash`. */
  readonly getSeedHash?: PublishContentSeedHashFn;
}

/** The mutable, per-call working state {@link applyOneRow} needs — grouped into one object so that
 *  function's own signature stays a single required-input-object parameter (this codebase's own
 *  convention for exported/boundary functions) despite the number of fields involved.
 *  @complexity N/A — a plain data grouping, no behavior. */
interface ApplyRowContext {
  readonly workspaceId: string;
  readonly runId: string;
  readonly sourcePrincipalId: string;
  readonly principalId: string;
  readonly entityByKey: ReadonlyMap<string, PackedEntity>;
  readonly handlerByType: ReadonlyMap<string, PublishContentHandler>;
  readonly baselineRepo: PublishContentBaselineRepoPort;
  readonly getSeedHash: PublishContentSeedHashFn;
  readonly clock: ClockPort;
  readonly recordContentApplied: (input: {
    itemKey: string;
    changeSetId: string;
    /** The retire half's own change set, for a `retires` row whose retire and create both landed. */
    retiredChangeSetId?: string;
  }) => Promise<void>;
}

/**
 * How {@link applyOneRow} should report a failure raised by `handler.apply()` — the row's downgraded
 * outcome plus its operator-facing reason — or `null` for a genuine failure that must abort the run.
 *
 * Any type may opt one of its own failures into a downgrade by raising
 * {@link PublishContentApplyRowError}; `post`'s two pre-existing classes keep a named special case
 * (`PostVersionConflictError` is covered via its `extends PostConflictError`, `post.ts:667`, not
 * named separately). See this file's header for why the two are phrased differently.
 *
 * @complexity O(1).
 */
function classifyApplyRowFailure(
  error: unknown,
  row: PublishContentOutcomeRow
): { outcome: "conflict" | "blocked"; reason: string } | null {
  if (error instanceof PublishContentApplyRowError) {
    return { outcome: error.rowOutcome, reason: error.message };
  }
  if (error instanceof PostConflictError || error instanceof PostNotFoundError) {
    return {
      outcome: "conflict",
      reason: `${row.entityType} '${row.entityId}' changed on the destination during apply: ${error.message}`,
    };
  }
  return null;
}

/**
 * R5 (`plan-publish-repoint-menus-2026-09-24.md` §2.3) — capitalizes a handler's own `entityType`
 * for the one generic, type-agnostic operator-facing prefix the repoint pass produces when a whole
 * `repointReferences()` call throws (as opposed to a per-holder line, which the handler itself
 * already phrases — see {@link createPublishContentApplyPort}'s repoint pass, below).
 * @complexity O(1).
 */
function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * Applies exactly one report row, mutating nothing — returns the row as it actually resolved (which
 * may differ from the plan's own prediction, see this file's header) plus the `changeSetId` a write
 * produced (or `null` for a row that wrote nothing), and `retiredChangeSetId` — the SEPARATE change
 * set a {@link PublishContentOutcomeRow.retires} row's retire half produced (`null` for every other
 * row, including a `retires` row that never reached the write, e.g. because it was downgraded to
 * `conflict` before either write was attempted). It stays apart from `changeSetId` rather than
 * collapsing into one list, so a caller counting "one change set per row" is never off by one for a
 * row that produced two.
 *
 * @complexity O(1) plus whatever `handler.inspect`/`handler.planRetire`/`handler.retire`/
 * `handler.apply`/`baselineRepo` I/O costs — no loop; {@link createPublishContentApplyPort} is what
 * iterates a report's rows.
 */
async function applyOneRow(
  row: PublishContentOutcomeRow,
  ctx: ApplyRowContext
): Promise<{ row: PublishContentOutcomeRow; changeSetId: string | null; retiredChangeSetId: string | null }> {
  const key = entityKey(row.entityType, row.entityId);

  if (!row.writes) {
    // `conflict`/`blocked` pass through untouched — no baseline write (plan §4 task 8: baselines are
    // upserted for created/unchanged/applied/forced ONLY). `unchanged` is the one non-writing outcome
    // that still refreshes the baseline: the destination already matches the source, so there is
    // nothing to apply, but recording that agreement is exactly what lets FUTURE runs tell "still
    // agrees" apart from "diverged since we last looked".
    if (row.outcome === "unchanged") {
      const entity = ctx.entityByKey.get(key);
      if (entity) {
        await ctx.baselineRepo.upsert({
          workspaceId: ctx.workspaceId,
          peerPrincipalId: ctx.sourcePrincipalId,
          entityType: row.entityType,
          entityId: row.entityId,
          hashAtLastSync: entity.contentHash,
          hashVersion: entity.hashVersion,
          syncedAt: ctx.clock.nowIso(),
          runId: ctx.runId,
        });
      }
    }
    return { row, changeSetId: null, retiredChangeSetId: null };
  }

  const entity = ctx.entityByKey.get(key);
  const handler = ctx.handlerByType.get(row.entityType);
  if (!entity || !handler) {
    // Internal inconsistency (the bundle/registry moved between planning and apply in a way that
    // should not be reachable through normal use) — downgrade, do not crash the whole run over it.
    return {
      row: {
        ...row,
        outcome: "blocked",
        writes: false,
        reason: `internal inconsistency: no packed entity/handler for ${row.entityType} '${row.entityId}' at apply time`,
      },
      changeSetId: null,
      retiredChangeSetId: null,
    };
  }

  const current = await handler.inspect(entity.id);

  if (row.retires) {
    // publish-overwrite-live-plan §4/S5 — an address-clash overwrite. This row's own entity id must
    // still be free at the destination (unlike a slug clash, "someone already holds THIS id" here
    // would mean a genuine create race, not the live holder this row is about to retire), and the
    // live row row.retires named at plan time must still be exactly what a FRESH planRetire() sees —
    // closing the same plan/apply window this file's header requires for every other outcome, just
    // applied to a target that lives outside this row's own id. Both checks run BEFORE either write,
    // so a stale retire target never reaches handler.retire()/apply() at all.
    if (current !== null) {
      return {
        row: {
          ...row,
          outcome: "conflict",
          writes: false,
          reason: `${row.entityType} '${row.entityId}' was created on the destination between plan and apply`,
        },
        changeSetId: null,
        retiredChangeSetId: null,
      };
    }
    if (!handler.planRetire || !handler.retire) {
      return {
        row: {
          ...row,
          outcome: "blocked",
          writes: false,
          reason: `internal inconsistency: no planRetire()/retire() on the ${row.entityType} handler for a retire-offered row at apply time`,
        },
        changeSetId: null,
        retiredChangeSetId: null,
      };
    }
    const freshTarget = await handler.planRetire(entity);
    if (!freshTarget || freshTarget.entityId !== row.retires.entityId || freshTarget.hash !== row.retires.hash) {
      return {
        row: {
          ...row,
          outcome: "conflict",
          writes: false,
          reason: `the live ${row.entityType} at this address changed after this run's plan was built`,
        },
        changeSetId: null,
        retiredChangeSetId: null,
      };
    }

    const itemIdempotencyKey = publishContentItemIdempotencyKey({
      workspaceId: ctx.workspaceId,
      sourcePrincipalId: ctx.sourcePrincipalId,
      entity,
    });
    let retireResult: { changeSetId: string; undo(): Promise<void> } | undefined;
    let changeSetId: string;
    try {
      retireResult = await handler.retire({
        target: row.retires,
        principalId: ctx.principalId,
        // Scoped to this run: `undo()` restores forward and leaves the retire's change set (and its
        // key) in the ledger, so a key shared across runs would make every retry after an undone
        // retire fail as "already executed".
        idempotencyKey: `${itemIdempotencyKey}:retire:${ctx.runId}`,
      });
      ({ changeSetId } = await handler.apply({
        entity,
        expectedVersion: undefined, // current === null (checked above) — this is always a create.
        principalId: ctx.principalId, // always the operator — see this file's header.
        idempotencyKey: itemIdempotencyKey,
      }));
    } catch (error) {
      // The retire already landed but the create it was clearing the address FOR did not — put the
      // holder back rather than leaving it retired with nothing to show for it (this handler's own
      // `retire()` doc: the apply loop is the one caller besides its own gateway rollback that calls
      // `undo()` directly). Only here: once the create has landed, the new row holds the address and
      // putting the holder back would collide with it.
      if (retireResult) {
        try {
          await retireResult.undo();
        } catch (undoError) {
          const cause = error instanceof Error ? error.message : String(error);
          const undoCause = undoError instanceof Error ? undoError.message : String(undoError);
          throw new Error(
            `${row.entityType} '${row.entityId}' was not created (${cause}), and putting the retired ` +
              `${row.retires.entityType} '${row.retires.entityId}' back failed too (${undoCause}) — restore it from Trash`
          );
        }
      }
      const downgrade = classifyApplyRowFailure(error, row);
      if (downgrade) {
        return {
          row: { ...row, outcome: downgrade.outcome, writes: false, reason: downgrade.reason },
          changeSetId: null,
          retiredChangeSetId: null,
        };
      }
      throw error; // genuine failure — the caller's own try/catch persists a `failed` run row and rethrows.
    }
    // Both writes landed. A failure from here on is accounting only, so it fails the run (keeping
    // `content_applied` and both change-set ids) instead of undoing anything.
    await ctx.recordContentApplied({ itemKey: key, changeSetId, retiredChangeSetId: retireResult.changeSetId });
    await ctx.baselineRepo.upsert({
      workspaceId: ctx.workspaceId,
      peerPrincipalId: ctx.sourcePrincipalId,
      entityType: row.entityType,
      entityId: row.entityId,
      hashAtLastSync: entity.contentHash,
      hashVersion: entity.hashVersion,
      syncedAt: ctx.clock.nowIso(),
      runId: ctx.runId,
    });
    return { row, changeSetId, retiredChangeSetId: retireResult.changeSetId };
  }

  if (row.outcome === "created" && current !== null) {
    return {
      row: {
        ...row,
        outcome: "conflict",
        writes: false,
        reason: `${row.entityType} '${row.entityId}' was created on the destination between plan and apply`,
      },
      changeSetId: null,
      retiredChangeSetId: null,
    };
  }
  if (row.outcome !== "created" && current === null) {
    return {
      row: {
        ...row,
        outcome: "conflict",
        writes: false,
        reason: `${row.entityType} '${row.entityId}' was removed from the destination between plan and apply`,
      },
      changeSetId: null,
      retiredChangeSetId: null,
    };
  }
  if (row.outcome === "applied" && current) {
    // Never for `forced` — an operator forcing past a conflict already accepted overriding whatever
    // is there. Re-derives the SAME baseline `planEntity` (`planner.ts`) compared against, rather
    // than reusing any value carried on `row` (the report never carries one) — this IS the
    // apply-time re-verification this file's header calls "the single most important property".
    const baseline = await ctx.baselineRepo.findOne({
      workspaceId: ctx.workspaceId,
      peerPrincipalId: ctx.sourcePrincipalId,
      entityType: row.entityType,
      entityId: row.entityId,
    });
    // No recorded baseline: fall back to the seed version, exactly as `planEntity` did (D1). A
    // real baseline still always wins — the seed is never a second vote once one exists.
    // S-F4: then the handler's own seed (`handler.seedHash`), exactly as `planEntity` falls back.
    const agreedHash = baseline
      ? baseline.hashAtLastSync
      : ((await ctx.getSeedHash({ entityType: row.entityType, entityId: row.entityId })) ??
        (await handler.seedHash?.(entity.id)) ??
        null);
    if (agreedHash === null || current.hash !== agreedHash) {
      return {
        row: {
          ...row,
          outcome: "conflict",
          writes: false,
          reason: `${row.entityType} '${row.entityId}' was edited on the destination again after this run's own plan was built`,
        },
        changeSetId: null,
        retiredChangeSetId: null,
      };
    }
  }

  try {
    const { changeSetId } = await handler.apply({
      entity,
      expectedVersion: current?.version, // `created` -> undefined (current is null); applied/forced -> fresh version just read above.
      principalId: ctx.principalId, // always the operator — see this file's header.
      idempotencyKey: publishContentItemIdempotencyKey({
        workspaceId: ctx.workspaceId,
        sourcePrincipalId: ctx.sourcePrincipalId,
        entity,
      }),
    });
    // Persist the change-set id BEFORE the baseline write. If that next write fails, status lookup
    // still proves exactly which content mutation landed and a retry can use the same command key.
    await ctx.recordContentApplied({ itemKey: key, changeSetId });
    await ctx.baselineRepo.upsert({
      workspaceId: ctx.workspaceId,
      peerPrincipalId: ctx.sourcePrincipalId,
      entityType: row.entityType,
      entityId: row.entityId,
      hashAtLastSync: entity.contentHash,
      hashVersion: entity.hashVersion,
      syncedAt: ctx.clock.nowIso(),
      runId: ctx.runId,
    });
    return { row, changeSetId, retiredChangeSetId: null };
  } catch (error) {
    const downgrade = classifyApplyRowFailure(error, row);
    if (downgrade) {
      return {
        row: { ...row, outcome: downgrade.outcome, writes: false, reason: downgrade.reason },
        changeSetId: null,
        retiredChangeSetId: null,
      };
    }
    throw error; // genuine failure — the caller's own try/catch persists a `failed` run row and rethrows.
  }
}

/**
 * Builds the real {@link PublishContentApplyPort} — Task 8's apply loop. See this file's header for
 * the apply-time race guards and the authorship-id disclosed deviation.
 *
 * @complexity O(n) in the report's row count (one `inspect`/`apply`/baseline call per writing row,
 * one baseline call per `unchanged` row), plus one bundle reload and one contributor-registry read
 * per call — dominated by whatever I/O those individually cost, not by this function's own control
 * flow.
 */
export function createPublishContentApplyPort(input: CreatePublishContentApplyPortInput): PublishContentApplyPort {
  async function saveRun(fields: {
    runId: string;
    startedAt: string;
    sourcePrincipalId: string;
    principalId: string;
    restorePointId: string;
    phase: PublishContentRunRecord["phase"];
    changeSetIds: readonly string[];
    report: PublishContentReport;
    items: readonly PublishContentRunItemState[];
    finishedAt: string | null;
  }): Promise<void> {
    await input.runRepo.save({
      id: fields.runId,
      workspaceId: input.workspaceId,
      direction: "import",
      peerPrincipalId: fields.sourcePrincipalId,
      peerLabel: null,
      phase: fields.phase,
      restorePointId: fields.restorePointId,
      changeSetIdsJson: JSON.stringify(fields.changeSetIds),
      actorId: fields.principalId,
      startedAt: fields.startedAt,
      finishedAt: fields.finishedAt,
      reportJson: JSON.stringify(fields.report),
      itemsJson: JSON.stringify(fields.items),
    });
  }

  return {
    async applyReport({ report, principalId, bundleId, restorePointId, authorize }) {
      const startedAt = input.clock.nowIso();
      const staged = await loadActiveBundle({
        repo: input.bundleRepo,
        workspaceId: input.workspaceId,
        id: bundleId,
        now: startedAt,
      });
      if (!staged) {
        throw new PublishContentBundleNotFoundError(
          `publish-content: bundle '${bundleId}' was not found, or has expired, for workspace '${input.workspaceId}'`
        );
      }
      const sourcePrincipalId = staged.sourcePrincipalId;
      const runId = input.idGen.newId();

      if (report.refused) {
        // Reachable per `gated-hooks.ts`'s own doc: a plan confirmed while ALREADY refused stays
        // refused at execute time too (same hash both times), so `PLAN_STALE` never intercepts it —
        // `executeMutation()` still calls this port. Nothing to apply; record it and stop.
        await saveRun({
          runId,
          startedAt,
          sourcePrincipalId,
          principalId,
          restorePointId,
          phase: "abandoned",
          changeSetIds: [],
          report,
          items: [],
          finishedAt: input.clock.nowIso(),
        });
        return {
          runId,
          changeSetIds: [],
          retiredChangeSetIds: [],
          repointChangeSetIds: [],
          menuLinksUpdated: 0,
          menuLinksNotUpdated: [],
        };
      }

      const entities = JSON.parse(staged.entitiesJson) as readonly PackedEntity[];
      const entityByKey = new Map(entities.map((entity) => [entityKey(entity.entityType, entity.id), entity] as const));
      // Registry read fresh, at apply time, every call — same rule `planner.ts`'s own header pins
      // for planning; a handler built once and cached across calls would go stale the moment a
      // contributor re-registers (e.g. a hot-reloaded dev process).
      // The caller's authorize wins when it supplies one: this port is built once per process and
      // closes over RBAC, which is the wrong authority for a publishing credential. See
      // `PublishContentApplyPort.applyReport`'s own doc.
      const handlerDeps =
        authorize === undefined ? input.publishContentDeps : { ...input.publishContentDeps, authorize };
      const { handlerByType } = buildPublishContentCatalog(handlerDeps);

      const effectiveRowsByKey = new Map(
        report.rows.map((row) => [entityKey(row.entityType, row.entityId), row] as const)
      );
      const itemByKey = new Map<string, PublishContentRunItemState>();
      for (const row of report.rows) {
        const key = entityKey(row.entityType, row.entityId);
        const entity = entityByKey.get(key);
        const idempotencyKey = entity
          ? publishContentItemIdempotencyKey({ workspaceId: input.workspaceId, sourcePrincipalId, entity })
          : `publish-content:v1:missing:${createHash("sha256").update(`${input.workspaceId}:${sourcePrincipalId}:${key}`).digest("hex")}`;
        itemByKey.set(key, {
          entityType: row.entityType,
          entityId: row.entityId,
          idempotencyKey,
          phase: "pending",
          outcome: row.outcome,
          writes: row.writes,
          reason: row.reason,
          changeSetId: null,
          retiredChangeSetId: null,
          errorSummary: null,
          updatedAt: startedAt,
        });
      }

      const itemStates = (): PublishContentRunItemState[] =>
        report.rows.map((row) => itemByKey.get(entityKey(row.entityType, row.entityId))!).filter(Boolean);
      const currentChangeSetIds = (): string[] =>
        Array.from(
          new Set(itemStates().flatMap((item) => (item.changeSetId === null ? [] : [item.changeSetId])))
        );
      const currentRetiredChangeSetIds = (): string[] =>
        itemStates().flatMap((item) => (item.retiredChangeSetId === null ? [] : [item.retiredChangeSetId]));
      const currentReport = (): PublishContentReport => ({
        ...report,
        rows: report.rows.map((row) => effectiveRowsByKey.get(entityKey(row.entityType, row.entityId)) ?? row),
      });
      const saveSnapshot = async (
        phase: PublishContentRunRecord["phase"],
        finishedAt: string | null
      ): Promise<void> =>
        saveRun({
          runId,
          startedAt,
          sourcePrincipalId,
          principalId,
          restorePointId,
          phase,
          changeSetIds: currentChangeSetIds(),
          report: currentReport(),
          items: itemStates(),
          finishedAt,
        });

      // Persist the run and every pending item before the first content write.
      await saveSnapshot("applying", null);

      const ctx: ApplyRowContext = {
        workspaceId: input.workspaceId,
        runId,
        sourcePrincipalId,
        principalId,
        entityByKey,
        handlerByType,
        baselineRepo: input.baselineRepo,
        getSeedHash: input.getSeedHash ?? NO_PUBLISH_CONTENT_SEED_HASH,
        clock: input.clock,
        recordContentApplied: async ({ itemKey, changeSetId, retiredChangeSetId }) => {
          const item = itemByKey.get(itemKey);
          if (!item) return;
          itemByKey.set(itemKey, {
            ...item,
            phase: "content_applied",
            changeSetId,
            ...(retiredChangeSetId === undefined ? {} : { retiredChangeSetId }),
            updatedAt: input.clock.nowIso(),
          });
          await saveSnapshot("applying", null);
        },
      };

      // R5 (`plan-publish-repoint-menus-2026-09-24.md` §2.3), extended by R6 (2026-09-24 follow-up)
      // — repoints every live reference that still points at an address-clash overwrite's retired
      // holder. Reads `itemByKey` as it stands AT THE MOMENT IT IS CALLED, so it is safe to call
      // after every row has landed (the normal path) OR from inside the loop's own `catch`, mid-run,
      // over whatever happened to land before an abort — either way it stays type-agnostic, calling
      // every registered handler that implements the optional `repointReferences` hook, generically,
      // and never importing navigation or any other reference-holding feature by name.
      //
      // R6's own property: an overwrite row whose retire+create BOTH landed (`item.retiredChangeSetId`
      // set — the same signal the success path already gated on) must still be repointed even when a
      // LATER accounting-only failure (e.g. this row's own baseline write, or an unrelated row's own
      // write) aborts the whole run — otherwise a live menu is left pointing at a holder this run
      // already moved to Trash. A row that never reached a landed retire (never got there, or the
      // create half failed and was undone) contributes nothing, aborted run or not.
      async function runRepointPass(): Promise<{
        repointChangeSetIds: string[];
        menuLinksUpdated: number;
        menuLinksNotUpdated: string[];
      }> {
        const replacements: EntityReplacement[] = [];
        for (const row of report.rows) {
          if (!row.retires) continue;
          const item = itemByKey.get(entityKey(row.entityType, row.entityId));
          // `retiredChangeSetId === null` covers both "never reached the retire" and "the create that
          // followed it failed and was undone" (§2.3 step 1) — either way, nothing was actually
          // replaced, so there is nothing here for a repoint pass to act on.
          if (!item || item.retiredChangeSetId === null) continue;
          replacements.push({ entityType: row.retires.entityType, oldId: row.retires.entityId, newId: row.entityId });
        }
        // Every id written THIS run, across every type — a holder in this set already carries the
        // source's own intent (its own row wrote), so repointing it would fight that intent (§2.5).
        const skipIds = new Set<string>(
          itemStates()
            .filter((item) => item.changeSetId !== null)
            .map((item) => item.entityId)
        );

        let repointChangeSetIds: string[] = [];
        let menuLinksUpdated = 0;
        const menuLinksNotUpdated: string[] = [];
        if (replacements.length > 0) {
          for (const handler of handlerByType.values()) {
            if (!handler.repointReferences) continue;
            try {
              const repointed = await handler.repointReferences({ replacements, skipIds, principalId, runId });
              repointChangeSetIds = repointChangeSetIds.concat(repointed.changeSetIds);
              menuLinksUpdated += repointed.linksUpdated;
              menuLinksNotUpdated.push(...repointed.notUpdated);
            } catch (error) {
              // The content this run published already landed — a repoint failure is reported, never
              // thrown back to fail the run (§2.3 step 4). A handler's own per-holder failures (a
              // denied grant, a concurrent edit) are already caught inside that handler and returned
              // via `notUpdated` above; reaching this catch means the WHOLE call failed (e.g. a
              // required port was never wired for this composition root).
              const message = error instanceof Error ? error.message : String(error);
              menuLinksNotUpdated.push(`${capitalize(handler.entityType)} links were not updated: ${message}`);
            }
          }
        }
        return { repointChangeSetIds, menuLinksUpdated, menuLinksNotUpdated };
      }

      let activeItemKey: string | null = null;

      try {
        for (const row of report.rows) {
          activeItemKey = entityKey(row.entityType, row.entityId);
          const result = await applyOneRow(row, ctx);
          effectiveRowsByKey.set(activeItemKey, result.row);
          const item = itemByKey.get(activeItemKey);
          if (item) {
            itemByKey.set(activeItemKey, {
              ...item,
              phase: "completed",
              outcome: result.row.outcome,
              writes: result.row.writes,
              reason: result.row.reason,
              changeSetId: result.changeSetId ?? item.changeSetId,
              retiredChangeSetId: result.retiredChangeSetId ?? item.retiredChangeSetId,
              errorSummary: null,
              updatedAt: input.clock.nowIso(),
            });
          }
          await saveSnapshot("applying", null);
          activeItemKey = null;
        }
      } catch (error) {
        // A non-conflict error aborted the run partway through — the run row must still record
        // exactly which change sets landed before the failure (plan §5 risk #7's own words), never
        // silently drop that trail just because the whole run did not complete.
        if (activeItemKey) {
          const item = itemByKey.get(activeItemKey);
          if (item) {
            itemByKey.set(activeItemKey, {
              ...item,
              // Preserve `content_applied`: that is the recovery signal for a baseline/status write
              // failing after the domain command and its change set already landed.
              phase: item.phase === "content_applied" ? "content_applied" : "failed",
              errorSummary: error instanceof Error ? error.message : "unknown apply failure",
              updatedAt: input.clock.nowIso(),
            });
          }
        }
        // R6 — whatever landed before this abort (an overwrite row's retire+create both done) still
        // gets repointed; see `runRepointPass`'s own doc above for why this is safe to call here too.
        await runRepointPass();
        await saveSnapshot("failed", input.clock.nowIso());
        throw error;
      }

      const { repointChangeSetIds, menuLinksUpdated, menuLinksNotUpdated } = await runRepointPass();

      await saveSnapshot("applied", input.clock.nowIso());
      return {
        runId,
        changeSetIds: currentChangeSetIds(),
        retiredChangeSetIds: currentRetiredChangeSetIds(),
        repointChangeSetIds,
        menuLinksUpdated,
        menuLinksNotUpdated,
      };
    },
  };
}
