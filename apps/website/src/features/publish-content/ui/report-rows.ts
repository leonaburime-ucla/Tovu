import type { PublishContentOutcomeRow, PublishContentReport } from "./contract.js";

/**
 * @file Task 11 — turning a `PublishContentReport` into the rows the Publish Content dialog
 * renders, and the counts its primary button is labelled with.
 *
 * ## The one property this file is responsible for
 *
 * Plan §4 task 11: *a conflict row renders its reason and is not selectable for silent apply.*
 *
 * **2026-09-19 (owner-directed): rows a run WOULD write are now selectable; rows it would not are
 * still not.** {@link PublishReportRow.selectable} is derived from the disposition map below and
 * from nothing else, so only `publish` rows can ever carry a checkbox — an `unchanged` or `skipped`
 * row renders no control at all (not a disabled one), which keeps the original property exactly as
 * stated: there is no affordance anywhere in the dialog that could move a skipped row into the set
 * the run writes.
 *
 * Deselection is still **exclusion by construction**, not an apply-time flag: deselecting rows makes
 * the dialog re-plan against a bundle containing only the selected entities (`export-bundle.ts`'s
 * `selectBundleEntities`, reached through `push/plan`'s `selectedEntityKeys`), so a deselected entity
 * is never staged on the destination at all and no code path downstream has to remember to skip it.
 * `forced` (plan §4's seventh outcome, the operator explicitly choosing a conflicted row) is a
 * different feature and still unbuilt; when it lands it lands here, next to `publishRowDisposition`,
 * not as a second copy in `apps/admin`.
 *
 * `appliesOnExecute` is read straight off the planner's own `writes` flag rather than re-derived
 * from `outcome`, so this file cannot disagree with `planner.ts` about what a run does.
 */

/**
 * What the dialog says will happen to one entity.
 *
 * - `publish` — the run writes this row.
 * - `unchanged` — the destination already matches; nothing happens, and that is the expected case.
 * - `skipped` — the run deliberately does not touch this row, and owes the operator a reason.
 */
export type PublishRowDisposition = "publish" | "unchanged" | "skipped";

/** One rendered report row. `key` is stable across re-plans, so React can keep row identity, and it
 *  is byte-identical to `planner.ts`'s own `entityKey(type, id)` — the string a selection is sent
 *  back to the server as. */
export interface PublishReportRow {
  readonly key: string;
  readonly entityType: string;
  /** What the TYPE column reads — a short plain word for every registered handler
   *  ({@link ENTITY_TYPE_LABEL}), or {@link entityType} itself for one this file has not seen yet
   *  (degraded, never blank, same fallback shape as {@link entityLabel}'s own short-id floor). */
  readonly entityTypeLabel: string;
  readonly entityId: string;
  /** Always renderable, never blank: the planner's `entityLabel` when the entity had one, otherwise
   *  a {@link SHORT_ID_LENGTH}-character prefix of the id. A full uuid is never a display value —
   *  the whole column was unreadable while it was one. */
  readonly entityLabel: string;
  /** Whether this row may be deselected before publishing. True for `publish` rows ONLY — an
   *  `unchanged` or `skipped` row is a statement, not an action, and gets no control at all. */
  readonly selectable: boolean;
  readonly outcome: PublishContentOutcomeRow["outcome"];
  readonly disposition: PublishRowDisposition;
  readonly dispositionLabel: string;
  /** Never `null` for a `skipped` row — see {@link MISSING_REASON}. Rewritten for a non-technical
   *  owner by {@link friendlyPublishReason} before it ever reaches this shape; the planner's own raw
   *  wording (ids, "peer", "baseline") never renders. */
  readonly reason: string | null;
  /** The planner's own `writes` flag, carried through unmodified. */
  readonly appliesOnExecute: boolean;
  /**
   * publish-overwrite-live-plan §4/S9 — whether this row may render the "Overwrite on live"
   * checkbox. `true` only for a `skipped` row whose planner `canOverwrite` is `true`: a row the run
   * already writes (an ordinary `publish` disposition, including an already-forced conflict) never
   * gets a SECOND control offering to do the same thing again, and an `unchanged` row has nothing to
   * overwrite. Ticking one re-plans with `overwriteEntityKeys` (`use-publish-content-confirm.hooks.ts`),
   * which is what turns this same row `forced` and moves it out of `skipped` on the next render — the
   * checkbox is never itself what publishes anything.
   */
  readonly overwritable: boolean;
  /** The live row an overwrite of this entity would retire, named for the dialog — the planner's own
   *  `retires.entityLabel`, falling back to a short id the same way {@link entityLabel} does. `null`
   *  when this row retires nothing (every outcome but a resolvable slug clash). */
  readonly retiresLabel: string | null;
  /**
   * `plan-publish-repoint-menus-2026-09-24.md` §2.2/R6 — the live entities (e.g. menus) that still
   * link to this row's {@link retires} holder, named for the dialog the same way {@link retiresLabel}
   * is — the planner's own `referencedBy[].entityLabel`, falling back to a short id. Empty for every
   * row that retires nothing, and for a retire target with no live references at all.
   */
  readonly referencedByLabels: readonly string[];
  /**
   * Owner decision 2026-09-25 — the `entityKey`s of the in-scope pages/posts a carried-along media
   * row was brought along for (`PublishContentOutcomeRowDto.includedFor`). Empty for every other row.
   * A non-empty list makes the row pre-ticked and untickable: never {@link selectable}, but counted as
   * publishing while any of these keys is still ticked ({@link countSelectedPublishing}).
   */
  readonly includedFor: readonly string[];
  /** The dialog's note for a carried-along row — see {@link usedByNoteFor}. `null` on every other
   *  row. English source text; the dialog translates it. */
  readonly usedByNote: string | null;
}

