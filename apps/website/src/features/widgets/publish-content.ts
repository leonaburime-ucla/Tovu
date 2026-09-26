import { collectPlacementReferences } from "#src/features/publish-content/content-references";
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
import { bindWidgetArea, mutateWidgetAreaPlacements, reconcileWidgetRegionBindings, validatePlacementWidgetsExist } from "./region-area-service.js";
import { findWidgetTypeRegistration } from "./registry.js";
import { WIDGET_AREA_CONTENT_TYPE, WIDGET_CONTENT_TYPE } from "./types.js";
import type { WidgetInstanceStatus, WidgetPlacementNode, WidgetRegionKey, WidgetTypeKey } from "./types.js";
import { importWidgetInstance } from "./write-service.js";

/**
 * @file `widget` and `widget-area` on the publish factory.
 *
 * - `widget`: one `type='widget'` entry, keeping the source id (placements name it), addressed by
 *   slug. Packs the decoded payload (`widgetType`, `config`), not the stored JSON string, so key order
 *   never reads as a change. Only `active` instances outside the Trash travel. Config is
 *   schema-checked at write time, but the ids inside it (menu, media) resolve at render.
 *   A `contact-form` widget's `formDefinitionId` is the exception: a form's id is minted per instance
 *   (forms travel by slug), so the packed config names the form by slug and the write turns it back
 *   into the destination's own id — hence `dependsOn: ["form"]`.
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

const FORM_REF = "formDefinitionId";

/** The ref-typed config fields (`registry.ts`'s `x-ref-target`) and the publish type each names: a
 *  form by slug (packed through {@link swapFormRef}), a menu and a term by id. */
const WIDGET_CONFIG_REFERENCES: Readonly<Record<string, string>> = { [FORM_REF]: "form", menuRef: "menu", categoryTermId: "term" };

/** Swaps a `contact-form` widget's form reference through `swap` (id to slug on pack, slug to id on
 *  write). A reference `swap` cannot resolve stays as it is, so a dangling one stays dangling on
 *  both sides and still hashes alike. */
async function swapFormRef(
  widgetType: WidgetTypeKey,
  config: Record<string, unknown>,
  swap: (ref: string) => Promise<string | undefined>
): Promise<Record<string, unknown>> {
  const ref = config[FORM_REF];
  if (widgetType !== "contact-form" || typeof ref !== "string") return config;
  return { ...config, [FORM_REF]: (await swap(ref)) ?? ref };
}

/** The row as it packs: its form reference as the form's slug. */
async function portableRow(p: WidgetPublishPorts, workspaceId: string, row: WidgetRow): Promise<WidgetRow> {
  const config = await swapFormRef(row.widgetType, row.config, async (id) => (await p.forms.findById({ workspaceId, id }))?.slug);
  return config === row.config ? row : { ...row, config };
}

export const contributeWidgetPublish = (): PublishContentContributor =>
  createRepoPublishHandler<WidgetRow, WidgetPublishPorts>({
    entityType: "widget",
    permission: "widgets.update",
    dependsOn: ["form"],
    ports: (deps) => deps.ports.widget,
    list: async (p, workspaceId) =>
      Promise.all((await p.entries.listByWorkspace({ workspaceId, type: WIDGET_CONTENT_TYPE })).map((entry) => portableRow(p, workspaceId, toWidgetRow(entry)))),
    find: async (p, workspaceId, id) => {
      const row = await p.entries.findAnyById({ workspaceId, id });
      return row && row.type === WIDGET_CONTENT_TYPE ? portableRow(p, workspaceId, toWidgetRow(row)) : null;
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
        // Trash included: a trashed widget keeps its slug.
        const row = await p.entries.findAnyBySlug({ workspaceId, type: WIDGET_CONTENT_TYPE, slug });
        return row ? toWidgetRow(row) : null;
      },
    },
    references: (entity) => {
      const config = (entity.state.config ?? {}) as Record<string, unknown>;
      return Object.entries(WIDGET_CONFIG_REFERENCES).flatMap(([field, entityType]) => {
        const key = config[field];
        return typeof key === "string" && key.length > 0 ? [{ entityType, key }] : [];
      });
    },
    validate: async ({ entity }) => {
      const widgetType = entity.state.widgetType as WidgetTypeKey;
      const registration = findWidgetTypeRegistration(widgetType);
      if (!registration) return `widget '${entity.id}': widget type '${widgetType}' is not installed on the destination`;
      const check = validateWidgetConfig({ schema: registration.configSchema, config: entity.state.config as Record<string, unknown> });
      return check.valid ? null : `widget '${entity.id}': its settings do not fit the destination's '${widgetType}' widget`;
    },
    write: async (ctx) => {
      const { id, state, expectedVersion, principalId, workspaceId, ports } = ctx;
      const widgetType = state.widgetType as WidgetTypeKey;
      const config = await swapFormRef(widgetType, state.config as Record<string, unknown>, async (slug) => (await ports.forms.findBySlug({ workspaceId, slug }))?.id);
      const { instance } = await importWidgetInstance({
        deps: serviceDeps(ctx, "widget"),
        input: {
          workspaceId,
          actor: { principalId },
          id,
          slug: state.slug as string,
          title: state.title as string,
          widgetType,
          config,
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
    references: (entity) => collectPlacementReferences(entity.state),
    write: async (ctx) => {
      const { state, existing, expectedVersion, principalId, workspaceId } = ctx;
      const deps = serviceDeps(ctx, "widget-area");
      const regionKey = state.regionKey as WidgetRegionKey;
      const placements = state.placements as WidgetPlacementNode[];
      // Before `bindWidgetArea`: a create that then failed this check would leave an empty area bound.
      await validatePlacementWidgetsExist(deps, workspaceId, placements);
      const area = existing
        ? { id: existing.areaEntryId, version: expectedVersion as number }
        : (await bindWidgetArea({ deps, input: { workspaceId, regionKey } })).areaEntry;
      const { areaEntry } = await mutateWidgetAreaPlacements({
        deps,
        input: { workspaceId, actor: { principalId }, areaEntryId: area.id, baseVersion: area.version, placements },
      });
      await reconcileWidgetRegionBindings({ deps, input: { workspaceId } });
      return { version: areaEntry.version };
    },
    errors: {
      conflict: [VersionConflictError, WidgetAreaConflictError],
      blocked: [WidgetForbiddenError, WidgetInstanceNotFoundError, WidgetAreaNotFoundError, EntrySlugConflictError],
    },
  });
