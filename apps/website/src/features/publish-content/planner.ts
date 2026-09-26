import { CONTENT_HASH_VERSION } from "./content-hash.js";
import { PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION } from "./artifact-format.js";
import { buildPublishContentCatalog } from "./type-registry.js";
import type {
  PublishContentDeps,
  PublishContentHandler,
  PackedEntity,
  RetireTarget,
  ReferenceHolder,
} from "./type-registry.js";

/**
 * @file Task 5 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 5 / §5 risks
 * #1–#3 and #10.
 *
 * `planImport()` is **pure planning — it never writes.** It is what an operator sees before
 * confirming anything (plan §1.5's gated-mutation `computePlan()`), and it is what Task 7's
 * `PLAN_STALE` re-derivation re-runs at execute time to detect a destination that moved between
 * plan and apply. Every code path in this file only ever calls a handler's `inspect()`/`precheck()`
 * (both documented read-only in `type-registry.ts`) or the caller-supplied `getBaseline`/`hasBlob`
 * reads — never a handler's `apply()`, never a repo write.
 *
 * ## The seven outcomes (plan §4's own safety-property table)
 *
 * | Outcome     | Condition                                                              | Writes (later, in Task 8)? |
 * |-------------|-------------------------------------------------------------------------|-----------------------------|
 * | `created`   | no destination row with this id                                        | yes |
 * | `unchanged` | destination hash == source hash                                        | no  |
 * | `applied`   | destination hash == recorded baseline (untouched since we last spoke)  | yes |
 * | `applied`   | no recorded baseline, but destination hash == the SHIPPED SEED's hash  | yes |
 * | `conflict`  | destination hash differs from BOTH source and baseline — edited there  | no  |
 * | `conflict`  | no baseline AND no seed match (or no seed hash supplied at all)        | no  |
 * | `blocked`   | a precondition fails: slug taken, required blob gone, etc.             | no  |
 * | `forced`    | outcome was `conflict` and the operator explicitly chose this row      | yes |
 *
 * The `applied`-via-seed row is D1 (2026-09-24 owner decision) — see {@link PlanImportDeps.getSeedHash}'s
 * own doc for why "no baseline" no longer means "conflict, always" once a seed hash is wired.
 *
 * `refused` is deliberately NOT a `PublishContentOutcomeKind` — it is a WHOLE-RUN state (see
 * {@link PublishContentReport.refused}), because both of its triggers (`bundle.hashVersion` mismatch, or
 * ANY entity's recorded baseline being on a different `hashVersion`) mean this instance cannot trust
 * its own hash comparisons for the run at all. Producing a partial per-entity report anyway would
 * read like "here is what would happen", when the true answer is "this comparison is not safe to
 * make" — plan §5 risk #10's own reasoning for why a version mismatch must refuse, not silently
 * degrade into an all-conflicts report an operator might force through unread.
 *
 * The critical asymmetry the table encodes, restated because it is the one a competent implementer
 * is most likely to get backwards: **no baseline is a `conflict`, never a free pass to `created`.**
 * A destination that already holds unrelated content — most importantly, the very first sync against
 * an existing production database — must never be silently overwritten just because this peer never
 * recorded a baseline for it. Fail closed, never open. D1's seed-hash fallback does not weaken this:
 * it only ever turns "no baseline" into `applied` (an ordinary overwrite of a row proven byte-identical
 * to what this install itself shipped there), never into `created`, and only when the destination's
 * CURRENT content still matches the seed exactly — any drift at all, from any cause, stays a `conflict`.
 *
 * ## Two-pass structure
 *
 * Pass 1 prefetches every entity's baseline and refuses the WHOLE run the instant any baseline was
 * recorded by a different `CONTENT_HASH_VERSION` generation — before a single per-entity outcome is
 * computed, so a stale-version baseline on entity #47 of 200 can never leave 46 "valid-looking" rows
 * sitting in the report next to it (the adversarial aggregate case this module's own tests pin).
 * Pass 2 classifies every entity into exactly one outcome, walking types in `dependsOn`-derived
 * apply order (see `buildPublishContentCatalog`) so a caller applying `rows` in this exact
 * sequence (Task 8) always writes a prerequisite before its dependent.
 *
 * ## Why `buildPublishContentCatalog()` is called INSIDE `planImport`, every call
 *
 * Plan §3 rule 2, verbatim: "`listPublishContentContributors()` is called at publish time, inside
 * the planner, never captured at module load." `buildPublishContentCatalog()` performs that fresh
 * read and validates the dependency graph before it builds handlers. `planImport` never caches the
 * catalog across calls — a contributor registered between two calls is picked up by the next one.
 */

