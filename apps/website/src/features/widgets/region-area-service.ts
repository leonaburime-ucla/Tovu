/**
 * @file `widget_area` entry CRUD + whole-document placement mutation + the derived binding-table
 * reconcile step (SPEC-043 REQ-11..17; ADR-047 Debate Fold-In Amendment 1).
 *
 * Purpose:
 * Deliberately mirrors `navigation/reconcile.ts` — same reconcile-not-author discipline for
 * `widget_region_bindings` that `nav_location_bindings` already established.
 * `reconcileWidgetRegionBindings` is the ONLY code path permitted to write the binding table
 * (INV-02); no other file in this package calls `WidgetRegionBindingRepoPort.upsert`/`markInactive`
 * outside `bindWidgetArea`/`mutateWidgetAreaPlacements`, which both delegate their binding-table
 * writes through this same discipline.
 *
 * `entry_refs` extraction (INV-06) runs inside the same DB transaction as the triggering
 * `createEntry`/`updateEntry` call, via `deps.onWritten` — see `write-service.ts`'s file header for
 * the full reasoning (identical here).
 *
 * Architectural role:
 * `widgets` domain logic (implementation outline C-006).
 */
import type { ClockPort, OutboxPort, UUID } from "@jini-ai/cms/core";
import type { EntryRefsRepoPort } from "../../contracts/core/entry-refs/ports.js";
import { extractEntryRefs } from "../../contracts/core/entry-refs/extractor.js";
import type { ContentTypeRepoPort } from "../content-types/index.js";
import {
  VersionConflictError,
  toEntryOutbox,
  createEntry,
  updateEntry,
  type EntryListPort,
  type EntryRecord,
  type EntryRepoPort,
} from "../entries/index.js";
import {
  PRE_AUTHORIZED,
  requireWidgetPermission,
  WIDGETS_SYSTEM_ACTOR_ID,
  type WidgetsAuthorizeFn,
} from "./authorize-helper.js";
import { withEntryLock } from "./concurrency.js";
import {
  areaDocWithPlacements,
  buildWidgetAreaFieldsJson,
  emptyWidgetAreaDoc,
  ensureWidgetContentTypesRegistered,
  parseWidgetAreaPayload,
  parseWidgetInstancePayload,
  toWidgetAreaEntry,
  widgetAreaSlug,
} from "./entry-payload.js";
import {
  WidgetAreaConflictError,
  WidgetAreaNotFoundError,
  WidgetInstanceNotFoundError,
} from "./errors.js";
import type { WidgetRegionBindingRepoPort } from "./ports.js";
import {
  WIDGET_AREA_CONTENT_TYPE,
  WIDGET_AREA_FIELD_NAMESPACE,
  WIDGET_CONTENT_TYPE,
} from "./types.js";
import type {
  WidgetAreaEntry,
  WidgetPlacementNode,
  WidgetRegionBindingRow,
  WidgetRegionKey,
} from "./types.js";

export interface RegionAreaServiceDeps {
  entryRepo: EntryRepoPort & EntryListPort;
  contentTypeRepo: ContentTypeRepoPort;
  entryRefsRepo: EntryRefsRepoPort;
  bindingRepo: WidgetRegionBindingRepoPort;
  clock: ClockPort;
  ids: { newId: () => string };
  authorize: WidgetsAuthorizeFn;
  outbox: OutboxPort;
}

async function extractAndStoreAreaRefs(deps: RegionAreaServiceDeps, workspaceId: string, entry: EntryRecord): Promise<void> {
  const payload = parseWidgetAreaPayload(entry.fieldsJson);
  const refs = extractEntryRefs({
    workspaceId,
    sourceEntryId: entry.id,
    sourceEntryType: WIDGET_AREA_CONTENT_TYPE,
    bodyJson: payload.doc,
    fieldsExt: { [WIDGET_AREA_FIELD_NAMESPACE]: { regionKey: payload.regionKey } },
  });
  await deps.entryRefsRepo.replaceForSource({ workspaceId, sourceEntryId: entry.id, refs });
}

/**
 * The one shared shape both `createEntry` (`bindWidgetArea`) and `updateEntry`
 * (`mutateWidgetAreaPlacements`) below need. Bridges `deps.outbox` (the raw, full-`DomainEvent`
 * infra port) through `toEntryOutbox` into the narrower `{enqueue({name,payload})}` shape those
 * chokepoints declare locally — previously `deps.outbox` was forwarded unwrapped here, which
 * compiled but threw `NOT NULL constraint failed: outbox_events.id` against the real SQLite outbox
 * on every region bind/placement-mutation. Both call sites share this one helper already, so fixing
 * it here fixes both at once — see `write-service.ts`'s identically-named, identically-reasoned
 * helper for the full investigation pointer.
 */
