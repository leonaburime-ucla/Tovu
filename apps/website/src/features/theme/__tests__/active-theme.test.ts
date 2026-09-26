import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_THEME_ID, NO_THEME_ID, resolveActiveTheme } from "../active-theme.js";
import type { DiscoveredTheme } from "../theme.js";

/**
 * @file Certifies {@link resolveActiveTheme} — "given the discovered themes and a stored active
 * theme id, which theme actually renders".
 *
 * The regression this file exists to prevent: the resolver's fallback used to be
 * `deps.themes.find((t) => t.status === "valid")`, i.e. *whatever theme sorts first alphabetically*,
 * because discovery sorts by `manifest.id.localeCompare` (`theme.ts`'s `discoverAllBuiltInThemes`).
 * `basic` won on every real site purely by coincidence of naming — installing a theme called
 * `aurora` would have silently made IT the default for every site whose configured theme no longer
 * resolved. `seed.ts` documented that exact bug and routed around it by hardcoding `"tovu-theme"` into
 * the seeded row rather than fixing the resolver.
 *
 * Every fallback case below therefore puts a VALID theme that sorts before `basic` at the head of
 * the list. A test whose list happens to be ordered with `basic` first would pass under the old
 * arbitrary-order behaviour too and would certify nothing.
 */

function makeTheme(id: string, status: DiscoveredTheme["status"] = "valid"): DiscoveredTheme {
  return {
    manifest: { id, name: id, version: "1.0.0", tier: "static", engine: 1 },
    dir: `/fake/${id}`,
    tokens: {},
    tokensLight: {},
    templates: {},
    liquidTemplates: {},
    handlebarsTemplates: {},
    pages: {},
    partials: {},
    css: "",
    source: "site",
    status,
    errors: [],
  } as unknown as DiscoveredTheme;
}

/** Discovery order: `aurora` sorts before `basic`, exactly as `localeCompare` would place it. */
function sortedThemes(...ids: string[]): DiscoveredTheme[] {
  return [...ids].sort((a, b) => a.localeCompare(b)).map((id) => makeTheme(id));
}

test("the constant is a name, and it is the id the stock theme actually ships under", () => {
  assert.equal(DEFAULT_THEME_ID, "tovu-theme");
});

test("step 1: a configured, valid theme wins over the named default", () => {
  const themes = sortedThemes("aurora", "tovu-theme", "storefront");
  assert.equal(resolveActiveTheme({ themes }, "storefront")?.manifest.id, "storefront");
});

test("step 2: an unresolvable configured id falls back to the NAMED default, not the first valid theme", () => {
  // `aurora` is valid AND sorts first — the old resolver returned it here.
  const themes = sortedThemes("aurora", "tovu-theme", "storefront");
  assert.equal(resolveActiveTheme({ themes }, "deleted-theme")?.manifest.id, DEFAULT_THEME_ID);
});

test("step 2: a configured theme that discovery marked invalid also falls back to the named default", () => {
  const themes = [makeTheme("aurora"), makeTheme("tovu-theme"), makeTheme("broken", "invalid")].sort((a, b) =>
    a.manifest.id.localeCompare(b.manifest.id)
  );
  assert.equal(resolveActiveTheme({ themes }, "broken")?.manifest.id, DEFAULT_THEME_ID);
});

test("step 2 does not fire for an INVALID default: an unloadable `basic` is not rendered", () => {
  // The named default must clear the same `status === "valid"` bar the configured theme does,
  // otherwise this change would make a site render a theme the old code correctly refused.
  const themes = [makeTheme("aurora"), makeTheme("tovu-theme", "invalid")];
  assert.equal(resolveActiveTheme({ themes }, "deleted-theme")?.manifest.id, "aurora");
});

test("step 3 (unchanged): no default installed at all still falls through to the first valid theme", () => {
  const themes = sortedThemes("aurora", "storefront");
  assert.equal(resolveActiveTheme({ themes }, "deleted-theme")?.manifest.id, "aurora");
});

