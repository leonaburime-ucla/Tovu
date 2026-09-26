/**
 * @file Retired theme ids, so a rename never strands a site that still stores or links the old one.
 *
 * The stock theme was renamed `basic` -> `tovu-theme` on 2026-09-26. Nothing else moves with that
 * rename on its own:
 * - `seedSiteThemes()` copies stock themes into a site ONCE, so every site seeded earlier (the live
 *   Fly volume, every desktop site) still has a `themes/static/basic` folder whose manifest says
 *   `basic`, while a site seeded later has `tovu-theme` only.
 * - `presentation_settings.active_theme_id` and the settings ledger keep whatever id was stored.
 * - Published content bakes `/theme-assets/basic/...` URLs into stored HTML.
 *
 * So the alias works in BOTH directions and prefers the current name: asking for either id finds
 * `tovu-theme` when a site has it, otherwise `basic`. Preferring the current name matters once a
 * site holds both folders — e.g. live after the renamed theme is published to it — so the stored
 * `basic` follows the newly published copy instead of pinning the stale one.
 *
 * Pure data + one function, no imports, so any layer may use it without a dependency cost.
 */

/** Retired id -> current id. */
export const RENAMED_THEME_IDS: Readonly<Record<string, string>> = { basic: "tovu-theme" };

/**
 * The ids to try, in order, when looking up `id`: the current name first, then the retired one.
 * An id with no rename history is returned alone.
 *
 * @complexity O(r) over {@link RENAMED_THEME_IDS}.
 */
export function themeIdCandidates(id: string): string[] {
  for (const [retired, current] of Object.entries(RENAMED_THEME_IDS)) {
    if (id === retired || id === current) return [current, retired];
  }
  return [id];
}
