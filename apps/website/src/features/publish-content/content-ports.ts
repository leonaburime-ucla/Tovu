import type { ContentTypeListPort, ContentTypeRepoPort, IndexProvisionerPort } from "#src/features/content-types/index";
import type { FormDefinitionRepoPort } from "#src/features/forms/index";
import type { PublishContentPorts } from "./type-registry.js";

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
}

/** The ports keys this builder owns. */
export type ContentPublishPortKey = "form" | "content-type";

/** @complexity O(1) — a field projection, no I/O. */
export function buildContentPublishPorts(sources: ContentPublishSources): Pick<PublishContentPorts, ContentPublishPortKey> {
  return {
    form: { repo: sources.formDefinitionRepo },
    "content-type": { repo: sources.contentTypeRepo, indexProvisioner: sources.contentTypeIndexProvisioner },
  };
}
