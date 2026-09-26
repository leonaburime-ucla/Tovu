import { executeCommand, ForbiddenError } from "@jini-ai/cms/core";
import type { AuthorizeFn, ChangeSetRepoPort, JsonObject, OutboxPort } from "@jini-ai/cms/core";

import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import { contentHash, CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import type {
  EntityReplacement,
  PackedEntity,
  PublishContentContributor,
  PublishContentDeps,
  PublishContentHandler,
  ReferenceHolder,
  RepointResult,
} from "#src/features/publish-content/type-registry";

import { importMenuEntity } from "./import-menu.js";
import type { ImportMenuEntityDeps } from "./import-menu.js";
import { menuHoldersReferencing, repointMenuItems } from "./repoint-menu-refs.js";
import type { MenuRepointReplacement } from "./repoint-menu-refs.js";
import { MenuConflictError, MenuNotFoundError, MenuValidationError, updateMenuTree, validateAndCloneTree } from "./index.js";
import type { MenuRepoPort, MenuStatus, NavMenuDoc, NavMenuEntry } from "./index.js";

/**
 * @file S3 of `ADS-memory/.local-artifacts/publish-types-plan-2026-09-24.md` — `menu`'s
 * publish-content contribution. Mirrors `features/redirects/publish-content.ts` (S2) and
 * `features/post/publish-content.ts` exactly in shape: a DATA export (`{entityType, dependsOn,
 * build}`) importing only `type-registry.ts`'s TYPES, never `registerPublishContentContributor`
 * itself — see that file's header for why a value edge here would reopen a real module cycle.
 *
 * Design worked out in `ADS-memory/.local-artifacts/handoffs/2026-09-24-c7-publish-types-build.md`
 * §S3 pointer and `publish-types-plan-2026-09-24.md` §3's `menu` bullet before this file was typed
 * in; corrections made while implementing are disclosed below.
 *
 * ## Identity: the menu's OWN id, not a natural key
 *
 * Unlike `redirect` (S2), menu ids are SHARED across instances seeded from the same
 * `content.seed.db` (`menu-header-nav`, `menu-footer-nav`, four others), and a newly-created menu on
 * the source keeps that id when it travels. `PackedEntity.id` is therefore the menu's real `id`,
 * exactly like `post`/`page`/`media` — no natural-key indirection to parse.
 *
 * ## `apply()` writes through `importMenuEntity` (`./import-menu.ts`), a THIRD write path
 *
 * Jini's own `createMenu` mints its own id (`menu-service.ts:337-352`) and is unusable here;
 * `updateMenuTree` cannot create a row that does not exist yet. `importMenuEntity` is the
 * id-preserving, OCC-gated replacement — see its own file header for the full design, including why
 * it reimplements `assignLocation`'s binding-index half rather than calling it per-location (calling
 * it as literally described would introduce a redundant-resave defect: N extra menu saves/version
 * bumps/outbox events for one incoming record).
 *
 * No `executeCommand` wrapping: like `redirect` (S2's own disclosed note) and unlike `post`/`media`,
 * menus have no real command-gateway write path yet — `menu-service.ts`'s own header says so
 * explicitly ("that gateway is not implemented as running code yet ... called directly for now"), so
 * there is nothing to wrap into.
 *
 * ## Disclosed limitation: a trashed DESTINATION row cannot be distinguished from an absent one
 *
 * The design record's precheck bullet asks for "destination row trashed → blocked". `MenuRepoPort`
 * (unlike `PostRepoPort`, which is deliberately trash-blind — see `post.ts`'s `isTrashed`) HIDES a
 * trashed row at the port/adapter level for every real adapter: `repo.sqlite.ts`'s `NOT_TRASHED`
 * scopes `findById`/`findBySlug`/`list`, and `trash-aware-memory-menu-repo.ts` filters identically —
 * `findById` on a trashed destination id returns `null`, indistinguishable from "no such row". The
 * one seam that CAN see a trashed row (`findByIdIncludingTrashed`, `menu-trash-follow-ups.ts`'s
 * `MenuTrashLookup`) is not implemented by `TrashAwareInMemoryMenuRepo` (the hermetic composition
 * root's adapter, `server/runtime/composition/app.ts`) at all — typing this contributor's `menuRepo`
 * dependency to require it would fail to compile against that root, not just degrade gracefully.
 *
 * This is SAFE, not silently dangerous: every real adapter's own `.save()` independently refuses to
 * revive a trashed row at the storage layer (`repo.sqlite.ts`'s `setWhere: NOT_TRASHED`,
 * `trash-aware-memory-menu-repo.ts`'s explicit `status === "trash"` no-op guard) — a trashed
 * destination id structurally cannot be resurrected by a publish even without an explicit precheck
 * branch for it. The gap this leaves is only in the OPERATOR-FACING reason string: such a row plans
 * as `created` (since `inspect()` also sees `null`) and applies as a silent no-op rather than a
 * `blocked: destination is in the trash` explanation. Flagged here as a disclosed, narrow deviation
 * and a follow-up for whichever slice threads a trash-aware read into every composition root's menu
 * repo consistently — not a Sonnet-slice call on its own.
 *
 * ## `dependsOn: ["post", "page"]`
 *
 * Menu items may target a page/post id (`entryRef`). The resolver (`Jini/.../navigation/resolver.ts`)
 * already degrades a missing target to `available: false` rather than blocking resolution or this
 * publish (its own header; `precheck` below does not validate ref targets for the identical reason),
 * so this ordering is a best-effort freshness improvement — apply posts/pages first so most refs
 * resolve immediately after a full sync — not a correctness requirement `apply()` depends on.
 */

const MENU_DEPENDS_ON: readonly string[] = ["post", "page"];

/**
 * Every `NavMenuEntry` field, classified by what this transport does with it — same
 * defect-prevention reasoning as `POST_FIELD_DISPOSITIONS`/`REDIRECT_FIELD_DISPOSITIONS` (those
 * files' own docs): a field hashed but not actually written back by `importMenuEntity` would make
 * `planner.ts`'s `destination.hash === entity.contentHash` never agree, permanently reporting an
 * unchanged menu as `conflict`. `NavMenuEntry` carries no authorship/provenance field at all (no
 * `createdAt`/`createdBy*`, unlike `PostRecord`/`RedirectRecord`), so this map has only two buckets.
 */
const MENU_FIELD_DISPOSITIONS: Record<keyof NavMenuEntry, "transferred" | "local"> = {
  slug: "transferred",
  title: "transferred",
  status: "transferred",
  doc: "transferred",
  locations: "transferred",

  id: "local",
  workspaceId: "local",
  updatedAt: "local",
  version: "local",
};

/** The wire AND hash field set — identical for `menu` today (no provenance bucket exists to split
 *  them apart), derived from {@link MENU_FIELD_DISPOSITIONS} so the two can never silently drift. */
const TRANSFERRED_MENU_FIELDS = Object.freeze(
  (Object.keys(MENU_FIELD_DISPOSITIONS) as Array<keyof NavMenuEntry>).filter(
    (field) => MENU_FIELD_DISPOSITIONS[field] === "transferred"
  )
);

/** The wire shape of a packed menu: {@link TRANSFERRED_MENU_FIELDS}, nothing else — used for both
 *  `PackedEntity.state` and the hash input (see this file's header for why the two sets coincide).
 *  @complexity O(1) — a fixed field count. */
function toMenuState(record: NavMenuEntry): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const field of TRANSFERRED_MENU_FIELDS) {
    state[field] = record[field] ?? null;
  }
  return state;
}

