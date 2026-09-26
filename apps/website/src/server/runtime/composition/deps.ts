import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { InMemoryEventBus } from "#src/contracts/core/events/index";
import { createObservabilityPort } from "#src/platform/observability/index";
import { resolveProductRoot } from "#src/platform/site-dir/product-root";
// A plain static import, unlike `createApp`/`exportSite` below: `resolveStorefrontProducts` has no
// eager top-level side effect (`routes/site/products.ts`'s module body only declares functions/a
// route registrar), so there is no load-order hazard to defer — see `routes/types.ts`'s
// `resolveStorefrontProducts` doc for why this field exists at all.
import { resolveStorefrontProducts } from "../../inbound/public-http/routes/site/products.js";
import { backfillPostSearchIndex, SqlitePostRepo, SqlitePostSearchIndex, createPostRevertRegistry, listPublishedPosts } from "#src/features/post/index";
import { SqliteDeploymentsReadRepo } from "#src/features/deployments/index";
import { resolveAgentPluginLayout } from "#src/features/agent-plugins/layout";
import { resolveSkillLayout } from "#src/features/skills/layout";
import type { SiteBackupSources } from "#src/features/site-backup/sources";
import { SqlitePublishCredentialSetRepo } from "#src/platform/db/sqlite/publish-credential-repo.sqlite";
import { SqlitePublishHistoryStore } from "#src/platform/db/sqlite/publish-history-repo.sqlite";
import { SqlitePublishContentBundleRepo } from "#src/platform/db/sqlite/publish-content-bundle-repo.sqlite";
import { SqlitePublishContentPeerRepo } from "#src/platform/db/sqlite/publish-content-peer-repo.sqlite";
import { SqlitePublishContentBaselineRepo } from "#src/platform/db/sqlite/publish-content-baseline-repo.sqlite";
import { SqlitePublishContentRunRepo } from "#src/platform/db/sqlite/publish-content-run-repo.sqlite";
import { SqlitePublishTrustRevocationStore } from "#src/platform/db/sqlite/publish-trust-revocations.sqlite";
import { createPublishContentApplyPort, toPublishContentApplyDeps } from "#src/features/publish-content/apply-loop";
import { createFileBlobIndex } from "#src/features/publish-content/file-blob-index";
import { createSqlitePublishContentSeedHash } from "./publish-content-seed-hash.js";
import { SqliteCustomCredentialSetRepo } from "#src/platform/db/sqlite/custom-credential-repo.sqlite";
import { createDefaultHttpClient } from "#src/platform/http/client";
import {
  CUSTOM_CREDENTIALS_EGRESS_POLICY,
  MEDIA_IMPORT_EGRESS_POLICY,
  SINGLE_HOP_HTTPS_EGRESS_POLICY,
  createPublishContentPeerEgressPolicy,
  parsePublishContentDevHosts,
} from "#src/platform/http/egress-policies";
import { createResolvedMailer } from "../boot/resolve-mailer.js";
import { SqliteSourceControlCredentialSetRepo } from "#src/platform/db/sqlite/source-control-credential-repo.sqlite";
import { SqliteVendorCredentialSetRepo } from "#src/platform/db/sqlite/vendor-credential-repo.sqlite";
import { executionModeFromEnv } from "#src/features/deployments/publish-credentials/index";
import { InMemoryPublishCredentialVerificationCache } from "#src/features/deployments/static-publish/index";
import { PagesHtmlDocumentStore } from "#src/features/pages/index";
import {
  createChatStoreFactory,
  createSqliteAgentSessionStore,
  ensurePublicAssistantSettingDefinitions,
  ensureExecutionSettingDefinitions,
} from "#src/assistant/index";
import { SqlitePresentationSettingsRepo, resolveActiveThemeId } from "#src/features/presentation/index";
import { SqliteSettingsRepo } from "#src/features/settings/repo.sqlite";
import { SqliteToolAttemptAuditSink } from "#src/features/tool-audit/repo.sqlite";
import { discoverAllBuiltInThemes, rescanThemes, seedSiteThemes } from "#src/features/theme/index";
import { SqliteWorkspaceRepo } from "#src/features/workspace/index";
import { openContentDb, type ContentDb } from "#src/platform/db/sqlite/content-db";
import { hydrateContentDbFromSeed } from "#src/platform/db/sqlite/hydrate-content-db-from-seed";
import { hydrateBlobStoreFromSeed } from "#src/features/media/hydrate-blob-store-from-seed";
import { resolveWorkspace } from "#src/platform/site-dir/resolve-workspace";
import { createLiveSiteDisplayName } from "#src/platform/site-dir/read-site-dir";
import { resolveSiteRoot, resolveCheckoutRoot, describeSiteBinding, type SiteBinding } from "#src/platform/site-dir/index";
import { recoverIncompleteDataModuleMigrations } from "#src/features/plugins/migration-recovery";
import { SqliteChangeSetRepo } from "#src/platform/db/sqlite/change-set-repo.sqlite";
import { SqliteOutboxAdapter } from "#src/platform/db/sqlite/outbox-repo.sqlite";
import { SqliteTokenStore } from "#src/platform/db/sqlite/gated-mutation-token-repo.sqlite";
import { openDatabaseJournalDb } from "#src/platform/db/sqlite/database-journal-db";
import { openChatDb } from "#src/platform/db/sqlite/chat-db";
import { warnOnOrphanedChatRows } from "#src/platform/db/sqlite/chat-orphan-check";
import { SqliteMigrationRunsRepo, SqliteDatabaseLedgerRepo } from "#src/platform/db/sqlite/database-journal-repo";
import { ensureSeoSettingDefinitions } from "#src/features/seo/index";
import { installNewsletterDataModule } from "#src/features/newsletter/data-module-manifest";
import { ensureDefaultList } from "#src/features/newsletter/lists";
import { createHookRegistry } from "#src/features/newsletter/hooks";
import {
  SqliteNewsletterAudienceSnapshotRepo,
  SqliteNewsletterCampaignRepo,
  SqliteNewsletterConfirmationTokenRepo,
  SqliteNewsletterListRepo,
  SqliteNewsletterSendRepo,
  SqliteNewsletterSubscriptionRepo,
} from "#src/features/newsletter/repo.sqlite";
import { MembersSubscriberDirectory } from "#src/features/members/index";
import {
  seededPosts,
  seededPresentation,
  seededWorkspace,
  seedSettingsFromPresentation,
  SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID,
} from "../configuration/seed.js";
import { SqliteBufferSink } from "#src/platform/db/sqlite/analytics-sink.sqlite";
import {
  SqliteMagicLinkTokenRepo,
  SqliteMemberRepo,
  SqliteMemberSessionRepo,
  SqliteMemberSubscriptionRepo,
  SqliteMemberTierRepo,
} from "#src/features/members/index";
import { SqliteCommercePriceRepo, SqliteCommerceProductRepo } from "#src/features/commerce/repo.sqlite";
import { rebuildNavLocationBindings, registerMenuReverters } from "#src/features/navigation/index";
import { SqliteMenuRepo, SqliteNavLocationBindingRepo } from "#src/features/navigation/repo.sqlite";
import { buildMenuTrashFollowUpHooks } from "#src/features/navigation/menu-trash-follow-ups";
import { SqliteWebhookDeliveryRepo, SqliteWebhookSubscriptionRepo } from "#src/platform/db/sqlite/webhook-repo.sqlite";
import { EnvOrFileKeyring } from "#src/features/webhooks/keyring.env";
import { resolveSiteKeyId, siteKeySources } from "#src/features/webhooks/site-key-sources";
import { createKeyringBackedSigner } from "#src/features/webhooks/signing.keyring";
import { AesGcmSecretSealer } from "#src/features/webhooks/secret-sealer.aesgcm";
import { SqliteSiteAssistantCredentialRepo } from "#src/platform/db/sqlite/site-credential-repo.sqlite";
import { SqliteAdminExecutionCredentialRepo } from "#src/platform/db/sqlite/execution-credential-repo.sqlite";
import { SqliteComposioConfigRepo } from "#src/platform/db/sqlite/composio-config-repo.sqlite";
import { SqliteConnectorCredentialRepo } from "#src/platform/db/sqlite/composio-connector-credential-repo.sqlite";
import { SqliteMediaProviderCredentialRepo } from "#src/platform/db/sqlite/media-provider-credential-repo.sqlite";
import { SqliteExternalMcpServerRepo } from "#src/platform/db/sqlite/external-mcp-repo.sqlite";
import { createComposioConnectors } from "#src/platform/connectors/composio-service";
import {
  LocalFsBlobStore,
  purgeMedia,
  S3BlobStore,
  SharpImageTransformer,
  type BlobStorePort,
} from "#src/features/media/index";
import { ensureCoreMediaTransform } from "#src/features/media/bootstrap";
import { createSqliteIdentityRouteDeps, type IdentityRouteDepsSlice } from "#src/features/identity/wiring";
import {
  resetAdminPasswordSelfVerified,
  AdminPasswordResetVerificationFailedError,
} from "#src/features/identity/reset-admin-password-self-verified";
import { SqliteUserPurge } from "#src/features/identity/user-purge.sqlite";
import type { IdentityRepos } from "@jini-ai/cms/identity";
import type { ClockPort, IdGeneratorPort } from "@jini-ai/cms/core";
import { SqliteFormDefinitionRepo, SqliteFormSubmissionRepo } from "#src/features/forms/repo.sqlite";
import { FORMS_SUBMIT_PROFILE } from "#src/features/forms/rate-limit-profile";
import { createRateLimiter, SITE_ASSISTANT_PER_IP } from "#src/contracts/core/rate-limit/rate-limit";
import type { RouteDeps } from "../../routes/types.js";
import type { NewsletterRouteDeps } from "../../inbound/admin-http/routes/newsletter/deps.js";
import { createVerifiedOrigin, OriginRegistry, planOriginBoot } from "#src/features/origin/index";
import { registerConfiguredOrigin, seedDevCapabilityOrigin, SqliteOriginSettingRepo } from "#src/platform/db/sqlite/origin-repo.sqlite";
import { deriveDevScheme, resolveDevTls, resolveDevTlsCertPaths } from "../boot/dev-tls.js";
import {
  SqliteAssetBlobRepo,
  SqliteAssetRenditionRepo,
  SqliteMediaContentTypeStore,
  SqliteMediaRepo,
  SqliteTransformDefinitionRepo,
} from "#src/platform/db/sqlite/media-repo.sqlite";
import {
  RedirectHitSinkImpl,
  RedirectPhaseHandlerResolver,
  redirectMatcher,
  RedirectSlugChangeCapture,
  registerRedirectHitOutboxHandler,
  registerRedirectsPhaseHandlers,
  SqliteRedirectRepo,
  type RedirectsWriteDeps,
} from "#src/features/redirects/index";
import { registerSlugChangeCapture } from "#src/platform/routing/index";
import { SqliteDbOpsAdapter } from "#src/platform/db/sqlite/db-ops";
import { SqliteRestorePointsRepo } from "#src/platform/db/sqlite/database-journal-repo";
import { SqliteDatabaseIntrospectionAdapter } from "#src/platform/db/sqlite/database-introspection-adapter.sqlite";
import { InMemorySiteStatusRepo } from "#src/features/database/repo.memory";
import { NoopContentTypeIndexProvisioner } from "#src/features/content-types/index";
import { SqliteContentTypeRepo } from "#src/features/content-types/repo.sqlite";
import { SqliteEntryRepo } from "#src/features/entries/repo.sqlite";
import { SqliteWidgetRegionBindingRepo } from "#src/features/widgets/repo.sqlite";
import { buildWidgetsDeps } from "#src/features/widgets/deps";
import { adoptLegacyTrashedWidgets, restoreWidgetPriorStatus } from "#src/features/widgets/write-service";
import { SqliteEntryRefsRepo } from "#src/platform/db/sqlite/entry-refs-repo.sqlite";
import { SqlitePluginActivationRepo } from "#src/features/plugin-runtime/repo.sqlite";
import { WORD_COUNT_RUNTIME_SOURCE } from "#src/features/plugin-runtime/built-ins/word-count/index";
import { forgetPluginActivations, type RemovePluginFn } from "#src/features/plugin-runtime/uninstall";
import { composePluginRuntime } from "./plugin-runtime.js";
import { isAdminAssistantEnabled } from "./admin-assistant-enabled.js";
import { wireCoreResolvers } from "#src/features/widgets/resolvers/index";
import { createNavMenuReadModel } from "#src/features/navigation/index";
import { createCommentsModule, ensureCommentsSettingDefinitions, HeuristicSpamCheck } from "#src/features/comments/index";
import {
  ensureSettingsUiTabDefinitions,
  getEffective,
  set,
  resolveDefinitionRaw,
  registerDefinitions,
  ensureSettingDefinitions,
  SCOPE_BIT,
  INSTRUCTIONS_NAMESPACE,
} from "#src/features/settings/index";
import { createSettingsAnalyticsConfig, ensureAnalyticsSettingDefinitions } from "#src/features/analytics/config.settings";
import {
  ensureSiteTitleSettingDefinition,
  preserveLegacySiteTitles,
  type SiteDisplayNameSource,
} from "#src/features/settings/site-title";
import { SqliteSiteTitlePreservationStore } from "#src/features/settings/site-title-preservation.sqlite";
import { SqliteCommentRepo } from "#src/features/comments/repo.sqlite";
import {
  bindRemoveEntity,
  COMMENT_ENTITY_TYPE,
  bindForgetRemovedEntity,
  buildTrashRegistry,
  createCommentTrashAdapter,
  createContentDbTransactionRunner,
  createDirectoryTrashAdapter,
  unhideIfRemoveThrows,
  createMediaTrashAdapter,
  createPostTrashAdapter,
  createRedirectTrashAdapter,
  createSqliteTrashDb,
  createTableTrashAdapter,
  createTrashService,
  createTrashSweep,
  MEDIA_ENTITY_TYPE,
  PLUGIN_ENTITY_TYPE,
  POST_ENTITY_TYPE,
  REDIRECT_ENTITY_TYPE,
  SqliteTrashRepo,
  USER_ENTITY_TYPE,
  createUserTrashAdapter,
  type RemoveEntity,
  type TrashAdapter,
  type TrashedItemsRef,
  type TrashFollowUpHooks,
  withFollowUps,
} from "#src/features/trash/index";
import * as contentSchema from "#src/platform/db/schema.sqlite";
import { installCommentsDataModule } from "#src/features/comments/data-module-install";
import {
  SqliteEntryTermRepo,
  SqliteTaxonomyRepo,
  SqliteTaxonomyRevisionRepo,
  SqliteTermRepo,
  sqliteStampWatermark,
} from "#src/features/taxonomy/repo.sqlite";
import { toTaxonomyOutbox } from "#src/features/taxonomy/index";
import { createTermPurgeFollowUp, createTaxonomyPurgeFollowUp } from "#src/features/taxonomy/taxonomy-trash-follow-ups";
import { AlwaysUnavailableWatermarkSource, RestorePointDeepLinkLookup } from "#src/features/recovery/repo.memory";
import { buildGatewayDeps, buildOwnerOnlyInstanceAuthorize } from "#src/contracts/core/gated-mutations/composition";
import { resolveRuntimeMode } from "#src/contracts/core/runtime-mode";
import { wrapMailerWithPurposeGate } from "#src/platform/mail/purpose-scoped-mailer";
import { createExternalMcpOAuthService } from "#src/assistant/index";
import { createSqliteDeviceAuthorizationStore, createSqlitePendingAuthorizationStore } from "#src/platform/db/sqlite/oauth-pending-store.sqlite";

// Kept LAST on purpose. `app.ts` imports this file back (`builtInThemesDir` and the three
// `resolve*RootDir` functions), so `createApp` below closes the `deps.ts` <-> `app.ts` cycle that
// `.dependency-cruiser.mjs`'s `no-circular` header records. It is safe because neither module's
// top level uses the other's exports: this file's top level declares only functions. Keeping these
// last means a process that loads this file first (every `tovu` CLI command) still evaluates every
// import above in its existing order. Both were call-time `require()`s until 2026-09-16 (t91
// F4.1-A): under tsx, `require()` of a first-party `.ts` module loads a second, CommonJS-compiled
// copy of that module and its whole graph, so the site app built here read empty copies of the
// routing, page-head and event-subscription registries — exports and site inspection served no
// redirects. `src/__tests__/no-first-party-require.boundary.test.ts` now forbids that pattern.
import { exportSite } from "#src/platform/export/index";
import { createApp } from "./app.js";

