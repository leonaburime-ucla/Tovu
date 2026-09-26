import { collectBodyReferences } from "#src/features/publish-content/content-references";
import { tombstonedAtDestination } from "#src/features/publish-content/precheck-reasons";
import { createRepoPublishHandler, gatewayDeps, okOrThrow } from "#src/features/publish-content/repo-handler";
import type { EntryPublishPorts, PublishContentContributor } from "#src/features/publish-content/type-registry";
import { prepareTermSync, readTermIds } from "#src/features/taxonomy/publish-term-ids";
import { ContentRecordNotFoundError, TaxonomyNotApplicableError, TermRecordNotFoundError } from "#src/features/taxonomy/index";

import {
  ContentTypeNotActiveError,
  ContentTypeNotFoundError,
  EntryFieldValidationError,
  EntrySlugConflictError,
  ForbiddenError,
  importEntry,
  toEntryOutbox,
  VersionConflictError,
  type EntryStatus,
} from "./index.js";
import type { TrashableEntryRecord } from "./trash-aware-memory-repo.js";

/**
 * @file `collection-entry` on the publish factory: every entry except widgets and widget areas
 * (their own types). Keeps the source's id (Jini's `importEntry`), addressed by `(type, slug)`.
 *
 * `fieldsJson` travels whole: Tovu only ever writes the `ext.site` namespace, so there is nothing
 * else in it to leave behind. Term assignments (categories/tags) travel as `termIds`
 * (`taxonomy/publish-term-ids.ts`); the publish ports' `contentTypeTaxonomyPolicy` admits them for
 * any live collection.
 */

const WIDGET_TYPES = ["widget", "widget_area"];

/** An entry row plus its sorted term ids (`undefined` when it has none). */
type EntryRow = TrashableEntryRecord & { termIds?: string[] };

const withTerms = async (p: EntryPublishPorts, row: TrashableEntryRecord): Promise<EntryRow> => ({
  ...row,
  termIds: await readTermIds(p.terms, row.type, row.id),
});

export const contributeCollectionEntryPublish = (): PublishContentContributor =>
  createRepoPublishHandler<EntryRow, EntryPublishPorts>({
    entityType: "collection-entry",
    // 2 = the state may carry `termIds`. Exact-match, so an instance built before this refuses.
    schemaVersion: 2,
    permission: "admin.collections.manage",
    // The owning type and assigned terms are checked at write time; media and relation ids resolve at render.
    dependsOn: ["content-type", "term"],
    ports: (deps) => deps.ports["collection-entry"],
    list: async (p, workspaceId) => {
      const rows = await p.entries.listByWorkspaceExcludingTypes({ workspaceId, excludeTypes: WIDGET_TYPES });
      return Promise.all(rows.map((row) => withTerms(p, { ...row, deletedAt: null })));
    },
    find: async (p, workspaceId, id) => {
      const row = await p.entries.findAnyById({ workspaceId, id });
      return row ? withTerms(p, row) : null;
    },
    isTrashed: (row) => row.deletedAt !== null,
    fields: {
      type: "transferred",
      slug: "transferred",
      title: "transferred",
      status: "transferred",
      bodyJson: "transferred",
      fieldsJson: "transferred",
      termIds: "transferred",
      publishedAt: "provenance",
      createdAt: "provenance",
      id: "local",
      workspaceId: "local",
      updatedAt: "local",
      version: "local",
      deletedAt: "local",
    },
    omitWhenAbsent: ["termIds"],
    address: {
      field: "slug",
      // Trash included: a trashed row keeps its slug (`entries_workspace_type_slug_unique`).
      holder: (p, workspaceId, slug, state) => p.entries.findAnyBySlug({ workspaceId, type: state.type as string, slug }),
    },
    // A tombstone is terminal, so nothing in the bundle can fix it. A missing type is left to apply:
    // the same bundle may carry it.
    // Its collection, plus whatever its body embeds and its categories/tags.
    references: (entity) => [{ entityType: "content-type", key: String(entity.state.type) }, ...collectBodyReferences(entity.state)],
    validate: async ({ ports, workspaceId, entity }) => {
      const owner = await ports.contentTypes.findByKey({ workspaceId, key: entity.state.type as string });
      return owner?.status === "tombstone" ? tombstonedAtDestination("content-type", owner.key) : null;
    },
    write: async ({ ports, deps, workspaceId, id, state, expectedVersion, principalId }) => {
      const gateway = gatewayDeps(deps, "collection-entry");
      // Checked before the entry is written, so a missing term or permission blocks the row whole.
      const terms = await prepareTermSync({
        ports: ports.terms,
        deps,
        entityType: "collection-entry",
        entityId: id,
        principalId,
        contentType: state.type as string,
        wanted: state.termIds,
      });
      const saved = okOrThrow(
        await importEntry({
          deps: {
            entryRepo: ports.entries,
            contentTypeRepo: ports.contentTypes,
            clock: deps.clock,
            authorize: gateway.authorize,
            outbox: toEntryOutbox({ outbox: gateway.outbox, clock: deps.clock, idGen: deps.idGen, workspaceId }),
          },
          input: {
            actorId: principalId,
            workspaceId,
            id,
            type: state.type as string,
            slug: state.slug as string,
            title: state.title as string,
            status: state.status as EntryStatus,
            fieldsJson: state.fieldsJson,
            bodyJson: state.bodyJson,
            publishedAt: (state.publishedAt ?? null) as string | null,
            expectedVersion,
          },
        })
      );
      await terms.apply();
      return { version: saved.entry.version };
    },
    errors: {
      conflict: [VersionConflictError],
      blocked: [
        ForbiddenError,
        ContentTypeNotFoundError,
        ContentTypeNotActiveError,
        EntryFieldValidationError,
        EntrySlugConflictError,
        // Term sync, when the destination changed between its pre-check and the assignment.
        TermRecordNotFoundError,
        ContentRecordNotFoundError,
        TaxonomyNotApplicableError,
      ],
    },
  });