test("step 3 (unchanged): with no valid theme anywhere, the first discovered theme is still returned", () => {
  const themes = [makeTheme("aurora", "invalid"), makeTheme("storefront", "invalid")];
  assert.equal(resolveActiveTheme({ themes }, "deleted-theme")?.manifest.id, "aurora");
});

test("step 3 (unchanged): an empty discovery list is still `null`", () => {
  assert.equal(resolveActiveTheme({ themes: [] }, "tovu-theme"), null);
});

/**
 * The fallback used to be silent, which is the only reason the arbitrary-order bug survived long
 * enough to be worked around in `seed.ts` instead of fixed. These certify that each degraded step
 * announces itself and names the ids an operator needs to act on.
 */

function captureWarnings(t: import("node:test").TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    lines.push(String(message));
  });
  return lines;
}

test("step 1 is silent — a healthy site must not log on every request", (t) => {
  const warnings = captureWarnings(t);
  resolveActiveTheme({ themes: sortedThemes("aurora", "tovu-theme") }, "tovu-theme");
  assert.deepEqual(warnings, []);
});

test("step 2 warns, naming the configured id that vanished AND the default it fell back to", (t) => {
  const warnings = captureWarnings(t);
  resolveActiveTheme({ themes: sortedThemes("aurora", "tovu-theme") }, "deleted-theme");

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /deleted-theme/);
  assert.match(warnings[0] ?? "", /tovu-theme/);
});

test("step 3 warns that the default is gone too — a strictly worse state than step 2, said differently", (t) => {
  const warnings = captureWarnings(t);
  resolveActiveTheme({ themes: sortedThemes("aurora", "storefront") }, "deleted-theme");

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /deleted-theme/);
  assert.match(warnings[0] ?? "", /aurora/);
  assert.notEqual(warnings[0], undefined);
  // Must not be the step-2 message: the two states need different remedies (reactivate a theme vs.
  // reinstall the stock theme), so one shared string would be worse than no string.
  assert.doesNotMatch(warnings[0] ?? "", /falling back to the default theme/);
});

test("a site with zero themes warns rather than returning null silently", (t) => {
  const warnings = captureWarnings(t);
  assert.equal(resolveActiveTheme({ themes: [] }, "tovu-theme"), null);
  assert.equal(warnings.length, 1);
});

/**
 * State 3 — the operator deliberately turned the theme OFF. Distinct from state 2 ("nothing chosen
 * / the configured theme is gone", which falls back to the named default above) because the two
 * need opposite treatment: state 2 must substitute a theme, state 3 must substitute NOTHING.
 * Collapsing them onto the same `null` would route "deliberately themeless" straight into
 * `sendNoThemesInstalled`'s 500.
 */

test("the sentinel's exact spelling is pinned — `apps/admin` mirrors this literal by hand", () => {
  // `apps/admin/src/lib/api.ts` re-declares this value rather than importing it, following the same
  // documented client-mirrors-the-wire-contract convention `ThemeTier`/`THEME_TIERS` already use
  // (a browser bundle cannot import server internals). Admin's own `rules.unit.test.ts` pins the
  // same literal from its side, so changing the spelling here without changing it there turns one
  // of the two suites red instead of silently splitting the sentinel in half.
  assert.equal(NO_THEME_ID, "none");
});

test("the sentinel is not the empty string — `\"\"` already means something else", () => {
  // `features/presentation/active-theme-id.ts` returns `""` for "this workspace has no
  // presentation_settings row yet", and its own doc defines that as "fall back". If the deliberate
  // no-theme sentinel were also `""`, a workspace that had simply never been written would render
  // themeless instead of on the default theme — state 3 arriving where state 2 belongs.
  assert.notEqual(NO_THEME_ID, "");
});

