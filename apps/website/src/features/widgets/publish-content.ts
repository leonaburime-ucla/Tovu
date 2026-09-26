import { createRepoPublishHandler, gatewayDeps, type RepoWriteContext } from "#src/features/publish-content/repo-handler";
import type { PublishContentContributor, WidgetPublishPorts } from "#src/features/publish-content/type-registry";

import { ContentTypeNotActiveError, EntryFieldValidationError, EntrySlugConflictError, VersionConflictError, type EntryRecord } from "../entries/index.js";
import { validateWidgetConfig } from "./config-validation.js";
import { parseWidgetAreaPayload, parseWidgetInstancePayload } from "./entry-payload.js";
import {
  WidgetAreaConflictError,
  WidgetAreaNotFoundError,
  WidgetConfigValidationError,
  WidgetForbiddenError,
  WidgetInstanceNotFoundError,
  WidgetTypeUnregisteredError,
  WidgetVersionConflictError,
} from "./errors.js";
import { bindWidgetArea, mutateWidgetAreaPlacements, reconcileWidgetRegionBindings } from "./region-area-service.js";
import { findWidgetTypeRegistration } from "./registry.js";
import { WIDGET_AREA_CONTENT_TYPE, WIDGET_CONTENT_TYPE } from "./types.js";
import type { WidgetInstanceStatus, WidgetPlacementNode, WidgetRegionKey, WidgetTypeKey } from "./types.js";
import { importWidgetInstance } from "./write-service.js";

/**
 * @file `widget` and `widget-area` on the publish factory.
 *
 * - `widget`: one `type='widget'` entry, keeping the source id (placements name it), addressed by
 *   slug. Packs the decoded payload (`widgetType`, `config`), not the stored JSON string, so key order
 *   never reads as a change. Only `active` instances outside the Trash travel. `dependsOn` is empty:
 *   config is schema-checked at write time, but the ids inside it (menu, form, media) resolve at render.
 * - `widget-area`: one region's placements, keyed by `regionKey` (each instance owns its own area
 *   row, so the entry id stays local). The whole placement list replaces the destination's through
 *   `mutateWidgetAreaPlacements` (version-guarded, checks every placed widget is live), then the
 *   region bindings are rebuilt.
 */

/** The widgets write-service deps for one apply. */
function serviceDeps(ctx: RepoWriteContext<unknown, WidgetPublishPorts>, entityType: string) {
  const { deps, ports } = ctx;
  const gateway = gatewayDeps(deps, entityType);
  return {
    entryRepo: ports.entries,
    contentTypeRepo: ports.contentTypes,
    entryRefsRepo: ports.entryRefs,
    bindingRepo: ports.bindings,
    clock: deps.clock,
    ids: deps.idGen,
    authorize: gateway.authorize,
    outbox: gateway.outbox,
  };
}

interface WidgetRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly widgetType: WidgetTypeKey;
  readonly config: Record<string, unknown>;
  readonly status: WidgetInstanceStatus;
  readonly version: number;
  readonly deletedAt: string | null;
}

function toWidgetRow(entry: EntryRecord & { deletedAt?: string | null }): WidgetRow {
  const { widgetType, config, status } = parseWidgetInstancePayload(entry.fieldsJson);
  return { id: entry.id, slug: entry.slug, title: entry.title, widgetType, config, status, version: entry.version, deletedAt: entry.deletedAt ?? null };
}

