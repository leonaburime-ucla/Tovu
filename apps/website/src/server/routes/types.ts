import type { Express } from "express";
import type { PublishContentSeedHashFn } from "#src/features/publish-content/seed-hash";
import type { SiteProduct } from "../inbound/public-http/http/site/render.js";

import type { ExportReport } from "#src/platform/export/index";
import type { ObservabilityPort } from "#src/platform/observability/index";
import type { SiteBinding } from "#src/platform/site-dir/index";
import type { SiteBackupSources } from "#src/features/site-backup/sources";
import type { ToolAttemptAuditSink } from "#src/features/tool-audit/types";
import type {
  ForgetRemovedEntity,
  RemoveEntity,
  TrashDb,
  TrashPort,
  TrashRegistry,
  TrashSweepOnce,
} from "#src/features/trash/index";
import type { EventBusPort, OutboxPort, UUID } from "@jini-ai/cms/core";
import type { AuthorizeFn, ChangeSetRepoPort, RevertRegistry } from "../../contracts/core/commands/index.js";
import type {
  PasswordHasherPort,
  PolicyPermissionRepoPort,
  PolicyRepoPort,
  PrincipalPolicyRepoPort,
  PrincipalRepoPort,
  PrincipalRoleRepoPort,
  RolePolicyRepoPort,
  RoleRepoPort,
  SessionRepoPort,
  UserRepoPort,
} from "@jini-ai/cms/identity";
import type { ApiKeyRepoPort, ApiKeySecretHasherPort } from "../../features/identity/api-key-types.js";
import type { LipayApi } from "../../features/plugins/lipay/lipay-plugin.js";
import type { PostRepoPort, PostSearchPort, BeforeSaveHookPort, PostRecord, RemovePostFn } from "../../features/post/index.js";
import type { PagesHtmlDocumentStoreFactory } from "../../features/pages/index.js";
import type { ChatStoreFactory } from "../../assistant/persistence/tenant-scope.js";
import type { AgentSessionStore } from "../../assistant/persistence/agent-session-store.js";
import type { PresentationSettingsRepoPort } from "../../features/presentation/index.js";
import type { SettingsRepoPort, getEffective, set } from "../../features/settings/index.js";
import type { SiteDisplayNameSource, SiteTitlePreservationStorePort } from "../../features/settings/site-title.js";
import type { DiscoveredTheme } from "../../features/theme/index.js";
import type { WorkspaceRepoPort } from "../../features/workspace/index.js";
import type { AnalyticsConfigPort, AnalyticsSinkPort } from "../../features/analytics/index.js";
import type {
  MagicLinkTokenRepoPort,
  MemberRepoPort,
  MemberSessionRepoPort,
  MemberSubscriptionRepoPort,
  MemberTierRepoPort,
} from "../../features/members/index.js";
import type { CommercePriceRepoPort, CommerceProductRepoPort } from "../../features/commerce/index.js";
import type { MailerPort } from "../../platform/mail/index.js";
import type { MenuRepoPort, NavLocationBindingRepoPort } from "../../features/navigation/index.js";
import type { RemoveMenuFn } from "../../features/navigation/trash-menu.js";
import type { KeyringPort, SecretSealerPort, WebhookDeliveryRepoPort, WebhookSubscriptionRepoPort } from "../../features/webhooks/index.js";
import type { WebhookSigner } from "../../features/webhooks/signing.js";
import type { SiteAssistantCredentialRepoPort } from "../../assistant/site-credential-store.js";
import type { AdminExecutionCredentialRepoPort } from "../../assistant/execution-credential-store.js";
import type { PublishCredentialSetRepoPort, PublishExecutionMode } from "../../features/deployments/publish-credentials/index.js";
import type { PublishCredentialVerificationCache, PublishHistoryStore } from "../../features/deployments/static-publish/index.js";
import type { CustomCredentialSetRepoPort } from "../../features/custom-credentials/index.js";
import type { HttpClientPort } from "../../platform/http/index.js";
import type { SourceControlCredentialSetRepoPort } from "../../features/source-control/index.js";
import type { VendorCredentialSetRepoPort } from "../../features/vendor-credentials/index.js";
import type { ComposioConfigRepoPort } from "../../platform/connectors/composio-config-store.js";
import type { ComposioConnectors } from "../../platform/connectors/composio-service.js";
import type { MediaProviderCredentialRepoPort } from "../../features/media/index.js";
import type { ExternalMcpServerRepoPort } from "../../assistant/external-mcp-store.js";
import type { DeviceAuthorizationStore, ExternalMcpOAuthService } from "#src/assistant/external-mcp-oauth";
import type { PendingAuthorizationStore } from "#src/platform/oauth/index";
import type {
  AssetBlobRepoPort,
  AssetRenditionRepoPort,
  BlobStorePort,
  ImageTransformerPort,
  MediaContentTypeStorePort,
  TransformDefinitionRepoPort,
  VersionedMediaRepoPort,
} from "../../features/media/index.js";
// Composition-root-only boot effect, deliberately imported straight from its own file rather than
// through the `features/media` barrel — same precedent `deps.ts` already follows for
// `ensureCoreMediaTransform` (not barrel-exported either): this type has no reason to be part of
// this host's wider public media surface.
import type { HydrateBlobStoreFromSeedResult } from "../../features/media/hydrate-blob-store-from-seed.js";
import type { RemoveMediaFn } from "../../features/media/tool-registrations.js";
import type { OriginRegistryPort } from "../../features/origin/index.js";
import type { RedirectHitSink, RedirectRepoPort, RedirectsWriteDeps } from "../../features/redirects/index.js";
import type { FormDefinitionRepoPort, FormSubmissionRepoPort, RemoveFormSubmissionFn } from "../../features/forms/index.js";
import type { CommentIngressPolicy, CommentRepoPort, CommentWriteService } from "../../features/comments/index.js";
import type { RateLimiter } from "#src/contracts/core/rate-limit/rate-limit";
import type { LedgerReadPort } from "../../features/database/timeline.js";
import type {
  RestorePointListPort,
  RestorePointSavePort,
  RestorePointIdempotencyLookupPort,
} from "../../features/database/restore-points.js";
import type { DatabaseIntrospectionPort } from "../../features/database/adapter.sqlite.js";
import type {
  BootLedgerPort,
  MigrationRunsRepoPort,
  SiteStatusPort,
} from "../../features/database/boot/reconcile-interrupted-migration.js";
import type { DbOpsPort } from "../../contracts/core/gated-mutations/ports.js";
import type { ContentTypeRepoPort, IndexProvisionerPort } from "../../features/content-types/index.js";
import type { TeardownIndexProvisionerPort } from "../../features/content-types/index.js";
import type { ContentTypeListPort } from "../../features/content-types/index.js";
import type { EntryRepoPort } from "../../features/entries/index.js";
import type { EntryListPort } from "../../features/entries/index.js";
import type { EntryDisplayListPort, EntryListExcludingTypesPort } from "../../features/entries/public-list.js";
import type { EntryPublishReadPort } from "../../features/entries/repo.sqlite.js";
import type {
  AssignmentCountEntryTermRepoPort,
  DeletableTaxonomyRepoPort,
  DeletableTermRepoPort,
  EntryTermRepoPort,
  TaxonomyListPort,
  TaxonomyRepoPort,
  TaxonomyRevisionRepoPort,
  TermListPort,
  TermRepoPort,
  TransactionalRepoPort,
  UnassignableEntryTermRepoPort,
  ImportableTaxonomyRepoPort,
  ImportableTermRepoPort,
} from "../../features/taxonomy/index.js";
import type { DisclosureWatermarkSourcePort } from "../../features/recovery/disclosure.js";
import type { DeepLinkRestorePointLookupPort } from "../../features/recovery/deep-link.js";
import type { GatewayDeps } from "../../contracts/core/gated-mutations/gateway.js";
import type { LedgerAppendPort } from "../../features/database/gated-hooks.js";
import type { MergeableEntryTermRepoPort } from "../../features/taxonomy/gated-hooks.js";
import type { EntryTermReadPort, TaxonomyPublishReadPort, TermPublishReadPort } from "../../features/taxonomy/repo.sqlite.js";
import type {
  RemoveTermFn,
  RemoveTaxonomyFn,
  TermTrashReadPort,
  TaxonomyTrashReadPort,
} from "../../features/taxonomy/trash-term.js";
import type { WidgetRegionBindingRepoPort, RemoveWidgetFn } from "../../features/widgets/ports.js";
import type { EntryRefsRepoPort } from "../../contracts/core/entry-refs/ports.js";
import type { PluginActivationRepoPort } from "../../features/plugin-runtime/activation.js";
import type { PluginDiscoveryRecord } from "../../features/plugin-runtime/discovery.js";
import type { PluginPackageFiles } from "../../features/plugin-runtime/package-files.js";
import type { RemovePluginFn } from "../../features/plugin-runtime/uninstall.js";
import type { DeploymentsReadRepoPort, ExportEngine } from "../../features/deployments/index.js";
import type { PublishTrustRevocationPort } from "#src/features/publish-trust/revocations";
import type { PublishContentBundleRepoPort } from "../../features/publish-content/bundle-staging.js";
import type { PublishContentBaselineRepoPort } from "../../features/publish-content/baseline-repo.js";
import type { PublishContentApplyPort } from "../../features/publish-content/gated-hooks.js";
import type { PublishContentRunRepoPort } from "../../features/publish-content/run-repo.js";
import type { PublishContentPeerRepoPort } from "../../features/publish-content/peers.js";
import type { FileBlobIndexPort } from "../../features/publish-content/file-blob-index.js";

/**
 * Slice 1 of the `RouteDeps` god-object decomposition (2026-08-18) — the process-wide clock + id-gen
 * seam. Split out first because it is the smallest, most stable pair in the bag (used by nearly every
 * write chokepoint, but never grows past these two members) and has zero coupling to any other
 * domain group here.
 */
export interface ClockDeps {
  clock: { nowIso(): string };
  idGen: { newId(): string };
}

/**
 * Slice 1 of the `RouteDeps` god-object decomposition (2026-08-18) — the identity/auth-repo fields
 * `requireAdminSession`/`registerAuthRoutes` (`inbound/admin-http/dev-auth.ts`) actually consume, extracted
 * verbatim (fields + doc comments unchanged) from where they lived inline in `RouteDeps` below.
 *
 * `identity` library repo ports (ADR-021 / SPEC-006) — principal-centric
 * auth. In-memory only this pass (see `identity/INFO.md`); real login,
 * sessions, and the RBAC seed run against these.
 */
export interface IdentityDeps {
  principalRepo: PrincipalRepoPort;
  userRepo: UserRepoPort;
  sessionRepo: SessionRepoPort;
  roleRepo: RoleRepoPort;
  policyRepo: PolicyRepoPort;
  policyPermissionRepo: PolicyPermissionRepoPort;
  rolePolicyRepo: RolePolicyRepoPort;
  principalRoleRepo: PrincipalRoleRepoPort;
  principalPolicyRepo: PrincipalPolicyRepoPort;
  /** argon2id hashing seam (INV-05) — see `identity/hasher.ts`. */
  passwordHasher: PasswordHasherPort;
  /** SPEC-006 REQ-08 — the `api_keys` repo port (`identity/api-key-types.ts`). Declared in this
   *  repo rather than in `@jini-ai/cms/identity`, which scopes API keys out of its own surface. */
  apiKeyRepo: ApiKeyRepoPort;
  /** SPEC-006 REQ-08 — the api-key secret hashing seam, deliberately separate from
   *  `passwordHasher`; see `identity/api-key-secret.ts`'s header for why the two are tuned apart. */
  apiKeySecretHasher: ApiKeySecretHasherPort;
  /** Delete-user plan v2 Slice 2 — `trashUser`'s Trash-bound remove callback and trash-membership
   *  check; see `identity/wiring.ts`'s `IdentityRouteDepsSlice.removeUser` doc for the
   *  default-then-override story between the two composition roots. */
  removeUser?: RemoveEntity;
  isInTrash: (principalId: UUID) => Promise<boolean>;
  /**
   * Resolves once first-boot identity seeding (`identity/seed.ts`) completes.
   * Seeding hashes the owner's password (async, argon2id), so
   * `createRouteDeps()`/`createSqliteRouteDeps()` stay synchronous by kicking
   * the seed off immediately and handing back this promise; auth-adjacent
   * middleware/routes `await` it before touching identity repos, so
   * correctness never depends on request timing (no race).
   */
  identityReady: Promise<void>;
  /** SPEC-006 0.6.0 (REQ-11/REQ-15) — resolves to the seeded owner's principal id; see
   * `identity/wiring.ts`'s `IdentityRouteDepsSlice.ownerPrincipalId` doc for the full rationale. */
  ownerPrincipalId: Promise<UUID>;
  /**
   * Bound closure over `identity.authorize()` + its repos (ADR-006/ADR-021 §2:
   * `authorize()` itself is ordinary core code, not a port — this field exists
   * so `core/commands` can call it without importing the `identity` library;
   * see `AuthorizeFn`'s doc in `core/commands/command.ts`).
   */
  authorize: AuthorizeFn;
  workspaceId: UUID;
}

/**
 * Slice 2 of the `RouteDeps` god-object decomposition (2026-08-18) — the `media` library's
 * asset/blob/transform ports (ADR-027), extracted verbatim (fields + doc comments unchanged) from
 * where they lived inline in `RouteDeps` below.
 *
 * Unlike `ClockDeps`/`IdentityDeps` above, this group already had a real narrow consumer BEFORE
 * this extraction: every media route (`routes/admin/media/*.ts`'s 5 admin routes + the public
 * `routes/site/media-rendition.ts`) is typed against `routes/admin/media/deps.ts`'s
 * `MediaRouteDeps`, which hand-picked these same 6 keys off `RouteDeps` via `Pick`. That file now
 * composes `MediaDeps` directly instead of re-listing the keys a second time — see its own doc.
 * The two mixed-domain slices that also touch a couple of these fields
 * (`routes/admin/content/deps.ts`'s `ContentRouteDeps`, `routes/admin/seo/deps.ts`'s
 * `SeoRouteDeps`) are deliberately left alone: each needs only 2-3 of the 6 fields alongside a
 * larger, unrelated set (posts/pages/change-sets for the former, SEO settings for the latter), so
 * pulling in the whole `MediaDeps` group there would widen rather than narrow their real surface.
 */
export interface MediaDeps {
  /**
   * `media` library ports (ADR-027 walking skeleton — see `src/media/INFO.md`
   * for the disclosed scope: bespoke `MediaRecord` table instead of the
   * not-yet-implemented generic entries model, no journaled GC, no transform
   * pipeline, no origin-isolated serving). `mediaRepo` is the bespoke table's
   * repo (not a frozen ADR port, same status as `menuRepo`); `assetBlobRepo`/
   * `assetRenditionRepo` are the two core-owned sidecars ADR-027 §2 specifies;
   * `blobStore` is the one real ADR-027 §1 `BlobStorePort`.
   */
  mediaRepo: VersionedMediaRepoPort;
  assetBlobRepo: AssetBlobRepoPort;
  assetRenditionRepo: AssetRenditionRepoPort;
  blobStore: BlobStorePort;
  /**
   * The blob content-type side port (`media/content-type-store.ts`) — what the admin Media
   * screen's "Images"/"Videos" tabs filter on. Separate from `assetBlobRepo` above even though
   * both address the same `asset_blobs` table, because `AssetBlobRecord` is `@jini-ai/cms`'s
   * frozen port type with no content-type field; see that module's header for the full rationale.
   */
  mediaContentTypeStore: MediaContentTypeStorePort;
  /**
   * ADR-027 §4 named transform registry + rendition generation — new in this
   * task (see `src/media/rendition-service.ts` file header for the disclosed
   * scope: core-declared transforms only, in-process lazy single-flight
   * generation only). `transformDefinitionRepo` is the append-only
   * `transform_registry` sidecar; `imageTransformer` is the seam that
   * actually runs the pixel operation (`InMemoryImageTransformer` in the
   * hermetic test/dev composition, `SharpImageTransformer` in the real
   * running server — see `server/app.ts` / `server/deps.ts`).
   */
  transformDefinitionRepo: TransformDefinitionRepoPort;
  imageTransformer: ImageTransformerPort;
  /**
   * Fire-and-forget, same shape as `IdentityDeps.identityReady`: resolves once
   * `hydrateBlobStoreFromSeed()` (`features/media/hydrate-blob-store-from-seed.ts`) has finished
   * topping up `blobStore` with any stock seed blob it was missing — the fix for the production
   * incident where `content.seed.db` shipped real `media`/`asset_blobs` rows but no deploy path
   * ever shipped the bytes those rows' `storage_key`s point at. Optional (unlike `identityReady`):
   * only `server/deps.ts`'s real SQLite composition wires this — the in-memory hermetic composition
   * (`server/app.ts`'s `createRouteDeps()`) has no seed payload to hydrate from and leaves it unset,
   * exactly as `mediaTransformReady` is left un-exposed there for the same reason. No route gates on
   * this; it exists so a boot-integration test can await deterministic completion instead of racing
   * a fire-and-forget background copy.
   */
  blobHydrationReady?: Promise<HydrateBlobStoreFromSeedResult | undefined>;
}

