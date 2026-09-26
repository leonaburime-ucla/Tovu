import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import { contentHash, CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import type { PackedEntity, PublishContentContributor, PublishContentDeps, PublishContentHandler } from "#src/features/publish-content/type-registry";

import type { RedirectRepoPort } from "./ports.js";
import { checkRedirectFieldsWouldWrite, createRedirect, updateRedirect } from "./redirects.js";
import type { RedirectsWriteDeps } from "./redirects.js";
import {
  RedirectConflictError,
  RedirectLoopError,
  RedirectTargetNotAllowedError,
  RedirectValidationError,
} from "./types.js";
import type { RedirectMatchType, RedirectRecord, RedirectStatus, RedirectStatusCode } from "./types.js";

/**
 * @file S2 of `ADS-memory/.local-artifacts/publish-types-plan-2026-09-24.md` — `redirect`'s
 * publish-content contribution, mirroring `features/post/publish-content.ts`/
 * `features/media/publish-content.ts` exactly: a DATA export (`{entityType, dependsOn, build}`) that
 * imports only `type-registry.ts`'s TYPES, never `registerPublishContentContributor` itself. See
 * `type-registry.ts`'s own header for why a value edge here would reopen a real module cycle, and
 * `post`'s own file for the boundary test that enforces the identical rule for that feature.
 *
 * Full design worked out and recorded in
 * `ADS-memory/.local-artifacts/handoffs/2026-09-24-c7-publish-types-build.md` §S2 before this file was
 * typed in; see that record for the reasoning trail. Two corrections made while implementing (both
 * narrow, both disclosed):
 *
 * 1. `permission` is `"admin.redirects.manage"` — redirects' own existing write permission (the same
 *    one every other write in `features/redirects/*` already gates on), not `post`'s/`media`'s
 *    `"content.write"`. `PublishContentHandler.permission`'s own doc requires "the resource's OWN
 *    existing write permission, never a flat transport-wide permission" — the design record did not
 *    spell this field out, but it follows mechanically from that existing contract.
 * 2. `source`/`sourceEntryId`/`fromPathAtCapture`/`toPathAtCapture` are packed (so an operator
 *    inspecting a bundle can still see them) but excluded from the content hash — see
 *    {@link REDIRECT_FIELD_DISPOSITIONS}'s own doc for why hashing them would make every publish of a
 *    manually-created or slug-change-derived redirect report a permanent false conflict.
 *
 * ## The natural key
 *
 * Redirect ids are minted per-install (`idGen.newId()` inside `createRedirect`), so two instances
 * holding "the same" rule never share a row id the way `post`/`page`/`media` do. This transport keys
 * `PackedEntity.id` on `${matchType}:${fromPattern}` instead (behavior.spec.md §5.1's own exact-match
 * dedup key) — reversed by splitting on the FIRST `:` only ({@link parseRedirectNaturalKey}):
 * `matchType` is a short fixed enum with no colon of its own, while `fromPattern` may contain one.
 *
 * No `RedirectRepoPort` method finds a row (active OR disabled) by natural key directly —
 * `lookupExact`/`lookupLongestPrefix`/`listDynamic`/`findByFromPattern` all filter to
 * `status === "active"` only. {@link findRedirectByNaturalKey} uses `repo.list({workspaceId,
 * matchType})` (status omitted, so both statuses come back) and finds by `fromPattern` client-side —
 * O(n) over this feature's realistic row counts (tens, not thousands).
 */

/** Redirects have no dependency on any other publish-content type. */
const REDIRECT_DEPENDS_ON: readonly string[] = [];

/**
 * Every `RedirectRecord` field, classified by what this transport does with it — mirrors
 * `features/post/publish-content.ts`'s identical `POST_FIELD_DISPOSITIONS` map and the defect it
 * exists to prevent (hashing a field this transport cannot actually write back is worse than not
 * hashing it at all: it makes `destination.hash === entity.contentHash` — `planner.ts`'s
 * `planEntity` — never agree, so the row reports as permanently "changed" no matter how many times it
 * is republished with no real edit).
 *
 * - `"transferred"` (packed + hashed): every field `CreateRedirectInput`/`UpdateRedirectInput`
 *   actually accepts (`matchType`/`fromPattern`/`toTarget`/`statusCode`/`priority`/`override`), plus
 *   `status` — safe to hash because {@link pack} only ever emits `status: "active"` rows (see below),
 *   so a legitimately packed entity's `status` is always `"active"`, exactly what `createRedirect`
 *   hardcodes and `apply()` explicitly re-asserts on update.
 * - `"provenance"` (packed, NOT hashed): `createdAt` (write-once, applied only implicitly through
 *   `createRedirect`'s own `deps.clock` — never actually copied from the wire, unlike `post`'s
 *   identically-named field; kept in this bucket rather than `"local"` purely for wire visibility) and
 *   four fields this write chokepoint structurally cannot set at all: `source` (`createRedirect`'s
 *   `source` param is a *separate*, narrower argument — `"manual" | "import"` — never part of
 *   `CreateRedirectInput`, and `apply()` below always passes literal `"import"`, never the wire's own
 *   value) and `sourceEntryId`/`fromPathAtCapture`/`toPathAtCapture` (populated only by the
 *   `auto_slug_change` capture path in `capture.ts`, which writes directly and bypasses
 *   `createRedirect`/`updateRedirect` entirely — neither function has any field for them). Hashing any
 *   of these four would compare a value the SOURCE holds against a value the destination can never be
 *   made to hold, which is exactly the permanent-false-conflict defect this map exists to prevent —
 *   the same reasoning `post`'s own map applies to `createdByPrincipalId`/`createdAt`, extended here to
 *   fields that cannot round-trip at all rather than fields that merely disagree by instance.
 * - `"local"` (never packed): per-database identity/write bookkeeping that two instances holding the
 *   same logical rule legitimately disagree on.
 */
const REDIRECT_FIELD_DISPOSITIONS: Record<keyof RedirectRecord, "transferred" | "provenance" | "local"> = {
  matchType: "transferred",
  fromPattern: "transferred",
  toTarget: "transferred",
  statusCode: "transferred",
  status: "transferred",
  override: "transferred",
  priority: "transferred",

  createdAt: "provenance",
  source: "provenance",
  sourceEntryId: "provenance",
  fromPathAtCapture: "provenance",
  toPathAtCapture: "provenance",

  id: "local",
  workspaceId: "local",
  createdByPrincipal: "local",
  createdByPluginId: "local",
  updatedAt: "local",
  version: "local",
};

/** The wire keys: `"transferred"` plus `"provenance"` — everything packed, whether or not it is
 *  hashed. Derived from {@link REDIRECT_FIELD_DISPOSITIONS} rather than re-listed, so the two cannot
 *  drift apart the way `post`'s own field list once did (that file's header). */
const PACKED_REDIRECT_FIELDS = Object.freeze(
  (Object.keys(REDIRECT_FIELD_DISPOSITIONS) as Array<keyof RedirectRecord>).filter(
    (field) => REDIRECT_FIELD_DISPOSITIONS[field] !== "local"
  )
);

/** The hashed keys: `"transferred"` only. A strict subset of {@link PACKED_REDIRECT_FIELDS} — see
 *  {@link REDIRECT_FIELD_DISPOSITIONS}'s own doc for why `"provenance"` fields are packed but must
 *  never reach {@link contentHash}. */
const HASHED_REDIRECT_FIELDS = Object.freeze(
  (Object.keys(REDIRECT_FIELD_DISPOSITIONS) as Array<keyof RedirectRecord>).filter(
    (field) => REDIRECT_FIELD_DISPOSITIONS[field] === "transferred"
  )
);

/** The wire shape of a packed redirect: {@link PACKED_REDIRECT_FIELDS}, nothing else — what travels
 *  in `PackedEntity.state` and what {@link toImportableRedirectFields} reads back.
 *  @complexity O(1) — a fixed field count. */
function toPublishableRedirectState(record: RedirectRecord): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const field of PACKED_REDIRECT_FIELDS) {
    state[field] = record[field] ?? null;
  }
  return state;
}

