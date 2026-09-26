import express from "express";
import { NO_PUBLISH_CONTENT_SEED_HASH, type PublishContentSeedHashFn } from "#src/features/publish-content/seed-hash";
import { randomUUID } from "node:crypto";

import { InMemoryEventBus, InMemoryOutbox, processOutbox } from "#src/contracts/core/events/index";
import { createNoopObservabilityPort } from "#src/platform/observability/index";
import { InMemoryChangeSetRepo } from "#src/contracts/core/commands/index";
import { createSeoEventSubscriptions, createSeoPageHeadHook, ensureSeoSettingDefinitions } from "#src/features/seo/index";
import { registerPageHeadContributor, resetPageHeadRegistry } from "../../inbound/public-http/http/site/page-head.js";
import { InMemoryPostRepo, InMemoryPostSearchIndex, createPostRevertRegistry, listPublishedPosts } from "#src/features/post/index";
import type { PostRecord } from "#src/features/post/index";
import type { RedirectRecord } from "#src/features/redirects/index";
import {
  bindRemoveEntity,
  buildTrashRegistry,
  COMMENT_ENTITY_TYPE,
  bindForgetRemovedEntity,
  createDirectoryTrashAdapter,
  unhideIfRemoveThrows,
  createRecordStoreTrashAdapter,
  createSqliteTrashDb,
  createTableTrashAdapter,
  createTrashService,
  createTrashSweep,
  InMemoryTrashRepo,
  MEDIA_ENTITY_TYPE,
  PLUGIN_ENTITY_TYPE,
  POST_ENTITY_TYPE,
  REDIRECT_ENTITY_TYPE,
  type RemoveEntity,
  type TrashAdapter,
  type TrashDb,
  type TrashedItemsRef,
  withFollowUps,
} from "#src/features/trash/index";
import * as contentSchema from "#src/platform/db/schema.sqlite";
import { openContentDb, type ContentDb } from "#src/platform/db/sqlite/content-db";
import { InMemoryDeploymentsReadRepo } from "#src/features/deployments/index";
import { InMemoryPublishContentBundleRepo } from "#src/features/publish-content/bundle-staging";
import { createFileBlobIndex } from "#src/features/publish-content/file-blob-index";
import { buildContentPublishPorts } from "#src/features/publish-content/content-ports";
import { InMemoryPublishContentPeerRepo } from "#src/features/publish-content/peers";
import { InMemoryPublishContentBaselineRepo } from "#src/features/publish-content/baseline-repo";
import { InMemoryPublishContentRunRepo } from "#src/features/publish-content/run-repo";
import { createInMemoryRevocations } from "#src/features/publish-trust/revocations";
import { createPublishContentApplyPort, toPublishContentApplyDeps } from "#src/features/publish-content/apply-loop";
import { InMemoryPublishCredentialSetRepo, executionModeFromEnv } from "#src/features/deployments/publish-credentials/index";
import { InMemoryPublishCredentialVerificationCache, InMemoryPublishHistoryStore } from "#src/features/deployments/static-publish/index";
import { InMemoryCustomCredentialSetRepo } from "#src/features/custom-credentials/index";
import { createDefaultHttpClient } from "#src/platform/http/client";
import {
  CUSTOM_CREDENTIALS_EGRESS_POLICY,
  MEDIA_IMPORT_EGRESS_POLICY,
  createPublishContentPeerEgressPolicy,
  parsePublishContentDevHosts,
} from "#src/platform/http/egress-policies";
import { InMemorySourceControlCredentialSetRepo } from "#src/features/source-control/index";
import { InMemoryVendorCredentialSetRepo } from "#src/features/vendor-credentials/index";
import { InMemoryPagesHtmlDocumentStore } from "#src/features/pages/index";
// 2026-09-05 (fix-cycle) — used to be a lazy `require()` here; see `runExportSite`'s doc below for
// why a plain static import is now correct.
import { exportSite } from "#src/platform/export/index";
import {
  createInMemoryChatStoreFactory,
  createInMemoryAgentSessionStore,
  InMemorySiteAssistantCredentialRepo,
  InMemoryAdminExecutionCredentialRepo,
  InMemoryExternalMcpServerRepo,
  ensurePublicAssistantSettingDefinitions,
  ensureExecutionSettingDefinitions,
  onExternalMcpRosterChanged,
} from "#src/assistant/index";
import { triggerFederationReload } from "#src/server/runtime/composition/modules/assistant-daemon-client";
// Deep-imported rather than routed through the barrel above: `assistant/index.ts`'s Section D
// ("Admin Daemon Proxy / Process Composition") is documented as consumed by the DAEMON's own proxy
// composition (`server/modules/assistant.ts`) — this route is the opposite of that, a plain static
// page served by THIS website server for the browser's iframe to load directly (see the route's own
// module doc). Filing it under Section D would misdescribe it. `app.ts` is a composition root
// (`.dependency-cruiser.mjs`'s `COMPOSITION_ROOTS`), exempt from `no-deep-imports:assistant` for
// exactly this reason — the same exemption `express.static`'s `/agent-icons` mount below relies on.
import { registerMcpUiSandboxProxyRoute } from "#src/assistant/mcp-ui-sandbox-proxy-route";
import { InMemoryPresentationSettingsRepo, resolveActiveThemeId } from "#src/features/presentation/index";
import {
  InMemorySettingsRepo,
  ensureSettingsUiTabDefinitions,
  getEffective,
  set,
  resolveDefinitionRaw,
  registerDefinitions,
  ensureSettingDefinitions,
  SCOPE_BIT,
  INSTRUCTIONS_NAMESPACE,
} from "#src/features/settings/index";
import { discoverAllBuiltInThemes, rescanThemes } from "#src/features/theme/index";
import { InMemoryWorkspaceRepo } from "#src/features/workspace/index";
import { createInMemoryToolAttemptAuditSink } from "#src/features/tool-audit/repo.memory";
import path from "node:path";
import { builtInThemesDir, resolveExportOutputRootDir, resolvePublishOutputRootDir, resolveSourceControlExportRootDir } from "./deps.js";
import { deriveDevScheme, resolveDevTls, resolveDevTlsCertPaths } from "../boot/dev-tls.js";
import { describeSiteBinding, resolveAppDistDir, resolveCheckoutRoot, resolveProductRoot } from "#src/platform/site-dir/index";
import {
  seededPosts,
  seededPresentation,
  seededWorkspace,
  seedSettingsFromPresentation,
  SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID,
} from "../configuration/seed.js";
import { LocalBufferSink } from "#src/features/analytics/repo.memory";
import {
  ConsoleMailerAdapter,
  InMemoryMagicLinkTokenRepo,
  InMemoryMemberRepo,
  InMemoryMemberSessionRepo,
  InMemoryMemberSubscriptionRepo,
  InMemoryMemberTierRepo,
} from "#src/features/members/index";
import { InMemoryNavLocationBindingRepo, registerMenuReverters } from "#src/features/navigation/index";
import { TrashAwareInMemoryMenuRepo, type TrashableMenuRecord } from "#src/features/navigation/trash-aware-memory-menu-repo";
import { InMemoryWebhookDeliveryRepo, InMemoryWebhookSubscriptionRepo } from "#src/features/webhooks/index";
import { InMemoryKeyring } from "#src/features/webhooks/keyring.memory";
import { createKeyringBackedSigner } from "#src/features/webhooks/signing.keyring";
import { AesGcmSecretSealer } from "#src/features/webhooks/secret-sealer.aesgcm";
import { InMemoryComposioConfigRepo } from "#src/platform/connectors/composio-config-store.memory";
import { createComposioConnectors } from "#src/platform/connectors/composio-service";
import { InMemoryConnectorCredentialRepo } from "#src/platform/connectors/connector-credential-store.memory";
import { InMemoryMediaProviderCredentialRepo } from "#src/features/media/provider-credential-store.memory";
import {
  InMemoryAssetBlobRepo,
  InMemoryAssetRenditionRepo,
  InMemoryBlobStore,
  InMemoryImageTransformer,
  InMemoryMediaContentTypeStore,
  InMemoryVersionedMediaRepo,
  type MediaRecord,
  InMemoryTransformDefinitionRepo,
} from "#src/features/media/index";
import { createInMemoryIdentityRouteDeps } from "#src/features/identity/wiring";
import {
  InMemoryNewsletterAudienceSnapshotRepo,
  InMemoryNewsletterCampaignRepo,
  InMemoryNewsletterConfirmationTokenRepo,
  InMemoryNewsletterListRepo,
  InMemoryNewsletterSendRepo,
  InMemoryNewsletterSubscriptionRepo,
} from "#src/features/newsletter/repo.memory";
import { ensureDefaultList } from "#src/features/newsletter/lists";
import { createHookRegistry, handleSendBatchClaimed, SEND_BATCH_CLAIMED_EVENT } from "#src/features/newsletter/send-pipeline";
import type { SendBatchJob } from "#src/features/newsletter/index";
import { MembersSubscriberDirectory } from "#src/features/members/index";
import type { NewsletterRouteDeps } from "../../inbound/admin-http/routes/newsletter/deps.js";
import { toSendPipelineDeps } from "../../inbound/admin-http/routes/newsletter/deps.js";
import { createNewsletterModule } from "./modules/newsletter.js";
import type { NewsletterPublicRouteDeps } from "../../inbound/public-http/routes/site/newsletter-deps.js";
import {
  InMemoryFormDefinitionRepo,
  InMemoryFormSubmissionRepo,
  type StoredFormSubmission,
} from "#src/features/forms/repo.memory";
import { FORMS_SUBMIT_PROFILE } from "#src/features/forms/rate-limit-profile";
import { createVerifiedOrigin, InMemoryOriginSettingRepo, OriginRegistry } from "#src/features/origin/index";
import {
  InMemoryRedirectRepo,
  RedirectHitSinkImpl,
  RedirectPhaseHandlerResolver,
  redirectMatcher,
  RedirectSlugChangeCapture,
  registerRedirectHitOutboxHandler,
  registerRedirectsPhaseHandlers,
  type RedirectsWriteDeps,
} from "#src/features/redirects/index";
import { registerSlugChangeCapture } from "#src/platform/routing/index";
import { InMemoryDbOpsAdapter, InMemoryDatabaseIntrospectionAdapter, InMemoryMigrationRunsRepo, InMemoryRestorePointsRepo, InMemorySiteStatusRepo, InMemoryDatabaseLedgerRepo } from "#src/features/database/repo.memory";
import { InMemoryContentTypeRepo, NoopContentTypeIndexProvisioner } from "#src/features/content-types/index";
import { TrashAwareInMemoryEntryRepo, type TrashableEntryRecord } from "#src/features/entries/trash-aware-memory-repo";
import { InMemoryWidgetRegionBindingRepo } from "#src/features/widgets/repo.memory";
import { InMemoryEntryRefsRepo } from "#src/contracts/core/entry-refs/repo.memory";
import { InMemoryPluginActivationRepo } from "#src/features/plugin-runtime/repo.memory";
import { WORD_COUNT_RUNTIME_SOURCE } from "#src/features/plugin-runtime/built-ins/word-count/index";
import { forgetPluginActivations, type RemovePluginFn } from "#src/features/plugin-runtime/uninstall";
import { createAgentPluginsModule } from "./modules/agent-plugins.js";
import { createPluginsModule } from "./modules/plugins.js";
import { createSkillsModule } from "./modules/skills.js";
import { composePluginRuntime } from "./plugin-runtime.js";
import { wireCoreResolvers } from "#src/features/widgets/resolvers/index";
import { createNavMenuReadModel } from "#src/features/navigation/index";
import { createCommentsModule, ensureCommentsSettingDefinitions, HeuristicSpamCheck } from "#src/features/comments/index";
import { createSettingsAnalyticsConfig, ensureAnalyticsSettingDefinitions } from "#src/features/analytics/config.settings";
import {
  ensureSiteTitleSettingDefinition,
  InMemorySiteTitlePreservationStore,
  preserveLegacySiteTitles,
} from "#src/features/settings/site-title";
import { InMemoryCommentRepo } from "#src/features/comments/repo.memory";
import type { CommentRecord } from "#src/features/comments/index";
import { registerCommentsSubmitRoute } from "../../inbound/public-http/routes/site/comments-submit.js";
import { noopStampWatermark, toTaxonomyOutbox } from "#src/features/taxonomy/index";
import {
  SqliteEntryTermRepo,
  SqliteTaxonomyRepo,
  SqliteTaxonomyRevisionRepo,
  SqliteTermRepo,
} from "#src/features/taxonomy/repo.sqlite";
import { createTaxonomyPurgeFollowUp, createTermPurgeFollowUp } from "#src/features/taxonomy/taxonomy-trash-follow-ups";
import { AlwaysUnavailableWatermarkSource, RestorePointDeepLinkLookup } from "#src/features/recovery/repo.memory";
import { buildGatewayDeps, buildOwnerOnlyInstanceAuthorize } from "#src/contracts/core/gated-mutations/composition";
import { resolveRuntimeMode } from "#src/contracts/core/runtime-mode";
import { wrapMailerWithPurposeGate } from "#src/platform/mail/purpose-scoped-mailer";
import { registerAdminTaxonomyMergeTermRoutes } from "../../inbound/admin-http/routes/taxonomy/merge-term.js";
import { registerAdminDatabaseMigrateForwardRoutes } from "../../inbound/admin-http/routes/database/migrate-forward.js";
import { registerAdminRecoveryRestoreRoutes } from "../../inbound/admin-http/routes/recovery/restore.js";

