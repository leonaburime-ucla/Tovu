import { tombstonedAtDestination } from "#src/features/publish-content/precheck-reasons";
import { createRepoPublishHandler, gatewayDeps, okOrThrow } from "#src/features/publish-content/repo-handler";
import type { EntryPublishPorts, PublishContentContributor } from "#src/features/publish-content/type-registry";

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
 * else in it to leave behind. Term assignments (categories/tags) do NOT travel yet — writing them
 * needs a `contentTypeTaxonomyPolicy` nothing wires; that is a follow-up (schemaVersion 2).
 */

const WIDGET_TYPES = ["widget", "widget_area"];

export const contributeCollectionEntryPublish = (): PublishContentContributor =>
  createRepoPublishHandler<TrashableEntryRecord, EntryPublishPorts>({
    entityType: "collection-entry",
    permission: "admin.collections.manage",
    // Only the owning type is checked at write time; media and relation ids resolve at render.
    dependsOn: ["content-type"],
    ports: (deps) => deps.ports["collection-entry"],
    list: async (p, workspaceId) =>
      (await p.entries.listByWorkspaceExcludingTypes({ workspaceId, excludeTypes: WIDGET_TYPES })).map((row) => ({ ...row, deletedAt: null })),
    find: (p, workspaceId, id) => p.entries.findAnyById({ workspaceId, id }),
    isTrashed: (row) => row.deletedAt !== null,
    fields: {
      type: "transferred",
      slug: "transferred",
      title: "transferred",
      status: "transferred",
      bodyJson: "transferred",
      fieldsJson: "transferred",
      publishedAt: "provenance",
      createdAt: "provenance",
      id: "local",
      workspaceId: "local",
      updatedAt: "local",
      version: "local",
      deletedAt: "local",
    },
    address: {
      field: "slug",
      holder: async (p, workspaceId, slug, state) => {
        const row = await p.entries.findBySlug({ workspaceId, type: state.type as string, slug });
        return row ? { ...row, deletedAt: null } : null;
      },
    },
    // A tombstone is terminal, so nothing in the bundle can fix it. A missing type is left to apply:
    // the same bundle may carry it.
    validate: async ({ ports, workspaceId, entity }) => {
      const owner = await ports.contentTypes.findByKey({ workspaceId, key: entity.state.type as string });
      return owner?.status === "tombstone" ? tombstonedAtDestination("content-type", owner.key) : null;
    },
    write: async ({ ports, deps, workspaceId, id, state, expectedVersion, principalId }) => {
      const gateway = gatewayDeps(deps, "collection-entry");
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
      return { version: saved.entry.version };
    },
    errors: {
      conflict: [VersionConflictError],
      blocked: [ForbiddenError, ContentTypeNotFoundError, ContentTypeNotActiveError, EntryFieldValidationError, EntrySlugConflictError],
    },
  });
