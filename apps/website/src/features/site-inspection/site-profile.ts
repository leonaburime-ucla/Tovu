// 2026-09-12 (optional themes) — the no-theme sentinel, imported rather than re-spelled locally.
// This module otherwise imports nothing, which is deliberate for `RouteDeps` (see `deps.ts`'s
// header on the structural-declaration discipline) but was never a rule about VALUES: a second
// literal spelling of "no theme" here is exactly the drift that discipline exists to prevent.
import { NO_THEME_ID, themeIdCandidates } from "../theme/index.js";

import {
  authorizeAndCollectSection,
  DEFAULT_SECTION_TIMEOUT_MS,
  resolveRequestedSections,
  type CollectedSection,
  type InspectionAuthorizeFn,
  type InspectionSection,
  type InspectionSectionStatus,
} from "./section-collector.js";

/**
 * @file `buildSiteProfile()` — the ONE implementation of "what does this site currently look like",
 * shared by the `site_get_profile` agent tool and the `GET /api/admin/v1/workspaces/:workspaceId/
 * site/profile` admin route. Neither adapter owns any aggregation logic of its own.
 *
 * Why a shared service and not "just a tool" (2026-08-26 swarm-consensus decision, see
 * `AI-Dev-Shop/ADS-memory/reports/swarm-consensus/runs/2026-08-26T005706Z-consensus-report.md`):
 * `apps/admin` is a browser bundle and cannot invoke an agent tool. If the tool owned the
 * aggregation, the frontend would need a second implementation — and this codebase has ALREADY
 * produced exactly that divergence once, in settings (`settings_get_effective` is implemented
 * independently in `@jini-ai/cms/settings`'s tool registrations and in
 * `server/routes/admin/settings/get-effective.ts`, and the two drifted on principal handling).
 *
 * ---------------------------------------------------------------------------
 * Two properties this module is built to hold. Both are STRUCTURAL, not conventions.
 * ---------------------------------------------------------------------------
 *
 * **1. Per-section authorization, never one blanket permission.**
 * Tovu's domain tools and admin routes authorize INSIDE their own handlers (see
 * `features/theme/tool-registrations.ts`'s header: "nothing in `theme.ts`/`theme-files.ts` accepts
 * an `authorize` dependency ... every handler below does the same via the kit's
 * `requireToolPermission`"). An aggregator gated on a single permission would therefore be a real
 * privilege-escalation bypass around every one of those per-domain gates: one assistant-level grant
 * would become a shortcut around `settings.read`, `admin.plugins.read`, and the rest. So each
 * section here is authorized against the SAME permission string its own domain already uses
 * ({@link SITE_PROFILE_SECTION_PERMISSIONS}), and a denial marks that ONE section `forbidden`
 * rather than failing the whole call — a caller with 4 of 5 permissions gets 4 sections and an
 * explicit, non-silent `forbidden` marker on the fifth. Silently omitting a denied section would be
 * worse than refusing it: a compliance consumer must be able to tell "not permitted to look" apart
 * from "looked, found nothing".
 *
 * **2. Secrets are unrepresentable, not redacted.**
 * {@link SiteProfileDeps} names only read ports for pages, themes, presentation, settings,
 * content-types and plugin activation. It cannot reach `external-mcp-store.ts` (`sealedEnv`),
 * `connectors/connector-credential-store.ts` (`sealed`), `byok-credential.ts`,
 * `site-credential-store.ts`, `execution-credential-store.ts`, or `vendor-credentials` — those
 * modules are not imported here and there is no dep field that could carry one. Leaking a secret
 * from this file therefore requires ADDING A DEPENDENCY, which is a compile-time event a reviewer
 * sees in the diff, rather than a runtime event a `redactSecrets: boolean` flag fails open on.
 * Every DTO below is likewise built by NAMING FIELDS — never by spreading a domain record — so a
 * new field appearing on `PostRecord`/`ThemeManifest`/`PluginDiscoveryRecord` upstream cannot
 * silently appear in this response. This mirrors
 * `server/routes/admin/system/deployment-overview.ts`'s `{ name, set }` precedent: report presence,
 * never a value.
 *
 * ---------------------------------------------------------------------------
 * Deliberate non-features
 * ---------------------------------------------------------------------------
 * - **No cache.** The agent daemon is a separate OS process with its own SQLite handle over the
 *   same WAL file (`server/agent-daemon/agent-daemon-server.ts`), so a process-local memo would
 *   produce two caches that disagree — and the agent path is where staleness is most dangerous (an
 *   agent edits a page, re-reads a cached profile predating its own write, and concludes the edit
 *   failed). Under `TOVU_DB=memory` the two processes do not even share a database. The fan-out is
 *   a handful of indexed reads against an LLM round trip that dominates by orders of magnitude.
 * - **Not a transactionally consistent snapshot.** Sections read SQLite, in-memory boot state and
 *   the filesystem; `capturedAt` is when the call started, not a database point-in-time.
 * - **Config truth, not render truth.** This says what is CONFIGURED. It cannot prove what a
 *   visitor actually receives — that is `fetch_published_page`'s job (`published-page.ts`), a
 *   deliberately separate evidence plane.
 */

