import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyPublishCriteria,
  canConfirmPlan,
  canRequestPlan,
  confirmationTokenFor,
  countSelectedPublishing,
  planOnScreen,
  publishEntityTypePluralLabel,
  rowPublishesWithSelection,
  selectableRowKeys,
  summarizePublishReport,
  toPublishReportRows,
  type CriteriaSelection,
  type PublishContentNotSupportedByLive,
  type PublishContentOutcomeRow,
  type PublishContentPeerSummary,
  type PublishContentPhase,
  type PublishContentPlanResult,
  type PublishContentReport,
  type PublishCriteria,
  type PublishReportRow,
  type PublishReportSummary,
  type PublishRequestResult,
  type PublishScope,
} from "@tovu/publish-content-ui";

import { describeApiError, type AdminPublishDestinationView } from "@/lib/api";

import type { Translate } from "../../../lib/dictionary-translator";
import { defaultPublishContentPort } from "./publish-content-dependencies.hooks";
import type { PublishContentPort } from "./publish-content-port.hooks";
import { publishScopeDescriptionKey, publishScopeTitleKey } from "../publish-scope";

/**
 * @file The colocated `PublishContentDialog` behaviour — Escape-to-cancel, plus plan -> confirm ->
 * execute ceremony (`ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4
 * task 11). The component renders what this returns and decides nothing itself, per the standing
 * rule that component logic belongs in a hook.
 *
 * ## What is NOT here
 *
 * The ceremony's *rules* — which rows a run writes, what each outcome is called, and when a plan may
 * be confirmed or executed — live in `@tovu/publish-content-ui` (`apps/website/src/features/
 * publish-content/ui/`), next to the planner whose behaviour they restate. This file is the React
 * shell around them: state, effects, and the three port calls. A rule that could drift from
 * `planner.ts` does not belong in this package.
 *
 * ## Why execute is fired from an effect rather than inline after confirm
 *
 * Plan §4 task 11's acceptance criterion is that the dialog *cannot* fire execute without a
 * confirmed plan. Executing inline at the end of `confirmAndPublish` would make that a property of
 * one function's control flow — true today, and one early-return away from not being true. Instead
 * the token only exists inside a `confirmed` phase, {@link confirmationTokenFor} is the only reader,
 * and the execute effect keys off that reader's result. There is no code path in this file that can
 * call `port.executePublish` with anything else.
 *
 * The server enforces the same property independently — `gateway.execute()` re-runs `computePlan()`
 * and hash-compares it against the confirmed token before any write (`features/publish-content/
 * gated-hooks.ts`). This half exists so the operator never sees a button that would 409.
 */

/** The empty state's offer to connect — what replaces the old "configure a peer in Settings" dead
 *  end (`destination.ts`'s header: the connect action lives here, behind Publish, rather than on a
 *  settings screen the owner has to already know to visit). `message` is the server's own sentence
 *  (`AdminPublishDestinationView.message`) verbatim, never rewritten here. */
export interface PublishContentConnectOffer {
  readonly message: string;
  /** `null` on a fresh install with nothing deployed yet — the primary button stays disabled until
   *  there is a candidate to connect to. */
  readonly candidateUrl: string | null;
}

/** Everything `PublishContentDialog.tsx` renders. Nothing here is a raw port or a setter — the
 *  component gets finished strings and booleans, not state to interpret. */
export interface PublishContentConfirmView {
  readonly phase: PublishContentPhase;
  readonly peers: readonly PublishContentPeerSummary[];
  readonly selectedPeerId: string | null;
  /** Choosing a different site discards any plan on screen — a plan belongs to the site that made
   *  it — and is ignored while {@link peerSelectionEnabled} is `false`. */
  readonly onSelectPeer: (peerId: string) => void;
  /** `false` while a plan is being worked out and from the moment the operator commits: there the
   *  site is part of what is already in flight, and changing it could only misdescribe it. */
  readonly peerSelectionEnabled: boolean;
  /** `false` from confirm until the publish has an outcome on screen. The run cannot be aborted
   *  once confirm is sent, so closing then would cancel nothing and only hide whether it worked. */
  readonly dismissible: boolean;
  /** Closes the dialog — the one handler behind Cancel and the backdrop. A no-op while
   *  {@link dismissible} is `false`; Escape follows the same rule. */
  readonly onDismiss: () => void;
  readonly rows: readonly PublishReportRow[];
  readonly summary: PublishReportSummary | null;
  /** The keys of the rows this run would publish — every {@link PublishReportRow.selectable} row the
   *  operator has not unchecked. Rows that are not selectable are never in here. */
  readonly selectedKeys: ReadonlySet<string>;
  /** Owner decision 2026-09-25 — the carried-along media rows ({@link PublishReportRow.includedFor})
   *  that currently publish, because a page/post that uses them is still ticked. Their checkbox is
   *  shown ticked (and never clickable) exactly when the row is in here. */
  readonly carriedAlongKeys: ReadonlySet<string>;
  readonly onToggleRow: (key: string) => void;
  /** Checks every selectable row, or unchecks every one of them when any is currently checked. */
  readonly onToggleAll: () => void;
  /** `false` once the operator has committed (confirming/executing/done) — the report stays on
   *  screen through those phases, but its checkboxes stop being an offer at that point. */
  readonly selectionEnabled: boolean;
  /** Header-checkbox state. `someSelected` is the indeterminate case and is never true at the same
   *  time as `allSelected`. */
  readonly allSelected: boolean;
  readonly someSelected: boolean;
  /**
   * publish-overwrite-live-plan §4/S9. Whether the plan on screen came from a peer that can honour a
   * forced overwrite at all (`plan.liveCanOverwrite`). `true` while there is no plan on screen —
   * harmless, since {@link PublishReportRow.overwritable} rows don't exist yet either.
   */
  readonly liveCanOverwrite: boolean;
  /** The keys currently ticked "Overwrite on live" — a strict subset of every row's own key, never
   *  read for anything but rendering `checked`. */
  readonly overwriteKeys: ReadonlySet<string>;
  /** The rows that carry an "Overwrite on live" box: every {@link PublishReportRow.overwritable} row,
   *  plus every ticked one — a tick turns its row `forced`, and the box must stay to be unticked. */
  readonly overwriteOfferKeys: ReadonlySet<string>;
  /** Whether the overwrite column renders at all: the peer can honour it and some row offers a box. */
  readonly showOverwriteColumn: boolean;
  /** Ticks or unticks one row's "Overwrite on live" box, then immediately re-plans against it (see
   *  this file's `applyOverwriteKeys`) — the report on screen updates to show the tick actually
   *  taking effect (the row turns `forced`) rather than promising something a later Confirm might
   *  refuse. */
  readonly onToggleOverwrite: (key: string) => void;
  /** Ticks every {@link overwriteOfferKeys} row at once, or clears them all when every one already
   *  is — the overwrite column's own header control, independent of {@link onToggleAll}. */
  readonly onToggleAllOverwrite: () => void;
  readonly allOverwriteTicked: boolean;
  readonly someOverwriteTicked: boolean;
  /** Set while at least one box is ticked — the aggregate "this will replace things on the live site"
   *  notice, shown independent of {@link errorMessage}. `null` otherwise. */
  readonly overwriteWarning: string | null;
  /** Set when a ticking re-plan disagrees with what the operator already reviewed (see
   *  `overwriteReplanIsConsistent`) — the live site moved between the first plan and this tick. The
   *  report on screen already shows the new truth; this is the sentence explaining why it changed.
   *  Cleared the moment the ticked set changes again. */
  readonly overwriteMismatch: string | null;
  /** Set when at least one row could be overwritten in principle (`row.overwritable` on an
   *  untouched, unticked report) but the peer this plan targets cannot honour it
   *  (`!liveCanOverwrite`) — the dialog shows this sentence instead of any checkbox. */
  readonly overwriteUnavailable: string | null;
  /** `plan-publish-sections-2026-09-25.md` §2 S2 — the dialog's own `<h2>`, an English copy key the
   *  screen's `t()` resolves the same way it resolves every other string here. Always
   *  `publishScopeTitleKey(props.scope)`; unlike `primaryLabel`, it never changes once a plan lands. */
  readonly title: string;
  /** Owner decision 2026-09-25 — the description line under the title, an English copy key naming
   *  what this dialog sends: `publishScopeDescriptionKey(props.scope)`. */
  readonly description: string;
  readonly primaryLabel: string;
  readonly primaryDisabled: boolean;
  readonly onPrimary: () => void;
  /** A failed plan/confirm/execute, or a failed peer read. `null` when nothing has gone wrong. */
  readonly errorMessage: string | null;
  /** Set when the whole run refused (a content-hash version mismatch) — a different thing from an
   *  error, and it gets its own sentence rather than being flattened into one. */
  readonly refusalReason: string | null;
  readonly doneMessage: string | null;
  /** The server's own lines for each live menu the run could not repoint (plan §2.7) — reported,
   *  never silent. Empty outside the `done` phase and for a live built before the repoint pass. */
  readonly doneNotices: readonly string[];
  /** One line per type the live site can't take yet (`plan.notSupportedByLive`) — those rows never
   *  reach the report, so this is the only place they show. Empty when the live took everything. */
  readonly liveGapNotices: readonly string[];
  /** Set once peers have loaded empty and the destination check has resolved. `null` while peers
   *  exist, are still loading, or the destination check hasn't resolved yet — see this file's
   *  connect-offer effect. */
  readonly connectOffer: PublishContentConnectOffer | null;
}