/** One entity's recorded sync memory with a specific peer — the read side of
 *  `publish_content_baselines` (`platform/db/schema.sqlite.ts`), abstracted behind a callback so this
 *  module never has to know its caller's storage (SQLite today, an in-memory fake in this module's
 *  own tests). `hashVersion` is checked, never ignored — see this file's header. */
export interface BaselineRecord {
  readonly hashAtLastSync: string;
  readonly hashVersion: number;
}

/**
 * The import side's input: an already-exported, already-hashed set of entities (Task 4's export
 * route builds this; this module never re-derives it and never calls a handler's `pack()`).
 * `sourceLabel` is display-only, mirroring `publishContentRuns.peerLabel` — never used in any
 * comparison or trust decision.
 */
export interface PublishContentBundle {
  readonly artifactFormatVersion: number;
  readonly hashVersion: number;
  readonly sourceLabel?: string;
  readonly entities: readonly PackedEntity[];
}

/** Every outcome a single entity can resolve to. `refused` is deliberately excluded — see this
 *  file's header for why it is a whole-run state, not a per-entity one. */
export type PublishContentOutcomeKind = "created" | "unchanged" | "applied" | "conflict" | "blocked" | "forced";

/**
 * Re-exported from `type-registry.ts`, which is what actually names this shape on
 * `PublishContentHandler.planRetire`/`retire` (see that file's own doc on `RetireTarget`) — kept
 * importable from here too since this planner is where most other callers already get their
 * publish-content types from.
 */
export type { RetireTarget, ReferenceHolder };

/** One entity's classification. `writes` describes what a LATER apply pass (Task 8) would do if this
 *  report were accepted as-is — `planImport` itself never writes regardless of this flag's value. */
export interface PublishContentOutcomeRow {
  readonly entityType: string;
  readonly entityId: string;
  /** What a human calls this entity — see {@link entityDisplayLabel}. `null` when the packed state
   *  carries nothing human-readable, which is the ONLY case a caller may fall back to showing an id
   *  for. Never load-bearing: nothing compares, keys or authorizes on this field. */
  readonly entityLabel: string | null;
  readonly outcome: PublishContentOutcomeKind;
  readonly writes: boolean;
  /** Human-readable explanation for `conflict`/`blocked`/`forced` (why it was a conflict before being
   *  forced); `null` for `created`/`unchanged`, which need no explanation. */
  readonly reason: string | null;
  /**
   * publish-overwrite-live-plan §4 — true for every `conflict` row (the operator can already force
   * those via {@link PlanImportDeps.forcedEntityKeys}), and for a `blocked` row whose handler resolved
   * a {@link RetireTarget} that is NOT itself part of this bundle (see {@link planEntity}). `false`
   * everywhere else, including a `forced` row reached via the pre-existing conflict-forcing path —
   * that row is already what an operator asked for, not something still being offered.
   */
  readonly canOverwrite: boolean;
  /** Set on a slug-clash `blocked`/`forced` row whose handler resolved a live holder that overwriting
   *  would have to retire first (see {@link PublishContentHandler.planRetire}'s own doc, S4). `null`
   *  for every other row, including a `blocked` row whose handler has no `planRetire` at all. */
  readonly retires: RetireTarget | null;
  /**
   * `publish-repoint-menus-plan-2026-09-24.md` §2.2 — live entities that still link to this row's
   * {@link retires} holder by id (e.g. a menu item whose `entryRef` targets it), collected by a
   * post-pass over every registered handler's {@link PublishContentHandler.referencesTo}. Present
   * ONLY when non-empty — absent for every row with no retire target, and for a retire target with
   * no live references at all — so every pre-existing exact-object row assertion in
   * `planner.test.ts` stays valid without having to name a key it never expected.
   */
  readonly referencedBy?: readonly ReferenceHolder[];
}