/**
 * Slice 3 of the `RouteDeps` god-object decomposition (2026-08-18) — the site/admin credential-set
 * repos and their two shared ADR-058 sealing capabilities, extracted verbatim (fields + doc comments
 * unchanged) from where they lived inline in `RouteDeps` below.
 *
 * All ten fields are secret-adjacent (a sealed connection, a token, or the shared capability that
 * seals/opens one), but no single consumer reads more than a handful at once: every credential-CRUD
 * route (`routes/admin/system/{custom,source-control,vendor,publish}-credentials.ts`) reads its OWN
 * repo plus the two shared sealer/keyring fields, never another route's repo. Narrowed call sites so
 * far: the four `routes/admin/system/*-credentials.ts` files (each was a bare `RouteDeps` alias
 * before this slice, now a `Pick<RouteDeps, ...>` naming its own repo + the two shared fields — see
 * each file's own doc). `routes/admin/media/deps.ts`'s `MediaProviderRouteDeps` and `routes/admin/
 * external-mcp/deps.ts`'s `ExternalMcpRouteDeps` are left alone: both already `Pick` this same
 * shape (their own repo + the two shared fields) straight off `RouteDeps`, and composing this whole
 * ten-field group into either would add the other 8 credential fields neither one reads — the exact
 * "would widen, not narrow" case Slice 2's own doc already established for `ContentRouteDeps`/
 * `SeoRouteDeps`.
 */
export interface CredentialsDeps {
  /**
   * The SITE's encrypted provider credential store (ADR-058) — one row per workspace, backing the
   * "Visitor's AI Assistant" admin tab and `server/modules/site-assistant.ts`'s runtime key
   * resolution. Unlike `assistantSettingsReady` above, this needs no boot-time definition
   * registration (it is a plain table, not a `core.execution.*` ledger namespace), so there is no
   * matching `*Ready` promise — the repo is usable as soon as migrations have run.
   */
  siteAssistantCredentialRepo: SiteAssistantCredentialRepoPort;
  /** Seals/opens the SITE credential above. See `integrations/secret-sealer.aesgcm.ts`'s header for
   *  why this is one shared sealing capability, not one per workspace. */
  siteAssistantSecretSealer: SecretSealerPort;
  /**
   * The `KeyringPort` `siteAssistantSecretSealer` derives its AES key from — exposed separately
   * (not just baked into the sealer) because `setSiteAssistantCredential` also needs
   * `keyring.activeKey()` directly, to know which root-key generation to stamp into a freshly-sealed
   * row. Deliberately its OWN `EnvOrFileKeyring` instance in the real composition root
   * (`server/deps.ts`), constructed `{allowFileFallback:false}`, independent of the shared instance
   * webhook signing/newsletter tokens use — see ADR-058 §2 for why that asymmetry is intentional.
   */
  siteAssistantSecretKeyring: KeyringPort;
  /**
   * The ADMIN's own encrypted BYOK credential store — one row per `(workspaceId, principalId)`,
   * backing `modules/assistant-byok.ts`'s `createStoredExecutionCredentialPort` and the
   * GET/PUT/DELETE `.../assistant/execution-credential` routes. NOT `siteAssistantCredentialRepo`
   * above (that one is per-workspace and backs the public visitor assistant). Sealed via the SAME
   * `siteAssistantSecretSealer`/`siteAssistantSecretKeyring` instances above — see
   * `db/schema.sqlite.ts`'s `adminExecutionCredentials` header for why one shared sealing capability is
   * correct here rather than a third `KeyringPort` instance. No matching `*Ready` promise, for the
   * same reason `siteAssistantCredentialRepo` has none: a plain table, usable as soon as migrations
   * have run.
   */
  adminExecutionCredentialRepo: AdminExecutionCredentialRepoPort;
  /**
   * Per-workspace media-generation vendor credentials, backing the GET/PUT
   * `.../media/providers` routes the admin's Media → "Media providers" tab talks to. Sealed via
   * the same two capabilities above, for the same reason the BYOK store reuses them.
   *
   * Multi-row per workspace (one per vendor), unlike both credential repos above — see
   * `media/provider-credential-store.ts` for why this one is workspace-scoped rather than
   * per-principal. No matching `*Ready` promise: a plain table, usable as soon as migrations run.
   */
  mediaProviderCredentialRepo: MediaProviderCredentialRepoPort;
  /**
   * The workspace's roster of external MCP servers, backing the admin's Settings → External MCP tab
   * and read by the agent daemon at boot to decide what to federate
   * (`assistant/external-mcp-store.ts`).
   *
   * Multi-row per workspace like `mediaProviderCredentialRepo` above. Its sealed column holds a
   * whole `KEY=VALUE` environment block rather than one key, sealed with the same shared ADR-058
   * sealer/keyring as every other credential table here. No matching `*Ready` promise: a plain
   * table, usable as soon as migrations run.
   */
  externalMcpServerRepo: ExternalMcpServerRepoPort;
  /**
   * The OAuth subsystem for `authMode: "oauth"` external MCP connections
   * (`assistant/external-mcp-oauth.ts`), or absent.
   *
   * OPTIONAL. Not because the state it holds is process-bound (see
   * `externalMcpOAuthPending`/`externalMcpOAuthDevices` below for why that claim used to be here and
   * was wrong) — a caller with no persistent `content.db` to attach a real store to, or a narrow test
   * double that has no reason to wire OAuth at all, may still leave this unset, and
   * `modules/external-mcp.ts` then registers no OAuth routes: an unauthenticated public callback
   * endpoint that can complete nothing should not exist.
   */
  externalMcpOAuth?: ExternalMcpOAuthService;
  /**
   * The pending-authorization / device-authorization stores `externalMcpOAuth` above is built from —
   * exposed as their OWN fields, alongside the service, rather than only living inside it.
   *
   * Why: `agent-daemon-server.ts` builds its OWN, second `ExternalMcpOAuthService` instance (its own
   * header explains why — the refresh/reportAuthFailure half of the service needs to run in that
   * process too), and that second instance needs the SAME `pending`/`devices` stores this one uses,
   * not a second pair pointed at the same table through a second, independently-opened `content.db`
   * handle (which would re-run that file's `migrate()` a second time per boot — the exact hazard
   * `toolAttemptAuditSink`'s own doc on this interface already argues against reintroducing). Built
   * ONCE per composition root and threaded through both instances instead.
   *
   * These are what actually make `beginConnect`/`completeAuthorizationCallback`/
   * `pollDeviceAuthorization` work across processes: `composition/deps.ts`'s `createSqliteRouteDeps`
   * backs them with `platform/db/sqlite/oauth-pending-store.sqlite.ts`'s `content.db`-backed
   * adapters, so a handshake begun in the agent daemon (`external_mcp_oauth_connect` is an assistant
   * tool — it runs there) can be completed by the public callback route running in the main web
   * server. `composition/app.ts`'s hermetic root, which owns no `content.db` at all, backs them with
   * the in-memory adapters instead — correct whenever that root's `RouteDeps` live in ONE process
   * (which is all a narrow test double needs), but NOT a cross-process guarantee: under
   * `TOVU_DB=memory` both `src/index.ts` and `agent-daemon-server.ts` call that root in their OWN
   * process, so a chat-initiated authorization_code `external_mcp_oauth_connect` begun in the daemon
   * and redeemed by the main server's public callback fails `OAUTH_INVALID_STATE`. That is the same
   * per-process isolation `agent-daemon-server.ts`'s header already discloses for memory mode.
   * Admin-initiated connects (begin and callback both in the main server) and the `device_code`
   * grant (begin and poll both in the daemon) are unaffected.
   *
   * OPTIONAL for the same structural reason `externalMcpOAuth` is: a narrower test double that never
   * sets these gets no fallback rather than a broken build. A caller reading them without a
   * composition root's guarantee that they are set (`agent-daemon-server.ts`, notably) falls back to
   * building its own in-memory pair rather than crashing.
   */
  externalMcpOAuthPending?: PendingAuthorizationStore;
  externalMcpOAuthDevices?: DeviceAuthorizationStore;
  /**
   * This process's own best-effort public origin (`"https://localhost:3000"`-shaped) — the scheme
   * from whether THIS process terminates TLS itself (`server/runtime/boot/dev-tls.ts`) and the port
   * from `PORT`, host assumed `localhost` since a composition root has no live client request to
   * read a `Host` header from. Computed once per boot by both composition roots
   * (`server/runtime/composition/{deps,app}.ts`), mirroring the identical `devCapabilityScheme`
   * derivation already there.
   *
   * FALLBACK ONLY, and optional for the same reason `externalMcpOAuth` above is: a caller that never
   * sets it (a narrower test double, say) just gets no fallback rather than a broken build.
   * `features/external-mcp/tool-registrations.ts`'s `resolveExternalMcpOAuthRedirectUri` is the one
   * reader today — `TOVU_PUBLIC_URL`, when configured, always wins over this (a real deployment
   * behind a proxy or custom domain needs that override to keep working; this field only fills the
   * gap for the chat tool call that has no live request of its own to derive an origin from, the
   * identical gap `resolvePublicOrigin(req)` closes for the admin HTTP route). 2026-09-10: closes the
   * defect where a non-technical user's OAuth connect refused outright just because nobody had set an
   * env var.
   */
  derivedPublicOrigin?: string;
  /**
   * 2026-08-15 (Contract v2) — the `publish_credential_sets` repo backing the admin's Static Site tab
   * "add a connection" form and the DB-backed half of `static-publish/credentials.ts`'s
   * `composePublishCredentialSource`. Real `SqlitePublishCredentialSetRepo` in `server/deps.ts`
   * (migration `0041` already applied — see that repo's own doc); `InMemoryPublishCredentialSetRepo`
   * in `server/app.ts`'s hermetic composition, same rule-of-two every other repo here follows. Sealed
   * via the SAME shared `siteAssistantSecretSealer`/`siteAssistantSecretKeyring` instances above —
   * one sealing capability app-wide, same reasoning `adminExecutionCredentialRepo`/
   * `mediaProviderCredentialRepo` already establish.
   */
  publishCredentialSetRepo: PublishCredentialSetRepoPort;
  /**
   * 2026-08-15 — the `source_control_credential_sets` repo backing the admin Source Control page's
   * connect/replace form (`routes/admin/system/source-control-credentials.ts`). Real
   * `SqliteSourceControlCredentialSetRepo` in `server/deps.ts`; `InMemorySourceControlCredentialSetRepo`
   * in `server/app.ts`'s hermetic composition, same rule-of-two every other repo here follows. Sealed
   * via the SAME shared `siteAssistantSecretSealer`/`siteAssistantSecretKeyring` instances above — one
   * sealing capability app-wide, same reasoning `publishCredentialSetRepo` already establishes. A
   * deliberately SEPARATE table from `publishCredentialSetRepo` above, not a widened
   * `PublishProviderId` union — see `src/platform/db/schema.sqlite.ts`'s `sourceControlCredentialSets` doc comment for
   * why.
   */
  sourceControlCredentialSetRepo: SourceControlCredentialSetRepoPort;
  /**
   * 2026-08-16 (Phase 3) — the `vendor_credential_sets` repo backing the unified vendor-scoped
   * credential redesign (`features/vendor-credentials/`; `db/schema.sqlite.ts`'s `vendorCredentialSets`
   * doc has the full "destination vs. vendor" reasoning). Real `SqliteVendorCredentialSetRepo`
   * (`db/sqlite/vendor-credential-repo.sqlite.ts`) in `server/deps.ts`;
   * `InMemoryVendorCredentialSetRepo` in `server/app.ts`'s hermetic composition, same rule-of-two
   * every other repo here follows. Sealed via the SAME shared `siteAssistantSecretSealer`/
   * `siteAssistantSecretKeyring` instances above — one sealing capability app-wide, same reasoning
   * `publishCredentialSetRepo`/`sourceControlCredentialSetRepo` already establish.
   *
   * This table does NOT yet replace `publishCredentialSetRepo`/`sourceControlCredentialSetRepo`
   * above — both stay wired and fully live. `features/vendor-credentials/dual-read.ts`'s
   * `resolveDefaultForVendorDualRead` is the seam that lets a future caller read this table first
   * and fall back to one of the two legacy repos above when a vendor's group here is still empty
   * (an install whose data has not been backfilled by `development/scripts/backfill-vendor-
   * credentials.ts` yet) — see that module's own header for the full design and why a straight
   * cutover was rejected.
   */
  vendorCredentialSetRepo: VendorCredentialSetRepoPort;
  /**
   * 2026-08-17 — the `custom_credential_sets` repo backing the admin Access Tokens page's
   * "Add custom provider" form (`routes/admin/system/custom-credentials.ts`). Real
   * `SqliteCustomCredentialSetRepo` in `server/deps.ts`; `InMemoryCustomCredentialSetRepo` in
   * `server/app.ts`'s hermetic composition, same rule-of-two every other repo here follows. Sealed
   * via the SAME shared `siteAssistantSecretSealer`/`siteAssistantSecretKeyring` instances above —
   * one sealing capability app-wide, same reasoning `publishCredentialSetRepo`/
   * `sourceControlCredentialSetRepo` already establish. A deliberately separate table from both of
   * those and from `vendorCredentialSetRepo` — see `src/platform/db/schema.sqlite.ts`'s `customCredentialSets` doc
   * comment for why (no fixed provider-id catalog to join either union, or the vendor table's own
   * vendor-keyed model).
   */
  customCredentialSetRepo: CustomCredentialSetRepoPort;
  /**
   * The guarded outbound-HTTP seam (ADR-038) backing `features/custom-credentials`'s two agent
   * tools (`custom_credential_verify`/`custom_credential_make_request`,
   * `features/custom-credentials/tool-registrations.ts`) — an authenticated call through a saved
   * custom credential (e.g. "name.com", "fly.io") to its own operator-typed `baseUrl`. A genuinely
   * separate `HttpClientPort` instance from `server/runtime/composition/deps.ts`'s own local mailer
   * client (that one is a private local, never stored on `RouteDeps`, since only
   * `createResolvedMailer` ever needed it) — this one is stored here because the new registry-style
   * tool-contribution seam (`contribute<Domain>Tools()`) receives the SAME shared `RouteDeps` object
   * for every domain, so a domain's own `ToolDeps` interface can only pick up a field that genuinely
   * lives on this bag. Built from `platform/http/egress-policies.ts`'s own
   * `CUSTOM_CREDENTIALS_EGRESS_POLICY` (2026-09-10) — until then this shared the mailer client's
   * `SINGLE_HOP_HTTPS_EGRESS_POLICY`, but a live GitHub-Actions-log-diagnosis incident showed a
   * fixed-method, zero-redirect policy does not fit this domain: GitHub's own Actions job-logs
   * endpoint answers with a 302 to a signed Azure Blob Storage URL, and a `custom_credential_make_request`
   * GET could not follow it. See that policy's own doc for the full redirect-safety argument (GET
   * only, every hop re-verified, auth stripped cross-origin, no allowlist widening needed) — see
   * `features/custom-credentials/credentialed-request.ts`'s own header for why every outbound call
   * here needs the SSRF-guarded client rather than raw `fetch` (the target host is an arbitrary,
   * operator-typed `baseUrl`, not a small set of hardcoded, reviewed provider URLs).
   */
  customCredentialsHttpClient: HttpClientPort;
  /**
   * The guarded `HttpClientPort` backing `features/media-import`'s `media_import_from_url` — the
   * assistant handing the server a URL and the server fetching it, which is the textbook SSRF sink
   * and the reason this must never be a raw `fetch`.
   *
   * A THIRD instance rather than a reuse of `customCredentialsHttpClient` above, because it is built
   * from a different `EgressPolicy`: `platform/http/egress-policies.ts`'s
   * `MEDIA_IMPORT_EGRESS_POLICY`, which follows (and fully re-verifies) up to three redirects, allows
   * a file-sized response, and waits a download's worth of time — none of which
   * `SINGLE_HOP_HTTPS_EGRESS_POLICY` does or should. Sharing one client would mean one of the two
   * call shapes gets the wrong policy; see that policy's own doc for the per-axis reasoning.
   *
   * Stored on this bag for the same reason `customCredentialsHttpClient` is: the registry-style
   * tool-contribution seam (`contribute<Domain>Tools()`) hands the SAME shared `RouteDeps` object to
   * every domain, so a domain's own `ToolDeps` interface can only pick up a field that genuinely
   * lives here.
   */
  mediaImportHttpClient: HttpClientPort;
}

