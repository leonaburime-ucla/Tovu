export {
  discoverThemes,
  discoverAllBuiltInThemes,
  loadTheme,
  findTheme,
  findStoredTheme,
  validThemeIds,
  rescanThemes,
  duplicateThemeIds,
  nextAvailableThemeId,
  resolveTemplateId,
  resolveLiquidTemplateId,
  resolveHandlebarsTemplateId,
  isStandaloneThemePage,
  isPublishableThemePageCandidate,
  ENGINE_SUBFOLDERS,
  THEME_CATALOG_DIR,
  MARKETPLACE_CATALOG_DIR,
  type ThemeManifest,
  type ThemeBuildInfo,
  type ThemeTier,
  type ThemeTokens,
  type TemplateNode,
  type DiscoveredTheme,
} from "./theme.js";

// ADR-020 §5 (2026-08-12) — the install-time conformance gate a `build.source: "compiled"` theme must
// pass. Re-exported so a consumer checking `theme.manifest.build` can also reach the exact gate
// `loadTheme()` itself runs, without a second import path into `build-conformance.ts` directly.
export { checkBuiltThemeConformance, type ConformanceIssue } from "./build-conformance.js";

export {
  listMarketplaceThemes,
  downloadMarketplaceTheme,
  MarketplaceThemeError,
  type MarketplaceListItem,
  type ThemeLineage,
  type DownloadMarketplaceThemeResult,
} from "./marketplace.js";

// Install-local provenance metadata's own sidecar file (2026-08-18 schema v2 decision) — re-exported
// so `explore.ts`'s GET route can read a copy's lineage without a deep import into this feature's
// internals, matching every other cross-feature surface in this barrel.
export { readThemeLineageFile, writeThemeLineageFile, THEME_LINEAGE_FILENAME } from "./theme-lineage.js";

// Milestone 2 (2026-08-18) — the theme v2 package validator's public entry point, re-exported so
// `cli/commands/theme/validate.ts` (and any future caller) reaches it through this barrel rather than
// a deep import into `features/theme/validation/`'s internals.
export {
  validateThemePackage,
  type ThemeValidationProfile,
  type ThemeValidationIssue,
  type ThemeValidationSeverity,
  type ThemeValidationFinding,
  type ValidateThemePackageResult,
} from "./validation/validate-theme-package.js";

// Milestone 3 (2026-08-18) — the theme v2 migration orchestrator's public entry point, same
// deep-import-avoidance reasoning as Milestone 2's validator export just above.
export {
  migrateThemeToV2,
  cleanupMigrationOutput,
  type MigrationStatus,
  type MigrateThemeResult,
} from "./migration/migrate-theme.js";

// Milestone 5 (2026-08-18) — the generated root `index.html` portability snapshot for a `static`-tier
// theme, same deep-import-avoidance reasoning as Milestones 2/3's exports just above.
export {
  buildStaticPortabilityIndex,
  generateStaticPortabilityIndex,
  STATIC_PORTABILITY_INDEX_FILENAME,
  type GenerateStaticPortabilityIndexResult,
} from "./static-portability-index.js";

// Milestone 4 (2026-08-18) — the code-tier build-output normalizer's public entry point (Angular
// `ng build` → Tovu static-asset-contract shape), same deep-import-avoidance reasoning as Milestones
// 2/3/5's exports just above.
export {
  normalizeBuildOutputDirectory,
  planAssetRelocation,
  rewriteBundlerHtml,
  rewriteCssRelativeUrls,
  type AssetRelocation,
  type AssetRelocationPlan,
  type NormalizeBuildOutputResult,
} from "./code-tier-asset-normalizer.js";

export {
  renderStaticPage,
  renderStaticPartial,
  expandPartials,
  injectCurrentEntityContentId,
  injectPageTitle,
  resolveTemplate,
  isEligibleForTemplateBranch,
  isBarePageChoice,
  resolveStaticTierPageShellFallback,
  resolveTemplateBranchChoice,
  type TemplateBranchChoice,
  scanMenuEmbedIds,
  scanPostPreviewsLimit,
  DEFAULT_POST_PREVIEWS_LIMIT,
  MAX_POST_PREVIEWS_LIMIT,
  type StaticMenuItem,
  type StaticPostPreview,
  type PostTemplateResolution,
  // C5 (collections plan, 2026-09-23): the route layer (`pages.ts`'s
  // `resolveCollectionListsForRender`) needs the same per-marker identity key and inner-content
  // splitter `injectCollectionEmbeds` uses, so both sides agree on how a `collection` marker is
  // addressed and how its authored `<template>` is found.
  collectionMarkerKey,
  splitCollectionMarkerInner,
  type StaticCollectionList,
} from "./static-render.js";

// C5 (collections plan, 2026-09-23) — the pure entry-list renderer `pages.ts`'s
// `resolveCollectionListsForRender` calls once per distinct `collection` marker config, plus the
// item/field shapes it builds to feed that renderer. No I/O lives here (see `entry-list-render.ts`'s
// own `@file` doc); the route layer supplies already-fetched, already-formatted values.
export {
  renderEntryList,
  withEntryListStyleOnce,
  type EntryListItem,
  type EntryListFieldValue,
  type EntryListRenderOptions,
} from "./entry-list-render.js";