/** Maps a thrown chokepoint refusal to the per-row downgrade `apply-loop.ts` recognizes, or passes a
 *  genuine fault through unchanged (never swallowed) — mirrors `features/redirects/publish-content
 *  .ts`'s identical "apply-time re-verification" reasoning: every one of these is an ordinary,
 *  expected outcome of publishing real-world data, not a programming error.
 *  @complexity O(1). */
function toApplyRowError(err: unknown): Error {
  if (err instanceof MenuConflictError || err instanceof MenuNotFoundError) {
    return new PublishContentApplyRowError("conflict", err.message);
  }
  if (err instanceof MenuValidationError) {
    return new PublishContentApplyRowError("blocked", err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function buildHandler(deps: PublishContentDeps): PublishContentHandler {
  const entityType = "menu";
  const schemaVersion = 1;

  async function* pack(): AsyncIterable<PackedEntity> {
    // Absent `menuRepo` degrades to "nothing to export" — mirrors `features/redirects/
    // publish-content.ts`'s identical convention for a caller with no use for this type.
    const menuRepo = deps.ports.menu?.repo;
    if (!menuRepo) return;
    const rows = await menuRepo.list({ workspaceId: deps.workspaceId });
    for (const row of rows) {
      // Fail-closed skip: a trashed source menu never travels, so publishing can never export (and
      // therefore never resurrect, on any destination) trashed content — same reading
      // `features/post/publish-content.ts`'s own `pack()` applies to a trashed post.
      if (row.status === "trash") continue;
      const state = toMenuState(row);
      yield {
        entityType,
        id: row.id,
        schemaVersion,
        contentHash: contentHash(entityType, state),
        hashVersion: CONTENT_HASH_VERSION,
        requiredBlobs: [],
        state,
      };
    }
  }

  async function inspect(id: string): Promise<{ version: number; hash: string } | null> {
    const menuRepo = deps.ports.menu?.repo;
    if (!menuRepo) return null;
    const found = await menuRepo.findById({ workspaceId: deps.workspaceId, id });
    if (!found) return null;
    return { version: found.version, hash: contentHash(entityType, toMenuState(found)) };
  }

  /**
   * Pure precondition check — never writes. See this file's header for why a trashed destination
   * row is NOT one of the conditions checked here (a disclosed interface limitation, not an
   * oversight) and for why that omission is still safe.
   * @complexity O(1) repo calls plus {@link validateAndCloneTree}'s own O(n) tree walk.
   */
  async function precheck(entity: PackedEntity): Promise<string | null> {
    const menuRepo = deps.ports.menu?.repo;
    if (!menuRepo) return `menu entity '${entity.id}' cannot be prechecked — no menu port wired for this deps bag`;

    const state = entity.state;
    const slug = state.slug as string;
    const slugHolder = await menuRepo.findBySlug({ workspaceId: deps.workspaceId, slug });
    if (slugHolder && slugHolder.id !== entity.id) {
      return `menu slug '${slug}' is already held by a different menu ('${slugHolder.id}') at this destination`;
    }

    try {
      validateAndCloneTree((state.doc as NavMenuDoc).items);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return null;
  }

  /**
   * Applies ONE menu entity directly through `importMenuEntity` (`./import-menu.ts`) — see this
   * file's header for why that is a new, third write path rather than `createMenu`/`updateMenuTree`,
   * and why there is no `executeCommand` wrapping.
   * @complexity O(1) plus `importMenuEntity`'s own cost (bounded repo reads/writes — see its doc).
   */
  async function apply(input: {
    entity: PackedEntity;
    expectedVersion: number | undefined;
    principalId: string;
    idempotencyKey: string;
  }): Promise<{ changeSetId: string }> {
    const menuRepo = deps.ports.menu?.repo;
    const navLocationBindingRepo = deps.ports.menu?.bindingRepo;
    if (!menuRepo || !navLocationBindingRepo || !deps.outbox) {
      throw new Error(
        `publish-content: ${entityType}.apply() requires PublishContentDeps.ports.menu (repo, ` +
          "bindingRepo) and .outbox — wire them from the real apply-loop composition root " +
          "(features/publish-content/apply-loop.ts)."
      );
    }

    const state = input.entity.state;
    const record: NavMenuEntry = {
      id: input.entity.id,
      workspaceId: deps.workspaceId,
      slug: state.slug as string,
      title: state.title as string,
      status: state.status as MenuStatus,
      doc: state.doc as NavMenuDoc,
      locations: (state.locations as readonly string[] | undefined) ?? [],
      // Local write bookkeeping — never packed (see `MENU_FIELD_DISPOSITIONS`), and fully
      // recomputed inside `importMenuEntity`; these placeholders are never read back.
      updatedAt: deps.clock.nowIso(),
      version: 0,
    };

    const importDeps: ImportMenuEntityDeps = {
      clock: deps.clock,
      idGen: deps.idGen,
      repo: menuRepo,
      bindingRepo: navLocationBindingRepo,
      outbox: deps.outbox,
    };

    try {
      const { menu } = await importMenuEntity({
        deps: importDeps,
        input: { workspaceId: deps.workspaceId, record, expectedVersion: input.expectedVersion },
      });
      // Menus have no `change_sets` row of their own (no command-gateway write path yet — see this
      // file's header); `menu.id` is the best available per-row reference for the run's report, same
      // spirit as `redirect`'s own disclosed `record.id` choice.
      return { changeSetId: menu.id };
    } catch (err) {
      throw toApplyRowError(err);
    }
  }

  /**
   * R3 (`plan-publish-repoint-menus-2026-09-24.md` §2.1/§2.2) — read-only: every live menu with at
   * least one item, at any depth, whose `entryRef.entryId` is one of `ids`. Delegates the tree walk
   * to {@link menuHoldersReferencing} (`./repoint-menu-refs.js`) over a single `menuRepo.list()` read
   * — the planner (`planner.ts`) calls this at most once per plan, with every retire-target id
   * collected across the whole report, never once per row.
   * @complexity O(n) over every item across every live menu (n = total item count including
   * descendants) via {@link menuHoldersReferencing}, plus one repo list call.
   */
  async function referencesTo(ids: readonly string[]): Promise<readonly ReferenceHolder[]> {
    const menuRepo = deps.ports.menu?.repo;
    if (!menuRepo) return [];
    const menus = await menuRepo.list({ workspaceId: deps.workspaceId });
    return menuHoldersReferencing(menus, ids);
  }

  /**
   * R3 §2.3/§2.4 — the write side: for every live menu (from `menuRepo.list()`) not named in
   * `input.skipIds` that has at least one `entryRef` matching a replacement's `oldId`, rewrites those
   * links to the matching `newId` through `updateMenuTree`, wrapped in `executeCommand` exactly like
   * `retire()` (`features/post/publish-content.ts`) wraps its own domain write — one revertible,
   * audited change set per menu.
   *
   * A pre-check against the `menuRepo.list()` snapshot already in hand skips any menu with nothing to
   * change before spending a second repo round-trip on it. The actual write happens in
   * {@link repointOneMenu}, which re-reads that ONE menu fresh (never trusting this snapshot) so a
   * retry after a concurrency conflict sees whatever has actually landed. A failure repointing one
   * menu — a denied grant, an edit that keeps conflicting — never aborts the pass or throws: every
   * other menu is still attempted, and the failure becomes one line in
   * {@link RepointResult.notUpdated}, per this method's own contract (`type-registry.ts`) — the
   * content this run published already landed, so a repoint failure must only ever be reported, never
   * fail the run.
   *
   * @complexity O(m) items scanned across the `menuRepo.list()` snapshot for the pre-check (m = total
   * item count across live menus), plus up to 2 repo round-trips and one `executeCommand` per menu
   * that actually needs a write.
   */
  async function repointReferences(input: {
    replacements: readonly EntityReplacement[];
    skipIds: ReadonlySet<string>;
    principalId: string;
    runId: string;
  }): Promise<RepointResult> {
    const menuRepo = deps.ports.menu?.repo;
    const { changeSets, authorize, outbox } = deps;
    if (!menuRepo || !changeSets || !authorize || !outbox) {
      throw new Error(
        `publish-content: ${entityType}.repointReferences() requires PublishContentDeps.ports.menu.repo, ` +
          ".changeSets, .authorize and .outbox — wire them from the real apply-loop composition root " +
          "(features/publish-content/apply-loop.ts)."
      );
    }

    const replacementByOldId = new Map<string, MenuRepointReplacement>(
      input.replacements.map((replacement) => [replacement.oldId, { newId: replacement.newId, entityType: replacement.entityType }] as const)
    );

    const menus = await menuRepo.list({ workspaceId: deps.workspaceId });
    const changeSetIds: string[] = [];
    let linksUpdated = 0;
    const notUpdated: string[] = [];

    for (const menu of menus) {
      if (input.skipIds.has(menu.id)) continue;
      if (repointMenuItems(menu.doc.items, replacementByOldId).count === 0) continue;

      const outcome = await repointOneMenu({
        menuRepo,
        changeSets,
        authorize,
        outbox,
        menuId: menu.id,
        replacementByOldId,
        principalId: input.principalId,
        runId: input.runId,
      });
      if (outcome.kind === "written") {
        changeSetIds.push(outcome.changeSetId);
        linksUpdated += outcome.count;
      } else if (outcome.kind === "not-updated") {
        notUpdated.push(outcome.message);
      }
    }

    return { changeSetIds, linksUpdated, notUpdated };
  }

  /**
   * One menu's own repoint attempt, retried once on an optimistic-concurrency conflict. Each attempt
   * re-reads the menu FRESH (never the caller's `menuRepo.list()` snapshot) and recomputes the
   * repointed tree against that read, so a retry sees whatever landed since the previous attempt —
   * mirroring `retire()`'s (`features/post/publish-content.ts`) "fresh read right before the write"
   * discipline, one level up (per-attempt here, rather than inside `captureInverse` itself, since this
   * loop's retry needs the same fresh read to decide whether there is still anything to write).
   *
   * `MenuConflictError` on the first attempt retries once; a second conflict, or a `ForbiddenError`
   * from `executeCommand`'s own authorization gate (denying `admin.menus.update`), ends the attempt as
   * a {@link RepointResult.notUpdated} line rather than throwing — see {@link repointReferences}'s own
   * doc for why a repoint failure must never fail the surrounding publish run. Any other thrown error
   * is a genuine fault and is never swallowed.
   *
   * @complexity O(1) repo calls per attempt (bounded at 2 attempts) plus `repointMenuItems`'s own O(n)
   * tree walk (n = this one menu's item count) and `executeCommand`'s own cost.
   */
  async function repointOneMenu(input: {
    menuRepo: MenuRepoPort;
    changeSets: ChangeSetRepoPort;
    authorize: AuthorizeFn;
    outbox: OutboxPort;
    menuId: string;
    replacementByOldId: ReadonlyMap<string, MenuRepointReplacement>;
    principalId: string;
    runId: string;
  }): Promise<
    { kind: "written"; changeSetId: string; count: number } | { kind: "not-updated"; message: string } | { kind: "no-op" }
  > {
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const menu = await input.menuRepo.findById({ workspaceId: deps.workspaceId, id: input.menuId });
      if (!menu) return { kind: "no-op" }; // vanished since the snapshot — nothing left to repoint

      const repointed = repointMenuItems(menu.doc.items, input.replacementByOldId);
      if (repointed.count === 0) return { kind: "no-op" }; // already resolved (this attempt or a peer)

      const writeDeps = { repo: input.menuRepo, clock: deps.clock, idGen: deps.idGen, outbox: input.outbox };
      // The version `execute` wrote, so `rollback` can put the prior tree back under OCC.
      let writtenVersion: number | null = null;
      try {
        const { changeSetId } = await executeCommand({
          deps: { clock: deps.clock, idGen: deps.idGen, changeSets: input.changeSets, outbox: input.outbox, authorize: input.authorize },
          command: {
            workspaceId: deps.workspaceId,
            actor: { id: input.principalId, kind: "user" },
            summary: `Repoint menu '${menu.title}' links after publish run ${input.runId}`,
            permission: "admin.menus.update",
            idempotencyKey: `publish-content:v1:repoint:${input.runId}:${menu.id}`,
          },
          mutation: {
            entityType: "menu",
            entityId: menu.id,
            operation: "update",
            captureInverse: async () => ({ items: menu.doc.items } as unknown as JsonObject),
            execute: async () => {
              const written = await updateMenuTree({
                deps: writeDeps,
                input: { workspaceId: deps.workspaceId, id: menu.id, expectedVersion: menu.version, items: repointed.items },
              });
              writtenVersion = written.menu.version;
              return written;
            },
            captureEntityVersion: (result) => result.menu.version,
            // Compensating undo when the change-set record fails AFTER the write landed (INV-01: no
            // mutation without a record) — same role as `retire()`'s `rollback` in
            // `features/post/publish-content.ts`. Without it the menu stays repointed with no History
            // entry to revert, while the caller reports the links as not updated.
            rollback: async () => {
              if (writtenVersion === null) return;
              await updateMenuTree({
                deps: writeDeps,
                input: { workspaceId: deps.workspaceId, id: menu.id, expectedVersion: writtenVersion, items: menu.doc.items },
              });
            },
          },
        });
        return { kind: "written", changeSetId, count: repointed.count };
      } catch (err) {
        if (err instanceof MenuConflictError) {
          if (attempt >= MAX_ATTEMPTS) {
            return { kind: "not-updated", message: `Menu '${menu.title}' was not updated: it changed during publish.` };
          }
          continue; // one retry, against a fresh read at the top of the loop
        }
        if (err instanceof ForbiddenError) {
          return { kind: "not-updated", message: "Menu links were not updated: this publishing grant doesn't cover menus." };
        }
        throw err; // a genuine fault — never swallowed
      }
    }
    // Unreachable: the loop above always returns within MAX_ATTEMPTS iterations. Kept for TypeScript's
    // control-flow analysis, which cannot see that the last iteration always returns or continues.
    throw new Error("publish-content: menu.repointOneMenu() exhausted its retry loop without returning");
  }

  return {
    entityType,
    schemaVersion,
    // Menus' own existing write permission (`Jini/.../navigation/agent-tools.ts`,
    // `routes/admin/content/menus/*`) — never a flat transport-wide permission, per
    // `PublishContentHandler.permission`'s own contract.
    permission: "admin.menus.update",
    dependsOn: MENU_DEPENDS_ON,
    pack,
    inspect,
    precheck,
    apply,
    referencesTo,
    repointReferences,
  };
}

/**
 * `menu`'s publish-content contribution. Called from a composition root
 * (`server/runtime/composition/publish-content-manifest.ts`), NOT from within `features/navigation`
 * itself — see this file's header.
 */
export function contributeMenusPublish(): PublishContentContributor {
  return { entityType: "menu", dependsOn: MENU_DEPENDS_ON, build: buildHandler };
}