/**
 * The one site folder this process serves — the root every other runtime path below derives from.
 *
 * Replaces the old `infra/` convention (2026-08-27). `infra/` conflated two different things: the
 * repo's own scratch space, and the SITE's data. They have opposite lifecycles — upgrading Tovu
 * should replace the first and never touch the second — and keeping them in one directory is why
 * a site's themes ended up living inside the package (`src/themes/`), where an upgrade destroys
 * them along with their own "reset to original" backups.
 *
 * A site is a portable folder that owns its own `content.db`, `uploads/`, `themes/`, and journals
 * — ADR-012's install-dir model, already implemented for the CLI by SPEC-003's `tovu init` /
 * `tovu serve <dir>` (`site-dir/boot-site-dir.ts`). This function is that same model's DEFAULT for
 * the non-CLI boot path (`src/index.ts`), which previously had no site folder at all and derived
 * everything from `process.cwd()`.
 *
 * A thin `process`-reading wrapper, not the rule itself: {@link resolveSiteRoot} (`site-dir/`) owns
 * the `TOVU_SITE_DIR` / `TOVU_SITE` precedence, because `features/skills/layout.ts` and
 * `features/agent-plugins/layout.ts` need the same answer and must not import this composition
 * root to get it. Every `TOVU_*_DIR` below still overrides its own subpath independently, so a
 * deployment that relocates exactly one directory (a large uploads volume, say) does not have to
 * move the rest.
 */
export function siteDir(): string {
  return resolveSiteRoot();
}

/**
 * Root directory `LocalFsBlobStore` writes blob bytes under (ADR-012 `uploads/` convention,
 * mirroring `defaultContentDbPath()` below).
 */
export function mediaUploadsDir(): string {
  // Sibling of `defaultContentDbPath()`'s `<site>/content.db` — both now derive from the same
  // {@link siteDir}. Note this one is NOT derived from `dirname(contentDbPath)`, so a deployment
  // that overrides `TOVU_CONTENT_DB` alone still leaves uploads here; that independence is why
  // `uploads/` was historically the one runtime directory that did not follow the database
  // automatically, and it is preserved deliberately.
  return process.env.TOVU_MEDIA_UPLOADS_DIR ?? join(siteDir(), "uploads");
}

/**
 * Resolves the real running server's `BlobStorePort` — `LocalFsBlobStore` by default (unchanged
 * for every existing install), or `S3BlobStore` when an operator opts in with
 * `TOVU_MEDIA_BLOB_STORE=s3`. This is the ONE seam a deployment needs to point Tovu's media bytes
 * at S3-compatible object storage instead of a local volume — every read/write path (`/m/...`
 * rendition serving, admin upload/purge, static export's asset crawl) already goes through
 * whatever `RouteDeps.blobStore` this returns, so no other file changes for this to take effect.
 *
 * Fails LOUD, not silently, when the opt-in is set but incomplete: an operator who typos
 * `TOVU_MEDIA_BLOB_STORE=s3` without also setting the bucket/region/credential vars needs to see a
 * startup error, not have their install quietly fall back to writing local files nobody expected
 * (which would then look like "media works" until the next deploy wipes the ephemeral disk).
 *
 * @complexity O(1) — a handful of env reads and a branch.
 */
function resolveBlobStore(uploadsDir: string): BlobStorePort {
  const backend = process.env.TOVU_MEDIA_BLOB_STORE ?? "local";
  if (backend === "local") {
    return new LocalFsBlobStore({ rootDir: uploadsDir });
  }
  if (backend !== "s3") {
    throw new Error(`Unknown TOVU_MEDIA_BLOB_STORE '${backend}' — expected 'local' or 's3'.`);
  }
  // Each entry pairs the env var name with its resolved value, so a missing one can be reported
  // by its real name below rather than reconstructed from an object key.
  const requiredVars: Array<[name: string, value: string | undefined]> = [
    ["TOVU_S3_BUCKET", process.env.TOVU_S3_BUCKET],
    ["TOVU_S3_REGION", process.env.TOVU_S3_REGION],
    ["TOVU_S3_ACCESS_KEY_ID", process.env.TOVU_S3_ACCESS_KEY_ID],
    ["TOVU_S3_SECRET_ACCESS_KEY", process.env.TOVU_S3_SECRET_ACCESS_KEY],
  ];
  const missing = requiredVars.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`TOVU_MEDIA_BLOB_STORE=s3 requires ${requiredVars.map(([name]) => name).join(", ")} — missing: ${missing.join(", ")}.`);
  }
  const [, bucket] = requiredVars[0];
  const [, region] = requiredVars[1];
  const [, accessKeyId] = requiredVars[2];
  const [, secretAccessKey] = requiredVars[3];
  return new S3BlobStore({
    bucket: bucket as string,
    region: region as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    endpoint: process.env.TOVU_S3_ENDPOINT,
    keyPrefix: process.env.TOVU_S3_KEY_PREFIX,
  });
}

/**
 * The read-only STOCK themes tree that ships with the product: `content/themes/`, copied to
 * `dist/content/themes/` at build time (mirrors `content/templates/` -> `dist/content/templates/`)
 * and resolved package-relative to this file — never `process.cwd()` (CR-R04 fix: `tovu serve` used
 * to read `process.cwd()/themes`, which is wrong whenever the CLI is invoked from outside the repo
 * checkout).
 *
 * Walks up to find the product root rather than counting `../` segments — see `product-root.ts`'s
 * header for why a fixed count can't be correct in both the source and compiled trees after the
 * 2026-08-28 `apps/website/` rename (this file's own source and compiled locations are no longer
 * the same number of levels from `content/`, only the compiled one used to be assumed here).
 *
 * SEED SOURCE ONLY as of 2026-08-27. Nothing serves or writes this tree at runtime any more —
 * `RouteDeps.themesDir` is {@link siteThemesDir}, and `seedSiteThemes()` copies this into a site
 * once, on the first boot where the site has no `themes/` of its own. That split is the whole point
 * of the `infra/` -> `sites/` move: an upgrade replaces `src/` (and therefore this tree), so a
 * site's edited themes and their `__original-themes__/` backups cannot live here.
 *
 * The env var is `TOVU_STOCK_THEMES_DIR`, NOT `TOVU_THEMES_DIR` — the latter moved to
 * {@link siteThemesDir}, where "where MY themes live" is what an operator setting it actually
 * means.
 */
export function builtInThemesDir(): string {
  return process.env.TOVU_STOCK_THEMES_DIR ?? join(resolveProductRoot(), "content", "themes");
}

/**
 * `TOVU_THEMES_DIR` env, then `<site>/themes` — the site's OWN themes root, and the only theme tree
 * anything reads or writes at runtime (`RouteDeps.themesDir`: the Theme Studio's file editor, the
 * agent theme tools, marketplace downloads, `__original-themes__/` resets, and both static-asset
 * mounts in `server/app.ts`).
 *
 * Seeded from {@link builtInThemesDir} on a site's first boot — see `seedSiteThemes()`'s own header
 * for why that copies the whole ~19MB tree rather than filling in on demand.
 */
export function siteThemesDir(): string {
  return process.env.TOVU_THEMES_DIR ?? join(siteDir(), "themes");
}

/**
 * The read-only STOCK content seed a self-hosted container image ships for one specific site:
 * `content/seed-sites/<site>/content.seed.db`, copied there — from the tracked
 * `sites/<site>/content.seed.db` (`npm run seed:site`, development/scripts/seed-site.mjs) — by the
 * Dockerfile's OWN build stage only, deliberately never by the shared `npm run build` that
 * {@link builtInThemesDir} above also relies on: that script also produces the npm-publishable CLI
 * package, which must ship blank starter content, not this owner's own pruned site.
 *
 * SEED SOURCE ONLY, same split as {@link builtInThemesDir}/{@link siteThemesDir}:
 * `hydrateContentDbFromSeed()` copies this into {@link defaultContentDbPath} once, on a site's first
 * boot where `content.db` does not exist yet, and never again — an existing `content.db` is
 * production data, and overwriting it on a later redeploy is unrecoverable data loss. Living under
 * `content/`, not `sites/`, is what lets it survive `fly.toml`'s volume mount over
 * `/workspace/Tovu/sites`: that mount shadows the ENTIRE image `sites/` tree at runtime, so anything
 * shipped there for a fresh volume to read would be invisible the moment the mount takes effect.
 *
 * The env var is `TOVU_STOCK_CONTENT_SEED_DIR`, mirroring `TOVU_STOCK_THEMES_DIR`'s own escape
 * hatch. `siteName` defaults to this process's own site (`basename(siteDir())`) — decoupled from
 * `TOVU_CONTENT_DB`, which can relocate `content.db` itself without changing which site's stock
 * seed applies.
 */
export function builtInContentSeedDbPath(siteName: string = basename(siteDir())): string {
  const stockRoot = process.env.TOVU_STOCK_CONTENT_SEED_DIR ?? join(resolveProductRoot(), "content", "seed-sites");
  return join(stockRoot, siteName, "content.seed.db");
}

/**
 * The read-only STOCK upload payload a self-hosted container image ships for one specific site:
 * `content/seed-sites/<site>/uploads/`, the sibling the Dockerfile's build stage now stages
 * alongside `content.seed.db` (see that file's comment at the extraction loop). Same stock root as
 * {@link builtInContentSeedDbPath} — deliberately not a second env var: the two are always shipped
 * together, at the same physical location, as one seed payload for one site.
 *
 * SOURCE ONLY, consumed by `hydrateBlobStoreFromSeed()` — see that function's own header for why it
 * tops up the live `blobStore` one content-addressed key at a time rather than copying this
 * directory wholesale the way {@link builtInThemesDir}/`seedSiteThemes()` copy `themes/`.
 */
export function builtInSeedUploadsDir(siteName: string = basename(siteDir())): string {
  const stockRoot = process.env.TOVU_STOCK_CONTENT_SEED_DIR ?? join(resolveProductRoot(), "content", "seed-sites");
  return join(stockRoot, siteName, "uploads");
}

/**
 * Agent Plugins that ship WITH the product live in `content/agent-plugins/<pluginId>/`, copied to
 * `dist/content/agent-plugins/` at build time and resolved package-relative to this file — the exact
 * same shape as {@link builtInThemesDir} immediately above, including the product-root walk-up that
 * makes it land correctly in both the source and compiled layouts, and for the same reason (CR-R04:
 * a `process.cwd()`-relative path is wrong the moment the CLI is invoked from outside the checkout).
 *
 * Deliberately NOT `<site>/agent-plugins/`. That directory is `layout.ts`'s per-workspace INSTALL
 * root — gitignored site data (`sites/README.md`), populated by extraction, and frozen read-only
 * per digest. Product-shipped source cannot live there: it would not be tracked, would not ship in
 * a release, and would collide with the content-addressed tree the installer owns. Bundled source
 * is an INPUT to installation (`features/agent-plugins/seed-bundled.ts`), not a location within it.
 */
export function bundledAgentPluginsDir(): string {
  return process.env.TOVU_BUNDLED_AGENT_PLUGINS_DIR ?? join(resolveProductRoot(), "content", "agent-plugins");
}

/**
 * `TOVU_EXPORT_DIR` env, then `<site>/out/export` — the static-site export engine's default output
 * directory root. Build OUTPUT, grouped under the site's `out/` so it is visibly regenerable and
 * never confused with the site's own source data (`content.db`, `uploads/`, `themes/`).
 * Read ONCE here (mirrors `siteThemesDir()`/`mediaUploadsDir()` immediately
 * above) rather than re-read deep in `features/deployments/export-run.ts` (the admin route's export
 * trigger + the `deployment_trigger_export` agent tool) or `cli/commands/export.ts` (`tovu export`)
 * — both now read `RouteDeps.exportOutputRootDir` instead, which this function feeds in both
 * composition roots (`server/app.ts`'s `createRouteDeps()` and this file's
 * `createSqliteRouteDeps()`). See `routes/types.ts`'s `exportOutputRootDir` doc for the full
 * reasoning.
 */
export function resolveExportOutputRootDir(): string {
  return process.env.TOVU_EXPORT_DIR !== undefined ? resolve(process.env.TOVU_EXPORT_DIR) : join(siteDir(), "out", "export");
}

/**
 * `TOVU_SOURCE_CONTROL_EXPORT_DIR` env, then `<site>/out/source-control-export` — the
 * `source-control` domain's own export scratch directory, deliberately separate from
 * {@link resolveExportOutputRootDir} above so a static-site export and a source-control commit
 * export never race over the same on-disk output (see `features/source-control/commit-site.ts`'s
 * header). Read ONCE here, same reasoning as {@link resolveExportOutputRootDir}.
 */
export function resolveSourceControlExportRootDir(): string {
  return process.env.TOVU_SOURCE_CONTROL_EXPORT_DIR !== undefined
    ? resolve(process.env.TOVU_SOURCE_CONTROL_EXPORT_DIR)
    : join(siteDir(), "out", "source-control-export");
}

/**
 * `TOVU_PUBLISH_DIR` env, then `<site>/out/publish` — the static-publish flow's parent output
 * directory; each target gets its own subdirectory under it (see
 * `features/deployments/static-publish/adapter.ts`'s `publishOutputDir`). Read ONCE here, same
 * reasoning as {@link resolveExportOutputRootDir}.
 */
export function resolvePublishOutputRootDir(): string {
  return process.env.TOVU_PUBLISH_DIR !== undefined ? resolve(process.env.TOVU_PUBLISH_DIR) : join(siteDir(), "out", "publish");
}

/**
 * `TOVU_PLUGINS_DIR` env, then `<site>/plugins` — the per-site root `discoverPlugins()`
 * scans for site-installed plugins (SPEC-005 REQ-02's `<install-dir>/plugins/<id>/<version>/`
 * layout; this function resolves the `<install-dir>/plugins` segment itself, matching what
 * `discoverPlugins({ installDir })`'s own fixtures pass — see `discovery.ts`'s
 * `listInstalledPluginIdFolders`, which lists `<installDir>/<id>/` directly).
 *
 * Deliberately instance-wide, not per-workspace (unlike `src/features/agent-plugins/layout.ts`'s
 * `ws/<workspaceId>/` tenant isolation, a DIFFERENT feature with its own later, separate tenancy
 * decision): SPEC-005's `plugin_activations` table is already the per-workspace boundary (REQ-07,
 * `workspaceId`+`pluginId` primary key) — an installed plugin ARTIFACT is shared across every
 * workspace on this instance, same as `siteThemesDir()`'s themes; only its enabled/disabled
 * state is workspace-scoped. Read ONCE here, same reasoning as {@link resolveExportOutputRootDir}.
 */
export function pluginsInstallDir(): string {
  return process.env.TOVU_PLUGINS_DIR !== undefined ? resolve(process.env.TOVU_PLUGINS_DIR) : join(siteDir(), "plugins");
}

/**
 * @file SQLite-backed composition of route dependencies.
 *
 * Purpose:
 * Builds the same `RouteDeps` shape the in-memory path produces, but with the
 * three feature repos backed by a persistent content.db.
 *
 * How it relates to the project:
 * - Used by the process entrypoint (`index.ts`) for the running server.
 * - Tests keep using the in-memory default in `server/app.ts` (hermetic).
 *
 * Note: outbox + event bus remain in-memory for now (events are fire-on-write
 * side effects, not yet durable across restarts) — a durable outbox is a later
 * slice. Persistence here covers the content model (workspaces/posts/themes).
 */
export function defaultContentDbPath(): string {
  // `sites/<name>/content.db` (2026-08-27), via {@link siteDir}. Was `infra/content.db`, and before
  // that the bare working directory. ADR-012's model is unchanged — a site is a portable folder
  // owning its own `content.db`/`uploads/` — but the *default* now names a real site folder rather
  // than a shared scratch directory, so everything derived from `dirname(contentDbPath)` (the `ops/`
  // sidecar journals, every plugin-migration snapshot, every captured restore point, and
  // `agent-daemon-server.ts`'s `uploads/chat-attachments`) lands inside that one site instead of
  // beside the repo. A deployment still passes an explicit dir, and `TOVU_CONTENT_DB` still
  // overrides this outright. ABSOLUTE now, where the old `join("infra", "content.db")` was relative.
  return process.env.TOVU_CONTENT_DB ?? join(siteDir(), "content.db");
}

/**
 * ADR-041 §2 — the sidecar `ops/database-journal.db` lives as a sibling of `content.db` in the
 * install-dir tree, never inside it (a physically separate SQLite file so a `content.db` restore
 * never erases the incident record narrating that very restore). Defaults to `<dirname of
 * content.db>/ops/database-journal.db`; overridable independently via `TOVU_DATABASE_JOURNAL_DB`
 * for deployments that relocate the sidecar journal on its own.
 */
export function defaultDatabaseJournalDbPath(contentDbPath: string = defaultContentDbPath()): string {
  return process.env.TOVU_DATABASE_JOURNAL_DB ?? join(dirname(contentDbPath), "ops", "database-journal.db");
}

/**
 * `chat.db` lives as a sibling of `content.db` (ADS-memory/reports/2026-09-05-db-split-scoping.md
 * §6), for the same physical-separation reason `defaultDatabaseJournalDbPath` above exists: a
 * whole-file restore/duplicate of `content.db` must never carry (or erase) conversation history.
 * Defaults to `<dirname of content.db>/chat.db`; overridable independently via `TOVU_CHAT_DB`.
 */