const EMPTY_ROWS: readonly PublishReportRow[] = [];

/**
 * Operator-facing copy for a failed call, via the shared `describeApiError` base case rather than a
 * local `error.message` read (the 2026-08-01 adversarial-UX audit's cross-cutting finding #2: every
 * screen that rebuilt this chain itself, and every screen whose author forgot, showed a raw
 * developer string or a blank).
 *
 * The verbatim pass-through matters here specifically. A peer whose host resolves to a private
 * address answers 502 `EGRESS_REFUSED` with a message naming `devHostAllowlist` and the env var to
 * set — that sentence is the operator's only instruction for fixing it, so it must reach the screen
 * unrewritten. `request()` throws it as an `ApiError` whose `message` IS `body.error`, and
 * `describeApiError` returns that untouched; the fallback only covers an empty message or a thrown
 * non-Error.
 *
 * @complexity O(1).
 */
function messageOf(error: unknown, fallback: string): string {
  return describeApiError(error, fallback);
}

/**
 * Builds the primary button's label. Counted copy is assembled from `t()`-resolved fragments rather
 * than one interpolated key, because this app's translator is a key lookup with no interpolation
 * (`lib/dictionary-translator.ts`) — the alternative is a key per possible count.
 *
 * The connect offer takes priority over every phase check below it: while it is present, the same
 * button IS the connect action (see this file's header note on why one control is reused rather
 * than adding a second button next to a disabled "Publish").
 *
 * @complexity O(1).
 */
function primaryLabelFor(
  phase: PublishContentPhase,
  selectedPublishing: number,
  connectOffer: PublishContentConnectOffer | null,
  connecting: boolean,
  t: Translate,
  scope: PublishScope | undefined,
  onlyLiveGaps: boolean
): string {
  if (connectOffer) return connecting ? t("Connecting…") : t("Connect");
  if (phase.kind === "planning") return t("Planning…");
  if (phase.kind === "confirming" || phase.kind === "executing") return t("Publishing…");
  if (phase.kind === "done") return t("Published");
  // plan-publish-sections-2026-09-25.md §2 S2 — before a plan lands, the idle button promises what
  // this dialog is scoped to, same label as its own title (`publishScopeTitleKey`).
  if (phase.kind !== "planned") return t(publishScopeTitleKey(scope));
  // The SELECTED count, not the plan's own: the button must promise what this click will actually
  // do. A plan of 59 writable rows with 56 unchecked says "Publish 3 items".
  // An empty report whose types the live site simply can't take yet is not "nothing to publish" —
  // the content is there, the live is behind (see `liveGapLinesFor`).
  if (selectedPublishing === 0) return onlyLiveGaps ? t("Update the live site first") : t("Nothing to publish");
  return `${t("Publish")} ${selectedPublishing} ${selectedPublishing === 1 ? t("item") : t("items")}`;
}

/**
 * One line per type the live site can't take yet, e.g. "Forms (7) can't publish yet: the live site
 * needs an update first." The plural type name comes from `PUBLISH_SECTIONS` (`ui/sections.ts`);
 * the count sits in brackets so the sentence reads the same for 1 and for 7 in every locale (this
 * app's translator has no plurals or interpolation — see `primaryLabelFor`).
 *
 * @complexity O(n) in `entries.length`.
 */
export function liveGapLinesFor(
  entries: readonly PublishContentNotSupportedByLive[] | undefined,
  t: Translate
): readonly string[] {
  return (entries ?? [])
    .filter((entry) => entry.count > 0)
    .map(
      (entry) =>
        `${t(publishEntityTypePluralLabel(entry.entityType))} (${entry.count}) ${t("can't publish yet: the live site needs an update first.")}`
    );
}

