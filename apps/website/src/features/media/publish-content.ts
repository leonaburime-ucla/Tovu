import { executeCommand } from "@jini-ai/cms/core";
import type { JsonObject } from "@jini-ai/cms/core";

import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import { contentHash, CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import type { PackedEntity, PublishContentContributor, PublishContentDeps, PublishContentHandler } from "#src/features/publish-content/type-registry";

import { importMediaEntity } from "./import-media-entity.js";
import { computeBlobStorageKey } from "./index.js";
import type { AssetBlobRepoPort, BlobStorePort, MediaRecord, MediaRepoPort, VersionedMediaRepoPort } from "./index.js";

/**
 * @file Task 12 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 12 — plus the
 * `apply()` wiring Task 12 deliberately deferred to whoever landed the apply loop (Task 8, now
 * committed as `features/publish-content/apply-loop.ts`).
 *
 * `media`'s publish-content contribution, mirroring `features/post/publish-content.ts`'s
 * `contributePostPublish()`/`contributePagePublish()` exactly: this function returns DATA (a plain
 * `{entityType, dependsOn, build}` object) and imports only `type-registry.ts`'s TYPES — never
 * `registerPublishContentContributor` itself. See that file's own header for why a value edge here
 * would reopen a real module cycle, and
 * `features/publish-content/__tests__/post-no-direct-registry-import.boundary.test.ts` for the check
 * that enforces it for `features/post` (the identical rule applies here by construction — this file
 * simply never imports the registration function at all).
 *
 * `dependsOn` is empty — media is a DEPENDENCY of `post`/`page`
 * (`POST_AND_PAGE_DEPENDS_ON = ["media", "term"]` in `features/post/publish-content.ts`), never the
 * reverse: an embedded image must exist at the destination before the post referencing it applies,
 * so nothing needs to land before media itself.
 *
 * ## The two decisions Task 12's stub refused to make, and how they were settled
 *
 * **1. Where `apply()` gets the entity's raw BYTES.** From the destination's own
 * {@link BlobStorePort}, addressed by `computeBlobStorageKey({workspaceId, sha256})` — the exact key
 * Task 6's blob pre-flight PUT route (`routes/publish-content/blob-put.ts`) already wrote them under,
 * and the exact key `gated-hooks.ts`'s own `hasBlob` probe reads when the planner checks
 * `PackedEntity.requiredBlobs`. `PackedEntity.state` is JSON-only and never carries a binary payload,
 * so the bytes cannot travel on the entity itself; re-deriving them from anywhere else would mean a
 * second, competing source of truth for content-addressed storage. A sha this destination never
 * received is a REPORTED, non-destructive block ({@link MediaApplyBlockedError} with code
 * `blocked:missing-blob`) that writes nothing — never a silent skip, and never a partial write that
 * leaves a media row pointing at bytes that are not there. It is reported twice over: {@link
 * PublishContentHandler.precheck} below surfaces it as an ordinary `blocked` report row (the channel
 * `type-registry.ts`'s own `precheck` doc names — "a required blob's absence"), while the
 * authoritative `importMediaEntity` command refuses a missing byte payload at write time rather
 * than trusting that a caller ran `precheck` first.
 *
 * **2. Whether `apply()` routes through the same `executeCommand` gateway `post`'s does.** YES, and
 * this matters MORE for media than for posts, not less. `type-registry.ts`'s own
 * `PublishContentDeps.changeSets` doc requires it, and media is the type with the weakest independent
 * safety net: `posts` now has `post_revisions`, but `media` has no revision ledger and `asset_blobs`
 * has none either, so a write outside change-sets would sit outside the revert path with nothing else
 * to fall back on. Routing through the gateway gives every media import a `change_sets` row whose
 * inverse is the verbatim pre-write `MediaRecord` — that inverse IS media's revert path. The
 * `asset_blobs` half stays safe by construction rather than by ledger: `importMediaEntity` writes a
 * blob row ONLY when `findByHash` finds none, so the blob side of an import is append-only and an
 * existing row's attribution is never overwritten (see {@link MediaApplyResult.blobWritten} for how
 * that is reported).
 *
 * ## A failure here downgrades ONE row — it never aborts the run
 *
 * Both error classes below extend `PublishContentApplyRowError` (`features/publish-content/
 * apply-errors.ts`), which is what `apply-loop.ts`'s per-row catch checks. A blocked or conflicted
 * media entity therefore comes back as that ONE row's `blocked`/`conflict` outcome with this file's
 * own message as the reason, and every other entity in the run still applies — one missing blob must
 * never kill a 200-entity publish. A bare `Error` from here would instead reach `apply-loop.ts`'s
 * `throw error`, abort the whole run and persist a `failed` phase, which is the correct behaviour
 * ONLY for a genuine fault (a broken repo, a bug) and never for the data-shaped refusals below.
 *
 * The invariant that makes those row outcomes honest: `importMediaEntity` completes every
 * authoritative validation before its first write and reports a typed block to this wrapper.
 *
 * ## The optimistic-concurrency guard is now atomic (formerly a disclosed limitation)
 *
 * Guard 1 below (the freshest re-read immediately before `importMediaEntity` is called) is an EARLY
 * refusal only — it exists to avoid fetching blob bytes for an import that is already doomed, not
 * to be the enforcement point. The real guarantee lives inside `importMediaEntity`
 * (`import-media-entity.ts`): its `baseVersion` input carries the SAME compare into an atomic
 * compare-and-set write, `VersionedMediaRepoPort.saveIfVersion`/`insertIfAbsent`, mirroring
 * `PostRepoPort.saveIfVersion`'s identical role for `updatePost`. A concurrent writer that slips
 * past Guard 1's read (real blob-store I/O sits between the two) is now caught by that atomic write
 * instead of silently losing to a last-write-wins `save()`.
 */

/** Empty by design — see this file's header. */
const MEDIA_DEPENDS_ON: readonly string[] = [];

/** Machine-readable cause for a refused media apply. One discriminant rather than one error class
 *  per cause, mirroring `ImportMediaEntityResult`'s own `blocked` shape: every one of these is an
 *  ORDINARY, expected outcome of importing real-world data, not a programming error. */
export type MediaApplyBlockedCode = "blocked:missing-blob" | "blocked:slug-taken" | "blocked:precondition";

/**
 * A media entity that cannot be applied, for a reason that is data, not a fault. Thrown only after
 * every precondition check and BEFORE any write, so a blocked apply always leaves the destination
 * exactly as it found it — no blob row, no media row, no change set.
 *
 * Extends {@link PublishContentApplyRowError} with `rowOutcome: "blocked"`, so `apply-loop.ts`
 * downgrades THIS ONE report row and the rest of the run continues. One missing blob must never kill
 * a 200-entity publish. The message is used verbatim as the row's `reason`, which is why it is
 * phrased as a standalone operator-facing explanation.
 */
export class MediaApplyBlockedError extends PublishContentApplyRowError {
  readonly code: MediaApplyBlockedCode;

  constructor(code: MediaApplyBlockedCode, message: string) {
    super("blocked", message);
    this.name = "MediaApplyBlockedError";
    this.code = code;
  }
}

/**
 * The destination moved on from the `expectedVersion` the apply loop planned against — media's
 * equivalent of `PostConflictError`, deliberately its own class rather than a reuse of `post`'s (a
 * shared base in `apply-errors.ts` is what the loop actually checks; see that file's header).
 * `rowOutcome: "conflict"`, so the row downgrades and the run continues. Thrown before any write.
 */
export class MediaApplyConflictError extends PublishContentApplyRowError {
  constructor(message: string) {
    super("conflict", message);
    this.name = "MediaApplyConflictError";
  }
}

/**
 * What one applied media entity actually did. Structurally a superset of
 * {@link PublishContentHandler.apply}'s declared `{changeSetId}` return, so the apply loop keeps
 * compiling unchanged while a caller that cares can read {@link blobWritten}.
 */
export interface MediaApplyResult {
  readonly changeSetId: string;
  /**
   * `true` when this import created the `asset_blobs` row (attributed to the importing operator);
   * `false` when a row for these bytes already existed and was left completely untouched, original
   * `createdByPrincipal` included. Reuse is NORMAL and expected — two media rows legitimately
   * dedup onto the same bytes — so it is reported here and in the change set's summary, and is
   * deliberately NOT a conflict or a warning.
   */
  readonly blobWritten: boolean;
}

/** `MediaRecord` fields {@link contentHash} treats as this entity's real content — every field,
 *  mirroring `features/post/publish-content.ts`'s identical `toHashableState`: `content-hash.ts`'s
 *  own `canonicalize` already excludes `id`/`workspaceId`/`version`/`updatedAt` unconditionally, so
 *  passing the whole record through is safe and cannot silently drift from `MediaRecord`'s own field
 *  list the way hand-picking a subset could. */
function toHashableState(media: MediaRecord): Record<string, unknown> {
  return { ...media };
}

/**
 * The id of a DIFFERENT media row already holding `slug`, or `null` when the slug is free (or when
 * this entity has none — `media.slug` is nullable/optional in practice for pre-backfill rows, so an
 * empty slug has nothing to collide on; contrast `post.slug`, which is `NOT NULL`).
 *
 * Used only by {@link PublishContentHandler.precheck} for a lightweight operator preview. The
 * authoritative collision decision belongs to `importMediaEntity`.
 *
 * @complexity O(1) — one indexed `findBySlug` lookup, or none at all for a slugless entity.
 */
async function findSlugConflict(required: {
  mediaRepo: MediaRepoPort;
  workspaceId: string;
  entityId: string;
  slug: unknown;
}): Promise<string | null> {
  if (typeof required.slug !== "string" || required.slug.length === 0) return null;
  const holder = await required.mediaRepo.findBySlug({ workspaceId: required.workspaceId, slug: required.slug });
  return holder && holder.id !== required.entityId ? holder.id : null;
}

/** Whether this destination actually holds the bytes for `sha256` — the same
 *  `computeBlobStorageKey` + `exists` probe `gated-hooks.ts`'s own `hasBlob` performs for the
 *  planner, applied here so media's own `precheck`/`apply` never depend on a caller having wired
 *  that probe correctly.
 *  @complexity O(1) — one existence check against content-addressed storage. */
async function hasBlobBytes(required: { blobStore: BlobStorePort; workspaceId: string; sha256: string }): Promise<boolean> {
  return required.blobStore.exists({ storageKey: computeBlobStorageKey({ workspaceId: required.workspaceId, sha256: required.sha256 }) });
}

function buildHandler(deps: PublishContentDeps): PublishContentHandler {
  const entityType = "media";
  const schemaVersion = 1;
  // F2 — `media`'s port, keyed by entityType on the shared bag (`type-registry.ts`'s
  // `PublishContentPorts`).
  const mediaPort = deps.ports.media;

  async function* pack(): AsyncIterable<PackedEntity> {
    // Absent `ports.media` (every caller before this feature's deps bag is widened for real — see
    // `type-registry.ts`'s `PublishContentPorts.media` doc) degrades to "nothing to export",
    // never a crash — the same "type absent from the registry is absent from the bundle" contract
    // `type-registry.ts`'s own header rule 5 states for an unregistered type, applied here to a
    // registered-but-not-yet-wired one.
    if (!mediaPort) return;
    const rows = await mediaPort.repo.list({ workspaceId: deps.workspaceId });
    for (const row of rows) {
      yield {
        entityType,
        id: row.id,
        schemaVersion,
        contentHash: contentHash(entityType, toHashableState(row)),
        hashVersion: CONTENT_HASH_VERSION,
        // A media entity's own required blob is itself — the destination must hold these bytes
        // before this row can be applied, the exact case `PackedEntity.requiredBlobs` exists for.
        requiredBlobs: [row.source.sha256],
        state: toHashableState(row),
      };
    }
  }

  async function inspect(id: string): Promise<{ version: number; hash: string } | null> {
    if (!mediaPort) return null;
    const found = await mediaPort.repo.findById({ workspaceId: deps.workspaceId, id });
    if (!found) return null;
    return { version: found.version, hash: contentHash(entityType, toHashableState(found)) };
  }

  /**
   * Pure precondition check — never writes. Reports the two conditions that would otherwise only
   * surface once `apply()` refused: a slug held by a different id, and bytes this destination never
   * received. Both come back as a human-readable reason the planner turns into a `blocked` report
   * row (`planner.ts`'s `planEntity`), which is how an operator sees them BEFORE confirming anything.
   *
   * The blob check overlaps `planner.ts`'s own `requiredBlobs`/`hasBlob` pass on purpose: that pass
   * depends on a caller having wired `hasBlob` to the real store, and media is the one type whose
   * entity IS its blob. Checking here too costs one existence probe and removes the dependency.
   *
   * @complexity O(1) — at most one slug lookup and one blob existence probe.
   */
  async function precheck(entity: PackedEntity): Promise<string | null> {
    if (!mediaPort) return `media entity '${entity.id}' cannot be prechecked — no media port wired for this deps bag`;
    // Unlike `post`'s precheck, an absent/empty slug does NOT block here — `media.slug` is
    // nullable/optional in practice (pre-backfill rows genuinely have none), so there is nothing to
    // check for a collision, not an error condition. See `import-media-entity.ts`'s identical
    // reasoning for the real write path.
    const holderId = await findSlugConflict({
      mediaRepo: mediaPort.repo,
      workspaceId: deps.workspaceId,
      entityId: entity.id,
      slug: entity.state.slug,
    });
    if (holderId) return `slug '${String(entity.state.slug)}' is already held by a different media ('${holderId}')`;

    for (const sha256 of entity.requiredBlobs) {
      if (!(await hasBlobBytes({ blobStore: mediaPort.blobStore, workspaceId: deps.workspaceId, sha256 }))) {
        return `required blob '${sha256}' is not available on this destination`;
      }
    }
    return null;
  }

  /**
   * Applies ONE media entity through the command gateway — see this file's header for both design
   * decisions this implements and the two disclosed limitations it carries.
   *
   * Order inside the gateway matters and is not arbitrary. `executeCommand` runs
   * `authorize` -> idempotency -> `captureInverse` -> `execute` -> record, so authoritative
   * validation lives inside `execute()`: an unauthorized caller gets `ForbiddenError` rather than a
   * "that slug is taken" message that would tell them something about workspace content they are not
   * allowed to read. `captureInverse`'s read doubles as the freshest pre-write snapshot, so the
   * version guard reuses it rather than issuing a second query against a slightly older answer.
   *
   * Nothing is written before any throw. Preview checks stay in `precheck()` so the operator sees
   * likely blocks before confirmation; `importMediaEntity` is the one authoritative command for
   * slug, source, and byte validation at write time. This wrapper only enforces optimistic
   * concurrency and loads the staged bytes that command consumes.
   *
   * @complexity O(1) repo/store calls plus one O(n) hash pass over the blob's bytes (`n` = blob
   * size); the apply LOOP (`apply-loop.ts`) is what iterates a report's rows and calls this per row.
   */
  async function apply(input: {
    entity: PackedEntity;
    expectedVersion: number | undefined;
    principalId: string;
    idempotencyKey: string;
  }): Promise<MediaApplyResult> {
    const { changeSets, authorize, outbox } = deps;
    if (!changeSets || !authorize || !outbox) {
      throw new Error(
        `publish-content: ${entityType}.apply() requires PublishContentDeps.changeSets/authorize/` +
          "outbox — wire them from the real apply-loop composition root " +
          "(features/publish-content/apply-loop.ts)."
      );
    }
    if (!mediaPort) {
      throw new Error(
        `publish-content: ${entityType}.apply() requires PublishContentDeps.ports.media — wire it ` +
          "from the real apply-loop composition root (features/publish-content/apply-loop.ts)."
      );
    }
    const { repo: mediaRepo, assetBlobRepo, blobStore } = mediaPort;

    const workspaceId = deps.workspaceId;
    const source = input.entity.state as unknown as MediaRecord; // trusted round-trip: this file's own pack() produced it.
    const sha256 = source.source?.sha256 ?? "";

    // Read once, before the gateway, purely to phrase the change set's own summary accurately — the
    // AUTHORITATIVE blob decision is `importMediaEntity`'s (it re-reads and only writes when nothing
    // is there). Under a concurrent import of the identical bytes the two can disagree, which
    // affects this summary's wording and nothing else; `MediaApplyResult.blobWritten` below always
    // reports what actually happened.
    const blobExistedBeforeApply = (await assetBlobRepo.findByHash({ workspaceId, sha256 })) !== null;
    const summary = blobExistedBeforeApply
      ? `Import ${entityType} '${input.entity.id}' via publish-content (existing blob ${sha256} reused; attribution preserved)`
      : `Import ${entityType} '${input.entity.id}' via publish-content (new blob ${sha256})`;

    let priorMedia: MediaRecord | null = null;
    const { result, changeSetId } = await executeCommand({
      deps: { clock: deps.clock, idGen: deps.idGen, changeSets, outbox, authorize },
      command: {
        workspaceId,
        // Always the authenticated operator running the import, never an id carried in from the
        // source system — this is what `executeCommand`'s own `authorize()` checks. `media` has no
        // author column of its own, so unlike `post` there is no second authorship id to preserve.
        actor: { id: input.principalId, kind: "user" as const },
        summary,
        permission: "content.write",
        idempotencyKey: input.idempotencyKey,
      },
      mutation: {
        entityType,
        entityId: input.entity.id,
        operation: input.expectedVersion === undefined ? "create" : "update",
        captureInverse: async () => {
          priorMedia = await mediaRepo.findById({ workspaceId, id: input.entity.id });
          // `media` has no revision ledger, so this verbatim pre-write record IS the revert path —
          // see this file's header.
          return priorMedia ? ({ ...priorMedia } as unknown as JsonObject) : null;
        },
        execute: async (): Promise<{ blobWritten: boolean; version: number | null }> => {
          const existing: MediaRecord | null = priorMedia;

          // Guard 1 — an EARLY refusal only, on the freshest read available BEFORE any blob bytes are
          // fetched. The real, atomic enforcement is `importMediaEntity`'s compare-and-set write
          // (see this file's header) — a writer that slips past this read is still caught there.
          if (input.expectedVersion === undefined && existing) {
            throw new MediaApplyConflictError(
              `${entityType} '${input.entity.id}' changed on the destination during apply: expected no existing row, found version ${existing.version}`
            );
          }
          if (input.expectedVersion !== undefined) {
            if (!existing) {
              throw new MediaApplyConflictError(
                `${entityType} '${input.entity.id}' changed on the destination during apply: expected version ${input.expectedVersion}, but the row is gone`
              );
            }
            if (existing.version !== input.expectedVersion) {
              throw new MediaApplyConflictError(
                `${entityType} '${input.entity.id}' changed on the destination during apply: expected version ${input.expectedVersion}, found version ${existing.version}`
              );
            }
          }

          // Fetch only. `null` carries a missing pre-staged object into the authoritative import
          // command, which owns the refusal and its operator-facing reason.
          const bytes = (await hasBlobBytes({ blobStore, workspaceId, sha256 }))
            ? await blobStore.get({ storageKey: computeBlobStorageKey({ workspaceId, sha256 }) })
            : null;

          const outcome = await importMediaEntity({
            deps: { mediaRepo, assetBlobRepo, blobStore, clock: deps.clock, idGen: deps.idGen },
            input: {
              workspaceId,
              record: source,
              bytes,
              // A brand-new blob row at this destination has no prior attribution to protect, so it
              // takes the importing operator's principal. An EXISTING row is never re-stamped —
              // `importMediaEntity` only reaches `assetBlobRepo.save` when `findByHash` finds
              // nothing, which is what makes the preserved case safe by construction.
              blobCreatedByPrincipal: input.principalId,
              // The atomic compare-and-set basis — see this file's header (safety property 5,
              // formerly a disclosed limitation): Guard 1 above already compared the SAME basis
              // against the freshest read available to IT, but a concurrent writer can still land
              // between Guard 1's read and this command's own write. `importMediaEntity` carries the
              // compare into the write itself, so that race can no longer let two importers both win.
              baseVersion: input.expectedVersion ?? null,
            },
          });
          if (outcome.status === "conflict") {
            throw new MediaApplyConflictError(
              `${entityType} '${input.entity.id}' changed on the destination during apply: ${outcome.reason}`
            );
          }
          if (outcome.status === "blocked") {
            const code: MediaApplyBlockedCode =
              outcome.code === "missing-blob"
                ? "blocked:missing-blob"
                : outcome.code === "slug-taken"
                  ? "blocked:slug-taken"
                  : "blocked:precondition";
            throw new MediaApplyBlockedError(
              code,
              `${entityType} '${input.entity.id}' cannot be applied — ${outcome.reason}`
            );
          }
          const saved = await mediaRepo.findById({ workspaceId, id: input.entity.id });
          return { blobWritten: outcome.blobWritten, version: saved?.version ?? null };
        },
        captureEntityVersion: (executed) => executed.version,
        rollback: async () => {
          // Compensating undo for a change-set record that failed AFTER the write landed. An update
          // restores the prior record verbatim, `version` included; a create removes the row it just
          // added. The `asset_blobs` row and its bytes are deliberately left in place: they are
          // content-addressed and append-only here, another media row may already have deduped onto
          // them, and an orphan blob is reclaimable by the existing GC whereas a wrongly deleted one
          // is not.
          if (priorMedia) await mediaRepo.save(priorMedia);
          else await mediaRepo.remove({ workspaceId, id: input.entity.id });
        },
      },
    });

    return { changeSetId, blobWritten: result.blobWritten };
  }

  return { entityType, schemaVersion, permission: "content.write", dependsOn: MEDIA_DEPENDS_ON, pack, inspect, precheck, apply };
}

/**
 * `media`'s publish-content contribution. Resolves to `content.write` — the SAME permission
 * `post`/`page` already declare (no new permission invented for this feature, mirroring
 * `contributePostPublish`'s identical reasoning; media has no separate write permission of its own
 * in this codebase today).
 *
 * Called from a composition root (`server/runtime/composition/publish-content-manifest.ts`), NOT
 * from within `features/media` itself — see this file's header.
 */
export function contributeMediaPublish(): PublishContentContributor {
  return { entityType: "media", dependsOn: MEDIA_DEPENDS_ON, build: buildHandler };
}