// 2026-08-16 (export<->server decoupling follow-up) — "given discovered themes + a candidate id,
// which theme renders" query, moved here from `server/routes/site/pages.ts` so `export/
// route-manifest.ts` (and `server/routes/site/products.ts`, which used to keep its own private
// duplicate) can reuse it without a runtime edge into the composition-root module. Its sibling
// query, `resolveActiveThemeId`, deliberately lives in `#src/features/presentation/index` instead,
// NOT here — see `active-theme.ts`'s own file header for why splitting them avoids a real SCC
// regression a combined home would have caused.
// `DEFAULT_THEME_ID` (2026-09-12) rides along: it is the one name `seed.ts` and `resolveActiveTheme`
// must agree on, and the barrel is how `server/runtime/configuration/seed.ts` reaches it without a
// deep import, same as every other export here.
export {
  resolveActiveTheme,
  writableThemeIds,
  DEFAULT_THEME_ID,
  NO_THEME_ID,
  type ActiveThemeResolution,
  type ActiveThemeResolutionDeps,
} from "./active-theme.js";
export { RENAMED_THEME_IDS, themeIdCandidates } from "./theme-id-aliases.js";

// ADR-020 §3 (C6) Tier-2 guardrail: re-exported so `server/http/site/liquid-worker.ts`
// can run the same lint defensively at render time that `loadTheme()` runs at publish time.
export { lintLiquidTemplate, ALLOWED_LIQUID_TAGS, ALLOWED_LIQUID_FILTERS } from "./liquid-allowlist.js";

// Same ADR-020 §3 (C6) pairing for the Handlebars tier: re-exported so
// `server/http/site/handlebars-worker.ts` can run the same lint defensively at render time that
// `loadTheme()` runs at publish time.
export {
  lintHandlebarsTemplate,
  ALLOWED_HANDLEBARS_BLOCK_HELPERS,
  ALLOWED_HANDLEBARS_HELPERS,
  ALLOWED_HANDLEBARS_RAW_PATHS,
  ALLOWED_HANDLEBARS_DATA_VARS,
} from "./handlebars-allowlist.js";

// The Explore screen's file read/write surface (`server/routes/admin/themes/explore.ts`) —
// genuinely public, backing an admin route, no single-caller boot-sequence caveat like site-dir's.
export {
  copyThemeFile,
  deleteThemeFile,
  isGeneratedThemePath,
  listThemeFiles,
  MAX_THEME_FILE_BYTES,
  nextAvailableFileName,
  readThemeFile,
  renameThemeFile,
  resetThemeFileToOriginal,
  resolveThemeFileWriteScope,
  resolveThemeOriginalSource,
  restoreBuiltThemeGeneratedTree,
  themeFileDiffersFromOriginal,
  themeOriginalResetRefusal,
  writeThemeFile,
  ThemePathError,
  type ThemeFileWriteScope,
  type ThemeOriginalResetRefusal,
  type ThemeOriginalSource,
} from "./theme-files.js";

// 2026-08-19 architecture audit findings 1 & 2 — the one apiVersion-aware theme-layout resolver,
// shared by `server/routes/admin/themes/explore.ts` and (via the `@tovu/theme-layout` alias,
// `apps/admin/vite.config.ts`) the admin SPA. See `theme-layout.ts`'s own file header.
export { resolveThemeLayout, isPageFilePath, isPartialFilePath, type ThemeLayout } from "./theme-layout.js";

// 2026-08-19 architecture audit finding 4 — re-exported so `routes/site/pages.ts`'s missing-template
// diagnostic builder can pick the same apiVersion-correct `<link>` sentinel `renderStaticPage` itself
// already matches against, instead of a hardcoded v1-only literal.
export { tokenStylesheetSentinel } from "./static-asset-contract.js";

// 2026-08-27 (`infra/` -> `sites/<name>/` move) — the first-boot copy that gets a site's themes out
// of the package tree an upgrade replaces. Re-exported so `server/deps.ts`'s composition root does
// not deep-import it, same reasoning as every export above.
export { seedSiteThemes, type SeedSiteThemesResult, type SeedSiteThemesStatus } from "./seed-site-themes.js";

// 2026-08-30 — the shared "can this file's identity (name/existence) change" gate, extracted from
// `server/inbound/admin-http/routes/themes/explore.ts` so `tool-registrations.ts`'s
// `theme_rename_file`/`theme_delete_file` can call the SAME decision `explore.ts`'s own rename/delete
// routes call, rather than a second copy that could drift — see `file-identity-lock.ts`'s own header
// for why a deep import from either side was not an option.
export {
  fileGroup,
  fileExtension,
  isInsideCompiledSourceDir,
  isSourceDirWritableExtension,
  isTrashedThemePath,
  requiredThemeFiles,
  validateFileIdentityChange,
  IDENTITY_LOCKED_GROUPS,
  TRASH_DIR_NAME,
  type ThemeFileGroup,
  type FileIdentityLockResult,
} from "./file-identity-lock.js";

// 2026-09-16 (w4 lifecycle design "D") — generates `__original-themes__` from the shipped tree it
// mirrors instead of hand-maintaining it. Re-exported so `cli/commands/theme/sync-originals.ts` and
// the drift canary (`__tests__/shipped-theme-original-drift.canary.test.ts`) both reach it through
// this barrel, same reasoning as every export above.
export {
  syncThemeOriginals,
  writeGeneratedThemeOriginal,
  diffThemeFolders,
  relativeFilePaths,
  type SyncThemeOriginalsResult,
  type SyncThemeOriginalsThemeResult,
} from "./sync-originals.js";
