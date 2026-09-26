import { ForbiddenError } from "@jini-ai/cms/core";

import { createRepoPublishHandler, gatewayDeps, type RepoWriteContext } from "#src/features/publish-content/repo-handler";
import type { PublishContentContributor, TaxonomyPublishPorts } from "#src/features/publish-content/type-registry";

import {
  HierarchyCycleDetectedError,
  importTaxonomy,
  importTerm,
  ParentCrossTaxonomyError,
  TaxonomyNotHierarchicalError,
  TaxonomyRecordNotFoundError,
  TaxonomyVersionConflictError,
  TermNotFoundError,
  toTaxonomyOutbox,
  type Taxonomy,
  type Term,
} from "./index.js";

/**
 * @file `taxonomy` and `term` on the publish factory. Both keep the source's own id (Jini's
 * `importTaxonomy`/`importTerm`), so a term's `taxonomyId`/`parentId` point at the same rows on the
 * destination. A trashed row (`status` = `"trash"`) never packs, and a trashed destination refuses.
 * `status`, `updatedAt` and `version` stay local.
 */

const TRASH = "trash";

/** The Jini write-service deps for one apply. */
function writeDeps(ctx: RepoWriteContext<unknown, TaxonomyPublishPorts>, entityType: string) {
  const { deps, workspaceId, ports } = ctx;
  const gateway = gatewayDeps(deps, entityType);
  return {
    ...ports,
    clock: deps.clock,
    idGen: deps.idGen,
    workspaceId,
    authorize: (params: { principalId: string; permission: string }) => gateway.authorize({ ...params, workspaceId }),
    outbox: toTaxonomyOutbox({ outbox: gateway.outbox, clock: deps.clock, idGen: deps.idGen, workspaceId }),
  };
}

const errors = {
  conflict: [TaxonomyVersionConflictError],
  blocked: [ForbiddenError, TaxonomyRecordNotFoundError, TermNotFoundError, HierarchyCycleDetectedError, ParentCrossTaxonomyError, TaxonomyNotHierarchicalError],
};

export const contributeTaxonomyPublish = (): PublishContentContributor =>
  createRepoPublishHandler<Taxonomy, TaxonomyPublishPorts>({
    entityType: "taxonomy",
    permission: "admin.taxonomy.manage",
    ports: (deps) => deps.ports.taxonomy,
    list: (p) => p.taxonomies.list(),
    find: (p, _workspaceId, id) => p.taxonomies.findAnyById(id),
    isTrashed: (row) => row.status === TRASH,
    fields: { name: "transferred", hierarchical: "transferred", id: "local", status: "local", updatedAt: "local", version: "local" },
    // Not unique in the schema; two same-named groups would read as one on screen.
    address: { field: "name", holder: async (p, _workspaceId, name) => (await p.taxonomies.list()).find((t) => t.name === name) ?? null },
    write: async (ctx) => {
      const { id, state, expectedVersion, principalId } = ctx;
      const deps = writeDeps(ctx, "taxonomy");
      const saved = await importTaxonomy({ deps, principalId, id, name: state.name as string, hierarchical: state.hierarchical as boolean, expectedVersion });
      return { version: saved.version };
    },
    errors,
  });

/** Parents before children, so `importTerm` always finds a term's parent already written. */
function parentFirst(rows: readonly Term[]): Term[] {
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const ordered: Term[] = [];
  const seen = new Set<string>();
  const visit = (row: Term): void => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (parent) visit(parent);
    ordered.push(row);
  };
  rows.forEach(visit);
  return ordered;
}

export const contributeTermPublish = (): PublishContentContributor =>
  createRepoPublishHandler<Term, TaxonomyPublishPorts>({
    entityType: "term",
    permission: "admin.taxonomy.manage",
    dependsOn: ["taxonomy"],
    ports: (deps) => deps.ports.term,
    list: async (p) => (await Promise.all((await p.taxonomies.list()).map((t) => p.terms.listByTaxonomy({ taxonomyId: t.id })))).flat(),
    find: (p, _workspaceId, id) => p.terms.findAnyById(id),
    isTrashed: (row) => row.status === TRASH,
    packOrder: parentFirst,
    fields: { taxonomyId: "transferred", parentId: "transferred", name: "transferred", id: "local", status: "local", updatedAt: "local", version: "local" },
    // Its taxonomy and its parent: a scoped publish of a term brings both.
    references: ({ state }) => [
      { entityType: "taxonomy", key: String(state.taxonomyId) },
      ...(typeof state.parentId === "string" ? [{ entityType: "term", key: state.parentId }] : []),
    ],
    // A name is taken only among its siblings (same taxonomy, same parent).
    address: {
      field: "name",
      holder: async (p, _workspaceId, name, state) =>
        (await p.terms.listByTaxonomy({ taxonomyId: state.taxonomyId as string })).find((t) => t.name === name && t.parentId === (state.parentId ?? null)) ?? null,
    },
    write: async (ctx) => {
      const { id, state, expectedVersion, principalId } = ctx;
      const deps = writeDeps(ctx, "term");
      const input = { taxonomyId: state.taxonomyId as string, parentId: (state.parentId ?? null) as string | null, name: state.name as string };
      const saved = await importTerm({ deps, principalId, id, ...input, expectedVersion });
      return { version: saved.version };
    },
    errors,
  });
