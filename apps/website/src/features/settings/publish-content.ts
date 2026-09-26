import type { JsonValue } from "@jini-ai/cms/core";

import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import { createRepoPublishHandler, gatewayDeps } from "#src/features/publish-content/repo-handler";
import type { PublishContentContributor, PublishContentPorts } from "#src/features/publish-content/type-registry";

import {
  DefinitionNotFoundError,
  DefinitionTombstonedError,
  ForbiddenError,
  resolveDefinitionRaw,
  SCOPE_BIT,
  ScopeNotAllowedError,
  SecretNotSupportedError,
  set,
  ValueValidationFailedError,
  type SettingDefinitionRecord,
} from "./index.js";

/**
 * @file `site-setting` on the publish factory (`features/publish-content/repo-handler.ts`): the
 * owner-authored site identity — title and SEO defaults — travels to the live site (plan §1,
 * OQ1 = yes).
 *
 * Settings are a security boundary, so this is an ALLOWLIST ({@link PUBLISHABLE_SETTINGS}), never a
 * denylist: plenty of non-secret settings are per-environment (BYOK/provider chips, `site.testing`,
 * analytics IP ranges, privacy installation ids). A key must be listed AND its definition must be
 * non-secret and allow workspace scope, checked on the sending side (pack) and again on the receiving
 * side (precheck and write), so a hand-made bundle naming any other key is refused.
 *
 * Deliberately left out, though owner-authored: the crawl controls (`site.seo`
 * `default_robots_noindex`/`default_robots_nofollow`/`robots_rules`/`sitemap_enabled`) — a local or
 * staging value would deindex the live site; `site.comments.*` and `site.assistant.public_enabled`
 * are site behaviour, not identity. Only workspace values travel; a user's own preference never does.
 *
 * Addressed by `namespace:key`. Version is the value row's `seq` (the ledger revision that wrote it);
 * `set` records a `setting_revisions` row like any admin edit. A key cleared on the source is not
 * cleared on the live site.
 */

/** `namespace:key` -> the label the publish dialog shows. */
export const PUBLISHABLE_SETTINGS: Readonly<Record<string, string>> = {
  "core.site:title": "Site title",
  "site.seo:title_template": "SEO title template",
  "site.seo:default_description": "Default description",
  "site.seo:default_og_image": "Default share image",
  "site.seo:twitter_site": "X (Twitter) handle",
};

const OG_IMAGE = "site.seo:default_og_image";

export interface SiteSettingRow {
  readonly key: string;
  readonly label: string;
  readonly value: JsonValue | null;
  readonly version: number;
}

type Ports = PublishContentPorts["site-setting"];

/** Loopback, private-range and `.local` hosts: a URL naming one only works on this computer. */
const LOCAL_HOST = /^(?:localhost|.*\.localhost|.*\.local|127(?:\.\d+){3}|0\.0\.0\.0|\[::1?\]|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2})$/i;

/** An absolute URL whose host is this computer or its private network. A media ref (`<id>:<transform>`)
 *  or a public URL is fine. @complexity O(n) in the value's length. */
export function pointsAtThisComputer(value: unknown): boolean {
  if (typeof value !== "string" || !/^[a-z][a-z\d+.-]*:\/\//i.test(value.trim())) return false;
  try {
    return LOCAL_HOST.test(new URL(value.trim()).hostname);
  } catch {
    return true;
  }
}

function splitKey(id: string): { namespace: string; key: string } {
  const at = id.indexOf(":");
  return { namespace: id.slice(0, at), key: id.slice(at + 1) };
}

/** The definition, when `id` is allowlisted and it is non-secret, active and workspace-scoped. */
async function publishableDefinition(ports: Ports, workspaceId: string, id: string): Promise<SettingDefinitionRecord | null> {
  if (!Object.hasOwn(PUBLISHABLE_SETTINGS, id)) return null;
  const definition = await resolveDefinitionRaw({ repo: ports.settings }, { ...splitKey(id), workspaceId });
  const ok = definition && definition.status === "active" && !definition.secret && (definition.scopes & SCOPE_BIT.workspace) !== 0;
  return ok ? definition : null;
}

/** @complexity two indexed reads. */
async function findSetting(ports: Ports, workspaceId: string, id: string): Promise<SiteSettingRow | null> {
  const definition = await publishableDefinition(ports, workspaceId, id);
  if (!definition) return null;
  const row = await ports.settings.getWorkspaceValue({ workspaceId, settingId: definition.settingId });
  if (!row || row.state !== "set") return null;
  return { key: id, label: PUBLISHABLE_SETTINGS[id]!, value: row.valueJson, version: row.seq };
}

/** Plain refusals, rewritten for the owner by `ui/report-rows.ts`. */
const notPublishable = (id: string) => `site-setting '${id}' is not one this site publishes`;
const localOnly = (id: string) => `site-setting '${id}' points at this computer`;

export const contributeSiteSettingPublish = (): PublishContentContributor =>
  createRepoPublishHandler<SiteSettingRow, Ports>({
    entityType: "site-setting",
    // What `deriveRequiredPermission` names for a workspace-scope `set`.
    permission: "settings.workspace.write",
    // The share image may name a media item.
    dependsOn: ["media"],
    ports: (deps) => deps.ports["site-setting"],
    list: async (p, workspaceId) => {
      const rows = await Promise.all(Object.keys(PUBLISHABLE_SETTINGS).map((id) => findSetting(p, workspaceId, id)));
      return rows.filter((row): row is SiteSettingRow => row !== null);
    },
    find: findSetting,
    idOf: (row) => row.key,
    include: (row) => !(row.key === OG_IMAGE && pointsAtThisComputer(row.value)),
    fields: { key: "local", label: "provenance", value: "transferred", version: "local" },
    references: (entity) => {
      // `<media id>:<transform>`; a slug or URL names nothing a scoped publish can carry.
      const ref = entity.id === OG_IMAGE ? entity.state.value : null;
      const mediaId = typeof ref === "string" ? ref.split(":")[0] : "";
      return mediaId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaId) ? [{ entityType: "media", key: mediaId }] : [];
    },
    validate: async ({ ports, workspaceId, entity }) => {
      if (!(await publishableDefinition(ports, workspaceId, entity.id))) return notPublishable(entity.id);
      return entity.id === OG_IMAGE && pointsAtThisComputer(entity.state.value) ? localOnly(entity.id) : null;
    },
    write: async ({ ports, deps, workspaceId, id, state, principalId }) => {
      // Precheck already refused these; checked again because this is the one write.
      if (!(await publishableDefinition(ports, workspaceId, id))) throw new PublishContentApplyRowError("blocked", notPublishable(id));
      if (id === OG_IMAGE && pointsAtThisComputer(state.value)) throw new PublishContentApplyRowError("blocked", localOnly(id));
      const { authorize } = gatewayDeps(deps, "site-setting");
      const { revisionSeq } = await set({
        deps: { repo: ports.settings, clock: deps.clock, ids: deps.idGen, authorize, principals: ports.principals },
        input: {
          ...splitKey(id),
          scope: "workspace",
          value: (state.value ?? null) as JsonValue,
          workspaceId,
          callerPrincipalId: principalId,
          authWorkspaceId: workspaceId,
        },
      });
      return { version: revisionSeq };
    },
    errors: {
      blocked: [ValueValidationFailedError, ForbiddenError, DefinitionNotFoundError, DefinitionTombstonedError, ScopeNotAllowedError, SecretNotSupportedError],
    },
  });