/** The hash input for a redirect — {@link HASHED_REDIRECT_FIELDS} only. Used by both {@link pack}
 *  (against the source row) and {@link inspect} (against whatever the destination currently holds),
 *  so the two are always compared on the identical field set.
 *  @complexity O(1). */
function toHashableRedirectState(record: RedirectRecord): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const field of HASHED_REDIRECT_FIELDS) {
    state[field] = record[field] ?? null;
  }
  return state;
}

/** `PackedEntity.id` for a redirect — see this file's header for why a natural key is used instead of
 *  the per-install row id.
 *  @complexity O(1). */
export function redirectNaturalKey(matchType: RedirectMatchType, fromPattern: string): string {
  return `${matchType}:${fromPattern}`;
}

/** The short plain-English word an operator reads for a non-`"exact"` `matchType`, prefixed onto
 *  {@link redirectDisplayTitle}'s output. `"exact"` gets no prefix at all — an exact rule reads fine
 *  as a bare `from → to` pair, and every other match type needs to say it is not one. */
const MATCH_TYPE_PREFIX: Readonly<Record<RedirectMatchType, string>> = {
  exact: "",
  prefix: "starts with ",
  wildcard: "matches ",
  regex: "matches pattern ",
};

/**
 * What a human calls this redirect on screen — no `RedirectRecord` field is named `slug`/`title`/
 * `name`/`filename` (the four fields `planner.ts`'s `entityDisplayLabel` reads off packed state), so
 * without this every redirect row fell through to a short id prefix of its `PackedEntity.id`
 * (`redirectNaturalKey`'s `"matchType:fromPattern"`) — meaningless for this type specifically, since
 * that id is a colon- and slash-heavy string rather than the mostly-random uuid the short-id fallback
 * was designed for (`"exact:/old-promo"`.slice(0, 8) reads as `"exact:/o"`, not a recognizable
 * abbreviation). Packed under `state.title` in {@link toPublishableRedirectState}'s caller so the
 * generic fallback in `report-rows.ts` picks it up the same way every other type's `title`/`slug`
 * does, needing no redirect-specific code in the planner or the dialog.
 *
 * @complexity O(1).
 */