/**
 * The full result of one `planImport` call. When {@link refused} is `true`, {@link rows} and
 * {@link applyOrder} are always empty — see this file's header for why a refusal never coexists with
 * a partial per-entity report.
 */
export interface PublishContentReport {
  readonly refused: boolean;
  readonly refusalReason: string | null;
  /** Entity types in the order Task 8's apply loop must walk them — derived from every currently
   *  registered handler's validated `dependsOn` order (see `buildPublishContentCatalog`), plus,
   *  appended at the
   *  end, any type present in the bundle that has NO registered handler on this instance (always
   *  `blocked`; order among those is bundle-first-seen order, since they carry no `dependsOn` to sort
   *  by). Empty when {@link refused} is `true`. */
  readonly applyOrder: readonly string[];
  readonly rows: readonly PublishContentOutcomeRow[];
}

/**
 * Dependencies `planImport` needs, none of which it is ever allowed to write through.
 *
 * `publishContentDeps` is handed to every registered contributor's `build()` (see this file's
 * header on why the registry is read fresh, inside this function, every call) — it is NOT this
 * module's own deps shape, it is `type-registry.ts`'s, unchanged, so a new contributor's needs never
 * require touching this planner.
 */
export interface PlanImportDeps {
  readonly publishContentDeps: PublishContentDeps;
  /** Reads one entity's baseline for the peer this import is running against — already scoped to
   *  `(workspaceId, peerPrincipalId)` by the caller's own closure (plan §1.6: baselines are keyed by
   *  the AUTHENTICATED principal, never a bundle-declared id — this module has no principal of its
   *  own to leak into that key by mistake, because it never sees one). */
  readonly getBaseline: (args: { entityType: string; entityId: string }) => Promise<BaselineRecord | null>;
  /** Whether a blob this instance would need (by sha256) is already available — Task 6's blob store
   *  is not this module's concern; this is a narrow read-only probe a later composition wires to the
   *  real `BlobStorePort`. Required (not optional) so a caller is forced to make a deliberate choice
   *  for it rather than the check silently always passing. */
  readonly hasBlob: (sha256: string) => Promise<boolean>;
  /**
   * D1 (2026-09-24 owner decision, publish-types-plan §6) — the hash this entity had in the SHIPPED
   * SEED database (`content.seed.db`) this destination was originally hydrated from, consulted only
   * when {@link getBaseline} found no recorded baseline. A destination row that still matches the
   * seed exactly has never been touched there since — the very first real publish against it should
   * overwrite it like any other `applied` row, not sit in `conflict` forever for want of a
   * `publish_content_baselines` row nothing has ever had a reason to write (the owner's own reported
   * bug: publishing a new header nav never replaces the ORIGINAL seeded one).
   *
   * Optional, and consulted ONLY when there is no real baseline (see {@link planEntity}) — a real
   * recorded baseline always wins outright, exactly like before D1; this is purely a fallback for
   * "no baseline yet", never a second vote once one exists. Absent entirely (`undefined`), or
   * resolving `null` for a given entity (not present in that seed at all), falls straight through to
   * the pre-D1 "no baseline" conflict — the safe, unchanged default. Wiring a real implementation
   * (packing the matching entity out of `dist/content/seed-sites/<site>/content.seed.db`) is a
   * separate follow-up; today's one production caller (`gated-hooks.ts`) does not supply it yet.
   */
  readonly getSeedHash?: (args: { entityType: string; entityId: string }) => Promise<string | null>;
  /** Entity keys (see {@link entityKey}) the operator has explicitly chosen to force past a
   *  `conflict`, turning that one row's outcome into `forced`. Absent/empty means "force nothing" —
   *  every conflict stays a conflict, the safe default. */
  readonly forcedEntityKeys?: ReadonlySet<string>;
}