/** What the counts under the table add up to. */
export interface PublishReportSummary {
  readonly total: number;
  readonly publishing: number;
  readonly unchanged: number;
  readonly skipped: number;
}

/**
 * Stand-in for a `skipped` row whose planner reason is `null`. A skip with a blank cell reads as a
 * rendering bug and leaves the operator with no way to act; a sentence that says the reason is
 * missing is at least honest about which of the two it is.
 */
const MISSING_REASON = "No reason recorded.";

/** The one reason prefix that is already final, operator-facing copy — `file-tree-policy.ts`'s
 *  {@link import("../file-tree-policy.js").wrapTreePolicyReason}. {@link friendlyPublishReason}
 *  must never rewrite it a second time. */
const ALREADY_FINAL_PREFIX = "Can't publish:";

/**
 * One raw-reason pattern this dialog is known to receive, and the owner-facing sentence it becomes.
 * Order matters: {@link friendlyPublishReason} returns the first match, so a narrower pattern (e.g.
 * the two conflict wordings) is listed before anything broader it could also satisfy.
 */
interface ReasonRewrite {
  readonly pattern: RegExp;
  readonly friendly: string;
}

/**
 * The closed set of reason strings `planner.ts` and its registered handlers (`post`, `media`,
 * `redirects`, `navigation`, `theme`) can currently produce for a `skipped` or `forced` row, each
 * paired with the plain sentence a non-technical owner should read instead. Every raw string here is
 * quoted verbatim (minus the interpolated id/type) from where it is thrown, so this list is the
 * traceable map from "what the code says" to "what the dialog shows" — updating a handler's wording
 * means updating the matching pattern here, not guessing at a new regex blind.
 *
 * publish-content-copy-2026-09-25.md — every entry drops ids, "peer", "baseline" and "entity", and
 * names the available action ("tick Overwrite") only where the row that carries the reason actually
 * offers that control ({@link PublishReportRow.overwritable}).
 */
