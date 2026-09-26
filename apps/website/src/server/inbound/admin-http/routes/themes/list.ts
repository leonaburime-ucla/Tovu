import { findStoredTheme, type DiscoveredTheme } from "#src/features/theme/index";
import { getAuthedPrincipal } from "#src/server/inbound/admin-http/dev-auth";
import type { ContentRouteRegistrar } from "../content/deps.js";

/** Wire shape for one `THEMES_LIST` entry (SPEC-004 api.spec.md §5). */
interface ThemeListItem {
  id: string;
  name: string;
  version: string;
  source: DiscoveredTheme["source"];
  status: DiscoveredTheme["status"];
  errors: Array<{ code: string | null; file: string | null; message: string }>;
  active: boolean;
}

/**
 * TB-01 order: built-in themes first (id asc), then site themes (id asc).
 * `discoverThemes` already sorts within one call by id, but `deps.themes` may
 * one day concatenate multiple sources (built-in + site, per `theme.ts`'s own
 * `source` field) — sorting explicitly here doesn't rely on caller-side
 * concatenation order.
 */
function sortThemesForList(themes: readonly DiscoveredTheme[]): DiscoveredTheme[] {
  const sourceRank = (source: DiscoveredTheme["source"]): number => (source === "built-in" ? 0 : 1);
  return [...themes].sort((a, b) => {
    const rankDiff = sourceRank(a.source) - sourceRank(b.source);
    return rankDiff !== 0 ? rankDiff : a.manifest.id.localeCompare(b.manifest.id);
  });
}

/**
 * GET discovered themes with source/status/errors/active (SPEC-004 api.spec.md
 * `THEMES_LIST`) — reads the same `deps.themes` (`DiscoveredTheme[]`, from
 * `discoverThemes()`) that `presentation/patch-active-theme.ts`'s
 * `validThemeIds(deps.themes)` already exposes; this route is a new read
 * surface over that existing data source, not new theme storage.
 *
 * Gated by `theme.set` — there is no dedicated `theme.read` permission in the
 * catalog (mirrors `presentation/get.ts`'s identical disclosed reuse of a
 * write-shaped permission for a read route).
 *
 * Disclosed shape gap (Programmer handoff): `errors.spec.md` §3 documents each
 * `THEMES_LIST` error record as `{ code, file, message }`, sourced from "one
 * validator, two surfaces — never diverge" shared with `THEME_INVALID`'s
 * details. `features/theme/theme.ts`'s `loadTheme()` is explicitly a "spike
 * scope" validator (its own file header) that only ever collects plain
 * `errors: string[]` messages — it has no `code`/`file` vocabulary
 * (`MANIFEST_MISSING`, `CSS_FORBIDDEN`, etc., errors.spec.md §3) to draw from.
 * Building that structured vocabulary is a real validator rewrite (a new
 * "theme validator module"), not something this GET route can safely invent —
 * so each message is surfaced here as `{ code: null, file: null, message }`
 * rather than fabricating a code the validator never actually determined.
 */
export const registerAdminThemesListRoute: ContentRouteRegistrar = (app, deps) => {
  app.get("/api/admin/v1/workspaces/:workspaceId/themes", async (req, res) => {
    if (String(req.params.workspaceId ?? "") !== deps.workspaceId) {
      res.status(404).json({ error: "workspace was not found" });
      return;
    }

    try {
      const principal = getAuthedPrincipal(res);
      const authResult = await deps.authorize({
        principalId: principal.id,
        permission: "theme.set",
        workspaceId: deps.workspaceId,
        entityType: "presentation",
      });
      if (!authResult.allowed) {
        res.status(403).json({
          error: `principal '${principal.id}' is not authorized for 'theme.set' (${authResult.reason})`,
          code: "FORBIDDEN",
          details: { permission: "theme.set", reason: authResult.reason },
        });
        return;
      }

      // No settings-not-found 404 here (unlike PRESENTATION_GET) — api.spec.md §6's THEMES_LIST
      // status map lists only "unknown workspace" as a 404 cause. A missing/absent presentation
      // row just means no theme in the list matches `active: true`, not a listing failure.
      const settings = await deps.presentationRepo.findByWorkspaceId(deps.workspaceId);
      // The theme the stored id resolves to, retired ids included (`theme-id-aliases.ts`).
      const activeId = settings ? findStoredTheme({ themes: deps.themes, id: settings.activeThemeId })?.manifest.id : undefined;

      const themes: ThemeListItem[] = sortThemesForList(deps.themes).map((theme) => ({
        id: theme.manifest.id,
        name: theme.manifest.name,
        version: theme.manifest.version,
        source: theme.source,
        status: theme.status,
        errors: theme.errors.map((message) => ({ code: null, file: null, message })),
        active: theme.manifest.id === activeId,
      }));

      res.json({ themes });
    } catch {
      res.status(500).json({ error: "internal error" });
    }
  });
};