/** The natural key an entity is addressed by everywhere in this module: baselines, forced
 *  selections, and grouping. Exported so a caller building {@link PlanImportDeps.forcedEntityKeys}
 *  (an operator's row selection in Task 7/11) constructs the identical string, rather than
 *  re-deriving the `${type}:${id}` convention by hand and risking a mismatch. */
export function entityKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** The packed-state fields a human identifier may live under, most identifying first. `slug` leads
 *  because every type that has one guarantees it unique per workspace and derives it from the
 *  operator's own words (`post.slug` is `NOT NULL`; `MediaRecord.slug` is derived from `title` at
 *  upload and unique per `(workspaceId, slug)`), so it is the one value that is both readable AND
 *  addresses exactly one row. `title`/`name`/`filename` follow for a type that has no slug yet;
 *  `label` names a content type (its id is the machine `key`), `regionKey` a widget area. */
const HUMAN_IDENTIFIER_FIELDS = ["slug", "title", "name", "filename", "label", "regionKey"] as const;

/**
 * What to call one packed entity on screen, or `null` when its state carries nothing readable.
 *
 * Derived HERE, in the planner, rather than looked up by whatever renders the report: the report
 * travels to an admin client that holds no content of its own (and, for a push, to an operator
 * looking at a REMOTE instance's plan of the LOCAL site's entities), so the only place both the id
 * and the entity's own fields exist together is this pass. A UI-side lookup would have to re-fetch
 * every row's entity from an instance that may not have it.
 *
 * Reads well-known field names off `state` rather than asking the handler, because `PackedEntity.
 * state` is a `Record<string, unknown>` by contract and every registered type already names its
 * human key one of the fields below. A type whose key is none of them gets `null` and its caller
 * shows a short id — degraded, never wrong.
 *
 * @complexity O(1) — at most six property reads, no allocation on the miss path.
 */