const REASON_REWRITES: readonly ReasonRewrite[] = [
  {
    pattern: /^no registered publish-content handler for entity type/,
    friendly: "This kind of content can't be published from here yet.",
  },
  {
    // Owner decision 2026-09-25: a push plans ON the live site, so "this instance"/"this destination"
    // in the raw text is LIVE — and the push driver uploads every required file before planning, so
    // a file still absent there is one this site could not send. The old "hasn't finished syncing
    // here yet" named the wrong side.
    pattern: /^required blob '.+' is not available/,
    friendly: "A file this item needs is missing on the live site, and couldn't be sent from here.",
  },
  // planner.ts's two conflict wordings (baseline recorded vs. none) — same cause to the operator
  // ("this destination row doesn't match what we agreed on last"), same action either way.
  {
    pattern: /has been edited on the destination since the last sync with this peer/,
    friendly: "Different version already on the live site. Tick Overwrite to replace it.",
  },
  {
    pattern: /no prior sync baseline for .+ with this peer — the destination already holds different content/,
    friendly: "Different version already on the live site. Tick Overwrite to replace it.",
  },
  {
    // `menu slug '...'` (navigation), bare `slug '...'` (post/media), and the factory's other
    // addresses (`name '...'` for taxonomy/term).
    pattern: /^(?:menu )?(?:slug|name|key) '.+' is already held by a different [\w-]+/,
    friendly: "Another item on the live site already uses this name.",
  },
  {
    // post.ts words it `<type> '<id>' is in the trash ...` — the type prefix is part of the real text,
    // and hyphenated for factory types (`collection-entry`, `content-type`).
    pattern: /^(?:[\w-]+ )?'.+' is in the trash at this destination/,
    friendly: "This item is in the trash on the live site. Restore it there before publishing.",
  },
  {
    pattern: /^'.+' is a '.+' at this destination but a '.+' at the source/,
    friendly: "This item's type doesn't match the live site's version, so it can't be published over it.",
  },
  {
    pattern: /has no usable slug to check for a collision/,
    friendly: "This item has no name set, so it can't be checked against the live site.",
  },
  {
    pattern: /cannot be prechecked — no \w+ wired for this deps bag/,
    friendly: "Publishing isn't available for this item right now.",
  },
  {
    pattern: /has a malformed natural key/,
    friendly: "This item's data is incomplete and can't be published.",
  },
  {
    pattern: /is not a valid theme tree address/,
    friendly: "This theme's files aren't in a valid location.",
  },
  {
    pattern: /this site has no themes folder/,
    friendly: "This site doesn't have a themes folder set up.",
  },
  {
    pattern: /themes folder spans two disks/,
    friendly: "The site's themes folder isn't set up correctly.",
  },
];

/** Matches `file-tree-policy.ts`'s generic `"<title> was not published: <detail>"` wrapping — every
 *  `checkTreeFiles` reason this module has no specific rewrite for yet (a path-shape or deny-list
 *  detail, all of which name a raw relative path). Kept last and generic on purpose: the title is
 *  real information ("Theme: static/basic") worth keeping, the raw path/segment detail after the
 *  colon is not. */
const GENERIC_TREE_WRAP_PATTERN = /^(.+) was not published: .+$/;

/**
 * Owner decision 2026-09-25 — a tree refusal that is about ONE file names that file, the way
 * `file-tree-policy.ts`'s already-final video reason does, instead of the generic "one of its files
 * isn't allowed". Each pattern matches a `wrapTreePolicyReason`-wrapped `checkTreeFiles`/
 * `checkTreePath` detail, quoted from that module, and captures the offending path; only the file's
 * own name is shown. The secret scan's pattern name (and so anything about what matched) is dropped.
 */
interface NamedFileRewrite {
  readonly pattern: RegExp;
  readonly friendly: (fileName: string) => string;
}

const TOO_LARGE = (name: string): string => `Can't publish: a file is too large (${name})`;
const LOOKS_SECRET = (name: string): string => `Can't publish: a file looks like it contains a key or password (${name})`;

const NAMED_FILE_REWRITES: readonly NamedFileRewrite[] = [
  { pattern: /^.+ was not published: "(.+)" is \d+ bytes, larger than the \d+-byte per-file limit$/, friendly: TOO_LARGE },
  {
    pattern:
      /^.+ was not published: "(.+)" (?:looks like it holds a key \(.+\)|looks like an environment file|is a package-manager credential file|is an MCP server configuration file, which can hold secrets|looks like a private SSH key|has a '\.(?:pem|key|p12|pfx)' extension, which is never published)$/,
    friendly: LOOKS_SECRET,
  },
];

/**
 * Rewrites one raw planner/handler reason into the sentence the dialog shows an owner — terse, free
 * of ids and sync-protocol terms ("baseline", "peer", "entity"), and naming the action when the
 * matched cause has one. `file-tree-policy.ts`'s own `"Can't publish: ..."` sentinel is already
 * exactly this (that module's header explains why it alone gets to skip the title wrapper) and is
 * returned unchanged rather than double-translated.
 *
 * Anything matching none of {@link REASON_REWRITES}, {@link NAMED_FILE_REWRITES} or {@link GENERIC_TREE_WRAP_PATTERN} — a future
 * handler's wording this file has not seen yet, or a test fixture that is not real handler text —
 * passes through unchanged rather than being mangled by a guess.
 *
 * @complexity O(1) — a fixed, small number of regex tests against one string.
 */
