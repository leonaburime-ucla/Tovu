import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { Express } from "express";

import { resolvePathWithin } from "#src/contracts/core/index";
import { themeIdCandidates } from "#src/features/theme/theme-id-aliases";

import { themeAssetSecurityHeaders } from "./theme-content-security-headers.js";

/**
 * @file Serves a theme's own files at `/theme-assets/{themeId}/...` — originally `static`-tier only
 * (`css/`/`js/`, for `server/http/site/render.ts`'s static-tier branch, which rewrites a page's
 * `../css/`/`../js/` references to this prefix), EXTENDED 2026-08-12 to also cover `templated`-tier
 * theme folders (`content/themes/templated/`) so a Liquid theme's own images/screenshots — previously
 * unreachable at any URL, the reason `storefront` ships zero images and `fashion-modern`'s hero photo
 * and admin-card screenshot both 404'd — can be requested the same way.
 *
 * `express.static(themeDir)` below is unscoped to any subpath — it serves a theme's ENTIRE folder,
 * every file, not just `css/`/`js/`/`assets/`. That was found while reviewing whether `build.sourceDir`
 * (a compiled theme's own framework source) is reachable over HTTP: it is, identically to every other
 * file in the theme, at `/theme-assets/{themeId}/{sourceDir}/...`. Extending this to `templated/`
 * folders makes a theme's own `templates/*.liquid` SOURCE fetchable too, e.g.
 * `/theme-assets/fashion-modern/templates/product.liquid` — a DELIBERATE, not overlooked, choice:
 * (a) it is already exactly as reachable for every static theme's `pages/*.html`, so this is
 * extending an existing "a theme's own folder is public" model to a second tier, not creating a new
 * exposure class; (b) `.liquid` carries no browser-executable MIME type (`express.static`'s
 * `send`/`mime-types` dependency has no entry for it, so it serves as `application/octet-stream`, not
 * `text/html` — verified by request in this change's own test), so unlike the `.svg`/`.html`/`.js`
 * XSS angle closed in `d822d87` for a compiled theme's `sourceDir`, there is no script-execution risk
 * from a bare GET on liquid source; and (c) theme markup is author content the theme's own installer
 * already accepted, not a secret. What this extension does NOT do: it does not touch, narrow, or
 * widen `explore.ts`'s WRITE-time file-extension gate (`isThemeFileWritable`/
 * `SOURCE_DIR_WRITABLE_EXTENSIONS`) — an `.svg` asset with embedded `<script>` was, and remains,
 * writable into ANY theme's (any tier's) plain asset folder (`fileGroup` classifies `.svg` "asset", "a
 * group that has never been read-only"). UPDATE 2026-08-13 (security pass Finding 1): the SERVE-side
 * risk that write-time gap used to carry — a direct GET on such a file executing its script,
 * same-origin with `/api/admin/*` — is now closed here, not in `explore.ts`: every response below
 * carries `themeAssetSecurityHeaders`' `Content-Security-Policy: sandbox` + `X-Content-Type-Options:
 * nosniff` (see that module's own header for the full reasoning and the options rejected). Write access
 * still means "the bytes land in the theme's folder," but no longer means "a direct request to them
 * executes as a document" — see `theme-content-security-headers.ts`.
 *
 * Anyone reasoning about what write access to a theme's files can expose over HTTP must start from
 * "every root passed to `themeRoots` is fully public, whole-folder," not from a narrower claim.
 *
 * `declarative`-tier themes (`content/themes/declarative/`) and the not-yet-built `handlebars` tier are
 * deliberately NOT in `themeRoots` here — no theme in either currently ships any asset a template
 * references by URL (declarative themes are pure JSON block trees; `handlebars/` has no theme folders
 * on disk at all yet), so adding either root would be speculative, untestable dead code. Add a root
 * here the day a theme in that tier actually needs one.
 *
 * ONE dynamic route per root passed, not one `express.static` mount per theme.
 *
 * The per-theme version read the themes directory once at registration and mounted what it found,
 * which meant a theme created afterwards — downloaded, copied from the originals catalog, dropped in
 * by hand — served 404 for every asset until the process restarted. Re-running that loop is not a fix
 * either: Express mounts cannot be removed, so each rescan would stack another handler for the same
 * prefix, forever. Resolving the theme id per request has neither problem, and is less code.
 *
 * Assets are deliberately served for EVERY theme rather than only the active one: switching the
 * active theme is a DB write with no restart, and the admin previews inactive themes, so a request
 * for a non-active theme's CSS is normal traffic rather than something to defend against.
 */