import { applyDevCors } from "../../inbound/shared/dev-cors.js";
import { applyRequestTracking } from "../../inbound/shared/observability-middleware.js";
import { parsePublicJsonBody, respondToOversizedBody } from "../../inbound/shared/json-body-parsers.js";
import { applyTrustProxy } from "../../inbound/shared/trust-proxy.js";
import { applySiteServingGate } from "../../inbound/public-http/middleware/site-serving-gate.js";
import { registerAdminStatic } from "../../inbound/admin-http/admin-static.js";
import { registerSiteChatStatic } from "../../inbound/public-http/middleware/site-chat-static.js";
import { registerThemePreviewStatic } from "../../inbound/public-http/middleware/theme-preview-static.js";
import { registerThemeStaticAssets } from "../../inbound/public-http/middleware/theme-static-assets.js";
import { registerThemePagePreview } from "../../inbound/public-http/middleware/theme-page-preview.js";
import { registerSiteRoutes } from "../../inbound/public-http/routes/site/pages.js";
import { registerStoreRoutes } from "../../inbound/public-http/routes/site/store.js";
import { registerPaymentsWebhookRoute } from "../../inbound/public-http/routes/site/payments-webhook.js";
import { registerProductRoutes, resolveStorefrontProducts } from "../../inbound/public-http/routes/site/products.js";
import { registerAnalyticsIngestRoute } from "../../inbound/public-http/routes/site/analytics-ingest.js";
import { registerContentPostGetRoute } from "../../inbound/public-http/routes/content/posts/get-by-slug.js";
import { createCommentsModerationModule } from "./modules/comments-moderation.js";
import { createCoreModule } from "./modules/core.js";
import { createFormsModule } from "./modules/forms.js";
import { createMenusModule } from "./modules/menus.js";
import { createWidgetsModule } from "./modules/widgets.js";
import { createSettingsModule } from "./modules/settings.js";
import { createUsersModule } from "./modules/users.js";
import { createApiKeysModule } from "./modules/api-keys.js";
import { createWorkspaceModule } from "./modules/workspace.js";
import { createIntegrationsModule } from "./modules/integrations.js";
import { createIntegrationsAdminModule } from "./modules/integrations-admin.js";
import { createConnectorsModule } from "./modules/connectors.js";
import { createExternalMcpModule } from "./modules/external-mcp.js";
import { createDeviceAuthorizationStore, createExternalMcpOAuthService } from "#src/assistant/index";
import { createPendingAuthorizationStore } from "#src/platform/oauth/index";
import { createMediaModule } from "./modules/media.js";
import { createTaxonomyModule } from "./modules/taxonomy.js";
import { createTrashModule } from "./modules/trash.js";
import { withUserTrashAdminOverride } from "./trash-user-admin-override.js";
import { identityServiceDepsFrom } from "../../inbound/admin-http/routes/users/deps.js";
import { createContentModule } from "./modules/content.js";
import { createPublishContentModule } from "./modules/publish-content.js";
import { createMembersModule } from "./modules/members.js";
import type { MembersRouteDeps } from "../../inbound/admin-http/routes/members/deps.js";
import type { MemberPublicRouteDeps } from "../../inbound/public-http/routes/members/deps.js";
import {
  createRateLimiter,
  MAGIC_LINK_COMPLETE_ATTEMPT,
  MAGIC_LINK_PER_EMAIL,
  MAGIC_LINK_PER_IP,
  SITE_ASSISTANT_PER_IP,
} from "#src/contracts/core/rate-limit/rate-limit";
import { createAnalyticsModule } from "./modules/analytics.js";
import { createCommerceModule } from "./modules/commerce.js";
import { registerAdminModuleStatusRoute } from "../../inbound/admin-http/routes/system/module-status.js";
import { registerAdminObservabilityStatusRoute } from "../../inbound/admin-http/routes/system/observability-status.js";
import { registerAdminMailStatusRoute } from "../../inbound/admin-http/routes/system/mail-status.js";
import { registerAdminAssistantDaemonRoutes } from "../../inbound/admin-http/routes/system/assistant-daemon.js";
import { registerAdminDeploymentOverviewRoute } from "../../inbound/admin-http/routes/system/deployment-overview.js";
import { registerAdminSitesRoutes } from "../../inbound/admin-http/routes/system/sites.js";
import { registerAdminSiteProfileRoute } from "../../inbound/admin-http/routes/site/profile.js";
import { registerAdminDockerfileSourceRoute } from "../../inbound/admin-http/routes/system/dockerfile-source.js";
import { registerAdminExportSiteRoutes } from "../../inbound/admin-http/routes/system/export-site.js";
import { registerAdminCustomCredentialsRoutes } from "../../inbound/admin-http/routes/system/custom-credentials.js";
import { registerAdminPublishCredentialsRoutes } from "../../inbound/admin-http/routes/system/publish-credentials.js";
import { registerAdminSourceControlCredentialsRoutes } from "../../inbound/admin-http/routes/system/source-control-credentials.js";
import { registerAdminVendorCredentialsRoutes } from "../../inbound/admin-http/routes/system/vendor-credentials.js";
import { registerAdminSiteTokenRoutes } from "../../inbound/admin-http/routes/system/site-token.js";
import { registerAdminFsFilesCustomRootRoutes } from "../../inbound/admin-http/routes/fs-files/custom-root.js";
import { registerAdminPublishSiteRoutes } from "../../inbound/admin-http/routes/system/publish-site.js";
import { registerAdminDeploymentsListRoute } from "../../inbound/admin-http/routes/deployments/list.js";
import { createFormsAdminModule } from "./modules/forms-admin.js";
import { registerFormsSubmitRoute } from "../../inbound/public-http/routes/site/forms-submit.js";
import { createRedirectsModule } from "./modules/redirects.js";
import { createDatabaseRecoveryModule } from "./modules/database-recovery.js";
import { createContentTypesModule } from "./modules/content-types.js";
import { createSeoModule } from "./modules/seo.js";
import { isAdminAssistantEnabled } from "./admin-assistant-enabled.js";
import { createAssistantModule } from "./modules/assistant.js";
import { createSiteAssistantModule } from "./modules/site-assistant.js";
import { createAssistantChatsModule } from "./modules/assistant-chats.js";
import { createAssistantSettingsModule } from "./modules/assistant-settings.js";
import { createAssistantExecutionModule } from "./modules/assistant-execution.js";
import { createAssistantByokModule } from "./modules/assistant-byok.js";
import { createAssistantAgUiModule } from "./modules/assistant-ag-ui.js";
import type { RouteDeps } from "../../routes/types.js";
// `type`-only, so it is erased and adds no runtime edge — used only to annotate
// {@link runExportSite} below.
import type { ExportEngine } from "#src/features/deployments/export-run";
import type { Express } from "express";
import type { ServerModuleHandle } from "./modules/types.js";

/**
 * @file HTTP composition root and route wiring.
 *
 * Purpose:
 * Assembles concrete adapters and exposes API endpoints.
 *
 * How it relates to the project:
 * - Default composition uses in-memory adapters seeded from `./seed` — this is
 *   what tests exercise (hermetic, no filesystem). The running server injects
 *   the SQLite composition from `./deps` instead (see `index.ts`).
 * - Triggers `processOutbox` after successful writes to deliver async events.
 * - SPEC-044: `CREATE_WORKSPACE`/list/get/update/delete now live in
 *   `modules/workspace.ts` (`createWorkspaceModule`), not inline here — the original unauthenticated
 *   `app.post("/workspaces", ...)` route this file used to own was moved to
 *   `routes/admin/workspace/create.ts` and hardened behind `AUTH_SESSION` + `workspace.manage`.
 *
 * Architectural role:
 * Keeps transport concerns (HTTP, status codes, request parsing) separate from
 * domain logic. Feature code remains reusable outside Express.
 */

export interface CreateRouteDepsOptions {
  readonly pluginFailureThreshold?: number;
  /** Site-installed plugin scan root, threaded to `composePluginRuntime`'s `discoverPlugins()`
   * call (REQ-02). Omitted by default — this composition root is documented "hermetic, no
   * filesystem" (see file header) and every existing caller relies on that; passing a real
   * directory here is opt-in, for a caller that specifically wants to exercise site-plugin
   * discovery through this in-memory root instead of `server/deps.ts`'s SQLite one. */
  readonly installDir?: string;
  /** D1 — the seed-version lookup this instance plans and applies imports against. Omitted means
   *  this hermetic root ships no seed ({@link NO_PUBLISH_CONTENT_SEED_HASH}); a two-instance test
   *  passes a real `createPublishContentSeedHash()` over a third instance standing in for the seed. */
  readonly publishContentSeedHash?: PublishContentSeedHashFn;
}