export function friendlyPublishReason(reason: string): string {
  if (reason.startsWith(ALREADY_FINAL_PREFIX)) return reason;
  for (const { pattern, friendly } of REASON_REWRITES) {
    if (pattern.test(reason)) return friendly;
  }
  for (const { pattern, friendly } of NAMED_FILE_REWRITES) {
    const path = reason.match(pattern)?.[1];
    if (path !== undefined) return friendly(path.slice(path.lastIndexOf("/") + 1));
  }
  const wrapped = reason.match(GENERIC_TREE_WRAP_PATTERN);
  if (wrapped) return `${wrapped[1]} can't be published — one of its files isn't allowed.`;
  return reason;
}

/** How much of an id to show when an entity has no human identifier at all. Eight hex characters is
 *  the git-short-sha convention and stays unique enough to tell two rows apart on one screen, which
 *  is the only job left for an id once the label column is doing the naming. */
const SHORT_ID_LENGTH = 8;

/**
 * The shared fallback behind both {@link displayLabelFor} and {@link retiresLabelFor}: prefer a real
 * label, fall back to a short id prefix, never the full uuid.
 *
 * @complexity O(1).
 */
function labelOrShortId(label: string | null | undefined, id: string): string {
  if (label !== null && label !== undefined && label.trim().length > 0) return label;
  return id.slice(0, SHORT_ID_LENGTH);
}

/**
 * What to print in the entity column. Prefers the planner's own label; falls back to a short id
 * prefix, never the full uuid (`?? null` covers an older peer whose report predates the field).
 *
 * @complexity O(1).
 */
function displayLabelFor(row: PublishContentOutcomeRow): string {
  return labelOrShortId(row.entityLabel, row.entityId);
}

/**
 * What the dialog names the live row an overwrite would retire, or `null` when this row retires
 * nothing. Same fallback as {@link displayLabelFor} — a `RetireTarget` carries its own
 * `entityLabel`/`entityId` pair, not the row's.
 *
 * @complexity O(1).
 */
function retiresLabelFor(row: PublishContentOutcomeRow): string | null {
  const target = row.retires ?? null;
  if (target === null) return null;
  return labelOrShortId(target.entityLabel, target.entityId);
}

/**
 * What the dialog names every live holder still linking to this row's retire target — empty when the
 * row retires nothing, or when nothing live references it. Same fallback as {@link displayLabelFor}
 * and {@link retiresLabelFor}, applied per holder.
 *
 * @complexity O(h) in the row's holder count.
 */
function referencedByLabelsFor(row: PublishContentOutcomeRow): readonly string[] {
  const holders = row.referencedBy ?? [];
  return holders.map((holder) => labelOrShortId(holder.entityLabel, holder.entityId));
}

/**
 * The note a carried-along media row shows, named by the types of the pages/posts that use it.
 *
 * @complexity O(k) in the referrer count.
 */
function usedByNoteFor(includedFor: readonly string[]): string | null {
  if (includedFor.length === 0) return null;
  const types = new Set(includedFor.map((key) => key.slice(0, key.indexOf(":"))));
  if (types.has("page") && types.has("post")) return "Used by these pages and posts";
  return types.has("post") ? "Used by these posts" : "Used by these pages";
}

/** The registered `PublishContentHandler.entityType` ids, named for an owner rather than a
 *  developer — `"theme-files"` reads "Theme" (the plan-time tier/id split is an implementation
 *  detail no operator needs), every other id already has an obvious plain form. A type not listed
 *  here (a future handler this file has not seen yet) falls back to its own raw id in
 *  {@link entityTypeLabelFor} rather than failing — degraded, never wrong. */
const ENTITY_TYPE_LABEL: Readonly<Record<string, string>> = {
  post: "Post",
  page: "Page",
  media: "Media",
  menu: "Menu",
  redirect: "Redirect",
  "theme-files": "Theme",
};

/** @complexity O(1). */
function entityTypeLabelFor(entityType: string): string {
  return ENTITY_TYPE_LABEL[entityType] ?? entityType;
}

const DISPOSITION_BY_OUTCOME: Readonly<Record<PublishContentOutcomeRow["outcome"], PublishRowDisposition>> = {
  created: "publish",
  applied: "publish",
  forced: "publish",
  unchanged: "unchanged",
  conflict: "skipped",
  blocked: "skipped",
};

/** Terse, operator-facing, and specific about *why* — "Skipped" alone sends someone hunting. */
const LABEL_BY_OUTCOME: Readonly<Record<PublishContentOutcomeRow["outcome"], string>> = {
  created: "Will publish — new",
  applied: "Will publish — update",
  forced: "Will publish — overwrite",
  unchanged: "Already up to date",
  conflict: "Skipped",
  blocked: "Skipped",
};