export function entityDisplayLabel(state: Record<string, unknown>): string | null {
  for (const field of HUMAN_IDENTIFIER_FIELDS) {
    const value = state[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Classifies exactly one entity — the per-row half of {@link planImport}'s pass 2. Never called for
 * an entity whose baseline already failed the {@link CONTENT_HASH_VERSION} check (pass 1 refuses the
 * whole run before this function is ever reached in that case).
 *
 * Precondition checks (required blobs, then `handler.precheck`) run UNCONDITIONALLY, before any
 * hash comparison — deliberately not skipped for an entity that would otherwise turn out
 * `unchanged`/non-writing, so a real data-integrity problem (e.g. a slug collision) is always visible
 * in the report rather than hidden behind "nothing would have changed anyway".
 *
 * @complexity O(1) plus whatever `handler.inspect`/`handler.precheck`/`deps.hasBlob` cost — one call
 * to each, never more, regardless of `entity.requiredBlobs.length` beyond the first failing blob
 * (short-circuits on the first missing one).
 */
async function planEntity(
  entity: PackedEntity,
  handler: PublishContentHandler | undefined,
  baseline: BaselineRecord | null,
  deps: PlanImportDeps,
  bundleKeys: ReadonlySet<string>
): Promise<PublishContentOutcomeRow> {
  const identity = {
    entityType: entity.entityType,
    entityId: entity.id,
    entityLabel: entityDisplayLabel(entity.state),
  };

  if (!handler) {
    return {
      ...identity,
      outcome: "blocked",
      writes: false,
      reason: `no registered publish-content handler for entity type '${entity.entityType}' on this instance`,
      canOverwrite: false,
      retires: null,
    };
  }

  for (const sha256 of entity.requiredBlobs) {
    if (!(await deps.hasBlob(sha256))) {
      return {
        ...identity,
        outcome: "blocked",
        writes: false,
        reason: `required blob '${sha256}' is not available on this instance`,
        canOverwrite: false,
        retires: null,
      };
    }
  }

  const blockReason = await handler.precheck(entity);
  if (blockReason) {
    // publish-overwrite-live-plan §4/S2 — a slug clash this handler knows how to resolve gets offered
    // as an overwrite, UNLESS the row that would have to be retired is itself part of this same
    // bundle (retiring it would move its own slug out from under it mid-run — an ordering problem,
    // not an overwrite; plan §2's last table row). An already-forced key (the operator's own prior
    // "overwrite on live" tick, the same `forcedEntityKeys` mechanism the conflict branch below uses)
    // turns a valid target straight into `forced` with the target attached.
    const target = await handler.planRetire?.(entity) ?? null;
    if (target !== null) {
      if (bundleKeys.has(entityKey(target.entityType, target.entityId))) {
        return { ...identity, outcome: "blocked", writes: false, reason: blockReason, canOverwrite: false, retires: null };
      }
      const forced = deps.forcedEntityKeys?.has(entityKey(entity.entityType, entity.id)) ?? false;
      if (forced) {
        return { ...identity, outcome: "forced", writes: true, reason: blockReason, canOverwrite: true, retires: target };
      }
      return { ...identity, outcome: "blocked", writes: false, reason: blockReason, canOverwrite: true, retires: target };
    }
    return { ...identity, outcome: "blocked", writes: false, reason: blockReason, canOverwrite: false, retires: null };
  }

  const destination = await handler.inspect(entity.id);
  if (!destination) {
    return { ...identity, outcome: "created", writes: true, reason: null, canOverwrite: false, retires: null };
  }
  if (destination.hash === entity.contentHash) {
    return { ...identity, outcome: "unchanged", writes: false, reason: null, canOverwrite: false, retires: null };
  }
  if (baseline && destination.hash === baseline.hashAtLastSync) {
    return { ...identity, outcome: "applied", writes: true, reason: null, canOverwrite: false, retires: null };
  }

  // D1 (2026-09-24 owner decision, see this module's header and `getSeedHash`'s own doc): no
  // RECORDED baseline exists, but the destination still matches exactly what the shipped seed put
  // there. Treat the seed's own hash as a virtual baseline — the same "untouched since we last
  // agreed" reasoning as the branch above, just with the seed standing in for a sync that never
  // happened. Only reachable when `baseline` is falsy, so a real recorded baseline always takes
  // priority and this never re-litigates an already-resolved conflict.
  //
  // S-F4: when the generic seed-db lookup has no answer, a handler whose seed is not a DB row (e.g.
  // `theme-files`' `__original-themes__` folders) answers for itself via `handler.seedHash`.
  if (!baseline) {
    const seedHash =
      (await deps.getSeedHash?.({ entityType: entity.entityType, entityId: entity.id })) ??
      (await handler.seedHash?.(entity.id)) ??
      null;
    if (seedHash !== null && destination.hash === seedHash) {
      return { ...identity, outcome: "applied", writes: true, reason: null, canOverwrite: false, retires: null };
    }
  }

  // Destination differs from both the incoming source AND the recorded baseline (or there is no
  // baseline at all) — plan §4's two `conflict` rows, unified here because both mean the same thing
  // to the operator: "this destination row does not match what we last agreed on; overwriting it
  // needs your explicit say-so." The reason text is the only place the two causes are distinguished.
  const conflictReason = baseline
    ? `${entity.entityType} '${entity.id}' has been edited on the destination since the last sync with this peer`
    : `no prior sync baseline for ${entity.entityType} '${entity.id}' with this peer — the destination already holds different content`;
  const forced = deps.forcedEntityKeys?.has(entityKey(entity.entityType, entity.id)) ?? false;
  if (forced) {
    // Unlike the retire-offered `forced` row above, this one already went through the (separate,
    // pre-existing) plain conflict-forcing path — nothing is still being "offered" here, so it gets
    // the same `canOverwrite:false, retires:null` as any other non-offer row (publish-overwrite-live-
    // plan §4: only the `conflict` outcome itself, and a valid retire target, ever set `true`).
    return { ...identity, outcome: "forced", writes: true, reason: conflictReason, canOverwrite: false, retires: null };
  }
  return { ...identity, outcome: "conflict", writes: false, reason: conflictReason, canOverwrite: true, retires: null };
}

/**
 * `publish-repoint-menus-plan-2026-09-24.md` §2.2 — the planner's post-pass. Collects every row's
 * {@link PublishContentOutcomeRow.retires} target id, asks each registered handler that has a
 * {@link PublishContentHandler.referencesTo} for the live entities that still link to any of them
 * (one call per handler, never per row — `ids` carries every retire target across the whole report
 * at once), and attaches the survivors back onto their row's `referencedBy`. Returns `rows`
 * unchanged — the exact same array reference — whenever there is nothing to attach, so the ordinary
 * run (no retires at all) pays zero extra handler calls.
 *
 * A returned holder is dropped when ITS OWN row in this same report already writes: the bundle also
 * republishes that referencing entity this run, so its incoming tree already carries the new id and
 * repointing it live would fight the source's own intent (plan §2.5's "written this run" row).
 *
 * @complexity O(h) handler calls (h = handlers with `referencesTo`, one call each) plus O(r) to
 * index `rows` by key and O(k) to redistribute the returned holders (k = holders returned) — never
 * one read per row.
 */
async function attachReferencedBy(
  rows: readonly PublishContentOutcomeRow[],
  handlerByType: ReadonlyMap<string, PublishContentHandler>
): Promise<readonly PublishContentOutcomeRow[]> {
  const ids = [...new Set(rows.filter((row) => row.retires !== null).map((row) => row.retires!.entityId))];
  if (ids.length === 0) return rows;

  const holders: ReferenceHolder[] = [];
  for (const handler of handlerByType.values()) {
    if (!handler.referencesTo) continue;
    holders.push(...(await handler.referencesTo(ids)));
  }
  if (holders.length === 0) return rows;

  // A holder whose OWN referencing entity is itself written this run is dropped — plan §2.5: the
  // incoming tree already targets the new id, so repointing the live copy would be redundant (and,
  // for a row later overwritten by this same run, actively wrong).
  const rowByKey = new Map(rows.map((row) => [entityKey(row.entityType, row.entityId), row] as const));
  const holdersByReferencedId = new Map<string, ReferenceHolder[]>();
  for (const holder of holders) {
    const ownRow = rowByKey.get(entityKey(holder.entityType, holder.entityId));
    if (ownRow?.writes) continue;
    const list = holdersByReferencedId.get(holder.referencedId) ?? [];
    list.push(holder);
    holdersByReferencedId.set(holder.referencedId, list);
  }
  if (holdersByReferencedId.size === 0) return rows;

  return rows.map((row) => {
    if (row.retires === null) return row;
    const referencedBy = holdersByReferencedId.get(row.retires.entityId);
    return referencedBy && referencedBy.length > 0 ? { ...row, referencedBy } : row;
  });
}

/**
 * Plans an import: for every entity in `bundle`, decides one of the seven outcomes (this file's
 * header) with ZERO writes. See this file's header for the two-pass structure and the whole-run
 * refusal semantics.
 *
 * @complexity O(n) handler resolution/reads in `bundle.entities.length` (two passes, each one
 * read-shaped call per entity) plus O(t²) for `buildPublishContentCatalog` over the small
 * number of distinct types `t` — dominated by whatever I/O `getBaseline`/`hasBlob`/`inspect`/
 * `precheck` themselves cost, not by this function's own control flow.
 */
export async function planImport(bundle: PublishContentBundle, deps: PlanImportDeps): Promise<PublishContentReport> {
  if (bundle.artifactFormatVersion !== PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION) {
    return {
      refused: true,
      refusalReason:
        `bundle artifact format version ${bundle.artifactFormatVersion} does not match this instance's ` +
        `${PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION} — use an exporter/importer pair with a supported format`,
      applyOrder: [],
      rows: [],
    };
  }

  if (bundle.hashVersion !== CONTENT_HASH_VERSION) {
    return {
      refused: true,
      refusalReason: `bundle content-hash version ${bundle.hashVersion} does not match this instance's ${CONTENT_HASH_VERSION} — upgrade the older instance before syncing`,
      applyOrder: [],
      rows: [],
    };
  }

  // Rule 2 (this file's header): read and validate the registry FRESH, inside this call, every call.
  const catalog = buildPublishContentCatalog(deps.publishContentDeps);
  const { handlerByType } = catalog;

  // Entity DTO compatibility is also exact. Refuse before baseline/blob/destination reads so an
  // operator never receives a partially credible plan for a bundle this importer cannot decode.
  for (const entity of bundle.entities) {
    const handler = handlerByType.get(entity.entityType);
    if (handler && entity.schemaVersion !== handler.schemaVersion) {
      return {
        refused: true,
        refusalReason:
          `${entity.entityType} '${entity.id}' uses schema version ${entity.schemaVersion}, but this ` +
          `instance supports version ${handler.schemaVersion} for that type`,
        applyOrder: [],
        rows: [],
      };
    }
  }

  // Pass 1 — prefetch baselines, refuse the whole run on the first hash-version mismatch found.
  const baselineByKey = new Map<string, BaselineRecord | null>();
  for (const entity of bundle.entities) {
    const baseline = await deps.getBaseline({ entityType: entity.entityType, entityId: entity.id });
    if (baseline && baseline.hashVersion !== CONTENT_HASH_VERSION) {
      return {
        refused: true,
        refusalReason:
          `baseline for ${entity.entityType} '${entity.id}' was recorded with content-hash version ${baseline.hashVersion}, ` +
          `but this instance is on version ${CONTENT_HASH_VERSION} — upgrade the older instance before syncing`,
        applyOrder: [],
        rows: [],
      };
    }
    baselineByKey.set(entityKey(entity.entityType, entity.id), baseline);
  }

  // Pass 2 — classify every entity, walking types in dependsOn-derived apply order. Types present in
  // the bundle with no registered handler are appended after, in first-seen order (plan §3 rule 4
  // only orders types that declare dependsOn; an unhandled type has none to sort by, and is always
  // `blocked` regardless of where it sits).
  const entitiesByType = new Map<string, PackedEntity[]>();
  for (const entity of bundle.entities) {
    const list = entitiesByType.get(entity.entityType) ?? [];
    list.push(entity);
    entitiesByType.set(entity.entityType, list);
  }
  const unhandledTypes = [...entitiesByType.keys()].filter((type) => !handlerByType.has(type));
  const applyOrder = [...catalog.applyOrder, ...unhandledTypes];

  // publish-overwrite-live-plan §4/S2 — every entity's own key, built once, so `planEntity` can tell
  // "the row a slug clash would retire" apart from "an entity this very bundle is also publishing"
  // without re-walking `bundle.entities` per blocked row.
  const bundleKeys = new Set(bundle.entities.map((entity) => entityKey(entity.entityType, entity.id)));

  const rows: PublishContentOutcomeRow[] = [];
  for (const type of applyOrder) {
    const handler = handlerByType.get(type);
    for (const entity of entitiesByType.get(type) ?? []) {
      const baseline = baselineByKey.get(entityKey(entity.entityType, entity.id)) ?? null;
      rows.push(await planEntity(entity, handler, baseline, deps, bundleKeys));
    }
  }

  // publish-repoint-menus-plan §2.2 — attach any live references to a row's retire target, so the
  // confirm dialog can show what still points at a holder before an operator chooses to overwrite it.
  const rowsWithReferences = await attachReferencedBy(rows, handlerByType);

  return { refused: false, refusalReason: null, applyOrder, rows: rowsWithReferences };
}
