import { executeCommand } from "@jini-ai/cms/core";

import { contentHash, CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import type {
  PublishContentContributor,
  PublishContentDeps,
  PublishContentHandler,
  PackedEntity,
  RetireTarget,
} from "#src/features/publish-content/type-registry";

import { importPostEntity, isTrashed, restorePostForward, retirePostForReplacement, PostConflictError, PostNotFoundError, ROOT_SLUG } from "./post.js";
import type { PostKind, PostRecord } from "./post.js";

/**
 * @file Task 2 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 2's
 * "`contributePostPublish()` / `contributePagePublish()` returning data only".
 *
 * A NEW file, deliberately NOT added to `features/post/tool-registrations.ts` (unlike the otherwise
 * near-identical `contributePostDuplicateHandlers` precedent there).
 *
 * `apply()` (Task 8, 2026-09-18) is the one function here that writes — through `createPost`/
 * `updatePost` (the real domain functions, never the raw repo) wrapped in `executeCommand` (plan
 * §1.4), exactly like every other admin write route in this codebase. It requires
 * `PublishContentDeps.changeSets`/`authorize` to be wired — see its own doc below for why those stay
 * optional on the shared `PublishContentDeps` interface, and for the two authorship rules (Task 15)
 * it has to get right on the create path.
 *
 * Both contributors return DATA (plain `{entityType, dependsOn, build}` objects) and import only
 * `type-registry.ts`'s TYPES — never `registerPublishContentContributor` itself. Wiring the actual
 * registration call is the composition root's job
 * (`server/runtime/composition/publish-content-manifest.ts`), exactly like
 * `contributePostDuplicateHandlers()`'s own relationship to `registerDuplicateResourceHandler`. See
 * `type-registry.ts`'s header for why a value edge from here would reopen a real module cycle, and
 * `__tests__/post-no-direct-registry-import.boundary.test.ts` for the check that enforces it.
 */

/**
 * `post`'s and `page`'s declared prerequisite types (plan §3's own worked example: "post ->
 * [media, term]"). Both share the currently implemented `media` dependency — a Page's body can
 * embed media exactly like a Post's can (same table, same `bodyJson` shape; `PostKind` only changes
 * which admin list surfaces a row — see `post.ts`'s own doc). `term` must be added here only when
 * its real contributor is registered: catalog construction rejects speculative/unregistered
 * dependencies because no safe apply order exists for them.
 */
const POST_AND_PAGE_DEPENDS_ON: readonly string[] = ["media"];

/**
 * Every `PostRecord` field, classified by what this transport DOES with it. This map is the single
 * place that decision is recorded, and `Record<keyof PostRecord, ...>` is what makes it a decision
 * rather than an omission: adding a field to `PostRecord` fails this file's typecheck until someone
 * classifies the new field here.
 *
 * ## The defect this exists to prevent
 *
 * This file used to hash `{...post}` — the WHOLE record — while `apply()` wrote back a hand-listed
 * subset of six or so fields. Everything in the gap (`bodyFormat`/`bodyHtml`, `seoExtJson`, `ext`,
 * `deletedAt`, `memberAccessJson`, and `templateChoice`/`overridesThemePage` on the create path) was
 * hashed but never applied, so publishing silently dropped or replaced it and still reported
 * success. `memberAccessJson` made that a SECURITY defect and not only a fidelity one: a
 * members-only post published to production as a publicly readable row.
 *
 * **"hashed but not applied" is the defect.** The reverse combination is safe: a field that is
 * applied but not hashed simply never triggers a publish on its own. So `"transferred"` is the only
 * disposition that participates in the content hash, and `"local"` fields are excluded from BOTH
 * sides — they are per-destination facts that a source instance has no standing to overwrite.
 *
 * @see `content-hash.ts`'s `EXCLUDED_KEYS`, which independently drops `id`/`workspaceId`/`version`/
 * `updatedAt`/`createdAt`/`createdByPrincipalId`. This map agrees with it by classifying those same
 * fields `"local"`; the two are belt and braces, not one relying on the other.
 */
const POST_FIELD_DISPOSITIONS: Record<keyof PostRecord, "transferred" | "provenance" | "local"> = {
  // Content — packed, hashed, and written verbatim by `importPostEntity` (`post.ts`).
  title: "transferred",
  slug: "transferred",
  bodyJson: "transferred",
  status: "transferred",
  kind: "transferred",
  bodyFormat: "transferred",
  bodyHtml: "transferred",
  seoExtJson: "transferred",
  templateChoice: "transferred",
  overridesThemePage: "transferred",
  memberAccessJson: "transferred",

  // Authorship PROVENANCE (Task 15) — packed and applied, but NOT hashed. The source is the
  // authority on who wrote a post and when, so an import copies both rather than re-stamping every
  // row with the importing operator's id; they are write-once, so only a row that does not exist at
  // the destination yet takes them. Excluded from the hash by `content-hash.ts`'s own
  // `EXCLUDED_KEYS` (which is why they can safely ride along in `state`): two instances that merely
  // disagree on a row's author or creation time must not read as a content edit.
  createdByPrincipalId: "provenance",
  createdAt: "provenance",

  // Identity and per-database write bookkeeping. Two instances holding the same logical content
  // legitimately disagree on all of these — this feature's founding premise, see
  // `content-hash.ts`'s header.
  id: "local",
  workspaceId: "local",
  version: "local",
  updatedAt: "local",

  // Plugin-namespaced extension data (SPEC-005 CIC U-004), written only by the local
  // `content.entry.beforeSave` hook chain. Neither packed nor hashed: a plugin's namespace is a
  // fact about the instance the plugin is INSTALLED on, and a destination running a different
  // plugin set would otherwise repack to a different hash forever and report the row as eternally
  // "changed". The destination's own `ext` survives an import untouched (`toImportableRecord` hands
  // `importPostEntity` the destination's existing bag, and its `beforeSaveHook` merge runs on top),
  // so this exclusion loses nothing that belongs to this instance.
  ext: "local",

  // Trash. Never packed and never hashed: `pack()` skips trashed rows outright rather than shipping
  // them, and `precheck` refuses a trashed DESTINATION row, so publishing can neither export trash
  // nor resurrect it. OPEN PRODUCT QUESTION (2026-09-19): whether a locally-deleted post should
  // instead delete on production. This is the safe reading — it never resurrects trash as live
  // content and never deletes production content — until that is answered.
  deletedAt: "local",
};

/** The keys {@link toPublishableState} puts on the wire: `"transferred"` plus `"provenance"`.
 *  Derived from {@link POST_FIELD_DISPOSITIONS} rather than re-listed, so the two cannot drift. */
const PACKED_POST_FIELDS = Object.freeze(
  (Object.keys(POST_FIELD_DISPOSITIONS) as Array<keyof PostRecord>).filter(
    (field) => POST_FIELD_DISPOSITIONS[field] !== "local"
  )
);

/** The wire shape of a packed `post`/`page`: exactly {@link PACKED_POST_FIELDS}, nothing else.
 *  Named so `pack`, `inspect` and `apply` read one contract instead of three hand-listed field sets
 *  that can drift apart. */
export type PublishablePostState = Pick<PostRecord, (typeof PACKED_POST_FIELDS)[number]>;

/**
 * Projects a `PostRecord` onto {@link PublishablePostState} — the ONE state builder behind `pack`,
 * `inspect` and the content hash.
 *
 * Undefined optional fields are normalized to `null` so a row whose optional column was never set
 * and one whose column holds SQL `NULL` hash identically across two instances whose adapters
 * represent that difference differently. (`content-hash.ts`'s `normalize` collapses the same two
 * cases, but doing it here makes the WIRE shape unambiguous too, not just the hash input.)
 *
 * Exported so a test can assert against THE state builder rather than re-deriving the field list
 * on its own — a duplicated recipe in a test is the same drift this DTO exists to close, and it
 * is how four suites came to hash `{...post}` while production hashed something else.
 *
 * @complexity O(1) — a fixed field count, no iteration over anything caller-controlled.
 */
export function toPublishableState(post: PostRecord): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const field of PACKED_POST_FIELDS) {
    state[field] = post[field] ?? null;
  }
  return state;
}