/**
 * Whether the operator may change which site this dialog publishes to. Only where no request is in
 * flight and nothing is committed: `idle`, a `planned` report still being reviewed, or `failed`.
 * `done` is closed for the same reason `canRequestPlan` excludes it — close and reopen to go again.
 *
 * @complexity O(1).
 */
function peerSelectionOpen(phase: PublishContentPhase): boolean {
  return phase.kind === "idle" || phase.kind === "planned" || phase.kind === "failed";
}

/**
 * The confirmation banner shown once a publish executes: how many entities changed, plus how many
 * live menu links were repointed to follow them (`plan-publish-repoint-menus-2026-09-24.md` §2.7/R6).
 * `null` outside the `done` phase, same as the field this replaces.
 *
 * Counted copy is assembled from `t()`-resolved fragments for the same reason `primaryLabelFor` above
 * is: this app's translator has no interpolation. The menu-links clause is appended only when
 * `menuLinksUpdated` is greater than 0 — a run that repointed nothing says nothing about menus at
 * all, rather than a confusing "Menu links updated: 0." `?? 0` covers a peer built before R5, whose
 * `PublishContentExecuteResult` carries no `menuLinksUpdated` at all.
 *
 * @complexity O(1).
 */
function doneMessageFor(phase: PublishContentPhase, t: Translate): string | null {
  if (phase.kind !== "done") return null;
  const changeCount = phase.result.changeSetIds.length;
  const base = `${t("Published")} ${changeCount} ${changeCount === 1 ? t("change") : t("changes")}.`;
  const menuLinksUpdated = phase.result.menuLinksUpdated ?? 0;
  if (menuLinksUpdated <= 0) return base;
  return `${base} ${t("Menu links updated:")} ${menuLinksUpdated}.`;
}

/**
 * The overwrite checkbox's `title` — `plan-publish-repoint-menus-2026-09-24.md` §2.7/R6: when the
 * retired holder still feeds a live menu, the tooltip names it too, so an operator ticking
 * "overwrite" can see what else moves with it. `undefined` for a row with no `retires` target at all
 * (`PublishContentDialog.tsx` only renders this control for an offered row in the first place, but
 * the function stays defensive rather than assuming that holds).
 *
 * @complexity O(n) in `referencedByLabels.length` for the join; O(1) otherwise.
 */
export function overwriteTooltipFor(
  row: Pick<PublishReportRow, "retiresLabel" | "referencedByLabels">,
  t: Translate
): string | undefined {
  if (!row.retiresLabel) return undefined;
  const base = `${row.retiresLabel} ${t("moves to")} ${t("Trash")}`;
  if (row.referencedByLabels.length === 0) return base;
  return `${base}. ${t("Menu links follow:")} ${row.referencedByLabels.join(", ")}`;
}

/**
 * Whether a publish has been committed and has no outcome yet: confirm is on its way or answered,
 * or execute is running. From here the live site finishes the run whatever this dialog does (terra
 * review 2026-09-20, finding 3), so the dialog stays open until it can say how that went.
 *
 * @complexity O(1).
 */
function publishInFlight(phase: PublishContentPhase): boolean {
  return phase.kind === "confirming" || phase.kind === "confirmed" || phase.kind === "executing";
}

/**
 * Whether `peerId` is an actually-chosen site, as opposed to the picker's blank placeholder
 * (`PublishContentDialog.tsx`'s `<option value="">`, which fires `onSelectPeer("")`) or nothing
 * chosen at all. Every guard downstream of a peer id — the start gate, the confirm gate, and the
 * execute effect's gate — reads this rather than a bare `!== null`, so an empty string can never slip
 * through one of them into a `planPublish`/`confirmPublish`/`executePublish` call with an empty
 * `:peerId` segment (a confusing 404, since Express can't route an empty path segment, instead of the
 * button simply staying disabled — plan-server.md's BLOCKED-CLAIMED finding, 2026-09-20).
 * `onSelectPeer` below also normalizes `""` to `null` in {@link selectedPeerId} itself, so this
 * belongs to defense in depth for anything that reads {@link planPeerRef} after an `await`, not the
 * only thing standing between the picker and the network.
 * @complexity O(1).
 */
function isChosenPeerId(peerId: string | null): peerId is string {
  return peerId !== null && peerId !== "";
}

/** `${entityType}:${entityId}` — byte-identical to `planner.ts`'s own `entityKey()` and to
 *  `report-rows.ts`'s row `key`, which is what a ticked "Overwrite on live" checkbox is keyed by. */
function outcomeRowKey(row: Pick<PublishContentOutcomeRow, "entityType" | "entityId">): string {
  return `${row.entityType}:${row.entityId}`;
}

/** Every key this report would actually write (`created`/`applied`/`forced`), minus `exclude` — the
 *  yardstick {@link overwriteReplanIsConsistent} uses twice, once per report, to compare "everything
 *  this run writes other than what the operator is ticking or unticking". */
function writingKeysExcluding(report: PublishContentReport, exclude: ReadonlySet<string>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const row of report.rows) {
    if (row.outcome !== "created" && row.outcome !== "applied" && row.outcome !== "forced") continue;
    const key = outcomeRowKey(row);
    if (!exclude.has(key)) keys.add(key);
  }
  return keys;
}

/**
 * Whether re-planning with `tickedKeys` (publish-overwrite-live-plan §4/S9's "Overwrite on live"
 * boxes) landed on a report consistent with `shown` — the report on screen when the operator
 * clicked, i.e. the one they actually reviewed. Comparing against the screen rather than the first
 * plan matters after a mismatch: the operator has been told to check the new list, and every later
 * tick would otherwise re-report the same old drift forever (c7n-ow-review2, 2026-09-24).
 *
 * Two things must both hold:
 * 1. every ticked key is now `forced` in `next` — a peer that can honour the overwrite always
 *    answers this way; anything else means the tick did not take (e.g. the holder moved again).
 * 2. every writing row (created/applied/forced) outside `changing` — the keys ticked or unticked by
 *    this click and any still in flight — names the exact same set in both reports: a live edit
 *    landing in between shows up here as a newly-written or newly-skipped row.
 *
 * A `false` here is not a network error: the re-plan itself succeeded, it just disagrees with what
 * was on screen, and `applyOverwriteKeys` shows the new truth plus a sentence rather than silently
 * keeping the stale one.
 *
 * @complexity O(n) in the larger report's row count.
 */