/** Every section this profile can report. The array is the closed vocabulary the `sections`
 *  parameter, the permission map and the response shape all derive from — add a section by adding
 *  it here and the compiler names every place that must be updated. */
export const SITE_PROFILE_SECTION_NAMES = ["pages", "theme", "plugins", "settings", "contentTypes"] as const;

export type SiteProfileSectionName = (typeof SITE_PROFILE_SECTION_NAMES)[number];

/**
 * The permission each section is authorized against — the SAME string that domain's own tool/route
 * already uses, reused rather than invented:
 * - `pages` -> `content.read` (`features/pages/agent-tools.ts`)
 * - `theme` -> `theme.set` (`features/theme/agent-tools.ts`'s `THEME_READ_PERMISSION`)
 * - `plugins` -> `admin.plugins.read` (`features/plugin-runtime/agent-tools.ts`,
 *   `server/routes/admin/plugins/list.ts`)
 * - `settings` -> `settings.read` (`@jini-ai/cms/settings`'s `settings_get_effective`)
 * - `contentTypes` -> `admin.collections.read` (`server/routes/admin/content-types/list.ts`)
 *
 * A NEW aggregate permission was deliberately NOT minted: a caller who may not read settings must
 * not become able to read them by asking a different door, and a fresh `site.profile.read` grant
 * would be exactly that door.
 */
export const SITE_PROFILE_SECTION_PERMISSIONS: Readonly<Record<SiteProfileSectionName, string>> = {
  pages: "content.read",
  theme: "theme.set",
  plugins: "admin.plugins.read",
  settings: "settings.read",
  contentTypes: "admin.collections.read",
};

/** Why a section carries no data — `section-collector.ts`'s {@link InspectionSectionStatus}, shared
 *  with `site_describe_capabilities`. A compliance consumer must read `forbidden` and `unavailable`
 *  as "unable to assess", never as a pass. */
export type SiteProfileSectionStatus = InspectionSectionStatus;

/** One profile section — `section-collector.ts`'s {@link InspectionSection}; see its field docs. */
export type SiteProfileSection<T> = InspectionSection<T>;

/** JSON a setting value can be. Structural, so the DTO stays serializable by construction. */
export type SiteProfileJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly SiteProfileJsonValue[]
  | { readonly [key: string]: SiteProfileJsonValue };

/** One page/post row, field-by-field. Deliberately carries NO body: `bodyJson`/`bodyHtml` are whole
 *  document payloads, and a snapshot of every page's body is a context bomb that would degrade the
 *  very reasoning this profile feeds. An agent fetches one body at a time via `pages_read_html`. */
export interface SiteProfilePageSummary {
  id: string;
  title: string;
  slug: string;
  kind: string;
  status: string;
  bodyFormat: string;
  updatedAt: string;
}

export interface SiteProfilePages {
  /** Rows that exist after trash filtering — NOT `items.length`, which the cap may have shortened. */
  total: number;
  countsByKind: Record<string, number>;
  countsByStatus: Record<string, number>;
  items: SiteProfilePageSummary[];
}

export interface SiteProfileThemeSummary {
  id: string;
  name: string;
  version: string;
  tier: string;
  source: string;
  status: string;
  /** Count only — the messages themselves are `theme_list`'s job, not this snapshot's. */
  errorCount: number;
}