export const contributeWidgetPublish = (): PublishContentContributor =>
  createRepoPublishHandler<WidgetRow, WidgetPublishPorts>({
    entityType: "widget",
    permission: "widgets.update",
    ports: (deps) => deps.ports.widget,
    list: async (p, workspaceId) => (await p.entries.listByWorkspace({ workspaceId, type: WIDGET_CONTENT_TYPE })).map(toWidgetRow),
    find: async (p, workspaceId, id) => {
      const row = await p.entries.findAnyById({ workspaceId, id });
      return row && row.type === WIDGET_CONTENT_TYPE ? toWidgetRow(row) : null;
    },
    // A legacy `trash`/`purged` payload is trashed too (the Trash adopts those rows over time).
    isTrashed: (row) => row.deletedAt !== null || row.status !== "active",
    fields: {
      slug: "transferred",
      title: "transferred",
      widgetType: "transferred",
      config: "transferred",
      id: "local",
      status: "local",
      version: "local",
      deletedAt: "local",
    },
    address: {
      field: "slug",
      holder: async (p, workspaceId, slug) => {
        const row = await p.entries.findBySlug({ workspaceId, type: WIDGET_CONTENT_TYPE, slug });
        return row ? toWidgetRow(row) : null;
      },
    },
    validate: async ({ entity }) => {
      const widgetType = entity.state.widgetType as WidgetTypeKey;
      const registration = findWidgetTypeRegistration(widgetType);
      if (!registration) return `widget '${entity.id}': widget type '${widgetType}' is not installed on the destination`;
      const check = validateWidgetConfig({ schema: registration.configSchema, config: entity.state.config as Record<string, unknown> });
      return check.valid ? null : `widget '${entity.id}': its settings do not fit the destination's '${widgetType}' widget`;
    },
    write: async (ctx) => {
      const { id, state, expectedVersion, principalId, workspaceId } = ctx;
      const { instance } = await importWidgetInstance({
        deps: serviceDeps(ctx, "widget"),
        input: {
          workspaceId,
          actor: { principalId },
          id,
          slug: state.slug as string,
          title: state.title as string,
          widgetType: state.widgetType as WidgetTypeKey,
          config: state.config as Record<string, unknown>,
          expectedVersion,
        },
      });
      return { version: instance.version };
    },
    errors: {
      conflict: [VersionConflictError, WidgetVersionConflictError],
      blocked: [WidgetForbiddenError, WidgetTypeUnregisteredError, WidgetConfigValidationError, EntrySlugConflictError, EntryFieldValidationError, ContentTypeNotActiveError],
    },
  });

interface WidgetAreaRow {
  readonly regionKey: WidgetRegionKey;
  readonly placements: readonly WidgetPlacementNode[];
  readonly schemaVersion: number;
  readonly areaEntryId: string;
  readonly version: number;
}

/** One row per region; a region on two area entries resolves last-wins, as the binding rebuild does. */
async function listAreas(p: WidgetPublishPorts, workspaceId: string): Promise<WidgetAreaRow[]> {
  const byRegion = new Map<string, WidgetAreaRow>();
  for (const entry of await p.entries.listByWorkspace({ workspaceId, type: WIDGET_AREA_CONTENT_TYPE })) {
    const { regionKey, doc } = parseWidgetAreaPayload(entry.fieldsJson);
    byRegion.set(regionKey, { regionKey, placements: doc.placements, schemaVersion: doc.schemaVersion, areaEntryId: entry.id, version: entry.version });
  }
  return [...byRegion.values()];
}

export const contributeWidgetAreaPublish = (): PublishContentContributor =>
  createRepoPublishHandler<WidgetAreaRow, WidgetPublishPorts>({
    entityType: "widget-area",
    permission: "widgets.place",
    dependsOn: ["widget"],
    ports: (deps) => deps.ports["widget-area"],
    list: listAreas,
    find: async (p, workspaceId, regionKey) => (await listAreas(p, workspaceId)).find((row) => row.regionKey === regionKey) ?? null,
    idOf: (row) => row.regionKey,
    fields: {
      regionKey: "transferred",
      placements: "transferred",
      // Always 1; `mutateWidgetAreaPlacements` keeps the destination's own.
      schemaVersion: "provenance",
      areaEntryId: "local",
      version: "local",
    },
    write: async (ctx) => {
      const { state, existing, expectedVersion, principalId, workspaceId } = ctx;
      const deps = serviceDeps(ctx, "widget-area");
      const regionKey = state.regionKey as WidgetRegionKey;
      const area = existing
        ? { id: existing.areaEntryId, version: expectedVersion as number }
        : (await bindWidgetArea({ deps, input: { workspaceId, regionKey } })).areaEntry;
      const { areaEntry } = await mutateWidgetAreaPlacements({
        deps,
        input: { workspaceId, actor: { principalId }, areaEntryId: area.id, baseVersion: area.version, placements: state.placements as WidgetPlacementNode[] },
      });
      await reconcileWidgetRegionBindings({ deps, input: { workspaceId } });
      return { version: areaEntry.version };
    },
    errors: {
      conflict: [VersionConflictError, WidgetAreaConflictError],
      blocked: [WidgetForbiddenError, WidgetInstanceNotFoundError, WidgetAreaNotFoundError, EntrySlugConflictError],
    },
  });