function overwriteReplanIsConsistent(
  shown: PublishContentReport,
  next: PublishContentReport,
  tickedKeys: ReadonlySet<string>,
  changing: ReadonlySet<string>
): boolean {
  const nextByKey = new Map(next.rows.map((row) => [outcomeRowKey(row), row]));
  for (const key of tickedKeys) {
    const row = nextByKey.get(key);
    if (!row || row.outcome !== "forced") return false;
  }
  const shownOther = writingKeysExcluding(shown, changing);
  const nextOther = writingKeysExcluding(next, changing);
  if (shownOther.size !== nextOther.size) return false;
  for (const key of shownOther) if (!nextOther.has(key)) return false;
  return true;
}

/** `{ overwriteEntityKeys }` narrowed to the keys in `keep`, or `{}` when none survive — spread into
 *  a narrowing re-plan so an empty set is never sent as an explicit (and meaningless) empty array.
 *  @complexity O(n + m). */
function overwriteKeysWithin(
  overwriteEntityKeys: readonly string[] | undefined,
  keep: readonly string[]
): { overwriteEntityKeys?: readonly string[] } {
  const kept = new Set(keep);
  const within = (overwriteEntityKeys ?? []).filter((key) => kept.has(key));
  return within.length > 0 ? { overwriteEntityKeys: within } : {};
}

/**
 * S2 — what `props.onPlanned` is called with: the SAME `rows`/`selection` the dialog itself renders
 * from, so a chat/WebMCP caller's report can never disagree with what the operator sees on screen.
 *
 * `willOverwrite` is a subset of `willPublish`, not a separate list: a `forced` row is also a row
 * that will be published (plan §2's own `PublishRequestResult` doc says as much — "what would be
 * published or overwritten"), it just publishes BY overwriting. `leftAlone` only ever names a
 * `skipped` row — an `unchanged` row isn't "left alone" by the criteria, it was already a no-op
 * before any criteria existed.
 *
 * @complexity O(rows).
 */
function buildCriteriaPublishResult(
  rows: readonly PublishReportRow[],
  selection: CriteriaSelection,
  siteLabel: string | null
): PublishRequestResult {
  const willPublish: string[] = [];
  const willOverwrite: string[] = [];
  const leftAlone: { label: string; reason: string }[] = [];
  const selected = new Set(selectableRowKeys(rows).filter((key) => !selection.deselectedKeys.has(key)));
  for (const row of rows) {
    // A carried-along media row publishes with the pages/posts that use it (`rowPublishesWithSelection`).
    if (rowPublishesWithSelection(row, selected)) {
      willPublish.push(row.entityLabel);
      if (row.outcome === "forced") willOverwrite.push(row.entityLabel);
    } else if (row.disposition === "skipped") {
      leftAlone.push({ label: row.entityLabel, reason: row.reason ?? "No reason recorded." });
    }
  }
  return {
    opened: true,
    planned: true,
    site: siteLabel,
    willPublish,
    willOverwrite,
    leftAlone,
    unmatchedItems: selection.unmatchedItems,
    unknownTypes: selection.unknownTypes,
    nextStep: "Check the list in the Publish dialog, then click Publish.",
  };
}

/**
 * @param props.onCancel Called when the dialog should close (Escape, Cancel, the backdrop) — never
 *   while a committed publish has no outcome yet; see `publishInFlight`.
 * @param props.t The screen's own bound translator, threaded down rather than resolved again here.
 * @param props.port Dependency injection seam for tests — see `publish-content-port.hooks.ts`.
 * @param props.criteria `publish-criteria-tool-webmcp-plan-2026-09-24.md` §4 S2 — a caller with no
 *   button of its own (chat, WebMCP, or the admin's own `?publish=` deep link) names what it asked
 *   for here. Applied exactly once, against the first plan that lands: it becomes the dialog's
 *   STARTING `deselectedKeys`/overwrite ticks, never a second selection mechanism of its own — see
 *   this file's "S2 — applying criteria" block below, and plan §2's own header for why this can never
 *   itself write anything (planning is read-only; only a person's own click reaches confirm/execute).
 * @param props.scope `plan-publish-sections-2026-09-25.md` §2 S2 — what this dialog is about (a
 *   section button's "Publish pages", say), sent unchanged on every `port.planPublish` call via this
 *   hook's own `planInScope` helper. `undefined` for the Dashboard's own "Publish all content" and
 *   for every criteria-only (chat/WebMCP) open — see `ui/contract.ts`'s `PublishScope` header for why
 *   this is kept separate from `props.criteria`.
 * @param props.onPlanned Fires once, with what the (possibly criteria-narrowed) plan actually shows —
 *   after any overwrite re-plan the criteria triggered has settled, never before. `undefined` for the
 *   Dashboard's own ordinary open (plan §0's caller 1), which has no one waiting on an answer.
 * @complexity Time: O(n) per re-render in the plan's row count (row shaping + the summary counts);
 * space: O(n) for the shaped rows. One document-level keydown listener for the mounted lifetime.
 */
