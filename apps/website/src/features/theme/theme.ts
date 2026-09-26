import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "@jini-ai/cms/core";
import { markersOfType } from "#src/contracts/core/embeds/marker";
import { checkBuiltThemeConformance } from "./build-conformance.js";
import { lintHandlebarsTemplate } from "./handlebars-allowlist.js";
import { lintLiquidTemplate } from "./liquid-allowlist.js";
// `theme-files.ts` imports `ENGINE_SUBFOLDERS`/`THEME_CATALOG_DIR` from this module already, so this
// is a pre-existing module pair, now cyclic in the other direction too — safe because both of these
// are consumed only inside `loadTheme`'s function body below, never at module-evaluation time.
import { GENERATED_THEME_DIRS, isSourceDirGeneratedConflict } from "./theme-files.js";
import { themeIdCandidates } from "./theme-id-aliases.js";
import { resolveThemeLayout } from "./theme-layout.js";

/**
 * @file Declarative theme package format + discovery (SPEC-004, spike slice).
 *
 * Purpose:
 * A theme is a folder of validated *data* — no executable code. This module
 * defines the on-disk shape, discovers theme folders, and resolves a route to a
 * template id. The template-tree renderer (`server/http/site/render.ts`) turns
 * the resolved block tree into HTML.
 *
 * Spike scope (VibeCoder): discovery + a shallow validity check (required files
 * parse). The full SPEC-004 validation pipeline (CSS sanitization allowlist,
 * component-reference checks, size caps, id-collision rules) is deferred to the
 * proper SPEC-004 build. Treat this as exploratory, not test-certified.
 */

/**
 * ADR-020 capability tier. `declarative` = data-only (safe from anyone),
 * `templated` = LiquidJS-rendered (sandboxed logic, no JS), `handlebars` =
 * Handlebars-rendered (sandboxed logic, no JS — a sibling of `templated` with
 * its own allowlist/worker pair, not a replacement for it), `static` = plain
 * HTML/CSS/JS, no template language at all — every byte editable, a whole
 * `pages/*.html` set instead of one `templates/` route map (see `pages` on
 * {@link DiscoveredTheme}), `code` = trusted signed-plugin JS (not built yet).
 * Absent in `theme.json` ⇒ `declarative`.
 */
export type ThemeTier = "declarative" | "templated" | "handlebars" | "static" | "code";

const THEME_TIERS: readonly ThemeTier[] = ["declarative", "templated", "handlebars", "static", "code"];

/**
 * Themes trusted to skip the Liquid allowlist lint (`ThemeManifest.skipLiquidAllowlist`'s own doc) —
 * a maintainer-controlled list in Tovu's OWN source, never a field a theme package can set about
 * itself (schema v2 decision, 2026-08-18). Empty today: no first-party theme currently needs the
 * exception; extending this requires editing Tovu's own source, not a theme's `theme.json`.
 */
export const TRUSTED_SKIP_LIQUID_ALLOWLIST_THEME_IDS: ReadonlySet<string> = new Set([]);

/**
 * `theme.json.build` — ADR-020 §5 (2026-08-12): declares which of the two lifecycle classes a
 * `static`-tier theme belongs to.
 *
 * **Authored** — this field absent, every theme on disk today. The working copy on disk IS the
 * source: full per-file edit, reset, and `theme_write_file` AI-authorability, exactly as before this
 * field existed.
 *
 * **Built** (`source: "compiled"`) — the shipped `pages/`, `css/`, `js/` were produced by a framework's
 * own build (React/Vue/Angular) rather than authored directly. Settled by the debate: *the author or
 * publisher CI builds; Tovu never runs the build* — this field records provenance/contract for a build
 * that already happened elsewhere, it never triggers one. A built theme's SOURCE (`sourceDir`) keeps
 * everything an authored theme has today — per-file edit, reset, AI-authorability
 * ({@link import("./theme-files.js").resolveThemeFileWriteScope}). Only its GENERATED tree — everything
 * outside `sourceDir` plus `theme.json` — loses that per-file granularity: it is read-only from every
 * per-file surface, and is restored, when it is, only as one complete release, never file-by-file.
 *
 * `source: "compiled"` requires `tier: "static"` (enforced in {@link loadTheme}) — a compiled theme's
 * RUNTIME is a `static` theme; there is no server-executing `code` tier this maps onto (`code` stays
 * reserved and unbuilt — see {@link ThemeTier}'s own doc).
 */
export interface ThemeBuildInfo {
  /**
   * `"compiled"` marks this theme as a built release (see this interface's own doc). Any other or
   * absent value — including a `build` object present in `theme.json` with no `source` key at all, or
   * an unrecognized string — is treated as `"authored"` rather than failing the theme. This is a
   * descriptive default for an optional field, not {@link parseTier}'s fail-closed contract: that
   * exists because a wrong TIER silently applies a different tier's validation rules with no error;
   * defaulting an ambiguous `build.source` to "this is just an ordinary authored theme" has no
   * equivalent silent-wrong-behavior risk.
   */
  source: "authored" | "compiled";
  /** `compiled` only — which framework produced the source. Purely descriptive: nothing in Tovu's
   * request-time branches reads this field; it exists for the editor/marketplace UI and support. */
  framework?: "react" | "vue" | "angular";
  /**
   * `compiled` only, REQUIRED — the authored source tree's root, relative to the theme folder (e.g.
   * `"src"`). Everything under this path, plus `theme.json` itself, stays per-file editable exactly
   * like an authored theme; everything outside it is this build's generated output and is read-only
   * through every per-file surface (see {@link import("./theme-files.js").resolveThemeFileWriteScope}).
   * An author-DECLARED path rather than an assumed `src/` convention: a hardcoded prefix would either
   * lock a real source tree named something else out of editing entirely, or (looser) let a generated
   * folder that merely starts with the same letters (`src-legacy/`) slip through as writable.
   */
  sourceDir?: string;
  /** `compiled` only — the tool and version that produced the artifact (e.g. `"astro@4.15.2"`),
   * recorded for support/reproducibility. Never parsed or version-checked by Tovu. */
  builderVersion?: string;
  /** `compiled` only — sha256 of the lockfile the build ran against. Provenance only; Tovu never reads
   * the lockfile's own contents. */
  lockfileHash?: string;
  /**
   * `compiled` only, REQUIRED (non-empty) — sha256 hex digest of each generated file's bytes, keyed by
   * path relative to the theme folder. Verified against the real files on disk by
   * {@link checkBuiltThemeConformance} (`build-conformance.ts`) before the theme is accepted as
   * `status: "valid"` — this is what backs "immutable, versioned, integrity-verified," not a UI label.
   * A file not listed here is not integrity-checked — a documented gap (`build-conformance.ts`'s own
   * header), not a silent one.
   */
  artifactHashes?: Record<string, string>;
}

