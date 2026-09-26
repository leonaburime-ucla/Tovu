#!/usr/bin/env -S npx tsx
// Relocated 2026-08-18 out of src/themes/static/basic/ (the schema-v2 approved-roots
// list has no slot for a script or its `preview/` output — theme-authoring-guide-v2.md
// §3, structure.ts's V2_APPROVED_ROOTS) as part of migrating `basic` to schema v2. STALE:
// still hardcoded to `basic`'s pre-migration v1 layout (css/styles.css, js/*.js, pages/,
// root nav.html/footer*.html) — the theme itself now uses v2's css/theme.css,
// scripts/*.js, render/pages/, render/partials/, so this script no longer runs against
// the theme's real files as-is. Superseded functionally by src/features/theme/static-render.ts,
// the real renderer this script was always a stand-in for (see original comment below).
// Kept for its git history and in case future dev-preview tooling revives the pattern for
// a v2-shaped theme; not wired into any build/CI step.
//
// Original header, otherwise unchanged:
// Stand-in for Tovu's real `static`-tier theme loader (not wired into
// src/features/theme/theme.ts yet). Stitches nav/footer slots + both token sets into
// standalone HTML under preview/<mode>/, mirroring what the host renderer will do:
// read tokens.json + tokens.light.json, emit :root and :root[data-theme="light"],
// resolve `type: "partial"` `data-embed-config` markers against the theme's declared
// partials, via the shared parser so this script can't drift from the real one. Every
// output page ships BOTH token sets and the live toggle — <mode> only controls the
// page's initial data-theme, not which tokens are available. Re-run after editing
// nav.html, footer.html, pages/*.html, or either tokens file.
//
// Run: ./build-preview.mjs (uses the shebang above) or `npx tsx build-preview.mjs`.
// This script needs the TS loader to reach the shared marker parser; plain
// `node build-preview.mjs` cannot load a TypeScript module and will fail.
// NOTE: keep the shebang's interpreter command free of the literal word
// "import" (e.g. don't rewrite this as `node --import tsx`) — tsx@4.19's
// dynamic-import prescan misreads that word in a shebang as real code and
// throws a bogus "Parse error" the moment the file also has a `//` comment.
// Confirmed by bisection; not our bug to fix here.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { substituteMarkers } from "#src/contracts/core/embeds/marker";

const ROOT = join(import.meta.dirname, "..", "..", "content", "themes", "static", "tovu-theme");

function tokensToCss(darkTokens, lightTokens) {
  const darkLines = Object.entries(darkTokens).map(([k, v]) => `  ${k}: ${v};`);
  const lightLines = Object.entries(lightTokens).map(([k, v]) => `  ${k}: ${v};`);
  return (
    `:root {\n${darkLines.join("\n")}\n}\n` +
    `:root[data-theme="light"] {\n${lightLines.join("\n")}\n}`
  );
}

function resolveSlots(html, { navHtml, footerHtml, footerMinimalHtml }) {
  // Both slots go through the one shared marker parser (src/contracts/core/embeds/marker.ts) —
  // see development/docs/architecture/embed-marker-migration.md. `resolve` returning
  // undefined leaves a marker exactly as authored, which also covers every
  // `data-embed-config` this preview script doesn't know about (e.g. `type: "menu"`
  // markers inside nav.html/footer.html themselves stay untouched, same as before).
  return substituteMarkers(html, (marker) => {
    if (marker.type !== "partial") return undefined;
    if (marker.id === "nav") {
      const current = marker.config.current;
      if (typeof current !== "string") return navHtml;
      // Mark the matching nav link with aria-current="page" — mirrors what the
      // original export did inline per-page; here it's derived from one shared
      // partial + the marker's declared `current`, not duplicated markup.
      const re = new RegExp(`(<a href="[^"]+" data-nav-id="${current}")(>)`);
      return navHtml.replace(re, '$1 aria-current="page"$2');
    }
    if (marker.id === "footer") {
      return marker.config.variant === "minimal" ? footerMinimalHtml : footerHtml;
    }
    return undefined;
  });
}

function build(mode) {
  const outDir = join(ROOT, "preview", mode);
  // Clean first: this build only ever copies/writes files it currently knows about, so a file
  // removed from source (e.g. a deleted script) would otherwise linger here forever as a stale
  // orphan (this happened for real — js/typewriter.js survived two rebuilds after deletion).
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "css"), { recursive: true });
  mkdirSync(join(outDir, "js/vendor"), { recursive: true });

  const darkTokens = JSON.parse(readFileSync(join(ROOT, "tokens.json"), "utf8"));
  const lightTokens = JSON.parse(readFileSync(join(ROOT, "tokens.light.json"), "utf8"));
  const navHtml = readFileSync(join(ROOT, "nav.html"), "utf8");
  const footerHtml = readFileSync(join(ROOT, "footer.html"), "utf8");
  const footerMinimalHtml = readFileSync(join(ROOT, "footer-minimal.html"), "utf8");

  copyFileSync(join(ROOT, "css/styles.css"), join(outDir, "css/styles.css"));
  copyFileSync(join(ROOT, "js/main.js"), join(outDir, "js/main.js"));
  copyFileSync(join(ROOT, "js/theme-toggle.js"), join(outDir, "js/theme-toggle.js"));
  copyFileSync(join(ROOT, "js/reveal.js"), join(outDir, "js/reveal.js"));
  copyFileSync(join(ROOT, "js/hero-intro.js"), join(outDir, "js/hero-intro.js"));
  copyFileSync(join(ROOT, "js/vendor/motion.js"), join(outDir, "js/vendor/motion.js"));

  const tokenCss = tokensToCss(darkTokens, lightTokens);
  const pagesDir = join(ROOT, "pages");
  const pages = readdirSync(pagesDir).filter((f) => f.endsWith(".html"));

  for (const file of pages) {
    let html = readFileSync(join(pagesDir, file), "utf8");
    if (mode === "light") html = html.replace("<html lang=\"en\">", "<html lang=\"en\" data-theme=\"light\">");
    html = html.replace('<link rel="stylesheet" href="../css/styles.css" />', () =>
      `<style>\n${tokenCss}\n</style>\n<link rel="stylesheet" href="css/styles.css" />`
    );
    html = html.replace('<script src="../js/theme-toggle.js"></script>', '<script src="js/theme-toggle.js"></script>');
    html = html.replace('<script src="../js/main.js"></script>', '<script src="js/main.js"></script>');
    html = html.replace('<script src="../js/vendor/motion.js"></script>', '<script src="js/vendor/motion.js"></script>');
    html = html.replace('<script src="../js/reveal.js"></script>', '<script src="js/reveal.js"></script>');
    html = html.replace('<script src="../js/hero-intro.js"></script>', '<script src="js/hero-intro.js"></script>');
    html = resolveSlots(html, { navHtml, footerHtml, footerMinimalHtml });
    writeFileSync(join(outDir, file), html);
  }
  console.log(`built ${pages.length} pages -> ${outDir} (initial mode: ${mode}, toggle live in both)`);
}

build("dark");
build("light");