export function defaultChatDbPath(contentDbPath: string = defaultContentDbPath()): string {
  return process.env.TOVU_CHAT_DB ?? join(dirname(contentDbPath), "chat.db");
}

/**
 * SPEC-003 (ADR-PIPE-003 C-010) — an already-opened db + a resolved workspace id, supplied by
 * the install-dir boot path (`site-dir/boot-site-dir.ts`) instead of this function opening its
 * own db. `db`/`workspaceId` are required together or omitted together (validated below) — there
 * is no legal state where only one is supplied. `uploadsDir` is independent of that pair.
 */
export interface CreateSqliteRouteDepsOverrides {
  db: ContentDb;
  workspaceId: string;
  /** Consecutive plugin hook failures before automatic quarantine. */
  pluginFailureThreshold: number;
  /**
   * Install-dir-relative uploads path — `cli/commands/serve.ts` supplies `<dir>/uploads` (CR-R01
   * fix: uploads used to always default to `mediaUploadsDir()`, which is `process.cwd()`-relative
   * and therefore wrong whenever `tovu serve <dir>` is invoked from outside that dir). Omitted, it
   * falls back to `mediaUploadsDir()` — the legacy same-directory dev boot's existing behavior.
   */
  uploadsDir: string;
  /**
   * Install-dir-relative themes path — `cli/commands/{serve,export}.ts` supply `<dir>/themes`, for
   * exactly the reason `uploadsDir` above exists (CR-R01): the default {@link siteThemesDir} is
   * `process.cwd()`-relative, so `tovu serve <dir>` invoked from outside `<dir>` would otherwise
   * seed and serve a `sites/tovu-com/themes` next to wherever the operator happened to be standing
   * rather than the site it was told to run. Omitted, it falls back to {@link siteThemesDir}.
   */
  themesDir: string;
  /**
   * The `RouteDeps.siteBinding` value this boot should carry — supplied by `cli/commands/serve.ts`
   * for the install-dir path (`{dir: target, ..., switcherCompatible: false}`, since `target` bears
   * no `{cwd, env}`-relative relationship to any `sites/` folder). Omitted, it falls back to
   * `describeSiteBinding()` — the legacy same-process default boot's existing behavior, unchanged.
   * See `RouteDeps.siteBinding`'s own doc for the full defect this fixes.
   */
  siteBinding: SiteBinding;
}

/**
 * 2026-08-20 (complexity pass) — CIC U-001 / Contract Map C-010's paired-override guard, hoisted
 * out of `createSqliteRouteDeps`. Each `overrides?.field` read is its own branch under ESLint's
 * `complexity` rule; splitting the two reads plus the comparison `if` into their own 4-line
 * function moves those 3 points of complexity here instead of onto the composition root, without
 * changing what gets checked or when.
 */
function assertOverridesPairedOrAbsent(overrides?: Partial<CreateSqliteRouteDepsOverrides>): void {
  const hasOverrideDb = overrides?.db !== undefined;
  const hasOverrideWorkspaceId = overrides?.workspaceId !== undefined;
  if (hasOverrideDb !== hasOverrideWorkspaceId) {
    throw new Error(
      "createSqliteRouteDeps: overrides.db and overrides.workspaceId must be supplied together or not at all"
    );
  }
}

/**
 * Builds `composePluginRuntime`'s optional `failureThreshold` field from `overrides` — the exact
 * undefined-check-and-conditional-spread shape `server/app.ts`'s `createRouteDeps` repeats for its
 * own optional `composePluginRuntime` fields, hoisted here for the same reason
 * {@link assertOverridesPairedOrAbsent} is: one ternary counted once, not inline in the composition
 * root.
 */
function pluginFailureThresholdOverride(
  overrides?: Partial<CreateSqliteRouteDepsOverrides>
): { failureThreshold?: number } {
  return overrides?.pluginFailureThreshold === undefined ? {} : { failureThreshold: overrides.pluginFailureThreshold };
}

/**
 * First-boot-only: turns a deployed container's stock `content.seed.db` into this site's live
 * `content.db`, exactly once — same presence-not-contents gate `seedSiteThemes()` above uses for
 * `themes/`, so a live db from any later boot is never touched (see `hydrateContentDbFromSeed()`'s
 * own header for the full rationale). Hoisted out of `createSqliteRouteDeps` for the same reason
 * {@link assertOverridesPairedOrAbsent} is: one branch counted once here, not inline in the
 * composition root. A no-op whenever `overrides.db` is supplied — that caller (`boot-site-dir.ts`'s
 * install-dir path) has already opened its own db before reaching here, so `dbPath` is never even
 * read in that branch.
 */
function hydrateContentDbIfNeeded(dbPath: string, overrides?: Partial<CreateSqliteRouteDepsOverrides>): void {
  if (overrides?.db !== undefined) return;
  hydrateContentDbFromSeed({ seedDbPath: builtInContentSeedDbPath(), dbPath });
}

/**
 * 2026-09-03 (complexity pass) — `overrides.themesDir ?? siteThemesDir()`, hoisted out of
 * `createSqliteRouteDeps` for the same reason {@link assertOverridesPairedOrAbsent} is: one `??`
 * counted once here, not inline in the composition root.
 */
function resolveThemesDirOverride(overrides?: Partial<CreateSqliteRouteDepsOverrides>): string {
  return overrides?.themesDir ?? siteThemesDir();
}

/**
 * `overrides.siteBinding ?? describeSiteBinding()`, hoisted for the same reason
 * {@link resolveThemesDirOverride} is: one `??` counted once here, not inline in the composition
 * root. See `CreateSqliteRouteDepsOverrides.siteBinding`'s own doc for why the install-dir boot
 * path (`cli/commands/serve.ts`) must supply an explicit value rather than let this default apply.
 */
function resolveSiteBindingOverride(overrides?: Partial<CreateSqliteRouteDepsOverrides>): SiteBinding {
  return overrides?.siteBinding ?? describeSiteBinding();
}

/**
 * `RouteDeps.siteBackupSources`: the directories `site_backup_plan` reads, taken from the SAME
 * resolved values this root serves the site from, so a backup never walks a different folder than
 * the one in use. Media is `null` under `TOVU_MEDIA_BLOB_STORE=s3`: the bytes then live in object
 * storage, and the backup says so instead of copying an unused local folder.
 *
 * @complexity O(1) — env reads and one small `package.json` read.
 */
function resolveSiteBackupSources(input: { siteDir: string; uploadsDir: string; themesDir: string }): SiteBackupSources {
  return {
    siteDir: input.siteDir,
    mediaUploadsDir: process.env.TOVU_MEDIA_BLOB_STORE === "s3" ? null : input.uploadsDir,
    themesDir: input.themesDir,
    agentPluginsDir: resolveAgentPluginLayout().root,
    skillsDir: resolveSkillLayout().root,
    tovuVersion: readTovuVersion(),
  };
}

/** The product's own `package.json` version, stamped into a site backup's manifest. A missing or
 *  unreadable file costs only the stamp, never the boot. */
function readTovuVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(resolveProductRoot(), "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * SPEC-050 (NC-2 = B, REQ-13): the served site's display name, `config.json` `name` in the directory
 * holding `dbPath`, read at each render that needs it so a rename shows with no restart. Every boot
 * path keeps `content.db` in its site directory (`tovu serve`/`tovu export` pass `<dir>/content.db`;
 * the default boot and the agent daemon use `siteDir()`'s), so no caller has to thread it. Reads
 * `undefined` while that directory holds no valid `config.json` (a bare `TOVU_CONTENT_DB`, a temp test
 * database) and always for `:memory:`; the site title then falls back to `workspaces.name`.
 */
function createSiteDisplayNameSource(dbPath: string): SiteDisplayNameSource {
  if (dbPath === ":memory:") return { read: () => undefined };
  return createLiveSiteDisplayName({ dir: dirname(dbPath) });
}

/**
 * 2026-09-03 (complexity pass) — `overrides.db ?? openContentDb(...)`, hoisted for the same reason
 * {@link assertOverridesPairedOrAbsent} is. When `overrides.db` is supplied (the install-dir
 * `serve` path), reuse that SAME handle rather than opening/migrating a second db — `bootSiteDir`
 * has already validated, migrated, and stamped this db before calling here (BR-05/BR-06).
 */
function resolveOrOpenContentDb(dbPath: string, overrides?: Partial<CreateSqliteRouteDepsOverrides>): ContentDb {
  return (
    overrides?.db ??
    openContentDb(
      dbPath,
      {
        workspace: seededWorkspace,
        posts: seededPosts,
        presentation: seededPresentation,
      },
      // ADR-023 §2 — mandatory, blocking boot-time recovery for any crash-interrupted dataModule
      // DDL attempt, before the site opens to end users.
      recoverIncompleteDataModuleMigrations
    )
  );
}

/**
 * 2026-09-03 (complexity pass) — `overrides.workspaceId ?? resolveWorkspace({ db }).id`, hoisted
 * for the same reason {@link assertOverridesPairedOrAbsent} is. CIC U-001 (Workspace-id
 * single-source-of-truth) still holds: this remains the sole `resolveWorkspace` call site: moving
 * it into its own function does not add a second one.
 */
function resolveWorkspaceIdOverride(db: ContentDb, overrides?: Partial<CreateSqliteRouteDepsOverrides>): string {
  return overrides?.workspaceId ?? resolveWorkspace({ db }).id;
}

/**
 * 2026-09-03 production incident recovery hook — opt-in ONLY: a no-op on every ordinary boot,
 * because it does nothing at all unless the operator has explicitly set `TOVU_ADMIN_RESET_PASSWORD`
 * (e.g. as a Fly secret) for this one deploy. That opt-in-via-env-var gate is what makes it safe to
 * wire into every boot unconditionally, the same reasoning `hydrateContentDbIfNeeded` above follows
 * for its own presence-not-contents gate.
 *
 * Exists because the admin UI's own reset-password route is not always trustworthy as a recovery
 * path — it is exactly what failed in the incident this closes (see
 * `features/identity/reset-admin-password-self-verified.ts`'s own header for the full story) — so
 * an operator locked out of the admin panel needs a way to fix the credential that does not depend
 * on the admin panel already working. `resetAdminPasswordSelfVerified` re-reads and verifies the
 * write before this function ever reports success; a failure here is logged loudly but never
 * crashes the boot (mirrors `hydrateBlobStoreFromSeed`'s own catch-and-log posture below) —
 * crashing the ENTIRE public site over a failed ADMIN-only credential fix would be a strictly worse
 * outcome than the incident it is trying to recover from.
 *
 * A no-op whenever `overrides.db` is supplied, same reason and same guard as
 * `hydrateContentDbIfNeeded` above: that caller has already opened its own db (at a path this
 * function cannot assume equals `dbPath`) before reaching here.
 */
function applyAdminPasswordResetFromEnvIfConfigured(required: {
  db: ContentDb;
  dbPath: string;
  workspaceId: string;
  identity: IdentityRouteDepsSlice;
  clock: ClockPort;
  idGen: IdGeneratorPort;
  overrides?: Partial<CreateSqliteRouteDepsOverrides>;
}): Promise<void> {
  if (required.overrides?.db !== undefined) return Promise.resolve();

  const password = process.env.TOVU_ADMIN_RESET_PASSWORD;
  if (!password) return Promise.resolve();
  const username = process.env.TOVU_ADMIN_RESET_USERNAME ?? "admin";

  const { db, dbPath, workspaceId, identity, clock, idGen } = required;
  const repos: IdentityRepos = {
    principals: identity.principalRepo,
    users: identity.userRepo,
    sessions: identity.sessionRepo,
    roles: identity.roleRepo,
    policies: identity.policyRepo,
    policyPermissions: identity.policyPermissionRepo,
    rolePolicies: identity.rolePolicyRepo,
    principalRoles: identity.principalRoleRepo,
    principalPolicies: identity.principalPolicyRepo,
  };
  const dbOps = new SqliteDbOpsAdapter({ db, filePath: dbPath });

  // eslint-disable-next-line no-console
  console.error(
    `TOVU_ADMIN_RESET_PASSWORD is set — resetting password for username='${username}' at boot. ` +
      "Unset this env var/secret again immediately after a successful reset."
  );

  return identity.identityReady
    .then(() =>
      resetAdminPasswordSelfVerified(
        // eslint-disable-next-line no-console
        {
          auth: { repos, hasher: identity.passwordHasher, clock, idGen },
          dbOps,
          ownerPrincipalId: identity.ownerPrincipalId,
          log: (m) => console.error(`[admin-password-reset] ${m}`),
        },
        { workspaceId, username, password, restorePointScopeId: "boot-admin-password-reset" }
      )
    )
    .then(() => {
      // eslint-disable-next-line no-console
      console.error(`[admin-password-reset] SUCCESS — username='${username}' password reset and self-verified at boot.`);
    })
    .catch((err) => {
      const detail =
        err instanceof AdminPasswordResetVerificationFailedError
          ? err.message
          : `${(err as Error).message ?? err}`;
      // eslint-disable-next-line no-console
      console.error(`[admin-password-reset] FAILED for username='${username}': ${detail}`);
    });
}

export function createSqliteRouteDeps(
  dbPath: string = defaultContentDbPath(),
  overrides?: Partial<CreateSqliteRouteDepsOverrides>
): NewsletterRouteDeps {
  assertOverridesPairedOrAbsent(overrides);

  // Resolved ONCE and threaded down, the same discipline `exportOutputRootDir`/`themesDir` already
  // follow (see `routes/types.ts`). Seeded before anything discovers themes off it: on a site's
  // first boot `<site>/themes` does not exist yet, and `discoverAllBuiltInThemes` below would
  // otherwise hand the admin an empty theme list. Deliberately NOT done in `server/app.ts`'s
  // in-memory `createRouteDeps()` — that is the hermetic/test path, and seeding there would copy
  // the whole ~19MB stock tree per test run.
  const resolvedThemesDir = resolveThemesDirOverride(overrides);
  seedSiteThemes({ stockDir: builtInThemesDir(), siteThemesDir: resolvedThemesDir });
  const resolvedSiteBinding = resolveSiteBindingOverride(overrides);

  hydrateContentDbIfNeeded(dbPath, overrides);

  const db = resolveOrOpenContentDb(dbPath, overrides);
  // CIC U-001 (Workspace-id single-source-of-truth): ONE resolved variable, reused by every
  // internal construction below that used to read the old seeded-workspace literal directly —
  // this is the sole `resolveWorkspace` call site in this function's call graph
  // (U-001-B1's grep-checkable invariant: zero remaining literal references outside this line;
  // {@link resolveWorkspaceIdOverride} is the one place that calls it). The legacy default path
  // (no overrides) resolves it dynamically too (rather than keeping the literal for that branch
  // only), so both paths share one mechanism instead of two that could drift (REQ-06/REQ-10;
  // every existing seeded fixture has exactly one workspace row, so this is behavior-identical to
  // the old literal for every current caller — see CIC's Design Context).
  const workspaceId = resolveWorkspaceIdOverride(db, overrides);
  // Posts written before migration 0022 existed — and the demo content `openContentDb` seeds
  // directly into `posts`, bypassing `SqlitePostRepo` entirely — have no FTS projection yet, so
  // `content_post_search` would not find them without an edit. Synchronous and unconditional (not
  // one of this file's fire-and-forget `*Ready` promises): on a warm database it is a single
  // indexed anti-join that writes nothing, and running it before the deps are handed out means no
  // consumer can ever observe a half-indexed corpus. See `backfillPostSearchIndex`'s own doc for
  // why it fills gaps rather than rebuilding.
  backfillPostSearchIndex(db.$client);
  const clock = { nowIso: () => new Date().toISOString() };
  const idGen = { newId: () => randomUUID() };
  const pluginActivationRepo = new SqlitePluginActivationRepo(db);
  const pluginRuntime = composePluginRuntime({
    workspaceId,
    clock,
    activationRepo: pluginActivationRepo,
    sources: [WORD_COUNT_RUNTIME_SOURCE],
    // Reachability fix: previously omitted entirely, so `discoverPlugins()` only ever scanned the
    // compiled-in built-in registry — a plugin placed on disk (REQ-02's install layout) was
    // invisible to every real boot of this composition root, no matter how it got there.
    installDir: pluginsInstallDir(),
    ...pluginFailureThresholdOverride(overrides),
  });
  // P0a fix (2026-09-23) — fire-and-forget at boot, mirrors `commentsReady`/`newsletterReady`: a
  // fresh process's `pluginRuntime.hookRegistry` starts empty, so without this, a plugin durably
  // marked `enabled` before a restart would silently stop firing until an operator re-toggled it.
  // `buildBootModules` awaits this (as `deps.pluginRuntimeReady`) before the server starts serving.
  const pluginRuntimeReady = pluginRuntime.attachEnabledPluginsAtBoot();
  // SQLite-backed identity (principals/users/sessions/roles/policies persist in content.db) so a
  // login survives a `tsx watch` restart instead of being silently wiped every file save.
  const identity = createSqliteIdentityRouteDeps({ db, workspaceId, clock, idGen });
  // Fire-and-forget, mirroring `identityReady`/`blobHydrationReady` below — opt-in only (see the
  // function's own doc), so this is a genuine no-op on every ordinary boot.
  const adminPasswordResetReady = applyAdminPasswordResetFromEnvIfConfigured({ db, dbPath, workspaceId, identity, clock, idGen, overrides });
  void adminPasswordResetReady;
  const presentationRepo = new SqlitePresentationSettingsRepo(db);
  const settingsRepo = new SqliteSettingsRepo(db);
  // Fire-and-forget, mirroring `identityReady` (see routes/types.ts's `settingsReady` doc) — this
  // composition root stays synchronous; consumers await `settingsReady` before relying on the
  // migrated value being present.
  const settingsReady = seedSettingsFromPresentation({
    presentationRepo,
    settingsRepo,
    clock,
    ids: idGen,
    principals: identity.principalRepo,
    systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID,
  }).then(() => undefined);
  // SPEC-008 (ADR-PIPE-008 Decision §3, T050) — idempotently registers the 8 `site.seo.*`
  // definitions at boot, mirroring `settingsReady`'s fire-and-forget shape. Chained AFTER
  // `settingsReady` resolves, not fired in parallel with it — both are SQLite writers on the
  // SAME single better-sqlite3 connection, and `SettingsWriteService`'s chokepoint opens a real
  // `BEGIN IMMEDIATE` transaction; two independent async chains racing to BEGIN on one connection
  // throws "cannot start a transaction within a transaction" (caught directly, not theoretical).
  const seoReady = settingsReady.then(() =>
    ensureSeoSettingDefinitions(
      { settingsRepo, clock, ids: idGen, principals: identity.principalRepo },
      { workspaceId: workspaceId, systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
    ).then(() => undefined)
  );

  // SPEC-035 (ADR-028 Settings Layered Ledger wiring for Comments) — idempotently registers the 6
  // `comments.*` definitions at boot, mirroring `seoReady`'s exact fire-and-forget shape. Chained
  // AFTER `seoReady` resolves, not fired in parallel — same single-SQLite-connection transaction
  // hazard `seoReady`'s own comment documents immediately above.
  const commentsSettingsReady = seoReady.then(() =>
    ensureCommentsSettingDefinitions(
      { settingsRepo, clock, ids: idGen, principals: identity.principalRepo },
      { workspaceId: workspaceId, systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
    ).then(() => undefined)
  );

  // The visitor-facing assistant's master switch (`assistant/public-assistant-settings.ts`).
  // Chained after `commentsSettingsReady`, not fired in parallel, for the same
  // single-SQLite-connection transaction hazard `seoReady`'s comment above documents. Registering
  // the definition does NOT enable anything: its default is `false`.
  const assistantSettingsReady = commentsSettingsReady.then(() =>
    ensurePublicAssistantSettingDefinitions(
      {
        settingsRepo,
        clock,
        ids: idGen,
        principals: identity.principalRepo,
        resolveDefinitionRaw,
        registerDefinitions,
        scopeBit: SCOPE_BIT,
      },
      { workspaceId: workspaceId, systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
    ).then(() => undefined)
  );

  // The admin "Execution mode" tab's `core.execution.*` definitions
  // (`assistant/execution-mode-settings.ts`). Chained after `assistantSettingsReady` rather than
  // fired in parallel, for the identical single-SQLite-connection-transaction reason `seoReady`'s
  // own comment above documents. `ownerKind: "core"` (not "site"), so unlike the three bindings
  // above this one does not pass a `workspaceId` into the registration call — see that file's
  // header for the namespace-fence reasoning.
  const executionSettingsReady = assistantSettingsReady.then(() =>
    ensureExecutionSettingDefinitions(
      { settingsRepo, clock, ids: idGen, principals: identity.principalRepo, ensureSettingDefinitions },
      { systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
    ).then(() => undefined)
  );

  // The remaining ledger-only settings-dialog tabs (Instructions, Notifications, Privacy).
  // Chained after `executionSettingsReady` rather than fired alongside it for the same
  // single-SQLite-connection-transaction reason every registration above documents.
  const settingsUiTabsReady = executionSettingsReady.then(() =>
    ensureSettingsUiTabDefinitions(
      { settingsRepo, clock, ids: idGen, principals: identity.principalRepo },
      { systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
    ).then(() => undefined)
  );

  // The public analytics beacon's `core.analytics.*` definitions (`analytics/config.settings.ts`).
  // Chained after `settingsUiTabsReady` rather than fired alongside it, for the identical
  // single-SQLite-connection-transaction reason every registration above documents.
  const analyticsSettingsReady = settingsUiTabsReady.then(() =>
    ensureAnalyticsSettingDefinitions(
      { settingsRepo, clock, ids: idGen, principals: identity.principalRepo },
      { systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
    ).then(() => undefined)
  );

  // SPEC-050 `core.site.title` (`features/settings/site-title.ts`): registration, then the one-time
  // pin for every workspace the marker migration recorded as pre-existing (REQ-06). Chained after
  // `analyticsSettingsReady` for the single-SQLite-connection-transaction reason every registration
  // above documents; the pin writes through the same ledger.
  const siteTitlePreservationStore = new SqliteSiteTitlePreservationStore(db);
  const siteDisplayName = createSiteDisplayNameSource(dbPath);
  const siteTitleSettingsDeps = { settingsRepo, clock, ids: idGen, principals: identity.principalRepo };
  const siteTitleReady = analyticsSettingsReady
    .then(() => ensureSiteTitleSettingDefinition(siteTitleSettingsDeps, { systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }))
    .then(() =>
      preserveLegacySiteTitles(
        { ...siteTitleSettingsDeps, preservationStore: siteTitlePreservationStore },
        { systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
      )
    )
    .then(() => undefined);

  // ADR-PIPE-012 D-5/D-8 (T043/T044): the persistent composition root uses the real SQLite
  // adapters for both navigation repo ports, and runs the binding-index rebuild once at boot
  // (after the SQLite db above has already opened) so the derived index starts in sync with
  // whatever menus this content.db already holds. Fire-and-forget, mirroring `settingsReady`'s
  // shape — logged and swallowed rather than aborting boot, matching W-003's "logs and continues
  // on failure" contract (ADR-PIPE-012 Wiring Map).
  const menuRepo = new SqliteMenuRepo(db);
  const navLocationBindingRepo = new SqliteNavLocationBindingRepo(db);
  const menuBindingsReady = rebuildNavLocationBindings({
    menuRepo,
    bindingRepo: navLocationBindingRepo,
    clock,
    workspaceId: workspaceId,
  })
    .then(() => undefined)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`rebuildNavLocationBindings failed at boot: ${(err as Error).message}`);
    });
  void menuBindingsReady;

  // SPEC-011 (Newsletter, ADR-PIPE-011 T011/W-010): boot-time `declareDataModule()` invocation for
  // Newsletter's real 5-table manifest, against the SAME raw better-sqlite3 handle underneath the
  // Drizzle `ContentDb` (mirrors `SqliteSettingsRepo.transaction`'s `$client` cast). Idempotent —
  // `declareDataModule()`'s own skip-if-exists logic makes repeated boot calls safe (T010 proves the
  // failure/rollback path separately). Fire-and-forget, mirroring `menuBindingsReady`'s shape: logged
  // and swallowed rather than aborting boot on failure — a failed install leaves Newsletter's admin
  // routes 404/500ing against missing tables, but never bricks the rest of the server.
  const newsletterClient = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
  const newsletterListRepo = new SqliteNewsletterListRepo(db);
  // T030: seed the workspace's default "all subscribers" list right after the tables exist —
  // idempotent (`ensureDefaultList` is itself a find-or-create), matching `declareDataModule()`'s own
  // skip-if-exists convention.
  const newsletterReady = installNewsletterDataModule({ db: newsletterClient, dbPath })
    .then(() => ensureDefaultList({ deps: { listRepo: newsletterListRepo, clock, ids: idGen }, input: { workspaceId: workspaceId } }))
    .then(() => undefined)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`installNewsletterDataModule failed at boot: ${(err as Error).message}`);
    });

  /**
   * ADR-031/ADR-023 (SPEC-033) — Comments' `declareDataModule()` call, against the SAME shared
   * `db.$client` connection Newsletter's install just used. Chained AFTER `newsletterReady`
   * resolves (NOT fired in parallel), for the exact same reason `seoReady` is chained after
   * `settingsReady` above: two independent fire-and-forget async chains racing SQLite calls
   * (including SPEC-032's exclusive-lock pragma toggling) against ONE shared connection produced
   * a real, deterministically-reproduced "database is locked" failure — caught via a live
   * multi-boot smoke test, not a synthetic case. This is the identical hazard class this file's
   * own `seoReady` comment already documents; this fixes the same mistake made fresh here.
   */
  const commentsReady = newsletterReady
    .then(() => installCommentsDataModule({ db: db.$client, dbPath }))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`installCommentsDataModule failed at boot: ${(err as Error).message}`);
    });

  // ADR-027 §4 — the core "public" transform definition that lets the unauthenticated `/m/`
  // rendition route serve ANY asset at all (`media/bootstrap.ts`'s file header has the full
  // diagnosis: with zero rows in `transform_registry`, every `/m/` request 404s regardless of
  // what media exists). Hoisted here (rather than down with the other media repos below) so this
  // call and the returned `RouteDeps.transformDefinitionRepo` field share the SAME repo instance
  // rather than two independent wrappers over the same table. Chained after `commentsReady`, not
  // fired in parallel, for the identical single-SQLite-connection transaction hazard every `Ready`
  // chain in this function documents; fire-and-forget and not exposed on `RouteDeps`, mirroring
  // `menuBindingsReady`'s shape — nothing downstream needs to gate a request on this resolving,
  // since `ensureCoreMediaTransform` is idempotent and the window between boot and its single
  // insert completing is a few milliseconds.
  const transformDefinitionRepo = new SqliteTransformDefinitionRepo(db);
  const mediaTransformReady = commentsReady
    .then(() =>
      ensureCoreMediaTransform({
        deps: { clock, idGen, transformRepo: transformDefinitionRepo },
        input: { workspaceId: workspaceId },
      })
    )
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`ensureCoreMediaTransform failed at boot: ${(err as Error).message}`);
    });
  void mediaTransformReady;

  // Fills in stock blob BYTES for `media`/`asset_blobs` rows this site inherited from
  // `content.seed.db` (see `hydrate-blob-store-from-seed.ts`'s own header for the incident this
  // closes). Hoisted here — rather than left inline down with the other media fields below — for
  // the same reason `transformDefinitionRepo` above is: this call and the returned
  // `RouteDeps.blobStore` field must share the SAME instance, not two independent adapters over the
  // same backing store. Fired independently, NOT chained after `commentsReady`/`mediaTransformReady`
  // above: unlike those two, this touches no SQLite connection at all — it only reads the seed
  // payload off disk and calls `blobStore.exists`/`put` — so it carries none of the shared-
  // connection hazard the rest of this function's `Ready` chain exists to avoid. Exposed on
  // `RouteDeps` (unlike `mediaTransformReady`) purely so a boot-integration test can await
  // deterministic completion instead of racing a fire-and-forget background copy; no route or
  // caller needs to gate on it — `hydrateBlobStoreFromSeed`'s own per-key gate makes every run after
  // the first an all-`skipped` no-op. It calls `blobStore.putIfAbsent()` — one atomic call per key
  // now, not a separate `exists()`/`put()` pair (see that file's header for the race that closes).
  const resolvedUploadsDir = overrides?.uploadsDir ?? mediaUploadsDir();
  const blobStore = resolveBlobStore(resolvedUploadsDir);
  const blobHydrationReady = hydrateBlobStoreFromSeed({
    seedUploadsDir: builtInSeedUploadsDir(),
    blobStore,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`hydrateBlobStoreFromSeed failed at boot: ${(err as Error).message}`);
    return undefined;
  });

  // SPEC-009 (Redirects, ADR-PIPE-009) — FIRST-TIME composition-root wiring of `origin`'s
  // OriginRegistry and `routing`'s registration functions, mirroring `server/app.ts`'s identical
  // wiring. `redirects` DOES get its real `SqliteRedirectRepo` here (unlike the in-memory-only
  // libraries above), since T014 built a full rule-of-two adapter for it.
  // ADR-046 Phase 1 (BR-04 resolution, 2026-07-16 swarm debate): durable SQLite outbox. Events
  // survive a restart; `SqliteChangeSetRepo.insert()`'s co-persisted event and this adapter's
  // `claimPending()`/`markDelivered()`/`markFailed()` share the same `outbox_events` table.
  const outbox = new SqliteOutboxAdapter(db);
  const bus = new InMemoryEventBus();
  // ADR-046 Phase 1 (2026-07-16): durable SQLite origin-settings adapter.
  //
  // 2026-09-18 — `planOriginBoot` (`features/origin/configured-origin.ts`) now decides what this
  // boot writes, instead of an unconditional dev seed. Design note:
  // `ADS-memory/reports/2026-09-18-public-origin-registration-design.md`.
  //   - `TOVU_PUBLIC_URL` names a real public https origin -> register it, correcting an existing
  //     dev-capability row in place. This is what finally lets production's sitemap.xml emit
  //     absolute URLs, and what heals the `http://localhost:3000` row Fly's first boot persisted.
  //   - nothing configured, local mode -> the dev seed below, byte-for-byte unchanged.
  //   - nothing configured, production mode -> write NOTHING. ADR-040 §2 fails closed on an absent
  //     origin; the unconditional seed is what poisoned prod in the first place, and its
  //     find-or-create contract made that row immortal.
  //
  // `devCapabilityScheme` is DERIVED, not the `"https"` literal this used to hardcode (2026-09-05
  // audit finding, Chunk D finding 3): the dev API server only terminates TLS when `resolveDevTls`
  // (`server/runtime/boot/dev-tls.ts`) says so, same as `index.ts`'s own real boot path computes —
  // this composition root calls it independently rather than threading `index.ts`'s result through,
  // mirroring how `isAdminAssistantEnabled()` above is also called directly here rather than passed
  // in. Two real, disclosed cases fall to plain HTTP: a fresh clone with no `.certs/`, and
  // `TOVU_DISABLE_DEV_TLS`, which every hermetic Playwright `webServer` under
  // `development/*.config.ts` sets. A hardcoded `https` in either case silently shipped broken
  // `https://` links (redirects' canonicalOrigin, newsletter confirmation/unsubscribe, site
  // evidence) for a server that only ever answers on `http://`. `REPO_ROOT` is a walk-up
  // (`resolveCheckoutRoot`), not a fixed `../` count: the compiled tree is two levels shallower than
  // the tsx source tree, so a count only ever matched one of them.
  // NOTE: `devCapabilityScheme` stays at this scope, NOT inside the dev-seed branch below — the
  // `derivedPublicOrigin` field near the end of this function is a second consumer (see its own
  // comment). Narrowing it to the branch compiles nowhere and was caught by `tsc`.
  const REPO_ROOT = resolveCheckoutRoot();
  const devCapabilityScheme = deriveDevScheme(resolveDevTls(resolveDevTlsCertPaths(REPO_ROOT)).active);
  const originBoot = planOriginBoot({ now: clock.nowIso() });
  if (originBoot.kind === "configured") {
    registerConfiguredOrigin({ db, workspaceId: workspaceId, origin: originBoot.origin });
  } else if (originBoot.kind === "dev-seed") {
    seedDevCapabilityOrigin({
      db,
      seed: {
        workspaceId: workspaceId,
        origin: createVerifiedOrigin({
          scheme: devCapabilityScheme,
          host: "localhost",
          port: 3000,
          verifiedAt: clock.nowIso(),
          source: "dev-capability",
        }),
        // ADR-PIPE-015 T016: a dev-capability egress allowlist entry so the real
        // isAllowedEgressTarget oracle doesn't fail-closed on every fresh dev server — matches the
        // `example.com` target every integrations fixture/test in this repo already uses.
        egressAllowlist: ["example.com"],
      },
    });
  }
  const originRegistry = new OriginRegistry({ repo: new SqliteOriginSettingRepo(db) });
  const redirectRepo = new SqliteRedirectRepo(db);
  const redirectHitSink = new RedirectHitSinkImpl();
  // ---------------------------------------------------------------------------
  // Local admin Trash (design: ADS-memory/reports/2026-09-20-trash-delete-architecture.md)
  // ---------------------------------------------------------------------------
  // A plain Map, built here and resolved on every call. NOT a module-level registry: this
  // codebase's registries (`ToolRegistry`, routing's `phaseRegistry`) are append-only with no
  // unregister, so anything that filters at registration time runs exactly once — two real bugs
  // already came from that. Adding a phase-2 domain means one more `set()` here and no migration.
  const assetRenditionRepo = new SqliteAssetRenditionRepo(db);
  // `TRASHABLE` (plan §1/§4) — built once here from the live `schema.sqlite.ts` tables. Adding a type needs
  // no edit below this line, only a new `registry.ts` `Map` entry — the adapter map beneath already
  // loops over every registered entry generically.
  const trashRegistry = buildTrashRegistry({ schema: contentSchema });
  const sqliteTrashDb = createSqliteTrashDb({ db });
  // Column-only reference to `trashed_items`, shared by every generic entry's adapter — needed only
  // by a `purgeFirst` cascade that declares `entityType` (`form` -> `form_submission`, `taxonomy` ->
  // `term`): the phantom-row cleanup, T1 item 5 (`table-adapter.ts`'s `TrashedItemsRef`).
  const trashedItemsRef: TrashedItemsRef = {
    table: contentSchema.trashedItems,
    workspaceId: contentSchema.trashedItems.workspaceId,
    entityType: contentSchema.trashedItems.entityType,
    entityId: contentSchema.trashedItems.entityId,
  };
  // Finishes a hide/restore/purge a generic marker flip alone cannot (`follow-ups.ts`), per type.
  // `widget`: an adopted legacy widget keeps its `purged` payload while in the Trash (an older site
  // build still reads it), and its restore makes the payload active again. `routeDeps` is read at
  // restore time, long after it exists below. T5/T6 add their own entries here (menu/taxonomy
  // revision + event follow-ups) — this map stays the one per-type wiring point (plan §2 T1 item 6).
  // Hoisted above `trashFollowUpHooks` (needs `findByEntity` for the term/taxonomy purge
  // follow-ups below) — the constructor takes only `db.$client`, no dependency on
  // `trashAdapters`/`trash` itself, so this is safe to build early (T6, step 3).
  const trashRepo = new SqliteTrashRepo(db.$client);
  // Purge-only audit trail for `term`/`taxonomy` (plan §6 Q2): one `taxonomy_revisions` row plus a
  // domain event, matching `deleteTerm`/`deleteTaxonomy`'s own writes — see
  // `taxonomy-trash-follow-ups.ts`'s file header. A second, cheap `SqliteTermRepo`/
  // `SqliteTaxonomyRevisionRepo` instance each (stateless wrappers over the same tables `termRepo`/
  // `taxonomyRevisionRepo` below use) rather than hoisting those out of the return object literal.
  const taxonomyFollowUpTermRepo = new SqliteTermRepo({ db, workspaceId });
  const taxonomyFollowUpRevisions = new SqliteTaxonomyRevisionRepo({ db, workspaceId });
  const taxonomyFollowUpOutbox = toTaxonomyOutbox({ outbox, clock, idGen, workspaceId });
  const trashFollowUpHooks = new Map<string, TrashFollowUpHooks>([
    [
      "widget",
      {
        afterUnhide: (required) =>
          restoreWidgetPriorStatus({
            deps: buildWidgetsDeps(routeDeps),
            input: { workspaceId: required.workspaceId, widgetInstanceId: required.entityId, priorStatus: required.priorMarker },
          }),
      },
    ],
    ["menu", buildMenuTrashFollowUpHooks({ menuRepo, outbox, idGen, clock })],
    [
      "term",
      createTermPurgeFollowUp({
        termRepo: taxonomyFollowUpTermRepo,
        trash: trashRepo,
        revisions: taxonomyFollowUpRevisions,
        outbox: taxonomyFollowUpOutbox,
        clock,
      }),
    ],
    [
      "taxonomy",
      createTaxonomyPurgeFollowUp({
        termRepo: taxonomyFollowUpTermRepo,
        trash: trashRepo,
        revisions: taxonomyFollowUpRevisions,
        outbox: taxonomyFollowUpOutbox,
        clock,
      }),
    ],
  ]);
  const pluginTrashAdapter = createDirectoryTrashAdapter({
    entityType: PLUGIN_ENTITY_TYPE,
    locate: ({ entityId }) => pluginRuntime.locatePluginPackageDirs(entityId),
    forget: ({ entityId }) => forgetPluginActivations({ pluginId: entityId }, { repo: pluginActivationRepo }),
  });
  const trashAdapters = new Map<string, TrashAdapter>([
    [POST_ENTITY_TYPE, createPostTrashAdapter(db.$client)],
    [REDIRECT_ENTITY_TYPE, createRedirectTrashAdapter(db.$client)],
    [COMMENT_ENTITY_TYPE, createCommentTrashAdapter(db.$client)],
    [PLUGIN_ENTITY_TYPE, pluginTrashAdapter],
    [
      MEDIA_ENTITY_TYPE,
      createMediaTrashAdapter({
        client: db.$client,
        // Media's hard delete is not a row delete: rendition rows hang off it and the blob store
        // holds bytes. `purgeMedia` owns that ladder, so the adapter delegates rather than
        // reimplementing it in SQL and silently orphaning bytes.
        purgeAsset: async ({ workspaceId: ws, entityId }) => {
          await purgeMedia({
            deps: { mediaRepo, blobRepo: assetBlobRepo, renditionRepo: assetRenditionRepo, blobStore, clock },
            input: { workspaceId: ws, id: entityId },
          });
        },
      }),
    ],
    [
      USER_ENTITY_TYPE,
      createUserTrashAdapter({
        db,
        // A fresh instance, not `identity.userPurge` (removed — see `wiring.ts`'s
        // `IdentityRouteDepsSlice.removeUser` doc): `purge`'s hard-delete is now reached only
        // through this adapter's own `purge()`, never directly from the route layer.
        purge: new SqliteUserPurge(db),
        idGen: { next: () => randomUUID() },
        clock,
      }),
    ],
    // One generic adapter per `TRASHABLE` entry — `createTableTrashAdapter` is
    // written once and driven entirely by each entry's own registration, so this line never changes
    // as G2-G4 add more entries.
    ...[...trashRegistry.values()].map((entry) => {
      const adapter = createTableTrashAdapter({ entry, db: sqliteTrashDb, trashedItems: trashedItemsRef });
      const hooks = trashFollowUpHooks.get(entry.entityType);
      return [entry.entityType, hooks ? withFollowUps({ adapter, hooks }) : adapter] as const;
    }),
  ]);
  // Reentrant: `deletePost` and `tombstoneRedirect` already open their own BEGIN IMMEDIATE around
  // "marker + revision append", and `remove` is called from inside it. Named (not inlined) because
  // the comments moderation service needs the SAME runner to wrap its own two writes.
  const trashTransaction = createContentDbTransactionRunner(db.$client);
  const trash = createTrashService({
    repo: trashRepo,
    adapters: trashAdapters,
    idGen: { next: () => randomUUID() },
    transaction: trashTransaction,
  });
  // Folder moves before the Trash row is written; if that write throws, move the folder back.
  const removePlugin: RemovePluginFn = unhideIfRemoveThrows(pluginTrashAdapter, bindRemoveEntity(trash, PLUGIN_ENTITY_TYPE));
  // Delete-user plan v2 Slice 2 — `identity`'s `removeUser`/`isInTrash` overrides (see
  // `wiring.ts`'s `IdentityRouteDepsSlice.removeUser` doc for why identity itself cannot build
  // these: it wires before `trash`/`trashRepo` exist).
  const removeUser = bindRemoveEntity(trash, USER_ENTITY_TYPE);
  const isInTrash = async (principalId: string): Promise<boolean> =>
    (await trashRepo.findByEntity({ workspaceId, entityType: USER_ENTITY_TYPE, entityId: principalId })) !== null;

  /**
   * Narrows `bindRemoveEntity`'s result for a type whose registry entry declares no `blocker`
   * (redirect/comment/form_submission — none of `registry.ts`'s three entries for them sets one).
   * `TrashMarkerResult` (T1) is generic over every registered kind, so TypeScript cannot see that on
   * its own; this is the composition-root seam that carries the narrower promise those domains'
   * OWN structural types (`RemoveRedirectFn`/`RemoveCommentFn`/`RemoveFormSubmissionFn`) still make.
   * A `"blocked"` result here is a composition bug (a blocker was added to one of these three entries
   * without updating this call site to match) — fail fast rather than silently drop it.
   */
  function removeEntityWithoutBlocker(remove: RemoveEntity): (
    required: Parameters<RemoveEntity>[0]
  ) => Promise<{ ok: true; version: number | null } | { ok: false; reason: "not-found" | "version-changed" }> {
    return async (required) => {
      const result = await remove(required);
      if (!result.ok && result.reason === "blocked") {
        throw new Error(`trash: '${required.id}' reported 'blocked' from a type registered with no blocker — composition bug`);
      }
      return result;
    };
  }

  const redirectsWriteDeps: RedirectsWriteDeps = {
    repo: redirectRepo,
    remove: removeEntityWithoutBlocker(bindRemoveEntity(trash, REDIRECT_ENTITY_TYPE)),
    // S7 (web-high fix plan 2026-09-24) — same identity `isInTrash` shape as above, pre-bound to
    // this domain's entity type. `trash.restore` is the real `TrashPort` method, not a bespoke one.
    isInTrash: async (required) =>
      (await trashRepo.findByEntity({ workspaceId: required.workspaceId, entityType: REDIRECT_ENTITY_TYPE, entityId: required.id })) !== null,
    restore: (required) =>
      trash.restore({
        workspaceId: required.workspaceId,
        entityType: REDIRECT_ENTITY_TYPE,
        entityId: required.id,
        at: required.at,
        actor: required.actor,
      }),
    db: redirectRepo,
    transaction: (fn) => redirectRepo.transaction(fn),
    matcher: redirectMatcher,
    originRegistry,
    clock,
    idGen,
    outbox,
  };
  registerRedirectsPhaseHandlers({
    resolver: new RedirectPhaseHandlerResolver({
      repo: redirectRepo,
      matcher: redirectMatcher,
      originRegistry,
      hits: { outbox, clock, idGen },
    }),
  });
  registerSlugChangeCapture(
    new RedirectSlugChangeCapture({ repo: redirectRepo, db: redirectRepo, clock, idGen })
  );
  void registerRedirectHitOutboxHandler({ bus, hitSink: redirectHitSink });

  // ADR-041 §2 — opens the sidecar ops journal alongside content.db. `mkdirSync` (recursive) is
  // required first: unlike `openContentDb`'s target (the process cwd, which already exists),
  // `ops/` is a new subdirectory better-sqlite3 will not create for us.
  const databaseJournalDbPath = defaultDatabaseJournalDbPath(dbPath);
  mkdirSync(dirname(databaseJournalDbPath), { recursive: true });
  const databaseJournalDb = openDatabaseJournalDb(databaseJournalDbPath);
  // ADS-memory/reports/2026-09-05-db-split-scoping.md §6 — chat data lives in its own file,
  // sibling to content.db, for the same "a whole-file restore/duplicate must never carry (or
  // erase) chat history" reason `databaseJournalDb` above is already separate. No `mkdirSync`
  // needed: unlike `ops/`, `chat.db`'s directory is `dirname(dbPath)`, which `openContentDb`
  // already required to exist.
  const chatDbPath = defaultChatDbPath(dbPath);
  const chatDb = openChatDb(chatDbPath);
  // The split above was wiring-only: it redirected the chat stores at `chat.db` but never moved the
  // rows an already-deployed `content.db` was holding, and nothing anywhere reported that. Every
  // such conversation is intact but unread, because the stores no longer look in that file. This
  // counts them and prints one warning naming the counts and the migration script — read-only, and
  // completely silent (one bounded `count(*)` per table) on the already-migrated boot. It
  // deliberately does NOT migrate: `applyChatSplit` deletes from content.db after copying, and its
  // own header requires a backup first — see `chat-orphan-check.ts`'s header for the rejected
  // alternatives.
  warnOnOrphanedChatRows({ contentDb: db.$client, contentDbPath: dbPath, chatDbPath });
  // `siteId` reuses `workspaceId` for v1's single-workspace-per-content.db topology — ADR-041 §7
  // names `siteId` vs `workspaceId` as SPEC-003 OQ-04, explicitly unresolved by that ADR; this
  // composition root does not resolve it either, it just picks the only value available today.
  const databaseLedgerRepo = new SqliteDatabaseLedgerRepo({ db: databaseJournalDb, siteId: workspaceId });
  // ADR-041/043/044/045 re-audit (2026-07-16, TM-adr041-043-044-045-audit-001, Finding 2 fix) —
  // the real `migration_runs` read side `reconcileInterruptedMigrationOnBoot` needs. The actual
  // boot-time SCAN call lives in `bootstrap.ts` (a proper sequenced boot module), not here —
  // this composition root only constructs and exposes the port.
  const migrationRunsRepo = new SqliteMigrationRunsRepo({ db: databaseJournalDb, siteId: workspaceId });
  // Admin-UI backend-gap closure (design-spec.md §0.4/§3.8/§4.8, this dispatch): both classes were
  // already built (a prior session's disclosed-but-unwired infra work — see each class's own file
  // header) but never constructed by any composition root until now. `SqliteRestorePointsRepo`
  // shares the same sidecar journal db/siteId as `databaseLedgerRepo` above.
  const restorePointsRepo = new SqliteRestorePointsRepo({ db: databaseJournalDb, siteId: workspaceId });
  const dbOps = new SqliteDbOpsAdapter({ db, filePath: dbPath });
  // ADR-041 §3 (this dispatch) — reuses the SAME already-open `db`/`dbPath` pair `dbOps` above
  // just used, rather than opening a second connection to the same `content.db` file.
  const databaseIntrospection = new SqliteDatabaseIntrospectionAdapter({ db, dbPath });

  // ADR-031/ADR-023 (SPEC-033) — hoisted so the Comments module's `entryLookup` reads the SAME
  // repo the rest of this composition root wires (mirrors `restorePointsRepo`'s identical
  // hoisting rationale above). The actual `commentsReady` I/O (declareDataModule against the
  // SAME shared `db.$client` connection) is chained AFTER `newsletterReady` below — this is
  // pure, synchronous, I/O-free wiring only.
  const entryRepo = new SqliteEntryRepo(db);
  // Hoisted (2026-09-02 taxonomy render-surface gap fix) so the SAME instance backs both
  // `entryTermRepo` and the new `entryTermReadRepo` field below — one concrete class satisfying two
  // differently-shaped dependency slots, rather than two separate connections to the same table.
  const sqliteEntryTermRepo = new SqliteEntryTermRepo({ db, workspaceId: workspaceId });
  // SPEC-043/ADR-047 (widgets) — hoisted alongside `entryRepo` for the same reason: both the admin
  // `widgets` routes and the public site-render path (`routes/site/pages.ts` → `resolvePageWidgets`,
  // W-004) read/write against the SAME real tables, via the same `db` connection.
  const widgetBindingRepo = new SqliteWidgetRegionBindingRepo(db);
  const entryRefsRepo = new SqliteEntryRefsRepo(db);
  const formDefinitionRepo = new SqliteFormDefinitionRepo(db);
  // Collections plan R1 — hoisted above `wireCoreResolvers` (was constructed later, inline, only for
  // the `ContentTaxonomyDeps` object below). Both `SqliteContentTypeRepo` instances would read the
  // same `content.db` either way (it is a stateless adapter over `db`), but one shared instance
  // keeps this identical to `server/app.ts`'s hermetic root, where sharing is load-bearing.
  const contentTypeRepo = new SqliteContentTypeRepo(db);
  // SPEC-043/ADR-047 (widgets, Fable adversarial-review fix 2026-07-21) — the boot-wiring pass
  // `resolvers/index.ts`'s `wireCoreResolvers` file header always said was needed before the app
  // served traffic, but no composition root ever called it. Without this, `menu`/`recent-entries`/
  // `contact-form` widgets silently rendered as empty placeholders on every real page — only the
  // two static widget types (`text`/`social-links`) ever worked. Real deps only; `menu`'s
  // `NavMenuReadModel` is the one dependency with no prior real adapter anywhere in the codebase
  // (see `navigation/read-model.ts`'s file header).
  wireCoreResolvers({
    entryList: entryRepo,
    navMenuReadModel: createNavMenuReadModel({ menuRepo, bindingRepo: navLocationBindingRepo }),
    formDefinitionRepo,
    contentTypes: contentTypeRepo,
  });
  const commentsModule = createCommentsModule({
    commentRepo: new SqliteCommentRepo(db.$client),
    entryRepo,
    outbox,
    clock,
    idGen,
    spamCheck: new HeuristicSpamCheck(),
    settingsRepo,
    // Local admin Trash. A comment's "deleted" marker is one value of its moderation status, so the
    // index has to follow both directions of that transition — see `syncRemovalIndex`.
    remove: removeEntityWithoutBlocker(bindRemoveEntity(trash, COMMENT_ENTITY_TYPE)),
    forgetRemoved: ({ workspaceId: ws, id }) =>
      trashRepo.deleteByEntity({ workspaceId: ws, entityType: COMMENT_ENTITY_TYPE, entityId: id }),
    runInTransaction: trashTransaction,
  });

  // Hoisted above `newsletterKeyring` (moved up from its original position further below, where a
  // second `resolveRuntimeMode()` call used to sit) so `newsletterKeyring`'s own construction below
  // can read it — `resolveRuntimeMode()` is a pure, side-effect-free read of `process.env.
  // TOVU_RUNTIME_MODE` (see its own header), so hoisting the call changes nothing about what it
  // returns, only when it is first read.
  const runtimeMode = resolveRuntimeMode();

  // site-key plan §A3a: both root-key-backed keyrings below need this site's own ordered source
  // list (per-site file first in local mode, mirroring `ensureSiteKey`'s own writer-side ordering —
  // `site-key-sources.ts`). Computed once, here, rather than per-keyring: `dbPath !== ":memory:" ?
  // dirname(dbPath) : undefined` is the SAME "every real boot path keeps content.db in its site
  // directory" pattern `createSiteDisplayNameSource` above already relies on, so a `:memory:` boot
  // (no site directory at all) correctly resolves no `siteKeyId` and therefore no per-site
  // candidate, exactly like every other site-directory-derived read in this file.
  const siteDirForKeyring = dbPath !== ":memory:" ? dirname(dbPath) : undefined;
  const siteKeyIdForKeyring = siteDirForKeyring ? resolveSiteKeyId({ siteDir: siteDirForKeyring }) : undefined;
  const siteKeySourcesList = siteKeySources({
    mode: runtimeMode,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    siteKeyId: siteKeyIdForKeyring,
  });

  // SPEC-011 (Newsletter) Stage 5 wiring — hoisted for the same reason `server/app.ts`'s identical
  // hoisting comment explains: `newsletterSubscriberDirectory` must read the SAME member rows the
  // returned `memberRepo` field exposes, and `newsletterKeyring` is the ONE process-lifetime
  // `KeyringPort` instance also used to build `webhookSigner` below (one root key,
  // purpose-namespaced — `webhooks/ports.ts`'s `KeyringPort.derive()` contract — not two).
  //
  // `allowFileFallback: runtimeMode !== "production"` (2026-09-09 integrations-root-key fix): in
  // local/dev mode this still defaults to `true` (unchanged from before this fix) — a developer
  // with no `TOVU_INTEGRATIONS_ROOT_KEY` set must keep booting via the generated-file fallback. In
  // production, the file fallback resolves against the container's own ephemeral rootfs (`Dockerfile`'s
  // `USER node` -> `homedir()` is `/home/node`, not the mounted Fly volume) — a missing var there
  // used to boot fine and silently mint a fresh, throwaway root key on every redeploy. The boot-time
  // gate (`server/runtime/boot/production-readiness-gate.ts`'s `hasMissingIntegrationsRootKey`) is
  // the primary fix — it refuses to boot before this line is ever reached — this is defense in
  // depth: if that gate is ever bypassed or this composition root is ever reached from a path that
  // does not call it, `newsletterKeyring` still fails loudly on first use in production (missing
  // env var AND no key file at the durable path — `keyring.env.ts`'s `defaultRootKeyFilePath`)
  // rather than silently re-keying.
  //
  // NOT extended to `allowFileFallback: true` unconditionally (undoing the `runtimeMode` gate)
  // even though `defaultRootKeyFilePath`'s 2026-09-09 durability fix removed the ORIGINAL reason
  // for this gate (the ephemeral-rootfs problem) — a committed regression test
  // (`production-readiness-boot.integration.test.ts`) pins this exact mode-gated construction, and
  // this pass's own dispatch scoped the production fix to `siteAssistantSecretKeyring` below, not
  // this instance. Left as a disclosed, intentional asymmetry rather than silently "fixed": in
  // production, webhook signing / newsletter tokens still require the env var; only the
  // credential-sealing keyring below can now also use a generated file.
  //
  // `allowFileAutoGenerate: false` (2026-09-16) — closes an OVERSIGHT, not the disclosed asymmetry
  // above. The local-mode "must keep booting via the generated-file fallback" rationale was written
  // (`ddfa5e07`) while reading and minting were still one unit; the `allowFileAutoGenerate` split
  // arrived two hours later (`bb84fc1b`) and was applied to `siteAssistantSecretKeyring` only. Left
  // on the default, this instance minted `~/.tovu/integrations-root-key.hex` unattended in local
  // mode — and its only live consumer is the PUBLIC `/newsletter/unsubscribe` route, whose
  // `processUnsubscribe` derives before it can reject a token, so ANY anonymous request with a
  // base64url-JSON token minted it. `siteAssistantSecretKeyring` reads that same path, so the key
  // sealing every stored credential could be one no operator created, saw or backed up. Nothing
  // derives at boot (resolution is lazy) and no legitimate unsubscribe token can exist before a key
  // does, so no startup or first-run path depended on the mint. This instance still READS an
  // existing file; with no env var and no file, a local unsubscribe request now fails closed.
  const memberRepo = new SqliteMemberRepo(db);
  // site-key plan §A3a: `sources` is threaded in ONLY outside production (`siteKeySourcesList` is
  // computed once, above). Passing it unconditionally would make `resolveRootKey()` take the
  // `sources`-driven early-return branch (`keyring.env.ts`'s own `if (this.sources)` check) and
  // never consult `allowFileFallback` again — silently ADDING a file fallback for
  // webhook-signing/newsletter-token material in production, which the `allowFileFallback:
  // runtimeMode !== "production"` line immediately below exists specifically to deny. Kept as a
  // separate `undefined`-in-production local (rather than a nested object literal inside the
  // `EnvOrFileKeyring({...})` call below) so `production-readiness-boot.integration.test.ts`'s two
  // source-text regression tests — which scan for `allowFileFallback`/`allowFileAutoGenerate` via a
  // `[^}]*` pattern that cannot cross a nested `{`/`}` — keep matching this construction unchanged.
  const newsletterKeyringSources = runtimeMode !== "production" ? siteKeySourcesList : undefined;
  const newsletterKeyring = new EnvOrFileKeyring({
    allowFileFallback: runtimeMode !== "production",
    allowFileAutoGenerate: false,
    sources: newsletterKeyringSources,
  });
  const newsletterSubscriberDirectory = new MembersSubscriberDirectory({ members: memberRepo });
  const newsletterHooks = createHookRegistry();

  // ADR-058: the SITE assistant credential store's OWN `KeyringPort` instance — deliberately NOT
  // `newsletterKeyring` above, even though both read the same `TOVU_INTEGRATIONS_ROOT_KEY` env var
  // and (when it is set) derive from byte-identical root-key material.
  //
  // 2026-09-09 — CHANGED from `{ allowFileFallback: false }` to `{ allowFileFallback: true,
  // allowFileAutoGenerate: false }` (owner-approved, after this exact asymmetry was flagged rather
  // than silently reconciled — `ADS-memory/reports/2026-09-09-security-site-token.md`). This
  // instance may now READ an already-generated key file — the durable, production-safe path
  // `defaultRootKeyFilePath()` now resolves to — but will NEVER mint one itself
  // (`allowFileAutoGenerate: false`): the only way a file comes into existence for this store is
  // the admin Secrets page's Site Token tab's explicit, attended Generate action
  // (`keyring.env.ts`'s `generateFileRootKey`, a plain function independent of this flag).
  //
  // This UPDATES rather than reverses ADR-058 §2's stated reasoning: that section's actual
  // objection was an UNATTENDED first-use mint under a feature encrypting a real, paid credential
  // ("a missing root key throws immediately rather than silently minting..."), which
  // `allowFileAutoGenerate: false` still fully honors. It DOES contradict ADR-058 §9's "leaked
  // backup alone is not enough" framing: that defense assumed the root key lives only in the live
  // process's environment, never on disk beside `content.db`. Once a generated key file exists on
  // the same Fly volume as the database it protects, someone who obtains a volume snapshot/backup
  // gets both — the ciphertext AND the key that opens it. This is an ACCEPTED, DOCUMENTED cost of
  // this change, not an oversight: it trades some of ADR-058's original defense-in-depth for the
  // ability to run without `fly secrets set` at all. See `ADS-memory/reports/
  // 2026-09-09-security-site-token.md` for the full tradeoff writeup.
  // site-key plan §A3a: `sources` is threaded in UNCONDITIONALLY (both modes) — safe and
  // behavior-preserving in production, since `siteKeySourcesList`'s production branch is exactly
  // `[env, legacy-volume-file]`, the same env-then-`defaultRootKeyFilePath()` precedence this
  // instance's own default (non-`sources`) resolution already used (`site-key-sources.ts`'s
  // `legacyVolumeFilePath` doc: "the production durable-volume path ... reused here unchanged").
  const siteAssistantSecretKeyring = new EnvOrFileKeyring({
    allowFileFallback: true,
    allowFileAutoGenerate: false,
    sources: siteKeySourcesList,
  });
  const siteAssistantSecretSealer = new AesGcmSecretSealer(siteAssistantSecretKeyring);
  // Held as a local rather than constructed inline, because the OAuth service below must be given
  // the SAME repo instance the routes read through — two instances would refresh a token into one
  // and read it back from the other.
  const externalMcpServerRepo = new SqliteExternalMcpServerRepo(db);
  // Same "one shared instance" reasoning as `externalMcpServerRepo` above, and also exposed as their
  // own `RouteDeps.externalMcpOAuthPending`/`externalMcpOAuthDevices` fields below — see that doc for
  // why `agent-daemon-server.ts`'s own second `ExternalMcpOAuthService` instance must reuse these
  // rather than building a second pair over a second, independently-opened `content.db` handle.
  // Backed by THIS root's `db` — the same file the main web server's public OAuth callback route and
  // the agent daemon's `external_mcp_oauth_connect` tool both open their own handle onto, which is
  // what lets either process complete a handshake the other started.
  const externalMcpOAuthPending = createSqlitePendingAuthorizationStore({ db, clock, sealer: siteAssistantSecretSealer, keyring: siteAssistantSecretKeyring });
  const externalMcpOAuthDevices = createSqliteDeviceAuthorizationStore({ db, workspaceId, clock, sealer: siteAssistantSecretSealer, keyring: siteAssistantSecretKeyring });

  // 2026-08-31 (mail rule-of-two build): resolved once here, ahead of the `RouteDeps` object
  // literal below, because `mailer:` (built from it) is an earlier property than
  // `customCredentialSetRepo:` — see `resolve-mailer.ts`'s own header for the full design. Sealed
  // via the SAME shared sealer/keyring every other credential repo on this root already reuses (no
  // third `EnvOrFileKeyring` instance).
  const customCredentialSetRepo = new SqliteCustomCredentialSetRepo(db);
  // `runtimeMode` itself is now resolved further up (see `newsletterKeyring`'s own hoisting
  // comment above) — kept read here via the same local rather than re-hoisting every downstream
  // use, since everything below this point already assumed a local named `runtimeMode` exists.
  // Outbound mail-API calls (Resend today) use the shared `SINGLE_HOP_HTTPS_EGRESS_POLICY` — see
  // `platform/http/egress-policies.ts`'s own header for why this used to be a hand-copied literal
  // (no default policy exists elsewhere in this codebase to reuse otherwise; checked: no production
  // `HttpClientPort` consumer was wired into either composition root before this).
  const resolvedMailer = createResolvedMailer({
    workspaceId,
    customCredentialRepo: customCredentialSetRepo,
    sealer: siteAssistantSecretSealer,
    httpClient: createDefaultHttpClient(SINGLE_HOP_HTTPS_EGRESS_POLICY),
    mode: runtimeMode,
  });

  // `features/custom-credentials`'s two agent tools (`custom_credential_verify`/
  // `custom_credential_make_request`) need a guarded `HttpClientPort` of their own — see
  // `routes/types.ts`'s `customCredentialsHttpClient` doc for why this is a genuinely separate
  // CLIENT instance from the mailer's above. Built from its own `CUSTOM_CREDENTIALS_EGRESS_POLICY`
  // (2026-09-10) rather than the mailer's `SINGLE_HOP_HTTPS_EGRESS_POLICY` — that policy's own doc
  // has the live incident (GitHub's Actions job-logs endpoint 302s to a signed Azure Blob URL) that
  // made a zero-redirect policy the wrong fit for this tool specifically.
  const customCredentialsHttpClient = createDefaultHttpClient(CUSTOM_CREDENTIALS_EGRESS_POLICY);

  // `features/media-import`'s `media_import_from_url` needs its own guarded `HttpClientPort` — a
  // THIRD instance, and the only one built from a policy other than SINGLE_HOP_HTTPS. See
  // `routes/types.ts`'s `mediaImportHttpClient` doc and `MEDIA_IMPORT_EGRESS_POLICY`'s own doc for
  // why fetching an image file cannot use the fixed-method, no-redirect, 1 MB policy above.
  const mediaImportHttpClient = createDefaultHttpClient(MEDIA_IMPORT_EGRESS_POLICY);

  // `features/publish-content`'s outbound push/pull leg needs its own guarded `HttpClientPort` — a
  // FOURTH instance. It is the only one whose policy is built rather than imported as a literal,
  // because it is the only one with an operator-configurable `devHostAllowlist`: a legitimate
  // publish peer may sit on a private network (Railway/Render internal DNS, an AWS VPC, two Tovus
  // behind one VPS firewall), and `TOVU_PUBLISH_CONTENT_DEV_HOSTS` is the plain env var that says
  // so on every platform. Unset means "every peer must resolve to a public address", the safe
  // default. See `createPublishContentPeerEgressPolicy`'s own doc.
  const publishContentPeerHttpClient = createDefaultHttpClient(
    createPublishContentPeerEgressPolicy(parsePublishContentDevHosts(process.env.TOVU_PUBLISH_CONTENT_DEV_HOSTS))
  );

  // Composio connectors. The service is built BEFORE the deps object because both the routes and
  // the boot hydration below need the same instance — its provider holds the catalog cache and the
  // OAuth pending-state map, so a second instance would silently not share either.
  const composioConfigRepo = new SqliteComposioConfigRepo(db);
  const composioConnectors = createComposioConnectors({
    workspaceId,
    repo: composioConfigRepo,
    credentialRepo: new SqliteConnectorCredentialRepo(db),
    sealer: siteAssistantSecretSealer,
    keyring: siteAssistantSecretKeyring,
    clock,
    // Test-only seam: points the provider at a fake Composio for `development/e2e`. Unset in every
    // real deployment, where the provider's own default origin applies.
    ...(process.env.TOVU_COMPOSIO_BASE_URL ? { baseUrl: process.env.TOVU_COMPOSIO_BASE_URL } : {}),
  });
  // Loads the sealed API key into the provider's synchronous snapshot. Failure is logged, not
  // fatal: an unhydrated provider still serves its static catalog, so the Connectors tab degrades
  // to its unconfigured (gated) state rather than taking the whole admin down.
  void composioConnectors.refresh().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`composio connectors hydration failed at boot: ${(err as Error).message}`);
  });

  // Extracted (not inlined into the return object below) so `revertRegistry` can close over the
  // SAME instance `RouteDeps.postRepo` exposes, rather than a second `SqlitePostRepo(db)` — both
  // are stateless wrappers over the shared `db` handle, so a second instance would behave
  // identically, but reusing one matches this root's existing single-instance convention (see
  // `outbox`/`settingsRepo` above).
  const postRepo = new SqlitePostRepo(db);

  // Task 8 of the publish-content (Publish Content) feature — same "reuse one instance" convention
  // as `postRepo` just above: `publishContentApplyPort`'s own bundle/baseline reads must hit the
  // SAME rows `RouteDeps.publishContentBundleRepo`/`publishContentBaselineRepo` expose (both are
  // stateless wrappers over the shared `db`, so a second instance would behave identically, but one
  // instance matches this root's own stated convention). `changeSets` is hoisted for the identical
  // reason as `revertRegistry`'s `postRepo` above.
  const changeSets = new SqliteChangeSetRepo(db);
  // Hoisted out of the `routeDeps` literal below for the SAME reason as `changeSets` above: the
  // apply loop's `media.apply()` must read and write through the same adapters every media route
  // uses. Both are stateless wrappers over the shared `db`, so a second instance would behave
  // identically — one instance simply matches this root's own stated convention.
  const mediaRepo = new SqliteMediaRepo(db);
  const assetBlobRepo = new SqliteAssetBlobRepo(db);
  const publishContentBundleRepo = new SqlitePublishContentBundleRepo(db);
  const publishContentBaselineRepo = new SqlitePublishContentBaselineRepo(db);
  const publishContentRunRepo = new SqlitePublishContentRunRepo(db);
  // `publish-files-plan-2026-09-24.md` §3 — ONE process-lifetime instance, same "hoisted, never
  // rebuilt per request" convention as every repo above. See `routes/types.ts`'s `fileBlobIndex` doc.
  const publishContentFileBlobIndex = createFileBlobIndex();
  // Task 10 — named remote Tovus, with their API keys sealed at rest under the shared ADR-058
  // sealer/keyring below. See `routes/types.ts`'s `publishContentPeerRepo` doc.
  const publishContentPeerRepo = new SqlitePublishContentPeerRepo(db);
  // D1 — ONE seed lookup for both the import route's planner and the apply loop's re-verification
  // (`RouteDeps.publishContentSeedHash`), so the two can never disagree on "untouched since seed".
  const publishContentSeedHash = createSqlitePublishContentSeedHash({
    seedDbPath: builtInContentSeedDbPath(),
    workspaceId,
    clock,
    idGen,
    redirectsWriteDeps,
  });
  // One array shared by `routeDeps.themes` (below) and the theme-files apply's refresh hook, so a
  // published theme's partials/pages re-render without a restart (`rescanThemes` refills IN PLACE).
  const siteThemes = discoverAllBuiltInThemes({ dir: resolvedThemesDir, source: "built-in" });
  const publishContentApplyPort = createPublishContentApplyPort({
    workspaceId,
    bundleRepo: publishContentBundleRepo,
    baselineRepo: publishContentBaselineRepo,
    runRepo: publishContentRunRepo,
    publishContentDeps: toPublishContentApplyDeps({
      workspaceId,
      clock,
      idGen,
      outbox,
      changeSets,
      authorize: identity.authorize,
      // F2 — one ports bag keyed by entityType (`type-registry.ts`'s `PublishContentPorts`).
      ports: {
        post: {
          repo: postRepo,
          forgetRemoved: bindForgetRemovedEntity(trashRepo, POST_ENTITY_TYPE),
          // S4 (publish-overwrite-live-plan-2026-09-24) — same binding `routeDeps.removePost` below
          // uses; the post handler's `retire()` needs it to wrap `retirePostForReplacement`.
          remove: removeEntityWithoutBlocker(bindRemoveEntity(trash, POST_ENTITY_TYPE)),
        },
        media: { repo: mediaRepo, assetBlobRepo, blobStore },
        redirect: redirectsWriteDeps,
        menu: { repo: menuRepo, bindingRepo: navLocationBindingRepo },
        "theme-files": {
          // S19 (S-F4) — the theme-files handler's `apply()` stages/writes under this site's own
          // themes root, the SAME value `routeDeps.themesDir` (below) resolves to. See
          // `routes/types.ts`'s `themesDir` doc.
          themesDir: resolvedThemesDir,
          onReplaced: () => {
            rescanThemes({ themes: siteThemes, dir: resolvedThemesDir });
          },
        },
      },
    }),
    clock,
    idGen,
    getSeedHash: publishContentSeedHash,
  });

  const routeDeps: NewsletterRouteDeps = {
    workspaceId: workspaceId,
    workspaceRepo: new SqliteWorkspaceRepo(db),
    trash,
    // Pre-bound per domain. A delete path receives exactly one of these and therefore cannot reach
    // another domain's entities by passing the wrong string.
    removePost: removeEntityWithoutBlocker(bindRemoveEntity(trash, POST_ENTITY_TYPE)),
    removeComment: bindRemoveEntity(trash, COMMENT_ENTITY_TYPE),
    removeMedia: removeEntityWithoutBlocker(bindRemoveEntity(trash, MEDIA_ENTITY_TYPE)),
    removeRedirect: bindRemoveEntity(trash, REDIRECT_ENTITY_TYPE),
    removeWidget: removeEntityWithoutBlocker(bindRemoveEntity(trash, "widget")),
    forgetRemovedMedia: bindForgetRemovedEntity(trashRepo, MEDIA_ENTITY_TYPE),
    forgetRemovedPost: bindForgetRemovedEntity(trashRepo, POST_ENTITY_TYPE),
    // The 60-day backstop's one pass. `createServingApp` owns the timer that calls it, so it runs
    // only in a site-serving process — never in the exporter or the agent daemon.
    sweepTrash: createTrashSweep({ repo: trashRepo, adapters: trashAdapters, transaction: trashTransaction }),
    // Read on every call; see `TrashDeps.isTrashableEntityType`.
    isTrashableEntityType: (entityType) => trashAdapters.has(entityType),
    // `TrashDeps.registry`/`db` — read by `moveToTrash` (`POST .../trash/items`) and by
    // `permissions.ts`'s registry-based permission lookup, both via this same `routeDeps` object.
    registry: trashRegistry,
    db: sqliteTrashDb,
    postRepo,
    postSearch: new SqlitePostSearchIndex(db),
    // SPEC-047/ADR-056 — the db handle and clock are closed over here so no route ever holds one;
    // a route supplies only the `(workspaceId, postId)` scope. See `RouteDeps.pagesHtmlStore`.
    // `entryRefsRepo` (SPEC-047 Slice 3) is the same instance `RouteDeps.entryRefsRepo` below
    // exposes — one shared index, not a second writer. `revisions: postRepo` (S1, fix plan
    // 2026-09-24 row 14) is the SAME `postRepo` constructed above — one `post_revisions` ledger,
    // not a second writer of that either.
    pagesHtmlStore: (scope) => new PagesHtmlDocumentStore(scope, { db, clock, entryRefsRepo, revisions: postRepo }),
    // `chatDb` (opened above, alongside `databaseJournalDb`) is the sidecar `chat.db` handle, NOT
    // `content.db`'s — ADS-memory/reports/2026-09-05-db-split-scoping.md §6. `@jini-ai/sqlite`'s
    // chat-history adapter takes a raw handle and never opens a database itself, which is exactly
    // what let this move from `db.$client` to `chatDb` be a two-line redirect rather than a
    // refactor.
    chatHistory: createChatStoreFactory(chatDb),
    // Migration `0051`'s table, over the same sidecar handle immediately above — see
    // `RouteDeps.agentSessions`'s own doc for why this is not principal-scoped like `chatHistory`.
    agentSessions: createSqliteAgentSessionStore(chatDb),
    presentationRepo,
    settingsRepo,
    getEffective,
    set,
    instructionsNamespace: INSTRUCTIONS_NAMESPACE,
    seoReady,
    settingsReady,
    assistantSettingsReady,
    // See `routes/types.ts`'s `adminAssistantEnabled` field doc — read once here, mirroring
    // `server/app.ts`'s `createRouteDeps()`.
    adminAssistantEnabled: isAdminAssistantEnabled(),
    siteAssistantCredentialRepo: new SqliteSiteAssistantCredentialRepo(db),
    siteAssistantSecretSealer,
    siteAssistantSecretKeyring,
    // The ADMIN's own BYOK credential store — reuses the SAME sealer/keyring instances just above
    // (see `routes/types.ts`'s `adminExecutionCredentialRepo` doc for why one shared sealing
    // capability is correct here rather than a third `EnvOrFileKeyring` instance).
    adminExecutionCredentialRepo: new SqliteAdminExecutionCredentialRepo(db),
    // Same shared sealer/keyring again — one sealing capability across all three credential tables.
    mediaProviderCredentialRepo: new SqliteMediaProviderCredentialRepo(db),
    externalMcpServerRepo,
    /**
     * ADR-058 sealing again, one more consumer: the OAuth subsystem for `authMode: "oauth"`
     * external MCP connections. Built HERE rather than inside `modules/external-mcp.ts` because its
     * pending-authorization and device-authorization stores must be shared by the connect route and
     * the public callback route — two routes in the same module, one instance, and a composition
     * root is where "one instance" is expressible. See `routes/types.ts`'s `externalMcpOAuth` doc
     * for why the field is optional at all, and its `externalMcpOAuthPending`/`externalMcpOAuthDevices`
     * doc for why `pending`/`devices` below are the SAME locals exposed as their own fields rather
     * than built fresh here.
     */
    externalMcpOAuth: createExternalMcpOAuthService({
      workspaceId,
      repo: externalMcpServerRepo,
      sealer: siteAssistantSecretSealer,
      keyring: siteAssistantSecretKeyring,
      clock,
      pending: externalMcpOAuthPending,
      devices: externalMcpOAuthDevices,
    }),
    externalMcpOAuthPending,
    externalMcpOAuthDevices,
    // See `routes/types.ts`'s `derivedPublicOrigin` doc. Reuses `devCapabilityScheme` (derived just
    // above for the dev-capability origin seed) rather than calling `resolveDevTls` a second time —
    // that would re-read the cert/key PEM files off disk for no reason, since the scheme is the only
    // part of that resolution this needs.
    derivedPublicOrigin: `${devCapabilityScheme}://localhost:${Number(process.env.PORT ?? 3000)}`,
    // Same shared sealer/keyring once more — see the note above the BYOK repo.
    composioConfigRepo,
    composioConnectors,
    executionSettingsReady,
    settingsUiTabsReady,
    analyticsSettingsReady,
    siteTitleReady,
    siteTitlePreservationStore,
    siteDisplayName,
    // ADR-046 Phase 1 slice 1 (SPEC-023, 2026-07-16): change-set mutation history now survives a
    // restart — the first durable-adapter slice off Phase 1's capability table, per the ADR's own
    // "pull-based per capability, not a uniform sweep" fold-in guidance.
    changeSets: new SqliteChangeSetRepo(db),
    // Pre-loaded with the post-domain reverters, closed over the SAME postRepo/clock/outbox
    // instances this root threads through everything else (ADR-018 C-005/C-006; 2026-08-13
    // features-post-deep-import-trace.md Job 2 — see `features/post/reverters.ts`'s header).
    // R4 (`plan-publish-repoint-menus-2026-09-24.md` §2.4/§3) wraps the SAME registry with the
    // menu-domain `menu/update` reverter, closed over this root's own menuRepo, so a repoint change
    // set is revertible from History exactly like any other publish write.
    revertRegistry: registerMenuReverters(
      createPostRevertRegistry({
        postRepo,
        clock,
        outbox,
        // `post/delete`'s reverter clears the trash marker; without this the index row it was written
        // with outlives it and the Trash lists a post that is live again.
        forgetRemoved: bindForgetRemovedEntity(trashRepo, POST_ENTITY_TYPE),
      }),
      { menuRepo, clock, idGen, outbox }
    ),
    themes: siteThemes,
    themesDir: resolvedThemesDir,
    // Design C (2026-09-16) — the package's own read-only catalog, threaded through separately from
    // `themesDir` above (which is this SITE's own themes root) so `resolveThemeOriginalSource` can
    // fall back to it for a theme this site has no catalog original of its own for. Already resolved
    // once above (`seedSiteThemes({ stockDir: builtInThemesDir(), ... })`); calling it again here is
    // the same cheap, side-effect-free env/path lookup, not a second filesystem walk.
    packageThemesDir: builtInThemesDir(),
    siteBinding: resolvedSiteBinding,
    siteBackupSources: resolveSiteBackupSources({ siteDir: resolvedSiteBinding.dir, uploadsDir: resolvedUploadsDir, themesDir: resolvedThemesDir }),
    outbox,
    bus,
    // Env-driven — off (the real no-op port) unless the operator has set
    // `OTEL_EXPORTER_OTLP_ENDPOINT`. This is the composition root BOTH real-process boot paths
    // build `RouteDeps` from (`index.ts`'s non-memory branch AND `cli/commands/serve.ts`'s `tovu
    // serve`), so this is the one call site where the real (non-hermetic) adapter choice belongs —
    // see `platform/observability/index.ts`'s `createObservabilityPort` doc and `routes/types.ts`'s
    // `ObservabilityDeps` doc for the rule-of-two this mirrors.
    observability: createObservabilityPort(),
    // Constructed over the same already-opened content.db that carries site content. Its
    // constructor reads the table now, so a missing or inaccessible deny store stops boot rather
    // than making every disconnected publisher silently look connected.
    publishTrustRevocations: new SqlitePublishTrustRevocationStore(db),
    clock,
    idGen,
    // ADR-046 Phase 1 (final capability slice): analytics ingest buffer is durable — survives a
    // restart, closing the `LocalBufferSink.capabilities().durable` misreport the capability
    // inventory flagged.
    analyticsSink: new SqliteBufferSink({ db, workspaceId: workspaceId }),
    analyticsConfig: createSettingsAnalyticsConfig({ settingsRepo }),
    ...identity,
    // Overrides `identity`'s placeholder default (`undefined`/`async () => false`) — see
    // `wiring.ts`'s `IdentityRouteDepsSlice.removeUser` doc. Must stay AFTER `...identity` above.
    removeUser,
    isInTrash,
    redirectRepo,
    redirectHitSink,
    originRegistry,
    redirectsWriteDeps,
    // ADR-046 Phase 1 (2026-07-16): durable SQLite adapters — already fully built and
    // contract-tested, wired into a real composition root for the first time.
    memberRepo,
    memberTierRepo: new SqliteMemberTierRepo(db),
    memberSubscriptionRepo: new SqliteMemberSubscriptionRepo(db),
    memberSessionRepo: new SqliteMemberSessionRepo(db),
    magicLinkRepo: new SqliteMagicLinkTokenRepo(db),
    // SPEC-022 REQ-09/REQ-10: every send routes through the purpose-scoped seam. No capability
    // has a durable outbox path yet (Phase 1 territory — see capability-inventory.ts's "outbox"
    // entry), so `durableOutboxReady` is unconditionally false today; in `local` mode (the
    // default) the gate never refuses regardless (INV-06). `resolvedMailer.mailer` (built above,
    // ahead of this object literal) is the boot-time-resolved real-or-console adapter — see
    // `resolve-mailer.ts`'s own header for the hosted-API/SMTP/console resolution order and the
    // disclosed startup race.
    mailer: wrapMailerWithPurposeGate({
      inner: resolvedMailer.mailer,
      mode: runtimeMode,
      durableOutboxReady: () => false,
    }),
    menuRepo,
    navLocationBindingRepo,
    removeMenu: removeEntityWithoutBlocker(bindRemoveEntity(trash, "menu")),
    // ADR-046 Phase 1 (2026-07-16): durable SQLite adapters, wired into a real composition root
    // for the first time. Delivery-worker activation itself stays gated (REQ-07/SPEC-022's
    // capabilityRouteGuard unconditionally contains "webhooks" in production mode regardless of
    // durability) until a Phase-1-follow-on spec supplies the rest of the production gate ADR-046
    // names for this row (guarded HttpClientPort, egress policy, worker lifecycle).
    webhookSubscriptionRepo: new SqliteWebhookSubscriptionRepo(db),
    webhookDeliveryRepo: new SqliteWebhookDeliveryRepo(db),
    // ADR-PIPE-015 Phase 1: the real KeyringPort-backed signer (GAP-02/GAP-03). Inert until
    // Phase 4 registers the fan-out subscriber + delivery worker — no route calls this directly
    // yet, so wiring it now carries no live-traffic risk ahead of that gated activation.
    webhookSigner: createKeyringBackedSigner(newsletterKeyring),
    // ADR-046 Phase 1 (2026-07-16): durable SQLite adapters for all four route-consumed media
    // repos — previously in-memory (ADR-027 walking skeleton, rows lost on every restart). Bytes
    // already used the real `LocalFsBlobStore` (unlike `server/app.ts`'s hermetic-test
    // composition) since durable byte database was always the one piece of Media pointless to fake
    // in the actual running server.
    mediaRepo,
    assetBlobRepo,
    assetRenditionRepo,
    mediaContentTypeStore: new SqliteMediaContentTypeStore(db),
    // 2026-08-12: wiring products into template render data. Plain Drizzle repos over the SAME
    // `db` every other adapter above already shares — no plugin/`declareDataModule()` bootstrap
    // needed (unlike `store`/`lipay`), so this is as cheap as `mediaRepo` above, not a `store`-
    // style special case.
    commerceProductRepo: new SqliteCommerceProductRepo(db),
    commercePriceRepo: new SqliteCommercePriceRepo(db),
    blobStore,
    // Boot-time blob hydration readiness — see the `blobHydrationReady` construction above (hoisted
    // alongside `blobStore` itself) for why this is fired independently and exposed here.
    blobHydrationReady,
    // ADR-027 §4 transform registry + rendition generation: registry rows are now durable too
    // (ADR-046 Phase 1). The real running server gets `SharpImageTransformer` (unlike
    // `server/app.ts`'s hermetic-test composition, which uses the deterministic in-memory
    // double). `sharp` is a pinned, installed dependency (`package.json`) — this stale "not
    // installed" note was flagged by the 2026-07-15 `/audit-work` batch (ADR-046 finding B-01)
    // and corrected here and in ADR-046 itself. See `src/media/image-transformer.sharp.ts`'s file
    // header for the still-real lazy-require rationale.
    transformDefinitionRepo,
    imageTransformer: new SharpImageTransformer(),
    // SPEC-011 (Newsletter): real SQLite adapters for all 6 repo ports (the campaign pair is
    // Drizzle-backed; the 5 `p_newsletter__*` tables are raw-SQL, `declareDataModule()`-created —
    // see `newsletterReady` above). `membersConsentCapability` stays `null` (unbound) — Members has
    // not shipped a real capability this pass (ADR-PIPE-011 Risks item 3); Newsletter must not
    // substitute a local stand-in that returns success by default.
    newsletterReady,
    newsletterCampaignRepo: new SqliteNewsletterCampaignRepo(db),
    newsletterListRepo,
    newsletterSubscriptionRepo: new SqliteNewsletterSubscriptionRepo(db),
    newsletterAudienceSnapshotRepo: new SqliteNewsletterAudienceSnapshotRepo(db),
    newsletterSendRepo: new SqliteNewsletterSendRepo(db),
    newsletterConfirmationTokenRepo: new SqliteNewsletterConfirmationTokenRepo(db),
    membersConsentCapability: null,
    // Stage 5 (routes) wiring — see the hoisted-vars comment above `commentsModule`/return.
    newsletterSubscriberDirectory,
    newsletterKeyring,
    newsletterHooks,
    // SPEC-010 (Forms, Tier-1 sample plugin, ADR-PIPE-010): the real SQLite rule-of-two adapters
    // (unlike the several "no SQLite adapter yet" libraries noted above — Forms' C-012 ports both
    // ship one). `formsRateLimiter` is one process-lifetime counter store, matching
    // `server/app.ts`'s hermetic-test composition's identical construction.
    formDefinitionRepo,
    formSubmissionRepo: new SqliteFormSubmissionRepo(db),
    removeFormSubmission: removeEntityWithoutBlocker(bindRemoveEntity(trash, "form_submission")),
    formsRateLimiter: createRateLimiter({ profile: FORMS_SUBMIT_PROFILE, clock }),
    // SPEC-046 REQ-7 — same one-process-lifetime-counter-store shape as `formsRateLimiter` above,
    // just above it so the two process-lifetime rate limiters stay visually paired.
    siteAssistantRateLimiter: createRateLimiter({ profile: SITE_ASSISTANT_PER_IP, clock }),
    databaseLedgerRepo,
    // Real SQLite adapters (this dispatch, closing Session 5's disclosed "no SQLite adapter yet
    // for content-types/entries/taxonomy" gap — see `features/{content-types,entries,taxonomy}/
    // repo.sqlite.ts` file headers). `contentTypeIndexProvisioner` stays a no-op: building the real
    // ADR-022 §3 expression-index DDL executor is a separate, larger work item this dispatch's
    // scope (persistence for the registry/entries/taxonomy rows themselves) does not cover —
    // disclosed explicitly rather than silently left implying it's done.
    contentTypeRepo,
    contentTypeIndexProvisioner: new NoopContentTypeIndexProvisioner(),
    entryRepo,
    taxonomyRepo: new SqliteTaxonomyRepo({ db, workspaceId: workspaceId }),
    termRepo: new SqliteTermRepo({ db, workspaceId: workspaceId }),
    // `removeTerm` is WIDE (carries `"blocked"` — the `term` registry entry declares a
    // `TERM_HAS_CHILDREN` blocker); `removeTaxonomy` is narrowed the same way as `removeMenu`/
    // `removeFormSubmission` above (T6, step 3).
    removeTerm: bindRemoveEntity(trash, "term"),
    removeTaxonomy: removeEntityWithoutBlocker(bindRemoveEntity(trash, "taxonomy")),
    // Same instance backs both `entryTermRepo` (the certified write-service port, widened with the
    // Mergeable/AssignmentCount additive capabilities) and `entryTermReadRepo` (the new
    // `EntryTermReadPort` read path, `routes/types.ts`'s own doc explains why these are two
    // separately-typed fields rather than one further-widened intersection).
    entryTermRepo: sqliteEntryTermRepo,
    entryTermReadRepo: sqliteEntryTermRepo,
    taxonomyRevisionRepo: new SqliteTaxonomyRevisionRepo({ db, workspaceId: workspaceId }),
    stampWatermark: sqliteStampWatermark(db),
    restorePointsRepo,
    dbOps,
    databaseIntrospection,
    // Built HERE, over the SAME `db` handle every repo above shares, rather than in the module that
    // consumes it — see `RouteDeps.toolAttemptAuditSink`'s own doc. Deliberately not a second
    // `openContentDb(dbPath)`: that call migrates unconditionally, and this root has already opened
    // (and migrated) the one file both handles would point at.
    toolAttemptAuditSink: new SqliteToolAttemptAuditSink(db),
    siteStatusRepo: new InMemorySiteStatusRepo(),
    migrationRunsRepo,
    disclosureWatermarkSource: new AlwaysUnavailableWatermarkSource(),
    deepLinkRestorePointLookup: new RestorePointDeepLinkLookup(restorePointsRepo),
    // SPEC-016 (`core/gated-mutations`'s gateway, ADR-041 §5) — composed into a real composition
    // root for the first time this dispatch (Session 5's own disclosure: "a token-store-backed
    // primitive composed into ZERO composition roots in this codebase as of this session"). One
    // process-lifetime `GatewayDeps`. `tokens: new SqliteTokenStore(db)` (SPEC-022 durability fix —
    // see `core/gated-mutations/composition.ts`'s file header): this composition root is the real
    // production one, so its `gated-mutations` capability must be durable, unlike `server/app.ts`'s
    // hermetic in-memory composition which still gets the default `InMemoryTokenStore`.
    // `authorizeInstance` closes the instance-scope authorization gap
    // (`GatewayDeps.authorizeInstance`'s doc comment): bound to `buildOwnerOnlyInstanceAuthorize`
    // over `identity.ownerPrincipalId`, the seeded owner already treated as this instance's sole
    // never-disable-able principal (SPEC-006 0.6.0).
    gatedMutations: {
      gatewayDeps: buildGatewayDeps({
        clock,
        idGen,
        authorize: identity.authorize,
        authorizeInstance: buildOwnerOnlyInstanceAuthorize({ ownerPrincipalId: identity.ownerPrincipalId }),
        tokens: new SqliteTokenStore(db),
      }),
    },
    commentRepo: commentsModule.commentRepo,
    commentIngressPolicy: commentsModule.ingressPolicy,
    commentWriteService: commentsModule.writeService,
    commentsReady,
    commentsSettingsReady,
    widgetBindingRepo,
    entryRefsRepo,
    // SPEC-005 BR-01/BR-05 — one process-lifetime runtime instance shared by activation and every
    // content save. The root owns concrete adapters; `plugin-runtime.ts` owns capability-handle
    // composition and the load/setup/attach sequence.
    pluginActivationRepo,
    discoverPlugins: pluginRuntime.discoverPlugins,
    onPluginEnabled: pluginRuntime.onPluginEnabled,
    onPluginDisabled: pluginRuntime.onPluginDisabled,
    removePlugin,
    readPluginPackageFiles: pluginRuntime.readPluginPackageFiles,
    pluginBeforeSaveHook: pluginRuntime.beforeSaveHook,
    pluginRuntimeReady,
    // 2026-08-15 — read-only wiring onto migration 0037's tables, previously applied with zero
    // callers on either end. See `routes/types.ts`'s `deploymentsReadRepo` doc.
    deploymentsReadRepo: new SqliteDeploymentsReadRepo(db),
    // Task 6 of the publish-content (Publish Content) feature — see `routes/types.ts`'s
    // `publishContentBundleRepo` doc. Real, DB-backed (hoisted above so Task 8's
    // `publishContentApplyPort` reads the SAME store); `server/runtime/composition/app.ts`'s
    // hermetic composition uses `InMemoryPublishContentBundleRepo` instead.
    publishContentBundleRepo,
    // `publish-files-plan-2026-09-24.md` §3 — see `routes/types.ts`'s `fileBlobIndex` doc. Same
    // hoisted-singleton instance every real repo above follows.
    fileBlobIndex: publishContentFileBlobIndex,
    // Task 7 — see `routes/types.ts`'s `publishContentBaselineRepo` doc. Real, DB-backed (hoisted
    // above for the same reason); `server/runtime/composition/app.ts`'s hermetic composition uses
    // `InMemoryPublishContentBaselineRepo` instead.
    publishContentBaselineRepo,
    // Task 8 — the real apply loop (`apply-loop.ts`). See `routes/types.ts`'s
    // `publishContentApplyPort` doc.
    publishContentApplyPort,
    publishContentSeedHash,
    // Task 8 — the apply loop's audit trail. See `routes/types.ts`'s `publishContentRunRepo` doc.
    publishContentRunRepo,
    // Task 10 — peers + the guarded outbound client that dials them. See
    // `routes/types.ts`'s `publishContentPeerRepo`/`publishContentPeerHttpClient` docs.
    publishContentPeerRepo,
    publishContentPeerHttpClient,
    // 2026-08-15 — the real export engine, bound here rather than imported inside
    // `features/deployments/export-run.ts`/`export-site.ts` — see `routes/types.ts`'s
    // `runExportSite` doc for why that indirection exists (a real circular-load crash it began as a
    // fix for, now history; it stays to keep `features/deployments` off the export engine's graph).
    runExportSite: (options) => exportSite(options),
    // Read ONCE here rather than deep in `export-run.ts`/`cli/commands/export.ts` — see
    // `resolveExportOutputRootDir`'s own doc immediately above and `routes/types.ts`'s
    // `exportOutputRootDir` doc.
    exportOutputRootDir: resolveExportOutputRootDir(),
    // 2026-08-20 (RouteDeps-narrowing pass 2) — nullary, closed over the `const routeDeps` binding
    // below rather than taking it per call; same self-referencing-closure shape `exportSiteBound`
    // below already uses, same TEST GOTCHA (`routes/types.ts`'s `exportSiteBound` doc, generalized:
    // spread-override is silently inert; mutate the object in place instead).
    createSiteApp: () => createApp(routeDeps),
    // 2026-08-20 (RouteDeps-narrowing pass 2) — same nullary-closure conversion, same reasoning, same
    // TEST GOTCHA.
    resolveStorefrontProducts: () => resolveStorefrontProducts(routeDeps),
    // 2026-09-03 — see `routes/types.ts`'s `resolveActiveThemeId`/`listPublishedPosts` docs and
    // `server/app.ts`'s identical binding. Same nullary-closure-over-`routeDeps` shape as
    // `resolveStorefrontProducts` immediately above.
    resolveActiveThemeId: () => resolveActiveThemeId(routeDeps),
    listPublishedPosts: () =>
      listPublishedPosts({ deps: { repo: routeDeps.postRepo }, input: { workspaceId: routeDeps.workspaceId } }),
    // 2026-08-15 (Contract v2) — see `routes/types.ts`'s `publishCredentialSetRepo`/
    // `publishExecutionMode` docs. Sealed via the same shared sealer/keyring the two credential
    // repos above already reuse (no third `EnvOrFileKeyring` instance).
    publishCredentialSetRepo: new SqlitePublishCredentialSetRepo(db),
    // 2026-08-16 rework — see `routes/types.ts`'s `publishHistoryStore` doc. Real, DB-backed;
    // `server/app.ts`'s hermetic composition uses `InMemoryPublishHistoryStore` instead.
    publishHistoryStore: new SqlitePublishHistoryStore(db),
    publishExecutionMode: executionModeFromEnv(),
    // Read ONCE here rather than deep in `static-publish/adapter.ts` — see
    // `resolvePublishOutputRootDir`'s own doc above and `routes/types.ts`'s `publishOutputRootDir`
    // doc.
    publishOutputRootDir: resolvePublishOutputRootDir(),
    // 2026-08-16 — see `routes/types.ts`'s `publishCredentialVerificationCache` doc. Deliberately
    // in-memory, not DB-backed — one instance per process (this function runs once per boot, per
    // `index.ts`/`agent-daemon-server.ts`'s own call sites), same singleton lifetime
    // `siteAssistantSecretSealer` above already has.
    publishCredentialVerificationCache: new InMemoryPublishCredentialVerificationCache(),
    // 2026-08-15 — see `routes/types.ts`'s `sourceControlCredentialSetRepo` doc. Sealed via the
    // same shared sealer/keyring the credential repos above already reuse (no third
    // `EnvOrFileKeyring` instance).
    sourceControlCredentialSetRepo: new SqliteSourceControlCredentialSetRepo(db),
    // Read ONCE here rather than deep in `source-control/commit-site.ts` — see
    // `resolveSourceControlExportRootDir`'s own doc above and `routes/types.ts`'s
    // `sourceControlExportRootDir` doc.
    sourceControlExportRootDir: resolveSourceControlExportRootDir(),
    // 2026-08-16 (Phase 3) — see `routes/types.ts`'s `vendorCredentialSetRepo` doc. Sealed via the
    // same shared sealer/keyring the two legacy credential repos above already reuse (no third
    // `EnvOrFileKeyring` instance).
    vendorCredentialSetRepo: new SqliteVendorCredentialSetRepo(db),
    // 2026-08-17 — see `routes/types.ts`'s `customCredentialSetRepo` doc. Sealed via the same
    // shared sealer/keyring the credential repos above already reuse (no third `EnvOrFileKeyring`
    // instance). Same instance `resolvedMailer` above was built from — not a second repo.
    customCredentialSetRepo,
    // See `routes/types.ts`'s own doc — a genuinely separate `HttpClientPort` instance from
    // `resolvedMailer`'s, built above.
    customCredentialsHttpClient,
    // 2026-09-06 — see `routes/types.ts`'s `mediaImportHttpClient` doc. A third instance, built
    // above from `MEDIA_IMPORT_EGRESS_POLICY` rather than `SINGLE_HOP_HTTPS_EGRESS_POLICY`.
    mediaImportHttpClient,
    // 2026-08-20 (RouteDeps-narrowing fix) — see `routes/types.ts`'s `exportSiteBound` doc and
    // `server/app.ts`'s matching field for the identical closure-ordering reasoning (`routeDeps`
    // spread LAST, so it always wins over anything a caller's `opts` might also carry).
    exportSiteBound: (opts) => exportSite({ ...opts, routeDeps }),
  };

  // Owner decision 6 (2026-09-21): the widgets the retired "delete permanently" rung left behind
  // (payload status `purged`/`trash`) go into the Trash, once — idempotent, so every later boot finds
  // none and logs nothing. Waits for every boot-time SQLite writer above to settle first (the shared-
  // connection transaction hazard `seoReady`'s comment documents); fire-and-forget, logged, never
  // aborts boot.
  const widgetAdoptionReady = Promise.allSettled([siteTitleReady, menuBindingsReady, mediaTransformReady])
    .then(() => adoptLegacyTrashedWidgets({ deps: buildWidgetsDeps(routeDeps), input: { workspaceId } }))
    .then(({ adopted }) => {
      for (const widget of adopted) {
        // eslint-disable-next-line no-console
        console.info(`[trash] moved legacy deleted widget '${widget.id}' ("${widget.title}") to the Trash`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`adoptLegacyTrashedWidgets failed at boot: ${(err as Error).message}`);
    });
  void widgetAdoptionReady;

  return routeDeps;
}