/**
 * Slice 3 of the `RouteDeps` god-object decomposition (2026-08-18) — the ADR-022/ADR-043/ADR-044
 * content-model repos (`content-types`/`entries`/`taxonomy`/`entry_refs`), extracted verbatim (fields
 * + doc comments unchanged) from where they lived inline in `RouteDeps` below.
 *
 * The original "Admin-UI backend-gap closure" design-spec comment covering this cluster ALSO covers
 * `stampWatermark`/`restorePointsRepo`/`dbOps`/`databaseIntrospection`/`siteStatusRepo`/
 * `disclosureWatermarkSource`/`deepLinkRestorePointLookup` below — none of those are part of this
 * group, so that comment stays put, still attached to `stampWatermark` (the first field of that
 * original cluster still declared directly on `RouteDeps`).
 *
 * `entryRefsRepo` is included here even though it physically lived elsewhere in `RouteDeps` (next to
 * `widgetBindingRepo`, ADR-022 §5/SPEC-043) — schema-owned by `core`, but its own repo port
 * (`EntryRefsRepoPort`) is exactly this group's shape of thing (a content-model persistence seam), so
 * it groups here per this slice's own field list rather than with `widgets`.
 *
 * No consumer narrowed to this group this slice: `routes/admin/content-types/deps.ts`'s
 * `ContentTypesRouteDeps` and `routes/admin/taxonomy/deps.ts`'s `TaxonomyRouteDeps` each already
 * `Pick` only 3-4 of these 8 fields alongside other, non-group fields (`outbox`/`postRepo`/
 * `stampWatermark`) — composing the whole group into either would widen rather than narrow, the same
 * "leave alone" case Slice 2 already established for `ContentRouteDeps`/`SeoRouteDeps`.
 * `widgets/deps.ts`'s `WidgetsRouteDeps` (reads `entryRepo`/`contentTypeRepo`/`entryRefsRepo`, 3 of
 * these 8) is declared fully structurally on purpose — its own header says it is "free of a back-edge
 * into the composition root" — so it is left alone for a different, stronger reason: importing this
 * named type would reopen exactly the edge it was written to avoid.
 */
export interface ContentTaxonomyDeps {
  /** ADR-022/ADR-043 — the `content_types` registry's write chokepoint repo, widened with this
   * dispatch's new `ContentTypeListPort` (`features/content-types/list.ts`). */
  contentTypeRepo: ContentTypeRepoPort & ContentTypeListPort;
  /** No-op this pass (`features/content-types/repo.memory.ts`'s `NoopContentTypeIndexProvisioner`)
   * — real DDL index provisioning targets `content.db` tables this domain has no SQLite adapter
   * for yet, same disclosed gap as `contentTypeRepo`. */
  contentTypeIndexProvisioner: IndexProvisionerPort & TeardownIndexProvisionerPort;
  /** ADR-022/ADR-043 — the `entries` write chokepoint repo, widened with this dispatch's new
   * `EntryListPort` (`features/entries/list.ts`). Also satisfies entries' `ContentTypeLookupPort`
   * structurally when `contentTypeRepo` is passed as its `contentTypeRepo` dep (a `ContentTypeRecord`
   * is a structural superset of `OwningContentType`). Widened again by collections plan C2 with
   * `EntryDisplayListPort` (`features/entries/public-list.ts`) — the `{"type":"collection"}`
   * marker's bounded published-entry read. No composition-root edit: `deps.ts`'s `SqliteEntryRepo`
   * and `app.ts`'s `TrashAwareInMemoryEntryRepo` both implement it directly. Widened for
   * publish-content (`collection-entry`) with the excluding-types list and the trash-inclusive read. */
  entryRepo: EntryRepoPort & EntryListPort & EntryDisplayListPort & EntryListExcludingTypesPort & EntryPublishReadPort;
  /** ADR-044 — the `taxonomies`/`terms`/`entry_terms`/`taxonomy_revisions` write chokepoint repos,
   * `taxonomyRepo`/`termRepo` widened with this dispatch's new `TaxonomyListPort`/`TermListPort`
   * (`features/taxonomy/list.ts`). `mergeTerm`'s plan/confirm/execute ceremony is NOT wired this
   * pass (needs `core/gated-mutations`'s gateway, not composed into any composition root yet). */
  /** Widened again for the `deleteTaxonomy`/`deleteTerm` guarded-delete routes with
   * `DeletableTaxonomyRepoPort`/`DeletableTermRepoPort` (`@jini-ai/cms/taxonomy`'s additive
   * delete capability — see that package's `write-service.ts` for why these are additive
   * interfaces rather than folded into the certified `TaxonomyRepoPort`/`TermRepoPort`).
   * `taxonomyRepo` widened once more with `TransactionalRepoPort` (coordinator review, hazards
   * #1/#2): the same guard-and-cascade atomicity `deleteTerm`/`deleteTaxonomy` need, sourced from
   * whichever one repo instance the route wires up as `deps.transaction` — `taxonomyRepo` is the
   * one both delete flows always have, so it is the canonical source. */
  /** Widened once more with `TaxonomyTrashReadPort` (`findForTrash`, a host-only addition — see
   *  `EntryTermReadPort`'s doc above for why these are declared directly against `repo.sqlite.js`/
   *  `trash-term.js` rather than folded into a certified Jini port) for `trashTaxonomy`'s read. */
  /** Widened for publish-content (`features/taxonomy/publish-content.ts`) with the id-preserving
   *  import's `ImportableTaxonomyRepoPort` and the trash-inclusive `TaxonomyPublishReadPort`. */
  taxonomyRepo: TaxonomyRepoPort & TaxonomyListPort & DeletableTaxonomyRepoPort & TransactionalRepoPort & TaxonomyTrashReadPort & ImportableTaxonomyRepoPort & TaxonomyPublishReadPort;
  /** Widened once more with `TermTrashReadPort` (`findForTrash`) for `trashTerm`'s read — same
   *  host-only-addition reasoning as `taxonomyRepo` above. */
  /** Widened for publish-content the same way as `taxonomyRepo`. */
  termRepo: TermRepoPort & TermListPort & DeletableTermRepoPort & TermTrashReadPort & ImportableTermRepoPort & TermPublishReadPort;
  /** Bound at composition to the generic trash pipeline (T6, trash parallel plan §2, owner
   *  decision 5) — `RemoveTermFn` is WIDE (carries `"blocked"`, the `TERM_HAS_CHILDREN` blocker);
   *  `RemoveTaxonomyFn` is narrowed, same reasoning as `removeWidget`/`removeMenu` elsewhere in
   *  this file. */
  removeTerm: RemoveTermFn;
  removeTaxonomy: RemoveTaxonomyFn;
  /** Widened this dispatch with `MergeableEntryTermRepoPort` (the `mergeTerm` gated-mutation
   * ceremony's by-term enumeration need — see `features/taxonomy/gated-hooks.ts`). Widened again
   * with `AssignmentCountEntryTermRepoPort` for the `deleteTaxonomy`/`deleteTerm` guard, and again
   * with `UnassignableEntryTermRepoPort` for `taxonomy_unassign_terms` (A2, taxonomy plan) — both
   * `SqliteEntryTermRepo` (real) and `InMemoryEntryTermRepo` (`@jini-ai/cms/taxonomy`, hermetic)
   * already implement it, so this widening breaks neither composition's typecheck. */
  entryTermRepo: EntryTermRepoPort & MergeableEntryTermRepoPort & AssignmentCountEntryTermRepoPort & UnassignableEntryTermRepoPort;
  /**
   * Public-render read path (2026-09-02 taxonomy render-surface gap fix, `repo.sqlite.ts`'s
   * `EntryTermReadPort`) — resolves the terms assigned to a page/post for `pages.ts`'s
   * `renderViaTemplate` to render. Optional, unlike every other field in this group: the certified
   * `@jini-ai/cms/taxonomy` package's `InMemoryEntryTermRepo` (wired as `entryTermRepo` above in
   * `server/runtime/composition/app.ts`'s hermetic composition) has no by-content read method to
   * satisfy this with, so widening `entryTermRepo`'s own type instead — the precedent
   * `MergeableEntryTermRepoPort`/`AssignmentCountEntryTermRepoPort` set immediately above — would
   * break that composition's typecheck. `server/runtime/composition/deps.ts`'s real composition
   * sets this to the SAME `SqliteEntryTermRepo` instance it already constructs for `entryTermRepo`
   * (one concrete class satisfying two differently-shaped dependency slots); the hermetic
   * composition leaves it `undefined`, and every consumer degrades to "no terms" for that case,
   * never a throw — see `resolveAssignedTermsForRender`'s own doc.
   */
  entryTermReadRepo?: EntryTermReadPort;
  taxonomyRevisionRepo: TaxonomyRevisionRepoPort;
  /**
   * SPEC-043/ADR-022 §5 (`entry_refs`) — the reference-integrity index's persistence seam
   * (`core/entry-refs/ports.ts`'s `EntryRefsRepoPort`). Schema-owned by `core`, first populated by
   * `widgets` (the region-area/write-service chokepoint hooks) — consumed here by the admin
   * `widgets` routes for the REQ-34 where-used disclosure and the REQ-42 safe-delete check.
   */
  entryRefsRepo: EntryRefsRepoPort;
}

/**
 * Slice 3 of the `RouteDeps` god-object decomposition (2026-08-18) — the ADR-031/ADR-023 (SPEC-033)
 * Comments bundled plugin's composed backend, extracted verbatim (fields + doc comments unchanged)
 * from where they lived inline in `RouteDeps` below.
 *
 * No consumer narrowed to this group this slice: `routes/admin/comments/deps.ts`'s
 * `CommentsModerationRouteDeps` already `Pick`s 3 of these 5 fields (`commentRepo`/
 * `commentWriteService`/`commentsSettingsReady`) alongside non-group fields (`settingsRepo`/
 * `principalRepo`) — composing the whole group would add `commentIngressPolicy`/`commentsReady`,
 * which that file's own 4 registrars never read, the same "would widen" case Slice 2 already
 * established for `ContentRouteDeps`/`SeoRouteDeps`. `comments/tool-registrations.ts`'s
 * `CommentsToolDeps` (reads 4 of the 5: everything but `commentIngressPolicy`) and `server/routes/
 * site/comments-submit.ts`'s `CommentsSubmitDeps` (reads only `commentIngressPolicy`) are both
 * declared structurally, deliberately never importing `RouteDeps`, to keep those modules free of a
 * back-edge into the composition root — importing this named type would reopen exactly the edge they
 * were written to avoid.
 */
export interface CommentsDeps {
  /** ADR-031/ADR-023 (SPEC-033) — the Comments bundled plugin's composed backend
   * (`comments/index.ts#createCommentsModule`). */
  commentRepo: CommentRepoPort;
  commentIngressPolicy: CommentIngressPolicy;
  commentWriteService: CommentWriteService;
  /** Fire-and-forget at boot (mirrors `newsletterReady`) — await (or, for the real server, go
   * through the ADR-046 Phase 2 boot lifecycle) before relying on the `p_comments__*` tables
   * existing. `server/app.ts`'s hermetic composition resolves this immediately (no dataModule
   * declare needed against an in-memory repo). */
  commentsReady: Promise<void>;
  /** SPEC-035 (ADR-028 Settings Layered Ledger wiring) — resolves once the 6 `comments.*` setting
   * definitions are registered (mirrors `seoReady`'s identical shape/convention). Chained AFTER
   * `seoReady` in both composition roots — the settings write chokepoint's `BEGIN IMMEDIATE`
   * transaction cannot tolerate two independent boot-time definition-registration chains racing
   * on the SAME SQLite connection (the same hazard `seoReady`'s own doc comment documents for
   * `settingsReady`). The comments admin settings routes (`routes/admin/comments/*-settings.ts`)
   * await this before reading/writing through the ledger. */
  commentsSettingsReady: Promise<void>;
}

/**
 * Slice 3 of the `RouteDeps` god-object decomposition (2026-08-18) — the `members` library's ports
 * (ADR-030), extracted verbatim (fields + doc comments unchanged) from where they lived inline in
 * `RouteDeps` below.
 *
 * Unlike the other three Slice-3 groups, this one had a real, exact, WHOLE-group consumer already:
 * `routes/admin/members/deps.ts`'s `MembersRouteDeps` re-declared these same 6 fields (plus its own
 * `magicLinkPerEmailLimiter`) via `extends RouteDeps` — a WIDENING pattern (the same historical shape
 * `routes/admin/integrations/deps.ts`'s pre-SPEC-034 `IntegrationsRouteDeps` used to have) from back
 * when these fields hadn't landed on `RouteDeps` directly yet. Its own header still claims "`src/
 * server/routes/types.ts` does not yet declare the `members` library's repo ports" — stale, since
 * ADR-030 wiring landed them directly on `RouteDeps` some time ago. That file now `extends RouteDeps,
 * MembersDeps` instead of re-typing the 6 fields a second time, and its header is corrected — see its
 * own doc.
 *
 * `routes/members/deps.ts`'s `MemberPublicRouteDeps` (the public sign-in route family) also reads all
 * 6 fields, but is deliberately left alone: it is declared fully structurally on purpose (no
 * `authorize`/session field at all, by ADR-030 §3 design — see its own header) and has never imported
 * anything from `routes/types.ts`; doing so now would tie a route family whose entire point is
 * staying decoupled from the admin composition root to this file, for a savings of six duplicated
 * field types.
 */
export interface MembersDeps {
  /** `members` library ports (ADR-030) — Members admin screen. */
  memberRepo: MemberRepoPort;
  memberTierRepo: MemberTierRepoPort;
  memberSubscriptionRepo: MemberSubscriptionRepoPort;
  memberSessionRepo: MemberSessionRepoPort;
  magicLinkRepo: MagicLinkTokenRepoPort;
  mailer: MailerPort;
}

/**
 * Slice 4 of the `RouteDeps` god-object decomposition (2026-08-18) — the ADR-041/ADR-045 database
 * recovery read surface: the Database Timeline's read port, the restore-points list/save side, the
 * dialect-neutral db-ops capability, this site's serving status, and Recovery's two lookup ports,
 * extracted verbatim (fields + doc comments unchanged) from where they lived inline in `RouteDeps`
 * below.
 *
 * A real, exact, WHOLE-group consumer already existed before this extraction:
 * `routes/admin/database-recovery/deps.ts`'s `DatabaseRecoveryRouteDeps` already `Pick`ed these same
 * 6 keys off `RouteDeps` (plus `workspaceId`/`authorize`/`clock`) for the 7 plain database/recovery
 * registrars. That file now composes `DatabaseRecoveryDeps` directly instead of re-listing the keys
 * a second time — see its own doc.
 *
 * `migrationRunsRepo`/`stampWatermark`/`databaseIntrospection`/`gatedMutations` are deliberately NOT
 * part of this group even though the original "Admin-UI backend-gap closure" header comment (still
 * attached to `stampWatermark` below) covers them too — `database-recovery/deps.ts`'s real consumer
 * never reads any of the four (its own header explicitly excludes the 2 gated-mutation ceremonies
 * that need `gatedMutations`), so pulling them in here would widen rather than narrow the one real
 * consumer this slice has. They remain candidates for a later, separate group.
 */
