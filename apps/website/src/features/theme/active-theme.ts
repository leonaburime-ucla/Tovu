import { findStoredTheme, validThemeIds, type DiscoveredTheme } from "./theme.js";

/**
 * @file "Given a list of discovered themes and a candidate active id, which theme actually
 * renders" — moved here 2026-08-16 from `server/routes/site/pages.ts` (2026-08-16 architecture
 * follow-up: edge 2 of the export<->server decoupling — see
 * `ADS-memory/reports/2026-08-16-export-edge-decoupling.md`). Was already a pure `(deps) => value`
 * query with zero `req`/`res`/middleware coupling; the only reason it lived in the routing layer
 * was history, not a real dependency. `export/route-manifest.ts` used to import it straight from
 * `server/routes/site/pages.ts` (a real runtime edge into the composition-root module, flagged by
 * `check:architecture`'s module-cycle detector) purely to reuse this exact logic — this file is the
 * shared home `pages.ts` and `route-manifest.ts` (and now `products.ts`, which used to keep its own
 * private duplicate rather than create the same cross-file coupling) import from instead.
 *
 * Deliberately does NOT also carry `resolveActiveThemeId` (which `pages.ts` calls immediately
 * before this) even though the two are always used together at every real call site — that function
 * has ZERO dependency on theme data (it only reads `PresentationSettingsRepoPort` and returns a bare
 * string), and giving it a home here would have created a real `features/theme -> features/
 * presentation` edge that pulls this whole module into the pre-existing 36-module fused
 * strongly-connected component `features/presentation` already belongs to (measured, not assumed —
 * see `active-theme-id.ts`'s own file header in `features/presentation/` for the full trace and the
 * before/after SCC membership diff). Two files instead of one, so that "used together" and
 * "belongs together" stay separate questions.
 *
 * Deliberately typed against a narrow, LOCAL structural interface below rather than `RouteDeps`
 * (`server/routes/types.ts`) — importing `RouteDeps` here, even as a type-only import, would just
 * relocate the exact edge this move exists to remove (`check-architecture.ts`'s dependency-cruiser
 * pass resolves `--ts-pre-compilation-deps`, so a type-only import counts as a real graph edge, not
 * only a runtime one). `RouteDeps` is a structural superset of it, so every real caller (which
 * always has a full `RouteDeps` in hand) passes it through unchanged, exactly the way `pages.ts`'s
 * own pre-existing `TemplateRenderDeps`/`ContentMarkerResolutionDeps` `Pick`s already do.
 */

/** The narrow slice {@link resolveActiveTheme} needs. */
export interface ActiveThemeResolutionDeps {
  themes: DiscoveredTheme[];
}

/**
 * The stock theme a site falls back to when its configured theme id no longer resolves.
 *
 * A NAME, not a position. Before this constant existed the fallback was
 * `deps.themes.find((t) => t.status === "valid")` — the first valid theme in DISCOVERY order, and
 * discovery sorts by `manifest.id.localeCompare` (`theme.ts`'s `discoverAllBuiltInThemes`). `basic`
 * won on every real site purely by coincidence of naming: installing a theme called `aurora` would
 * have silently made it the default for every site whose configured theme had gone missing.
 * `server/runtime/configuration/seed.ts` recorded that exact bug in 2026-08-10 and routed around it
 * by hardcoding `"basic"` into the seeded presentation row instead of fixing the resolver, which
 * left the seed's literal and the resolver's implicit winner as two independent facts that merely
 * happened to agree. Both now read this one name, so they cannot disagree.
 *
 * Lives here rather than in `theme.ts` alongside `ENGINE_SUBFOLDERS`/`THEME_CATALOG_DIR` because its
 * entire meaning is step 2 of {@link resolveActiveTheme} directly below — the pair has to be read
 * together to be understood, and a reader of `theme.ts` has nothing there to say what "default"
 * means. It must stay inside `features/theme` (not `features/presentation`) for the measured reason
 * `features/presentation/active-theme-id.ts`'s own header records: `features/presentation` is inside
 * the pre-existing 36-module SCC and `features/theme` is not, so a constant consumed by
 * `resolveActiveTheme` must not create that edge.
 */
