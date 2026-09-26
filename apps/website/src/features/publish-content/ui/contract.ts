/**
 * @file Task 11 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 11.
 *
 * The dialog-specific wire shapes live here. The report itself is imported from the neutral,
 * client-safe `report-contract.ts` module so there is only one report DTO declaration.
 */
import type {
  PublishContentOutcomeKindDto,
  PublishContentOutcomeRowDto,
  PublishContentReportDto,
} from "../report-contract.js";

export type PublishContentOutcomeKind = PublishContentOutcomeKindDto;
export type PublishContentOutcomeRow = PublishContentOutcomeRowDto;
export type PublishContentReport = PublishContentReportDto;

/**
 * One configured publish target, as `GET .../publish-content/peers` returns it.
 *
 * `masked` and `hasCredential` are the ONLY credential-shaped fields that exist on the client at
 * all. The sealed material behind them never leaves the server — nothing in this folder, in the
 * admin dialog, or in any error path may request, render, log or store it.
 */
export interface PublishContentPeerSummary {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly remoteWorkspaceId: string;
  /** A display hint derived from the key, never the key. `null` when the peer holds no credential. */
  readonly masked: string | null;
  readonly hasCredential: boolean;
}

/** One type the live site can't take yet — see {@link PublishContentPlanResult.notSupportedByLive}. */
export interface PublishContentNotSupportedByLive {
  readonly entityType: string;
  readonly count: number;
}

/**
 * `POST .../publish-content/peers/:peerId/push/plan` — the shared gated-mutation envelope
 * (`GatedPlanResult` in `apps/admin/src/lib/api.ts`) with this ceremony's own `details`, spread at
 * the top level so one client render path serves both this route and the local `/import/plan`.
 *
 * `bundleId` is load-bearing, not informational: the peer's `/import/execute` requires the same
 * bundle it planned against, so the client MUST carry this value from the plan into the execute
 * call. Losing it turns a confirmed plan into an unexecutable one.
 */
export interface PublishContentPlanResult {
  readonly planId: string;
  readonly planHash: string;
  readonly bundleId: string;
  readonly details: PublishContentReport;
  /**
   * publish-overwrite-live-plan §4/S7 — whether the peer this plan targets can honour a forced
   * overwrite at all (`peer-transport.ts`'s `PushBundleResult.liveCanOverwrite`, echoed here by
   * `push/plan`). `false` for a peer on an older Tovu build, or one whose bundle carried no
   * entities to probe against. The admin dialog and the chat tool read this before ever offering an
   * "Overwrite on live" tick.
   */
  readonly liveCanOverwrite: boolean;
  /**
   * The types the live site's build can't take yet, with how many of each the bundle held back
   * (`peer-transport.ts`'s `PushBundleResult.notSupportedByLive`, echoed by `push/plan`). Those rows
   * never reach `details.rows`, so without this a forms-only publish to an older live reads as
   * "Nothing to publish". Absent (or empty) when the live took every type.
   */
  readonly notSupportedByLive?: readonly PublishContentNotSupportedByLive[];
  /**
   * The `overwriteEntityKeys` this plan was built with, echoed back exactly as sent so a client can
   * carry the SAME set into `push/execute` (§3's admin/chat flow) rather than keeping its own
   * parallel copy in sync. Absent when nothing was ticked — the pre-S7 default every existing caller
   * still gets.
   */
  readonly overwriteEntityKeys?: readonly string[];
}

/**
 * `plan-publish-sections-2026-09-25.md` §1 — narrows `push/plan` to a subset of the corpus, applied on
 * the SERVER before staging (§1's decision: faster, and every existing row-selection/overwrite/refusal
 * mechanism stays correct with no changes because the staged bundle already only holds in-scope rows).
 *
 * Absent means "publish everything", the same "absent, not an empty real answer" contract
 * `selectedEntityKeys` already reads by. A present field must be a non-empty array (empty means the
 * request is malformed, not "select nothing" — that ambiguity is `selectedEntityKeys`'s job, not
 * this one's) of at most 1000 entries; the peer transport route 400s otherwise.
 *
 * Kept separate from `PublishCriteria` (`criteria.ts`) on purpose: criteria is chat's *starting
 * selection* (it still plans/uploads/shows every type, only unticking non-matching rows); scope is
 * *what this dialog is about* (it narrows what is staged at all). Chat's behaviour does not change.
 *
 * `entityTypes` and `entityKeys` both narrow (AND, not OR) when both are given: a themes-only scope
 * with an `entityKeys` list still only ever shows theme rows, and an id from a different type in that
 * list matches nothing. `entityKeys` matches `planner.ts`'s `entityKey(type, id)` shape, same as
 * `selectedEntityKeys`.
 */
export interface PublishScope {
  readonly entityTypes?: readonly string[];
  readonly entityKeys?: readonly string[];
}

/** `POST .../publish-content/peers/:peerId/push/confirm`. The token is the ONLY thing that authorizes an
 *  execute — see `phase.ts`. */
export interface PublishContentConfirmResult {
  readonly confirmationToken: string;
}

/** `POST .../publish-content/peers/:peerId/push/execute` — mirrors `gated-hooks.ts`'s `executeMutation()` return.
 *  `restorePointId` is what an operator needs to undo a whole bad run; `changeSetIds` is what they
 *  need to undo one entity. */
export interface PublishContentExecuteResult {
  readonly restorePointId: string;
  readonly runId: string;
  readonly changeSetIds: readonly string[];
  /** publish-overwrite-live-plan §4 — the change sets that moved a live address holder to Trash, kept
   *  apart from `changeSetIds`. Absent from a live built before the overwrite feature. */
  readonly retiredChangeSetIds?: readonly string[];
  /** R5 (`plan-publish-repoint-menus-2026-09-24.md` §2.3) — the change sets a live-reference repoint
   *  pass produced (e.g. a menu's entryRef rewritten after an overwrite). Absent from a live built
   *  before this feature. */
  readonly repointChangeSetIds?: readonly string[];
  /** Total links repointed this run; the admin dialog shows this only when it is greater than 0
   *  (§2.7). Absent from a live built before this feature. */
  readonly menuLinksUpdated?: number;
  /** Operator-facing lines for a holder that could not be repointed. Absent from a live built before
   *  this feature. */
  readonly menuLinksNotUpdated?: readonly string[];
}