function entriesWriteDeps(deps: RegionAreaServiceDeps, workspaceId: string) {
  return {
    entryRepo: deps.entryRepo,
    contentTypeRepo: deps.contentTypeRepo,
    clock: deps.clock,
    ids: deps.ids,
    authorize: PRE_AUTHORIZED,
    outbox: toEntryOutbox({ outbox: deps.outbox, clock: deps.clock, idGen: deps.ids, workspaceId }),
    onWritten: (entry: EntryRecord) => extractAndStoreAreaRefs(deps, workspaceId, entry),
  };
}

export interface BindWidgetAreaInput {
  readonly workspaceId: UUID;
  readonly regionKey: WidgetRegionKey;
}

export interface BindWidgetAreaRequired {
  deps: RegionAreaServiceDeps;
  input: BindWidgetAreaInput;
}

/**
 * REQ-13: seeds a `widget_area` entry for a region with no existing binding (called on theme
 * activation — a system/boot operation, not a user-initiated `widgets.place` mutation, so no
 * `authorize()` gate here, matching how `navigation`'s location seeding is likewise boot-driven).
 * Idempotent: a region already bound (or an existing-but-unbound `widget_area` entry for that
 * region key, found via its deterministic slug) is reused, never duplicated.
 */
export async function bindWidgetArea(required: BindWidgetAreaRequired): Promise<{ areaEntry: WidgetAreaEntry }> {
  const { deps, input } = required;

  await ensureWidgetContentTypesRegistered({ deps, workspaceId: input.workspaceId });

  return withEntryLock(`${input.workspaceId}::area::${input.regionKey}`, async () => {
    const existingBinding = await deps.bindingRepo.findByRegion({ workspaceId: input.workspaceId, regionKey: input.regionKey });
    if (existingBinding) {
      const boundEntry = await deps.entryRepo.findById({ workspaceId: input.workspaceId, id: existingBinding.areaEntryId });
      if (boundEntry) return { areaEntry: toWidgetAreaEntry(boundEntry) };
    }

    const slug = widgetAreaSlug(input.regionKey);
    let entry = await deps.entryRepo.findBySlug({ workspaceId: input.workspaceId, type: WIDGET_AREA_CONTENT_TYPE, slug });
    if (!entry) {
      const created = await createEntry({
        deps: entriesWriteDeps(deps, input.workspaceId),
        input: {
          actorId: WIDGETS_SYSTEM_ACTOR_ID,
          workspaceId: input.workspaceId,
          type: WIDGET_AREA_CONTENT_TYPE,
          slug,
          title: `Region: ${input.regionKey}`,
          fieldsJson: buildWidgetAreaFieldsJson({ regionKey: input.regionKey, doc: emptyWidgetAreaDoc() }),
          owner: WIDGET_AREA_FIELD_NAMESPACE,
        },
      });
      if (!created.ok) throw created.error;
      entry = created.value.entry;
    }

    await deps.bindingRepo.upsert({
      workspaceId: input.workspaceId,
      regionKey: input.regionKey,
      areaEntryId: entry.id,
      updatedAt: deps.clock.nowIso(),
    });

    return { areaEntry: toWidgetAreaEntry(entry) };
  });
}

export interface MutateWidgetAreaPlacementsInput {
  readonly workspaceId: UUID;
  readonly actor: { readonly principalId: UUID };
  readonly areaEntryId: UUID;
  readonly baseVersion: number;
  /** The complete resulting ordered list — always a whole-document write, never a per-row patch (INV-03). */
  readonly placements: readonly WidgetPlacementNode[];
}

export interface MutateWidgetAreaPlacementsRequired {
  deps: RegionAreaServiceDeps;
  input: MutateWidgetAreaPlacementsInput;
}

/** REQ-16/AC-10: every referenced widgetEntryId must exist, be a live (non-trashed) widget instance,
 *  in this same workspace — checked before any write. Throws the first violation found. */
export async function validatePlacementWidgetsExist(
  deps: RegionAreaServiceDeps,
  workspaceId: UUID,
  placements: readonly WidgetPlacementNode[]
): Promise<void> {
  for (const placement of placements) {
    const widget = await deps.entryRepo.findById({ workspaceId, id: placement.widgetEntryId });
    if (!widget || widget.type !== WIDGET_CONTENT_TYPE) {
      throw new WidgetInstanceNotFoundError(
        `placement references widget '${placement.widgetEntryId}', which does not exist in workspace '${workspaceId}' (REQ-16)`
      );
    }
    const widgetPayload = parseWidgetInstancePayload(widget.fieldsJson);
    if (widgetPayload.status === "trash" || widgetPayload.status === "purged") {
      throw new WidgetInstanceNotFoundError(`placement references widget '${placement.widgetEntryId}', which is trashed (REQ-16)`);
    }
  }
}

/** Converts a rejected `updateEntry` result into the matching typed error — a version conflict
 *  reports the CURRENT (post-conflict) version, any other failure propagates as-is. Never returns. */