// Renamed from `basic` 2026-09-26; sites still holding a `basic` folder or a stored `basic` id
// resolve through `theme-id-aliases.ts`.
export const DEFAULT_THEME_ID = "tovu-theme";

/**
 * Stored in `active_theme_id` to mean "the operator deliberately turned the theme OFF" — state 3 of
 * the optional-theme feature, where they intend to handle styling themselves.
 *
 * NOT the empty string, deliberately, even though `""` would have needed no thought. `""` is
 * ALREADY taken: `features/presentation/active-theme-id.ts`'s `resolveActiveThemeId` returns it for
 * "this workspace has no `presentation_settings` row yet" (a freshly created workspace, or a
 * `content.db` mid-seed), and its own doc defines that as "fall back". Spelling the deliberate
 * choice `""` too would have made an unwritten workspace render THEMELESS instead of on the default
 * theme — state 3 arriving where state 2 belongs, which is the exact confusion this feature exists
 * to remove. Fixing it from the other side is not available either: teaching `resolveActiveThemeId`
 * to return {@link DEFAULT_THEME_ID} would create the `features/presentation -> features/theme` edge
 * both files' headers exist to prevent.
 *
 * A distinct literal costs nothing the empty string would have saved: the column is `TEXT NOT NULL`
 * on both dialects so there is no DDL either way, and the settings ledger's mirror schema is
 * `{ type: "string" }` with no enum, so it round-trips unchanged.
 *
 * Shadowing: {@link resolveActiveTheme} tests this value BEFORE consulting discovery, so an
 * operator who happens to have a theme folder with this id finds it unreachable rather than finding
 * "no theme" silently meaning "that theme". Deliberate, and the safer direction of the two.
 */
export const NO_THEME_ID = "none";

/**
 * What {@link resolveActiveTheme} can return. Three outcomes, none of which collapses into another:
 *
 * - a {@link DiscoveredTheme} — render with it;
 * - {@link NO_THEME_ID} — the operator turned the theme off; render UNSTYLED, not an error;
 * - `null` — no theme could be resolved at all (nothing is installed); this is the 500.
 *
 * `NO_THEME_ID` is a truthy string precisely so that every pre-existing `if (!theme)` guard keeps
 * meaning "nothing installed" and does NOT swallow the deliberate case. The union then forces each
 * of the six call sites to be visited by the type checker rather than silently inheriting a
 * behaviour that was only ever written for "the theme is broken".
 */
export type ActiveThemeResolution = DiscoveredTheme | typeof NO_THEME_ID | null;

/**
 * Resolve the theme to render with, in three ordered steps:
 *
 * 1. the configured theme, when discovered and valid;
 * 2. otherwise {@link DEFAULT_THEME_ID}, when discovered and valid — the NAMED default;
 * 3. otherwise the first valid theme, otherwise the first discovered theme, otherwise `null`.
 *
 * This is the render-time fallback that keeps the public site from 500-ing when the active theme id
 * is missing/invalid (SPEC-004 REQ-10, spike-level).
 *
 * Step 2 was inserted 2026-09-12 IN FRONT OF step 3 rather than replacing it, deliberately: step 3
 * is arbitrary (see {@link DEFAULT_THEME_ID}) but it is not useless — it is what still renders a
 * site on which the stock theme was itself deleted. Keeping it means this change can never make a
 * site serve LESS than it did before; it only makes the common case deterministic.
 *
 * The `status === "valid"` bar in step 2 is the same bar step 1 applies. An `invalid` copy of the
 * stock theme falls through to step 3 rather than being rendered — otherwise adding a named default
 * would have started serving a theme the old code correctly refused.
 *
 * Steps 2 and 3 each `console.warn` with distinct wording, because they need distinct remedies
 * (reactivate a theme vs. reinstall the stock theme). Silence is what let the arbitrary-order bug
 * survive long enough to be worked around in `seed.ts` rather than fixed: a site can render the
 * wrong theme indefinitely with nothing anywhere saying so. Per-call rather than once-per-process,
 * matching `static-render.ts`'s existing convention (`renderStaticPage` warns on every request for a
 * theme missing its token sentinel) — a degraded site therefore logs per request, which is the
 * accepted trade here; deduplicating would need module state and make this query stateful.
 * Step 1, the healthy path, is silent.
 *
 * Step 0, ahead of all of it: {@link NO_THEME_ID} short-circuits. A deliberate "no theme" is not a
 * degraded state and must never be substituted for, warned about, or routed into the
 * nothing-installed 500 — including on a site with zero themes installed, where "off" is still
 * exactly what the operator asked for.
 *
 * @complexity O(n) over the discovered-theme list (three linear scans in the worst case).
 */