/** `theme.json` — static theme identity. */
export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  /**
   * Schema version this manifest declares (`theme-authoring-guide-v2.md` §5/§11). `2` means the
   * theme's on-disk shape uses v2 paths (`css/theme.css`, `scripts/`, `render/pages/`) — read by
   * `static-asset-contract.ts`'s `tokenStylesheetSentinel`/`rewriteAssetPaths`/
   * `findUnrewrittenAssetPaths` (via `static-render.ts` and `build-conformance.ts`), and by
   * `resolveThemeLayout` (`theme-layout.ts`, 2026-08-19 architecture audit findings 1 & 2 — the one
   * apiVersion-aware source of truth every other consumer routes through) to pick the matching
   * sentinel/folder names at request/install time. As of the 2026-08-18 Milestone 3 migration, all
   * seven built-in static themes (`content/themes/static/*`) declare `2` — this is the live, common case,
   * not a forward-looking one. Absent (or any value other than `2` — still fully supported for a
   * site-authored or marketplace theme) means v1's flat `css/styles.css`/`js/` shape, preserved
   * exactly, the only behavior this field had before Milestone 3 introduced `2`.
   */
  apiVersion?: 2;
  /** ADR-020 capability tier (defaults to `declarative` when omitted). */
  tier: ThemeTier;
  /** Legacy pre-ADR-020 field; retained for back-compat, superseded by `tier`. */
  class?: "declarative";
  engine: number;
  /**
   * ADR-020 §5 (2026-08-12) — free-text credit for who produced this theme, e.g. "Aurora Themes Co.".
   * Absent for every theme on disk today; `loadTheme` never parsed this field before this change, and
   * nothing in the engine branches on it. Independent of {@link ThemeBuildInfo}: `build` is about HOW
   * the static output was produced, `author` is about WHO produced it — a hand-authored theme can
   * still declare an `author`.
   */
  author?: string;
  /** ADR-020 §5 (2026-08-12) — declares which lifecycle class this theme belongs to. See
   * {@link ThemeBuildInfo}'s own doc for the authored-vs-built distinction and what each keeps/loses. */
  build?: ThemeBuildInfo;
  description?: string;
  /**
   * Optional Google Fonts family specs the page shell loads for this theme,
   * e.g. "Fraunces:opsz,wght@9..144,400;9..144,600". Spike-only convenience;
   * SPEC-004 CSS sanitization forbids external font @import in theme CSS, so
   * fonts live in the manifest, not the stylesheet.
   */
  fonts?: string[];
  /**
   * SPEC-043/ADR-047 §2a — the region keys (e.g. `["header","footer"]`) this theme declares for
   * widget placement, the same way it already declares templates/slots. Additive, optional field:
   * absent/undefined means "no declared regions" (unchanged behavior for every existing `theme.json`
   * on disk today — no back-compat migration needed). `resolvePageWidgets`'s `resolvedRegions` input
   * (`src/widgets/resolver-service.ts`) is sourced directly from this field at render time
   * (`server/http/site/render.ts::renderSite`) — this fulfills what ADR-047 §2a's own framing already
   * assumed existed ("themes declare region keys the same way they already declare template
   * slots/regions") rather than a hardcoded core constant.
   */
  regions?: string[];
  /**
   * Opt-out of the ADR-020 §3 Liquid tag/filter allowlist (`liquid-allowlist.ts`) for this theme's
   * `.liquid` templates. Absent/`false` (default) keeps the existing enforced behavior — every
   * theme on disk today is unaffected, no migration needed. `true` means fuller Liquid (e.g.
   * `include`/`render` or a wider filter set) is available for this theme — the runtime's
   * independent layers (worker isolation, `NO_ACCESS_FS` filesystem lockdown, memory/render/parse
   * limits — `liquid-worker.ts`) still apply regardless of this flag; only the allowlist's own
   * pre-flight lint is skipped.
   *
   * **Schema v2 decision (2026-08-18): NOT publisher-controlled, never read from `theme.json`.**
   * A theme package setting this about itself would let ANY publisher silently disable the one lint
   * standing between an author's `.liquid` template and the render worker — the opposite of "the
   * theme is a first-party/trusted artifact" this flag is meant to express. `loadTheme()` resolves
   * this field from {@link TRUSTED_SKIP_LIQUID_ALLOWLIST_THEME_IDS} — a maintainer-controlled list
   * in Tovu's OWN source — keyed by the theme's folder id, never from the raw manifest JSON. This
   * field stays on `ThemeManifest` as the RESOLVED value every other read site (the `.liquid` lint
   * branch below) already consumes; only its SOURCE changed.
   *
   * Liquid-only by name and by effect: the `handlebars` tier has NO equivalent opt-out, and that
   * asymmetry is deliberate rather than an omission. Liquid's excluded surface is mostly
   * capability breadth (a wider filter set, `include`/`render`), so "this theme is a first-party
   * artifact" is a coherent trade. The Handlebars allowlist's three headline refusals — raw
   * `{{{output}}}`, partials, and decorators — are not breadth; they are the tier's XSS seam and
   * its two documented routes from template text into the compiler's own object graph (see
   * `handlebars-allowlist.ts`). There is no theme whose convenience justifies re-opening those, so
   * the flag simply does not apply to `.hbs`/`.handlebars` files.
   */
  skipLiquidAllowlist?: boolean;
  /**
   * `static` tier only — the ordered list of `pages/*.html` filenames (e.g. `["blog-post.html",
   * "page-shell.html"]`) a Post OR a Page can pick between, "ordered to nudge the right choice"
   * (first entry is the implicit default in the Post editor's picker). Absent/undefined means this
   * theme ships no templates — a row's `templateChoice` then has nothing to resolve against, which
   * the render path treats as "misconfigured", not "fall back to generic rendering" (see
   * `pages.ts`'s template branch).
   *
   * ONE array for both kinds (2026-08-11 unification), superseding the earlier separate
   * `postTemplate`/`pageTemplate` split (2026-08-10/11 design docs) — that split existed only
   * because the OLD marker vocabulary made a template's slot type kind-specific
   * (`{"type":"post","id":"{{post}}"}"` vs `{"type":"content"}"`), so the wrong array could offer a
   * Post-shaped template to a Page. The unified `content` marker (`{"type":"content"}"`, optional
   * `id`) removed that distinction at the source: the resolver reads the referenced row's
   * `bodyFormat` at RENDER time and dispatches, so a template file no longer declares which kind it
   * is for. One array is therefore no longer a hazard, and keeping two would just be two
   * independently-maintained copies of the same list to keep in sync — the same "duplicated logic
   * regresses" argument `resolveTemplate`'s own history already made once (2026-08-09
   * null-vs-`""`-conflation).
   *
   * **What this does NOT solve**: which templates make SENSE for a Post vs a Page (a blog template's
   * byline/date/next-post chrome does not belong on Privacy Policy) is a template-APPLICABILITY
   * question this field is silent on — see `ADS-memory/reports/implementation/
   * 2026-08-11-unified-content-marker.md` for why marker-based applicability inference (the design
   * doc's own "interim" proposal) has no signal left to key off now that every template's primary
   * slot carries the identical `{"type":"content"}"` marker, and both admin pickers therefore offer
   * this one flat list unfiltered, same as they always effectively did within their own kind.
   */
  templates?: string[];
  /**
   * `static` tier only — the allow-list of {@link isPublishableThemePageCandidate} page ids this
   * theme currently serves publicly (2026-08-30, owner ask: a static theme's public routing was
   * pure file presence with no draft/unpublished concept at all — the gap an agent worked around by
   * moving a live page into an invented `_unpublished/` folder and dropping it from `theme.json`,
   * outside every audited write path. This field is the real mechanism that replaces it).
   *
   * **Absent (no recorded decision — applies RETROACTIVELY to every theme on disk, not only ones
   * touched after this date): off by default.** {@link isStandaloneThemePage} treats every eligible
   * candidate page as unpublished until a decision is recorded. This reverses this field's own
   * first-day default (absent originally meant "everything published", for backward compatibility
   * with pure file-presence routing) per the owner's explicit correction, in their own words: "The
   * pages are not published by default. They shouldn't be... because then they would have wrong
   * information because they're generic themes." Only `index`, `404`, and a declared {@link templates}
   * shell stay live regardless — {@link isPublishableThemePageCandidate} excludes those from this
   * field's reach entirely; they were never "published", they are structurally load-bearing.
   *
   * **Present (a theme where the publish toggle has been used at least once): an explicit allow-list.**
   * A candidate page id NOT in this array is unpublished, same meaning as the absent case — the array
   * only ever records what has been turned ON. The publish route (`explore.ts`'s
   * `registerAdminThemePagePublishRoute`) is the only writer: because the default is already "off",
   * the first toggle on a theme with no recorded array needs no backfill — it simply starts from an
   * empty array and applies the one requested change.
   *
   * Entries are candidate page ids (`pricing`, matching {@link DiscoveredTheme.pages}' own keys), not
   * filenames — `index`/`404` and a declared {@link templates} shell can never appear meaningfully
   * here even if listed: {@link isStandaloneThemePage} excludes them before this array is ever
   * consulted, the same way it always has.
   */
  publishedPages?: string[];
  /**
   * `static` tier only — the color modes this theme ships token sets for, e.g. `["dark", "light"]`.
   * A mode name is just the value written into the page's root `data-theme` attribute, which is the
   * selector `tokensToRootCss` (`static-render.ts`) already emits its `tokens.light.json` override
   * block under (`:root[data-theme="light"]`). Absent/undefined means the theme declares nothing, and
   * {@link renderStaticPage} then emits no `data-theme` at all — the pre-2026-08-10 behavior, where
   * the base `:root` block always won because no attribute existed for an override block to match.
   */
  modes?: string[];
  /**
   * `static` tier only — which of {@link modes} a freshly-served page starts in. Emitted as
   * `data-theme="<defaultMode>"` on the page's `<html>` element, so it selects between the token
   * blocks above. A theme wanting a user-flippable toggle owns that itself: static themes are plain
   * HTML/JS, so their own script sets `document.documentElement.dataset.theme`, and the engine's job
   * ends at establishing the initial value. Declaring a `defaultMode` outside `modes` is a manifest
   * error (the theme loads `invalid` with a message), not a silent fallback.
   */
  defaultMode?: string;
  /**
   * `static` tier only — the `{"type":"partial","id":"<key>"}` `data-embed-config` markers this
   * theme's pages embed, mapped to the root partial file each one pulls in. Read by `resolveSlots`
   * (`static-render.ts`); before this was wired, that function hardcoded exactly the `nav`/`footer`
   * pair every theme on disk happens to declare, so the field was authored but never parsed.
   * {@link DEFAULT_THEME_SLOTS} reproduces that hardcoded pair for a theme that declares no `slots`,
   * which is why wiring this changed no existing theme's output.
   */
  slots?: Record<string, ThemeSlotDescriptor>;
}

/** One entry of {@link ThemeManifest.slots}. */
export interface ThemeSlotDescriptor {
  /** Root partial filename this slot renders, e.g. `nav.html`. */
  source: string;
  /**
   * Whether this slot's marker can carry a `current` key (e.g.
   * `{"type":"partial","id":"nav","current":"pricing"}`) that marks the matching `data-nav-id`
   * anchor inside the resolved partial with `aria-current="page"`. A boolean opt-in, not an
   * attribute name — `data-nav-id` is the only half of this convention themes ever varied, so
   * there was never a second attribute name to configure; only `nav`-shaped slots set this, a
   * `footer` has no current item.
   *
   * Legacy: `theme.json` may instead carry `"activeAttr": "<any string>"` — the pre-2026-08-10
   * spelling, from when this really did name an attribute on the marker element
   * (`data-nav-current`, since retired). {@link parseSlots} treats ANY string value there as
   * `honorsCurrentPage: true`; the string's own content was already dead weight by the time this
   * field was renamed; only its presence ever mattered. Drop that fallback once no in-repo
   * `theme.json` still writes `activeAttr` and the marker drift check
   * (`development/docs/architecture/embed-marker-migration.md` item 4) is extended to gate on it.
   */
  honorsCurrentPage?: boolean;
  /**
   * Alternate sources selected by a marker's `variant` config key, e.g.
   * `{ "minimal": "footer-minimal.html" }`. A variant with no entry here falls back to the
   * `<source-stem>-<variant>.html` filename convention, which is what `resolveSlots` did for every
   * variant before this field was parsed.
   */
  variants?: Record<string, string>;
}