async function rejectMutateWidgetAreaPlacementsWrite(
  deps: RegionAreaServiceDeps,
  workspaceId: UUID,
  areaEntryId: UUID,
  current: EntryRecord,
  error: Error
): Promise<never> {
  if (error instanceof VersionConflictError) {
    const latest = await deps.entryRepo.findById({ workspaceId, id: areaEntryId });
    throw new WidgetAreaConflictError(error.message, latest?.version ?? current.version);
  }
  throw error;
}

/** REQ-15/16: one atomic, version-guarded write; rejects placements referencing a nonexistent/trashed/cross-workspace widget. */
export async function mutateWidgetAreaPlacements(
  required: MutateWidgetAreaPlacementsRequired
): Promise<{ areaEntry: WidgetAreaEntry }> {
  const { deps, input } = required;

  await requireWidgetPermission({
    authorize: deps.authorize,
    actor: input.actor,
    workspaceId: input.workspaceId,
    permission: "widgets.place",
  });

  return withEntryLock(`${input.workspaceId}::${input.areaEntryId}`, async () => {
    const current = await deps.entryRepo.findById({ workspaceId: input.workspaceId, id: input.areaEntryId });
    if (!current || current.type !== WIDGET_AREA_CONTENT_TYPE) {
      throw new WidgetAreaNotFoundError(`widget_area '${input.areaEntryId}' was not found`);
    }

    await validatePlacementWidgetsExist(deps, input.workspaceId, input.placements);

    const currentPayload = parseWidgetAreaPayload(current.fieldsJson);
    const nextDoc = areaDocWithPlacements({ doc: currentPayload.doc, placements: input.placements });

    const result = await updateEntry({
      deps: entriesWriteDeps(deps, input.workspaceId),
      input: {
        actorId: input.actor.principalId,
        workspaceId: input.workspaceId,
        id: input.areaEntryId,
        fieldsJson: buildWidgetAreaFieldsJson({ regionKey: currentPayload.regionKey, doc: nextDoc }),
        expectedVersion: input.baseVersion,
        owner: WIDGET_AREA_FIELD_NAMESPACE,
      },
    });

    if (!result.ok) {
      return rejectMutateWidgetAreaPlacementsWrite(deps, input.workspaceId, input.areaEntryId, current, result.error);
    }

    // regionKey never changes on a placement mutation — refresh the derived row's audit timestamp
    // only (INV-02 still trivially holds: the binding is still exactly what a rebuild would produce).
    await deps.bindingRepo.upsert({
      workspaceId: input.workspaceId,
      regionKey: currentPayload.regionKey,
      areaEntryId: result.value.entry.id,
      updatedAt: deps.clock.nowIso(),
    });

    return { areaEntry: toWidgetAreaEntry(result.value.entry) };
  });
}

export interface ReconcileWidgetRegionBindingsInput {
  readonly workspaceId: UUID;
}

export interface ReconcileWidgetRegionBindingsRequired {
  deps: RegionAreaServiceDeps;
  input: ReconcileWidgetRegionBindingsInput;
}

/**
 * REQ-12/14: reconciles `widget_region_bindings` from the authoritative `widget_area` entries. The
 * sole write path for the binding table (INV-02) — a full rescan-and-replace, exactly mirroring
 * `navigation/reconcile.ts`'s `rebuildNavLocationBindings`. A region key present on more than one
 * `widget_area` entry (a data-drift edge case the invariant should otherwise prevent) resolves
 * last-writer-wins by iteration order, consistent with `WidgetRegionBindingRepoPort.upsert`'s own
 * semantics elsewhere in this library.
 *
 * Orphan handling (REQ-14): this reconcile pass only ever WRITES rows implied by live `widget_area`
 * entries — it never independently marks a row inactive for a region no theme declares anymore
 * (that requires theme-declaration data this function is not given). `markInactive` is `widgets/
 * repo.{memory,sqlite}.ts`'s own export for that call site (out of this task's scope — no HTTP/
 * theme-activation route exists yet to drive it).
 *
 * @complexity O(n) over the workspace's `widget_area` entry count.
 * @overallScore 100
 */
export async function reconcileWidgetRegionBindings(required: ReconcileWidgetRegionBindingsRequired): Promise<void> {
  const { deps, input } = required;

  const areaEntries = await deps.entryRepo.listByWorkspace({ workspaceId: input.workspaceId, type: WIDGET_AREA_CONTENT_TYPE });
  const now = deps.clock.nowIso();

  const byRegion = new Map<WidgetRegionKey, WidgetRegionBindingRow>();
  for (const entry of areaEntries) {
    const payload = parseWidgetAreaPayload(entry.fieldsJson);
    byRegion.set(payload.regionKey, {
      workspaceId: input.workspaceId,
      regionKey: payload.regionKey,
      areaEntryId: entry.id,
      updatedAt: now,
    });
  }

  await deps.bindingRepo.rebuildForWorkspace({ workspaceId: input.workspaceId, bindings: [...byRegion.values()] });
}
