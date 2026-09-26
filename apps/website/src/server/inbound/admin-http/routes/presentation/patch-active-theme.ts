import {
  PresentationSettingsNotFoundError,
  PresentationSettingsValidationError,
  setActiveTheme,
} from "#src/features/presentation/index";
import { findStoredTheme, validThemeIds, writableThemeIds } from "#src/features/theme/index";
import { toAdminPresentationResponse } from "#src/server/inbound/admin-http/http/presentation";
import { getAuthedPrincipal } from "#src/server/inbound/admin-http/dev-auth";
import type { ContentRouteRegistrar } from "../content/deps.js";

/**
 * PATCH the active theme.
 *
 * Gated by the existing `theme.set` permission, checked directly via `authorize()` — mirrors
 * `members/disable.ts`'s pattern since `setActiveTheme` is a direct feature call, not routed
 * through the SPEC-001 command gateway.
 */

/**
 * Reads the PATCH body's `activeThemeId`, defaulting to `""` for a missing/non-object body or a
 * missing field. `setActiveTheme`'s own `allowed.includes("")` check then turns that into a
 * `PresentationSettingsValidationError` naming the empty string, so a malformed body reads as "no
 * theme id" rather than a raw parse failure.
 *
 * Pulled out of the route handler purely to bring its cyclomatic complexity back under this repo's
 * gate — the `?.`/`??` here are two decision points genuinely independent of the handler's own
 * control flow (no nesting relationship), not a behavior change.
 */
function readActiveThemeId(body: unknown): string {
  return String((body as { activeThemeId?: unknown } | null)?.activeThemeId ?? "");
}

/**
 * Maps a caught error from `setActiveTheme` to its status/body. Pulled out of the route handler for
 * the same reason as {@link readActiveThemeId}: the two `instanceof` checks are independent decision
 * points that add to cyclomatic complexity without adding nesting, so moving them here is a pure
 * complexity-gate fix — still the same 400/404/500 statuses and bodies as before.
 */
function presentationPatchErrorResponse(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof PresentationSettingsValidationError) {
    return { status: 400, body: { error: err.message } };
  }
  if (err instanceof PresentationSettingsNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  return { status: 500, body: { error: "internal error" } };
}

export const registerAdminPresentationPatchRoute: ContentRouteRegistrar = (app, deps) => {
  app.patch("/api/admin/v1/workspaces/:workspaceId/presentation", async (req, res) => {
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

      const result = await setActiveTheme({
        deps: {
          repo: deps.presentationRepo,
          clock: deps.clock,
          availableThemeIds: writableThemeIds(deps),
        },
        input: {
          workspaceId: deps.workspaceId,
          activeThemeId: readActiveThemeId(req.body),
        },
      });

      // Template-picker feature (2026-08-10, unified 2026-08-11) — recomputed from the NEWLY active
      // theme (not the one that was active before this PATCH), so switching themes immediately
      // updates what BOTH pickers offer, matching `get.ts`'s identical computation.
      const activeTheme = findStoredTheme({ themes: deps.themes, id: result.settings.activeThemeId });
      const activeThemeTemplates = activeTheme?.manifest.templates ?? [];
      const activeThemeStaticPageIds = activeTheme ? Object.keys(activeTheme.pages) : [];
      // Themes admin screen (2026-08-10) — same computation as `get.ts`, so a theme switch's
      // response keeps the tab-grouping data in sync without a follow-up GET.
      const availableThemes = deps.themes
        .filter((t) => t.status === "valid")
        .map((t) => ({ id: t.manifest.id, tier: t.manifest.tier, apiVersion: t.manifest.apiVersion }));

      res.json(
        toAdminPresentationResponse({
          settings: result.settings,
          // `validThemeIds(deps.themes)`, NOT `result.availableThemeIds` — this ONE request carries
          // both lists, and they are not the same list. `result.availableThemeIds` is the write
          // allowlist echoed back by `setActiveTheme` (the caller-supplied set it validated
          // against), so it contains `NO_THEME_ID`; this field is the READ CATALOGUE the admin's
          // theme picker renders one card per entry from, exactly as in `get.ts`. Passing the
          // allowlist through would have put a blank card in the picker on the very request that
          // turns the theme off — i.e. only in the state where it is least likely to be noticed as
          // this route's doing. See `writableThemeIds`'s own doc (`features/theme/active-theme.ts`).
          availableThemeIds: validThemeIds(deps.themes),
          availableThemes,
          activeThemeTemplates,
          activeThemeStaticPageIds,
        })
      );
    } catch (err) {
      const { status, body } = presentationPatchErrorResponse(err);
      res.status(status).json(body);
    }
  });
};