/**
 * Rebuilds the full `PostRecord` `importPostEntity` replicates, from a packed state plus whatever
 * the destination already holds.
 *
 * `"local"` fields are filled from the DESTINATION's own row (or a documented default when there is
 * none) and never from the wire; `"provenance"` fields come from the wire only for a row that does
 * not exist here yet, matching their write-once contract.
 *
 * @complexity O(1).
 */
function toImportableRecord(
  required: { state: Record<string, unknown>; workspaceId: string; id: string; existing: PostRecord | null }
): PostRecord {
  const { state, workspaceId, id, existing } = required;
  const packed = state as Partial<PostRecord>;
  const wire: Record<string, unknown> = {};
  for (const field of PACKED_POST_FIELDS) {
    wire[field] = packed[field] ?? null;
  }
  return {
    ...(wire as unknown as PublishablePostState),
    id,
    workspaceId,
    // Recomputed by `importPostEntity` itself; present only because `PostRecord` requires them, and
    // never read off the wire.
    version: existing?.version ?? 0,
    updatedAt: existing?.updatedAt ?? "",
    // A packed entity is never trashed (`pack` skips trashed rows) and a trashed destination row is
    // refused before this point, so the only correct value here is "live".
    deletedAt: null,
    ...(existing?.ext !== undefined ? { ext: existing.ext } : {}),
    createdByPrincipalId: existing ? existing.createdByPrincipalId : ((wire.createdByPrincipalId as string | null) ?? null),
    createdAt: existing ? existing.createdAt : ((wire.createdAt as string | null) ?? null),
  };
}