export interface SiteProfileTheme {
  /** The configured id, straight from presentation settings. `null` when nothing is configured. */
  activeThemeId: string | null;
  /**
   * The configured theme's own row, when it is among the discovered themes. `null` when the
   * configured id names nothing discovered — a real, reportable misconfiguration this field makes
   * visible rather than papering over with the render-time fallback (`resolveActiveTheme`).
   *
   * `null` means TWO different things; {@link SiteProfileTheme.themeDisabled} is what tells them
   * apart. Read this field alone and a site whose operator turned the theme off looks exactly like
   * a site whose theme was deleted.
   */
  active: SiteProfileThemeSummary | null;
  /**
   * `true` when the operator turned the theme off deliberately (`activeThemeId` is the no-theme
   * sentinel). This is a CHOICE, not drift — a profile reader that treats every `active: null` as a
   * misconfiguration would report a problem that does not exist on these sites, which is worse than
   * silence because it trains the reader to ignore the field.
   */
  themeDisabled: boolean;
  installed: SiteProfileThemeSummary[];
}

export interface SiteProfilePluginSummary {
  id: string;
  name: string;
  version: string;
  source: string;
  tier: string | null;
  status: string;
  /** Activation state for THIS workspace only; `false` when no activation row exists. */
  enabled: boolean;
}

/** One inventory-safe setting. `value` is the effective value; `configured` says whether the
 *  setting resolved at all (a definition that has never been registered reports `false`, `null`). */
export interface SiteProfileSettingSummary {
  namespace: string;
  key: string;
  configured: boolean;
  value: SiteProfileJsonValue;
  /** `true` when the value serialized larger than {@link MAX_SETTING_VALUE_CHARS} and was dropped. */
  truncated?: boolean;
}

export interface SiteProfileContentTypeSummary {
  key: string;
  label: string;
  status: string;
  version: number;
  fieldCount: number;
}

export interface SiteProfile {
  schemaVersion: "1";
  /** When the call STARTED. Not a database point-in-time — see this file's header. */
  capturedAt: string;
  /** `partial` when any REQUESTED section came back non-`ok`. Never inferred by the caller. */
  completeness: "complete" | "partial";
  sections: {
    pages?: SiteProfileSection<SiteProfilePages>;
    theme?: SiteProfileSection<SiteProfileTheme>;
    plugins?: SiteProfileSection<SiteProfilePluginSummary[]>;
    settings?: SiteProfileSection<SiteProfileSettingSummary[]>;
    contentTypes?: SiteProfileSection<SiteProfileContentTypeSummary[]>;
  };
}

// ---------------------------------------------------------------------------
// Ports — the entire dependency surface. Nothing credential-bearing is nameable here.
// ---------------------------------------------------------------------------

