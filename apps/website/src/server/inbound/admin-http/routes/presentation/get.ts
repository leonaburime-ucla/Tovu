import {
  getPresentationSettings,
  PresentationSettingsNotFoundError,
} from "#src/features/presentation/index";
import { findStoredTheme, validThemeIds } from "#src/features/theme/index";
import { toAdminPresentationResponse } from "#src/server/inbound/admin-http/http/presentation";
import { getAuthedPrincipal } from "#src/server/inbound/admin-http/dev-auth";
import type { ContentRouteRegistrar } from "../content/deps.js";

/**
 * GET presentation settings (active theme + available themes).
 *
 * Gated by the existing `theme.set` permission — there is no dedicated read permission for
 * presentation settings in the catalog, and `activeThemeId` is currently the only field this
 * resource has, so the same permission that gates changing it also gates reading it (same
 * single-permission-per-domain reasoning as `member.manage`). Disclosed explicitly in the
 * Programmer handoff since this reuses a write-shaped permission name for a read route.
 */
export const registerAdminPresentationGetRoute: ContentRouteRegistrar = (app, deps) => {
  app.get("/api/admin/v1/workspaces/:workspaceId/presentation", async (req, res) => {
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

      // **Deliberately NOT the write allowlist.** This list is echoed straight back to the client as
      // `AdminPresentation.availableThemeIds` and is what the admin's theme picker renders one card
      // per entry from — it is a READ CATALOGUE of themes an operator can pick, not a set of values
      // the API will accept.
      //
      // `patch-active-theme.ts` passes a DIFFERENT list through an identically-named field: its
      // `writableThemeIds` appends `NO_THEME_ID` so "turn the theme off" is a storable value. That
      // sentinel must never appear HERE — it would render as a blank card in the picker, with no
      // type error, no failing test and no gate to catch it. The two expressions used to be
      // character-for-character identical, which is exactly why this note exists on the side that
      // did not change: a reader reducing duplication in this directory sees two identical calls in
      // sibling files and no reason not to merge them. There is one, and it is this.
      const result = await getPresentationSettings({
        deps: { repo: deps.presentationRepo, availableThemeIds: validThemeIds(deps.themes) },
        input: { workspaceId: deps.workspaceId },
      });

      // Template-picker feature (2026-08-10, unified 2026-08-11) — the active theme's own declared
      // template list, so BOTH the Post editor's and the Pages editor's pickers always reflect
      // whichever theme is actually live right now (one shared field since the unified `content`
      // marker — see `AdminPresentation.activeThemeTemplates`'s own doc).
      // `findStoredTheme`, not an exact match: a stored retired id (`basic`, renamed `tovu-theme`)
      // still names the active theme, and the response reports the id the theme list shows.
      const activeTheme = findStoredTheme({ themes: deps.themes, id: result.settings.activeThemeId });
      const activeThemeTemplates = activeTheme?.manifest.templates ?? [];
      // Slug-collision override (2026-08-10) — every page id the active theme ships, so the editor
      // can warn when a post's own slug is currently claimed by one of the theme's own pages.
      const activeThemeStaticPageIds = activeTheme ? Object.keys(activeTheme.pages) : [];
      // Themes admin screen (2026-08-10) — tier alongside id for every valid theme, so the Themes
      // screen can group cards by tier without a second round trip. Filtered to `status === "valid"`
      // to match `validThemeIds`'s own filter above (an invalid theme is not one an operator can pick).
      const availableThemes = deps.themes
        .filter((t) => t.status === "valid")
        .map((t) => ({ id: t.manifest.id, tier: t.manifest.tier, apiVersion: t.manifest.apiVersion }));

      res.json(
        toAdminPresentationResponse({
          settings: activeTheme
            ? { ...result.settings, activeThemeId: activeTheme.manifest.id as typeof result.settings.activeThemeId }
            : result.settings,
          availableThemeIds: result.availableThemeIds,
          availableThemes,
          activeThemeTemplates,
          activeThemeStaticPageIds,
        })
      );
    } catch (err) {
      if (err instanceof PresentationSettingsNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }

      res.status(500).json({ error: "internal error" });
    }
  });
};
