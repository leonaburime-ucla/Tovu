import { trashedAtDestination } from "#src/features/publish-content/precheck-reasons";
import { createRepoPublishHandler, gatewayDeps, type FieldDisposition } from "#src/features/publish-content/repo-handler";
import type { PublishContentContributor, PublishContentPorts } from "#src/features/publish-content/type-registry";

import { FormDefinitionNotFoundError, FormFieldValidationError, FormSlugConflictError } from "./errors.js";
import type { FieldDescriptor, FormDefinitionRecord, FormDefinitionStatus, NotifyConfig } from "./types.js";
import { createFormDefinition, setFormDefinitionStatus, updateFormDefinition } from "./write-service.js";

/**
 * @file `form` on the publish factory (`features/publish-content/repo-handler.ts`). Carries the form's
 * structure only — submissions are visitor data and never travel (plan §1).
 *
 * Addressed by `slug`, not the row id: the site looks a form up by slug and the id is minted per
 * instance by `createFormDefinition`. The repo hides trashed rows, so a slug held only by a trashed
 * form is found through `isSlugTaken` and refused rather than planned as a create that would collide.
 */

/** `notify` is an open owner question (plan OQ2): flip this one line to `"local"` to stop sending the
 *  source's notification recipients to the destination. */
const NOTIFY: FieldDisposition = "transferred";

export const contributeFormPublish = (): PublishContentContributor =>
  createRepoPublishHandler<FormDefinitionRecord, PublishContentPorts["form"]>({
    entityType: "form",
    permission: "admin.forms.manage",
    ports: (deps) => deps.ports.form,
    list: (p, workspaceId) => p.repo.list({ workspaceId }),
    find: (p, workspaceId, slug) => p.repo.findBySlug({ workspaceId, slug }),
    idOf: (row) => row.slug,
    fields: {
      name: "transferred",
      slug: "transferred",
      fields: "transferred",
      status: "transferred",
      notify: NOTIFY,
      id: "local",
      workspaceId: "local",
      createdAt: "local",
      updatedAt: "local",
      version: "local",
    },
    validate: async ({ ports, workspaceId, entity, existing }) =>
      !existing && (await ports.repo.isSlugTaken({ workspaceId, slug: entity.id })) ? trashedAtDestination("form", entity.id) : null,
    write: async ({ ports, deps, workspaceId, id, state, existing, principalId }) => {
      const writeDeps = { ...gatewayDeps(deps, "form"), repo: ports.repo };
      const actor = { id: principalId, kind: "user" as const };
      const name = state.name as string;
      const fields = state.fields as FieldDescriptor[];
      // A `"local"` notify never arrives; an update then keeps the destination's own.
      const notify = (state.notify ?? undefined) as NotifyConfig | undefined;
      const { definition } = existing
        ? await updateFormDefinition({ deps: writeDeps, input: { workspaceId, actor, formId: existing.id, patch: { name, fields, notify } } })
        : await createFormDefinition({ deps: writeDeps, input: { workspaceId, actor, name, slug: id, fields, notify } });
      const status = state.status as FormDefinitionStatus;
      if (definition.status !== status) {
        await setFormDefinitionStatus({ deps: writeDeps, input: { workspaceId, actor, formId: definition.id, status } });
      }
    },
    errors: { blocked: [FormFieldValidationError, FormSlugConflictError], conflict: [FormDefinitionNotFoundError] },
  });