/** Shared pack/inspect/precheck implementation behind both `"post"` and `"page"` contributors —
 *  mirrors `tool-registrations.ts`'s own `duplicatePostOrPage` precedent of one shared function
 *  parameterized by `kind`, rather than two near-duplicate handler bodies.
 *
 *  Deliberately reads `PostRepoPort` directly rather than going through `post.ts`'s
 *  `getAdminPostById`/`listAdminPosts` domain wrappers — those add admin-view formatting (public
 *  URL resolution, etc.) this feature has no use for, and this file's whole point is to stay off
 *  any code path currently in flux (this file's own header). */
function buildHandler(deps: PublishContentDeps, kind: PostKind): PublishContentHandler {
  const entityType = kind; // "post" | "page" — PostKind's two values are exactly this feature's two entityTypes.
  const schemaVersion = 1;
  // F2 — `post`'s port, keyed by entityType on the shared bag (`type-registry.ts`'s
  // `PublishContentPorts`). Read once so every function below shares the same narrowing; absent
  // behaves exactly like every other optional port on this interface: `pack`/`inspect`/`precheck`
  // degrade to "nothing to report" (this file's own guards, below), `apply`/`retire` throw loudly.
  const postRepo = deps.ports.post?.repo;

  async function* pack(): AsyncIterable<PackedEntity> {
    if (!postRepo) return;
    const rows = await postRepo.list({ workspaceId: deps.workspaceId });
    for (const row of rows) {
      if (row.kind !== kind) continue;
      // Trash is not content to publish. `PostRepoPort` is deliberately trash-BLIND (see
      // `PostRecord.deletedAt`'s own doc), so this filter has to live here, exactly the way every
      // other trash-aware read in `post.ts` applies its own. Without it a binned post would be
      // shipped and then land at the destination as live content, since `deletedAt` is not a field
      // this transport carries.
      if (isTrashed(row)) continue;
      yield {
        entityType,
        id: row.id,
        schemaVersion,
        contentHash: contentHash(entityType, toPublishableState(row)),
        hashVersion: CONTENT_HASH_VERSION,
        // Blob-reference detection (which media sha256s a body embeds) is Task 12's job (plan §5
        // risk #5: media is not a registered type until ids are preserved) — an empty list here is
        // a disclosed gap, not a silent one; see `PackedEntity.requiredBlobs`'s own doc.
        requiredBlobs: [],
        state: toPublishableState(row),
      };
    }
  }

  async function inspect(id: string): Promise<{ version: number; hash: string } | null> {
    if (!postRepo) return null;
    const found = await postRepo.findById({ workspaceId: deps.workspaceId, id });
    if (!found || found.kind !== kind) return null;
    return { version: found.version, hash: contentHash(entityType, toPublishableState(found)) };
  }

  /**
   * Reports, WITHOUT writing anything, every condition under which `apply()` would refuse this
   * entity — a slug already held here, a destination row in the trash, a kind that cannot be
   * changed. Each of these is a real, ordinary outcome of importing real-world data, not a
   * programming error, so they come back as a human-readable reason rather than a throw
   * (`PublishContentHandler.precheck`'s own contract).
   *
   * A body-format difference (`doc` vs `html`) is deliberately NOT one of these — D2 (2026-09-24
   * owner decision, publish-types-plan §6) — publishing now REPLACES an existing row whose format
   * differs, the same as any other content change, instead of refusing it. `entity.state.bodyFormat`
   * already participates in the content hash (`POST_FIELD_DISPOSITIONS`), so a format-only change
   * still surfaces as an ordinary `conflict`/`applied` outcome through the planner's normal hash
   * comparison — it is never silently skipped, only no longer specially blocked. See
   * `features/post/post.ts`'s `importPostEntity` for the matching second-guard removal that makes
   * the actual write succeed, not only the plan.
   *
   * Every guard below is enforced a SECOND time inside `importPostEntity`, which is what actually
   * makes them safe: `apply()` can be reached without a precheck, and the destination can change
   * between the two calls. This function exists so an operator sees the problem in the plan rather
   * than as a failed row mid-run.
   *
   * @complexity O(1) — two indexed repo reads.
   */
  async function precheck(entity: PackedEntity): Promise<string | null> {
    if (!postRepo) return `${entityType} entity '${entity.id}' cannot be prechecked — no post repo wired for this deps bag`;
    const slug = entity.state.slug;
    if (typeof slug !== "string" || slug.length === 0) {
      return `${entityType} entity '${entity.id}' has no usable slug to check for a collision`;
    }
    const holder = await postRepo.findBySlug({ workspaceId: deps.workspaceId, slug });
    if (holder && holder.id !== entity.id) {
      return `slug '${slug}' is already held by a different ${entityType} ('${holder.id}')`;
    }

    const existing = await postRepo.findById({ workspaceId: deps.workspaceId, id: entity.id });
    if (!existing) return null;
    if (isTrashed(existing)) {
      return `${entityType} '${entity.id}' is in the trash at this destination — restore it before publishing over it, or publishing would resurrect it as live content`;
    }
    if (existing.kind !== kind) {
      return `'${entity.id}' is a '${existing.kind}' at this destination but a '${kind}' at the source — kind is fixed at creation and cannot be changed by publishing`;
    }
    return null;
  }

  /**
   * Task 8's real apply path: every write goes through `executeCommand` (plan §1.4) wrapping
   * `createPost`/`updatePost` — never `deps.postRepo` directly, so this write is auditable and
   * revertible exactly like an ordinary admin edit (a `change_sets` row with an inverse).
   *
   * `deps.changeSets`/`deps.authorize`/`deps.outbox` are all OPTIONAL on `PublishContentDeps`
   * (`type-registry.ts`'s own "absent behaves like it always did" convention for this interface) —
   * only a real `ContentTransportApplyPort`/`PublishContentApplyPort` composition
   * (`features/publish-content/apply-loop.ts`) supplies them, because only `apply()` routes a write
   * through the command gateway. `pack`/`inspect`/`precheck` never read any of the three, so a
   * caller that only needs those (Task 4's export route, Task 5/7's planner) is unaffected by them
   * being absent. Narrowed into local `const`s immediately below rather than read off `deps` again
   * later — TypeScript does not carry a closured parameter's narrowing across the rest of this
   * function body, and `updatePost`'s own `UpdatePostDeps.outbox` is REQUIRED (unlike this
   * interface's optional `outbox`), so the narrowing has to happen once, here.
   *
   * ## Authorship (Task 15) — the two ids this function must NOT conflate
   *
   * `input.principalId` (who is RUNNING this import) and the imported post's OWN author are
   * different facts and travel through two completely separate fields:
   * - `command.actor.id` is always `input.principalId` — the real, authenticated, authorized
   *   operator — for BOTH branches below. This is what `executeCommand`'s own `authorize()` call
   *   checks permission for for the change-set audit trail; it must never be an arbitrary id
   *   from a remote peer's own identity system that does not exist as a principal here (see the
   *   next paragraph for why the plan's own draft phrasing on this point cannot be followed literally).
   * - `createPost`'s `input.actorId` (the ONLY thing that becomes `PostRecord.createdByPrincipalId`,
   *   `content-hash.ts`'s excluded-from-hashing field) is read straight from the SOURCE entity's own
   *   `createdByPrincipalId` on the `created` path — never from `input.principalId` — per plan §4
   *   task 15: "do not let an importer re-stamp every post with the importing operator's id."
   *   `updatePost` never touches `createdByPrincipalId` at all (write-once, `UpdatePostInput` has no
   *   such field), so the `applied`/`forced` branch needs no special-casing for this — its own
   *   `actorId: input.principalId` only ever reaches the revision ledger, exactly as plan §4 task 15
   *   describes ("Revision-ledger actorId here is the IMPORTING OPERATOR").
   *
   * Disclosed deviation from the plan §1.4/§4 task 8 draft wording ("actor: {id: principal.id, kind:
   * 'api_key'}"): `CommandActor.kind` (`@jini-ai/cms/core`) is a real, closed union of `"user" |
   * "agent"` — there is no `"api_key"` member, and every other admin-write route in this codebase
   * (`routes/posts/{create,update}.ts`) uses `kind: "user"` regardless of whether the underlying
   * credential was a session cookie or an API key (the two are indistinguishable once resolved to a
   * `PrincipalRecord` — `dev-auth.ts`'s own doc). Using the SOURCE author as `command.actor.id`
   * instead (a plausible misreading of "the importer must copy the source's author") would also have
   * been a live bug: `executeCommand`'s `authorize()` call checks `command.actor.id`'s OWN
   * permissions, and a remote peer's author id is not a principal that exists in this instance's
   * identity system at all — every `created` import would then fail `ForbiddenError` (or worse,
   * silently authorize against an id that happens to collide). `kind: "user"` matches this
   * codebase's real type and every other real call site.
   *
   * @complexity O(1) plus `executeCommand`'s own cost (one `authorize()` call, one domain write, one
   * change-set insert) — no loop, no batching; the apply LOOP (`apply-loop.ts`) is what iterates a
   * report's rows and calls this once per row.
   */
  async function apply(input: {
    entity: PackedEntity;
    expectedVersion: number | undefined;
    principalId: string;
    idempotencyKey: string;
  }): Promise<{ changeSetId: string }> {
    const { changeSets, authorize, outbox } = deps;
    const forgetRemovedPost = deps.ports.post?.forgetRemoved;
    if (!changeSets || !authorize || !outbox || !postRepo || !forgetRemovedPost) {
      throw new Error(
        `publish-content: ${entityType}.apply() requires PublishContentDeps.changeSets/authorize/` +
          "outbox and ports.post.repo/forgetRemoved — wire them from the real apply-loop composition " +
          "root (features/publish-content/apply-loop.ts)."
      );
    }
    const gatewayDeps = { clock: deps.clock, idGen: deps.idGen, changeSets, outbox, authorize };
    const summary = `Import ${entityType} '${input.entity.id}' via publish-content`;
    const actor = { id: input.principalId, kind: "user" as const };
    const isCreate = input.expectedVersion === undefined;

    // Read once BEFORE the gateway so the imported record can be assembled against what this
    // destination actually holds (its own `ext`, its own write-once authorship). `importPostEntity`
    // re-reads inside the mutation and owns the AUTHORITATIVE decision — this read only shapes the
    // record handed to it, and a row that changes between the two is caught there by
    // `expectedVersion`.
    let priorPost = await postRepo.findById({ workspaceId: deps.workspaceId, id: input.entity.id });
    const record = toImportableRecord({
      state: input.entity.state,
      workspaceId: deps.workspaceId,
      id: input.entity.id,
      existing: priorPost,
    });

    const { changeSetId } = await executeCommand({
      deps: gatewayDeps,
      command: {
        workspaceId: deps.workspaceId,
        actor,
        summary,
        permission: "content.write",
        idempotencyKey: input.idempotencyKey,
      },
      mutation: {
        entityType,
        entityId: input.entity.id,
        operation: isCreate ? "create" : "update",
        captureInverse: async () => {
          priorPost = await postRepo.findById({ workspaceId: deps.workspaceId, id: input.entity.id });
          return priorPost ? { ...priorPost } : null;
        },
        execute: () =>
          importPostEntity({
            deps: { repo: postRepo, clock: deps.clock, outbox, beforeSaveHook: deps.beforeSaveHook },
            input: {
              workspaceId: deps.workspaceId,
              record,
              expectedVersion: input.expectedVersion,
              // The revision ledger's actor is always the IMPORTING OPERATOR — see this function's
              // own doc. The SOURCE's author travels separately, on `record.createdByPrincipalId`.
              actorId: input.principalId,
            },
          }),
        captureEntityVersion: (result) => result.post.version,
        rollback: async () => {
          // Compensating undo for a change-set record that failed AFTER the write landed. An
          // update restores the prior record forward — see `restorePostForward`'s own doc for why
          // "forward" rather than the verbatim restore `command.ts:82` asks for.
          if (priorPost) {
            await restorePostForward({
              deps: { repo: postRepo, clock: deps.clock, outbox, forgetRemoved: forgetRemovedPost },
              input: { prior: priorPost, actorId: input.principalId },
            });
            return;
          }
          // A create has no pre-image, so the correct undo is for the row never to have existed:
          // `PostRepoPort.hardDelete` removes it outright, with the revision the create appended
          // and the slug it reserved. Until 2026-09-20 the port had no row removal and this trashed
          // the row instead, which was the wrong shape twice over — it recorded a creation the
          // system had just decided did not happen, left it sitting in the Trash for a user to
          // "restore", and kept its slug reserved against the retry of the very import that failed.
          // The one thing it must not become is a no-op: leaving the row live would publish content
          // at the destination with no change-set record to revert it by.
          const orphan = await postRepo.findById({ workspaceId: deps.workspaceId, id: input.entity.id });
          if (!orphan) return;
          await postRepo.hardDelete({ workspaceId: deps.workspaceId, id: input.entity.id });
        },
      },
    });
    return { changeSetId };
  }

  /**
   * S4's read half (`publish-overwrite-live-plan-2026-09-24.md` §4/§5) — reports the live row a
   * slug-clash overwrite would retire, or `null` when there is none. Never writes.
   *
   * The three conditions under which there is nothing to retire, matching {@link precheck}'s own
   * slug-taken branch it is meant to answer for:
   * - the slug is free, or already held by `entity` itself — nothing to overwrite;
   * - `entity.id` already exists at this destination — a same-id collision needs a different remedy
   *   (a kind change, S11) than retiring some unrelated row;
   * - the slug is {@link ROOT_SLUG} — the home page has no other address to move to
   *   ({@link retirePostForReplacement}'s own refusal, mirrored here so the box is never even offered).
   *
   * @complexity O(1) — two indexed repo reads, same as `precheck()`.
   */
  async function planRetire(entity: PackedEntity): Promise<RetireTarget | null> {
    if (!postRepo) return null;
    const slug = entity.state.slug;
    if (typeof slug !== "string" || slug.length === 0 || slug === ROOT_SLUG) return null;

    const holder = await postRepo.findBySlug({ workspaceId: deps.workspaceId, slug });
    if (!holder || holder.id === entity.id) return null;

    const existingHere = await postRepo.findById({ workspaceId: deps.workspaceId, id: entity.id });
    if (existingHere) return null;

    return {
      entityType: holder.kind,
      entityId: holder.id,
      entityLabel: holder.title,
      hash: contentHash(holder.kind, toPublishableState(holder)),
    };
  }

  /**
   * S4's write half — retires `target` (moves it to Trash under a renamed slug, never in place)
   * through the same `executeCommand` gateway {@link apply} uses, wrapping
   * {@link retirePostForReplacement} exactly the way `routes/pages/delete.ts:46-92` wraps
   * `deletePost`: `operation: "delete"`, inverse is the holder's own prior `deletedAt` — `null` for a
   * live holder, its trash time for one that was already trashed. A revert must put the row back
   * exactly where it was, not always un-trash it: `retirePostForReplacement` only renames an
   * already-trashed holder (its own doc), so a literal `{deletedAt: null}` inverse would un-trash a
   * row the human had trashed before this run ever touched it.
   *
   * `captureInverse` reads `target`'s CURRENT row and closes over it as `holder`; `execute` reuses
   * that same read as `retirePostForReplacement`'s required `expectedVersion`, rather than a second,
   * later read, because `executeCommand` guarantees `captureInverse` resolves before `execute` runs
   * (`core/commands/command.ts`'s own "Order matters: idempotency check -> inverse capture ->
   * execute -> record"). The apply loop (S5) is what re-verifies `target.hash` against a FRESH
   * `planRetire()` immediately before calling this — a holder that changed between plan and apply is
   * caught there, not here.
   *
   * `undo()` restores `holder` forward through {@link restorePostForward} — the same primitive
   * `apply()`'s own `rollback` uses — and is also what the gateway's `mutation.rollback` calls on a
   * change-set-record failure, so every path that can need to "put this retire back" restores
   * identically.
   *
   * @complexity O(1) plus `executeCommand`'s own cost, same as `apply()`.
   */
  async function retire(input: {
    target: RetireTarget;
    principalId: string;
    idempotencyKey: string;
  }): Promise<{ changeSetId: string; undo(): Promise<void> }> {
    const { changeSets, authorize, outbox } = deps;
    const forgetRemovedPost = deps.ports.post?.forgetRemoved;
    const removePost = deps.ports.post?.remove;
    if (!changeSets || !authorize || !outbox || !postRepo || !forgetRemovedPost || !removePost) {
      throw new Error(
        `publish-content: ${entityType}.retire() requires PublishContentDeps.changeSets/authorize/` +
          "outbox and ports.post.repo/forgetRemoved/remove — wire them from the real apply-loop " +
          "composition root (features/publish-content/apply-loop.ts)."
      );
    }
    const gatewayDeps = { clock: deps.clock, idGen: deps.idGen, changeSets, outbox, authorize };
    const actor = { id: input.principalId, kind: "user" as const };
    const { target } = input;

    let holder: PostRecord | null = null;

    const undoRetire = async () => {
      if (!holder) return;
      await restorePostForward({
        deps: { repo: postRepo, clock: deps.clock, outbox, forgetRemoved: forgetRemovedPost },
        input: { prior: holder, actorId: input.principalId },
      });
    };

    const { changeSetId } = await executeCommand({
      deps: gatewayDeps,
      command: {
        workspaceId: deps.workspaceId,
        actor,
        summary: `Retire ${target.entityType} '${target.entityId}' for publish overwrite`,
        permission: "content.write",
        idempotencyKey: input.idempotencyKey,
      },
      mutation: {
        entityType: target.entityType,
        entityId: target.entityId,
        operation: "delete",
        captureInverse: async () => {
          holder = await postRepo.findById({ workspaceId: deps.workspaceId, id: target.entityId });
          if (!holder) {
            throw new PostNotFoundError(`${target.entityType} '${target.entityId}' was not found`);
          }
          // The apply loop's own re-check runs before this read, outside any lock; checking the
          // hash again here, on the row whose version `execute` pins, closes that gap.
          if (contentHash(holder.kind, toPublishableState(holder)) !== target.hash) {
            throw new PostConflictError(`the live ${target.entityType} at this address changed after this run's plan was built`);
          }
          return { deletedAt: holder.deletedAt ?? null };
        },
        execute: () =>
          retirePostForReplacement({
            deps: { repo: postRepo, clock: deps.clock, outbox, remove: removePost },
            input: {
              workspaceId: deps.workspaceId,
              id: target.entityId,
              expectedVersion: holder!.version,
              today: todayStamp(deps.clock.nowIso()),
              actorId: input.principalId,
            },
          }),
        captureEntityVersion: (result) => result.post.version,
        rollback: undoRetire,
      },
    });

    return { changeSetId, undo: undoRetire };
  }

  return {
    entityType,
    schemaVersion,
    permission: "content.write",
    dependsOn: POST_AND_PAGE_DEPENDS_ON,
    pack,
    inspect,
    precheck,
    apply,
    planRetire,
    retire,
  };
}

