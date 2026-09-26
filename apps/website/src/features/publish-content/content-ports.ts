import type { ContentTypeListPort, ContentTypeRepoPort, IndexProvisionerPort } from "#src/features/content-types/index";
import type { FormDefinitionRepoPort } from "#src/features/forms/index";
import type { PostRepoPort } from "#src/features/post/post";
import { createContentLookup, type ContentTypeTaxonomyPolicyPort } from "#src/features/taxonomy/index";
import type { EntryPublishPorts, PublishContentPorts, TaxonomyPublishPorts, WidgetPublishPorts } from "./type-registry.js";

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
  readonly entryRepo: EntryPublishPorts["entries"] & WidgetPublishPorts["entries"];
  readonly entryRefsRepo: WidgetPublishPorts["entryRefs"];
  readonly widgetBindingRepo: WidgetPublishPorts["bindings"];
}

/** The ports keys this builder owns. */
export type ContentPublishPortKey = "form" | "content-type" | "taxonomy" | "term" | "collection-entry" | "widget" | "widget-area";

/** Widget types are entries too, but never carry terms. */
const NO_TERMS_TYPES: ReadonlySet<string> = new Set(["widget", "widget_area"]);

/**
 * Collection entries' term policy for publishing: any taxonomy on an entry whose collection exists
 * here and is not tombstoned. Only the publish path wires a policy, so it only lets through an
 * assignment the source already held; nothing narrower is recorded per collection to check against.
 * @complexity one indexed read per call.
 */
function liveCollectionsTakeAnyTaxonomy(sources: ContentPublishSources): ContentTypeTaxonomyPolicyPort {
  return {
    async taxonomiesFor({ contentType }) {
      if (NO_TERMS_TYPES.has(contentType)) return null;
      const owner = await sources.contentTypeRepo.findByKey({ workspaceId: sources.workspaceId, key: contentType });
      return owner && owner.status !== "tombstone" ? "all" : null;
    },
  };
}

/** @complexity O(1) — a field projection, no I/O. */
export function buildContentPublishPorts(sources: ContentPublishSources): Pick<PublishContentPorts, ContentPublishPortKey> {
  const taxonomy: TaxonomyPublishPorts = {
    taxonomies: sources.taxonomyRepo,
    terms: sources.termRepo,
    entryTerms: sources.entryTermRepo,
    revisions: sources.taxonomyRevisionRepo,
    stampWatermark: sources.stampWatermark,
    contentLookup: createContentLookup({ postRepo: sources.postRepo, entryRepo: sources.entryRepo, workspaceId: sources.workspaceId }),
    contentTypeTaxonomyPolicy: liveCollectionsTakeAnyTaxonomy(sources),
  };
  const widget: WidgetPublishPorts = {
    entries: sources.entryRepo,
    contentTypes: sources.contentTypeRepo,
    entryRefs: sources.entryRefsRepo,
    bindings: sources.widgetBindingRepo,
    forms: sources.formDefinitionRepo,
  };
  return {
    taxonomy,
    term: taxonomy,
    form: { repo: sources.formDefinitionRepo },
    "content-type": { repo: sources.contentTypeRepo, indexProvisioner: sources.contentTypeIndexProvisioner },
    "collection-entry": { entries: sources.entryRepo, contentTypes: sources.contentTypeRepo, terms: taxonomy },
    widget,
    "widget-area": widget,
  };
}
