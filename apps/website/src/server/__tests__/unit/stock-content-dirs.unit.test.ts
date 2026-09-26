import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { builtInThemesDir, bundledAgentPluginsDir } from "../../runtime/composition/deps.js";

/**
 * @file Regression coverage for the 2026-08-27 `src/` -> `content/` stock-data move.
 *
 * Purpose:
 * Shipped DATA (themes, templates, bundled agent plugins, the `/agent-icons` static tree) no longer
 * lives inside `src/`. It lives in a tracked, read-only top-level `content/`. Two things can break
 * silently when that tree moves, and neither is caught by `tsc` (none of these directories holds a
 * single `.ts` file, so nothing imports them):
 *
 *  1. **Layout portability.** Every one of these paths is resolved via `resolveProductRoot()`
 *     (`product-root.ts`), a walk-up that finds the nearest ancestor with both a `package.json` and a
 *     `content/` dir — deliberately NOT a fixed `../` count off `import.meta.dirname` (CR-R04 — see
 *     `deps.ts`'s `builtInThemesDir` header). Since the 2026-08-27 `apps/website/` rename, the SOURCE
 *     tree (`apps/website/src/server/` -> `<repo-root>/content`) and the COMPILED tree
 *     (`dist/src/server/` -> `dist/content`) sit at DIFFERENT depths below their own root, so a fixed
 *     relative offset can never be correct in both at once (`product-root.ts`'s own header). This file
 *     asserts the resolved ABSOLUTE destination against the real filesystem instead — the one thing
 *     both trees actually have to agree on.
 *
 *  2. **Build staleness.** `dist/` is never cleaned wholesale, so an asset copy that only ever adds
 *     files leaves deleted themes behind forever. Before this change `dist/src/themes/` carried four
 *     theme folders (`column`, `grayscale`, `handlebars`, `liquidjs`) that had not existed in source
 *     for weeks, and a published image shipped them. Deleting them once fixes nothing; the copy step
 *     has to clean its own target.
 *
 * Architectural role:
 * A repo-invariant test, not a unit of product logic. It reads the real `package.json` and the real
 * `deps.ts` exports rather than a fixture, because a fixture could not observe either regression.
 */

/** `apps/website/src/server/__tests__/unit/` -> repo root. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "..");

/** The directory `deps.ts` itself resolves from, i.e. what `import.meta.dirname` sees there. */
const DEPS_DIR = path.join(REPO_ROOT, "apps", "website", "src", "server");

/** The directory `site-dir/read-template.ts` resolves `TEMPLATES_ROOT` from. */
const SITE_DIR_DIR = path.join(REPO_ROOT, "apps", "website", "src", "platform", "site-dir");

/**
 * Both env overrides must be unset for these assertions to describe the package-relative default
 * rather than whatever a developer exported. Asserted rather than deleted: silently mutating the
 * process env would make a real misconfiguration look like a pass.
 */
function assertNoStockDirOverride(): void {
  assert.equal(
    process.env.TOVU_STOCK_THEMES_DIR,
    undefined,
    "TOVU_STOCK_THEMES_DIR is set; this test asserts the package-relative DEFAULT",
  );
  assert.equal(
    process.env.TOVU_BUNDLED_AGENT_PLUGINS_DIR,
    undefined,
    "TOVU_BUNDLED_AGENT_PLUGINS_DIR is set; this test asserts the package-relative DEFAULT",
  );
}

test("stock themes resolve to content/themes via the product-root walk-up, landing on the real repo root's content/", () => {
  assertNoStockDirOverride();

  // Not a fixed `../` count: `builtInThemesDir()` walks up via `resolveProductRoot()` precisely
  // because a fixed offset from `DEPS_DIR` cannot be correct in both the source tree
  // (`apps/website/src/server`, four levels above `content/`) and the compiled tree (`dist/src/server`,
  // two levels above `dist/content/`) at once -- see `product-root.ts`'s own header. What both trees
  // DO share is the absolute destination, so that -- not the relative offset -- is what this asserts.
  assert.equal(
    path.relative(DEPS_DIR, builtInThemesDir()),
    path.join("..", "..", "..", "..", "content", "themes"),
    "builtInThemesDir() must land on <repo-root>/content/themes from this source tree's DEPS_DIR",
  );
  assert.equal(builtInThemesDir(), path.join(REPO_ROOT, "content", "themes"));
  assert.ok(existsSync(builtInThemesDir()), `${builtInThemesDir()} does not exist`);
  assert.ok(existsSync(path.join(builtInThemesDir(), "static", "tovu-theme", "theme.json")));
});