/**
 * `yyyymmdd` from an ISO clock reading — {@link retirePostForReplacement}'s own `today` input shape
 * (`post.ts`'s own doc: "supplied by the caller rather than derived from `deps.clock.nowIso()`'s ISO
 * format"). The one place that derivation happens, so `retire()` above stays a pure caller of it.
 */
function todayStamp(nowIso: string): string {
  return nowIso.slice(0, 10).replace(/-/g, "");
}

/**
 * `post`'s publish-content contribution. Resolves to `content.write` — the SAME permission
 * `content_post_create`/`content_post_update` already declare (no new permission invented for this
 * feature, mirroring `contributePostDuplicateHandlers`'s identical reasoning).
 *
 * Called from a composition root (`server/runtime/composition/publish-content-manifest.ts`), NOT
 * from within `features/post` itself — see this file's own header.
 */
export function contributePostPublish(): PublishContentContributor {
  return { entityType: "post", dependsOn: POST_AND_PAGE_DEPENDS_ON, build: (deps) => buildHandler(deps, "post") };
}

/**
 * `page`'s publish-content contribution — same table, same repo, same handler shape as
 * {@link contributePostPublish}, distinguished only by `PostKind`. See that function's own doc.
 */
export function contributePagePublish(): PublishContentContributor {
  return { entityType: "page", dependsOn: POST_AND_PAGE_DEPENDS_ON, build: (deps) => buildHandler(deps, "page") };
}