/** The subset of a post row this profile reads. `PostRecord` is a structural superset. */
export interface SiteProfilePostRow {
  id: string;
  title: string;
  slug: string;
  kind: string;
  status: string;
  bodyFormat: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** The subset of a discovered theme this profile reads. `DiscoveredTheme` is a structural superset. */
export interface SiteProfileThemeRow {
  manifest: { id: string; name: string; version: string; tier: string };
  source: string;
  status: string;
  errors: readonly string[];
}

/** The subset of a discovery record this profile reads. `PluginDiscoveryRecord` is a superset. */
export interface SiteProfilePluginRow {
  id: string;
  name: string;
  version: string;
  source: string;
  tier?: string | undefined;
  status: string;
}

/** The subset of an activation row this profile reads. `PluginActivationRecord` is a superset. */
export interface SiteProfilePluginActivationRow {
  pluginId: string;
  workspaceId: string;
  enabled: boolean;
}

/** The subset of a content-type row this profile reads. `ContentTypeRecord` is a superset. */
export interface SiteProfileContentTypeRow {
  key: string;
  label: string;
  status: string;
  version: number;
  fields: readonly unknown[];
  tombstonedAt?: string | null;
}

/** `authorize()`'s shape — `section-collector.ts`'s structural {@link InspectionAuthorizeFn}, so this
 *  module still names only what it reads. `AuthorizeFn` satisfies it directly. */
export type SiteProfileAuthorizeFn = InspectionAuthorizeFn;

/**
 * Every dependency `buildSiteProfile` has. Each field is a narrow read port bound by an ADAPTER
 * (`site-profile-deps.ts`) from the composition root's deps bag — deliberately NOT the deps bag
 * itself, so this signature enumerates exactly what the profile can reach and a reader can check
 * the secret-safety claim by reading this one interface.
 */
export interface SiteProfileDeps {
  workspaceId: string;
  authorize: SiteProfileAuthorizeFn;
  clock: { nowIso(): string };
  listPosts(): Promise<readonly SiteProfilePostRow[]>;
  listThemes(): Promise<readonly SiteProfileThemeRow[]>;
  readActiveThemeId(): Promise<string | null>;
  listPlugins(): Promise<readonly SiteProfilePluginRow[]>;
  listPluginActivations(): Promise<readonly SiteProfilePluginActivationRow[]>;
  /** One effective setting value, or `null` when the definition does not resolve. */
  readSetting(input: { namespace: string; key: string }): Promise<SiteProfileJsonValue | null>;
  listContentTypes(): Promise<readonly SiteProfileContentTypeRow[]>;
}

export interface BuildSiteProfileOptions {
  /** Which sections to collect. Omitted/empty means all of {@link SITE_PROFILE_SECTION_NAMES}. */
  sections?: readonly SiteProfileSectionName[] | undefined;
  /** Page rows to include, capped at {@link MAX_PAGE_ITEMS}. Defaults to {@link DEFAULT_PAGE_ITEMS}. */
  pageLimit?: number | undefined;
  /** Per-section wall clock before the section is marked `unavailable`/`timed-out`. */
  sectionTimeoutMs?: number | undefined;
}

/** Default page rows returned. Small on purpose: the constraint is LLM context tokens, not
 *  database milliseconds, and `total`/`countsBy*` already answer "how big is this site". */
export const DEFAULT_PAGE_ITEMS = 50;

/** Hard ceiling on page rows regardless of `pageLimit`. `PostRepoPort.list()` has no limit
 *  parameter, so the underlying read is O(N) in the workspace's row count no matter what — this
 *  caps the RESPONSE, which is the cost that actually matters here. */
export const MAX_PAGE_ITEMS = 200;

/** A setting value serializing beyond this is reported as `truncated` with `value: null` rather
 *  than inlined. Bounds a single misconfigured JSON setting from dominating the whole snapshot. */
export const MAX_SETTING_VALUE_CHARS = 2_000;

/** Default per-section wall clock. Owned by `section-collector.ts`; re-exported here under the name
 *  this module has always published. */
export { DEFAULT_SECTION_TIMEOUT_MS };

/**
 * The inventory-safe settings this profile reports, as an explicit allowlist of `(namespace, key)`
 * pairs — never "every registered setting".
 *
 * Two reasons it is an allowlist rather than an enumeration:
 * 1. `@jini-ai/cms/settings` refuses `secret: true` definitions today
 *    ("secret:true definitions are not supported in the core-only subset"), but this boundary must
 *    not depend on that staying true forever. An allowlist stays correct if it changes.
 * 2. A plugin or a future capability can register arbitrary namespaces. Enumerating them would put
 *    third-party configuration into an LLM's context with nobody having decided it belongs there.
 *
 * Every entry below is a first-party, non-credential display/SEO setting registered by this repo's
 * own boot path (`features/settings/migration.ts`, `seo/settings.ts`).
 */
export const INVENTORY_SAFE_SETTINGS: readonly { namespace: string; key: string }[] = [
  { namespace: "core.presentation", key: "activeThemeId" },
  { namespace: "site.seo", key: "title_template" },
  { namespace: "site.seo", key: "default_description" },
  { namespace: "site.seo", key: "default_og_image" },
  { namespace: "site.seo", key: "twitter_site" },
  { namespace: "site.seo", key: "default_robots_noindex" },
  { namespace: "site.seo", key: "default_robots_nofollow" },
  { namespace: "site.seo", key: "sitemap_enabled" },
  { namespace: "site.seo", key: "robots_rules" },
];

/**
 * Authorizes ONE profile section against {@link SITE_PROFILE_SECTION_PERMISSIONS}, then collects it,
 * through `section-collector.ts`'s shared mechanism (also used by `site_describe_capabilities`).
 *
 * Every profile section goes through this one binding of the permission map, so no section can be
 * added without its own gate. `authorize()` runs BEFORE `collect` is ever called, so a denied section
 * performs no read at all.
 *
 * @param deps - The profile's dependency bag (supplies `authorize` and `workspaceId`).
 * @param spec.principalId - Who is asking.
 * @param spec.section - Which section, used to look up its permission.
 * @param spec.timeoutMs - Per-section wall clock.
 * @param spec.collect - The section's own read, invoked only after authorization passes.
 * @returns An `ok` section on success, `forbidden` on denial, `unavailable` on throw/timeout.
 * Never throws: one broken section must not fail the other four.
 * @complexity O(1) plus one `authorize()` call plus `collect`'s own cost.
 * @example
 * await authorizeAndCollect(deps, { principalId: "p1", section: "theme", timeoutMs: 5000, collect: () => collectTheme(deps) });
 */
function authorizeAndCollect<T>(
  deps: SiteProfileDeps,
  spec: {
    principalId: string;
    section: SiteProfileSectionName;
    timeoutMs: number;
    collect: () => Promise<CollectedSection<T>>;
  },
): Promise<SiteProfileSection<T>> {
  return authorizeAndCollectSection({
    authorize: deps.authorize,
    workspaceId: deps.workspaceId,
    principalId: spec.principalId,
    section: spec.section,
    permission: SITE_PROFILE_SECTION_PERMISSIONS[spec.section],
    entityType: "site-profile-section",
    logLabel: "site-profile",
    timeoutMs: spec.timeoutMs,
    collect: spec.collect,
  });
}

/** Tally of one field's values across rows — the `countsBy*` maps' single implementation.
 *  @complexity O(N) in `rows`. */
function tally<T>(rows: readonly T[], pick: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = pick(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Field-by-field page projection. Never spreads the row — see this file's header. */
function toPageSummary(row: SiteProfilePostRow): SiteProfilePageSummary {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    bodyFormat: row.bodyFormat,
    updatedAt: row.updatedAt,
  };
}

/** Field-by-field theme projection. Never spreads the manifest — a `ThemeManifest` carries
 *  build-provenance and font fields this snapshot has no consumer for. */
function toThemeSummary(row: SiteProfileThemeRow): SiteProfileThemeSummary {
  return {
    id: row.manifest.id,
    name: row.manifest.name,
    version: row.manifest.version,
    tier: row.manifest.tier,
    source: row.source,
    status: row.status,
    errorCount: row.errors.length,
  };
}

/**
 * Collects the `pages` section: every non-trashed post/page row, counted in full and sampled to
 * `limit`.
 *
 * Counts come from the FULL row set while `items` is capped, so "this site has 4,000 pages" stays
 * true even when only 50 are listed. Trashed rows are excluded because they are invisible on every
 * admin and public read (`features/post/post.ts`'s `isTrashed`), so including them here would
 * describe a site nobody can see.
 *
 * @param deps - Supplies `listPosts()`.
 * @param limit - Maximum rows in `items`, already clamped by the caller.
 * @returns The section payload, with `truncated` set when rows were dropped.
 * @throws Whatever `listPosts()` throws — the caller converts it to `unavailable`.
 * @complexity O(N) in the workspace's post count; `PostRepoPort.list()` has no limit parameter, so
 *   the READ is unbounded by that port's design and only the response is capped.
 * @example await collectPages(deps, 50);
 */
async function collectPages(deps: SiteProfileDeps, limit: number): Promise<CollectedSection<SiteProfilePages>> {
  const rows = (await deps.listPosts()).filter((row) => row.deletedAt === undefined || row.deletedAt === null);
  const items = rows.slice(0, limit).map(toPageSummary);
  const data: SiteProfilePages = {
    total: rows.length,
    countsByKind: tally(rows, (row) => row.kind),
    countsByStatus: tally(rows, (row) => row.status),
    items,
  };
  return rows.length > items.length ? { data, truncated: true } : { data };
}

/**
 * Collects the `theme` section: the configured active theme id, its discovered row when it exists,
 * and every discovered theme.
 *
 * `active: null` with a non-null `activeThemeId` is a REAL state (the configured theme is missing
 * or was renamed) and is reported rather than smoothed over by the render-time fallback, because
 * "the site renders a different theme than the one configured" is exactly the kind of drift a
 * profile exists to surface.
 *
 * `themeDisabled` separates the one `active: null` case that is NOT drift: the operator turned the
 * theme off on purpose. Both states are reported; only one is a problem.
 *
 * @param deps - Supplies `readActiveThemeId()`/`listThemes()`.
 * @returns The section payload. Never truncated — the theme roster is boot-discovered and small.
 * @throws Whatever either read throws.
 * @complexity O(T) in the discovered-theme count.
 * @example await collectTheme(deps);
 */
async function collectTheme(deps: SiteProfileDeps): Promise<CollectedSection<SiteProfileTheme>> {
  const [activeThemeId, themes] = await Promise.all([deps.readActiveThemeId(), deps.listThemes()]);
  const installed = themes.map(toThemeSummary);
  return {
    data: {
      activeThemeId,
      active:
        activeThemeId === null
          ? null
          : (themeIdCandidates(activeThemeId)
              .map((id) => installed.find((theme) => theme.id === id))
              .find((theme) => theme !== undefined) ?? null),
      themeDisabled: activeThemeId === NO_THEME_ID,
      installed,
    },
  };
}

/**
 * Collects the `plugins` section: every discovered plugin, joined to THIS workspace's activation
 * rows.
 *
 * `PluginActivationRepoPort.listAll()` returns rows across every workspace (its own doc says so),
 * so the join filters on `deps.workspaceId` — without that filter a multi-tenant install would
 * report another workspace's activation state as this one's.
 *
 * @param deps - Supplies `listPlugins()`/`listPluginActivations()`.
 * @returns One row per discovered plugin. A plugin with no activation row reports `enabled: false`,
 * which is the real default, not a guess.
 * @throws Whatever either read throws.
 * @complexity O(P + A) — one pass to index activations, one pass over discovered plugins.
 * @example await collectPlugins(deps);
 */
async function collectPlugins(deps: SiteProfileDeps): Promise<CollectedSection<SiteProfilePluginSummary[]>> {
  const [discovered, activations] = await Promise.all([deps.listPlugins(), deps.listPluginActivations()]);
  const enabledByPluginId = new Map<string, boolean>();
  for (const row of activations) {
    if (row.workspaceId === deps.workspaceId) enabledByPluginId.set(row.pluginId, row.enabled);
  }
  return {
    data: discovered.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      source: plugin.source,
      tier: plugin.tier ?? null,
      status: plugin.status,
      enabled: enabledByPluginId.get(plugin.id) ?? false,
    })),
  };
}