/**
 * D10 fix — lets a second process (the agent daemon, `assistant/agent-daemon-server.ts`) bind to
 * the SAME workspace the main server process already resolved, instead of independently
 * re-resolving `resolveWorkspace`'s default (oldest-row) answer on its own connection. Without
 * this, the two processes agree only because the default resolution happens to be
 * time-invariant today (a newly created workspace can never become "the oldest") — correct by a
 * coincidence of `resolveWorkspace`'s current semantics, not by construction, and the two
 * processes have no way to agree at all once an explicit workspace choice enters the picture.
 *
 * `workspaceIdOverride` undefined reproduces `createSqliteRouteDeps()`'s existing no-override
 * behavior exactly (byte-identical for every current single-workspace caller). When supplied, it
 * is validated against a real workspace row via {@link resolveWorkspace} BEFORE
 * `createSqliteRouteDeps` is called — CIC U-001's `overrides.db`/`overrides.workspaceId`
 * "together or not at all" rule (`createSqliteRouteDeps` above) means the caller cannot supply a
 * bare workspaceId override without also supplying the db handle it was validated against, so
 * this function opens that db handle itself rather than asking `createSqliteRouteDeps` to do so
 * twice.
 *
 * @throws {ValidationError} `workspaceIdOverride` was supplied but names no real workspace row —
 *   propagates uncaught (`resolveWorkspace`'s own error), which is deliberate: a caller (the
 *   daemon) that silently fell back to the default workspace on a bad override would be a worse
 *   failure mode than a loud boot-time crash naming the bad id.
 * @complexity O(1) beyond `resolveWorkspace`'s own cost (see that function's own complexity note).
 * @overallScore 100
 */
export function createSqliteRouteDepsForWorkspace(
  workspaceIdOverride: string | undefined,
  dbPath: string = defaultContentDbPath()
): NewsletterRouteDeps {
  if (workspaceIdOverride === undefined) return createSqliteRouteDeps(dbPath);

  const db = openContentDb(
    dbPath,
    { workspace: seededWorkspace, posts: seededPosts, presentation: seededPresentation },
    recoverIncompleteDataModuleMigrations
  );
  const workspace = resolveWorkspace({ db }, { workspaceId: workspaceIdOverride });
  return createSqliteRouteDeps(dbPath, { db, workspaceId: workspace.id });
}
