import type { ContentTypeListPort, ContentTypeRepoPort, IndexProvisionerPort } from "#src/features/content-types/index";
import type { FormDefinitionRepoPort } from "#src/features/forms/index";
import type { PostRepoPort } from "#src/features/post/post";
import { createPostBackedContentLookup } from "#src/features/taxonomy/index";
import type { EntryPublishPorts, PublishContentPorts, TaxonomyPublishPorts } from "./type-registry.js";

/**
 * @file The one place the factory-built types (`repo-handler.ts`) get their ports from.
 *
 * Every composition root (`composition/deps.ts`, `composition/app.ts`, `publish-content-seed-hash.ts`)
 * and the route bag (`routes/publish-content/deps.ts`) spreads `...buildContentPublishPorts(sources)`
 * into its `ports` literal. {@link ContentPublishSources} is named after the matching `RouteDeps`
 * fields, so the route bag passes its own deps straight through and a root passes the same local
 * consts it already hands to `routeDeps`. A new type adds its port here once, plus a source field in
 * each root only when it needs a repo no earlier type did — the compiler names every root that
 * forgot.
 */
export interface ContentPublishSources {
  readonly formDefinitionRepo: FormDefinitionRepoPort;
  readonly contentTypeRepo: ContentTypeRepoPort & ContentTypeListPort;
  readonly contentTypeIndexProvisioner: IndexProvisionerPort;
  readonly workspaceId: string;
  readonly postRepo: PostRepoPort;
  readonly taxonomyRepo: TaxonomyPublishPorts["taxonomies"];
  readonly termRepo: TaxonomyPublishPorts["terms"];
  readonly entryTermRepo: TaxonomyPublishPorts["entryTerms"];
  readonly taxonomyRevisionRepo: TaxonomyPublishPorts["revisions"];
  readonly stampWatermark: () => void;
  readonly entryRepo: EntryPublishPorts["entries"];
}

/** The ports keys this builder owns. */
export type ContentPublishPortKey = "form" | "content-type" | "taxonomy" | "term" | "collection-entry";

/** @complexity O(1) — a field projection, no I/O. */
export function buildContentPublishPorts(sources: ContentPublishSources): Pick<PublishContentPorts, ContentPublishPortKey> {
  const taxonomy: TaxonomyPublishPorts = {
    taxonomies: sources.taxonomyRepo,
    terms: sources.termRepo,
    entryTerms: sources.entryTermRepo,
    revisions: sources.taxonomyRevisionRepo,
    stampWatermark: sources.stampWatermark,
    contentLookup: createPostBackedContentLookup({ postRepo: sources.postRepo, workspaceId: sources.workspaceId }),
  };
  return {
    taxonomy,
    term: taxonomy,
    form: { repo: sources.formDefinitionRepo },
    "content-type": { repo: sources.contentTypeRepo, indexProvisioner: sources.contentTypeIndexProvisioner },
    "collection-entry": { entries: sources.entryRepo, contentTypes: sources.contentTypeRepo },
  };
}