export interface DatabaseRecoveryDeps {
  /**
   * ADR-041 §1/§2 — the Database Timeline's read port, backed by the sidecar
   * `ops/database-journal.db` (`db/sqlite/database-journal-repo.ts`'s `SqliteDatabaseLedgerRepo`
   * in `server/deps.ts`'s real composition; `features/database/repo.memory.ts`'s
   * `InMemoryDatabaseLedgerRepo` in `server/app.ts`'s hermetic composition). Only the read side is
   * wired into `RouteDeps` this pass — see `routes/admin/database/timeline.ts`'s file header for
   * what remains unwired.
   */
  /** Widened this dispatch with `LedgerAppendPort` — both `SqliteDatabaseLedgerRepo` and
   * `InMemoryDatabaseLedgerRepo` already implement `.append()`; only the type declaration here was
   * narrower than the concrete instances (see `features/database/gated-hooks.ts`'s
   * `buildMigrateForwardHooks` and `features/recovery/gated-hooks.ts`'s `buildRestoreHooks`, which
   * need to append real ledger rows).
   * Widened again (2026-07-16, TM-adr041-043-044-045-audit-001, Finding 2 fix) with
   * `BootLedgerPort` — both concrete adapters already implement `appendInterruptedRow` too; only
   * this declaration was narrower. */
  databaseLedgerRepo: LedgerReadPort & LedgerAppendPort & BootLedgerPort;
  /** ADR-041 §2/§4 — the `restore_points` table's list + save side (`database/restore-points.ts`'s
   * new `RestorePointListPort`/`RestorePointSavePort`). Real `SqliteRestorePointsRepo` in
   * `server/deps.ts` (already built, previously unwired); in-memory in `server/app.ts`.
   * Widened with `RestorePointIdempotencyLookupPort` (AC-11 idempotency-key fix) — both concrete
   * repos already implement `findByIdempotencyKey`; only this declaration was narrower. */
  restorePointsRepo: RestorePointListPort & RestorePointSavePort & RestorePointIdempotencyLookupPort;
  /** SPEC-016 C-007 — the dialect-neutral restore-point capability/capture surface. Real
   * `SqliteDbOpsAdapter` in `server/deps.ts` (already built, previously unwired); a deterministic
   * in-memory double in `server/app.ts` (`features/database/repo.memory.ts`'s
   * `InMemoryDbOpsAdapter`). */
  dbOps: DbOpsPort;
  /** ADR-041 §3/§10 — this site's `SERVING`/`PENDING_MIGRATION`/`BLOCKED_PENDING_RECOVERY` status.
   * In-memory in both compositions, defaulted to `SERVING` — no composition root invokes
   * `features/database/boot/*`'s reconciliation functions at actual boot yet (disclosed gap, see
   * handoff), so this only ever changes if a future caller calls `.set()`. */
  siteStatusRepo: SiteStatusPort;
  /** ADR-045 §2 — Recovery's discarded-write-window baseline source. Always reports the baseline
   * as unavailable (`features/recovery/repo.memory.ts`'s `AlwaysUnavailableWatermarkSource`) — the
   * safe default per `disclosure.ts`'s own "never fabricate a zero count" rule, not a corner cut;
   * see that class's doc comment. */
  disclosureWatermarkSource: DisclosureWatermarkSourcePort;
  /** ADR-041 §7/ADR-045 §5 — re-resolves a `DatabaseContextEnvelope`'s carried `restorePointId`
   * server-side (`features/recovery/repo.memory.ts`'s `RestorePointDeepLinkLookup`, backed by the
   * same real `restorePointsRepo` list above). */
  deepLinkRestorePointLookup: DeepLinkRestorePointLookupPort;
}

/**
 * The full app-wide dependency bag every route handler and module-registration function historically
 * accepted whole, even when touching 1-2 fields (tracked architecture debt — "core size" / "propagation
 * cost" in `npm run check:architecture`). `ClockDeps`/`IdentityDeps`/`MediaDeps` (Slices 1-2),
 * `CredentialsDeps`/`ContentTaxonomyDeps`/`CommentsDeps`/`MembersDeps` (Slice 3),
 * `DatabaseRecoveryDeps` (Slice 4), `ComposioDeps` (Slice 5), `WebhooksDeps` (Slice 6),
 * `FormsDeps` (Slice 7), and `PostDeps`/`PresentationDeps`/`SettingsDeps`/`ChangeSetDeps`/
 * `EventBusDeps`/`AnalyticsDeps`/`NavigationDeps`/`DatabaseOpsDeps`/`RedirectsDeps`/
 * `CommerceCatalogDeps`/`WidgetsDeps`/`PluginRuntimeDeps` (Slice 8) above are an incremental
 * decomposition: pulled out as their own named, cohesive interfaces and folded back in here via
 * intersection so this type stays 100% identical to every existing consumer. Narrowed call sites so
 * far: `inbound/admin-http/dev-auth.ts`'s `requireAdminSession` and `assistant/byok-tool-surface.ts`'s
 * `createByokToolSurface` (Slice 1, to `ClockDeps`/`IdentityDeps`); `routes/admin/media/deps.ts`'s
 * `MediaRouteDeps` (Slice 2, to `MediaDeps`); the four `routes/admin/system/*-credentials.ts` files
 * (to a `Pick` of `CredentialsDeps`' fields) plus `routes/admin/members/deps.ts`'s
 * `MembersRouteDeps` (Slice 3, to `MembersDeps` directly); `routes/admin/database-recovery/deps.ts`'s
 * `DatabaseRecoveryRouteDeps` (Slice 4, to `DatabaseRecoveryDeps` directly);
 * `routes/admin/connectors/deps.ts`'s `ConnectorsRouteDeps`/`ConnectorsConfigRouteDeps` (Slice 5, to
 * `ComposioDeps`/a `Pick` of it); `routes/admin/integrations/deps.ts`'s `IntegrationsRouteDeps`
 * (Slice 6, to `WebhooksDeps` directly); and `routes/admin/forms/deps.ts`'s `FormsRouteDeps`
 * (Slice 7, to `FormsDeps` directly) — see those files' own docs.
 *
 * Slice 8 (2026-08-18) is the LAST slice: it groups every field that was still flat in the trailing
 * intersection object below, closing out this decomposition. No Slice-8 group has a single real
 * whole-group `Pick`/`extends` consumer yet — each group's own doc explains the domain-cohesion
 * rationale used instead (the same rationale `ContentTaxonomyDeps`/`CommentsDeps` already
 * established in Slice 3). A handful of fields deliberately stayed flat rather than join a group:
 * `workspaceRepo`/`chatHistory`/`webhookSigner`/`formsRateLimiter`/`siteAssistantRateLimiter` are
 * true singletons with no cohesive sibling (each already has a real narrow consumer via
 * `Pick<RouteDeps, ...>`, so leaving them flat costs nothing). `runExportSite`/`createSiteApp`/
 * `resolveStorefrontProducts` stay flat because their own types reference `RouteDeps` itself —
 * moving any of them into a named sub-interface closes a real circular-type reference TypeScript
 * rejects (a concrete `tsc` contravariance failure, confirmed before this slice started).
 * `exportOutputRootDir`/`deploymentsReadRepo`/`publishHistoryStore`/`publishExecutionMode`/
 * `publishOutputRootDir`/`publishCredentialVerificationCache`/`sourceControlExportRootDir` stay
 * flat too — out of scope for this slice alongside `features/deployments/`/`features/
 * source-control/`, which carry 7 already-diagnosed, unrelated violations this slice does not
 * touch.
 */
/**
 * Slice 5 of the `RouteDeps` god-object decomposition (2026-08-18) — the Composio connectors
 * domain (config repo + long-lived provider/service), extracted verbatim (fields + doc comments
 * unchanged) from where they lived inline in `RouteDeps` below.
 *
 * A real narrow consumer already existed before this extraction: `routes/admin/connectors/deps.ts`
 * declares TWO Composio-shaped types on the same axis media's `MediaRouteDeps` established —
 * `ConnectorsRouteDeps` (catalog routes, `composioConnectors` alone) and `ConnectorsConfigRouteDeps`
 * (the 2 config routes, both fields plus the shared ADR-058 sealer/keyring already in
 * `CredentialsDeps`). Both are rewired to compose `ComposioDeps` (or a `Pick` of it) instead of
 * re-declaring `composioConnectors`'s type inline.
 */
export interface ComposioDeps {
  /**
   * The workspace's sealed Composio project key + provisioned auth-config ids, backing the admin's
   * Settings → Connectors tab (`connectors/composio-config-store.ts`).
   *
   * Single-row per workspace, unlike `mediaProviderCredentialRepo` above — a workspace has one
   * Composio project, not a roster. Sealed with the same shared ADR-058 sealer/keyring as every
   * other credential table here. No matching `*Ready` promise: a plain table, usable as soon as
   * migrations run.
   */
  composioConfigRepo: ComposioConfigRepoPort;
  /**
   * The long-lived Composio provider + service the connectors routes read through.
   *
   * A live service rather than a repo because `ComposioConnectorProvider` owns in-process caches
   * and (for OAuth) pending-authorization state that must survive across requests — see
   * `connectors/composio-service.ts` for why it cannot be rebuilt per request.
   */
  composioConnectors: ComposioConnectors;
}

/**
 * Slice 6 of the `RouteDeps` god-object decomposition (2026-08-18) — the ADR-036 webhook
 * subscription/delivery persistence pair, extracted verbatim (fields + doc comments unchanged)
 * from where they lived inline in `RouteDeps` below.
 *
 * `webhookSigner` deliberately stays OUT of this group and flat on `RouteDeps` — its own doc
 * comment already discloses "Not consumed by any route yet", and `routes/admin/integrations/
 * deps.ts`'s real consumer (below) confirms it: `IntegrationsRouteDeps` never picks it.
 *
 * A real narrow consumer already existed before this extraction: `routes/admin/integrations/
 * deps.ts`'s `IntegrationsRouteDeps` already `Pick`ed these same 2 keys off `RouteDeps` (plus
 * `workspaceId`/`authorize`/`clock`/`idGen`/`originRegistry`) for the 5 admin integrations routes.
 * That file now composes `WebhooksDeps` directly instead of re-listing the 2 keys a second time —
 * see its own doc. `originRegistry` stays a separate `Pick<RouteDeps, "originRegistry">` there
 * rather than joining this group: it is redirects/origin-domain infrastructure reused here, not a
 * webhooks-owned field (see a later slice's `RedirectsDeps` for its home group).
 */
export interface WebhooksDeps {
  /** ADR-036 `webhook_subscriptions` persistence. */
  webhookSubscriptionRepo: WebhookSubscriptionRepoPort;
  /** ADR-036 `webhook_deliveries` persistence. */
  webhookDeliveryRepo: WebhookDeliveryRepoPort;
}

/**
 * Slice 7 of the `RouteDeps` god-object decomposition (2026-08-18) — the `forms` library's write
 * chokepoint repo pair (SPEC-010, ADR-PIPE-010), extracted verbatim (fields + doc comments unchanged)
 * from where they lived inline in `RouteDeps` below.
 *
 * `formsRateLimiter` deliberately stays OUT of this group and flat on `RouteDeps` — the original
 * header comment (still attached to it below) introduced all three together, but
 * `routes/admin/forms/deps.ts`'s real consumer (below) never reads it: the 7 admin forms routes this
 * type serves are session-gated, not the public rate-limited submission endpoint that field backs
 * (`routes/site/forms-submit.ts`, declared structurally, deliberately never importing `RouteDeps` —
 * the same back-edge-avoidance pattern `CommentsDeps`'s own doc already establishes for
 * `comments-submit.ts`).
 *
 * A real narrow consumer already existed before this extraction: `routes/admin/forms/deps.ts`'s
 * `FormsRouteDeps` already `Pick`ed these same 2 keys off `RouteDeps` (plus `workspaceId`/
 * `authorize`/`clock`/`idGen`/`changeSets`/`outbox`) for the 7 forms admin routes. That file now
 * composes `FormsDeps` directly instead of re-listing the 2 keys a second time — see its own doc.
 */