test("state 3: the sentinel resolves to the sentinel — no theme, no substitute", () => {
  const themes = sortedThemes("aurora", "tovu-theme", "storefront");
  assert.equal(resolveActiveTheme({ themes }, NO_THEME_ID), NO_THEME_ID);
});

test("state 3 is NOT null: `null` means 'nothing installed', which is a 500, and these must not collapse", () => {
  const themes = sortedThemes("aurora", "tovu-theme");
  assert.notEqual(resolveActiveTheme({ themes }, NO_THEME_ID), null);
  assert.equal(resolveActiveTheme({ themes: [] }, "whatever"), null);
});

test("state 3 wins even with zero themes installed — turning the theme off is not a degraded state", () => {
  assert.equal(resolveActiveTheme({ themes: [] }, NO_THEME_ID), NO_THEME_ID);
});

test("state 3 is silent — a deliberate choice is not a warning", (t) => {
  const warnings = captureWarnings(t);
  resolveActiveTheme({ themes: sortedThemes("aurora", "tovu-theme") }, NO_THEME_ID);
  assert.deepEqual(warnings, []);
});

test("state 2 still fires for `\"\"` — an unwritten workspace gets the default theme, not no theme", () => {
  // The whole reason the sentinel is not `""`. `resolveActiveThemeId` returns `""` for a workspace
  // with no `presentation_settings` row; that must still reach the NAMED DEFAULT, never state 3.
  const themes = sortedThemes("aurora", "tovu-theme", "storefront");
  const resolved = resolveActiveTheme({ themes }, "");

  assert.notEqual(resolved, NO_THEME_ID, "an unwritten workspace must not read as 'deliberately themeless'");
  assert.ok(resolved !== null && resolved !== NO_THEME_ID, "must resolve to a real theme");
  assert.equal(resolved.manifest.id, DEFAULT_THEME_ID);
});

test("a theme folder literally named `none` is shadowed by the sentinel, not the other way round", () => {
  // The sentinel is checked BEFORE discovery, so an operator who happens to have a theme with this
  // id cannot make "no theme" silently mean "that theme". Shadowed, documented, and not a crash.
  const themes = [makeTheme("tovu-theme"), makeTheme(NO_THEME_ID)];
  assert.equal(resolveActiveTheme({ themes }, NO_THEME_ID), NO_THEME_ID);
});

// `basic` -> `tovu-theme` rename (2026-09-26, `theme-id-aliases.ts`): a stored retired id and an
// un-renamed site folder must both keep resolving, with no fallback warning.
test("a stored retired id `basic` resolves to the renamed `tovu-theme`, silently", (t) => {
  const warnings = captureWarnings(t);
  const resolved = resolveActiveTheme({ themes: sortedThemes("aurora", "tovu-theme") }, "basic");
  assert.ok(resolved !== null && resolved !== NO_THEME_ID);
  assert.equal(resolved.manifest.id, "tovu-theme");
  assert.deepEqual(warnings, []);
});

test("a site seeded before the rename (only a `basic` folder) still resolves `basic` and the default", (t) => {
  const warnings = captureWarnings(t);
  const stored = resolveActiveTheme({ themes: sortedThemes("aurora", "basic") }, "basic");
  const fallback = resolveActiveTheme({ themes: sortedThemes("aurora", "basic") }, "");
  assert.ok(stored !== null && stored !== NO_THEME_ID && fallback !== null && fallback !== NO_THEME_ID);
  assert.equal(stored.manifest.id, "basic");
  assert.equal(fallback.manifest.id, "basic");
  assert.equal(warnings.length, 1, "only the unwritten-workspace fallback warns");
});

test("a site holding BOTH folders renders the current one for a stored `basic` (publish carries the renamed copy)", () => {
  const resolved = resolveActiveTheme({ themes: sortedThemes("basic", "tovu-theme") }, "basic");
  assert.ok(resolved !== null && resolved !== NO_THEME_ID);
  assert.equal(resolved.manifest.id, "tovu-theme");
});