function redirectDisplayTitle(matchType: RedirectMatchType, fromPattern: string, toTarget: string): string {
  return `${MATCH_TYPE_PREFIX[matchType]}${fromPattern} → ${toTarget}`;
}

/** Reverses {@link redirectNaturalKey}, splitting on the FIRST `:` only (`fromPattern` may itself
 *  contain one; `matchType` never does). Returns `null` for a key with no `:` at all — never
 *  reachable for a key this file's own {@link redirectNaturalKey} produced, but a defensive result
 *  rather than a throw for a hand-crafted or corrupted id arriving from outside this process.
 *  @complexity O(n) in the key's length (one scan for the separator). */
function parseRedirectNaturalKey(key: string): { matchType: RedirectMatchType; fromPattern: string } | null {
  const sep = key.indexOf(":");
  if (sep < 0) return null;
  return { matchType: key.slice(0, sep) as RedirectMatchType, fromPattern: key.slice(sep + 1) };
}

/** The row (active OR disabled) holding this exact `matchType:fromPattern`, or `null` — see this
 *  file's header for why no repo method answers this directly.
 *  @complexity O(n) in this workspace's row count for `matchType`. */
async function findRedirectByNaturalKey(required: {
  repo: RedirectRepoPort;
  workspaceId: string;
  matchType: RedirectMatchType;
  fromPattern: string;
}): Promise<RedirectRecord | null> {
  const rows = await required.repo.list({ workspaceId: required.workspaceId, matchType: required.matchType });
  return rows.find((row) => row.fromPattern === required.fromPattern) ?? null;
}

/** Maps a thrown chokepoint refusal to the per-row downgrade `apply-loop.ts` recognizes, or passes a
 *  genuine fault through unchanged (never swallowed) — mirrors `features/media/publish-content.ts`'s
 *  own "apply-time re-verification" reasoning: every one of these is an ordinary, expected outcome of
 *  publishing real-world data, not a programming error.
 *  @complexity O(1). */