test("bundled agent plugins resolve to content/agent-plugins via the product-root walk-up", () => {
  assertNoStockDirOverride();

  assert.equal(
    path.relative(DEPS_DIR, bundledAgentPluginsDir()),
    path.join("..", "..", "..", "..", "content", "agent-plugins"),
  );
  assert.equal(bundledAgentPluginsDir(), path.join(REPO_ROOT, "content", "agent-plugins"));
  assert.ok(existsSync(path.join(bundledAgentPluginsDir(), "site-compliance")));
});

test("site templates resolve to content/templates via the product-root walk-up", () => {
  // `read-template.ts` holds `TEMPLATES_ROOT` in a module-private const with no accessor, so the
  // offset is asserted against the source text. Weaker than calling an export, but it is the only
  // way to observe the constant, and the alternative -- asserting only that `readTemplate("starter")`
  // succeeds -- would pass just as happily on a cwd-relative path that breaks under `dist/`.
  const source = readFileSync(path.join(SITE_DIR_DIR, "read-template.ts"), "utf8");
  assert.match(
    source,
    /path\.join\(\s*resolveProductRoot\(\),\s*"content",\s*"templates"\s*\)/,
    "read-template.ts must resolve TEMPLATES_ROOT via resolveProductRoot(), not a fixed ../ count, so it lands correctly in both the source and compiled trees",
  );
  assert.ok(existsSync(path.join(REPO_ROOT, "content", "templates", "starter", "template.json")));
});

test("no stock data directory is left behind inside src/", () => {
  for (const stale of ["themes", "templates", "public", "agent-plugins"]) {
    assert.equal(
      existsSync(path.join(REPO_ROOT, "src", stale)),
      false,
      `src/${stale} still exists; stock data belongs in content/`,
    );
  }
});

/**
 * Every `cp -R <src>/. <dest>/` pair in the `build` script, in command order.
 *
 * @complexity O(n) over the length of the build script string.
 */
function assetCopies(buildScript: string): { from: string; to: string; at: number }[] {
  const copies: { from: string; to: string; at: number }[] = [];
  const pattern = /cp -R (\S+)\/\. (\S+)\/(?=\s|$)/g;
  for (let m = pattern.exec(buildScript); m !== null; m = pattern.exec(buildScript)) {
    copies.push({ from: m[1], to: m[2], at: m.index });
  }
  return copies;
}

test("the build script copies stock data to dist/content, not dist/src", () => {
  const buildScript = String(
    (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
      .scripts.build,
  );

  const stock = assetCopies(buildScript).filter((c) => c.from.startsWith("content/"));
  assert.deepEqual(
    stock.map((c) => `${c.from} -> ${c.to}`).sort(),
    [
      "content/agent-plugins -> dist/content/agent-plugins",
      "content/public -> dist/content/public",
      "content/templates -> dist/content/templates",
      "content/themes -> dist/content/themes",
    ],
    "all four stock trees must be copied from content/ to dist/content/",
  );
});

test("every asset copy in the build script cleans its destination first", () => {
  const buildScript = String(
    (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
      .scripts.build,
  );

  for (const copy of assetCopies(buildScript)) {
    // Any `rm -rf` BEFORE this copy that names the destination or one of its ancestors. Ancestors
    // count because `rm -rf dist/content` legitimately cleans `dist/content/themes` too.
    const ancestors = new Set<string>();
    const segments = copy.to.split("/");
    for (let i = 1; i <= segments.length; i += 1) ancestors.add(segments.slice(0, i).join("/"));

    const cleaned = [...buildScript.slice(0, copy.at).matchAll(/rm -rf ([^&|]+)/g)]
      .flatMap((m) => m[1].trim().split(/\s+/))
      .some((target) => ancestors.has(target));

    assert.ok(
      cleaned,
      `build script copies into ${copy.to} without an earlier "rm -rf" of it or an ancestor; ` +
        `deleted source files would survive in dist/ forever (this is how dist/src/themes/ came to ` +
        `ship column, grayscale, handlebars and liquidjs after they were removed from source)`,
    );
  }
});