export function registerThemeStaticAssets(app: Express, required: { themeRoots: readonly string[] }): void {
  const roots = required.themeRoots.map((dir) => path.resolve(dir));

  app.use("/theme-assets/:themeId", themeAssetSecurityHeaders, (req, res, next) => {
    const themeId = String(req.params.themeId ?? "");
    // A renamed theme answers to both ids (`theme-id-aliases.ts`): old `/theme-assets/basic/...`
    // URLs baked into stored content keep resolving after the rename, on sites that have either
    // folder. Current name first; a file missing there falls through to the retired folder.
    const themeDirs = [...new Set(themeIdCandidates(themeId).map((id) => resolveThemeDir(roots, id)))].filter(
      (dir): dir is string => dir !== null
    );
    const serveFrom = (index: number): void => {
      const themeDir = themeDirs[index];
      if (themeDir === undefined) {
        next();
        return;
      }
      express.static(themeDir)(req, res, (err?: unknown) => (err ? next(err) : serveFrom(index + 1)));
    };
    serveFrom(0);
  });
}

/**
 * Resolve `<root>/<themeId>` to a real directory for the first `root` (checked in order) where it
 * exists, or `null` if no root has it — the multi-root generalization of the original single-root
 * function (unchanged validation per root, just tried across a list). Tie-break for a `themeId` that
 * happens to exist under more than one root: first root in `roots` wins — today's caller
 * (`app.ts`) always lists `themes/static` before `themes/templated`, so an accidental same-named
 * folder in both resolves to the static one, matching this mount's original (pre-extension) behavior
 * for every theme id that already existed under `themes/static`. No such collision exists on disk
 * today (verified: `ls themes/static themes/templated` share no folder name).
 *
 * Four separate refusals per root, because a path segment now arrives from the request rather than
 * from a `readdirSync` of trusted names:
 * - `..`/separators/absolute paths, rejected by `core/path-containment.ts`'s shared
 *   `resolvePathWithin` — kept even though Express decodes `:themeId` as a single segment, because
 *   that is a property of the routing layer rather than of this function.
 * - the `__original-themes__`/`__marketplace__` catalogs, whose whole purpose is to be a pristine
 *   copy nothing serves or runs; neither is a theme and must not be reachable as one.
 * - ANY dot-prefixed directory name. `.tovu-migrate-staging-*` scratch output (ARCH-001,
 *   2026-08-19) is the case that forced this: `migrate-theme.ts` deliberately leaves that on disk
 *   for dry-run/failure inspection as a direct sibling of real theme folders, and without a
 *   refusal it resolved here exactly like a real theme id -- its whole folder (css, tokens,
 *   screenshots) was servable over HTTP. Refusing the DOT rather than that one literal prefix is
 *   deliberate: it is strictly broader (any hidden dir -- .git, .env.d, a future scratch prefix --
 *   is refused for free), no legitimate theme id is dot-prefixed (verified against
 *   content/themes/static and content/themes/templated), and it needs NO import. The earlier form
 *   imported MIGRATION_STAGING_DIR_PREFIX from features/theme/theme.ts, which made this the only
 *   file in src/server/ importing that 1134-line module and regressed four check:architecture
 *   metrics (propagation cost all-import 11.57->11.87 and runtime-only 1.75->1.8, module API
 *   surface 201->202, core size 16.84%->17.05%) for a single string constant.
 * - anything that simply is not there, which falls through to the next root, then to the normal 404.
 */
function resolveThemeDir(roots: readonly string[], themeId: string): string | null {
  if (themeId === "" || themeId.startsWith("__") || themeId.startsWith(".")) return null;
  for (const root of roots) {
    const candidate = resolvePathWithin(root, themeId);
    if (candidate === null) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