function createLazyProxy<T extends object>(factory: () => T): T {
  let instance: T | undefined;
  return new Proxy({} as T, {
    get(_target, property) {
      const object = (instance ??= factory());
      const value = Reflect.get(object, property, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/** In-memory route deps seeded from `./seed`. Default for tests/dev. */
export function createRouteDeps(options: CreateRouteDepsOptions = {}): NewsletterRouteDeps {
  const workspaceRepo = new InMemoryWorkspaceRepo([seededWorkspace]);
  const postRepo = new InMemoryPostRepo(seededPosts);
  const presentationRepo = new InMemoryPresentationSettingsRepo([seededPresentation]);
  const settingsRepo = new InMemorySettingsRepo();
  const clock = { nowIso: () => new Date().toISOString() };
  const idGen = { newId: () => randomUUID() };
  const pluginActivationRepo = new InMemoryPluginActivationRepo();
  const pluginRuntime = composePluginRuntime({
    workspaceId: seededWorkspace.id,
    clock,
    activationRepo: pluginActivationRepo,
    sources: [WORD_COUNT_RUNTIME_SOURCE],
    ...(options.installDir === undefined ? {} : { installDir: options.installDir }),
    ...(options.pluginFailureThreshold === undefined
      ? {}
      : { failureThreshold: options.pluginFailureThreshold }),
  });
  const identity = createInMemoryIdentityRouteDeps({ workspaceId: seededWorkspace.id, clock, idGen });
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
  // `settingsReady` resolves (not fired in parallel) — see `deps.ts`'s identical fix for why:
  // two independent writers opening the settings chokepoint's transaction concurrently on the
  // SQLite composition root throws; chaining keeps both composition roots' boot sequence identical.
  const seoReady = settingsReady.then(() =>
    ensureSeoSettingDefinitions(
      { settingsRepo, clock, ids: idGen, principals: identity.principalRepo },
      { workspaceId: seededWorkspace.id, systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
    ).then(() => undefined)
  );

  // SPEC-035 (ADR-028 Settings Layered Ledger wiring for Comments) — idempotently registers the 6
  // `comments.*` definitions at boot, mirroring `seoReady`'s exact fire-and-forget shape. Chained
  // AFTER `seoReady` resolves (not fired in parallel) for the identical reason `seoReady` itself
  // chains after `settingsReady` — see that binding's comment immediately above.
  const commentsSettingsReady = seoReady.then(() =>
    ensureCommentsSettingDefinitions(
      { settingsRepo, clock, ids: idGen, principals: identity.principalRepo },
      { workspaceId: seededWorkspace.id, systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
    ).then(() => undefined)
  );

  // The visitor-facing assistant's master switch (`assistant/public-assistant-settings.ts`).
  // Chained after `commentsSettingsReady` rather than fired in parallel, for the identical reason
  // that binding chains after `seoReady` — see `seoReady`'s own comment above. Registering the
  // definition does NOT enable anything: its default is `false`.
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
      { workspaceId: seededWorkspace.id, systemPrincipalId: SETTINGS_MIGRATION_SYSTEM_PRINCIPAL_ID }
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
  // pin for workspaces that existed before the setting. This root always seeds fresh, so it records
  // no pre-existing workspace (EC-03) and the pin is a no-op. Chained after `analyticsSettingsReady`
  // for the single-SQLite-connection-transaction reason every registration above documents.
  const siteTitlePreservationStore = new InMemorySiteTitlePreservationStore();
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

  // SPEC-011 (Newsletter) — declared here (not inline in the return object) so `newsletterReady`
  // below can seed the default list against the SAME repo instance the returned deps expose.
  const newsletterListRepoInMemory = new InMemoryNewsletterListRepo();

  // SPEC-009 (Redirects, ADR-PIPE-009) — FIRST-TIME composition-root wiring of `origin`'s
  // OriginRegistry and `routing`'s registration functions (Context item 4: neither library had a
  // real consumer before this feature). Seeds a `dev-capability` verified origin for the single
  // seeded workspace, mirroring every other dev-mode fixture in this file (e.g. `seededWorkspace`).
  const originRegistry = new OriginRegistry({
    repo: new InMemoryOriginSettingRepo([
      {
        workspaceId: seededWorkspace.id,
        origin: createVerifiedOrigin({
          scheme: "http",
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
    ]),
  });
  const redirectRepo = new InMemoryRedirectRepo();
  const redirectHitSink = new RedirectHitSinkImpl();
  const outbox = new InMemoryOutbox();
  const bus = new InMemoryEventBus();
  // Admin-UI backend-gap closure (design-spec.md §0.4/§4.8, this dispatch): declared here (not
  // inline in the return object) so Recovery's `deepLinkRestorePointLookup` below reads the SAME
  // in-memory rows Database's restore-points routes write into, not a second, disconnected instance.
  const restorePointsRepo = new InMemoryRestorePointsRepo();
  // Local admin Trash, hermetic half. A plain Map resolved at CALL time, same as `deps.ts`'s —
  // never a module-level registry. Every domain whose delete path is wired to `deps.remove` in this
  // composition must be registered here; an unregistered type fails loudly at the call rather than
  // silently trashing something that could never be restored.
  const commentRepo = new InMemoryCommentRepo();
  // Hoisted here (from beside `changeSets` further down) for TWO reasons now: the apply loop's
  // `media.apply()` must write into the very stores the media routes and this file's own tests
  // read — constructed twice they would be two disconnected in-memory stores — and the media
  // `TrashAdapter` just below needs the same instance.
  const mediaRepo = new InMemoryVersionedMediaRepo([]);
  // Hoisted for the same reason: the `form_submission` `TrashAdapter` below must flip the marker on
  // the very store the Forms routes read.
  const formSubmissionRepo = new InMemoryFormSubmissionRepo();
  // ADR-031/ADR-023 (SPEC-033) — hoisted so the Comments module's `entryLookup` reads the SAME
  // in-memory entries the rest of the hermetic composition writes into (mirrors
  // `restorePointsRepo`'s identical hoisting rationale above) — and so the `widget` `TrashAdapter`
  // below flips the marker on the very store the widget routes read.
  const entryRepo = new TrashAwareInMemoryEntryRepo();
  const workspaceId = seededWorkspace.id;
  const taxonomyDb = createLazyProxy<ContentDb>(() => openContentDb(":memory:"));
  const sqliteTrashDb = createLazyProxy<TrashDb>(() => createSqliteTrashDb({ db: taxonomyDb }));
  const trashRegistry = new Map(
    [...buildTrashRegistry({ schema: contentSchema })].filter(([entityType]) =>
      entityType === "term" || entityType === "taxonomy"
    )
  );
  const trashedItemsRef: TrashedItemsRef = {
    table: contentSchema.trashedItems,
    workspaceId: contentSchema.trashedItems.workspaceId,
    entityType: contentSchema.trashedItems.entityType,
    entityId: contentSchema.trashedItems.entityId,
  };
  const trashRepo = new InMemoryTrashRepo();
  const taxonomyFollowUpTermRepo = new SqliteTermRepo({ db: taxonomyDb, workspaceId });
  const taxonomyFollowUpRevisions = new SqliteTaxonomyRevisionRepo({ db: taxonomyDb, workspaceId });
  const taxonomyFollowUpOutbox = toTaxonomyOutbox({ outbox, clock, idGen, workspaceId });
  const taxonomyRepo = new SqliteTaxonomyRepo({ db: taxonomyDb, workspaceId });
  const termRepo = new SqliteTermRepo({ db: taxonomyDb, workspaceId });
  const entryTermRepo = new SqliteEntryTermRepo({ db: taxonomyDb, workspaceId });
  const taxonomyRevisionRepo = new SqliteTaxonomyRevisionRepo({ db: taxonomyDb, workspaceId });
  const pluginTrashAdapter = createDirectoryTrashAdapter({
    entityType: PLUGIN_ENTITY_TYPE,
    locate: ({ entityId }) => pluginRuntime.locatePluginPackageDirs(entityId),
    forget: ({ entityId }) => forgetPluginActivations({ pluginId: entityId }, { repo: pluginActivationRepo }),
  });
  const trashAdapters = new Map<string, TrashAdapter>([
    [PLUGIN_ENTITY_TYPE, pluginTrashAdapter],
    [
      POST_ENTITY_TYPE,
      createRecordStoreTrashAdapter<PostRecord>({
        entityType: POST_ENTITY_TYPE,
        store: postRepo,
        isHidden: (record) => record.deletedAt !== undefined && record.deletedAt !== null,
        hidden: (record, at) => ({ ...record, deletedAt: at, updatedAt: at }),
        shown: (record, at) => ({ ...record, deletedAt: null, updatedAt: at }),
        // 2026-09-20: `PostRepoPort.hardDelete` now exists on both adapters, so this purges for
        // real. The former stand-down ("`InMemoryPostRepo` has no row removal") was honest but left
        // an expired post un-purgeable in this composition — the sweeper released the lease and
        // retried the same row on every pass, forever. Same cascade the durable adapter performs:
        // `hardDelete` takes the revision ledger and the parked autosave with the row.
        hardDelete: (required) => postRepo.hardDelete(required),
      }),
    ],
    [
      REDIRECT_ENTITY_TYPE,
      createRecordStoreTrashAdapter<RedirectRecord>({
        entityType: REDIRECT_ENTITY_TYPE,
        // `insertRedirect` rather than `save`: this repo's `save` insists on a paired revision, and
        // the revision for a tombstone is written by `tombstoneRedirect` itself.
        store: {
          findById: (required) => redirectRepo.findById(required),
          save: async (record) => {
            await redirectRepo.insertRedirect(record);
          },
        },
        isHidden: (record) => record.status === "disabled",
        hidden: (record, at) => ({ ...record, status: "disabled", updatedAt: at }),
        shown: (record, at) => ({ ...record, status: "active", updatedAt: at }),
      }),
    ],
    [
      COMMENT_ENTITY_TYPE,
      createRecordStoreTrashAdapter<CommentRecord>({
        entityType: COMMENT_ENTITY_TYPE,
        // `save` is this double's direct-write seam (not on `CommentRepoPort`) — the moderation
        // write-service has already flipped the status by the time `remove` runs, so `hide` is a
        // no-op here and only `unhide` (a Trash-screen restore) actually writes.
        store: commentRepo,
        isHidden: (record) => record.status === "trash",
        hidden: (record, at) => ({ ...record, status: "trash", updatedAt: at }),
        // Back to moderation, not to the prior status: the original is recorded nowhere the
        // no-parse rule lets an adapter read, and of the two guesses this is the one that cannot
        // republish spam onto a public page.
        shown: (record, at) => ({ ...record, status: "pending", updatedAt: at }),
        // No `hardDelete`: `InMemoryCommentRepo.purge` needs a moderator, an action and a note this
        // adapter does not have, so purge stands down rather than claiming a removal.
      }),
    ],
    [
      MEDIA_ENTITY_TYPE,
      createRecordStoreTrashAdapter<MediaRecord>({
        entityType: MEDIA_ENTITY_TYPE,
        store: mediaRepo,
        isHidden: (record) => record.status === "trashed",
        hidden: (record, at) => ({ ...record, status: "trashed", updatedAt: at }),
        shown: (record, at) => ({ ...record, status: "active", updatedAt: at }),
        // No `hardDelete`: a media purge is not a row delete — rendition rows hang off it and the
        // blob store holds bytes, a ladder `purgeMedia` owns. Reimplementing it here would orphan
        // bytes, so purge stands down instead.
      }),
    ],
    [
      "form_submission",
      createRecordStoreTrashAdapter<StoredFormSubmission>({
        entityType: "form_submission",
        // The repo's trash-blind, memory-only seam — its port reads hide a trashed submission.
        store: {
          findById: (required) => formSubmissionRepo.findAnyById(required),
          save: (record) => formSubmissionRepo.save(record),
        },
        isHidden: (record) => record.deletedAt !== null,
        hidden: (record, at) => ({ ...record, deletedAt: at }),
        shown: (record) => ({ ...record, deletedAt: null }),
        hardDelete: (required) => formSubmissionRepo.hardDelete(required),
      }),
    ],
    [
      "widget",
      createRecordStoreTrashAdapter<TrashableEntryRecord>({
        entityType: "widget",
        // The repo's trash-blind seam — its port reads hide a trashed entry. No `hardDelete`: a purge
        // here stands down, same as the hermetic media/comment adapters.
        store: {
          findById: (required) => entryRepo.findAnyById(required),
          save: (record) => entryRepo.saveAny(record),
        },
        isHidden: (record) => record.deletedAt !== null,
        hidden: (record, at) => ({ ...record, deletedAt: at }),
        shown: (record) => ({ ...record, deletedAt: null }),
      }),
    ],
    [
      "menu",
      createRecordStoreTrashAdapter<TrashableMenuRecord>({
        entityType: "menu",
        // The repo's trash-blind seam — its port reads hide a trashed menu. No `hardDelete`: a purge
        // here stands down, same as the hermetic media/comment/widget adapters (T5's own registry
        // work removes location bindings at purge; this composition has no bindings table to sweep
        // either, so it stands down the same honest way).
        store: {
          findById: (required) => menuRepo.findAnyById(required),
          save: (record) => menuRepo.saveAny(record),
        },
        isHidden: (record) => record.status === "trash",
        // Stash the pre-trash status so `shown` can restore it — `flip()` has no side-channel of its
        // own for it (see `trash-aware-memory-menu-repo.ts`'s file doc).
        hidden: (record, at) => ({ ...record, status: "trash", updatedAt: at, priorStatus: record.status }),
        shown: (record, at) => ({ ...record, status: record.priorStatus ?? "published", updatedAt: at, priorStatus: null }),
      }),
    ],
    [
      "term",
      withFollowUps({
        adapter: createTableTrashAdapter({
          entry: trashRegistry.get("term")!,
          db: sqliteTrashDb,
          trashedItems: trashedItemsRef,
        }),
        hooks: createTermPurgeFollowUp({
          termRepo: taxonomyFollowUpTermRepo,
          trash: trashRepo,
          revisions: taxonomyFollowUpRevisions,
          outbox: taxonomyFollowUpOutbox,
          clock,
        }),
      }),
    ],
    [
      "taxonomy",
      withFollowUps({
        adapter: createTableTrashAdapter({
          entry: trashRegistry.get("taxonomy")!,
          db: sqliteTrashDb,
          trashedItems: trashedItemsRef,
        }),
        hooks: createTaxonomyPurgeFollowUp({
          termRepo: taxonomyFollowUpTermRepo,
          trash: trashRepo,
          revisions: taxonomyFollowUpRevisions,
          outbox: taxonomyFollowUpOutbox,
          clock,
        }),
      }),
    ],
  ]);
  const trash = createTrashService({
    repo: trashRepo,
    adapters: trashAdapters,
    idGen: { next: () => randomUUID() },
    // Nothing here opens a database transaction, so the runner is a pass-through. The atomicity
    // guarantee this replaces is a SQLite one; an in-memory store has no partial-write window.
    transaction: (fn) => fn(),
  });
  // Folder moves before the Trash row is written; if that write throws, move the folder back.
  const removePlugin: RemovePluginFn = unhideIfRemoveThrows(pluginTrashAdapter, bindRemoveEntity(trash, PLUGIN_ENTITY_TYPE));

  // See `composition/deps.ts`'s identically-named/documented helper: narrows `bindRemoveEntity`'s
  // result for a type whose registry entry declares no `blocker` (redirect/comment/form_submission).
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
    // S7 (web-high fix plan 2026-09-24) — see `composition/deps.ts`'s identically-documented fields.
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
    transaction: async (fn) => fn(),
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

  // SPEC-043/ADR-047 (widgets) — hoisted alongside `entryRepo` for the same reason: both the admin
  // `widgets` routes and the public site-render path (`routes/site/pages.ts` → `resolvePageWidgets`,
  // W-004) must see the SAME binding/ref-index state, not two independent in-memory instances.
  const widgetBindingRepo = new InMemoryWidgetRegionBindingRepo();
  const entryRefsRepo = new InMemoryEntryRefsRepo();
  const menuRepo = new TrashAwareInMemoryMenuRepo();
  const navLocationBindingRepo = new InMemoryNavLocationBindingRepo();
  const formDefinitionRepo = new InMemoryFormDefinitionRepo();
  // Collections plan R1 — hoisted above `wireCoreResolvers` (was constructed later, inline, only for
  // the Admin-UI backend-gap deps object below) so the `recent-entries` widget's "Collection list"
  // mode and the rest of the app (content-type CRUD routes, etc.) share the SAME store — a second
  // `new InMemoryContentTypeRepo()` here would be an empty, disconnected double nothing ever
  // registers a content type into, silently breaking every collection-configured widget.
  const contentTypeRepo = new InMemoryContentTypeRepo();
  const contentTypeIndexProvisioner = new NoopContentTypeIndexProvisioner();
  // SPEC-043/ADR-047 (widgets, Fable adversarial-review fix 2026-07-21) — mirrors `server/deps.ts`'s
  // identical fix: without this, no test exercising the real HTTP path ever ran a dynamic widget
  // type (`menu`/`recent-entries`/`contact-form`) through its actual resolver, only test doubles.
  wireCoreResolvers({
    entryList: entryRepo,
    navMenuReadModel: createNavMenuReadModel({ menuRepo, bindingRepo: navLocationBindingRepo }),
    formDefinitionRepo,
    contentTypes: contentTypeRepo,
  });
  const commentsModule = createCommentsModule({
    commentRepo,
    entryRepo,
    outbox,
    clock,
    idGen,
    spamCheck: new HeuristicSpamCheck(),
    settingsRepo,
    remove: removeEntityWithoutBlocker(bindRemoveEntity(trash, COMMENT_ENTITY_TYPE)),
    forgetRemoved: ({ workspaceId: ws, id }) =>
      trashRepo.deleteByEntity({ workspaceId: ws, entityType: COMMENT_ENTITY_TYPE, entityId: id }),
    // Nothing in this composition opens a database transaction; see `createTrashService` above.
    runInTransaction: (fn) => fn(),
  });

  // SPEC-011 (Newsletter) Stage 5 wiring — hoisted so `newsletterSubscriberDirectory` below reads
  // the SAME member rows the returned `memberRepo` field exposes (mirrors `entryRepo`/
  // `widgetBindingRepo`'s identical hoisting rationale above), and so `newsletterKeyring` is the
  // ONE process-lifetime `KeyringPort` instance also used to build `webhookSigner` just below —
  // one root key, purpose-namespaced (`webhooks/ports.ts`'s `KeyringPort.derive()` contract),
  // not two independent keyrings.
  const memberRepo = new InMemoryMemberRepo([]);
  const newsletterKeyring = new InMemoryKeyring();
  const newsletterSubscriberDirectory = new MembersSubscriberDirectory({ members: memberRepo });
  const newsletterHooks = createHookRegistry();

  // ADR-058: the SITE assistant credential store's OWN `KeyringPort` instance, deliberately not
  // `newsletterKeyring` above — see `routes/types.ts`'s `siteAssistantSecretKeyring` doc and ADR-058
  // §2 for why a separate instance matters in the real composition root (`server/deps.ts`). This
  // hermetic root has no "fail closed on a missing env var" concern to preserve (there is no env var
  // here at all), so a second `InMemoryKeyring` is just the same rule-of-two test double, kept
  // distinct so this root's wiring shape matches `deps.ts`'s one-instance-per-purpose shape.
  const siteAssistantSecretKeyring = new InMemoryKeyring();
  const siteAssistantSecretSealer = new AesGcmSecretSealer(siteAssistantSecretKeyring);
  // Held as a local rather than constructed inline, because the OAuth service below must be given
  // the SAME repo instance the routes read through — two instances would refresh a token into one
  // and read it back from the other.
  const externalMcpServerRepo = new InMemoryExternalMcpServerRepo();
  // Same "one shared instance" reasoning as `externalMcpServerRepo` above, and also exposed as their
  // own `RouteDeps.externalMcpOAuthPending`/`externalMcpOAuthDevices` fields below. Within one
  // process this pair is what makes a connect/callback/poll handshake share state — but this root is
  // process-local, so it cannot do that across processes: `agent-daemon-server.ts` builds its OWN
  // such pair in its own process (see `routes/types.ts`'s doc for the full `TOVU_DB=memory` caveat),
  // which is why the sqlite root's `content.db`-backed pair, not this one, is what carries a chat
  // handshake to completion.
  const externalMcpOAuthPending = createPendingAuthorizationStore({ clock });
  const externalMcpOAuthDevices = createDeviceAuthorizationStore();

  // See `routes/types.ts`'s `derivedPublicOrigin` doc. Mirrors `deps.ts`'s identical derivation
  // (`resolveCheckoutRoot`, a walk-up that is right from both the tsx and the compiled tree) — this
  // hermetic root backs the same live HTTP server as `deps.ts`'s in `TOVU_DB=memory` mode, so its
  // fallback origin must be derived the same way rather than silently differing.
  const REPO_ROOT_FOR_ORIGIN = resolveCheckoutRoot();
  const derivedPublicOrigin = `${deriveDevScheme(resolveDevTls(resolveDevTlsCertPaths(REPO_ROOT_FOR_ORIGIN)).active)}://localhost:${Number(process.env.PORT ?? 3000)}`;

  // Composio connectors, hermetic half. No boot `refresh()` here, unlike `deps.ts`: the in-memory
  // repo starts empty every time, so hydrating it could only ever install the same empty config
  // the provider is already constructed with.
  const composioConfigRepo = new InMemoryComposioConfigRepo();
  const composioConnectors = createComposioConnectors({
    workspaceId: seededWorkspace.id,
    repo: composioConfigRepo,
    credentialRepo: new InMemoryConnectorCredentialRepo(),
    sealer: siteAssistantSecretSealer,
    keyring: siteAssistantSecretKeyring,
    clock,
    ...(process.env.TOVU_COMPOSIO_BASE_URL ? { baseUrl: process.env.TOVU_COMPOSIO_BASE_URL } : {}),
  });

  // Extracted (not inlined into the return object below), same reasoning as `restorePointsRepo`
  // above: Task 8's real `publishContentApplyPort` (`apply-loop.ts`) must read/write the SAME
  // in-memory bundle/baseline/run stores the routes below expose on `RouteDeps`, not a second,
  // disconnected instance — an apply loop reading an empty baseline store would never see `applied`,
  // only ever `created`/`conflict`. `changeSets` is hoisted for the identical reason: the apply
  // loop's `executeCommand` calls must land in the SAME change-set store every other route/test
  // reads off `RouteDeps.changeSets`.
  const changeSets = new InMemoryChangeSetRepo([], [], outbox);
  const assetBlobRepo = new InMemoryAssetBlobRepo([]);
  const blobStore = new InMemoryBlobStore();
  const publishContentBundleRepo = new InMemoryPublishContentBundleRepo();
  const publishContentBaselineRepo = new InMemoryPublishContentBaselineRepo();
  const publishContentRunRepo = new InMemoryPublishContentRunRepo();
  // `publish-files-plan-2026-09-24.md` §3 — no rule-of-two double needed: `FileBlobIndexPort` is
  // already an in-memory LRU (`file-blob-index.ts`'s own doc), so this hermetic root shares the
  // SAME real factory the SQLite root uses. Hoisted for the identical "one process-lifetime
  // instance" reason as every repo above. See `routes/types.ts`'s `fileBlobIndex` doc.
  const fileBlobIndex = createFileBlobIndex();
  // Task 10 — the rule-of-two in-memory peer repo. See `routes/types.ts`'s
  // `publishContentPeerRepo` doc.
  const publishContentPeerRepo = new InMemoryPublishContentPeerRepo();
  const publishContentSeedHash = options.publishContentSeedHash ?? NO_PUBLISH_CONTENT_SEED_HASH;
  // One array shared by `routeDeps.themes` (below) and the theme-files apply's refresh hook, so a
  // published theme's partials/pages re-render without a restart (`rescanThemes` refills IN PLACE).
  const siteThemes = discoverAllBuiltInThemes({ dir: builtInThemesDir(), source: "built-in" });
  const publishContentApplyPort = createPublishContentApplyPort({
    workspaceId: seededWorkspace.id,
    bundleRepo: publishContentBundleRepo,
    baselineRepo: publishContentBaselineRepo,
    runRepo: publishContentRunRepo,
    publishContentDeps: toPublishContentApplyDeps({
      workspaceId: seededWorkspace.id,
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
        ...buildContentPublishPorts({
          workspaceId: seededWorkspace.id,
          postRepo,
          formDefinitionRepo,
          contentTypeRepo,
          contentTypeIndexProvisioner,
          taxonomyRepo,
          termRepo,
          entryTermRepo,
          taxonomyRevisionRepo,
          stampWatermark: noopStampWatermark,
          entryRepo,
        }),
        "theme-files": {
          // S19 (S-F4) — same value `routeDeps.themesDir` (below) resolves to. See
          // `routes/types.ts`'s `themesDir` doc and `deps.ts`'s identical addition to this same
          // apply bag.
          themesDir: builtInThemesDir(),
          onReplaced: () => {
            rescanThemes({ themes: siteThemes, dir: builtInThemesDir() });
          },
        },
      },
    }),
    clock,
    idGen,
    getSeedHash: publishContentSeedHash,
  });

  const routeDeps: NewsletterRouteDeps = {
    workspaceId: seededWorkspace.id,
    trash,
    // The rest of this root stays hermetic; only term/taxonomy exercise the shared scratch database.
    registry: trashRegistry,
    db: sqliteTrashDb,
    removePost: removeEntityWithoutBlocker(bindRemoveEntity(trash, POST_ENTITY_TYPE)),
    removeComment: bindRemoveEntity(trash, COMMENT_ENTITY_TYPE),
    removeMedia: removeEntityWithoutBlocker(bindRemoveEntity(trash, MEDIA_ENTITY_TYPE)),
    removeRedirect: bindRemoveEntity(trash, REDIRECT_ENTITY_TYPE),
    removeWidget: removeEntityWithoutBlocker(bindRemoveEntity(trash, "widget")),
    removeMenu: removeEntityWithoutBlocker(bindRemoveEntity(trash, "menu")),
    // Bound the same way as `composition/deps.ts`; the matching adapters share `taxonomyDb`.
    removeTerm: bindRemoveEntity(trash, "term"),
    removeTaxonomy: removeEntityWithoutBlocker(bindRemoveEntity(trash, "taxonomy")),
    forgetRemovedMedia: bindForgetRemovedEntity(trashRepo, MEDIA_ENTITY_TYPE),
    forgetRemovedPost: bindForgetRemovedEntity(trashRepo, POST_ENTITY_TYPE),
    // Present so this root satisfies `TrashDeps`, and harmless: `createApp` never starts the
    // timer (`createServingApp` does), and the hermetic media/comment adapters have no
    // `hardDelete`, so a pass here would stand down rather than claim a removal.
    sweepTrash: createTrashSweep({ repo: trashRepo, adapters: trashAdapters, transaction: (fn) => fn() }),
    isTrashableEntityType: (entityType) => trashAdapters.has(entityType),
    // The hermetic half of the real SQLite deny store. `core.ts` still narrows this to `list`
    // before giving it to the request gate, so tests retain the same least-authority boundary.
    publishTrustRevocations: createInMemoryRevocations(),
    workspaceRepo,
    postRepo,
    // Mirrors `postRepo` on every query rather than maintaining an index — see
    // `features/post/search-index.memory.ts` for why that is right for this root and wrong for
    // `deps.ts`'s. Constructed eagerly, but its scratch database is not opened until the first
    // search, so the many tests that call `createRouteDeps()` without searching pay nothing.
    postSearch: new InMemoryPostSearchIndex(postRepo),
    // Backed by `postRepo` above, NOT by a throwaway `:memory:` ContentDb — this root's posts do
    // not live in any SQLite database, so a real-adapter-over-scratch-db would edit rows nothing
    // else in this root can see. See `features/pages/html-document-store.memory.ts`'s header.
    // `entryRefsRepo` (SPEC-047 Slice 3) is the same instance `RouteDeps.entryRefsRepo` below
    // exposes — one shared index, mirroring `server/deps.ts`'s identical wiring. No separate
    // `revisions:` field to wire here (S1, fix plan 2026-09-24 row 14) — unlike the sqlite store,
    // this double's `deps.repo` is already the full `postRepo`, so its own `appendRevision` calls
    // use that same instance unconditionally; see `html-document-store.memory.ts`'s header.
    pagesHtmlStore: (scope) => new InMemoryPagesHtmlDocumentStore(scope, { repo: postRepo, clock, entryRefsRepo }),
    // No in-memory *reimplementation* of the chat store: this root gets the real adapter over a
    // throwaway `:memory:` database. `search-index.memory.ts` earns a hand-written double because
    // it mirrors `postRepo` rather than maintaining an index; chat history has no such alternate
    // shape, so a second implementation would only be a second thing to keep in sync — and the
    // one property tests most need to trust here is the isolation predicate, which only the real
    // adapter has. `ensureChatHistoryTables` is the package's own path for a host with no
    // migration system, which is exactly this root's situation.
    chatHistory: createInMemoryChatStoreFactory(),
    // Same "no in-memory reimplementation needed" situation as `chatHistory` above, but this port
    // has no `ai_chats` foreign key or isolation predicate to get right, so a plain map (no `db`
    // at all) is the whole double — see `agent-session-store.ts`'s own doc.
    agentSessions: createInMemoryAgentSessionStore(),
    presentationRepo,
    settingsRepo,
    getEffective,
    set,
    instructionsNamespace: INSTRUCTIONS_NAMESPACE,
    settingsReady,
    seoReady,
    assistantSettingsReady,
    siteAssistantCredentialRepo: new InMemorySiteAssistantCredentialRepo(),
    siteAssistantSecretSealer,
    siteAssistantSecretKeyring,
    adminExecutionCredentialRepo: new InMemoryAdminExecutionCredentialRepo(),
    mediaProviderCredentialRepo: new InMemoryMediaProviderCredentialRepo(),
    externalMcpServerRepo,
    /**
     * ADR-058 sealing again, one more consumer: the OAuth subsystem for `authMode: "oauth"`
     * external MCP connections. Built HERE rather than inside `modules/external-mcp.ts` because its
     * pending-authorization and device-authorization stores are in-memory and must be shared by the
     * connect route and the public callback route — two routes in the same module, one instance,
     * and a composition root is where "one instance" is expressible. See
     * `routes/types.ts`'s `externalMcpOAuth` doc for why the field is optional at all.
     */
    externalMcpOAuth: createExternalMcpOAuthService({
      workspaceId: seededWorkspace.id,
      repo: externalMcpServerRepo,
      sealer: siteAssistantSecretSealer,
      keyring: siteAssistantSecretKeyring,
      clock,
      pending: externalMcpOAuthPending,
      devices: externalMcpOAuthDevices,
    }),
    externalMcpOAuthPending,
    externalMcpOAuthDevices,
    derivedPublicOrigin,
    composioConfigRepo,
    composioConnectors,
    executionSettingsReady,
    settingsUiTabsReady,
    analyticsSettingsReady,
    siteTitleReady,
    siteTitlePreservationStore,
    // No site directory: the site title's no-owner-title value falls back to `workspaces.name` (SPEC-050 EC-03).
    siteDisplayName: { read: () => undefined },
    // BR-04 (2026-07-16): the repo forwards insert()'s optional event to this SAME outbox
    // instance, matching what the old separate executeCommand()-level enqueue() call did.
    // Hoisted above (not constructed inline) — see the comment there for why.
    changeSets,
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
    themesDir: builtInThemesDir(),
    siteBinding: describeSiteBinding(),
    outbox,
    bus,
    // Always the no-op adapter here, never the env-driven `createObservabilityPort()` — this root
    // is documented "hermetic, no filesystem" (file header above), and a stray
    // `OTEL_EXPORTER_OTLP_ENDPOINT` left in a developer's shell must never make a test try to reach
    // a real collector. See `routes/types.ts`'s `ObservabilityDeps` doc for the full rule-of-two.
    observability: createNoopObservabilityPort(),
    clock,
    idGen,
    analyticsSink: new LocalBufferSink(),
    analyticsConfig: createSettingsAnalyticsConfig({ settingsRepo }),
    ...identity,
    redirectRepo,
    redirectHitSink,
    originRegistry,
    redirectsWriteDeps,
    memberRepo,
    memberTierRepo: new InMemoryMemberTierRepo([]),
    memberSubscriptionRepo: new InMemoryMemberSubscriptionRepo([]),
    memberSessionRepo: new InMemoryMemberSessionRepo([]),
    magicLinkRepo: new InMemoryMagicLinkTokenRepo([]),
    // SPEC-022 REQ-09/REQ-10 — see deps.ts's identical wiring for the rationale. This hermetic
    // composition resolves `local` by default (no test sets TOVU_RUNTIME_MODE), so the gate stays
    // inert here — existing tests are unaffected (INV-06).
    mailer: wrapMailerWithPurposeGate({
      inner: new ConsoleMailerAdapter(),
      mode: resolveRuntimeMode(),
      durableOutboxReady: () => false,
    }),
    menuRepo,
    navLocationBindingRepo,
    webhookSubscriptionRepo: new InMemoryWebhookSubscriptionRepo(),
    webhookDeliveryRepo: new InMemoryWebhookDeliveryRepo(),
    // ADR-PIPE-015 Phase 1 T017: the real createKeyringBackedSigner code path, backed by an
    // in-memory KeyringPort so this hermetic test/dev composition never touches a real file or
    // env var. The delivery worker is still the first real consumer — activation stays gated
    // (Phase 4) until the real KeyringPort/HttpClientPort/SQLite adapters are wired in deps.ts.
    webhookSigner: createKeyringBackedSigner(newsletterKeyring),
    // `media` (ADR-027 walking skeleton): in-memory rows + in-memory blob bytes here so tests
    // stay hermetic (no filesystem writes) — the real running server (`server/deps.ts`) uses
    // `LocalFsBlobStore` for actual byte durability while keeping rows in-memory too (see that
    // file's comment for why: no SQLite adapter exists yet for this newer library, matching the
    // disclosed precedent the last several admin-section libraries followed).
    mediaRepo,
    assetBlobRepo,
    assetRenditionRepo: new InMemoryAssetRenditionRepo([]),
    mediaContentTypeStore: new InMemoryMediaContentTypeStore(),
    blobStore,
    // ADR-027 §4 transform registry + rendition generation (new in this task): in-memory registry
    // rows (no SQLite adapter yet, same disclosed precedent as the media repos above) and the
    // deterministic `InMemoryImageTransformer` test double here so hermetic tests never depend on
    // `sharp` being installed — see `src/media/image-transformer.sharp.ts`'s file header for the
    // disclosed blocker on the real adapter, which `server/deps.ts` wires instead.
    transformDefinitionRepo: new InMemoryTransformDefinitionRepo([]),
    imageTransformer: new InMemoryImageTransformer(),
    // SPEC-011 (Newsletter): in-memory adapters — no `declareDataModule()` boot step needed (that
    // mechanism is SQLite-only), so `newsletterReady` resolves immediately, unlike `server/deps.ts`'s
    // real fire-and-forget install. `membersConsentCapability` stays `null` (unbound) — see that
    // file's identical note.
    // T030: seed the default "all subscribers" list once, same as `server/deps.ts`'s real boot path.
    newsletterReady: ensureDefaultList({
      deps: { listRepo: newsletterListRepoInMemory, clock, ids: idGen },
      input: { workspaceId: seededWorkspace.id },
    }).then(() => undefined),
    newsletterCampaignRepo: new InMemoryNewsletterCampaignRepo(),
    newsletterListRepo: newsletterListRepoInMemory,
    newsletterSubscriptionRepo: new InMemoryNewsletterSubscriptionRepo(),
    newsletterAudienceSnapshotRepo: new InMemoryNewsletterAudienceSnapshotRepo(),
    newsletterSendRepo: new InMemoryNewsletterSendRepo(),
    newsletterConfirmationTokenRepo: new InMemoryNewsletterConfirmationTokenRepo(),
    membersConsentCapability: null,
    // Stage 5 (routes) wiring — see the hoisted-vars comment above `commentsModule`/return.
    newsletterSubscriberDirectory,
    newsletterKeyring,
    newsletterHooks,
    // SPEC-010 (Forms, Tier-1 sample plugin, ADR-PIPE-010): in-memory adapters, matching every
    // other core-owned-table feature's hermetic test/dev composition. `formsRateLimiter` is one
    // process-lifetime `FORMS_SUBMIT_PROFILE` counter store (constructed once here, not
    // per-request) so its fixed-window counts persist across requests within one `createApp()`.
    formDefinitionRepo,
    formSubmissionRepo,
    removeFormSubmission: removeEntityWithoutBlocker(bindRemoveEntity(trash, "form_submission")),
    formsRateLimiter: createRateLimiter({ profile: FORMS_SUBMIT_PROFILE, clock }),
    // SPEC-046 REQ-7 — same one-process-lifetime-counter-store shape as `formsRateLimiter` above,
    // matching `server/deps.ts`'s real composition's identical construction.
    siteAssistantRateLimiter: createRateLimiter({ profile: SITE_ASSISTANT_PER_IP, clock }),
    // ADR-041 §1/§2 (Database Timeline): in-memory ledger, same disclosed precedent as every other
    // feature's hermetic test/dev composition above. `server/deps.ts`'s real composition opens
    // the sidecar `ops/database-journal.db` and uses `SqliteDatabaseLedgerRepo` instead.
    databaseLedgerRepo: new InMemoryDatabaseLedgerRepo(),
    migrationRunsRepo: new InMemoryMigrationRunsRepo(),
    // Admin-UI backend-gap closure (design-spec.md §0.4, this dispatch): in-memory adapters for
    // content-types/entries plus the restore-points/dbOps/site-status/recovery seams the
    // Database/Recovery screens' remaining read routes need.
    contentTypeRepo,
    contentTypeIndexProvisioner,
    entryRepo,
    taxonomyRepo,
    termRepo,
    entryTermRepo,
    taxonomyRevisionRepo,
    stampWatermark: noopStampWatermark,
    restorePointsRepo,
    dbOps: new InMemoryDbOpsAdapter(),
    databaseIntrospection: new InMemoryDatabaseIntrospectionAdapter(),
    // This hermetic root has no real `content.db` of its own (see file header: "in-memory adapters
    // seeded from `./seed`"), so its tool-attempt audit sink is the in-memory half of the same
    // rule-of-two split every adapter above follows — see `RouteDeps.toolAttemptAuditSink`'s own doc
    // for why the root constructs this rather than handing a module a path to open for itself.
    toolAttemptAuditSink: createInMemoryToolAttemptAuditSink(),
    siteStatusRepo: new InMemorySiteStatusRepo(),
    disclosureWatermarkSource: new AlwaysUnavailableWatermarkSource(),
    deepLinkRestorePointLookup: new RestorePointDeepLinkLookup(restorePointsRepo),
    // SPEC-016 (`core/gated-mutations`'s gateway, ADR-041 §5) — same composition `server/deps.ts`
    // wires for the real server, mirrored here for the hermetic test/dev composition (its own
    // `InMemoryTokenStore` instance — see `core/gated-mutations/composition.ts`'s file header for
    // the disclosed `TokenStorePort` decision). `authorizeInstance` mirrors `server/deps.ts`'s own
    // owner-only instance-scope binding (`GatewayDeps.authorizeInstance`'s doc comment).
    gatedMutations: {
      gatewayDeps: buildGatewayDeps({
        clock,
        idGen,
        authorize: identity.authorize,
        authorizeInstance: buildOwnerOnlyInstanceAuthorize({ ownerPrincipalId: identity.ownerPrincipalId }),
      }),
    },
    commentRepo: commentsModule.commentRepo,
    commentIngressPolicy: commentsModule.ingressPolicy,
    commentWriteService: commentsModule.writeService,
    // In-memory repo needs no dataModule declare — resolves immediately, unlike `deps.ts`'s real
    // fire-and-forget install (mirrors `newsletterReady`'s identical hermetic-vs-real split).
    commentsReady: Promise.resolve(),
    commentsSettingsReady,
    widgetBindingRepo,
    entryRefsRepo,
    // SPEC-005 BR-01/BR-05 — the same in-memory runtime instance backs the enable route and every
    // content save in this hermetic composition.
    pluginActivationRepo,
    discoverPlugins: pluginRuntime.discoverPlugins,
    onPluginEnabled: pluginRuntime.onPluginEnabled,
    onPluginDisabled: pluginRuntime.onPluginDisabled,
    removePlugin,
    readPluginPackageFiles: pluginRuntime.readPluginPackageFiles,
    pluginBeforeSaveHook: pluginRuntime.beforeSaveHook,
    // In-memory activationRepo starts empty every test run, so there is nothing to re-attach —
    // mirrors `commentsReady`'s identical hermetic-vs-real split.
    pluginRuntimeReady: Promise.resolve(),
    // 2026-08-15 — hermetic double for `server/deps.ts`'s real `SqliteDeploymentsReadRepo`. Empty
    // by default; a test that needs seeded rows constructs its own `InMemoryDeploymentsReadRepo`
    // and overrides this field, the same way other tests override a single `createRouteDeps()`
    // field rather than this composition root taking on fixture-authoring for every case.
    deploymentsReadRepo: new InMemoryDeploymentsReadRepo(),
    // Task 6 of the publish-content (Publish Content) feature — hermetic double for
    // `server/runtime/composition/deps.ts`'s real `SqlitePublishContentBundleRepo`. Hoisted above
    // (not constructed inline) so Task 8's `publishContentApplyPort` reads the SAME store. See
    // `routes/types.ts`'s `publishContentBundleRepo` doc.
    publishContentBundleRepo,
    // `publish-files-plan-2026-09-24.md` §3 — hoisted above so it is the SAME instance a `pack()`
    // fills and a route reads. See `routes/types.ts`'s `fileBlobIndex` doc.
    fileBlobIndex,
    // Task 7 — hermetic double for `server/runtime/composition/deps.ts`'s real
    // `SqlitePublishContentBaselineRepo`. Hoisted above for the same reason. See
    // `routes/types.ts`'s `publishContentBaselineRepo` doc.
    publishContentBaselineRepo,
    // Task 8 — the real apply loop (`apply-loop.ts`). See `routes/types.ts`'s
    // `publishContentApplyPort` doc.
    publishContentApplyPort,
    publishContentSeedHash,
    // Task 8 — the apply loop's audit trail. See `routes/types.ts`'s `publishContentRunRepo` doc.
    publishContentRunRepo,
    // Task 10 — peers + the guarded outbound client that dials them. The client is built from
    // `createPublishContentPeerEgressPolicy()` with the same operator-set `devHostAllowlist` the
    // SQLite root reads, so a hermetic app is not accidentally more permissive than a real one.
    publishContentPeerRepo,
    publishContentPeerHttpClient: createDefaultHttpClient(
      createPublishContentPeerEgressPolicy(parsePublishContentDevHosts(process.env.TOVU_PUBLISH_CONTENT_DEV_HOSTS))
    ),
    // 2026-08-15 — the real export engine, bound here rather than imported inside
    // `features/deployments/export-run.ts`/`export-site.ts` — see `routes/types.ts`'s
    // `runExportSite` doc for why that indirection is required, not stylistic. NOT resolved lazily
    // any more; see {@link runExportSite} (the local const below, shadowing this field's own name)
    // for why a plain static import replaced the `require()` this used to carry.
    runExportSite,
    // Read ONCE here rather than deep in `export-run.ts`/`cli/commands/export.ts` — see
    // `server/deps.ts`'s `resolveExportOutputRootDir` doc and `routes/types.ts`'s
    // `exportOutputRootDir` doc.
    exportOutputRootDir: resolveExportOutputRootDir(),
    // Read ONCE here — see `routes/types.ts`'s `adminAssistantEnabled` doc. This module's own
    // mount-gating code below reads THIS field rather than calling `isAdminAssistantEnabled()` a
    // second time, so the value never disagrees with which admin-assistant routes are actually live.
    adminAssistantEnabled: isAdminAssistantEnabled(),
    // 2026-08-16 — see `routes/types.ts`'s `createSiteApp` doc: the direct reference this file can
    // take (createApp is declared in this same module) closing `export -> server` for the in-memory
    // composition root. `server/deps.ts`'s SQLite composition root needs the lazy-`require`d
    // equivalent instead, since it cannot take a same-file reference.
    //
    // 2026-08-20 (RouteDeps-narrowing pass 2) — now NULLARY, closed over the `const routeDeps`
    // binding below rather than taking it per call. Same self-referencing-closure shape
    // `exportSiteBound` below already uses (safe for the identical reason: this arrow only runs
    // after `createRouteDeps()` has returned, by which point `routeDeps` is fully constructed) — see
    // `routes/types.ts`'s `exportSiteBound` doc, now generalized, for the TEST GOTCHA this closure
    // shape carries (spread-override is silently inert; mutate the object in place instead).
    createSiteApp: () => createApp(routeDeps),
    // 2026-08-16 — see `routes/types.ts`'s `resolveStorefrontProducts` doc (edge 2 of the
    // export<->server decoupling): a direct reference, same reasoning as `createSiteApp` above
    // (`resolveStorefrontProducts` is declared in `./routes/site/products`, already imported by
    // this file to register the real product routes).
    //
    // 2026-08-20 (RouteDeps-narrowing pass 2) — same nullary-closure conversion as `createSiteApp`
    // immediately above, same reasoning, same TEST GOTCHA.
    resolveStorefrontProducts: () => resolveStorefrontProducts(routeDeps),
    // 2026-09-03 — see `routes/types.ts`'s `resolveActiveThemeId`/`listPublishedPosts` docs: closes
    // the `platform <-> features/presentation`/`platform <-> features/post` module cycles
    // `check:architecture` flagged (`platform/export/route-manifest.ts` no longer imports either
    // function directly). Same nullary-closure-over-`routeDeps` shape as `resolveStorefrontProducts`
    // immediately above.
    resolveActiveThemeId: () => resolveActiveThemeId(routeDeps),
    listPublishedPosts: () =>
      listPublishedPosts({ deps: { repo: routeDeps.postRepo }, input: { workspaceId: routeDeps.workspaceId } }),
    // 2026-08-15 (Contract v2) — hermetic double for `server/deps.ts`'s real
    // `SqlitePublishCredentialSetRepo`; see `routes/types.ts`'s `publishCredentialSetRepo`/
    // `publishExecutionMode` docs. `executionModeFromEnv()` (not a hardcoded `"self-hosted-cli"`) so
    // a test can still exercise `TOVU_EXECUTION_MODE=hosted-api-only` against this hermetic root.
    publishCredentialSetRepo: new InMemoryPublishCredentialSetRepo(),
    // 2026-08-16 rework — hermetic double for `server/deps.ts`'s real `SqlitePublishHistoryStore`;
    // see `routes/types.ts`'s `publishHistoryStore` doc.
    publishHistoryStore: new InMemoryPublishHistoryStore(),
    publishExecutionMode: executionModeFromEnv(),
    // Read ONCE here rather than deep in `static-publish/adapter.ts` — see `server/deps.ts`'s
    // `resolvePublishOutputRootDir` doc and `routes/types.ts`'s `publishOutputRootDir` doc.
    publishOutputRootDir: resolvePublishOutputRootDir(),
    // 2026-08-16 — hermetic double for `server/deps.ts`'s real (also in-memory — see
    // `routes/types.ts`'s `publishCredentialVerificationCache` doc for why this cache is
    // deliberately never DB-backed) instance.
    publishCredentialVerificationCache: new InMemoryPublishCredentialVerificationCache(),
    // 2026-08-15 — hermetic double for `server/deps.ts`'s real
    // `SqliteSourceControlCredentialSetRepo`; see `routes/types.ts`'s
    // `sourceControlCredentialSetRepo` doc.
    sourceControlCredentialSetRepo: new InMemorySourceControlCredentialSetRepo(),
    // Read ONCE here rather than deep in `source-control/commit-site.ts` — see `server/deps.ts`'s
    // `resolveSourceControlExportRootDir` doc and `routes/types.ts`'s `sourceControlExportRootDir`
    // doc.
    sourceControlExportRootDir: resolveSourceControlExportRootDir(),
    // 2026-08-16 (Phase 3) — hermetic double for `server/deps.ts`'s real
    // `SqliteVendorCredentialSetRepo`; see `routes/types.ts`'s `vendorCredentialSetRepo` doc.
    vendorCredentialSetRepo: new InMemoryVendorCredentialSetRepo(),
    // 2026-08-17 — hermetic double for `server/deps.ts`'s real `SqliteCustomCredentialSetRepo`; see
    // `routes/types.ts`'s `customCredentialSetRepo` doc.
    customCredentialSetRepo: new InMemoryCustomCredentialSetRepo(),
    // `features/custom-credentials`'s two agent tools need a guarded `HttpClientPort` — see
    // `routes/types.ts`'s `customCredentialsHttpClient` doc. `createDefaultHttpClient` performs no
    // I/O until a request is actually sent, so building a real one here (rather than a fake) keeps
    // this hermetic composition root's own tests exercising the real SSRF-guard/host-binding path.
    // `CUSTOM_CREDENTIALS_EGRESS_POLICY`: the SAME policy `server/deps.ts` uses for its own instance
    // (2026-09-10) — see that export's own doc for why this domain needed to follow a GET redirect
    // (GitHub's Actions job-logs endpoint 302s to a signed Azure Blob URL) and could no longer share
    // the mailer's zero-redirect `SINGLE_HOP_HTTPS_EGRESS_POLICY`.
    customCredentialsHttpClient: createDefaultHttpClient(CUSTOM_CREDENTIALS_EGRESS_POLICY),
    // 2026-09-06 — `features/media-import`'s `media_import_from_url`. Same reasoning as the line
    // above (a real guarded client, not a fake, so this hermetic composition root's own tests
    // exercise the real SSRF guard), built from `MEDIA_IMPORT_EGRESS_POLICY` instead — see
    // `routes/types.ts`'s `mediaImportHttpClient` doc for why the two policies cannot be shared.
    mediaImportHttpClient: createDefaultHttpClient(MEDIA_IMPORT_EGRESS_POLICY),
    // 2026-08-20 (RouteDeps-narrowing fix) — see `routes/types.ts`'s `exportSiteBound` doc. `routeDeps`
    // spread LAST: this self-referencing closure captures the `const routeDeps` binding below (safe —
    // the arrow body only runs after `createRouteDeps()` has returned, by which point `routeDeps` is
    // fully constructed), and it must always win over whatever `opts` a caller passes, even if that
    // `opts` happens to carry its own `routeDeps` key (see `routes/types.ts`'s own doc on this field
    // for the exact bug this ordering closes).
    // 2026-09-05 (fix-cycle) — plain static reference now; see `runExportSite`'s doc below for why
    // the lazy `require()` this used to carry is gone.
    exportSiteBound: (opts) => exportSite({ ...opts, routeDeps }),
  };
  return routeDeps;
}

/**
 * `exportSite`, now a plain static reference — until 2026-09-05 this was resolved at CALL time via a
 * lazy `require()`, to break a cycle that no longer exists.
 *
 * THE CYCLE THIS USED TO BREAK, AND WHY IT'S GONE. The original justification (2026-08-15, this
 * doc's own prior text): `platform/export/site-exporter.ts` imported `createApp` from THIS file, so
 * a static `import { exportSite } from "#src/platform/export/index"` here would have closed
 *
 *     server/app.ts -> export/index.ts -> export/site-exporter.ts -> server/app.ts
 *
 * and the daemon (`server/inbound/assistant/agent-daemon-server.ts`, which imports this file for
 * `createRouteDeps`) crashed on every boot with `TypeError: Cannot read properties of undefined
 * (reading 'createInMemoryChatStoreFactory')` when that edge closed eagerly. That back-edge was
 * removed for real on 2026-08-16 (generalized 2026-08-20, "RouteDeps-narrowing pass 2"):
 * `site-exporter.ts` no longer imports `server/app.ts` at all, static OR lazy — it boots the app via
 * `options.routeDeps.createSiteApp()`, injected through `RouteDeps` (see that file's own header
 * comment and `routes/types.ts`'s `createSiteApp` doc). This file's lazy `require()` for the
 * OPPOSITE direction (this file calling INTO `platform/export`) was never actually needed once that
 * injection landed — it just never got revisited, including across two path-rewrite commits
 * (`03cc71442`, `e031173e4`) that mechanically edited these very lines without re-checking the cycle
 * claim.
 *
 * VERIFIED 2026-09-05, not assumed: `platform/export`'s complete runtime closure (`ports.ts`,
 * `route-manifest.ts`, `site-exporter.ts`, `export-failure-summary.ts`, `index.ts`, and everything
 * THEY import — `features/theme`, `features/post`, `features/presentation`, `features/redirects`,
 * `platform/routing`, `contracts/core`) contains zero imports of this file or any `#src/server/**`
 * module — confirmed by direct source read of every file in that closure, a repo-wide grep for any
 * specifier reaching `runtime/composition/app`, and independently by `.dependency-cruiser.mjs`'s own
 * 2026-08-28 cross-validated (DFS + `no-circular` + madge) 5-SCC baseline, which names the real
 * `deps.ts`/`app.ts`/`deployment-overview.ts` cycle (deps.ts closed the same cycle via a static
 * import as of 2026-09-16, t91 F4.1-A — see that file's own doc) but does not include this edge. This file already statically
 * imports every one of those modules' own dependencies anyway (`#src/features/theme/index`,
 * `#src/features/post/index`, `#src/features/presentation/index`, `#src/features/redirects/index`,
 * `#src/platform/routing/index`, `#src/contracts/core/**` are all imported above), so this static
 * import adds `platform/export`'s own 5 files to this file's runtime closure and nothing else.
 *
 * Also fixes a real defect, not just cleanup: the lazy `require()` ran tsx's CJS loader over
 * `platform/export`'s whole barrel graph inside processes that had already loaded the same files
 * via tsx's ESM loader (any in-process test that calls `routeDeps.exportSiteBound`/`runExportSite`,
 * e.g. `commit-site.ts`, `static-publish/adapter.ts`), producing two V8 coverage images per file that
 * lcov merges into one corrupted `SF:` block — see
 * `ADS-memory/reports/2026-09-05-coverage-dual-instantiation-routes-W-and-A.md`'s "Route A".
 */
const runExportSite: ExportEngine<RouteDeps> = (options) => exportSite(options);

/**
 * 2026-08-20 (complexity pass) — `createApp` mounts ~30 `ServerModuleHandle`s below, each via the
 * identical `mod.registerRoutes?.(app)` guard (`registerRoutes` is optional per
 * `modules/types.ts`'s `ServerModuleHandle` doc: a module may own only subscriptions, only routes,
 * or both). ESLint's `complexity` rule counts every `?.` as its own branch, so 30 inlined copies of
 * the SAME guard cost `createApp` 30 points of complexity for zero actual decision-making — the
 * guard never varies. Hoisting it here means the branch is counted once, in this 2-line function,
 * instead of once per call site.
 */
function mountRoutes(app: Express, mod: ServerModuleHandle): void {
  mod.registerRoutes?.(app);
}

/** Same hoisted-guard rationale as {@link mountRoutes}, for the `start?.()` half of
 * `ServerModuleHandle` (a module's optional subscriptions/workers, started once at boot). */
function startModule(mod: ServerModuleHandle): void {
  mod.start?.();
}

/** Buses that already carry the handlers {@link subscribeSiteEventHandlersOnce} attaches. */
const busesWithSiteEventHandlers = new WeakSet<RouteDeps["bus"]>();

/**
 * Attaches the site's outbox event handlers to `routeDeps.bus`, once per bus (2026-09-14).
 *
 * `createApp` runs more than once on the same `routeDeps` in one process: the serving app first, then
 * `routeDeps.createSiteApp()` for every static export (`platform/export/site-exporter.ts`) and every
 * published-page fetch (`features/site-inspection/published-page.ts`). These subscriptions used to
 * sit inline in `createApp`, so each rebuild added another copy of every handler to the same bus and
 * one event then ran each handler once per build (a duplicate forms notify mail per export, for
 * one). Pinned by `server/__tests__/integration/create-app-event-subscriptions-once.integration.test.ts`.
 *
 * Keyed on the bus because the bus is what holds the handlers. The first build's handlers serve every
 * later build; they capture fields of `routeDeps`, which is the same object in every build.
 *
 * @param routeDeps the composed deps whose `bus` receives the handlers.
 * @complexity O(1): a fixed set of subscriptions.
 */
function subscribeSiteEventHandlersOnce(routeDeps: RouteDeps): void {
  if (busesWithSiteEventHandlers.has(routeDeps.bus)) return;
  busesWithSiteEventHandlers.add(routeDeps.bus);

  void routeDeps.bus.subscribe("workspace.created", async (event) => {
    // Demonstration side effect. Replace with indexers/webhooks/etc.
    console.log("event handled:", event.name, event.payload);
  });

  // SPEC-008 (ADR-PIPE-008 Decision §5, T038) — SEO subscribes to the 3 entry-lifecycle events
  // `post.ts`'s `updatePost()` now emits, invalidating that workspace's sitemap cache entry on
  // delivery (idempotent per ADR-009 — a duplicate delivery is a no-op, `invalidateSitemapCache`
  // is itself idempotent). Delivered by the serving process's background outbox drainer
  // (`serving-app.ts`) or by a route's own inline `processOutbox` call.
  const seoEventSubscriptions = createSeoEventSubscriptions();
  void routeDeps.bus.subscribe("entry.published", (event) => seoEventSubscriptions.onEntryPublished(event as never));
  void routeDeps.bus.subscribe("entry.updated", (event) => seoEventSubscriptions.onEntryUpdated(event as never));
  void routeDeps.bus.subscribe("entry.unpublished", (event) => seoEventSubscriptions.onEntryUnpublished(event as never));

  const newsletterAdminDeps = routeDeps as NewsletterRouteDeps;
  // T040 (tasks.md Phase 4) — the `newsletter.send.batch.claimed` bus subscriber `send-pipeline.ts`'s
  // own file header names as the one piece of Stage 4 wiring no composition root had done yet
  // (found while wiring Stage 5's `send-campaign.ts`, which is the only real caller of `claimBatch`/
  // `processOutbox` for this campaign). Mirrors the demonstration `bus.subscribe("workspace.created",
  // ...)` above. In practice this handler is never reached in either composition root today:
  // `authorizeSend`'s Launch Gate check always rejects before `freezeAudience` ever enqueues a batch,
  // because precondition (a) `isSendingEnabled` always resolves `false` (`routes/newsletter/deps.ts`'s
  // `toSendPipelineDeps`) and (b) both composition roots bind `membersConsentCapability: null`
  // (tasks.md's disclosed, by-design "Real Sending Is Inherently Blocked Today" flag). Precondition
  // (d) is no longer the blocker — Resend and SMTP adapters resolve (`boot/resolve-mailer.ts`),
  // corrected 2026-09-16. Wired now anyway so the pipeline is genuinely complete end to end the
  // moment (a) and (b) are met, not silently half-wired.
  void routeDeps.bus.subscribe<SendBatchJob>(SEND_BATCH_CLAIMED_EVENT, async (event) => {
    await handleSendBatchClaimed({ deps: toSendPipelineDeps(newsletterAdminDeps), job: event.payload });
  });

  /**
   * ADR-046 Phase 3 (SPEC-031) — SPEC-010 (Forms) outbox wiring, now split across two
   * feature-owned modules instead of two inline blocks: `forms` owns the C-009 notify
   * subscriber (its own business logic); `integrations` owns the webhook-fanout subscriber to
   * the SAME `form.submission.received` topic (cross-feature integration owned by the
   * consumer, per the ADR's explicit Phase 3 rule — see `modules/integrations.ts`'s header).
   */
  startModule(
    createFormsModule({
      bus: routeDeps.bus,
      mailer: routeDeps.mailer,
      formDefinitionRepo: routeDeps.formDefinitionRepo,
      formSubmissionRepo: routeDeps.formSubmissionRepo,
    })
  );
  startModule(
    createIntegrationsModule({
      bus: routeDeps.bus,
      webhookSubscriptionRepo: routeDeps.webhookSubscriptionRepo,
      webhookDeliveryRepo: routeDeps.webhookDeliveryRepo,
      idGen: routeDeps.idGen,
      clock: routeDeps.clock,
    })
  );
}

export function createApp(routeDeps: RouteDeps = createRouteDeps()) {
  // `page-head.ts`'s `contributors` registry is a process-wide singleton, but `createApp()` still
  // runs more than once per process: every test that calls it directly, and every
  // `routeDeps.createSiteApp()` the exporter and site-inspection make. Resetting here — before this
  // invocation registers its own SEO `page.head` hook below — keeps the registry scoped to
  // whichever `createApp()` call runs most recently, so a stale seeded hook can never keep folding
  // into a live request's `<head>` alongside the real one. See `resetPageHeadRegistry`'s own doc for
  // the full trace.
  //
  // This file used to end with an eager `export const app = createApp();`, removed 2026-09-16 (t91
  // F4.1): loading this module then replaced whatever redirects composition was already live (see
  // `routing.ts`'s `registerResolvePhase` doc and `redirects/phase-handler.ts`'s file header).
  resetPageHeadRegistry();
  const app = express();
  // X-Forwarded-For is trusted only for a known edge proxy's hops (Fly) or TOVU_TRUST_PROXY.
  applyTrustProxy(app);
  applyDevCors(app);
  // Registered as early as possible — ahead of the serving gate below and every route module — so
  // a request the gate rejects, or a 404 that matches no route at all, is still measured. See
  // `observability-middleware.ts`'s own file header for the full reasoning and for why this is the
  // single chokepoint that sees both `tovu serve` and `index.ts`'s boot paths (both call this exact
  // `createApp()` function; see `ADS-memory/.local-artifacts/metrics/
  // 2026-08-28-observability-groundwork.md` §1-2 for why that distinction matters here).
  applyRequestTracking(app, { observability: routeDeps.observability });
  // ADR-041/043/044/045 re-audit (2026-07-16, TM-adr041-043-044-045-audit-001, round-2, codex
  // finding R2-F2-BLOCK-NOT-ENFORCED) — must run before every other route/middleware so a
  // BLOCKED_PENDING_RECOVERY site refuses normal traffic regardless of which route would have
  // handled it. See site-serving-gate.ts's own header for the allowlist rationale.
  applySiteServingGate(app, { siteStatusRepo: routeDeps.siteStatusRepo, workspaceId: routeDeps.workspaceId });

  // MUST stay ahead of the blanket `express.json()` immediately below. Payment webhooks are
  // HMAC-signed over the exact received bytes, and the blanket parser destroys them — so this one
  // route registers its own `express.raw()` first and terminates the response before the JSON
  // parser layer is ever reached. See `routes/site/payments-webhook.ts`'s file header for why
  // registration order is the fix and why the API is resolved per request rather than captured
  // here. This is the only route in the app that inverts the parser/route registration order.
  registerPaymentsWebhookRoute(app, { resolveLipay: () => routeDeps.lipay ?? null });

  // Public routes parse JSON at a small limit here; session-gated paths are left unparsed and
  // parsed by `requireAdminSession` only once the caller has authenticated (15 MB, 75 MB for the
  // base64 upload routes). See `inbound/shared/json-body-parsers.ts` for the limits and why.
  app.use(parsePublicJsonBody);

  // Once per bus, not once per createApp call: see `subscribeSiteEventHandlersOnce`.
  subscribeSiteEventHandlersOnce(routeDeps);

  // SPEC-008 (ADR-PIPE-008 Decision §2/§3, T009) — SEO's `page.head` contributor, registered once
  // at boot into the core-owned `page-head.ts` registry (never imported directly by `render.ts`).
  registerPageHeadContributor(
    createSeoPageHeadHook({
      postRepo: routeDeps.postRepo,
      settingsRepo: routeDeps.settingsRepo,
      media: routeDeps,
      originRegistry: routeDeps.originRegistry,
    })
  );

  // ADR-046 Phase 3 (SPEC-039): the `core` server module — ops routes, then
  // login/logout/me (ungated), then the `/api/admin` session gate, all
  // registered together in that order so login is never caught by its own
  // gate. Real argon2id + principal/session model (ADR-021/SPEC-006) — see
  // inbound/admin-http/dev-auth.ts.
  mountRoutes(app, createCoreModule(routeDeps));

  // ADR-046 Phase 3 (SPEC-038): the `content` server module — 11 posts/pages/change-sets/
  // presentation admin routes. `registerContentPostGetRoute` (public site content serving) stays
  // inline immediately below — it was never one of this module's 11 registrations.
  mountRoutes(app, createContentModule(routeDeps));
  registerContentPostGetRoute(app, routeDeps);

  // Task 4 of the publish-content (Publish Content) feature (`ADS-memory/reports/
  // 2026-09-18-publish-feature-implementation-plan.md` §1.1/§4) — the export/pull route. This is
  // also where `installFirstPartyPublishContentTypes()` first gets a real caller (see
  // `publish-content-manifest.ts`'s own header and `modules/publish-content.ts`'s).
  mountRoutes(app, createPublishContentModule(routeDeps));

  // ADR-PIPE-013 Decision §2-3 (FEAT-013 Phase 2) — one shared
  // MAGIC_LINK_PER_EMAIL limiter instance consulted by BOTH the admin
  // request-magic-link route and the new public sign-in route (C-015: one
  // counter per email, not two). Per-boot-scoped, mirroring
  // `registerAuthRoutes`'s own `loginRateLimiter` construction.
  const magicLinkPerEmailLimiter = createRateLimiter({ profile: MAGIC_LINK_PER_EMAIL, clock: routeDeps.clock });
  const magicLinkPerIpLimiter = createRateLimiter({ profile: MAGIC_LINK_PER_IP, clock: routeDeps.clock });
  const magicLinkCompleteAttemptLimiter = createRateLimiter({ profile: MAGIC_LINK_COMPLETE_ATTEMPT, clock: routeDeps.clock });
  const membersDeps: MembersRouteDeps = { ...routeDeps, magicLinkPerEmailLimiter };

  // NEW public (non-admin) member route family (ADR-PIPE-013 Decision §2-3) —
  // mounted OUTSIDE /api/admin's `requireAdminSession` middleware (this
  // family is unauthenticated by design), alongside the existing
  // `registerContentPostGetRoute`-style public mount above. Boot-time repo
  // adapters remain in-memory (Decision §5) — unchanged by this wiring.
  const memberPublicDeps: MemberPublicRouteDeps = {
    workspaceId: routeDeps.workspaceId,
    memberRepo: routeDeps.memberRepo,
    memberTierRepo: routeDeps.memberTierRepo,
    memberSubscriptionRepo: routeDeps.memberSubscriptionRepo,
    memberSessionRepo: routeDeps.memberSessionRepo,
    magicLinkRepo: routeDeps.magicLinkRepo,
    mailer: routeDeps.mailer,
    clock: routeDeps.clock,
    idGen: routeDeps.idGen,
    magicLinkPerEmailLimiter,
    magicLinkPerIpLimiter,
    magicLinkCompleteAttemptLimiter,
  };
  // ADR-046 Phase 3 (SPEC-038): the `members` server module — 4 admin CRUD/list routes + 2 public
  // sign-in routes, genuinely two deps objects (see `modules/members.ts`'s file header).
  mountRoutes(app, createMembersModule({ admin: membersDeps, public: memberPublicDeps }));

  // SPEC-011 (Newsletter, ADR-PIPE-011) Stage 5 — the `newsletter` server module: 19 admin routes
  // (inside the `/api/admin` gate mounted by `createCoreModule` above) + 2 public, cookie-less,
  // token-only routes (`newsletter-confirm.ts`/`newsletter-unsubscribe.ts`), genuinely two deps
  // objects, same rationale as `members` immediately above (see `modules/newsletter.ts`'s header).
  // `routeDeps` is cast to `NewsletterRouteDeps` here (not widened) — mirrors every admin
  // newsletter route file's own `routeDeps as NewsletterRouteDeps` cast (`routes/admin/newsletter/
  // deps.ts`'s file header); `createRouteDeps()`'s actual return type already IS
  // `NewsletterRouteDeps`, this parameter's own `RouteDeps` annotation is just narrower.
  const newsletterAdminDeps = routeDeps as NewsletterRouteDeps;
  const newsletterPublicDeps: NewsletterPublicRouteDeps = {
    workspaceId: newsletterAdminDeps.workspaceId,
    newsletterReady: newsletterAdminDeps.newsletterReady,
    newsletterConfirmationTokenRepo: newsletterAdminDeps.newsletterConfirmationTokenRepo,
    newsletterSubscriptionRepo: newsletterAdminDeps.newsletterSubscriptionRepo,
    newsletterKeyring: newsletterAdminDeps.newsletterKeyring,
    mailer: newsletterAdminDeps.mailer,
    membersConsentCapability: newsletterAdminDeps.membersConsentCapability,
    originRegistry: newsletterAdminDeps.originRegistry,
    clock: newsletterAdminDeps.clock,
    idGen: newsletterAdminDeps.idGen,
  };
  mountRoutes(app, createNewsletterModule({ admin: newsletterAdminDeps, public: newsletterPublicDeps }));

  // ADR-046 Phase 3 (SPEC-041): the `analytics` server module — the single admin "recent hits"
  // read route (ADR-035/ADR-PIPE-014).
  mountRoutes(app, createAnalyticsModule(routeDeps));
  // ADR-001 bounded operational read: provider discovery reflects only the optional composed
  // payment runtime; configuration and downstream Commerce capabilities remain explicitly absent.
  mountRoutes(app, createCommerceModule(routeDeps));
  // ADR-054: the PUBLIC visitor assistant. Deliberately NOT behind `requireAdminSession` — it is
  // the one assistant surface anonymous traffic may reach, which is why it runs on its own
  // in-process provider relay with a read-only published-content tool surface rather than the
  // admin's process-spawning agent daemon. `start()` logs the demo-gate state at boot.
  const siteAssistantModule = createSiteAssistantModule(routeDeps);
  startModule(siteAssistantModule);
  mountRoutes(app, siteAssistantModule);
  registerAdminModuleStatusRoute(app, routeDeps);
  // Observability admin page, Overview tab (`development/todos.md` 2026-09-09 owner ask) — same
  // `system.read`-gated shape as the module-status route just above.
  registerAdminObservabilityStatusRoute(app, routeDeps);
  // Whether outbound mail really sends (not the console fallback) — the form editor greys out its
  // notification settings when it does not.
  registerAdminMailStatusRoute(app, routeDeps);
  // Admin "Restart assistant" action (`system.write`-gated) — the manual recovery seam for the
  // locally-spawned agent daemon, sibling to the on-demand recovery `server/modules/assistant.ts`'s
  // daemon-proxy code now triggers automatically on a known-failed request. See that route file's
  // own header for why its response never claims the daemon is healthy again.
  registerAdminAssistantDaemonRoutes(app, routeDeps);
  // Admin Deployment panel (Overview + Dockerfile tabs) — same `system.read`-gated shape as the
  // module-status route just above; see each route file's own header for why they share it.
  registerAdminDeploymentOverviewRoute(app, routeDeps);
  registerAdminDockerfileSourceRoute(app, routeDeps);
  // Admin "Sites" screen (2026-09-04 sites-switcher decision) — list/create/activate the sites
  // under `sites/<name>/`. `system.read`/`system.write`-gated, same shape as the routes just
  // above; Create/Activate additionally refuse when `TOVU_ENABLE_SITE_SWITCHER` is off (default),
  // which List does not — see that route file's own header for the full split.
  registerAdminSitesRoutes(app, routeDeps);
  // The admin frontend's door to `buildSiteProfile()` — the SAME function the `site_get_profile`
  // agent tool calls, because `apps/admin` is a browser bundle and cannot invoke an agent tool.
  // Deliberately NOT gated by one `authorize()` call here: it authorizes each section against that
  // section's own domain permission. See that route file's header for why that difference matters.
  registerAdminSiteProfileRoute(app, routeDeps);
  // Deployment panel → Static Site tab: trigger + poll the static exporter (`src/platform/export/`).
  // `system.export`-gated for the trigger (a disk write), `system.read` for the status poll — see
  // that file's own header for the split.
  registerAdminExportSiteRoutes(app, routeDeps);
  // Deployment panel → publish-to-GitHub-Pages/Vercel: trigger + poll a one-shot static publish
  // (`features/deployments/static-publish/`, wrapping `@jini-ai/devops/deploy`). `system.publish`-
  // gated for BOTH the trigger and the status poll — see that route file's own header for why.
  registerAdminPublishSiteRoutes(app, routeDeps);
  // Deployment panel → Static Site tab's credential form: CRUD over saved provider connections
  // (`publish_credential_sets`). `system.publish`-gated on every verb — see that route file's own
  // header for why this doesn't split trigger/read the way `publish-site.ts` does.
  registerAdminPublishCredentialsRoutes(app, routeDeps);
  // Admin Source Control page: CRUD over saved GitHub/GitLab/Bitbucket identity connections
  // (`source_control_credential_sets`). `source-control.credentials.write`-gated on every verb —
  // see that route file's own header for why this is NOT `system.publish`.
  registerAdminSourceControlCredentialsRoutes(app, routeDeps);
  // Access Tokens page's "Add custom provider" form: CRUD over saved user-defined provider
  // connections (`custom_credential_sets`). `custom-credentials.write`-gated on every verb.
  registerAdminCustomCredentialsRoutes(app, routeDeps);
  // Phase 3: CRUD over the unified `vendor_credential_sets` table (`features/vendor-credentials/`) —
  // the eventual replacement for BOTH credential routes just above, once every install's data is
  // confirmed migrated. `vendor-credentials.write`-gated on every verb, deliberately its own
  // permission — see that route file's own header for why neither `system.publish` nor
  // `source-control.credentials.write` fits a table that now serves both domains.
  registerAdminVendorCredentialsRoutes(app, routeDeps);
  // Security panel → Site Token tab: view/generate the TOVU_INTEGRATIONS_ROOT_KEY root key's
  // generated-file fallback. `admin.security.tokens.manage`-gated on both verbs — see that route
  // file's own header for exactly what this does and does not cover (since 2026-09-09 it seals
  // every stored credential and can satisfy a production boot, but webhook signing / newsletter
  // tokens still need the env var).
  registerAdminSiteTokenRoutes(app, routeDeps);
  // Chat composer's folder control: GET/PUT/DELETE the fs-files `custom` root — the operator-set
  // folder `fs_list_files`/`fs_read_file` may reach outside `repo`/`site`. `content.read`-gated, the
  // same permission that gates those two tools themselves — see that route file's own header.
  registerAdminFsFilesCustomRootRoutes(app, routeDeps);
  // Deployment panel → Full Site tab: read-only snapshot of the deployments domain
  // (`features/deployments/`). `deployments.read`-gated, not `system.read` — see that route
  // file's own header for why this one gets its own permission.
  registerAdminDeploymentsListRoute(app, routeDeps);
  // ADR-046 Phase 3 (SPEC-040): the `comments-moderation` server module — 4 admin
  // moderation-queue/moderate/settings routes. Distinct from `createCommentsModule` above
  // (the ADR-031 backend composition) and from `registerCommentsSubmitRoute` below (the public,
  // unauthenticated submission route, which stays inline near the site catch-all).
  mountRoutes(app, createCommentsModerationModule(routeDeps));
  // ADR-046 Phase 3 (SPEC-040): the `menus` server module — 6 admin CRUD/location-assignment
  // routes (ADR-029). `MenuRouteDeps` reused as-is from its existing location in
  // `http/admin/menus.ts` (see `modules/menus.ts`'s file header for why it lives there).
  mountRoutes(app, createMenusModule(routeDeps));
  // SPEC-043 (widgets, ADR-047) — 13 admin routes (instance CRUD, region binding/placement,
  // server-side embed mutation) + the widgets.place/create/remove/diagnose AI tool surface.
  // `RouteDeps` already carries every dependency this module needs (`widgetBindingRepo`/
  // `entryRefsRepo`, added by this same dispatch) — no widened deps type, unlike menus.
  mountRoutes(app, createWidgetsModule(routeDeps));
  // SPEC-005 (ADR-005-ARCH) — the `plugins` server module: PLUGINS_LIST/PLUGIN_SET_ENABLED (REQ-10).
  mountRoutes(app, createPluginsModule(routeDeps));
  // 2026-09-09 — the `agent-plugins` server module: AGENT_PLUGINS_LIST, the admin Agent Plugins
  // screen's read of real installed Agent Plugins (a SEPARATE family from the `plugins` module
  // above — see `modules/agent-plugins.ts`'s own header).
  mountRoutes(app, createAgentPluginsModule(routeDeps));
  // skills-composer-typeahead (implementation-outline.md, C-001/C-003) — the `skills` server
  // module: GET .../skills, the browser-reachable enumeration of installed standalone Agent Skills.
  mountRoutes(app, createSkillsModule(routeDeps));
  // ADR-046 Phase 3 (SPEC-034): the `integrations-admin` server module — 5 admin CRUD/read routes
  // over webhook subscriptions/deliveries (ADR-036). Distinct from `createIntegrationsModule`
  // below, which owns the Forms-to-webhook fan-out subscriber, not an HTTP surface.
  mountRoutes(app, createIntegrationsAdminModule(routeDeps));
  // ADR-046 Phase 3 (SPEC-034): the `media` server module — 5 admin routes + the public rendition
  // route (previously registered much later, see below near the old catch-all-precedence group;
  // moved up here since its only real constraint, "before `/:slug`", still holds — see
  // `modules/media.ts`'s file header for the full disclosure).
  mountRoutes(app, createMediaModule(routeDeps));
  // The local admin Trash screen's 3 routes (design:
  // `ADS-memory/reports/2026-09-20-trash-delete-architecture.md`). Registered next to `media`
  // because Media is one of the four kinds it lists, but it is a platform surface, not a media one:
  // it spans Posts, Comments, Media and Redirects. No ordering constraint — every path is under
  // `/api/admin/v1/workspaces/:workspaceId/trash` and none is a catch-all.
  //
  // `authorize` is overridden (ONLY for this module's own deps, never `routeDeps.authorize` itself,
  // which every other route reads unchanged) so restore/purge of a trashed USER also honor the
  // built-in `admin` role, not just the owner `TRASH_PERMISSION_BY_ENTITY_TYPE.get("user") === "*"`
  // alone (OWNER DECISION 2026-09-24, delete-user plan v2 Slice 3's "Open gap") — see
  // `trash-user-admin-override.ts`'s file header for why the override lives here and not in
  // `permissions.ts`/`mayActOnEntityType`, which are shared by every other trashable kind.
  mountRoutes(
    app,
    createTrashModule({
      ...routeDeps,
      authorize: withUserTrashAdminOverride({
        base: routeDeps.authorize,
        identity: identityServiceDepsFrom(routeDeps),
        workspaceId: routeDeps.workspaceId,
      }),
    })
  );
  // The `connectors` server module — Composio-backed third-party accounts behind the admin's
  // Settings → Connectors tab. Registered next to `integrations-admin` above because the two share
  // the `admin.integrations.manage` permission, but they own different subsystems (outbound
  // webhooks there, inbound third-party accounts here) — see `modules/connectors.ts`.
  mountRoutes(app, createConnectorsModule(routeDeps));
  mountRoutes(app, createExternalMcpModule(routeDeps));
  // ADR-046 Phase 3 (SPEC-040): the `users` server module — 8 admin CRUD/list routes over
  // users/roles/policies (ADR-021/SPEC-006 identity RBAC).
  mountRoutes(app, createUsersModule(routeDeps));
  // SPEC-006 REQ-08: the `api-keys` server module — the 3 api-key admin routes. Registered next to
  // `users` because both are the ADR-021/SPEC-006 identity surface, but kept a separate module —
  // see `modules/api-keys.ts` for why. Must sit after `createCoreModule` above, which mounts the
  // `/api/admin` session gate these three routes rely on for both auth and credential-kind.
  mountRoutes(app, createApiKeysModule(routeDeps));
  // SPEC-044: the `workspace` server module — 5 admin routes (list/create/get/update/delete), the
  // real successor to the original unauthenticated inline `POST /workspaces` route this file used
  // to own directly (see the file header note).
  mountRoutes(app, createWorkspaceModule(routeDeps));
  // ADR-046 Phase 3 (SPEC-040): the `settings` server module — 5 admin settings HTTP routes
  // (SPEC-007 Phase 5, T043).
  mountRoutes(app, createSettingsModule(routeDeps));

  // ADR-046 Phase 3 (SPEC-041): the `forms-admin` server module — 7 admin routes (definitions
  // CRUD + submissions list/get/delete), gated per api.spec.md §2's `admin.forms.*` profiles.
  // Distinct from `createFormsModule` below, which owns the Forms-to-notify-subscriber
  // subscription, not an HTTP surface.
  mountRoutes(app, createFormsAdminModule(routeDeps));

  // ADR-046 Phase 3 (SPEC-041): the `redirects` server module — 7 admin routes (list/get/create/
  // update/tombstone/import/hits), each gated by `admin.redirects.manage` (api.spec.md §1/§2).
  mountRoutes(app, createRedirectsModule(routeDeps));

  // ADR-046 Phase 3 (SPEC-042, final slice): the `database-recovery` server module — all 7
  // Database/Recovery plain registrations (Timeline + restore-points list/create, Recovery's own
  // restore-points list, disclosure, deep-link, status). Consolidates what used to be two
  // non-contiguous inline blocks (this one, plus a second block after `createTaxonomyModule`
  // below) into one call site — see `modules/database-recovery.ts`'s file header for the full
  // disclosure of why that consolidation is safe (no path overlap with content-types/entries/
  // taxonomy). `registerAdminDatabaseMigrateForwardRoutes`/`registerAdminRecoveryRestoreRoutes`
  // (the 2 gated-mutation ceremonies) stay inline below, unchanged non-goal since SPEC-031.
  mountRoutes(app, createDatabaseRecoveryModule(routeDeps));

  // Built ONCE, by calling `createAssistantByokModule` here (rather than at its original position
  // below) so its returned `.toolSurface` can be handed to `createAssistantModule` immediately after
  // — never folded into `routeDeps` (that bag already carries 53 back-edges into this file, a
  // tracked architectural metric; see `npm run check:architecture`). Deliberately NOT
  // `createByokToolSurface(routeDeps)` called directly here: that would add a new edge from this
  // file straight to `byok-tool-surface.ts`, and measuring with `check:architecture` showed that one
  // edge alone regresses the "core size" metric (it flips ~17 files into the core classification,
  // both fan-in and fan-out above the graph median) — this file already transitively reaches that
  // module THROUGH `createAssistantByokModule`, so reading the value off its return object is free.
  // See `AssistantByokModuleHandle`'s own doc for the full trace.
  const byokAssistantModule = createAssistantByokModule(routeDeps);

  // Roster-change fan-out (S6, 2026-09-24): this web-server process holds two federation runtimes
  // — the agent daemon (a separate process, reached over HTTP) and BYOK's own in-process
  // `FederationRuntime` on `byokAssistantModule.toolSurface.federation` — and `put.ts`/
  // `oauth-callback.ts`/`features/external-mcp/tool-registrations.ts` must reload both, not just the
  // one this file used to reach directly. See `external-mcp-roster-change.ts`'s own header. `"byok"`
  // is a no-op when BYOK has no federated connections configured (`federation` is `undefined` in that
  // case — same optionality `byok-tool-surface.ts` documents on that field).
  onExternalMcpRosterChanged("agent-daemon", () => triggerFederationReload());
  onExternalMcpRosterChanged("byok", () => byokAssistantModule.toolSurface.federation?.reload());

  // `TOVU_ADMIN_ASSISTANT=off` — a real disable: the four admin-assistant route modules below are
  // never mounted, matching ADR-054's visitor-assistant posture (no endpoint, not a hidden widget).
  // `createAssistantSettingsModule`/`createAssistantExecutionModule` stay mounted unconditionally —
  // the first is the PUBLIC assistant's master switch (a different product), and the second is the
  // settings tab that would have to render the off state. See `admin-assistant-enabled.ts`.
  //
  // Reads `routeDeps.adminAssistantEnabled` (computed once in `createRouteDeps()`/`createSqliteRouteDeps()`)
  // rather than calling `isAdminAssistantEnabled()` again here — see `routes/types.ts`'s
  // `adminAssistantEnabled` field doc: the admin SPA's `GET .../assistant/settings` response threads
  // the SAME field, so a second, separate read here could never end up disagreeing with what that
  // response reports.
  const adminAssistantEnabled = routeDeps.adminAssistantEnabled;

  // ADR-049: the admin assistant's tool-execution/run surface, composed from the published
  // `@jini-ai/core` + `@jini-ai/daemon` + `@jini-ai/node-host` kernel — see `src/assistant/`.
  if (adminAssistantEnabled) mountRoutes(app, createAssistantModule(routeDeps, byokAssistantModule.toolSurface.surfaceExchanges));

  // Durable transcripts for that same assistant, in `content.db` rather than the daemon. Separate
  // module because nothing here is proxied: run execution belongs to the daemon (that is where run
  // state lives), while history belongs to Tovu's own database, where backups, snapshots, and
  // workspace scoping already work. The daemon can restart or be replaced without touching it.
  if (adminAssistantEnabled) mountRoutes(app, createAssistantChatsModule(routeDeps));

  // The AI Assistant admin section's 2 settings routes (GET/PUT the public assistant's master
  // switch). Registered next to `createAssistantModule` for readability only — the two modules share
  // no dependencies and no path prefix (see `modules/assistant-settings.ts`'s header), and both sit
  // inside the `/api/admin` session gate, so this position is not load-bearing.
  mountRoutes(app, createAssistantSettingsModule(routeDeps));
  // The same admin section's "Execution mode" tab — Local CLI detection + BYOK connection
  // test/model discovery. Separate module from the settings pair above for the reason
  // `modules/assistant-execution.ts`'s header gives (stateless egress probes, not settings CRUD).
  mountRoutes(app, createAssistantExecutionModule(routeDeps));
  // 2026-08-04: the admin dock's "API · BYOK" execution mode — a second, provider-direct run path
  // alongside `createAssistantModule`'s daemon proxy above. Composes its own registry/executor over
  // the SAME `buildAssistantToolRegistrations` catalog the daemon uses (see `modules/assistant-byok.ts`'s
  // header for the full trace and disclosed gaps). Reuses this SAME `routeDeps` — the whole reason
  // this can be a second, independent composition rather than a daemon-process change. Routes only —
  // the module itself (and its `toolSurface`) was already built above, so
  // `createAssistantModule`'s redemption proxy shares the exact same confirmation store.
  if (adminAssistantEnabled) mountRoutes(app, byokAssistantModule);

  // ADR-059 (2026-08-18): the admin assistant's AG-UI canary transport — additive, flagged,
  // deletable. Wraps the SAME daemon-backed run lifecycle `createAssistantModule` above proxies
  // (via `assistant-daemon-client.ts`'s shared `fetchAgentDaemon`, extracted from that module this
  // same dispatch), translating its wire frames into real AG-UI SSE events. Does not touch, and is
  // not touched by, either existing execution path. See `modules/assistant-ag-ui.ts`'s header.
  if (adminAssistantEnabled) mountRoutes(app, createAssistantAgUiModule(routeDeps));

  // ADR-046 Phase 3 (SPEC-042, final slice): the `content-types` server module (ADR-043
  // Collections backend) — all 8 registrations (content-types' list/register/update-fields/
  // lifecycle, entries' list/create/update/lifecycle). Admin-UI backend-gap closure (design-
  // spec.md §0.4) — the read-side domain functions + admin routes the Web Design pass found
  // missing across Collections, Categories & Tags (taxonomy), and the rest of Database/Recovery.
  // `mergeTerm`'s plan/confirm/execute ceremony and the migrate-forward/restore-ceremony routes
  // were deferred at the time this block was first written; see the gated-mutation route
  // registrations below for where they now live.
  mountRoutes(app, createContentTypesModule(routeDeps));
  // ADR-046 Phase 3 (SPEC-034): the `taxonomy` server module — the 5 plain CRUD/list routes.
  // `registerAdminTaxonomyMergeTermRoutes` (the gated-mutation ceremony) stays inline below,
  // alongside the unrelated database/recovery ceremonies it shares a gateway pattern with.
  mountRoutes(app, createTaxonomyModule(routeDeps));

  // SPEC-016 (`core/gated-mutations`'s gateway composed into a real composition root, this
  // dispatch) — the 3 deferred gated-mutation ceremonies: taxonomy `mergeTerm`, database
  // `migrate-forward`, recovery `restore`. Each registers 3 endpoints (`/plan`, `/confirm`,
  // `/execute`) mirroring `gateway.ts`'s own 3-method shape.
  registerAdminTaxonomyMergeTermRoutes(app, routeDeps);
  registerAdminDatabaseMigrateForwardRoutes(app, routeDeps);
  registerAdminRecoveryRestoreRoutes(app, routeDeps);

  // ADR-046 Phase 3 (SPEC-042, final slice): the `seo` server module (SPEC-008 SEO) — 6 admin
  // routes gated by `admin.seo.manage`, plus the 2 public site routes (sitemap.xml/robots.txt),
  // which must register before `registerSiteRoutes`'s `/:slug` catch-all below. This call site
  // sits at the exact same position the 8 inline registrations previously occupied — well before
  // `registerSiteRoutes` — so that ordering constraint is unchanged. See `modules/seo.ts`'s file
  // header for the full disclosure and the re-run `route-class-precedence.unit.test.ts` evidence.
  mountRoutes(app, createSeoModule(routeDeps));

  // Built admin SPA (apps/admin/dist) at /admin; helpful 503 when unbuilt. Walked up to, not a fixed
  // `../` count: the source and compiled (`dist/src/...`) trees sit at different depths.
  registerAdminStatic(app, {
    distDir: process.env.TOVU_ADMIN_DIST ?? resolveAppDistDir("admin"),
  });

  // ADR-049 — `@jini-ai/chat-react`'s runtime picker requests agent icons from `/agent-icons/*`
  // at the site root (hardcoded, no `ChatPaneProps` override exists to relocate it — verified
  // against `chat-react@0.2.0`'s `AgentRuntimePicker.tsx`), which sits outside the admin SPA's own
  // `/admin/*`-scoped static serving above. Served from Tovu's own root here (in both dev, via
  // `apps/admin/vite.config.ts`'s matching proxy entry, and prod) rather than duplicated inside
  // `apps/admin/dist` (which would only ever resolve under `/admin/`).
  app.use("/agent-icons", express.static(path.join(resolveProductRoot(), "content", "public", "agent-icons")));

  // MCP-UI sandbox proxy — `@mcp-ui/client`'s `AppFrame` points an iframe's `src` at this exact
  // root-relative path (see `mcp-ui-sandbox-proxy-route.ts`'s own module doc) and never falls back
  // to `srcdoc`, so every MCP-UI surface (e.g. `assistant_ask_choice`'s form) fails to render at all
  // without it. Same "root-relative, outside the admin SPA's `/admin/*` static serving" shape as
  // `/agent-icons` immediately above — mounted here on Tovu's own web server, NOT on the agent
  // daemon (`agent-daemon-server.ts`), because it needs nothing from that process's in-memory
  // `ToolExecutor`/`SurfaceExchangeStore`, only a constant string.
  registerMcpUiSandboxProxyRoute(app);

  // ADR-054 Task 2/3 — the built public site-chat bundle (apps/site-chat/dist) at /site-chat.
  // Distinct static mount from the admin SPA above: a single self-mounting script, not an app with
  // client-side routing, so `site-chat-static.ts` has no `index.html` SPA fallback to serve.
  registerSiteChatStatic(app, {
    distDir: process.env.TOVU_SITE_CHAT_DIST ?? resolveAppDistDir("site-chat"),
  });

  // SPIKE — `static`-tier theme preview builds at /theme-preview/<theme-id>/<dark|light>/...; see
  // theme-preview-static.ts's file header for exactly what this is (and isn't) wired up to.
  registerThemePreviewStatic(app, {
    // `routeDeps.themesDir`, not a package-relative path: since 2026-08-27 the themes a site
    // actually serves live under `sites/<name>/themes/`, and this mount has to follow them or the
    // preview renders the STOCK css while the live site renders the owner's edited copy. Reading it
    // off `routeDeps` rather than calling `siteThemesDir()` here keeps the hermetic in-memory path
    // (`createRouteDeps()` below, which stays on `builtInThemesDir()`) pointed at the same tree its
    // own `deps.themes` was discovered from.
    themesStaticDir: path.join(routeDeps.themesDir, "static"),
  });

  // Real (non-spike) asset serving for a theme's own files at /theme-assets/{id}/...: static-tier
  // css/js (used by render.ts's static-tier branch when actually rendering one as the live site),
  // EXTENDED 2026-08-12 to also cover templated-tier theme folders so a Liquid theme's own images/
  // screenshots are reachable (see theme-static-assets.ts's own header for why declarative/handlebars
  // are not listed here yet, and why templates/*.liquid source being servable is deliberate).
  registerThemeStaticAssets(app, {
    // Site-relative for the same reason as `themesStaticDir` just above — this is the mount that
    // serves the live site's own theme css/js, so a package-relative root here is precisely the bug
    // the `sites/` move fixes.
    themeRoots: [path.join(routeDeps.themesDir, "static"), path.join(routeDeps.themesDir, "templated")],
  });

  // Admin Explore screen's preview iframe: any static theme's page, fully rendered, at
  // /theme-explore/<theme-id>/<page-id> -- plus (2026-08-12) a GATED templated-theme (`.liquid`)
  // preview at /theme-explore/<theme-id>/template/<template-id>, which needs `requireAdminSession`
  // and therefore full `RouteDeps`, not the narrower `ContentRouteDeps` the admin CRUD module uses —
  // see that route's own file header for why it stays registered here instead of moving into
  // `createContentModule`. Registered AFTER the asset route above so the rendered page's own
  // `/theme-assets/...` references are already being served when it loads.
  registerThemePagePreview(app, routeDeps);

  // SPEC-044: the `workspace` server module (list/create/get/update/delete) is registered near the
  // other ADR-046 Phase 3 module calls above (`createUsersModule`); the original inline
  // unauthenticated `POST /workspaces` route that lived here has been removed (see the file header).

  // SPIKE: sample Tier-3 store page — must precede the site `/:slug` catch-all.
  registerStoreRoutes(app, routeDeps);
  // `/products`/`/products/:id` — theme-rendered product grid/detail over the same store data.
  // Must also precede the site `/:slug` catch-all.
  registerProductRoutes(app, routeDeps);

  // Public comment submission (ADR-031 §4) — unauthenticated by design; must precede the site
  // `/:slug` catch-all, same reasoning as the store/analytics routes above.
  registerCommentsSubmitRoute(app, { ingressPolicy: routeDeps.commentIngressPolicy, workspaceId: routeDeps.workspaceId });

  // Public analytics beacon (ADR-035 §5) — unauthenticated by design; must precede the site
  // `/:slug` catch-all. `config` is now the real ADR-028-backed adapter
  // (`analytics/config.settings.ts`'s `createSettingsAnalyticsConfig`), replacing the former
  // hardcoded dev-only stub.
  registerAnalyticsIngestRoute(app, {
    clock: routeDeps.clock,
    ids: routeDeps.idGen,
    sink: routeDeps.analyticsSink,
    config: routeDeps.analyticsConfig,
    resolveWorkspaceForHost: async () => routeDeps.workspaceId, // single-workspace v1
    rootKeySeed: process.env.ANALYTICS_ROOT_KEY_SEED ?? "dev-only-insecure-seed",
  });

  // ADR-046 Phase 3 (SPEC-034): the public media rendition route now registers earlier, as part of
  // `createMediaModule(routeDeps).registerRoutes(app)` above — it's still safely before the site
  // `/:slug` catch-all below, which is the only ordering constraint that ever applied to it.

  // Public, unauthenticated form submission endpoint (SPEC-010 REQ-05, FORMS_POST_SUBMIT) — must
  // precede the site `/:slug` catch-all, same reasoning as the routes immediately above.
  registerFormsSubmitRoute(app, {
    workspaceId: routeDeps.workspaceId,
    submitForm: {
      definitionRepo: routeDeps.formDefinitionRepo,
      submissionRepo: routeDeps.formSubmissionRepo,
      outbox: routeDeps.outbox,
      bus: routeDeps.bus,
      clock: routeDeps.clock,
      idGen: routeDeps.idGen,
      rateLimiter: routeDeps.formsRateLimiter,
    },
  });

  // Public dummy site — registered last (GET /:slug is a catch-all).
  registerSiteRoutes(app, routeDeps);

  // Last, so it sees a body-parser 413 from any route and answers JSON instead of Express's HTML page.
  app.use(respondToOversizedBody);

  return app;
}