/**
 * The `nav`/`footer` pair `resolveSlots` hardcoded before {@link ThemeManifest.slots} was parsed.
 * Used verbatim when a static theme declares no `slots`, so such a theme renders exactly as it did.
 */
export const DEFAULT_THEME_SLOTS: Readonly<Record<string, ThemeSlotDescriptor>> = {
  nav: { source: "nav.html", honorsCurrentPage: true },
  footer: { source: "footer.html" },
};

/** Design tokens: CSS custom-property name → value (emitted into `:root`). */
export type ThemeTokens = Record<string, string>;

/** A template is a JSON block tree (doc nodes + slot + component nodes). */
export type TemplateNode = JsonValue;

/** A fully-loaded, discovered theme. */
export interface DiscoveredTheme {
  manifest: ThemeManifest;
  /**
   * Absolute path of the folder this theme was loaded from. Recorded at load time because it is the
   * one fact about a theme that discovery knows and no consumer can re-derive: a theme id alone does
   * not say whether the folder sits at the top level of `themes/` or under one of
   * {@link ENGINE_SUBFOLDERS}. The `themes` agent-tool domain (`agent-tools.ts`) resolves every
   * read/write against THIS value rather than re-deriving a path from the id, so an id can never be
   * used to steer a file operation at a folder discovery did not itself produce.
   */
  dir: string;
  tokens: ThemeTokens;
  /**
   * Light-mode token overrides (static tier only), from an optional `tokens.light.json` sibling to
   * `tokens.json`. Empty object when the theme ships no light variant — a static theme is not
   * required to support both modes, and an empty `:root[data-theme="light"] {}` override block is
   * harmless (it overrides nothing, so the page just stays on its dark values).
   */
  tokensLight: ThemeTokens;
  /** Template id (`home`, `post`, …) → block tree (declarative tier). */
  templates: Record<string, TemplateNode>;
  /** Template id → raw LiquidJS source (templated tier, ADR-020). */
  liquidTemplates: Record<string, string>;
  /** Template id → raw Handlebars source (handlebars tier, ADR-020). */
  handlebarsTemplates: Record<string, string>;
  /**
   * Page id → raw HTML document source (static tier only). Keyed by filename
   * minus `.html`, from `pages/*.html` — unlike `templates`/`liquidTemplates`/
   * `handlebarsTemplates`, these are already-complete `<!doctype html>` documents,
   * not route-driven block trees/fragments, because a static theme has no
   * templating language for a renderer to fill in.
   */
  pages: Record<string, string>;
  /**
   * Partial id → raw HTML source (static tier only): `nav`, `footer`, and any
   * `footer-*` variant (e.g. `footer-minimal`) found at the theme root. A static
   * page embeds these via `data-tovu-slot="nav"` / `data-tovu-slot="footer"`
   * markers rather than a template-include directive — resolving them is the
   * renderer's job, not something baked into the page HTML at author time.
   */
  partials: Record<string, string>;
  /** Raw theme stylesheet (unsanitized in the spike). */
  css: string;
  source: "built-in" | "site";
  status: "valid" | "invalid";
  /** Human-readable validation errors; empty when valid. */
  errors: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): JsonValue {
  return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
}

/** Default an absent/empty `theme.json.tier`; reject a present value this build cannot render. */
function parseTier(value: JsonValue | undefined): ThemeTier {
  if (value === undefined || value === "") return "declarative";
  if (typeof value === "string" && (THEME_TIERS as readonly string[]).includes(value)) {
    return value as ThemeTier;
  }
  throw new Error(`unrecognized theme tier '${String(value)}'`);
}

/** `typeof value === "string" ? value : undefined` — the shape every plain optional-string
 * `theme.json` field shares (`author`, `description`, `defaultMode`, `build.builderVersion`,
 * `build.lockfileHash`, …); factored out once rather than repeated at each call site. */
function parseOptionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `Array.isArray(value) ? value.map(String) : undefined` — the shape every plain optional
 * string-array `theme.json` field shares (`fonts`, `regions`, `templates`, `modes`). */
function parseOptionalStringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

/**
 * `{ ...obj }` minus every key whose value is falsy. Centralizes the "include this optional field
 * only when it has a real value" rule {@link parseThemeBuildInfo}'s return object used to apply as
 * five separate `...(x ? {x} : {})` spreads — one per optional {@link ThemeBuildInfo} field.
 */
function pickTruthy<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => Boolean(v))) as Partial<T>;
}

/** `build.framework` — one of the three known values, or `undefined` for anything else
 * (including an unrecognized framework string, e.g. a theme built with a tool this doesn't
 * name yet — dropped rather than failing the parse, matching every other optional field here). */
function parseBuildFramework(value: JsonValue | undefined): ThemeBuildInfo["framework"] {
  return value === "react" || value === "vue" || value === "angular" ? value : undefined;
}

/** `build.sourceDir` — a non-empty string, or `undefined` (absent, wrong type, or `""`). Presence
 * is enforced separately, at {@link loadTheme}'s call site, once {@link ThemeBuildInfo.source} is
 * known to be `"compiled"` — see this field's own doc for why that check lives there. */
function parseBuildSourceDir(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `build.artifactHashes` — every entry whose value isn't a string is dropped rather than failing
 * the parse (a build tool emitting one malformed hash shouldn't sink the whole manifest); emptiness
 * after filtering is a {@link loadTheme} call-site concern, matching `sourceDir`'s split above. */
function parseBuildArtifactHashes(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * Parse `theme.json.build` into {@link ThemeBuildInfo}. Absent or non-object ⇒ `undefined` (this theme
 * is `authored`, unchanged from before this field existed). Malformed or missing OPTIONAL fields
 * degrade to omission rather than throwing — that is a different failure class than {@link parseTier}'s
 * fail-closed contract (see {@link ThemeBuildInfo.source}'s own doc for why). The two fields REQUIRED
 * for a `compiled` build (`sourceDir`, non-empty `artifactHashes`) are not enforced here — this
 * function only shapes what is present; {@link loadTheme}'s own call site pushes the "required when
 * compiled" errors, matching how `defaultMode`'s cross-field check already lives at the call site
 * rather than inside its own field's parser.
 */
function parseThemeBuildInfo(value: JsonValue | undefined): ThemeBuildInfo | undefined {
  if (!isObject(value)) return undefined;
  const source = value.source === "compiled" ? "compiled" : "authored";
  const framework = parseBuildFramework(value.framework);
  const sourceDir = parseBuildSourceDir(value.sourceDir);
  const builderVersion = parseOptionalString(value.builderVersion);
  const lockfileHash = parseOptionalString(value.lockfileHash);
  const artifactHashes = parseBuildArtifactHashes(value.artifactHashes);

  return {
    source,
    ...pickTruthy({ framework, sourceDir, builderVersion, lockfileHash, artifactHashes }),
  };
}

/**
 * `raw.honorsCurrentPage` (current) or a legacy `raw.activeAttr` string (pre-2026-08-10 spelling —
 * see {@link ThemeSlotDescriptor.honorsCurrentPage}) — either one opts a slot in. Split out of
 * {@link parseSlots} so that function stays a plain per-key loop, the same shape `parseMarkerConfig`
 * was split out of `scanEmbedMarkers` for (`core/embeds/marker.ts`).
 */
function parseSlotHonorsCurrentPage(raw: Readonly<Record<string, unknown>>): boolean {
  return raw.honorsCurrentPage === true || typeof raw.activeAttr === "string";
}

/** `raw.variants`, keeping only string-valued entries — `undefined` if there are none worth keeping. */
function parseSlotVariants(raw: Readonly<Record<string, unknown>>): Record<string, string> | undefined {
  if (!isObject(raw.variants)) return undefined;
  const variants = Object.fromEntries(
    Object.entries(raw.variants).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v)])
  );
  return Object.keys(variants).length > 0 ? variants : undefined;
}

/**
 * Parse `theme.json.slots` into {@link ThemeSlotDescriptor}s, skipping any entry that isn't an object
 * with a string `source`. Returns `undefined` for an absent/unusable field so the caller falls back to
 * {@link DEFAULT_THEME_SLOTS} rather than resolving zero slots — a theme whose `slots` block is
 * malformed still renders its nav and footer under the legacy convention instead of losing both.
 *
 * `honorsCurrentPage` accepts both spellings, additively: the current boolean, or the legacy
 * `activeAttr` string (any non-empty string). An out-of-tree theme.json that never migrates off
 * `activeAttr` must keep wiring `aria-current` exactly as it does today; this normalizes either
 * spelling onto the one field every downstream reader sees.
 */
function parseSlots(value: JsonValue | undefined): Record<string, ThemeSlotDescriptor> | undefined {
  if (!isObject(value)) return undefined;
  const slots: Record<string, ThemeSlotDescriptor> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isObject(raw) || typeof raw.source !== "string") continue;
    const variants = parseSlotVariants(raw);
    slots[key] = {
      source: raw.source,
      ...(parseSlotHonorsCurrentPage(raw) ? { honorsCurrentPage: true } : {}),
      ...(variants ? { variants } : {}),
    };
  }
  return Object.keys(slots).length > 0 ? slots : undefined;
}