function toApplyRowError(err: unknown): Error {
  if (
    err instanceof RedirectValidationError ||
    err instanceof RedirectTargetNotAllowedError ||
    err instanceof RedirectLoopError ||
    err instanceof RedirectConflictError
  ) {
    return new PublishContentApplyRowError("blocked", err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function buildHandler(deps: PublishContentDeps): PublishContentHandler {
  const entityType = "redirect";
  const schemaVersion = 1;

  async function* pack(): AsyncIterable<PackedEntity> {
    // Absent `redirectsWriteDeps` degrades to "nothing to export" — mirrors `features/media/
    // publish-content.ts`'s identical convention for a caller with no use for this type.
    const writeDeps = deps.ports.redirect;
    if (!writeDeps) return;
    const rows = await writeDeps.repo.list({ workspaceId: deps.workspaceId });
    for (const row of rows) {
      // Fail-closed skip: `status !== "active"` covers both a manually-disabled rule and a
      // Trash-tombstoned one (both are exactly `status: "disabled"` — `RedirectsWriteDeps` has no
      // read side into the Trash index to tell them apart), so publishing can never resurrect a
      // trashed rule as live content on the destination. The side effect — a manually-disabled rule
      // also never travels until re-enabled — is the documented, deliberately safe reading; see the
      // S2 design record for the open product question this leaves.
      if (row.status !== "active") continue;
      yield {
        entityType,
        id: redirectNaturalKey(row.matchType, row.fromPattern),
        schemaVersion,
        contentHash: contentHash(entityType, toHashableRedirectState(row)),
        hashVersion: CONTENT_HASH_VERSION,
        requiredBlobs: [],
        // `title` is synthetic display text, not a `RedirectRecord` field — added alongside the real
        // transferred/provenance fields rather than through them, and deliberately excluded from
        // {@link toHashableRedirectState} (this file's header: hashing something the destination could
        // never disagree on by real edit would just add noise to the comparison).
        state: { ...toPublishableRedirectState(row), title: redirectDisplayTitle(row.matchType, row.fromPattern, row.toTarget) },
      };
    }
  }

  async function inspect(id: string): Promise<{ version: number; hash: string } | null> {
    const writeDeps = deps.ports.redirect;
    if (!writeDeps) return null;
    const key = parseRedirectNaturalKey(id);
    if (!key) return null;
    const found = await findRedirectByNaturalKey({
      repo: writeDeps.repo,
      workspaceId: deps.workspaceId,
      matchType: key.matchType,
      fromPattern: key.fromPattern,
    });
    if (!found) return null;
    return { version: found.version, hash: contentHash(entityType, toHashableRedirectState(found)) };
  }

  /**
   * Pure precondition check — never writes. Reuses `redirects.ts`'s own
   * {@link checkRedirectFieldsWouldWrite} so this preview and `apply()`'s own apply-time
   * re-verification can never drift onto different rulesets (this file's header).
   *
   * @complexity O(1) plus whatever {@link checkRedirectFieldsWouldWrite} itself costs (one repo list,
   * one origin-allow check, at most two target-allow checks).
   */
  async function precheck(entity: PackedEntity): Promise<string | null> {
    const writeDeps = deps.ports.redirect;
    if (!writeDeps) return `redirect entity '${entity.id}' cannot be prechecked — no redirect port wired for this deps bag`;
    const key = parseRedirectNaturalKey(entity.id);
    if (!key) return `redirect entity '${entity.id}' has a malformed natural key (expected 'matchType:fromPattern')`;
    const existing = await findRedirectByNaturalKey({
      repo: writeDeps.repo,
      workspaceId: deps.workspaceId,
      matchType: key.matchType,
      fromPattern: key.fromPattern,
    });
    const state = entity.state;
    return checkRedirectFieldsWouldWrite(
      writeDeps,
      {
        workspaceId: deps.workspaceId,
        matchType: state.matchType as RedirectMatchType,
        fromPattern: state.fromPattern as string,
        toTarget: state.toTarget as string,
        statusCode: state.statusCode as RedirectStatusCode,
        priority: state.priority as number,
      },
      existing?.id
    );
  }

  /**
   * Applies ONE redirect entity directly through `createRedirect`/`updateRedirect` — the real
   * chokepoint, but NOT wrapped in `executeCommand` the way `post`'s/`media`'s `apply()` are.
   * Redirects have no `change_sets` row to produce: their own append-only revision ledger
   * (`redirect_revisions`, written in the same transaction by `createRedirect`/`updateRedirect`
   * themselves) is already this domain's audit trail, so routing through the command gateway would
   * add a second, redundant one. `record.id` is returned as `changeSetId` — the best available
   * per-row reference for the run's report, same spirit as other types' disclosed deviations
   * elsewhere in this feature.
   *
   * `override` — carried verbatim off `entity.state` like every other transferred field — is what
   * makes a published redirect win over an existing live page at the same path when the source rule
   * has it set (owner decision D3, 2026-09-19): nothing special-cased here, it travels because it is
   * an ordinary transferred field.
   *
   * @complexity O(1) plus `createRedirect`'s/`updateRedirect`'s own cost (repo reads, one origin-allow
   * check, at most two target-allow checks, one transactional write) — no loop; the apply LOOP
   * (`apply-loop.ts`) is what iterates a report's rows and calls this once per row.
   */
  async function apply(input: {
    entity: PackedEntity;
    expectedVersion: number | undefined;
    principalId: string;
    idempotencyKey: string;
  }): Promise<{ changeSetId: string }> {
    const writeDeps = deps.ports.redirect;
    if (!writeDeps) {
      throw new Error(
        `publish-content: ${entityType}.apply() requires PublishContentDeps.ports.redirect — wire it ` +
          "from the real apply-loop composition root (features/publish-content/apply-loop.ts)."
      );
    }
    const key = parseRedirectNaturalKey(input.entity.id);
    if (!key) {
      throw new Error(`publish-content: ${entityType}.apply() received a malformed natural key '${input.entity.id}'`);
    }
    const state = input.entity.state;
    const fields = {
      workspaceId: deps.workspaceId,
      matchType: state.matchType as RedirectMatchType,
      fromPattern: state.fromPattern as string,
      toTarget: state.toTarget as string,
      statusCode: state.statusCode as RedirectStatusCode,
      override: state.override as boolean,
      priority: state.priority as number,
    };

    if (input.expectedVersion === undefined) {
      try {
        const { record } = await createRedirect({
          deps: writeDeps,
          input: { ...fields, actorId: input.principalId },
          // Always the literal transport provenance, never the source's own `state.source` — see
          // {@link REDIRECT_FIELD_DISPOSITIONS}'s own doc for why that field cannot round-trip at all.
          source: "import",
        });
        return { changeSetId: record.id };
      } catch (err) {
        throw toApplyRowError(err);
      }
    }

    // `apply-loop.ts`'s own `applyOneRow` already re-checked `inspect()` before calling here for any
    // non-`created` row, so this coming back empty is a genuine race between that check and this
    // call — reported as a row conflict rather than crashing the whole run, exactly the shape
    // `features/post/publish-content.ts`'s own `apply()` uses for its equivalent re-resolve.
    const existing = await findRedirectByNaturalKey({
      repo: writeDeps.repo,
      workspaceId: deps.workspaceId,
      matchType: key.matchType,
      fromPattern: key.fromPattern,
    });
    if (!existing) {
      throw new PublishContentApplyRowError(
        "conflict",
        `${entityType} '${input.entity.id}' was removed from the destination between plan and apply`
      );
    }
    try {
      const { record } = await updateRedirect({
        deps: writeDeps,
        input: {
          ...fields,
          id: existing.id,
          status: (state.status as RedirectStatus | undefined) ?? "active",
          actorId: input.principalId,
        },
      });
      return { changeSetId: record.id };
    } catch (err) {
      throw toApplyRowError(err);
    }
  }

  return {
    entityType,
    schemaVersion,
    // Redirects' own existing write permission (`features/redirects/agent-tools.ts`,
    // `routes/redirects/*`) — never a flat transport-wide permission, per
    // `PublishContentHandler.permission`'s own contract.
    permission: "admin.redirects.manage",
    dependsOn: REDIRECT_DEPENDS_ON,
    pack,
    inspect,
    precheck,
    apply,
  };
}

/**
 * `redirect`'s publish-content contribution. Called from a composition root
 * (`server/runtime/composition/publish-content-manifest.ts`), NOT from within `features/redirects`
 * itself — see this file's header.
 */
export function contributeRedirectPublish(): PublishContentContributor {
  return { entityType: "redirect", dependsOn: REDIRECT_DEPENDS_ON, build: buildHandler };
}