/**
 * Collects the `settings` section: exactly {@link INVENTORY_SAFE_SETTINGS}, read one at a time.
 *
 * An oversized value is reported as `truncated` with `value: null` rather than inlined, so one
 * misconfigured JSON setting cannot dominate the snapshot's token budget.
 *
 * @param deps - Supplies `readSetting()`.
 * @returns One row per allowlisted setting, in allowlist order. Section-level `truncated` is set
 * when ANY value was dropped.
 * @throws Whatever `readSetting()` throws.
 * @complexity O(S) reads for the S allowlisted settings — a fixed module constant, not caller data.
 * @example await collectSettings(deps);
 */
async function collectSettings(deps: SiteProfileDeps): Promise<CollectedSection<SiteProfileSettingSummary[]>> {
  const rows = await Promise.all(
    INVENTORY_SAFE_SETTINGS.map(async ({ namespace, key }): Promise<SiteProfileSettingSummary> => {
      const value = await deps.readSetting({ namespace, key });
      if (value === null) return { namespace, key, configured: false, value: null };
      const serialized = JSON.stringify(value) ?? "";
      if (serialized.length > MAX_SETTING_VALUE_CHARS) {
        return { namespace, key, configured: true, value: null, truncated: true };
      }
      return { namespace, key, configured: true, value };
    }),
  );
  return rows.some((row) => row.truncated) ? { data: rows, truncated: true } : { data: rows };
}