/**
 * Whether the run writes this row, stated as a disposition rather than a boolean so the table can
 * distinguish "nothing to do" from "deliberately not done".
 *
 * @complexity O(1).
 */
export function publishRowDisposition(row: PublishContentOutcomeRow): PublishRowDisposition {
  return DISPOSITION_BY_OUTCOME[row.outcome];
}

/**
 * Shapes a report for rendering. A refused report has no rows by construction (`planner.ts`), so
 * this returns an empty list for one rather than inventing a placeholder — the dialog renders the
 * refusal reason on its own.
 *
 * @complexity O(n) in the report's row count, single pass, no sorting: the planner already emits
 * rows in `dependsOn` apply order and re-sorting here would hide that ordering from the operator.
 */
export function toPublishReportRows(report: PublishContentReport): readonly PublishReportRow[] {
  if (report.refused) return [];
  return report.rows.map((row) => {
    const disposition = publishRowDisposition(row);
    const rawReason = disposition === "skipped" ? (row.reason ?? MISSING_REASON) : row.reason;
    const includedFor = row.includedFor ?? [];
    return {
      key: `${row.entityType}:${row.entityId}`,
      entityType: row.entityType,
      entityTypeLabel: entityTypeLabelFor(row.entityType),
      entityId: row.entityId,
      entityLabel: displayLabelFor(row),
      selectable: disposition === "publish" && includedFor.length === 0,
      outcome: row.outcome,
      disposition,
      dispositionLabel: LABEL_BY_OUTCOME[row.outcome],
      reason: rawReason === null ? null : friendlyPublishReason(rawReason),
      appliesOnExecute: row.writes,
      overwritable: disposition === "skipped" && row.canOverwrite === true,
      retiresLabel: retiresLabelFor(row),
      referencedByLabels: referencedByLabelsFor(row),
      includedFor,
      usedByNote: usedByNoteFor(includedFor),
    };
  });
}

/**
 * The counts the dialog's primary button and summary line read from.
 *
 * `publishing` counts rows by disposition, not by `appliesOnExecute`: the two agree for every
 * outcome the planner produces, and disagreeing would mean the table said one thing and the button
 * said another. `report-rows.test.ts` pins them together.
 *
 * @complexity O(n), single pass.
 */
export function summarizePublishReport(rows: readonly PublishReportRow[]): PublishReportSummary {
  let publishing = 0;
  let unchanged = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.disposition === "publish") publishing += 1;
    else if (row.disposition === "unchanged") unchanged += 1;
    else skipped += 1;
  }
  return { total: rows.length, publishing, unchanged, skipped };
}

/**
 * Every row key the operator is allowed to deselect — the dialog's initial "everything is checked"
 * state, its header checkbox's whole reach, and the yardstick for "is this a strict subset?".
 *
 * Exported rather than left as a filter at the call site so all three of those reads apply the same
 * {@link PublishReportRow.selectable} rule; a fourth that spelled it `disposition === "publish"`
 * itself would silently disagree the day a new outcome lands.
 *
 * @complexity O(n), single pass.
 */
export function selectableRowKeys(rows: readonly PublishReportRow[]): readonly string[] {
  return rows.filter((row) => row.selectable).map((row) => row.key);
}

/**
 * Whether this row publishes given the operator's current selection: a selectable row when it is
 * ticked, a carried-along row ({@link PublishReportRow.includedFor}) while any page/post that uses it
 * is ticked — the same rule `push/plan`'s narrowed re-plan applies when it re-derives what to carry.
 *
 * @complexity O(k) in the row's referrer count.
 */
export function rowPublishesWithSelection(row: PublishReportRow, selected: ReadonlySet<string>): boolean {
  if (row.selectable) return selected.has(row.key);
  return row.disposition === "publish" && row.includedFor.some((key) => selected.has(key));
}

/**
 * How many rows this run would actually write given the operator's current selection — the number
 * the primary button commits to out loud.
 *
 * Counts the INTERSECTION rather than `selected.size`: a key left over from a previous plan, or one
 * naming a row that is no longer selectable, must not inflate the promise on the button. A
 * carried-along row counts through {@link rowPublishesWithSelection}.
 *
 * @complexity O(n·k), single pass; `k` is a carried-along row's referrer count.
 */
export function countSelectedPublishing(rows: readonly PublishReportRow[], selected: ReadonlySet<string>): number {
  let count = 0;
  for (const row of rows) if (rowPublishesWithSelection(row, selected)) count += 1;
  return count;
}