export interface FormsDeps {
  formDefinitionRepo: FormDefinitionRepoPort;
  formSubmissionRepo: FormSubmissionRepoPort;
  /** Moves a submission to the Trash — `bindRemoveEntity(trash, "form_submission")` at composition. */
  removeFormSubmission: RemoveFormSubmissionFn;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the `postRepo` write
 * chokepoint and its two siblings, extracted verbatim (fields + doc comments unchanged) from
 * where they lived inline in `RouteDeps` below.
 *
 * No single whole-group consumer: `routes/admin/content/deps.ts`'s `ContentRouteDeps` picks
 * `postRepo`/`pagesHtmlStore` (not `postSearch`) alongside many non-group fields; the
 * `content_post_search` agent tool (`features/post/tool-registrations.ts`) reads `postSearch`
 * alone. Grouped here on the doc comments' own "sibling of `postRepo`" cohesion rather than a
 * shared narrow consumer — the same rationale `ContentTaxonomyDeps`/`CommentsDeps` already used.
 */
export interface PostDeps {
  postRepo: PostRepoPort;
  /**
   * Ranked full-text search over posts/pages, backing the `content_post_search` agent tool.
   *
   * A sibling of `postRepo` rather than a method on it: `PostRepoPort` is a record store of exact
   * lookups whose in-memory adapter is three array scans, while this is a durable inverted index
   * with its own migration, sync obligation and backfill. See `features/post/search.ts` for the
   * full argument, and `search-index.sqlite.ts` for why the index carries only text while
   * workspace/kind/status/trash stay query-time filters on the live row.
   */
  postSearch: PostSearchPort;
  /**
   * SPEC-047/ADR-056 — builds the bespoke-HTML body store for one Page.
   *
   * A sibling of `postRepo`, never a method on it, and deliberately not reachable through the
   * ordinary Post/Page CRUD path: this is the ONLY writer of `body_format: "html"` rows anywhere
   * (CIC-3), and `createPost`/`updatePost` are structurally incapable of producing that shape. The
   * separation is the invariant, not a layering preference — see `features/pages/html-document-store.sqlite.ts`.
   *
   * A factory for the same reason `chatHistory` is one: composition closes over the `content.db`
   * handle so no route holds it, and every instance is bound to one `(workspaceId, postId)` pair.
   */
  pagesHtmlStore: PagesHtmlDocumentStoreFactory;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the presentation-settings
 * repo and the boot-discovered theme roster, extracted verbatim (fields + doc comments unchanged)
 * from where they lived inline in `RouteDeps` below.
 *
 * No single whole-group consumer, but real shared usage: `routes/admin/content/deps.ts`'s
 * `ContentRouteDeps` reads all three (`presentationRepo`/`themes` for `presentation/get.ts` and
 * `presentation/patch-active-theme.ts`; `themesDir` for `presentation/rescan-themes.ts`) alongside
 * many non-group fields — grouped here on that file's own field-by-field rationale rather than a
 * narrow Pick match.
 */
export interface PresentationDeps {
  presentationRepo: PresentationSettingsRepoPort;
  /** Themes discovered at boot (built-in + site themes/ dir), SPEC-004 spike. */
  themes: DiscoveredTheme[];
  /**
   * The themes root those themes were discovered under (`server/deps.ts`'s `builtInThemesDir()`).
   *
   * Threaded through as a dependency rather than re-derived where it is needed, because it is the
   * outer half of the `themes` agent-tool domain's containment check: `DiscoveredTheme.dir` says
   * where one theme lives, and this says which folders are allowed to contain a theme at all
   * (`features/theme/theme-files.ts`'s `isRecognizedThemeRoot`). Re-deriving it inside a feature
   * module would both invert the dependency and let a test/composition root that overrides
   * `TOVU_THEMES_DIR` disagree with the check enforcing it.
   */
  themesDir: string;
  /**
   * Design C (ADS-memory w4-theme-lifecycle-designs.md §5 / w6 dispatch, 2026-09-16) — the package's
   * own read-only stock themes root (`server/deps.ts`'s `builtInThemesDir()`), NOT `themesDir` above
   * (which is the SITE's own themes root in every real boot path except the hermetic one). Threaded
   * through so `features/theme/theme-files.ts`'s `resolveThemeOriginalSource` can fall back to the
   * package's own generated catalog (Design D, `sync-originals.ts`) when an already-seeded site has
   * no catalog original of its own for a theme — closing that gap for the seven shipped themes that
   * never had a hand-maintained original, without writing anything into the site.
   *
   * Optional and deliberately NOT backfilled onto every existing `RouteDeps` fixture: only the
   * SQLite composition root and the CLI install-dir boot supply it (both already call
   * `builtInThemesDir()` for `seedSiteThemes()`); every hand-built `RouteDeps`/`ContentRouteDeps`/
   * `ThemeToolDeps` test object and the hermetic in-memory composition root predate this field and
   * are unaffected — `resolveThemeOriginalSource` treats `undefined` as "no package fallback
   * configured," never as an error.
   */
  packageThemesDir?: string;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the settings ledger's repo
 * plus the `features/settings` function/constant bindings and the boot-registration `*Ready`
 * promise chain, extracted verbatim (fields + doc comments unchanged) from where they lived inline
 * in `RouteDeps` below.
 *
 * No single whole-group consumer — `routes/admin/settings/deps.ts`'s `SettingsRouteDeps` picks
 * `settingsReady`/`settingsRepo` (not the rest); `routes/admin/seo/deps.ts`'s `SeoRouteDeps` picks
 * `seoReady`/`settingsRepo`; `routes/admin/assistant/deps.ts`'s `AssistantSettingsRouteDeps` picks
 * `settingsRepo`/`getEffective`/`set`/`assistantSettingsReady` — each a different narrow subset.
 * Grouped here on domain cohesion instead (one ledger, one boot-registration chain — every `*Ready`
 * field's own doc comment says it is chained after the previous one on the same SQLite connection),
 * the same rationale `ContentTaxonomyDeps`/`CommentsDeps` already used for a shared-domain, no-single-
 * consumer group.
 */
export interface SettingsDeps {
  /**
   * SPEC-007 — the settings ledger's repo port. `core.commands.appliers`
   * (via `revert.ts`) reads through this now instead of
   * `PresentationSettingsRepoPort` (ADR-PIPE-007 Migration Safety); the
   * admin `settings.*` routes (Phase 5, not yet wired) will consume it too.
   */
  settingsRepo: SettingsRepoPort;
  /**
   * The real `features/settings`'s own `getEffective` — threaded through `RouteDeps` (rather than
   * each consumer importing it directly) so `assistant/public-assistant-settings.ts`'s
   * `GetPublicAssistantSettingsDeps` and `assistant/custom-instructions.ts`'s
   * `ResolveCustomInstructionsDeps` can receive it by injection instead of a static import — the
   * technique that keeps `settings` convertible to the standard tool-contribution registry without
   * closing an `[assistant, features/settings]` module cycle. `server/` already imports
   * `features/settings` directly and safely elsewhere in this file (`settingsRepo` above); this is
   * the same edge, just also threaded to the two `assistant/` files that need the FUNCTION.
   */
  getEffective: typeof getEffective;
  /** The real `features/settings`'s own `set` — see `getEffective`'s doc immediately above for why
   *  this is threaded through `RouteDeps` rather than imported directly by `assistant/
   *  public-assistant-settings.ts`'s `PublicAssistantSettingsWriteDeps`. */
  set: typeof set;
  /** The real `features/settings`'s own `INSTRUCTIONS_NAMESPACE` constant (`"core.instructions"`) —
   *  see `getEffective`'s doc above; threaded through so `assistant/custom-instructions.ts`'s
   *  `ResolveCustomInstructionsDeps` can receive it by injection instead of a static import. */
  instructionsNamespace: string;
  /**
   * Resolves once the one-time `migrateLegacyPresentationSettings()` boot
   * migration (SPEC-007 REQ-08) completes. Mirrors `identityReady`'s
   * fire-and-forget pattern (`identity/wiring.ts`): the composition roots
   * stay synchronous, and any settings-reading route/consumer should await
   * this before treating `settingsRepo` reads as post-migration-complete.
   */
  settingsReady: Promise<void>;
  /**
   * SPEC-008 (ADR-PIPE-008 Decision §3, T012) — resolves once the one-time
   * `ensureSeoSettingDefinitions()` boot call registers the 7 `site.seo.*`
   * setting definitions. Mirrors `settingsReady`'s exact shape/convention;
   * the admin `seo` settings routes (`get-settings.ts`/`put-settings.ts`)
   * await this first, same as `settings/get-effective.ts` awaits `settingsReady`.
   */
  seoReady: Promise<void>;
  /**
   * Resolves once the one-time `ensurePublicAssistantSettingDefinitions()` boot call registers the
   * `site.assistant.public_enabled` definition. Same shape and same convention as `seoReady` above,
   * and chained after it in both composition roots for the reason `seoReady`'s own comment in
   * `app.ts` gives: concurrent openers of the settings write chokepoint's transaction throw on the
   * SQLite root. The 2 admin assistant-settings routes await this before reading `settingsRepo`.
   */
  assistantSettingsReady: Promise<void>;
  /**
   * Resolves once the one-time `ensureExecutionSettingDefinitions()` boot call registers the 8
   * `core.execution.*` setting definitions backing the admin "Execution mode" tab (`@jini-ai/ui`'s
   * `ExecutionTab`). Same shape/convention as `assistantSettingsReady`, chained after it in both
   * composition roots for the identical transaction-hazard reason. Unlike the other three
   * `*Ready` bindings there is no dedicated execution-settings route today — the tab reads/writes
   * `core.execution.*` through the fully generic `settings/get-effective.ts`/`settings/set.ts`
   * routes (which only await the base `settingsReady`), so this promise currently has no route
   * consumer; it is still threaded through `RouteDeps` for the same discoverability/consistency
   * reason every other boot registration is, and so a future dedicated route has it available.
   */
  executionSettingsReady: Promise<void>;
  /**
   * Resolves once `ensureSettingsUiTabDefinitions()` registers the 9 definitions across
   * `core.instructions.*`, `core.notifications.*`, and `core.privacy.*` — the settings-dialog
   * tabs whose entire Tovu-side cost is ledger storage (no routes, no port). Chained after
   * `executionSettingsReady` in both composition roots for the same transaction-hazard reason
   * every other registration is, and likewise has no dedicated route consumer: all three tabs
   * read/write through the generic settings routes.
   */
  settingsUiTabsReady: Promise<void>;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the command-gateway change-set
 * store and its inverse-applier registry, extracted verbatim (fields + doc comments unchanged)
 * from where they lived inline in `RouteDeps` below.
 *
 * No single whole-group consumer: `routes/admin/content/deps.ts`'s `ContentRouteDeps` reads both
 * (`changeSets` for posts/pages create/update, `revertRegistry` for `change-sets/revert.ts`)
 * alongside many non-group fields. `routes/admin/plugins/deps.ts`'s `PluginsRouteDeps` also reads
 * `changeSets` alone (as a hand-typed shape, not a `Pick<RouteDeps>`). Grouped here on the fields'
 * own doc comments — `revertRegistry`'s says it is "closed over the SAME `postRepo`/`clock`/
 * `outbox` instances the rest of this bag already carries" alongside `changeSets` — the same
 * domain-cohesion rationale used where no narrow consumer exists.
 */
export interface ChangeSetDeps {
  /** Change-set store for the command gateway (in-memory in v1, ADR-008/018). */
  changeSets: ChangeSetRepoPort;
  /**
   * Inverse-applier registry for `changeset.revert` (ADR-018 C-005/C-006), pre-loaded with the
   * post-domain reverters (`features/post/reverters.ts`'s `createPostRevertRegistry`) by both
   * composition roots. `change-sets/revert.ts` reads this directly instead of calling
   * `defaultRevertRegistry()` itself — building the registry, closed over the SAME `postRepo`/
   * `clock`/`outbox` instances the rest of this bag already carries, is composition-root work, same
   * as every other concrete adapter selected here (2026-08-13 features-post-deep-import-trace.md
   * Job 2).
   */
  revertRegistry: RevertRegistry;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the outbox/event-bus pair,
 * extracted verbatim (fields + doc comments unchanged) from where they lived inline in `RouteDeps`
 * below.
 *
 * No single whole-group consumer, but a real shared call site: `routes/admin/content/deps.ts`'s
 * `ContentRouteDeps` reads both together (`posts/update.ts`'s `processOutbox({ outbox, bus, clock
 * })` drain call, per that file's own doc), alongside `routes/admin/workspace/deps.ts`'s
 * `WorkspaceRouteDeps` (`Pick<RouteDeps, ... | "outbox" | "bus">`) — the same outbox-drain pairing
 * repeats verbatim in a second, unrelated domain, which is the cohesion this group is built on.
 */
export interface EventBusDeps {
  outbox: OutboxPort;
  bus: EventBusPort;
}

/**
 * This task's own addition (2026-08-28) — the Constitution Article VIII observability seam. One
 * field, mirroring `EventBusDeps`'s own one-concern shape immediately above: every route/module
 * reads `RouteDeps.observability` through the `ObservabilityPort` interface only, never a concrete
 * adapter type (`platform/observability/ports.ts`'s file header explains why that boundary is the
 * whole point of the port). `server/runtime/composition/app.ts`'s hermetic `createRouteDeps()`
 * builds this with `createNoopObservabilityPort()`; `server/runtime/composition/deps.ts`'s
 * `createSqliteRouteDeps()` builds it with the env-driven `createObservabilityPort()` — the same
 * rule-of-two split every other adapter pair in this file already follows.
 */
export interface ObservabilityDeps {
  observability: ObservabilityPort;
  /**
   * `features/tool-audit`'s durable agent tool-attempt sink, BUILT BY THE COMPOSITION ROOT and
   * injected — not resolved by whichever module happens to want one. `server/deps.ts` builds
   * `new SqliteToolAttemptAuditSink(db)` over the SAME open `ContentDb` handle its other repos
   * already share; `server/app.ts`'s hermetic composition builds `createInMemoryToolAttemptAuditSink()`.
   * `modules/assistant-byok.ts` is the consumer. `agent-daemon-server.ts` is its own composition
   * root and reads this same field off the `RouteDeps` it already builds, so there is exactly one
   * construction per root rather than a hand-written copy per consumer.
   *
   * A PORT, replacing the `contentDbPath: string` this field superseded on 2026-09-06 (added hours
   * earlier by `b359e613`). Threading a path made every consumer call `openContentDb` itself, and
   * that function runs `migrate()` UNCONDITIONALLY (verified: `content-db.ts`'s `openContentDb`
   * calls `migrate` on every open) — so a module merely being CONSTRUCTED could migrate a database.
   * It also forced `server/app.ts`'s hermetic root, which owns no `content.db` file at all, to
   * publish a global default path it never opens; a root that has to fake a field is the tell that
   * the field is the wrong abstraction. Injecting the sink removes the `process.env` read, the
   * second handle, the deferral wrapper that existed only to postpone that handle, and the path
   * field, and leaves the consumer testable with a plain fake.
   */
  toolAttemptAuditSink: ToolAttemptAuditSink;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the public analytics ingest
 * buffer, its beacon config seam, and the matching boot-registration promise, extracted verbatim
 * (fields + doc comments unchanged) from where they lived inline in `RouteDeps` below.
 *
 * No route module in this codebase yet declares its own narrow analytics deps type — the admin
 * `analytics/recent-hits.ts` registrar and the public ingest route both take full `RouteDeps`
 * today. Grouped here on domain cohesion (ADR-035 ingest stage, ADR-046 boot registration) ahead
 * of a future narrow consumer, the same "candidate for a later group" precedent
 * `DatabaseRecoveryDeps`'s own doc already used for `stampWatermark`/`databaseIntrospection`.
 */
export interface AnalyticsDeps {
  /** Analytics ingest buffer (ADR-035 ingest-only stage; no rollup yet). ADR-046 Phase 1: durable
   * in real composition (`SqliteBufferSink`), in-memory in hermetic composition (`LocalBufferSink`). */
  analyticsSink: AnalyticsSinkPort;
  /**
   * The public analytics beacon's config seam (`analytics/config.settings.ts`'s
   * `createSettingsAnalyticsConfig`), backed by the `core.analytics.*` ledger definitions in both
   * composition roots. Replaces the former hardcoded stub `server/app.ts`'s `registerAnalyticsIngestRoute`
   * call used to build inline.
   */
  analyticsConfig: AnalyticsConfigPort;
  /**
   * Resolves once the one-time `ensureAnalyticsSettingDefinitions()` boot call registers the 6
   * `core.analytics.*` setting definitions backing `analyticsConfig`. Same shape/convention as
   * `settingsUiTabsReady`, chained after it in both composition roots for the identical
   * single-SQLite-connection-transaction reason every registration above documents.
   */
  analyticsSettingsReady: Promise<void>;
  /**
   * SPEC-050: resolves once `ensureSiteTitleSettingDefinition()` registers `core.site.title`, the
   * setting every public render reads through `resolveSiteTitle`, AND `preserveLegacySiteTitles()`
   * has pinned every workspace that existed before it. Chained after `analyticsSettingsReady` in both
   * composition roots for the same single-SQLite-connection transaction reason. `index.ts` and `serve`
   * await it before spawning the agent daemon, so the daemon's own boot never races the pin. A render
   * served before it settles never flips a pre-existing site: the resolver renders the legacy title
   * while that workspace's pin is pending (REQ-07).
   */
  siteTitleReady: Promise<void>;
  /** SPEC-050 (NC-3 = A): which workspaces existed before `core.site.title` and still wait for their pin. */
  siteTitlePreservationStore: SiteTitlePreservationStorePort;
  /**
   * SPEC-050 (NC-2 = B, REQ-13): `config.json` `name` of the served site directory, read at each
   * render that needs it, so a rename shows with no restart. Reads `undefined` when there is no site
   * directory (the title then falls back to `workspaces.name`).
   */
  siteDisplayName: SiteDisplayNameSource;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the navigation-owned menu
 * repo and its one real ADR-029 derived-index port, extracted verbatim (fields + doc comments
 * unchanged) from where they lived inline in `RouteDeps` below.
 *
 * No `routes/admin/menus/*.ts` file has its own narrow deps type today (all 6 registrars take full
 * `RouteDeps`); `routes/admin/content/deps.ts`'s `ContentRouteDeps` reads `menuRepo` alone (not
 * `navLocationBindingRepo`) for `template-preview.ts`'s theme-nav lookup. Grouped on the fields'
 * own ADR-029 pairing ahead of a future narrow menus consumer.
 */
export interface NavigationDeps {
  /** Local, navigation-owned menu repo (ADR-029; not a frozen ADR port). */
  menuRepo: MenuRepoPort;
  /** The one real ADR-029 port: the derived nav_location_bindings index. */
  navLocationBindingRepo: NavLocationBindingRepoPort;
  /** Bound at composition to the generic trash pipeline's `removeEntityWithoutBlocker` —
   *  `RemoveMenuFn`, not the broad `RemoveEntity`, same reasoning as `removeWidget` above. */
  removeMenu: RemoveMenuFn;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the database/gated-mutations
 * leftovers `DatabaseRecoveryDeps` (Slice 4) explicitly named as "candidates for a later group with
 * no single real narrow consumer yet", extracted verbatim (fields + doc comments unchanged) from
 * where they lived inline in `RouteDeps` below. This IS that later group.
 *
 * Admin-UI backend-gap closure (design-spec.md §0.4/§1.9/§2.8/§3.8/§4.8) — the read-side +
 * route-layer wiring the Web Design pass found missing across `content-types`, `entries`,
 * `taxonomy`, and (partially) `database`/`recovery`. Every field below is backed by an in-memory
 * adapter in BOTH `server/app.ts` and `server/deps.ts` (no SQLite adapter exists yet for
 * `content-types`/`entries`/`taxonomy` — the same disclosed "no adapter yet" precedent
 * `mediaRepo`/`transformDefinitionRepo`/`memberRepo` already establish), EXCEPT
 * `restorePointsRepo`/`dbOps` (moved to `DatabaseRecoveryDeps`, Slice 4), which get real
 * `db/sqlite/database-journal-repo.ts`/`db-ops.ts` adapters in `server/deps.ts`.
 *
 * (2026-08-18, Slice 3: the `content-types`/`entries`/`taxonomy` REPO fields this comment
 * originally introduced moved to `ContentTaxonomyDeps`. Slice 4: `restorePointsRepo`/`dbOps`/
 * `siteStatusRepo`/`disclosureWatermarkSource`/`deepLinkRestorePointLookup` moved to
 * `DatabaseRecoveryDeps`. Slice 8 (this pass): `migrationRunsRepo`/`stampWatermark`/
 * `databaseIntrospection`/`gatedMutations` — the 4 fields Slice 4 explicitly left behind — move
 * here. No single whole-group consumer exists yet: `routes/admin/taxonomy/deps.ts`'s
 * `TaxonomyRouteDeps` picks `stampWatermark` alone; the `taxonomy/terms/:id/merge`,
 * `database/migrate-forward`, and `recovery/restore` gated-mutation routes each read
 * `gatedMutations` directly against full `RouteDeps` (no narrow deps file); `migrationRunsRepo`/
 * `databaseIntrospection` back `features/database/boot/reconcile-interrupted-migration.ts` and
 * `features/database/adapter.sqlite.ts` respectively, neither with a route-level narrow consumer
 * today. Grouped on shared "database operations, no adapter/narrow-consumer yet" domain cohesion.)
 */
export interface DatabaseOpsDeps {
  /** ADR-041/043/044/045 re-audit (2026-07-16, TM-adr041-043-044-045-audit-001, Finding 2 fix) —
   * the `migration_runs` read side `reconcileInterruptedMigrationOnBoot` needs; previously
   * constructed nowhere (real SQLite adapter existed, unused; no in-memory double existed). */
  migrationRunsRepo: MigrationRunsRepoPort;
  /** Bumps `database_write_watermark` for taxonomy writes (create/rename/assign/delete). Real
   * `sqliteStampWatermark(db)` in `server/deps.ts` (the certified `stampWatermarkTx`, see
   * `core/gated-mutations/watermark.ts`); `noopStampWatermark` in `server/app.ts`'s in-memory
   * composition, which has no watermark table to advance. */
  stampWatermark: () => void;
  /** ADR-041 §3 — the `database_get_health`/`database_get_schema_state`/`database_list_pending_migrations`
   * agent tools' backing read port (`features/database/adapter.sqlite.ts`, closing the gap that
   * file's own catalog header previously disclosed as "no backing adapter composed into RouteDeps
   * yet"). Real `SqliteDatabaseIntrospectionAdapter` in `server/deps.ts` (reuses the same open
   * `ContentDb` handle `restorePointsRepo`/`dbOps` already share); `InMemoryDatabaseIntrospectionAdapter`
   * in `server/app.ts`'s hermetic composition. */
  databaseIntrospection: DatabaseIntrospectionPort;
  /**
   * SPEC-016 (`core/gated-mutations`'s gateway, ADR-041 §5) — composed into a real composition
   * root for the first time this dispatch. One process-lifetime `GatewayDeps` (in-process
   * `InMemoryTokenStore`, see `core/gated-mutations/composition.ts`'s file header for the disclosed
   * `TokenStorePort` decision) shared by every gated-mutation route this dispatch wires
   * (`taxonomy/terms/:id/merge`, `database/migrate-forward`, `recovery/restore`).
   */
  gatedMutations: { gatewayDeps: GatewayDeps };
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the `redirects` + `origin`
 * composition-root wiring (SPEC-009/ADR-PIPE-009), extracted verbatim (fields + doc comments
 * unchanged) from where they lived inline in `RouteDeps` below.
 *
 * No `routes/admin/redirects/*.ts` file has its own narrow deps type today (all 7 registrars take
 * full `RouteDeps`). `routes/admin/integrations/deps.ts`'s `IntegrationsRouteDeps` picks
 * `originRegistry` alone (deliberately kept a separate `Pick<RouteDeps, "originRegistry">` there —
 * see `WebhooksDeps`'s own Slice 6 doc — rather than joining `WebhooksDeps`, since it is
 * redirects/origin-domain infrastructure reused by that module, not webhooks-owned). Grouped here
 * on the fields' own single doc comment, which already introduces all 4 together as one feature's
 * composition-root wiring.
 */
export interface RedirectsDeps {
  /**
   * SPEC-009 / ADR-PIPE-009 — `redirects` + first-time `origin` composition-
   * root wiring. `redirectRepo`/`redirectHitSink` back the admin HTTP surface
   * (Phase 2) and the `phase-handler.ts` read path; `originRegistry` is the
   * single open-redirect/canonical-origin oracle (ADR-040), wired into the
   * composition root for the first time by this feature — no other library
   * had a real consumer for it before now. `redirectsWriteDeps` bundles the
   * write chokepoint's full dependency set (repo/db/transaction/matcher/
   * originRegistry/clock/idGen/outbox) — a single pre-built object rather
   * than exposing the package-private `RedirectDbHandle`/transaction-wrapper
   * types on this shared file (INV-07's chokepoint boundary stays {
   * `redirects.ts`, `capture.ts`, `ports.internal.ts` } — routes only ever
   * see the already-composed `RedirectsWriteDeps`, never the raw db handle).
   */
  redirectRepo: RedirectRepoPort;
  redirectHitSink: RedirectHitSink;
  originRegistry: OriginRegistryPort;
  redirectsWriteDeps: RedirectsWriteDeps;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the optional,
 * storefront-adjacent seams (the sample Tier-3 store plugin, the real commerce catalog read ports,
 * and the lipay payments plugin), extracted verbatim (fields + doc comments unchanged) from where
 * they lived inline in `RouteDeps` below.
 *
 * No route module has its own narrow deps type for any of these today (`routes/site/products.ts`/
 * `routes/site/payments-webhook.ts` both take full `RouteDeps`). Grouped here on the fields' own
 * cross-referencing doc comments — `commerceProductRepo`'s says "Optional, matching `store?:`
 * above's precedent" and `lipay`'s says "wired only by a composition root that has a real SQLite
 * handle, exactly like `store` above" — all four are optional, composition-root-gated,
 * storefront-facing seams that fall back gracefully when unset.
 */
export interface CommerceCatalogDeps {
  /** SPIKE: seam for the sample Tier-3 store plugin (data lives in plugin-owned `p_store__*`
   * tables). Optional — only the SQLite runtime wires it (see `index.ts`). */
  store?: {
    /** `slug` (readable-slugs S7): the product-detail link key — the plugin's `Product.slug`. */
    listProducts(): { id: string; slug: string; title: string; price: number; stock: number; version: number }[];
    checkout(
      productId: string,
      qty: number
    ):
      | { ok: true; orderId: string; remainingStock: number; retries: number }
      | { ok: false; reason: "not-found" | "out-of-stock" | "conflict"; retries: number };
  };
  /**
   * Commerce catalog read ports (2026-08-12: wiring products into template render data).
   * Optional, matching `store?:` above's precedent — the real running server's composition root
   * (`server/deps.ts`) wires both against the SAME `content.db` every other repo already uses (no
   * `declareDataModule()`/plugin bootstrap needed, unlike `store`/`lipay`); the hermetic
   * `server/app.ts` test composition leaves them unset, and `routes/site/products.ts` falls back
   * to `store?.listProducts()` when absent — never a hard dependency a test has to fake.
   */
  commerceProductRepo?: CommerceProductRepoPort;
  commercePriceRepo?: CommercePriceRepoPort;
  /**
   * The lipay payments framework plugin's composed API (`features/plugins/lipay`). Optional and
   * wired only by a composition root that has a real SQLite handle, exactly like `store` above —
   * lipay's tables come from `declareDataModule()`, which the in-memory composition has no
   * counterpart for. `routes/site/payments-webhook.ts` reads this lazily per request, so its route
   * can be registered ahead of the blanket body parser while activation still happens later.
   */
  lipay?: LipayApi;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the widgets domain's derived
 * projection repo, extracted verbatim (fields + doc comment unchanged) from where it lived inline
 * in `RouteDeps` below.
 *
 * Deliberately its own single-field group, not folded into `ContentTaxonomyDeps`: that interface's
 * own Slice 3 doc explicitly considered and rejected pulling `widgetBindingRepo` in alongside its
 * sibling `entryRefsRepo` — "`entryRefsRepo`... groups here per this slice's own field list rather
 * than with widgets" — leaving this exact field as the named candidate for its own group. No
 * `routes/admin/widgets/*.ts` file has a narrow deps type today (all 14 registrars take full
 * `RouteDeps`); the public site-render path (`routes/site/pages.ts` → `resolvePageWidgets`) does
 * too.
 */
export interface WidgetsDeps {
  /**
   * SPEC-043/ADR-047 (widgets) — the `widget_region_bindings` derived-projection repo
   * (`widgets/ports.ts`'s `WidgetRegionBindingRepoPort`, mirroring `NavLocationBindingRepoPort`
   * exactly). Consumed by both the admin `widgets` routes (region CRUD) and the public site-render
   * path (`routes/site/pages.ts` → `resolvePageWidgets`, W-004).
   */
  widgetBindingRepo: WidgetRegionBindingRepoPort;
}

/**
 * Slice 8 of the `RouteDeps` god-object decomposition (2026-08-18) — the SPEC-005 plugin-runtime
 * activation port, its pre-bound discovery/enable/disable closures, and the same process-lifetime
 * hook registry's content-facing port, extracted verbatim (fields + doc comments unchanged) from
 * where they lived inline in `RouteDeps` below.
 *
 * A real, near-exact consumer already exists: `routes/admin/plugins/deps.ts`'s `PluginsRouteDeps`
 * (a hand-typed shape, not a `Pick<RouteDeps>`, since that file predates this decomposition) already
 * declares `pluginActivationRepo`/`discoverPlugins`/`onPluginEnabled`/`onPluginDisabled` verbatim
 * alongside its own `workspaceId`/`authorize`/`clock`/`idGen`/`changeSets`/`outbox?`. Its own doc
 * comment says `discoverPlugins`/`onEnabled`/`onDisabled` are "pre-bound closures... the composition
 * root... builds these closures once and threads them through" — the same process-lifetime hook
 * registry `pluginBeforeSaveHook`'s doc calls "the same... hook registry's content-facing port",
 * which is why it joins this group rather than `ContentTaxonomyDeps`/`CommentsDeps` (it is a plugin
 * lifecycle hook, not a content-model repo).
 */
export interface PluginRuntimeDeps {
  /**
   * SPEC-005 (ADR-005-ARCH) — the `plugin_activations` persistence port (mirrors
   * `PresentationSettingsRepoPort` exactly, rule-of-two). Consumed by the `plugins` admin routes
   * (`PLUGINS_LIST`/`PLUGIN_SET_ENABLED`, REQ-10).
   */
  pluginActivationRepo: PluginActivationRepoPort;
  /**
   * SPEC-005 (ADR-005-ARCH) — pre-bound `discoverPlugins()` closure (install dir / built-in
   * registry already captured by the composition root). Phase 1 of this feature ships zero
   * built-in plugins (the `word-count` dogfood plugin is a later, gated phase per this feature's
   * own tasks.md), so this closure legitimately reports an empty built-in set today; the route
   * surface itself does not know or care how many plugins exist.
   */
  discoverPlugins: () => Promise<readonly PluginDiscoveryRecord[]>;
  /** BR-01/BR-05 lifecycle callbacks built once by the composition root and shared by the HTTP
   * and agent-tool enable paths. Failures reject the enable operation. */
  onPluginEnabled: (pluginId: string) => Promise<void>;
  onPluginDisabled: (pluginId: string) => void;
  removePlugin: RemovePluginFn;
  /** 2026-09-13 — pre-bound, read-only, bounded listing of one discovered plugin's own files
   * (`PLUGIN_FILES`). Path safety lives in the binding (`plugin-runtime.ts`) and
   * `features/plugin-runtime/package-files.ts`; the route only authorizes and resolves the record. */
  readPluginPackageFiles: (record: PluginDiscoveryRecord) => Promise<PluginPackageFiles>;
  /** The same process-lifetime hook registry's content-facing port. */
  pluginBeforeSaveHook: BeforeSaveHookPort;
  /** Fire-and-forget at boot (mirrors `commentsReady`) — resolves once every plugin durably marked
   * `enabled` has been re-attached to THIS process's hook registry (P0a fix: a fresh process starts
   * with an empty in-memory registry, so a plugin enabled before a restart would otherwise silently
   * stop firing until an operator re-toggled it). Await (or, for the real server, go through the
   * ADR-046 Phase 2 boot lifecycle) before relying on a previously-enabled plugin's hook running. */
  pluginRuntimeReady: Promise<void>;
}

/**
 * The destination's complete deny-store capability. Only composition code receives this writer;
 * `core.ts` narrows it to `list` before handing anything to the publishing request middleware.
 */
export interface PublishTrustRevocationDeps {
  publishTrustRevocations: PublishTrustRevocationPort;
}

/**
 * The local admin Trash (design: `ADS-memory/reports/2026-09-20-trash-delete-architecture.md`).
 *
 * `trash` is the whole port, read by the Trash screen's own routes. The `remove*` fields are
 * the SAME service pre-bound to one entity type each, and they are what the delete paths receive —
 * a delete path takes exactly one of them and therefore cannot address another domain's entities by
 * passing the wrong string. Each performs the marker flip AND the Trash index write as one
 * transaction; there is deliberately no field here that does only half of it.
 *
 * Pre-bound per domain rather than a `removeFor(entityType)` lookup at the call site, because a
 * lookup puts a typo-able string in every route and defers a wiring mistake to runtime.
 */
export interface TrashDeps {
  trash: TrashPort;
  // `RemovePostFn`, not the broad `RemoveEntity`: `deletePost` (`features/post/post.ts`) declares its
  // own narrower structural type with no `"blocked"` branch (post has no `TrashBlockerSpec`, T1). The
  // composition root narrows `bindRemoveEntity`'s wider result to match (`removeEntityWithoutBlocker`
  // in `deps.ts`/`app.ts`) so this field's promise is actually kept.
  removePost: RemovePostFn;
  removeComment: RemoveEntity;
  // `RemoveMediaFn`, not the broad `RemoveEntity` — same reasoning as `removePost` above:
  // `media_trash_asset` (`features/media/tool-registrations.ts`) declares its own narrower
  // structural type with no `"blocked"` branch (media has no `TrashBlockerSpec`, T1).
  removeMedia: RemoveMediaFn;
  removeRedirect: RemoveEntity;
  // `RemoveWidgetFn`, not the broad `RemoveEntity` — same reasoning as `removePost` above:
  // `trashWidgetInstance` (`features/widgets/ports.ts`) declares its own narrower structural type
  // with no `"blocked"` branch (widget has no `TrashBlockerSpec`, T1).
  removeWidget: RemoveWidgetFn;
  /**
   * Media alone needs this pair: its ladder has a HUMAN hard-purge rung of its own
   * (`routes/media/delete.ts`, gated by `media.delete.force`) that removes the row outside the
   * Trash screen, so the index row has to be dropped with it. See {@link ForgetRemovedEntity}.
   */
  forgetRemovedMedia: ForgetRemovedEntity;
  /**
   * Posts need it for a different reason than media: nothing removes a post row outside the Trash
   * screen, but two paths UNDO a delete after its transaction has already committed — the command
   * gateway's `rollback` (the change-set record failed to persist) and `post/delete`'s
   * `EntityReverter` (an operator reverting the recorded change set). Either one that clears the
   * marker without this leaves a live, published post listed in the Trash and selectable for
   * permanent deletion. See {@link ForgetRemovedEntity}.
   */
  forgetRemovedPost: ForgetRemovedEntity;
  /**
   * One pass of the 60-day auto-purge backstop, pre-bound to this composition's repo and adapters.
   *
   * A function rather than the repo-plus-adapters the sweep needs, for the same reason the
   * `remove*` fields are pre-bound: `RouteDeps` is handed to every route, and a route that could
   * reach `TrashRepoPort` directly could delete an index row without touching the entity.
   * `server/runtime/composition/serving-app.ts` is the only caller — it owns the timer.
   */
  sweepTrash: TrashSweepOnce;
  /**
   * Whether this composition registered a Trash adapter for `entityType`: a read of the live adapter
   * map, on every call, never a list captured once. `trash_item` checks it before it touches
   * anything, so a model-supplied kind the Trash cannot hold is refused rather than trusted.
   *
   * A predicate rather than the map: the adapters carry `purge`, and nothing handed to every route
   * may reach a hard delete.
   */
  isTrashableEntityType: (entityType: string) => boolean;
  /**
   * `TRASHABLE`, built once at composition from the live schema module (`registry.ts`). Read by
   * `moveToTrash` (the generic `POST .../trash/items` route) and by `permissions.ts`'s
   * `trashPermissionFor`/`mayActOnEntityType`/`filterVisibleTrashItems`, which `list.ts`/`restore.ts`/
   * `purge.ts` already call with this same deps object — one field serves both concerns. Named to
   * match `TrashRouteDeps.registry` exactly, since `RouteDeps` is passed there unchanged.
   */
  registry: TrashRegistry;
  /** The dialect-neutral DB port `moveToTrash` reads the entity's live display/version through —
   *  same instance `deps.ts` used to build every registry-derived `TrashAdapter`. Named to match
   *  `TrashRouteDeps.db`. */
  db: TrashDb;
}

export type RouteDeps = ClockDeps & IdentityDeps & MediaDeps & CredentialsDeps & ContentTaxonomyDeps & CommentsDeps & MembersDeps & DatabaseRecoveryDeps & ComposioDeps & WebhooksDeps & FormsDeps & PostDeps & PresentationDeps & SettingsDeps & ChangeSetDeps & EventBusDeps & AnalyticsDeps & NavigationDeps & DatabaseOpsDeps & RedirectsDeps & CommerceCatalogDeps & WidgetsDeps & PluginRuntimeDeps & ObservabilityDeps & PublishTrustRevocationDeps & TrashDeps & {
  workspaceRepo: WorkspaceRepoPort;
  /**
   * Durable AI chat history, obtained per-principal.
   *
   * A factory rather than a store, because there is no such thing as "the" chat store — every
   * query must be filtered by who is asking. Composition closes over the `content.db` handle so
   * no route ever holds one, which is what makes an unscoped `WHERE id = ?` unwritable rather
   * than merely against convention. See `assistant/persistence/tenant-scope.ts`.
   */
  chatHistory: ChatStoreFactory;
  /**
   * Per-(conversation, agent) agent-CLI session id (`assistant_agent_sessions`, migration `0051`),
   * so `agent-daemon-server.ts`'s `onStarted` can resume the underlying CLI session across chat
   * turns instead of spawning cold every time. Unlike `chatHistory` this is not per-principal
   * scoped: the daemon process has no `ChatPrincipal` to scope by (it decodes only `principalId`
   * from `contextRef`), and a conversation's session id carries no content of its own to protect —
   * see `assistant/persistence/agent-session-store.ts`.
   */
  agentSessions: AgentSessionStore;
  /**
   * ADR-036 §5 outbound HMAC signer. ADR-PIPE-015 Phase 1: built via `createKeyringBackedSigner`
   * over a real `KeyringPort` (`server/deps.ts`'s composition uses `EnvOrFileKeyring`;
   * `server/app.ts`'s hermetic test/dev composition uses the in-memory `InMemoryKeyring` test
   * double instead, to avoid touching real files/env in tests). Not consumed by any route yet —
   * the delivery worker is the first real consumer, and its activation stays gated behind
   * ADR-PIPE-015's Phase 4 "point of no return" until the real signer, guarded transport, and
   * SQLite adapters are all merged and code-reviewed.
   */
  webhookSigner: WebhookSigner;
  /**
   * `forms` library ports (SPEC-010, ADR-PIPE-010 — mirrors the existing
   * `webhookSubscriptionRepo`/`webhookDeliveryRepo` field-addition precedent). `formsRateLimiter`
   * is a single, process-lifetime `createRateLimiter({ profile: FORMS_SUBMIT_PROFILE, clock })`
   * instance (not constructed per-request) so its fixed-window counters persist across requests.
   *
   * (2026-08-18, Slice 7: `formDefinitionRepo`/`formSubmissionRepo` moved to the new `FormsDeps`
   * interface above, matching `routes/admin/forms/deps.ts`'s real narrow consumer; this field stays
   * here since that consumer never reads it — see `FormsDeps`'s own doc.)
   */
  formsRateLimiter: RateLimiter;
  /**
   * SPEC-046 REQ-7 — the public site assistant's own rate limiter, mirroring `formsRateLimiter`'s
   * shape exactly: a single, process-lifetime `createRateLimiter({ profile: SITE_ASSISTANT_PER_IP,
   * clock })` instance (not constructed per-request), keyed by `resolveClientIp(req)` in
   * `modules/site-assistant.ts`.
   */
  siteAssistantRateLimiter: RateLimiter;
  /**
   * 2026-08-15 — the deployments feature's READ side (`features/deployments/read-repo.ts`),
   * backing the admin Full Site tab's `GET .../deployments` route
   * (`routes/admin/deployments/list.ts`). Real `SqliteDeploymentsReadRepo` in `server/deps.ts`
   * (migration `0037` already applied — see that repo's own doc); `InMemoryDeploymentsReadRepo`
   * in `server/app.ts`'s hermetic composition, same rule-of-two every other repo here follows.
   * No write methods on the port yet — see `features/deployments/index.ts`'s header for why.
   */
  deploymentsReadRepo: DeploymentsReadRepoPort;
  /**
   * Task 6 of the publish-content (Publish Content) feature (`ADS-memory/reports/
   * 2026-09-18-publish-feature-implementation-plan.md` §2/§4 task 6) — staged-bundle storage for
   * `POST .../publish-content/bundles`, backing `publish_content_bundles` (migration `0066`).
   * Real `SqlitePublishContentBundleRepo` in `server/runtime/composition/deps.ts`'s
   * `createSqliteRouteDeps()`; `InMemoryPublishContentBundleRepo` in `server/runtime/composition/
   * app.ts`'s hermetic `createRouteDeps()` — same rule-of-two every other repo here follows.
   */
  publishContentBundleRepo: PublishContentBundleRepoPort;
  /**
   * `publish-files-plan-2026-09-24.md` §3 — the process-wide address book a file-tree `pack()`
   * (today only `features/theme/publish-content.ts`'s theme walker) fills as it hashes files on
   * disk, so a blob that lives only on disk (never copied into the media blob store) can still be
   * served (`routes/publish-content/blob-get.ts`) and pushed (`routes/publish-content/
   * peer-transport.ts`) via `createCompositePeerBlobSource`. ONE `createFileBlobIndex()` instance
   * per composition root, held for the process lifetime like `publishContentBundleRepo` above —
   * never rebuilt per request, or a `pack()`'s fills would be invisible to the very next read.
   */
  fileBlobIndex: FileBlobIndexPort;
  /**
   * Task 7 of the publish-content (Publish Content) feature (`ADS-memory/reports/
   * 2026-09-18-publish-feature-implementation-plan.md` §2/§4 task 7) — per-peer sync memory for
   * `publish_content_baselines` (migration `0066`), read by `gated-hooks.ts`'s `planImport()`
   * wiring. Real `SqlitePublishContentBaselineRepo` in `server/runtime/composition/deps.ts`'s
   * `createSqliteRouteDeps()`; `InMemoryPublishContentBaselineRepo` in `server/runtime/
   * composition/app.ts`'s hermetic `createRouteDeps()` — same rule-of-two every other repo here
   * follows.
   */
  publishContentBaselineRepo: PublishContentBaselineRepoPort;
  /**
   * Task 8 of the publish-content (Publish Content) feature — the real apply seam
   * (`gated-hooks.ts#PublishContentApplyPort`). Both composition roots bind
   * `createPublishContentApplyPort()`.
   */
  publishContentApplyPort: PublishContentApplyPort;
  /**
   * D1 (publish-types-plan §6) — this destination's seed-version lookup
   * (`features/publish-content/seed-hash.ts`): the hash an entity had in the stock
   * `content.seed.db` this instance was hydrated from. Passed to BOTH the import route's planner and
   * `publishContentApplyPort`'s apply-time re-verification, so they agree on what counts as
   * "untouched since seed". Real seed-backed lookup in `composition/deps.ts`;
   * `NO_PUBLISH_CONTENT_SEED_HASH` in the hermetic `composition/app.ts`, which ships no seed.
   */
  publishContentSeedHash: PublishContentSeedHashFn;
  /**
   * Task 8 of the publish-content (Publish Content) feature — the apply loop's audit trail
   * (`publish_content_runs`, migration `0066`). Exposed on `RouteDeps` (rather than only closed over
   * inside the `publishContentApplyPort` factory) because a test needs to read a run row back
   * directly — same rule-of-two both composition roots follow for every other repo here.
   */
  publishContentRunRepo: PublishContentRunRepoPort;
  /**
   * Task 10 of the publish-content (Publish Content) feature (`ADS-memory/reports/
   * 2026-09-18-publish-feature-implementation-plan.md` §4 task 10) — named remote Tovus this
   * workspace can push to or pull from (`publish_content_peers`), with their API keys sealed at
   * rest under the same shared ADR-058 sealer/keyring every other credential table here uses.
   * Real `SqlitePublishContentPeerRepo` in `server/runtime/composition/deps.ts`'s
   * `createSqliteRouteDeps()`; `InMemoryPublishContentPeerRepo` in `server/runtime/composition/
   * app.ts`'s hermetic `createRouteDeps()` — same rule-of-two every other repo here follows.
   */
  publishContentPeerRepo: PublishContentPeerRepoPort;
  /**
   * Task 10's outbound push/pull leg — a guarded `HttpClientPort` of its own, built from
   * `createPublishContentPeerEgressPolicy()` rather than any policy an existing consumer uses. See
   * that factory's own doc for why: it is the only policy in this codebase whose `devHostAllowlist`
   * is operator-configurable (`TOVU_PUBLISH_CONTENT_DEV_HOSTS`), because a legitimate peer may sit
   * on a private network on Railway, Render, AWS or a bare VPS.
   */
  publishContentPeerHttpClient: HttpClientPort;
  /**
   * The static-site export engine (`src/platform/export/site-exporter.ts`'s `exportSite`), injected here
   * rather than imported directly by `export-site.ts` or `features/deployments/export-run.ts`
   * (shared by that route AND the `deployment_trigger_export` agent tool). The indirection began as
   * a REQUIRED fix for THOSE two consumers, not a style choice: an eager import of `exportSite`
   * inside `features/deployments/export-run.ts` used to close a real cycle back into the
   * still-loading `assistant/tool-registrations.ts` and crash with `ReferenceError: Cannot access
   * 'DOMAIN_SLICES' before initialization`. Both halves of that cycle are gone as of 2026-09-16, and
   * the injection now stays for a different reason — it keeps `features/deployments` off the export
   * engine's whole graph at all (see `export-run.ts`'s file header, which owns the full trace).
   * Always the real `exportSite` in both `server/app.ts`'s `createRouteDeps()` and
   * `server/deps.ts`'s `createSqliteRouteDeps()` — the two places safe to import
   * `#src/platform/export/index` directly, since neither is reachable from `assistant/tool-registrations.ts`.
   * Typed structurally via `ExportEngine`, imported `type`-only (erased, zero runtime edge) so this
   * field costs this file nothing even though `export-run.ts` sits under `features/`.
   *
   * 2026-09-05 (fix-cycle) — the "site-exporter.ts imports createApp from THIS file" claim this doc
   * used to open with stopped being true on 2026-08-16 (generalized 2026-08-20): `site-exporter.ts`
   * boots the app via the injected `createSiteApp` field below instead, so it no longer imports
   * `server/app.ts` at all. `server/app.ts`'s own `createRouteDeps()` now builds its `runExportSite` /
   * `exportSiteBound` from a plain static `import { exportSite } from "#src/platform/export/index"`
   * (see that file's `runExportSite` const doc for the full verification) rather than the lazy
   * `require()` this doc previously described — "safe to import directly" is no longer just a
   * standing option, `server/app.ts` now does it. `server/deps.ts`'s SQLite composition root followed
   * on 2026-09-16 (t91 F4.1-A): its call-time `require()` built the export engine and site app from a
   * SECOND tsx module graph, so that root binds both from static imports now too.
   */
  runExportSite: ExportEngine<RouteDeps>;
  /**
   * `TOVU_EXPORT_DIR` env, then `<cwd>/infra/export` — the export engine's default output directory
   * root, read ONCE at boot by `server/app.ts`'s `createRouteDeps()`/`server/deps.ts`'s
   * `resolveExportOutputRootDir()` (via `createSqliteRouteDeps()`) rather than re-read deep inside
   * `features/deployments/export-run.ts`'s `startExportRun` or `cli/commands/export.ts`'s
   * `runExportCommand` — same "read once at the root, thread the value down" discipline `themesDir`
   * above already establishes for `TOVU_THEMES_DIR`. `cli/commands/export.ts`'s own `--out` flag
   * still takes precedence over this field where a caller supplies one; this field IS the
   * env-then-default fallback both callers share.
   */
  exportOutputRootDir: string;
  /**
   * What THIS process is actually serving, read ONCE at boot by `server/app.ts`'s
   * `createRouteDeps()`/`server/deps.ts`'s `createSqliteRouteDeps()` — same "read once at the root,
   * thread the value down" discipline `exportOutputRootDir`/`themesDir` above establish for their
   * own env-derived values.
   *
   * Before this field existed, `routes/system/sites.ts` and `sites_duplicate_site`
   * (`features/sites/tool-registrations.ts`) each called `platform/site-dir`'s
   * `describeSiteBinding()`/read `process.cwd()` fresh, independently, at REQUEST time rather than
   * receiving the value the composition root already resolved at BOOT time. The two agree for every
   * boot path that resolves the served site from `{cwd, env}` (the default boot, and desktop's
   * `TOVU_SITE_DIR`) — `describeSiteBinding()` is a pure, cheap re-derivation of the identical
   * inputs, so calling it twice was harmless there. They silently DISAGREE for `tovu serve <dir>`:
   * `cli/commands/serve.ts` resolves the served site directly from the CLI's `<dir>` argument
   * (`bootSiteDir`), never touching `TOVU_SITE_DIR`/`TOVU_SITE`, so a bare `describeSiteBinding()`
   * call re-derives an unrelated `<process.cwd()>/sites/tovu-com` instead — reporting the wrong site
   * as "currently serving" and, for the Sites-switcher's write operations, targeting the wrong
   * `sites/` tree entirely (2026-09-06 composition-root fix). `cli/commands/serve.ts` supplies this
   * field explicitly (`switcherCompatible: false` — see that flag's own doc); every other boot path
   * falls back to `describeSiteBinding()`, an unchanged default.
   */
  siteBinding: SiteBinding;
  /**
   * Where `features/site-backup`'s `site_backup_plan` reads this site's files from: the site folder
   * (`siteBinding.dir`), and the SAME uploads, themes, agent-plugins and skills roots this process
   * serves them from, plus the Tovu version stamped into the backup's manifest. Resolved once by
   * `server/runtime/composition/deps.ts`'s `createSqliteRouteDeps()`.
   *
   * Optional because the in-memory `server/app.ts` runtime has no site folder on disk; both
   * site-backup tools then answer `UNAVAILABLE` instead of backing up nothing.
   */
  siteBackupSources?: SiteBackupSources;
  /**
   * `TOVU_ADMIN_ASSISTANT` off switch, read ONCE at boot (`admin-assistant-enabled.ts`'s
   * `isAdminAssistantEnabled()`) by both composition roots — `server/app.ts`'s `createRouteDeps()`
   * and `server/deps.ts`'s `createSqliteRouteDeps()` — same "read once at the root, thread the
   * value down" discipline `exportOutputRootDir` above establishes for its own env var.
   *
   * `app.ts`'s own module-mounting code reads this SAME field (not a second `isAdminAssistantEnabled()`
   * call) to decide whether to mount the four gated admin-assistant modules, so the value a client
   * observes here can never disagree with which routes are actually live.
   *
   * The one route consumer is `routes/assistant/get-settings.ts`, which folds this into its response
   * alongside the (unrelated) public-assistant switch it already returns — see that route's own doc
   * for why: `modules/assistant-settings.ts` is one of exactly two admin-assistant modules mounted
   * UNCONDITIONALLY, so it is the one place the admin SPA can learn the flag is off without the
   * request itself 404ing.
   */
  adminAssistantEnabled: boolean;
  /**
   * Boots a real `Express` app — the SAME factory `server/app.ts` exports as `createApp`, injected
   * here rather than imported directly by `src/platform/export/site-exporter.ts` (`exportSite` needs to boot
   * an in-process copy of the app to crawl it over real HTTP — see that file's own header). A direct
   * `require("../server/app")` there was the one runtime edge closing `export -> server` (2026-08-16
   * architecture audit: dependency-cruiser flagged module cycle, propagation cost measured at 29.05%
   * with the edge present vs 9.43% with only this one edge removed). Mirrors `runExportSite`'s
   * injection precedent immediately above — always the real `createApp` in both `server/app.ts`'s
   * `createRouteDeps()` (direct same-file reference) and `server/deps.ts`'s `createSqliteRouteDeps()`
   * (a static import since 2026-09-16, t91 F4.1-A; the call-time `require()` it replaced built the
   * site app from a second tsx module graph that saw none of the live registries — the resulting
   * `deps.ts` <-> `app.ts` cycle is recorded in `.dependency-cruiser.mjs`'s `no-circular` header).
   * Both composition roots bind this field statically now — see `server/app.ts`'s own matching
   * `createSiteApp` field for the identical closure-ordering reasoning.
   *
   * NULLARY (`() => Express`), not `(routeDeps: RouteDeps) => Express` — 2026-08-20 RouteDeps-
   * narrowing fix, same shape and same day as `exportSiteBound` below. Before this change,
   * `export/site-exporter.ts`'s own `ExportSiteOptions.routeDeps` field had to be typed `RouteDeps`
   * just to have something to pass into this field's call (`routeDeps.createSiteApp(routeDeps)`),
   * which was a real, genuine "god type" back-edge (`check:architecture`'s `backEdgesIntoServer`
   * metric, not a location-only one like `ClockDeps`'s — verified by grep: `createSiteApp` field had
   * exactly ONE reader, `site-exporter.ts:657`, and no per-call argument this file's `routeDeps` isn't
   * already the right one for). Bound as `() => createApp(routeDeps)` in both composition roots,
   * closed over the SAME `const routeDeps` binding `exportSiteBound` already closes over — see the
   * TEST GOTCHA note on `exportSiteBound` below, now generalized to cover this field too.
   */
  createSiteApp: () => Express;
  /**
   * The SAME `resolveStorefrontProducts` (`server/routes/site/products.ts`) `/products` and
   * `/products/:id` render with, injected here for `export/route-manifest.ts` to reuse (2026-08-16,
   * export<->server decoupling edge 2 — see `ADS-memory/reports/2026-08-16-export-edge-decoupling.md`).
   * NOT moved down into `features/commerce` the way `resolveActiveTheme`/`resolveActiveThemeId` were:
   * its return type, `SiteProduct` (`server/http/site/render.ts`), is DELIBERATELY off-limits to
   * `features/commerce` — see `features/commerce/storefront.ts`'s own file header ("`features/commerce`
   * does not import `SiteProduct` or anything from `server/http/site`... `server/routes/site/
   * products.ts` is what bridges the two"). Moving this function would violate that existing,
   * documented boundary, so injection (mirroring `createSiteApp` immediately above) is the correct
   * shape here, not a fallback taken for lack of trying — measured, not assumed.
   *
   * NULLARY (`() => Promise<SiteProduct[]>`), not `(routeDeps: RouteDeps) => ...` — same 2026-08-20
   * fix and same reasoning as `createSiteApp` immediately above: this field had exactly ONE reader
   * (`route-manifest.ts:183`), which always called it with its own already-current `deps`, never a
   * different one — so a per-call `routeDeps` argument bought nothing except forcing `RouteDeps` into
   * every caller's own type. `export/route-manifest.ts`'s own `RouteManifestDeps` declares this field
   * against a minimal local `{id, title}` product shape rather than importing `SiteProduct` itself —
   * return-type covariance means the real, wider `SiteProduct[]` still satisfies it with no cast; see
   * that file's own doc for why importing `SiteProduct` there would just relocate this back-edge
   * rather than remove it.
   */
  resolveStorefrontProducts: () => Promise<SiteProduct[]>;
  /**
   * The same `resolveActiveThemeId` (`features/presentation/active-theme-id.ts`) the live public
   * routes resolve the active theme with, injected here for `platform/export/route-manifest.ts` to
   * reuse — mirroring `resolveStorefrontProducts`/`createSiteApp` immediately above, but for a
   * different reason: `resolveActiveThemeId` has no `server/**`-only type to avoid (unlike
   * `SiteProduct`), the issue is purely module direction. `route-manifest.ts` lives under
   * `platform/`, a foundation-layer module `features/presentation` itself depends on (via
   * `platform/db`); a direct import the other way would close a `platform <-> features/presentation`
   * runtime cycle (`check:architecture` module-cycle regression, 2026-09-03). NULLARY, closed over
   * the same `const routeDeps` binding `createSiteApp`/`resolveStorefrontProducts` already close
   * over — `resolveActiveThemeId`'s own `ActiveThemeIdResolutionDeps` (`presentationRepo`/
   * `workspaceId`) is a subset of `RouteDeps`, so `routeDeps` satisfies it with no cast.
   */
  resolveActiveThemeId: () => Promise<string>;
  /**
   * The same `listPublishedPosts` (`features/post/post.ts`) the live public routes render
   * posts/pages with, injected here for `platform/export/route-manifest.ts` to reuse — same
   * module-direction reason as `resolveActiveThemeId` immediately above:  `features/post` depends on
   * `platform` (via `platform/db`, `platform/routing`), so `route-manifest.ts` importing it directly
   * would close a `platform <-> features/post` runtime cycle. NULLARY, closed over the same `const
   * routeDeps` binding; `listPublishedPosts({ deps: { repo: routeDeps.postRepo }, input: {
   * workspaceId: routeDeps.workspaceId } })` is bound once at each composition root rather than
   * re-threading `postRepo`/`workspaceId` as two more `RouteManifestDeps` reads at the call site.
   */
  listPublishedPosts: () => Promise<{ posts: PostRecord[] }>;
  /**
   * 2026-08-16 rework of the original flat-JSON-file design (see `static-publish/publish-history.ts`'s
   * own header) — the append-only `publish_history` table backing `deployment_get_static_publish_capabilities`'s
   * `lastPublish` field. Real `SqlitePublishHistoryStore` (`db/sqlite/publish-history-repo.sqlite.ts`)
   * in `server/deps.ts`; `InMemoryPublishHistoryStore` in `server/app.ts`'s hermetic composition, same
   * rule-of-two every other repo/port here follows. `static-publish/publish-run.ts`'s
   * `startPublishRun`/`runPublishAndAwait` both take a `PublishHistoryStore` as a required
   * (non-defaulted) parameter — `publish-site.ts` and `publish-agent-tools.ts` pass this field
   * straight through rather than either one constructing its own instance.
   */
  publishHistoryStore: PublishHistoryStore;
  /**
   * 2026-08-15 (Contract v2) — this install's `PublishExecutionMode`, read once at boot from
   * `TOVU_EXECUTION_MODE` (`publish-credentials/execution-mode.ts`'s `executionModeFromEnv`) in BOTH
   * composition roots. Governs `composePublishCredentialSource`'s env-var-fallback behavior
   * (`"self-hosted-cli"` only — see that function's own doc) and is echoed verbatim in the
   * `GET .../publish/credentials` response so the admin UI can show self-hosted-vs-hosted-appropriate
   * guidance without re-deriving it client-side.
   */
  publishExecutionMode: PublishExecutionMode;
  /**
   * `TOVU_PUBLISH_DIR` env, then `<cwd>/infra/publish` — the static-publish flow's parent output
   * directory, read ONCE at boot by `server/app.ts`'s `createRouteDeps()`/`server/deps.ts`'s
   * `resolvePublishOutputRootDir()` (via `createSqliteRouteDeps()`), same "read once at the root"
   * discipline `exportOutputRootDir` above establishes. `static-publish/adapter.ts`'s
   * `publishOutputDir` joins this with the target id to get the per-target directory it actually
   * exports into — never re-reads `process.env` itself.
   */
  publishOutputRootDir: string;
  /**
   * 2026-08-16 — cached, non-secret provider-verification results for `publishCredentialSetRepo`'s
   * (or the env-var fallback's) credentials, keyed by `(workspaceId, target)`. Fixes "ready means a
   * row exists, not a working credential" (`deployments/static-publish/verify.ts`'s own header has
   * the full incident/design trail): `deployment_get_static_publish_capabilities`
   * (`publish-agent-tools.ts`) only ever calls `.get()` on this — a plain in-memory lookup, never a
   * decrypt, never a network call, so a read tool stays fast and cannot leak a credential. Only
   * `verifyPublishCredential` (called from `publish-credentials.ts`'s admin route, a human-gated
   * write surface, never an agent tool) ever calls `.set()`/`.delete()`. ONE shared
   * `InMemoryPublishCredentialVerificationCache` instance in both composition roots — same
   * app-wide-singleton reasoning `siteAssistantSecretSealer` above already establishes, so a result
   * cached from one request is visible to the next.
   */
  publishCredentialVerificationCache: PublishCredentialVerificationCache;
  /**
   * `TOVU_SOURCE_CONTROL_EXPORT_DIR` env, then `<cwd>/infra/source-control-export` — the
   * `source-control` domain's own export scratch directory (deliberately separate from
   * `exportOutputRootDir`/`publishOutputRootDir` above so no two of these features ever race over
   * the same on-disk output — see `features/source-control/commit-site.ts`'s header), read ONCE at
   * boot by `server/app.ts`'s `createRouteDeps()`/`server/deps.ts`'s
   * `resolveSourceControlExportRootDir()` (via `createSqliteRouteDeps()`). `commit-site.ts`'s
   * `commitExportDir` joins this with the provider subdirectory (`"github"`) — never re-reads
   * `process.env` itself.
   */
  sourceControlExportRootDir: string;
  /**
   * A pre-bound `exportSite` call — the SAME real export engine `runExportSite` above wraps, closed
   * over this exact `RouteDeps` object at construction time (`server/app.ts`'s `createRouteDeps()`/
   * `server/deps.ts`'s `createSqliteRouteDeps()`), so a caller supplies only `{outputDir; clean?;
   * basePath?}` — never a `routeDeps` argument.
   *
   * 2026-08-20 RouteDeps-narrowing fix, added specifically for `features/source-control/commit-site.ts`'s
   * `commitSiteToSourceControl` and `features/deployments/static-publish/adapter.ts`'s
   * `publishStaticSite`: both used to take `routeDeps: RouteDeps` directly (needing the full
   * composition-root bag to run a real `exportSite` pass immediately before committing/publishing),
   * which forced every caller up their own chain — `SourceControlToolDeps`, `StaticPublishToolDeps` —
   * to name `RouteDeps` too, the exact "god type" back-edge
   * `development/scripts/check-architecture.ts`'s `feature-no-express-or-admin-imports` rule exists to
   * catch. This field lets those two callers take a small, locally-typed function instead (each
   * declares its own structural copy — see `commit-site.ts`'s `ExportSiteBoundFn` — never importing
   * `RouteDeps` to describe it).
   *
   * DELIBERATELY NOT the same field as `runExportSite` above, and not merely renamed — the two have
   * genuinely different call shapes and mixing them up is a real, `tsc`-invisible bug (a `routeDeps`
   * field silently ignored, or a required one silently missing), not a style choice. `runExportSite`
   * stays `ExportEngine<RouteDeps>` (takes `routeDeps` per call) because `export-site.ts`'s POST route
   * and `features/deployments/export-run.ts`'s `startExportRun` are already generic over it and have
   * no reason to change; this field exists for the two callers that need the OPPOSITE shape — no
   * `routeDeps` parameter at all, because it is already closed over here.
   *
   * Bound as `(opts) => exportSite({ ...opts, routeDeps })` in both composition roots — `routeDeps`
   * spread LAST, deliberately, so a caller who forwards an unrelated `routeDeps` field through `opts`
   * (e.g. by naively passing an `ExportEngine`-shaped options object straight through, which DOES carry
   * one) can never overwrite the real, closed-over `RouteDeps` this binding exists to guarantee. See
   * `features/deployments/tool-registrations.ts`'s own `deployment_trigger_export` handler and its
   * regression test for the exact failure this ordering (and that handler's own explicit destructuring)
   * closes.
   *
   * TEST GOTCHA (live-found, `source-control/__tests__/commit-site.unit.test.ts`): this closure is
   * bound to ONE object identity, at construction time, inside `createRouteDeps()`/
   * `createSqliteRouteDeps()`. A test that overrides another field the real `exportSite` reads
   * internally (e.g. `createSiteApp`, to force one route/asset to fail) by SPREADING a copy —
   * `{ ...createRouteDeps(), createSiteApp: fake }` — produces a logically-overridden but DIFFERENT
   * object; this closure still points at the ORIGINAL, so the override silently never applies. The
   * fix is to MUTATE the same object in place — `const deps = createRouteDeps(); deps.createSiteApp =
   * fake;` — since a closure's field reads happen at CALL time against whatever object identity it
   * captured, not a snapshot of that object's properties at capture time. `sourceControlExportRootDir`/
   * `idGen`/every other field `SourceControlToolDeps`/`StaticPublishToolDeps` read directly (not
   * through this closure) has no such gotcha — only fields the real `exportSite` reads INSIDE this
   * closure's own call are affected.
   *
   * GENERALIZED (2026-08-20, RouteDeps-narrowing pass 2): `createSiteApp` and
   * `resolveStorefrontProducts` immediately above were converted to this SAME closure-bound-at-
   * construction-time shape (nullary, no `routeDeps` parameter) the same day, for the same "one
   * reader, no per-call argument it needs" reason this field was. They carry the IDENTICAL gotcha —
   * both are bound as `() => realFn(routeDeps)` inside `createRouteDeps()`/`createSqliteRouteDeps()`,
   * closed over that one object identity, so a spread-copy override of either is exactly as silently
   * inert as a spread-copy override of `createSiteApp` used to be for THIS field's own call. The
   * general rule, stated once here rather than re-derived per field: **any `RouteDeps` field whose
   * value is a function bound by closure at construction time — as opposed to a field the closure's
   * own body reads fresh off `routeDeps` at call time — must be overridden by mutating the object
   * `createRouteDeps()`/`createSqliteRouteDeps()` returned, never by spreading it into a copy.** As of
   * this pass that set is `exportSiteBound`, `createSiteApp`, and `resolveStorefrontProducts`; check
   * this doc first before assuming a new closure-shaped field is safe to spread-override.
   */
  exportSiteBound: (options: { outputDir: string; clean?: boolean; basePath?: string }) => Promise<ExportReport>;
};

export type RouteRegistrar = (app: Express, deps: RouteDeps) => void;