/**
 * Collects the `contentTypes` section: every non-tombstoned content type, as key/label/status/
 * version plus a field COUNT.
 *
 * Field definitions themselves are omitted: a content type's full field list is a schema document
 * an agent asks for through the `collections_*` tools when it actually needs it, and inlining every
 * field of every type would be the same context bomb the `pages` cap exists to prevent.
 *
 * @param deps - Supplies `listContentTypes()`.
 * @returns One row per live content type.
 * @throws Whatever `listContentTypes()` throws.
 * @complexity O(C) in the registered content-type count.
 * @example await collectContentTypes(deps);
 */
async function collectContentTypes(deps: SiteProfileDeps): Promise<CollectedSection<SiteProfileContentTypeSummary[]>> {
  const rows = await deps.listContentTypes();
  return {
    data: rows
      .filter((row) => row.tombstonedAt === undefined || row.tombstonedAt === null)
      .map((row) => ({
        key: row.key,
        label: row.label,
        status: row.status,
        version: row.version,
        fieldCount: row.fields.length,
      })),
  };
}

/** Clamps a caller-supplied page limit into `[1, MAX_PAGE_ITEMS]`, defaulting when absent.
 *  Non-integers and out-of-range values fall back to the default rather than propagating into a
 *  `slice()` that would silently return nothing. */
function resolvePageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) return DEFAULT_PAGE_ITEMS;
  return Math.min(requested, MAX_PAGE_ITEMS);
}

/**
 * Builds the site profile: every requested section, each authorized against its own domain
 * permission and collected concurrently.
 *
 * Sections run in parallel (`Promise.all` over at most 5 entries) because they share no state and a
 * serial fan-out would multiply the slowest read by five for no benefit. No section can fail the
 * call: {@link authorizeAndCollect} converts every denial and every throw into a status on that
 * section alone.
 *
 * @param deps - The narrow read ports (see {@link SiteProfileDeps} — this is where the
 * secret-safety claim is checkable).
 * @param input.principalId - The principal every section's `authorize()` call is made for.
 * @param options.sections - Which sections to collect. Omitted/empty means all of them.
 * @param options.pageLimit - Page rows to include, clamped to `[1, MAX_PAGE_ITEMS]`.
 * @param options.sectionTimeoutMs - Per-section wall clock, default {@link DEFAULT_SECTION_TIMEOUT_MS}.
 * @returns A {@link SiteProfile}. `completeness` is `partial` when any requested section is not
 * `ok`. Never rejects for a section-level failure; only a caller-side wiring error (a missing dep)
 * can reject.
 * @complexity O(N + T + P + A + C + S) — one read per section, run concurrently; `N` (posts)
 * dominates on a large site.
 * @example
 * const profile = await buildSiteProfile(deps, { principalId: "p-1" }, { sections: ["theme", "settings"] });
 */
export async function buildSiteProfile(
  deps: SiteProfileDeps,
  input: { principalId: string },
  options: BuildSiteProfileOptions = {},
): Promise<SiteProfile> {
  const capturedAt = deps.clock.nowIso();
  // Key order follows the closed vocabulary, however the caller ordered or repeated `sections`.
  const requested = resolveRequestedSections({ vocabulary: SITE_PROFILE_SECTION_NAMES, requested: options.sections });
  const pageLimit = resolvePageLimit(options.pageLimit);
  const timeoutMs = options.sectionTimeoutMs ?? DEFAULT_SECTION_TIMEOUT_MS;
  const principalId = input.principalId;

  const collectors: Record<SiteProfileSectionName, () => Promise<SiteProfileSection<unknown>>> = {
    pages: () =>
      authorizeAndCollect(deps, { principalId, section: "pages", timeoutMs, collect: () => collectPages(deps, pageLimit) }),
    theme: () => authorizeAndCollect(deps, { principalId, section: "theme", timeoutMs, collect: () => collectTheme(deps) }),
    plugins: () =>
      authorizeAndCollect(deps, { principalId, section: "plugins", timeoutMs, collect: () => collectPlugins(deps) }),
    settings: () =>
      authorizeAndCollect(deps, { principalId, section: "settings", timeoutMs, collect: () => collectSettings(deps) }),
    contentTypes: () =>
      authorizeAndCollect(deps, {
        principalId,
        section: "contentTypes",
        timeoutMs,
        collect: () => collectContentTypes(deps),
      }),
  };

  const results = await Promise.all(requested.map(async (name) => [name, await collectors[name]()] as const));

  const sections: SiteProfile["sections"] = {};
  for (const [name, section] of results) {
    // The collector map is keyed by the same closed vocabulary the response shape is, so this
    // assignment is exhaustive by construction; the cast only tells the compiler that a section's
    // payload type matches its own key, which the map above already guarantees.
    (sections as Record<string, SiteProfileSection<unknown>>)[name] = section;
  }

  return {
    schemaVersion: "1",
    capturedAt,
    completeness: results.every(([, section]) => section.status === "ok") ? "complete" : "partial",
    sections,
  };
}