export function usePublishContentConfirm(props: {
  onCancel: () => void;
  t: Translate;
  port?: PublishContentPort;
  criteria?: PublishCriteria;
  scope?: PublishScope;
  onPlanned?: (result: PublishRequestResult) => void;
}): PublishContentConfirmView {
  const { onCancel, t } = props;
  const port = props.port ?? defaultPublishContentPort;

  // plan-publish-sections-2026-09-25.md §2 S2 — the ONE place `scope` reaches `port.planPublish`
  // from, so no bare `port.planPublish` call under this hook can forget it. `props.scope` is fixed
  // for the dialog's whole lifetime (it is not operator-changeable state), so this needs no memo
  // beyond `useCallback`'s own identity stability.
  const planInScope = useCallback(
    (input: { peerId: string; selectedEntityKeys?: readonly string[]; overwriteEntityKeys?: readonly string[] }) =>
      port.planPublish(props.scope === undefined ? input : { ...input, scope: props.scope }),
    [port, props.scope]
  );

  const [phase, setPhase] = useState<PublishContentPhase>({ kind: "idle" });
  const [peers, setPeers] = useState<readonly PublishContentPeerSummary[]>([]);
  const [peersLoaded, setPeersLoaded] = useState(false);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [peersError, setPeersError] = useState<string | null>(null);

  // The empty state's connect offer — only ever populated when the peer list comes back empty (see
  // the effect below). `destination` and `destinationError` are mutually exclusive with each other,
  // same convention as `peers`/`peersError`.
  const [destination, setDestination] = useState<AdminPublishDestinationView | null>(null);
  const [destinationLoaded, setDestinationLoaded] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Stored as what the operator UNCHECKED, not as what is checked. "All checked by default" is then
  // the empty set rather than a value that has to be seeded from the plan the moment it arrives —
  // there is no effect to forget, no window where the rows render before the seeding lands, and a
  // re-plan's new rows arrive checked without anything having to re-seed them.
  const [deselectedKeys, setDeselectedKeys] = useState<ReadonlySet<string>>(() => new Set());

  // publish-overwrite-live-plan §4/S9 — the "Overwrite on live" ticks. Kept as its own state, never
  // folded into `deselectedKeys`: unchecking a row means "don't publish this", ticking here means
  // "resolve this skip by overwriting live", and the two are independent (a ticked row is also, once
  // it turns `forced`, a selectable row that can itself still be deselected).
  const [overwriteKeys, setOverwriteKeys] = useState<ReadonlySet<string>>(() => new Set());
  // Set only when a ticking re-plan finds the live site moved since the plan the operator is looking
  // at — cleared the instant the ticked set changes again, since a fresh re-plan speaks for itself.
  const [overwriteMismatch, setOverwriteMismatch] = useState<string | null>(null);
  // The plan `requestPlan` most recently landed for the CURRENT peer, before any overwrite tick —
  // what unticking the last box goes back to without a network call. Reset alongside
  // `overwriteKeys` on every fresh plan, and marked stale (`basePlanStaleRef`) the moment a ticking
  // re-plan shows live moved since: from then on it no longer describes live, so unticking the last
  // box asks live again instead of putting an out-of-date list back on screen.
  const basePlanRef = useRef<PublishContentPlanResult | null>(null);
  const basePlanStaleRef = useRef(false);
  // The ticked set as of the MOST RECENT `applyOverwriteKeys` call, read synchronously inside that
  // call's own async continuation so a superseded tick's response never overwrites a newer one's —
  // the same shape as `planPeerRef`'s "answering for a peer we've left" guard, one level down.
  const overwriteKeysRef = useRef<ReadonlySet<string>>(new Set());
  // Whether a ticking re-plan is still out. While it is, the plan on screen is not the one the ticks
  // describe, so confirming it would publish WITHOUT the overwrite just asked for — and the late
  // re-plan would then be dropped as answering a phase that has moved on. The ref is the synchronous
  // guard `confirmPlan` reads; the state is what disables the button.
  const overwriteReplanPendingRef = useRef(false);
  const [overwriteReplanPending, setOverwriteReplanPending] = useState(false);
  const setReplanPending = useCallback((pending: boolean): void => {
    overwriteReplanPendingRef.current = pending;
    setOverwriteReplanPending(pending);
  }, []);

  const dismissible = !publishInFlight(phase);
  const onDismiss = (): void => {
    if (dismissible) onCancel();
  };
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && dismissible) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, dismissible]);

  // `live` guards every `setState` that follows an `await`: the dialog is unmounted by its own
  // Cancel button and by Escape, either of which can land while a plan or a publish is in flight.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The site the current phase's plan was requested from — what confirm and execute address, never
  // the picker's value at click time (terra review 2026-09-20, finding 2). `PublishContentPlanResult`
  // carries no peer id of its own, so the binding is kept here: set when a plan is requested, cleared
  // when the operator picks another site. A ref because `requestPlan` compares against it after an
  // `await`, where a state read would be the stale closure value.
  const planPeerRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { peers: loaded } = await port.listPeers();
        if (cancelled || !live.current) return;
        setPeers(loaded);
        // Auto-select when there is exactly one target: the overwhelmingly common case is a single
        // production peer, and making the operator pick it from a list of one is friction with no
        // decision behind it. With two or more, the dialog asks.
        setSelectedPeerId(loaded.length === 1 ? loaded[0].id : null);
        // Nothing to publish to yet — check whether this install can offer a one-click connect
        // instead of failing shut. Sequenced after `listPeers` rather than fired in parallel: the
        // common case (already connected) never needs this second call at all.
        if (loaded.length === 0) {
          try {
            const view = await port.getDestination();
            if (cancelled || !live.current) return;
            setDestination(view);
          } catch (destinationErr) {
            if (cancelled || !live.current) return;
            setDestinationError(messageOf(destinationErr, t("Could not check whether this install can publish yet.")));
          } finally {
            if (!cancelled && live.current) setDestinationLoaded(true);
          }
        }
      } catch (error) {
        if (cancelled || !live.current) return;
        setPeersError(messageOf(error, t("Could not load publish targets.")));
      } finally {
        if (!cancelled && live.current) setPeersLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` is read only for a fallback string and is deliberately NOT a dependency: a caller whose
    // translator is a fresh closure each render would otherwise refetch the peer list on every
    // render. The worst case is a fallback sentence in a stale locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [port]);

  // Takes `peerId` explicitly rather than reading `selectedPeerId` off closure: `onConnect` below
  // calls this in the same tick it learns the newly-connected peer's id, before that `setState` has
  // committed, so a closure read here would still see `null`.
  //
  // Guards with `isChosenPeerId` itself rather than trusting every caller to check first (a3-review-4
  // handoff, 2026-09-21): `onConnect` calls this with whatever `site.id` `connectDestination` answers,
  // with no check of its own — a contract violation there would otherwise reach
  // `port.planPublish({ peerId: "" })` unguarded. This is the one function every network call in this
  // hook goes through, so the guard belongs here, not repeated (and possibly forgotten) at each caller.
  const requestPlan = useCallback(
    async (peerId: string) => {
      if (!isChosenPeerId(peerId)) return;
      planPeerRef.current = peerId;
      setPhase({ kind: "planning" });
      try {
        const plan = await planInScope({ peerId });
        // A plan answering for a site the dialog is no longer pointed at is dropped, not shown.
        if (!live.current || planPeerRef.current !== peerId) return;
        // A fresh top-level plan is the new baseline every overwrite tick gets checked against, and
        // starts with nothing ticked — same reasoning as `deselectedKeys` resetting on a re-plan.
        basePlanRef.current = plan;
        basePlanStaleRef.current = false;
        overwriteKeysRef.current = new Set();
        setOverwriteKeys(new Set());
        setOverwriteMismatch(null);
        setReplanPending(false);
        setPhase({ kind: "planned", plan });
      } catch (error) {
        if (!live.current || planPeerRef.current !== peerId) return;
        setPhase({ kind: "failed", message: messageOf(error, t("Could not work out what would be published.")), code: null });
      }
    },
    [planInScope, setReplanPending, t]
  );

  /**
   * The core of S9's "ticking re-plans" flow. Re-plans with `nextOverwriteKeys` and puts the result
   * on screen; when it disagrees with the report the operator was looking at
   * (`overwriteReplanIsConsistent`), it adds the mismatch sentence too. A `planned` phase is the only
   * one this ever fires from — ticking is offered only while a report is up for review.
   *
   * `nextOverwriteKeys.size === 0` (the operator unticked the last box) goes straight back to
   * `basePlanRef.current` with no network call — unless a mismatch has shown that plan no longer
   * describes live, in which case live is asked again (with no keys).
   */
  const applyOverwriteKeys = useCallback(
    (nextOverwriteKeys: ReadonlySet<string>) => {
      const peerId = planPeerRef.current;
      const base = basePlanRef.current;
      if (!isChosenPeerId(peerId) || base === null || phase.kind !== "planned") return;
      const shown = phase.plan;
      // Keys ticked or unticked by this click, plus any still in flight from an earlier one: the
      // consistency check compares everything ELSE between the screen and the answer.
      const changing = new Set([...overwriteKeysRef.current, ...nextOverwriteKeys]);
      overwriteKeysRef.current = nextOverwriteKeys;
      setOverwriteKeys(nextOverwriteKeys);
      setOverwriteMismatch(null);
      const useBase = nextOverwriteKeys.size === 0 && !basePlanStaleRef.current;
      setReplanPending(!useBase);
      void (async () => {
        try {
          const replanned = useBase
            ? base
            : await planInScope(
                nextOverwriteKeys.size === 0 ? { peerId } : { peerId, overwriteEntityKeys: Array.from(nextOverwriteKeys) }
              );
          // Superseded by a newer tick, a peer switch, or an unmount while this was in flight.
          if (!live.current || planPeerRef.current !== peerId || overwriteKeysRef.current !== nextOverwriteKeys) return;
          setReplanPending(false);
          if (!useBase && !overwriteReplanIsConsistent(shown.details, replanned.details, nextOverwriteKeys, changing)) {
            basePlanStaleRef.current = true;
            const peerLabel = peers.find((peer) => peer.id === peerId)?.label ?? t("the live site");
            setOverwriteMismatch(`${peerLabel} ${t("changed while you were deciding. Check the list again.")}`);
          }
          setPhase((current) => (current.kind === "planned" ? { kind: "planned", plan: replanned } : current));
        } catch (error) {
          if (!live.current || planPeerRef.current !== peerId || overwriteKeysRef.current !== nextOverwriteKeys) return;
          setReplanPending(false);
          setPhase({ kind: "failed", message: messageOf(error, t("Could not work out what would be published.")), code: null });
        }
      })();
    },
    [peers, phase, planInScope, setReplanPending, t]
  );

  const onToggleOverwrite = useCallback(
    (key: string): void => {
      const next = new Set(overwriteKeysRef.current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      applyOverwriteKeys(next);
    },
    [applyOverwriteKeys]
  );

  // The connect action behind the empty state — `destination.ts`'s header explains why it lives
  // here rather than on a settings screen. Success folds the newly connected site straight into
  // `peers`/`selectedPeerId` and moves on to planning immediately: the operator asked to publish,
  // not to "connect", so the one extra click stays inside the same flow rather than landing back on
  // a now-idle dialog they'd have to press Publish on again.
  const onConnect = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    setDestinationError(null);
    try {
      const view = await port.connectDestination();
      if (!live.current) return;
      if (view.site === null) {
        // Contract violation, not a user-facing failure mode: `destination.ts`'s `/connect` always
        // returns a site on success. Guarded rather than assumed so a server regression here shows
        // up as a sentence instead of a crash.
        setDestinationError(t("Could not connect."));
        setConnecting(false);
        return;
      }
      const { site } = view;
      setPeers([site]);
      setSelectedPeerId(site.id);
      setConnecting(false);
      void requestPlan(site.id);
    } catch (error) {
      if (!live.current) return;
      setDestinationError(messageOf(error, t("Could not connect.")));
      setConnecting(false);
    }
  }, [connecting, port, requestPlan, t]);

  /**
   * Confirms the plan on screen — and, when the operator unchecked rows, RE-PLANS first against a
   * bundle narrowed to what is still checked, then confirms THAT plan.
   *
   * The re-plan is what makes a deselection real. A confirmation token is bound to one plan hash, and
   * the destination applies the bundle it planned — so the only way to publish a subset is to give
   * the destination that subset to plan in the first place (`export-bundle.ts`'s
   * `selectBundleEntities`, via `push/plan`'s `selectedEntityKeys`). The alternative, carrying a
   * selection into execute for the apply loop to honour, would put the operator's exclusion behind a
   * flag a destination running an older build would silently ignore and publish everything anyway.
   *
   * A narrowed re-plan that turns out to write nothing lands back on `planned` with the narrowed
   * rows showing rather than confirming a run that would burn a restore point to do nothing.
   */
  const confirmPlan = useCallback(async () => {
    const peerId = planPeerRef.current;
    if (!isChosenPeerId(peerId) || phase.kind !== "planned" || !canConfirmPlan(phase)) return;
    // The plan on screen is not yet the one the operator's latest tick describes.
    if (overwriteReplanPendingRef.current) return;
    const { plan } = phase;
    const planRows = toPublishReportRows(plan.details);
    const selectable = selectableRowKeys(planRows);
    const keep = selectable.filter((key) => !deselectedKeys.has(key));
    if (keep.length === 0) return;
    // A carried-along media row is never selectable, so it is never in `keep` — but it still publishes
    // while a page/post using it is kept, and the narrowed re-plan carries it again. Its "Overwrite on
    // live" tick must survive with it, or that page publishes against the old live image.
    const keepSet = new Set(keep);
    const carriedKept = planRows.filter((row) => row.includedFor.length > 0 && rowPublishesWithSelection(row, keepSet)).map((row) => row.key);
    setPhase({ kind: "confirming", plan });
    try {
      const confirmed =
        keep.length === selectable.length
          ? plan
          : // Carries `plan.overwriteEntityKeys` (already echoed onto `plan` by any ticking re-plan)
            // into this narrowing re-plan too — deselecting an unrelated row must never silently
            // drop an "Overwrite on live" tick. A ticked row the operator ALSO unchecked is not in
            // `keep`, so its key is dropped here: an overwrite of something not being published
            // would only ask live to force a row the bundle doesn't carry.
            await planInScope({
              peerId,
              selectedEntityKeys: keep,
              ...overwriteKeysWithin(plan.overwriteEntityKeys, [...keep, ...carriedKept]),
            });
      if (!live.current) return;
      if (!canConfirmPlan({ kind: "planned", plan: confirmed })) {
        setPhase({ kind: "planned", plan: confirmed });
        return;
      }
      const { confirmationToken } = await port.confirmPublish({
        peerId,
        planId: confirmed.planId,
        planHash: confirmed.planHash,
      });
      if (!live.current) return;
      setPhase({ kind: "confirmed", plan: confirmed, confirmationToken });
    } catch (error) {
      if (!live.current) return;
      setPhase({ kind: "failed", message: messageOf(error, t("Could not publish.")), code: null });
    }
  }, [deselectedKeys, phase, planInScope, port, t]);

  // The ONLY call site of `port.executePublish` in this package. Its input is whatever
  // `confirmationTokenFor` returns, which is `null` for every phase but `confirmed`/`executing` —
  // see this file's header for why the guard is shaped this way rather than as an inline check.
  const executionToken = confirmationTokenFor(phase);
  useEffect(() => {
    const peerId = planPeerRef.current;
    if (executionToken === null || phase.kind !== "confirmed" || !isChosenPeerId(peerId)) return;
    const { plan } = phase;
    setPhase({ kind: "executing", plan, confirmationToken: executionToken });
    void (async () => {
      try {
        // `plan.bundleId` travels from the plan response into the execute call — the peer refuses a
        // token presented against any bundle but the one it planned. `plan.overwriteEntityKeys` is
        // the CONFIRMED plan's own echoed value (S9) — never re-read from operator state here, so
        // execute can only ever force the exact set the confirmation token was issued for.
        const result = await port.executePublish({
          peerId,
          bundleId: plan.bundleId,
          confirmationToken: executionToken,
          ...(plan.overwriteEntityKeys && plan.overwriteEntityKeys.length > 0
            ? { overwriteEntityKeys: plan.overwriteEntityKeys }
            : {}),
        });
        if (!live.current) return;
        setPhase({ kind: "done", result });
      } catch (error) {
        if (!live.current) return;
        setPhase({ kind: "failed", message: messageOf(error, t("Could not publish.")), code: null });
      }
    })();
  }, [executionToken, phase, port, t]);

  // The report stays on screen through confirm and execute — `planOnScreen` owns which phases have
  // one, so this file never has to re-enumerate them (and cannot get `planning`, which has no plan
  // yet, wrong).
  const visiblePlan = planOnScreen(phase);
  const rows = visiblePlan === null ? EMPTY_ROWS : toPublishReportRows(visiblePlan.details);
  const summary = visiblePlan === null ? null : summarizePublishReport(rows);
  const liveGapNotices = liveGapLinesFor(visiblePlan?.notSupportedByLive, t);

  // Derived every render rather than stored: `deselectedKeys` is the only state, so these can never
  // disagree with it or with the rows currently on screen.
  const selectableKeys = selectableRowKeys(rows);
  const selectedKeys: ReadonlySet<string> = new Set(selectableKeys.filter((key) => !deselectedKeys.has(key)));
  const selectedPublishing = countSelectedPublishing(rows, selectedKeys);
  const carriedAlongKeys: ReadonlySet<string> = new Set(
    rows.filter((row) => row.includedFor.length > 0 && rowPublishesWithSelection(row, selectedKeys)).map((row) => row.key)
  );
  const allSelected = selectableKeys.length > 0 && selectedKeys.size === selectableKeys.length;
  const someSelected = selectedKeys.size > 0 && !allSelected;

  // publish-overwrite-live-plan §4/S9. `true` with no plan on screen is harmless: `overwritableRows`
  // is empty then too, so nothing reads this as "go ahead and offer a box".
  const liveCanOverwrite = visiblePlan?.liveCanOverwrite ?? true;
  const overwritableRows = rows.filter((row) => row.overwritable);
  // A ticked row keeps its box: once its re-plan lands it is `forced`, no longer `overwritable`, and
  // dropping the box then would leave a tick the operator can neither see nor undo — and, for the
  // only such row, take the whole column (and its header box) with it.
  const overwriteOfferKeys: ReadonlySet<string> = new Set(
    rows.filter((row) => row.overwritable || overwriteKeys.has(row.key)).map((row) => row.key)
  );
  const showOverwriteColumn = liveCanOverwrite && overwriteOfferKeys.size > 0;
  const allOverwriteTicked = overwriteOfferKeys.size > 0 && [...overwriteOfferKeys].every((key) => overwriteKeys.has(key));
  const someOverwriteTicked = overwriteKeys.size > 0 && !allOverwriteTicked;
  // Ticks every offered row — earlier ticks included — or clears them all when every one already is.
  const onToggleAllOverwrite = (): void => {
    applyOverwriteKeys(allOverwriteTicked ? new Set() : new Set(overwriteOfferKeys));
  };
  const currentPeerLabel = peers.find((peer) => peer.id === selectedPeerId)?.label ?? t("the live site");

  // --- S2 (publish-criteria-tool-webmcp-plan-2026-09-24.md §4) — applying `props.criteria` as the
  // dialog's STARTING selection, for a caller with no button of its own to click. Three refs, because
  // this happens at most once per mount and each step waits on the one before it settling:
  //   1. `criteriaAutoPlanRef` — plans automatically once a site is resolved, standing in for the
  //      click a person would otherwise make first (planning writes nothing, so this is safe to do
  //      unprompted — the gate in plan §3 is about confirm/execute, never about a read-only plan).
  //   2. `criteriaAppliedRef` — applies the criteria's selection/overwrite ticks against that FIRST
  //      plan and only that one; a later re-plan (a peer switch, a hand tick) is left alone.
  //   3. `criteriaAwaitingReplanRef` — set only when the criteria ticked something, so `onPlanned`
  //      waits for that re-plan's real `forced` rows instead of reporting the pre-overwrite skips.
  const criteriaAutoPlanRef = useRef(false);
  const criteriaAppliedRef = useRef(false);
  const criteriaSelectionRef = useRef<CriteriaSelection | null>(null);
  const criteriaAwaitingReplanRef = useRef(false);

  useEffect(() => {
    if (props.criteria === undefined || criteriaAutoPlanRef.current) return;
    if (phase.kind !== "idle" || !isChosenPeerId(selectedPeerId)) return;
    criteriaAutoPlanRef.current = true;
    void requestPlan(selectedPeerId);
  }, [props.criteria, selectedPeerId, phase, requestPlan]);

  useEffect(() => {
    if (props.criteria === undefined || criteriaAppliedRef.current || phase.kind !== "planned") return;
    criteriaAppliedRef.current = true;
    const sel = applyPublishCriteria(toPublishReportRows(phase.plan.details), props.criteria);
    criteriaSelectionRef.current = sel;
    setDeselectedKeys(sel.deselectedKeys);
    if (sel.overwriteKeys.size > 0) {
      criteriaAwaitingReplanRef.current = true;
      applyOverwriteKeys(sel.overwriteKeys);
    }
    // `applyOverwriteKeys`/`props.criteria` deliberately excluded: this must run against the render
    // where `phase` FIRST becomes "planned" (so `applyOverwriteKeys`'s own `phase.kind==="planned"`
    // guard is current, not stale — see this block's own header), and it self-guards with the ref
    // against ever running a second time regardless of what else changes identity around it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    const sel = criteriaSelectionRef.current;
    if (sel === null || phase.kind !== "planned" || props.onPlanned === undefined) return;
    if (criteriaAwaitingReplanRef.current) {
      // The real (not stale-closure) current value — see this file's header on why `requestPlan`
      // can't read `phase` this way but a ref always can.
      if (overwriteReplanPendingRef.current) return;
      criteriaAwaitingReplanRef.current = false;
    }
    criteriaSelectionRef.current = null;
    const siteLabel = peers.find((peer) => peer.id === selectedPeerId)?.label ?? null;
    props.onPlanned(buildCriteriaPublishResult(rows, sel, siteLabel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, rows]);

  const overwriteWarning =
    liveCanOverwrite && overwriteKeys.size > 0
      ? t("Ticked items will replace what's on the live site, and stay recoverable in its Trash or history.")
      : null;

  // Shown only when the peer itself can't honour the overwrite AND there is something it would
  // otherwise have offered — an older live with a plain unchanged/created/applied report says nothing
  // extra here.
  const overwriteUnavailable =
    !liveCanOverwrite && overwritableRows.length > 0
      ? `${currentPeerLabel} ${t("is on an older Tovu and can't overwrite these yet. Update it, then publish again.")}`
      : null;

  // `null` until BOTH the peer list came back empty and the destination check that follows it has
  // resolved — so the dialog never flashes a stale "add one in Settings" sentence, and never shows
  // the connect offer a beat before it has anything real to say.
  const connectOffer: PublishContentConnectOffer | null =
    peersLoaded && peers.length === 0 && peersError === null && destinationLoaded && destination !== null
      ? { message: destination.message, candidateUrl: destination.candidateUrl }
      : null;

  // Checkboxes are an offer, and the offer closes the moment the operator commits: `planned` is the
  // only phase where changing the selection could still change what gets published.
  const selectionEnabled = phase.kind === "planned";

  const onToggleRow = (key: string): void => {
    setDeselectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // "Any checked -> uncheck everything", so the header is an escape hatch from a big plan rather
  // than a toggle whose meaning flips at an invisible halfway point.
  const onToggleAll = (): void => {
    setDeselectedKeys(selectedKeys.size > 0 ? new Set(selectableKeys) : new Set());
  };

  const peerSelectionEnabled = peerSelectionOpen(phase);
  const onSelectPeer = (peerId: string): void => {
    // The picker's blank "Choose a site…" option fires this with `""` (its `value`) — normalized to
    // `null` here so `selectedPeerId` can never hold it, the same "nothing chosen" state a fresh
    // dialog starts in. This is the fix, not just a defense: every downstream guard reads
    // `selectedPeerId`/`planPeerRef` off THIS state, so keeping it out from the start is what makes
    // `isChosenPeerId`'s other call sites redundant-but-safe rather than load-bearing on their own.
    const normalized = peerId === "" ? null : peerId;
    if (!peerSelectionEnabled || normalized === selectedPeerId) return;
    setSelectedPeerId(normalized);
    // The report on screen, and the rows unchecked in it, describe the site being left.
    planPeerRef.current = null;
    setPhase({ kind: "idle" });
    setDeselectedKeys(new Set());
    basePlanRef.current = null;
    basePlanStaleRef.current = false;
    setReplanPending(false);
    overwriteKeysRef.current = new Set();
    setOverwriteKeys(new Set());
    setOverwriteMismatch(null);
  };

  const canStart = canRequestPlan(phase) && isChosenPeerId(selectedPeerId);
  const runPrimary = useCallback((): Promise<void> => {
    if (connectOffer) return onConnect();
    if (!canRequestPlan(phase)) return confirmPlan();
    return isChosenPeerId(selectedPeerId) ? requestPlan(selectedPeerId) : Promise.resolve();
  }, [confirmPlan, connectOffer, onConnect, phase, requestPlan, selectedPeerId]);

  // Synchronous duplicate-submit guard (terra review 2026-09-20, finding 5's sibling). The button's
  // `disabled` is render-time phase; two calls in one tick both see `planned`, and each confirmed
  // phase would fire its own execute at the live site. Held until the step's own request settles.
  const primaryInFlightRef = useRef(false);
  const onPrimary = useCallback(() => {
    if (primaryInFlightRef.current) return;
    primaryInFlightRef.current = true;
    void runPrimary().finally(() => {
      primaryInFlightRef.current = false;
    });
  }, [runPrimary]);

  return {
    phase,
    peers,
    selectedPeerId,
    onSelectPeer,
    peerSelectionEnabled,
    dismissible,
    onDismiss,
    rows,
    summary,
    selectedKeys,
    carriedAlongKeys,
    onToggleRow,
    onToggleAll,
    selectionEnabled,
    allSelected,
    someSelected,
    liveCanOverwrite,
    overwriteKeys,
    overwriteOfferKeys,
    showOverwriteColumn,
    onToggleOverwrite,
    onToggleAllOverwrite,
    allOverwriteTicked,
    someOverwriteTicked,
    overwriteWarning,
    overwriteMismatch,
    overwriteUnavailable,
    title: publishScopeTitleKey(props.scope),
    description: publishScopeDescriptionKey(props.scope),
    primaryLabel: primaryLabelFor(
      phase,
      selectedPublishing,
      connectOffer,
      connecting,
      t,
      props.scope,
      rows.length === 0 && liveGapNotices.length > 0
    ),
    primaryDisabled: connectOffer
      ? connecting || connectOffer.candidateUrl === null
      : // `selectedPublishing` is ANDed with the plan-level rule, never a replacement for it: a plan
        // that may not be confirmed at all stays disabled whatever is checked, and a confirmable
        // plan with everything unchecked is disabled too — the button never promises a run that
        // would write nothing.
        !(canStart || (canConfirmPlan(phase) && selectedPublishing > 0 && !overwriteReplanPending)),
    onPrimary,
    errorMessage: peersError ?? destinationError ?? (phase.kind === "failed" ? phase.message : null),
    refusalReason: phase.kind === "planned" && phase.plan.details.refused ? phase.plan.details.refusalReason : null,
    doneMessage: doneMessageFor(phase, t),
    // De-duplicated: a grant that doesn't cover menus refuses every menu with the same line.
    doneNotices: phase.kind === "done" ? [...new Set(phase.result.menuLinksNotUpdated ?? [])] : [],
    liveGapNotices,
    connectOffer,
  };
}
