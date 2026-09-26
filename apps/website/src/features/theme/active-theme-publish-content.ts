import path from "node:path";

import { PresentationSettingsNotFoundError, PresentationSettingsValidationError, setActiveTheme } from "@jini-ai/cms/presentation";

import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import { createRepoPublishHandler, gatewayDeps } from "#src/features/publish-content/repo-handler";
import type { PublishContentContributor, PublishContentPorts } from "#src/features/publish-content/type-registry";

import { writableThemeIds } from "./active-theme.js";
import { RENAMED_THEME_IDS, themeIdCandidates } from "./theme-id-aliases.js";

/**
 * @file `active-theme` on the publish factory (`features/publish-content/repo-handler.ts`): which
 * theme the live site shows. Without it a published theme sits unused (plan §1 `site-setting` row).
 *
 * One entity per site, id {@link ACTIVE_THEME_ID}. The live value is `presentation_settings`, written
 * through Jini's `setActiveTheme` — the same chokepoint as the admin's theme switch, under the same
 * `theme.set` permission. (`core.presentation.activeThemeId` in the settings ledger is a global-scope
 * mirror, not the source of truth.)
 *
 * The id is packed under its current name (`basic` travels as `tovu-theme`), so a site still holding
 * the old id hashes the same. On arrival the first candidate folder this site has wins
 * (`theme-id-aliases.ts`); with none, the row is refused rather than switching the live site to a
 * theme it cannot render. That check runs at apply, not precheck: `dependsOn: ["theme-files"]` puts
 * the theme's own files first in the same run. Version is `updatedAt` in milliseconds — the row has no
 * counter.
 */

export const ACTIVE_THEME_ID = "site";

export interface ActiveThemeRow {
  readonly id: string;
  readonly label: string;
  readonly themeId: string;
  /** The theme's `<tier>/<folder>` (its `theme-files` key), or `null` when this site has no such folder. */
  readonly tree: string | null;
  readonly version: number;
}

type Ports = PublishContentPorts["active-theme"];

/** @complexity O(themes). */
function treeOf(ports: Ports, themeId: string): string | null {
  const theme = ports.themes.find((t) => t.status === "valid" && themeIdCandidates(themeId).includes(t.manifest.id));
  return theme ? `${path.basename(path.dirname(theme.dir))}/${path.basename(theme.dir)}` : null;
}

/** @complexity one indexed read plus O(themes). */
async function findActiveTheme(ports: Ports, workspaceId: string, id: string): Promise<ActiveThemeRow | null> {
  if (id !== ACTIVE_THEME_ID) return null;
  const record = await ports.presentation.findByWorkspaceId(workspaceId);
  if (!record) return null;
  const themeId = RENAMED_THEME_IDS[record.activeThemeId] ?? record.activeThemeId;
  return { id, label: themeId, themeId, tree: treeOf(ports, themeId), version: Date.parse(record.updatedAt) || 0 };
}

/** Plain refusal, rewritten for the owner by `ui/report-rows.ts`. */
const notInstalled = (themeId: string) => `active theme '${themeId}' is not installed at this destination`;

export const contributeActiveThemePublish = (): PublishContentContributor =>
  createRepoPublishHandler<ActiveThemeRow, Ports>({
    entityType: "active-theme",
    permission: "theme.set",
    dependsOn: ["theme-files"],
    ports: (deps) => deps.ports["active-theme"],
    list: async (p, workspaceId) => {
      const row = await findActiveTheme(p, workspaceId, ACTIVE_THEME_ID);
      return row ? [row] : [];
    },
    find: findActiveTheme,
    fields: { id: "local", label: "provenance", themeId: "transferred", tree: "provenance", version: "local" },
    references: (entity) => (typeof entity.state.tree === "string" ? [{ entityType: "theme-files", key: entity.state.tree }] : []),
    write: async ({ ports, deps, workspaceId, state, principalId }) => {
      const themeId = state.themeId as string;
      const { authorize } = gatewayDeps(deps, "active-theme");
      const auth = await authorize({ principalId, permission: "theme.set", workspaceId, entityType: "presentation" });
      if (!auth.allowed) {
        throw new PublishContentApplyRowError("blocked", `principal '${principalId}' is not authorized for 'theme.set' (${auth.reason})`);
      }
      const available = writableThemeIds({ themes: [...ports.themes] });
      const activeThemeId = themeIdCandidates(themeId).find((candidate) => available.includes(candidate));
      if (!activeThemeId) throw new PublishContentApplyRowError("blocked", notInstalled(themeId));
      const { settings } = await setActiveTheme({
        deps: { repo: ports.presentation, clock: deps.clock, availableThemeIds: available },
        input: { workspaceId, activeThemeId },
      });
      return { version: Date.parse(settings.updatedAt) || 0 };
    },
    errors: { blocked: [PresentationSettingsNotFoundError, PresentationSettingsValidationError] },
  });