/** Everything only a static theme ships. Returned by {@link loadStaticTierAssets}. */
interface StaticTierAssets {
  tokensLight: ThemeTokens;
  pages: Record<string, string>;
  partials: Record<string, string>;
  /** Validation failures, for the caller to merge into the theme's own `errors`. */
  errors: string[];
}

/** No static assets, for every tier that ships none. */
const NO_STATIC_TIER_ASSETS: StaticTierAssets = {
  tokensLight: {},
  pages: {},
  partials: {},
  errors: [],
};

/**
 * Read `tokens.light.json`, a static theme's optional light-mode override set.
 *
 * Optional unlike `tokens.json`: absent is not an error, it just means the theme ships no light
 * variant, which leaves the map empty so no `:root` override block is emitted at all.
 */
function readLightTokens(
  required: { themeDir: string; errors: string[] },
  _optional: Record<string, never> = {}
): ThemeTokens {
  const { themeDir, errors } = required;
  const path = join(themeDir, "tokens.light.json");
  if (!existsSync(path)) return {};
  try {
    const raw = readJson(path);
    if (!isObject(raw)) throw new Error("tokens.light.json is not an object");
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
  } catch (err) {
    errors.push(`tokens.light.json: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Read the root partial files a static theme's declared {@link ThemeManifest.slots} name.
 *
 * Before this, the partial scan was a hardcoded filename allowlist — `nav.html` or anything starting
 * with `footer` — which meant a theme could DECLARE a slot (`"sidebar": { "source": "sidebar.html" }`)
 * and have its file read by nothing, so the marker resolved empty with no error anywhere. Slots are
 * now the single source of truth for which root `.html` files are partials, which is what makes
 * adding a region to a copied theme a manifest edit rather than a code change here.
 *
 * A slot matches its own `source` plus the `<stem>-<variant>.html` convention `resolveSlots` already
 * falls back to for a variant with no explicit `variants` entry — so `footer.html` still pulls in
 * `footer-minimal.html`, and a new `sidebar` slot gets `sidebar-*.html` on the same terms rather than
 * a second, differently-shaped rule.
 */
/**
 * @param required.partialsDir - v1: the theme's own root (`themeDir`) — partials sit alongside
 * `pages/`/`css/`/`js/`. v2: `render/partials/` — see `theme-authoring-guide-v2.md` §3. Passed in
 * rather than derived here so this function stays agnostic to which schema version picked it.
 */
function loadSlotPartials(
  required: { partialsDir: string; slots: Record<string, ThemeSlotDescriptor> },
  _optional: Record<string, never> = {}
): Record<string, string> {
  const { partialsDir, slots } = required;
  if (!existsSync(partialsDir)) return {};
  const descriptors = Object.values(slots);
  const stems = descriptors.map((slot) => slot.source.replace(/\.html$/, ""));
  const explicitVariants = new Set(descriptors.flatMap((slot) => Object.values(slot.variants ?? {})));

  const partials: Record<string, string> = {};
  for (const file of readdirSync(partialsDir)) {
    if (!file.endsWith(".html")) continue;
    const named = explicitVariants.has(file);
    const conventional = stems.some((stem) => file === `${stem}.html` || file.startsWith(`${stem}-`));
    if (!named && !conventional) continue;
    partials[file.slice(0, -".html".length)] = readFileSync(join(partialsDir, file), "utf8");
  }
  return partials;
}

/** Every `templates` entry must resolve against `pages/<id>.html` and carry this marker type. */
const TEMPLATE_SLOT_MARKER_TYPE = "content";

/**
 * Validates the theme's `templates` array against its already-loaded `pages` (2026-08-11, owner
 * decision — see `ADS-memory/reports/continuity/2026-08-11-pages-template-decisions.md`, extended to
 * the unified single array by `ADS-memory/reports/design/2026-08-11-unified-content-marker-and-
 * templates.md`): a listed entry that resolves to no file, or to a file with zero `"content"`
 * markers, renders a structurally fine page with its actual content silently missing — "the worst
 * failure class this codebase keeps hitting", in the owner's own words, and the same class of bug
 * REQ-10's `pages/index.html is required` check exists to catch at load time rather than on a
 * visitor's page view.
 *
 * One field, one marker type, one call site — collapsed from the pre-unification version that took a
 * `fieldName`/`slotMarkerType` pair and was called twice (once for `postTemplate`/`"post"`, once for
 * `pageTemplate`/`"content"`). With only one array and one marker type left to check, parameterizing
 * either would just be indirection with a single value ever passed through it.
 *
 * Not itself tier-gated — `pages` is empty for every non-static theme (`loadStaticTierAssets`'s own
 * early return), so a non-static theme is already incapable of tripping this on a `templates` field it
 * isn't documented to declare; gating here too would just be a second copy of that same guarantee.
 *
 * @complexity O(t) over `templates`' length; each entry's marker scan is O(n) in that one page's HTML
 *   length (`markersOfType`), the same cost `resolveTemplate` already pays per request.
 */
function validateTemplateDeclarations(
  required: {
    templates: readonly string[] | undefined;
    pages: Readonly<Record<string, string>>;
    pagesDirName?: string;
  },
  _optional: Record<string, never> = {}
): string[] {
  const { templates, pages, pagesDirName = "pages" } = required;
  if (!templates) return [];

  const errors: string[] = [];
  for (const entry of templates) {
    const pageId = entry.replace(/\.html$/, "");
    const html = pages[pageId];
    if (html === undefined) {
      errors.push(`theme.json templates entry '${entry}' has no matching ${pagesDirName}/${pageId}.html file`);
      continue;
    }
    if (markersOfType(html, TEMPLATE_SLOT_MARKER_TYPE).length === 0) {
      errors.push(
        `${pagesDirName}/${pageId}.html is declared in theme.json templates but has no {"type":"${TEMPLATE_SLOT_MARKER_TYPE}"} marker`
      );
    }
  }
  return errors;
}

/**
 * Page ids that live in `pages` but are never their own public URL: `index` is served at `/` by the
 * home route, and `404` is the error document `handlePostNotFoundOnSlugRoute` renders WITH a 404
 * status. Serving either at `/<id>` is a soft 404 — a real 200 response carrying error-page or
 * duplicate-home content, which search engines index as genuine.
 */
const NON_ROUTABLE_THEME_PAGE_IDS: ReadonlySet<string> = new Set(["index", "404"]);

/**
 * Whether `pageId` is a page SHAPE {@link isStandaloneThemePage}'s publish check can apply to at all —
 * every check that predicate makes EXCEPT the publish-state lookup itself: the page exists, isn't
 * `index`/`404`, and isn't a declared {@link ThemeManifest.templates} shell.
 *
 * Split out (2026-08-30) so the publish-toggle UI/route can tell "this isn't a publishable page at
 * all" (index, 404, a Post/Page template shell, or no such page) apart from "it's a real candidate
 * page that is currently turned off" — {@link isStandaloneThemePage} answers only the second question
 * once this one is already true, and re-deriving these same three checks a second time at the route
 * layer is exactly the drift this predicate's own history already warns against once (see that
 * function's own doc for the pre-2026 duplication this file fixed).
 *
 * @complexity O(t) over `manifest.templates`' length — 0–3 entries on every real theme on disk.
 */
export function isPublishableThemePageCandidate(theme: DiscoveredTheme, pageId: string): boolean {
  if (theme.pages[pageId] === undefined) return false;
  if (NON_ROUTABLE_THEME_PAGE_IDS.has(pageId)) return false;
  return !(theme.manifest.templates ?? []).some((entry) => entry.replace(/\.html$/, "") === pageId);
}

/**
 * Whether `pageId` is one of this theme's own standalone, publicly reachable pages — i.e. whether
 * `GET /<pageId>` should render it directly.
 *
 * **Why this exists as one shared predicate.** A static theme's `pages` record
 * (`DiscoveredTheme.pages`) holds two structurally identical but semantically different kinds of
 * entry under the same string keys: real standalone marketing pages (`about`, `pricing`, …) AND
 * content-embedding template shells a Post/Page selects via `templateChoice` (`blog-post`,
 * `page-shell`, …, declared in `manifest.templates` and validated by
 * {@link validateTemplateDeclarations} above). Nothing in the loaded theme shape distinguishes them
 * by type — only which OTHER list names a given key. A shell served directly is a document whose
 * `{"type":"content"}` marker was never substituted: structurally fine, content silently missing,
 * the exact failure class {@link validateTemplateDeclarations}'s own doc calls "the worst failure
 * class this codebase keeps hitting".
 *
 * The live `GET /:slug` resolver (`server/routes/site/pages.ts`'s `isMarketingPageSlug`) and the
 * static exporter's route enumeration (`export/route-manifest.ts`) both have to answer this same
 * question, and previously each spelled its own answer — the exporter excluded shells and `404`,
 * the live route excluded neither, so `/blog-post` and `/404` were publicly reachable 200s on the
 * running server while the export correctly omitted them. Two resolvers for one question is a
 * drift waiting to happen; this is the single one both now call.
 *
 * NOT tier-gated: `pages` is empty for every non-static theme (`loadStaticTierAssets`'s own early
 * return), and both callers already branch on `tier === "static"` for their own separate reasons
 * (the live route to pick a resolution strategy, the exporter to skip the theme entirely). Gating
 * here too would be a third copy of a guarantee that already holds twice over.
 *
 * **Publish state (2026-08-30 addition, off-by-default retroactively since the same day).** Once
 * every {@link isPublishableThemePageCandidate} check passes, this also consults
 * {@link ThemeManifest.publishedPages} — see that field's own doc for the absent-means-unpublished /
 * present-means-explicit-allow-list contract. Checked LAST, after every shape check above: a page
 * that isn't even a candidate is never "unpublished", it simply isn't a publishable page at all.
 *
 * @complexity O(t) over `manifest.templates`' length — 0–3 entries on every real theme on disk.
 */
export function isStandaloneThemePage(theme: DiscoveredTheme, pageId: string): boolean {
  if (!isPublishableThemePageCandidate(theme, pageId)) return false;
  const { publishedPages } = theme.manifest;
  // No recorded decision on this theme at all — off by default (2026-08-30 owner correction,
  // applied retroactively to every theme, not only ones touched after this date). See
  // `ThemeManifest.publishedPages`'s own doc for the full history and the owner's own reasoning.
  if (publishedPages === undefined) return false;
  return publishedPages.includes(pageId);
}

/**
 * Read the static tier's assets as one unit, or nothing at all for any other tier.
 *
 * A static theme is a different kind of artifact from every other tier — already-complete HTML
 * documents plus their partials and an optional light-token variant, rather than a route map of
 * templates a rendering engine fills in — so none of this shares a branch with the other tiers.
 * Kept out of {@link loadTheme}, tier check included, because inlining it there made one function
 * responsible for four unrelated on-disk layouts and left the caller re-testing the tier three
 * separate times.
 *
 * Errors are returned rather than thrown, matching {@link loadTheme}'s contract that one bad theme
 * degrades to `status: "invalid"` instead of breaking discovery for every other theme.
 *
 * @complexity O(f) in the theme folder's entries, each read at most once.
 * @overallScore 100
 */
function loadStaticTierAssets(
  required: {
    themeDir: string;
    tier: ThemeTier;
    slots?: Record<string, ThemeSlotDescriptor>;
    templates?: string[];
    apiVersion?: 2;
  },
  _optional: Record<string, never> = {}
): StaticTierAssets {
  const { themeDir, tier, slots, templates, apiVersion } = required;
  if (tier !== "static") return NO_STATIC_TIER_ASSETS;

  const errors: string[] = [];
  const tokensLight = readLightTokens({ themeDir, errors });

  // REQ-01's spirit, not its exact home+entry pair: a static theme's minimum is one page to
  // actually show, not a route id a templating engine would fill in. `resolveThemeLayout` is the one
  // apiVersion-aware source of truth for this folder name — v2 nests it one level deeper
  // (`render/pages/`, theme-authoring-guide-v2.md §3) — v1 keeps `pages/` at the theme root.
  const layout = resolveThemeLayout(apiVersion);
  const pagesDirName = layout.pagesDir;
  const pages: Record<string, string> = {};
  const pagesDir = join(themeDir, pagesDirName);
  if (existsSync(pagesDir)) {
    for (const file of readdirSync(pagesDir)) {
      if (file.endsWith(".html")) {
        pages[file.slice(0, -".html".length)] = readFileSync(join(pagesDir, file), "utf8");
      }
    }
  }
  if (!pages.index) errors.push(`${pagesDirName}/index.html is required`);

  errors.push(...validateTemplateDeclarations({ templates, pages, pagesDirName }));

  // Partials (`nav`, `footer`, and anything else the manifest declares) live at the theme root in v1,
  // not under pages/, because a static page embeds them via a `{"type":"partial"}` marker the
  // renderer resolves rather than a template-include directive baked in at author time. v2 moves this
  // to `render/partials/`, alongside `render/pages/` — `layout.partialsDir` is `""` for v1 (the theme
  // root itself, see `ThemeLayout.partialsDir`'s own doc), which `join(themeDir, "")` resolves back to
  // `themeDir` unchanged. A theme with no `slots` block gets DEFAULT_THEME_SLOTS, which is the
  // nav/footer pair this scan used to hardcode.
  const partialsDir = join(themeDir, layout.partialsDir);
  const partials = loadSlotPartials({ partialsDir, slots: slots ?? DEFAULT_THEME_SLOTS });

  return { tokensLight, pages, partials, errors };
}

/**
 * Build a {@link ThemeManifest} from `theme.json`'s already-parsed, already-object-checked
 * contents — pure field-by-field shaping, no validation (see {@link validateManifestCrossFields}
 * for the checks that read more than one field at a time, and {@link parseThemeManifest} for the
 * try/catch this sits inside).
 */
function parseRawManifestFields(raw: Readonly<JsonObject>, id: string): ThemeManifest {
  const resolvedId = String(raw.id ?? id);
  return {
    id: resolvedId,
    name: String(raw.name ?? id),
    version: String(raw.version ?? "0.0.0"),
    apiVersion: raw.apiVersion === 2 ? 2 : undefined,
    tier: parseTier(raw.tier),
    engine: typeof raw.engine === "number" ? raw.engine : 1,
    author: parseOptionalString(raw.author),
    build: parseThemeBuildInfo(raw.build),
    description: parseOptionalString(raw.description),
    fonts: parseOptionalStringArray(raw.fonts),
    regions: parseOptionalStringArray(raw.regions),
    // NOT `raw.skipLiquidAllowlist` — see this field's own doc comment on `ThemeManifest` for the
    // 2026-08-18 schema v2 decision. Sourced from the trusted local list, never the package's own JSON.
    skipLiquidAllowlist: TRUSTED_SKIP_LIQUID_ALLOWLIST_THEME_IDS.has(resolvedId),
    // No `postTemplate`/`pageTemplate` back-compat aliases (2026-08-11 unification, owner's
    // standing rule on this contract: strictness over compat code). A manifest still carrying the
    // retired spelling simply loads with no templates, same as one that never declared any —
    // `check:embed-marker-drift` is what catches a manifest that needed converting, not this parse.
    templates: parseOptionalStringArray(raw.templates),
    publishedPages: parseOptionalStringArray(raw.publishedPages),
    modes: parseOptionalStringArray(raw.modes),
    defaultMode: parseOptionalString(raw.defaultMode),
    slots: parseSlots(raw.slots),
  };
}

/**
 * The `build.source: "compiled"` cross-field checks — a compiled theme is, at runtime, an
 * ordinary `static` theme, so there is no server-executing tier it maps onto (see
 * {@link ThemeBuildInfo}'s own doc), and its `sourceDir`/`artifactHashes` are REQUIRED once
 * `source` says `compiled` even though {@link parseThemeBuildInfo} treats them as optional shape.
 * Split out of {@link validateManifestCrossFields} so that function's own three top-level checks
 * (id match, `defaultMode`, and "is this a compiled build") stay a flat sequence.
 */
function validateCompiledBuildManifest(build: ThemeBuildInfo, tier: ThemeTier): string[] {
  const errors: string[] = [];
  if (tier !== "static") {
    errors.push("theme.json build.source 'compiled' requires tier 'static'");
  }
  if (!build.sourceDir) {
    errors.push("theme.json build.sourceDir is required when build.source is 'compiled'");
  } else if (isSourceDirGeneratedConflict(build.sourceDir)) {
    // The deeper fix promised in `explore.ts`'s PUT handler comment (2026-08-13): a manifest is
    // refused HERE, at install time, rather than relying only on each write route's own
    // `isGeneratedThemePath` call-site refusal. That refusal (explore.ts, marketplace.ts) stays —
    // this is an earlier, independent layer, not a replacement for it. See
    // `isSourceDirGeneratedConflict`'s own doc for the three conflicting shapes (exact, nested
    // inside, or ancestor-of a generated dir) and why `"preview-notes"` is not one of them.
    errors.push(
      `theme.json build.sourceDir '${build.sourceDir}' must not name or contain a generated theme directory (${GENERATED_THEME_DIRS.join(", ")})`
    );
  }
  if (!build.artifactHashes || Object.keys(build.artifactHashes).length === 0) {
    errors.push("theme.json build.artifactHashes is required when build.source is 'compiled'");
  }
  return errors;
}

/**
 * Cross-field manifest checks — each reads more than one field, which is why none of these live
 * inside {@link parseRawManifestFields} or a single field's own parser (matching how
 * {@link parseThemeBuildInfo}'s own doc already draws this line for `build`).
 */
function validateManifestCrossFields(manifest: ThemeManifest, id: string): string[] {
  const errors: string[] = [];
  if (manifest.id !== id) errors.push(`theme.json id '${manifest.id}' must equal folder name '${id}'`);
  // A `defaultMode` the theme ships no tokens for would silently render the base `:root` block
  // while the manifest claims otherwise — the exact "declared but unreachable" failure wiring
  // these fields was meant to end, so it fails the theme loudly instead of falling back.
  if (manifest.defaultMode !== undefined && !(manifest.modes ?? []).includes(manifest.defaultMode)) {
    errors.push(
      `theme.json defaultMode '${manifest.defaultMode}' is not listed in modes [${(manifest.modes ?? []).join(", ")}]`
    );
  }
  if (manifest.build?.source === "compiled") {
    errors.push(...validateCompiledBuildManifest(manifest.build, manifest.tier));
  }
  return errors;
}

/** A manifest that never parsed at all — {@link parseThemeManifest}'s fallback when `theme.json`
 * is missing, unreadable, or not an object. Every field falls back to what `loadTheme` used
 * before any of these fields existed. */
function emptyThemeManifest(id: string): ThemeManifest {
  return { id, name: id, version: "0.0.0", tier: "declarative", engine: 1 };
}

/**
 * Read and validate `theme.json`. Never throws — a read/parse failure degrades to
 * {@link emptyThemeManifest} plus one error, matching {@link loadTheme}'s "one bad theme never
 * breaks discovery" contract (SPEC-004 REQ-10 spirit).
 */
function parseThemeManifest(themeDir: string, id: string): { manifest: ThemeManifest; errors: string[] } {
  try {
    const raw = readJson(join(themeDir, "theme.json"));
    if (!isObject(raw)) throw new Error("theme.json is not an object");
    const manifest = parseRawManifestFields(raw, id);
    return { manifest, errors: validateManifestCrossFields(manifest, id) };
  } catch (err) {
    return { manifest: emptyThemeManifest(id), errors: [`theme.json: ${(err as Error).message}`] };
  }
}

/** Read `tokens.json`. Never throws — a read/parse failure degrades to an empty token map plus
 * one error, the same REQ-10 contract {@link parseThemeManifest} follows for `theme.json`. */
function loadThemeTokens(themeDir: string): { tokens: ThemeTokens; errors: string[] } {
  try {
    const raw = readJson(join(themeDir, "tokens.json"));
    if (!isObject(raw)) throw new Error("tokens.json is not an object");
    return { tokens: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)])), errors: [] };
  } catch (err) {
    return { tokens: {}, errors: [`tokens.json: ${(err as Error).message}`] };
  }
}

/**
 * The install-time gate for a built release (ADR-020 §5) — only runs for `build.source:
 * "compiled"` (a no-op otherwise, so every theme on disk today is unaffected). Needs
 * `pages`/`partials`, so {@link loadTheme} cannot call this any earlier than after
 * {@link loadStaticTierAssets} — see `build-conformance.ts`'s own header for what it checks and
 * why a hard failure here, not a runtime warning, is the point.
 */
function checkCompiledBuildConformance(
  manifest: ThemeManifest,
  themeDir: string,
  pages: Readonly<Record<string, string>>,
  partials: Readonly<Record<string, string>>
): string[] {
  if (manifest.build?.source !== "compiled") return [];
  return checkBuiltThemeConformance({
    themeId: manifest.id,
    themeDir,
    sourceDir: manifest.build.sourceDir,
    pages,
    partials,
    artifactHashes: manifest.build.artifactHashes ?? {},
    apiVersion: manifest.apiVersion,
  }).map((issue) => `build conformance (${issue.rule}) '${issue.page}': ${issue.message}`);
}

/** Which of the three template source families a `templates/` (or v2 `render/pages/`) directory
 * entry belongs to, by extension — `"unknown"` for anything {@link loadTemplateSources} ignores
 * (same as the original silent no-op for a non-matching file). */
function classifyTemplateFile(file: string): "json" | "liquid" | "handlebars" | "unknown" {
  if (file.endsWith(".json")) return "json";
  if (file.endsWith(".liquid")) return "liquid";
  if (file.endsWith(".hbs") || file.endsWith(".handlebars")) return "handlebars";
  return "unknown";
}

/** Declarative tier: one block-tree template per `.json` file. */
function loadJsonTemplateFile(
  templatesDir: string,
  templatesDirName: string,
  file: string,
  target: { templates: Record<string, TemplateNode>; errors: string[] }
): void {
  const templateId = file.slice(0, -".json".length);
  try {
    target.templates[templateId] = readJson(join(templatesDir, file));
  } catch (err) {
    target.errors.push(`${templatesDirName}/${file}: ${(err as Error).message}`);
  }
}

/**
 * Templated tier (ADR-020): raw LiquidJS source, rendered by the engine in render.ts. C6/REQ-06
 * lint-before-publish: reject any tag/filter outside the ADR-020 §3 allowlist before the theme
 * can load as valid — unless this theme is on the trusted `skipLiquidAllowlist` list (see
 * `ThemeManifest` doc comment: the runtime's other Tier-2 guardrails — worker isolation,
 * filesystem lockdown, memory/render/parse limits — still apply either way).
 */
function loadLiquidTemplateFile(
  templatesDir: string,
  templatesDirName: string,
  file: string,
  skipLiquidAllowlist: boolean,
  target: { liquidTemplates: Record<string, string>; errors: string[] }
): void {
  const templateId = file.slice(0, -".liquid".length);
  const source = readFileSync(join(templatesDir, file), "utf8");
  const violations = skipLiquidAllowlist ? [] : lintLiquidTemplate(source);
  if (violations.length > 0) {
    target.errors.push(`${templatesDirName}/${file}: ${violations.join("; ")}`);
  } else {
    target.liquidTemplates[templateId] = source;
  }
}

/**
 * Handlebars tier (ADR-020): raw Handlebars source, rendered by the isolated worker in
 * `server/http/site/handlebars-worker.ts`. Exactly the same lint-before-publish contract
 * {@link loadLiquidTemplateFile} applies, against the Handlebars-specific allowlist — a
 * disallowed helper, a partial, a decorator, or a `{{{raw}}}` output outside the one sanctioned
 * path fails the theme rather than reaching the compiler. Both extensions are accepted
 * (Handlebars' ecosystem uses them interchangeably) and map to the same template-id namespace, so
 * `home.hbs` and `home.handlebars` are the same template id — the last one `readdirSync` yields
 * wins, which is why a theme should ship one or the other, not both.
 */
function loadHandlebarsTemplateFile(
  templatesDir: string,
  templatesDirName: string,
  file: string,
  target: { handlebarsTemplates: Record<string, string>; errors: string[] }
): void {
  const ext = file.endsWith(".hbs") ? ".hbs" : ".handlebars";
  const templateId = file.slice(0, -ext.length);
  const source = readFileSync(join(templatesDir, file), "utf8");
  const violations = lintHandlebarsTemplate(source);
  if (violations.length > 0) {
    target.errors.push(`${templatesDirName}/${file}: ${violations.join("; ")}`);
  } else {
    target.handlebarsTemplates[templateId] = source;
  }
}

/**
 * Scan the theme's route-map directory (v1: theme-root `templates/`; v2: `render/pages/` —
 * theme-authoring-guide-v2.md §3, same folder name static pages use, only the naming convention
 * changes) and dispatch each file to its extension's loader. A missing directory is not an error
 * here — the required-template check ({@link validateRequiredTemplates}) is what turns "no home/
 * entry template" into one, the same REQ-10 fault-isolation split {@link loadStaticTierAssets}
 * already draws between "nothing found" and "what's required".
 */
function loadTemplateSources(
  themeDir: string,
  manifest: ThemeManifest
): {
  templatesDirName: string;
  templates: Record<string, TemplateNode>;
  liquidTemplates: Record<string, string>;
  handlebarsTemplates: Record<string, string>;
  errors: string[];
} {
  // v1: non-static tiers keep their route map at theme-root `templates/`. v2 unifies every tier's
  // route map under `render/pages/` — only the naming convention changes, the per-extension
  // dispatch below (json/liquid/hbs) stays identical either way.
  const templatesDirName = manifest.apiVersion === 2 ? "render/pages" : "templates";
  const templatesDir = join(themeDir, templatesDirName);
  const templates: Record<string, TemplateNode> = {};
  const liquidTemplates: Record<string, string> = {};
  const handlebarsTemplates: Record<string, string> = {};
  const errors: string[] = [];

  if (!existsSync(templatesDir)) {
    return { templatesDirName, templates, liquidTemplates, handlebarsTemplates, errors };
  }

  for (const file of readdirSync(templatesDir)) {
    const kind = classifyTemplateFile(file);
    if (kind === "json") {
      loadJsonTemplateFile(templatesDir, templatesDirName, file, { templates, errors });
    } else if (kind === "liquid") {
      loadLiquidTemplateFile(templatesDir, templatesDirName, file, manifest.skipLiquidAllowlist ?? false, {
        liquidTemplates,
        errors,
      });
    } else if (kind === "handlebars") {
      loadHandlebarsTemplateFile(templatesDir, templatesDirName, file, { handlebarsTemplates, errors });
    }
  }

  return { templatesDirName, templates, liquidTemplates, handlebarsTemplates, errors };
}

/** Which template-id map is authoritative for a tier's required home/entry check, and the file
 * extension its error messages should name — templated themes ship `.liquid`, handlebars themes
 * ship `.hbs`, every other (non-static) tier ships plain `.json`. */
function requiredTemplatesForTier(
  tier: ThemeTier,
  templates: Readonly<Record<string, TemplateNode>>,
  liquidTemplates: Readonly<Record<string, string>>,
  handlebarsTemplates: Readonly<Record<string, string>>
): { ext: string; required: Readonly<Record<string, unknown>> } {
  if (tier === "templated") return { ext: "liquid", required: liquidTemplates };
  if (tier === "handlebars") return { ext: "hbs", required: handlebarsTemplates };
  return { ext: "json", required: templates };
}

/**
 * REQ-01: a theme's required template minimum is home + entry (the base). C3: post/page are
 * optional specializations that fall through to entry (REQ-03). A static theme has no separate
 * route-map folder at all — its required-file check is {@link loadStaticTierAssets}'s job, not
 * this one's.
 */
function validateRequiredTemplates(
  manifest: ThemeManifest,
  templatesDirName: string,
  templates: Readonly<Record<string, TemplateNode>>,
  liquidTemplates: Readonly<Record<string, string>>,
  handlebarsTemplates: Readonly<Record<string, string>>
): string[] {
  if (manifest.tier === "static") return [];
  const { ext, required } = requiredTemplatesForTier(manifest.tier, templates, liquidTemplates, handlebarsTemplates);
  const errors: string[] = [];
  if (!required.home) errors.push(`${templatesDirName}/home.${ext} is required`);
  if (!required.entry) errors.push(`${templatesDirName}/entry.${ext} is required`);
  return errors;
}

/**
 * v1: static keeps CSS under `css/styles.css` (alongside sibling `js/` and `pages/` folders);
 * every other tier keeps a lone `styles.css` at the theme root, the flat single-stylesheet shape
 * that fits a route-map-only theme. v2 unifies every tier onto `css/theme.css`
 * (theme-authoring-guide-v2.md §3) — same folder name static already used, new filename, and now
 * every tier gets the `css/` folder rather than just static.
 */
function loadThemeCss(themeDir: string, manifest: ThemeManifest): string {
  const cssPath = join(
    themeDir,
    manifest.apiVersion === 2 ? "css/theme.css" : manifest.tier === "static" ? "css/styles.css" : "styles.css"
  );
  return existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
}

/**
 * Load one theme folder. Returns a DiscoveredTheme with `status: "invalid"` and
 * a populated `errors` list instead of throwing, so one bad theme never breaks
 * discovery (SPEC-004 REQ-10 spirit).
 */
export function loadTheme(
  required: { themeDir: string; id: string; source: "built-in" | "site" },
  _optional: Record<string, never> = {}
): DiscoveredTheme {
  const { themeDir, id, source } = required;
  const errors: string[] = [];

  const { manifest, errors: manifestErrors } = parseThemeManifest(themeDir, id);
  errors.push(...manifestErrors);

  const { tokens, errors: tokenErrors } = loadThemeTokens(themeDir);
  errors.push(...tokenErrors);

  // The static tier's whole on-disk layout — light tokens, pages/, root partials — loaded in one
  // call rather than as branches threaded through the tier-agnostic loading below. Empty for every
  // other tier, so nothing here needs to re-test which tier this is.
  const { tokensLight, pages, partials, errors: staticErrors } = loadStaticTierAssets({
    themeDir,
    tier: manifest.tier,
    slots: manifest.slots,
    templates: manifest.templates,
    apiVersion: manifest.apiVersion,
  });
  errors.push(...staticErrors);

  errors.push(...checkCompiledBuildConformance(manifest, themeDir, pages, partials));

  const { templatesDirName, templates, liquidTemplates, handlebarsTemplates, errors: templateErrors } =
    loadTemplateSources(themeDir, manifest);
  errors.push(...templateErrors);
  errors.push(
    ...validateRequiredTemplates(manifest, templatesDirName, templates, liquidTemplates, handlebarsTemplates)
  );

  const css = loadThemeCss(themeDir, manifest);

  return {
    manifest,
    dir: themeDir,
    tokens,
    tokensLight,
    templates,
    liquidTemplates,
    handlebarsTemplates,
    pages,
    partials,
    css,
    source,
    status: errors.length === 0 ? "valid" : "invalid",
    errors,
  };
}

/**
 * Discover every theme folder under `dir`. Missing dir ⇒ empty list (a site
 * served without a themes/ dir is legal, SPEC-004 REQ-05).
 *
 * `exclude` skips named subdirectories that aren't themes themselves — used by
 * {@link discoverAllBuiltInThemes} to keep the engine-specific subfolders
 * (`templated/`, `handlebars/`) from being scanned as (invalid) top-level theme
 * candidates when it also scans them directly as their own theme roots.
 *
 * Separately (and unconditionally, not via `exclude`), any child directory whose name starts with
 * {@link MIGRATION_STAGING_DIR_PREFIX} is skipped too — `exclude` only expresses exact names known
 * ahead of time (engine subfolders, the two catalog dirs), never a per-run-randomized prefix like
 * migration scratch output, so that one case gets its own always-on check here instead of being
 * threaded through every caller's `exclude` array.
 */
export function discoverThemes(
  required: { dir: string; source: "built-in" | "site"; exclude?: readonly string[] },
  _optional: Record<string, never> = {}
): DiscoveredTheme[] {
  const { dir, source, exclude } = required;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      if (exclude?.includes(name)) return false;
      if (name.startsWith(MIGRATION_STAGING_DIR_PREFIX)) return false;
      if (name === PUBLISH_STAGING_DIR || name === PUBLISH_PREVIOUS_DIR) return false;
      const full = join(dir, name);
      return statSync(full).isDirectory();
    })
    .map((name) => loadTheme({ themeDir: join(dir, name), id: name, source }))
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

/**
 * Named engine-specific subfolders under a themes root, one per {@link ThemeTier} except `code`
 * (not built yet) — every tier's themes live under its own subfolder so `themes/` doesn't mix
 * formats in one flat listing (2026-08-10: `declarative` moved off the bare top level, and the
 * LiquidJS-tier folder renamed from `liquidjs/` to `templated/` to match its `ThemeTier` value —
 * `templated` names the tier, not the engine, so more templating engines can land under this same
 * folder later without another rename). Scanning a missing subfolder is a no-op (`discoverThemes`'s
 * own missing-dir ⇒ empty-list behavior), so adding an engine here ahead of its first theme costs
 * nothing.
 *
 * Exported because it is also the containment boundary the `themes` agent-tool domain enforces
 * (`agent-tools.ts`/`tool-registrations.ts`): a theme folder that is not a direct child of the
 * themes root or of one of THESE subfolders is not a recognized theme root, and no agent-driven file
 * write may resolve into it.
 */
export const ENGINE_SUBFOLDERS = ["declarative", "templated", "handlebars", "static"] as const;

/**
 * The pristine-originals catalog under a themes root: shipped themes kept untouched so a copy can
 * always be compared against, reset to, or re-forked from what it started as.
 *
 * It is NOT a tier and NOT a theme — it holds its own `<tier>/<theme>/` tree — so discovery skips it
 * outright. A catalog theme is never runnable, never listed, and never the active theme; it becomes
 * either of those only by being COPIED into a real tier folder, which is the whole point: editing
 * your copy can never damage the thing you'd want to compare it against.
 *
 * The `__` prefix is load-bearing rather than decorative. It makes "this is not an installed theme"
 * a property of the name that any code path can check, instead of a list every new write path has to
 * remember to consult — see the containment note on {@link ENGINE_SUBFOLDERS}, which already refuses
 * agent-driven writes to anything that isn't a direct child of the root or of an engine subfolder.
 */
export const THEME_CATALOG_DIR = "__original-themes__";

/**
 * The local marketplace fixture root under a themes root — a stand-in for a remote theme
 * marketplace (see `content/themes/__marketplace__/README.md` for what a real one would still need:
 * network, search, versioning). Same shape as {@link THEME_CATALOG_DIR}: `<tier>/<id>/` per
 * {@link ENGINE_SUBFOLDERS}, and the same NOT-a-tier/NOT-a-theme status, for the same reason —
 * discovery skips it outright. A marketplace entry becomes a real, runnable theme only via
 * `downloadMarketplaceTheme` (`marketplace.ts`), which copies it into both {@link THEME_CATALOG_DIR}
 * and a live tier folder under a freshly assigned id ({@link nextAvailableThemeId}).
 */
export const MARKETPLACE_CATALOG_DIR = "__marketplace__";

/**
 * Prefix of the scratch directory `migrate-theme.ts`'s `createStagingDir` creates as a sibling of the
 * real theme folder it's migrating (`.tovu-migrate-staging-<id>-<random-hex>`), and deliberately
 * LEAVES ON DISK after a dry run or a failed migration for inspection (see that module's own header).
 * Not a tier and not a theme — same status as {@link THEME_CATALOG_DIR}/{@link MARKETPLACE_CATALOG_DIR}
 * — but unlike those two fixed names, discovery can't skip it by exact-name `exclude` because the
 * random suffix makes every occurrence's name unique; {@link discoverThemes} matches on this prefix
 * instead. ARCH-001 (2026-08-19): two such directories were swept into a commit by a broad `git add`
 * and discovered as three "basic"-id themes (the real one plus both scratch copies, which retain the
 * migrated manifest's `id`) before this constant existed to filter them out.
 */
export const MIGRATION_STAGING_DIR_PREFIX = ".tovu-migrate-staging-";

/**
 * Publish's own scratch folders at the themes ROOT (`publish-files-plan-2026-09-24.md` §3):
 * `theme-files` apply stages an incoming tree under {@link PUBLISH_STAGING_DIR} and moves the tree
 * it replaces under {@link PUBLISH_PREVIOUS_DIR}, so the swap is two renames on one filesystem. Not
 * tiers and not themes — {@link discoverThemes} skips both by name, as the site backup does.
 */
export const PUBLISH_STAGING_DIR = ".publish-staging";
export const PUBLISH_PREVIOUS_DIR = ".publish-previous";

/**
 * Discover every built-in theme across the top-level (declarative) folder plus every engine
 * subfolder in {@link ENGINE_SUBFOLDERS}. The one call site every composition root should use
 * instead of a raw {@link discoverThemes} call, so the liquidjs/handlebars split is a detail this
 * function owns rather than something every caller re-derives.
 */
export function discoverAllBuiltInThemes(
  required: { dir: string; source: "built-in" | "site" },
  _optional: Record<string, never> = {}
): DiscoveredTheme[] {
  const { dir, source } = required;
  const topLevel = discoverThemes({
    dir,
    source,
    exclude: [...ENGINE_SUBFOLDERS, THEME_CATALOG_DIR, MARKETPLACE_CATALOG_DIR],
  });
  const engineThemes = ENGINE_SUBFOLDERS.flatMap((sub) => discoverThemes({ dir: join(dir, sub), source }));
  return [...topLevel, ...engineThemes].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

/**
 * Assign a folder-safe id for a NEW theme being installed under `themesRoot`, guaranteeing it does
 * not collide with anything already there. Theme ids are unique per FOLDER, not globally (see
 * {@link duplicateThemeIds}) — the fix is to never create a second folder claiming an id already in
 * use, which is what this makes possible at the one call site that creates theme folders today
 * (`downloadMarketplaceTheme`, `marketplace.ts`).
 *
 * Checks BOTH the installed tier folder (`<themesRoot>/<tier>/<id>`) and the catalog
 * (`<themesRoot>/{@link THEME_CATALOG_DIR}/<tier>/<id>`) — a download writes to both in lockstep, so
 * a folder existing in only one of them (e.g. a previous run left the pair out of sync) still counts
 * as taken. Picking an id free in one and not the other would recreate the exact desync this exists
 * to prevent.
 *
 * `desiredId` is only ever SUFFIXED, never renumbered: an id that already ends in a digit (e.g.
 * `basic9`) gets `basic9-1` on collision, not `basic10` — the suffix always unambiguously means "the
 * Nth copy of this id", never a digit that could be mistaken for part of the original id.
 *
 * @param required.desiredId - The id to try first (typically a marketplace fixture's own `theme.json` id).
 * @param required.themesRoot - The themes root both the tier folder and the catalog live under.
 * @param required.tier - Which {@link ENGINE_SUBFOLDERS} tier's folder to check.
 * @returns `desiredId` if free, else `desiredId-1`, `desiredId-2`, … — the first free suffix.
 * @complexity O(n) filesystem existence checks, where n is the number of prior collisions on
 * `desiredId` (2 checks each); O(1) (2 checks) in the common, no-collision case.
 */
export function nextAvailableThemeId(
  required: { desiredId: string; themesRoot: string; tier: ThemeTier },
  _optional: Record<string, never> = {}
): string {
  const { desiredId, themesRoot, tier } = required;
  const isTaken = (id: string): boolean =>
    existsSync(join(themesRoot, tier, id)) || existsSync(join(themesRoot, THEME_CATALOG_DIR, tier, id));

  if (!isTaken(desiredId)) return desiredId;

  let suffix = 1;
  while (isTaken(`${desiredId}-${suffix}`)) suffix += 1;
  return `${desiredId}-${suffix}`;
}

/**
 * Re-run discovery and refill `themes` IN PLACE with the result.
 *
 * Discovery is otherwise a boot-time snapshot: the composition root calls {@link
 * discoverAllBuiltInThemes} once and freezes the array into `RouteDeps.themes`, so a theme that
 * appears on disk afterwards — downloaded from the marketplace, copied from the originals catalog,
 * dropped in by hand, pulled in by git — is invisible until the process restarts. That is fine for a
 * server whose themes only ever ship with it, and wrong for one where copying a theme is a normal
 * thing a user does in the admin UI.
 *
 * Mutates rather than returns because `RouteDeps.themes` is a plain array every consumer already
 * holds a reference to and reads per request (`deps.themes.find(...)` at request time, not at
 * registration time). Refilling that one array updates every reader at once; handing back a new array
 * would update only whoever remembered to re-read it, which is the same staleness bug one level in.
 *
 * Returns what changed so a caller can report it — a rescan that silently finds nothing is
 * indistinguishable from a rescan that didn't run.
 */
export function rescanThemes(
  required: { themes: DiscoveredTheme[]; dir: string; source?: "built-in" | "site" },
  _optional: Record<string, never> = {}
): { added: string[]; removed: string[]; total: number } {
  const { themes, dir, source = "built-in" } = required;
  const before = new Set(themes.map((t) => t.manifest.id));
  const fresh = discoverAllBuiltInThemes({ dir, source });
  const after = new Set(fresh.map((t) => t.manifest.id));

  themes.length = 0;
  themes.push(...fresh);

  return {
    added: [...after].filter((id) => !before.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id)).sort(),
    total: fresh.length,
  };
}

/**
 * Theme ids that more than one discovered theme claims.
 *
 * Ids are unique per FOLDER, not globally: `loadTheme` only checks that `theme.json`'s `id` equals
 * its own folder name, and {@link discoverAllBuiltInThemes} concatenates the top level with every
 * engine subfolder. So `static/nordic` and `handlebars/nordic` both load, both claim `nordic`, and
 * {@link findTheme} silently returns whichever sorts first — meaning `active_theme_id` can name two
 * different themes and the site renders one of them with no error anywhere.
 *
 * Surfaced rather than resolved: picking a winner here would hide the collision, and the real fix is
 * assigning a unique id when the theme is created (a download/copy appends `-1`, `-2`, …). This is
 * what lets the admin say so instead of rendering the wrong theme quietly.
 */
export function duplicateThemeIds(themes: DiscoveredTheme[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const theme of themes) {
    if (seen.has(theme.manifest.id)) duplicates.add(theme.manifest.id);
    seen.add(theme.manifest.id);
  }
  return [...duplicates].sort();
}

/** Ids of discovered themes that passed validation. */
export function validThemeIds(themes: DiscoveredTheme[]): string[] {
  return themes.filter((t) => t.status === "valid").map((t) => t.manifest.id);
}

/** Find a theme by id (any status). */
export function findTheme(
  required: { themes: DiscoveredTheme[]; id: string },
  _optional: Record<string, never> = {}
): DiscoveredTheme | undefined {
  const { themes, id } = required;
  return themes.find((t) => t.manifest.id === id);
}

/**
 * {@link findTheme} for a STORED id (the active-theme setting), which may name a renamed theme by
 * its retired id or name the current id on a site that still only has the retired folder. Tries
 * `themeIdCandidates(id)` in order (current name first). Explicit per-theme admin routes keep using
 * the exact {@link findTheme}: they address a theme the listing just showed, by its real id.
 */
export function findStoredTheme(required: { themes: DiscoveredTheme[]; id: string }): DiscoveredTheme | undefined {
  for (const candidate of themeIdCandidates(required.id)) {
    const theme = findTheme({ themes: required.themes, id: candidate });
    if (theme) return theme;
  }
  return undefined;
}

/**
 * SPEC-004 REQ-03 fallthrough chain, keyed by route, trimmed to the spike's routes: `home` and
 * `products`/`product` are own-named only (no fallthrough — a theme that doesn't declare one
 * simply has no such page, REQ-10 spirit); `post` tries `post` first, then falls through to
 * `entry` (built-ins ship `entry`; `post` is an optional override a theme may add to specialize
 * posts — AC-07). One candidate list per route rather than a route-shaped if/else chain, so
 * {@link resolveRouteTemplateId} stays a single loop instead of re-deriving this same shape three
 * times (once per source-map type below).
 */
const ROUTE_TEMPLATE_CANDIDATES: Readonly<Record<"home" | "post" | "products" | "product", readonly string[]>> = {
  home: ["home"],
  post: ["post", "entry"],
  products: ["products"],
  product: ["product"],
};

/**
 * Shared REQ-03 resolution core behind `resolveTemplateId`/`resolveLiquidTemplateId`/
 * `resolveHandlebarsTemplateId` — the three differ only in which source-map type they resolve
 * against (declarative block trees, raw `.liquid` source, raw `.hbs` source), never in the
 * fallthrough logic itself, so that logic lives here once. `templates` is read generically
 * (presence/truthiness only, via `Record<string, unknown>`) because none of the three callers'
 * value types matter to this decision — only whether a given template id exists.
 */
function resolveRouteTemplateId(
  route: "home" | "post" | "products" | "product",
  templates: Readonly<Record<string, unknown>>
): string | null {
  for (const candidateId of ROUTE_TEMPLATE_CANDIDATES[route]) {
    if (templates[candidateId]) return candidateId;
  }
  return null;
}

/**
 * Resolve a page route to a template id — see {@link ROUTE_TEMPLATE_CANDIDATES} for the REQ-03
 * fallthrough chain this applies.
 */
export function resolveTemplateId(
  required: { route: "home" | "post" | "products" | "product"; templates: Record<string, TemplateNode> },
  _optional: Record<string, never> = {}
): string | null {
  return resolveRouteTemplateId(required.route, required.templates);
}

/**
 * Templated-tier (LiquidJS) analogue of `resolveTemplateId`: same REQ-03 fallthrough over the raw
 * `.liquid` source map.
 */
export function resolveLiquidTemplateId(
  required: { route: "home" | "post" | "products" | "product"; liquidTemplates: Record<string, string> },
  _optional: Record<string, never> = {}
): string | null {
  return resolveRouteTemplateId(required.route, required.liquidTemplates);
}

/**
 * Handlebars-tier analogue of `resolveTemplateId`: same REQ-03 fallthrough over the raw `.hbs`
 * source map.
 */
export function resolveHandlebarsTemplateId(
  required: { route: "home" | "post" | "products" | "product"; handlebarsTemplates: Record<string, string> },
  _optional: Record<string, never> = {}
): string | null {
  return resolveRouteTemplateId(required.route, required.handlebarsTemplates);
}