export function resolveActiveTheme(deps: ActiveThemeResolutionDeps, activeThemeId: string): ActiveThemeResolution {
  if (activeThemeId === NO_THEME_ID) return NO_THEME_ID;

  const active = findStoredTheme({ themes: deps.themes, id: activeThemeId });
  if (active && active.status === "valid") return active;

  const named = findStoredTheme({ themes: deps.themes, id: DEFAULT_THEME_ID });
  if (named && named.status === "valid") {
    console.warn(
      `[theme] active theme '${activeThemeId}' did not resolve; falling back to the default theme '${DEFAULT_THEME_ID}'`
    );
    return named;
  }

  const substitute = deps.themes.find((t) => t.status === "valid") ?? deps.themes[0] ?? null;
  console.warn(
    substitute === null
      ? `[theme] active theme '${activeThemeId}' did not resolve and no theme is installed at all (default '${DEFAULT_THEME_ID}' is absent); the site has no theme to render`
      : `[theme] active theme '${activeThemeId}' did not resolve and the default theme '${DEFAULT_THEME_ID}' is absent or invalid; substituting '${substitute.manifest.id}', which is whichever theme discovery happened to list first`
  );
  return substitute;
}

/**
 * The ids a write path is permitted to STORE: every valid discovered theme, plus the no-theme
 * sentinel.
 *
 * Moved here from `server/inbound/admin-http/routes/presentation/patch-active-theme.ts` (2026-09-24,
 * F7a) once a second caller needed the identical rule: `theme_set_active`
 * (`set-active-theme-tool.ts`) writes through the same `setActiveTheme` chokepoint the admin PATCH
 * route does, and a second private copy of this list would be the one place the two callers could
 * silently drift on which ids a write may target.
 *
 * Jini's `setActiveTheme` validates against a set the CALLER supplies
 * (`@jini-ai/cms/presentation`'s `deps.availableThemeIds ?? ALLOWED_THEME_IDS`) — deliberately, per
 * that module's own header: it is theme-engine agnostic and a host owns theme discovery. Appending
 * the sentinel here is using that seam as documented, not working around it. No Jini edit, no
 * publish, no version bump.
 *
 * **This is the WRITE allowlist, and it is NOT the same list as the admin PATCH route's `get.ts`
 * sibling.** Those two call sites used to be character-for-character identical —
 * `availableThemeIds: validThemeIds(deps.themes)`, same expression, same field name, same import,
 * sibling files in one directory — while meaning two different things. `get.ts`'s copy is echoed to
 * the admin as `AdminPresentation.availableThemeIds` and feeds the theme picker, where the sentinel
 * would render as a blank card. Naming this value (rather than inlining the spread at each call site)
 * exists so the two stop looking interchangeable to anyone reducing duplication across these callers.
 * See `get.ts`'s matching note at its own call site — a comment only on the side that changed would
 * explain the addition but not the asymmetry, and the side that breaks is the one with nothing
 * written on it.
 */
export function writableThemeIds(deps: ActiveThemeResolutionDeps): string[] {
  return [...validThemeIds(deps.themes), NO_THEME_ID];
}
