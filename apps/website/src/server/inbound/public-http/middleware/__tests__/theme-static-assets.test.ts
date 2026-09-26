import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { registerThemeStaticAssets } from "../theme-static-assets.js";
import { createApp } from "#src/server/runtime/composition/app";

/**
 * @file Regression coverage for `registerThemeStaticAssets`'s 2026-08-12 extension from a single
 * `static`-tier root to a multi-root `themeRoots` list (added so `templated`-tier themes' own
 * images/screenshots become servable at `/theme-assets/{id}/...` — see that file's own header for
 * why). Two halves:
 *
 *   1. Fixture-based unit tests against throwaway temp directories (fast, no dependency on which
 *      real themes happen to exist on disk) — multi-root precedence, the `__`-prefix catalog
 *      refusal, path-traversal refusal, 404 fallthrough, and the `.liquid`-source-is-not-HTML
 *      content-type claim this change's own doc comment makes.
 *   2. A real end-to-end check through `createApp()` (the actual composition root, not a stand-in)
 *      confirming an existing `static`-tier theme's real asset serves byte-for-byte identically to
 *      before this change — the "prove the static tier isn't regressed" requirement — alongside the
 *      new `templated`-tier theme's own assets now resolving instead of 404ing.
 */

function withTempApp(fn: (baseUrl: string) => Promise<void>, roots: readonly string[]): Promise<void> {
  const app = express();
  registerThemeStaticAssets(app, { themeRoots: roots });
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("expected a real listening address"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      try {
        await fn(baseUrl);
        resolve();
      } catch (err) {
        reject(err as Error);
      } finally {
        server.close();
      }
    });
  });
}

/** Builds `<tmp>/<rootName>/<themeId>/<relPath>` = `content`, returning the root's absolute path. */
function makeThemeFixture(rootName: string, files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), `theme-assets-${rootName}-`));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(root, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("registerThemeStaticAssets: serves a file from the first root that has it", async (t) => {
  const rootA = makeThemeFixture("a", { "theme-one/styles.css": "body{color:red}" });
  const rootB = makeThemeFixture("b", { "theme-two/styles.css": "body{color:blue}" });
  t.after(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  await withTempApp(async (baseUrl) => {
    const resA = await fetch(`${baseUrl}/theme-assets/theme-one/styles.css`);
    assert.equal(resA.status, 200);
    assert.equal(await resA.text(), "body{color:red}");

    const resB = await fetch(`${baseUrl}/theme-assets/theme-two/styles.css`);
    assert.equal(resB.status, 200);
    assert.equal(await resB.text(), "body{color:blue}");
  }, [rootA, rootB]);
});

test("registerThemeStaticAssets: a theme id present under both roots resolves to the FIRST root (documented tie-break)", async (t) => {
  const rootA = makeThemeFixture("first", { "same-id/marker.txt": "from-first-root" });
  const rootB = makeThemeFixture("second", { "same-id/marker.txt": "from-second-root" });
  t.after(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  await withTempApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/theme-assets/same-id/marker.txt`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "from-first-root", "first-listed root must win the collision");
  }, [rootA, rootB]);
});

test("registerThemeStaticAssets: __-prefixed catalog ids are refused across every root, not just the first", async (t) => {
  const rootA = makeThemeFixture("catalog-a", { "__original-themes__/leak.txt": "should never serve" });
  const rootB = makeThemeFixture("catalog-b", {});
  t.after(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  await withTempApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/theme-assets/__original-themes__/leak.txt`);
    assert.equal(res.status, 404);
  }, [rootA, rootB]);
});

test("registerThemeStaticAssets: .tovu-migrate-staging-* scratch directories are refused, not served as a theme's own folder (ARCH-001, 2026-08-19)", async (t) => {
  // Mirrors the real on-disk shape: migrate-theme.ts's createStagingDir leaves this dir as a SIBLING
  // of the real theme it staged, both containing whatever files the migration copied (css/theme.css
  // here stands in for that). Before the fix, resolveThemeDir only refused "" and "__"-prefixed
  // names, so this resolved and served exactly like a real theme id.
  const rootA = makeThemeFixture("staging-a", {
    "basic/css/theme.css": "body{color:orange}",
    ".tovu-migrate-staging-basic-14cece79e115/css/theme.css": "body{color:orange}",
  });
  t.after(() => rmSync(rootA, { recursive: true, force: true }));

  await withTempApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/theme-assets/.tovu-migrate-staging-basic-14cece79e115/css/theme.css`);
    assert.equal(res.status, 404);

    // The real theme with the un-prefixed name must still serve, proving this isn't a blanket refusal.
    const realRes = await fetch(`${baseUrl}/theme-assets/basic/css/theme.css`);
    assert.equal(realRes.status, 200);
    assert.equal(await realRes.text(), "body{color:orange}");
  }, [rootA]);
});

test("registerThemeStaticAssets: the retired `basic` id serves the renamed `tovu-theme` folder, current name first, retired folder as file-level fallback", async (t) => {
  // `basic` -> `tovu-theme` (2026-09-26, `theme-id-aliases.ts`): `/theme-assets/basic/...` URLs are
  // baked into stored content, and sites seeded before the rename only have a `basic` folder.
  const renamedOnly = makeThemeFixture("alias-renamed", { "tovu-theme/css/theme.css": "renamed" });
  const retiredOnly = makeThemeFixture("alias-retired", { "basic/css/theme.css": "retired" });
  const both = makeThemeFixture("alias-both", {
    "tovu-theme/css/theme.css": "renamed",
    "basic/css/theme.css": "retired",
    "basic/css/only-in-retired.css": "retired-only",
  });
  t.after(() => [renamedOnly, retiredOnly, both].forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  await withTempApp(async (baseUrl) => {
    assert.equal(await (await fetch(`${baseUrl}/theme-assets/basic/css/theme.css`)).text(), "renamed");
  }, [renamedOnly]);
  await withTempApp(async (baseUrl) => {
    assert.equal(await (await fetch(`${baseUrl}/theme-assets/tovu-theme/css/theme.css`)).text(), "retired");
  }, [retiredOnly]);
  await withTempApp(async (baseUrl) => {
    assert.equal(await (await fetch(`${baseUrl}/theme-assets/basic/css/theme.css`)).text(), "renamed");
    assert.equal(await (await fetch(`${baseUrl}/theme-assets/tovu-theme/css/only-in-retired.css`)).text(), "retired-only");
    assert.equal((await fetch(`${baseUrl}/theme-assets/basic/css/missing.css`)).status, 404);
  }, [both]);
});

test("registerThemeStaticAssets: path traversal in the themeId segment cannot escape either root", async (t) => {
  const rootA = makeThemeFixture("trav-a", { "real-theme/ok.txt": "fine" });
  t.after(() => rmSync(rootA, { recursive: true, force: true }));

  await withTempApp(async (baseUrl) => {
    // Encoded so Express's router treats it as one :themeId segment rather than splitting the path.
    const res = await fetch(`${baseUrl}/theme-assets/${encodeURIComponent("../../../../etc")}/passwd`);
    assert.ok(res.status === 404 || res.status === 400, `expected refusal, got ${res.status}`);
  }, [rootA]);
});

test("registerThemeStaticAssets: resolveThemeDir is actually WIRED to the shared resolvePathWithin containment check, not just the dot/__ prefix guard", async (t) => {
  // Regression for the exact gap this task existed to close: d4ef2941 wrote the shared
  // containment helper (core/path-containment.ts) but never wired theme-static-assets.ts to it,
  // and nothing caught that. This pins the wiring itself, not the helper (already covered
  // directly by core/__tests__/unit/path-containment.unit.test.ts).
  //
  // "foo/../../outside-secret" does NOT start with "." or "__", so resolveThemeDir's early
  // dot/__ guard cannot be what refuses it -- verified directly (not assumed): a standalone probe
  // logging req.params.themeId for an encoded payload of this shape showed Express delivers it
  // verbatim, embedded slashes and all, and `.startsWith(".")`/`.startsWith("__")` both evaluate
  // false against it. A 404 here can only come from resolvePathWithin's own refusal.
  //
  // The traversal target is a real, readable SIBLING directory of the served root (not a system
  // file like /etc/passwd) specifically so a wiring regression is unambiguous: if resolvePathWithin
  // were ever replaced with a bare `path.resolve(root, themeId)` (no containment check at all),
  // "foo/../../outside-secret" resolves to a real directory that exists and contains a real file,
  // so the request would come back 200 with that file's actual bytes -- not an incidental 404 for
  // an unrelated reason (verified this by actually doing the swap: the first version of this test
  // used /etc/passwd as the target and stayed green even with the containment check removed,
  // because path.resolve landed on a FILE, and express.static can't serve a file as if it were a
  // directory root, so it 404s either way -- a false negative that doesn't distinguish "refused"
  // from "broken". This version does not have that problem.).
  const parentDir = mkdtempSync(path.join(tmpdir(), "theme-assets-wiring-parent-"));
  const rootA = path.join(parentDir, "theme-root");
  mkdirSync(path.join(rootA, "real-theme"), { recursive: true });
  writeFileSync(path.join(rootA, "real-theme", "ok.txt"), "fine");
  const outsideDir = path.join(parentDir, "outside-secret");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(path.join(outsideDir, "marker.txt"), "SHOULD NEVER BE SERVED");
  t.after(() => rmSync(parentDir, { recursive: true, force: true }));

  await withTempApp(async (baseUrl) => {
    // Positive control: a benign id under the SAME root still resolves and serves, so the
    // refusal below is provably about the traversal, not a general breakage of this root.
    const okRes = await fetch(`${baseUrl}/theme-assets/real-theme/ok.txt`);
    assert.equal(okRes.status, 200);
    assert.equal(await okRes.text(), "fine");

    // Two ".." exactly cancels "foo" then climbs from rootA to parentDir, landing on
    // outside-secret/ regardless of how deep the OS's own tmpdir happens to be -- deterministic,
    // not environment-dependent. Encoded so Express's router treats the whole value as one
    // :themeId segment rather than splitting the path.
    const payload = encodeURIComponent("foo/../../outside-secret");
    const res = await fetch(`${baseUrl}/theme-assets/${payload}/marker.txt`);
    assert.equal(res.status, 404, `expected the containment check to refuse the traversal, got ${res.status}`);
  }, [rootA]);
});

test("registerThemeStaticAssets: an id absent from every root 404s (no crash, clean fallthrough)", async (t) => {
  const rootA = makeThemeFixture("empty-a", {});
  t.after(() => rmSync(rootA, { recursive: true, force: true }));

  await withTempApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/theme-assets/does-not-exist/anything.css`);
    assert.equal(res.status, 404);
  }, [rootA]);
});

test("registerThemeStaticAssets: a .liquid template source file serves, but NOT as an HTML/script-executable content-type", async (t) => {
  const rootA = makeThemeFixture("liquid-a", {
    "my-theme/templates/product.liquid": "<h1>{{ product.title }}</h1>",
  });
  t.after(() => rmSync(rootA, { recursive: true, force: true }));

  await withTempApp(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/theme-assets/my-theme/templates/product.liquid`);
    assert.equal(res.status, 200);
    const contentType = res.headers.get("content-type") ?? "";
    assert.ok(
      !contentType.includes("text/html") && !contentType.includes("javascript") && !contentType.includes("svg"),
      `expected a non-executable content-type for .liquid, got "${contentType}"`
    );
    assert.equal(await res.text(), "<h1>{{ product.title }}</h1>");
  }, [rootA]);
});

test("registerThemeStaticAssets: font files carry `Access-Control-Allow-Origin: *` without credentials; non-font files carry no CORS header", async (t) => {
  // Theme Studio's preview is `<iframe sandbox="allow-scripts">`, an opaque ("null") origin, and
  // `@font-face` fetches are always CORS-mode, so without this header every theme font is blocked in
  // the preview (QA 2026-09-13: basic's geist-var.woff2 / geist-mono-var.woff2). The negative half
  // pins the scope: CSS/HTML/liquid load in no-cors mode and must not become cross-origin readable.
  const rootA = makeThemeFixture("cors-a", {
    "my-theme/assets/fonts/geist-var.woff2": "wOF2-fixture",
    "my-theme/assets/fonts/legacy.WOFF": "wOFF-fixture",
    "my-theme/assets/fonts/display.ttf": "ttf-fixture",
    "my-theme/css/theme.css": "body{}",
    "my-theme/pages/index.html": "<h1>hi</h1>",
    "my-theme/templates/product.liquid": "<h1>{{ product.title }}</h1>",
  });
  t.after(() => rmSync(rootA, { recursive: true, force: true }));

  await withTempApp(async (baseUrl) => {
    for (const file of ["assets/fonts/geist-var.woff2", "assets/fonts/legacy.WOFF", "assets/fonts/display.ttf"]) {
      const res = await fetch(`${baseUrl}/theme-assets/my-theme/${file}`);
      assert.equal(res.status, 200, `${file} should serve`);
      assert.equal(res.headers.get("access-control-allow-origin"), "*", `${file} must be CORS-loadable`);
      assert.equal(res.headers.get("access-control-allow-credentials"), null, `${file} must never allow credentials`);
      assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; sandbox", `${file} keeps the sandbox CSP`);
    }
    for (const file of ["css/theme.css", "pages/index.html", "templates/product.liquid"]) {
      const res = await fetch(`${baseUrl}/theme-assets/my-theme/${file}`);
      assert.equal(res.status, 200, `${file} should serve`);
      assert.equal(res.headers.get("access-control-allow-origin"), null, `${file} must not be CORS-readable`);
    }
  }, [rootA]);
});

// ---------------------------------------------------------------------------
// Real end-to-end check through the actual composition root (createApp()) —
// proves the static tier is unregressed and the templated tier now works.
// ---------------------------------------------------------------------------

test("createApp(): the real 'basic' static theme's real css/theme.css still serves byte-for-byte identically (static tier not regressed)", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a real listening address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const onDisk = readFileSync(path.resolve(import.meta.dirname, "../../../../../../../../content/themes/static/tovu-theme/css/theme.css"), "utf8");
  const res = await fetch(`${baseUrl}/theme-assets/tovu-theme/css/theme.css`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), onDisk);
});

test("createApp(): the real 'basic' theme's Geist fonts are CORS-loadable (`*`, no credentials) for the sandboxed Theme Studio preview", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a real listening address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  for (const file of ["geist-var.woff2", "geist-mono-var.woff2"]) {
    const res = await fetch(`${baseUrl}/theme-assets/tovu-theme/assets/fonts/${file}`);
    assert.equal(res.status, 200, `${file} should serve`);
    assert.equal(res.headers.get("content-type"), "font/woff2");
    assert.equal(res.headers.get("access-control-allow-origin"), "*", `${file} must be CORS-loadable`);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  }
});

test("createApp(): the new 'fashion-modern' templated theme's own assets now resolve (the gap this change closes)", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a real listening address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stylesOnDisk = readFileSync(
    path.resolve(import.meta.dirname, "../../../../../../../../content/themes/templated/fashion-modern/css/theme.css"),
    "utf8"
  );
  const stylesRes = await fetch(`${baseUrl}/theme-assets/fashion-modern/css/theme.css`);
  assert.equal(stylesRes.status, 200);
  assert.equal(await stylesRes.text(), stylesOnDisk);

  const screenshotRes = await fetch(`${baseUrl}/theme-assets/fashion-modern/screenshots/index.jpg`);
  assert.equal(screenshotRes.status, 200);
  assert.equal(screenshotRes.headers.get("content-type"), "image/jpeg");
});

test("createApp(): all 4 static themes' real screenshot files still serve byte-for-byte identically (the literal 'all 4 static themes' claim, not just 'basic')", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a real listening address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // One entry per theme under content/themes/static/ as of this change; each theme ships exactly one of
  // the two extensions (see Themes.tsx's own jpg-then-png fallback doc for why both exist).
  const staticThemeScreenshots: Array<{ id: string; file: string }> = [
    { id: "tovu-theme", file: "index.png" },
    { id: "tailark-dusk", file: "index.png" },
    { id: "tailark-quartz-dark", file: "index.jpg" },
    { id: "tailark-quartz-libre", file: "index.png" },
  ];

  for (const { id, file } of staticThemeScreenshots) {
    const onDiskPath = path.resolve(import.meta.dirname, `../../../../../../../../content/themes/static/${id}/screenshots/${file}`);
    const onDisk = readFileSync(onDiskPath);
    const res = await fetch(`${baseUrl}/theme-assets/${id}/screenshots/${file}`);
    assert.equal(res.status, 200, `${id}/screenshots/${file} should still 200`);
    const served = Buffer.from(await res.arrayBuffer());
    assert.ok(served.equals(onDisk), `${id}/screenshots/${file} bytes must match the on-disk file exactly`);
  }
});

test("createApp(): 'storefront' (an existing templated theme with no assets on disk) still 404s cleanly rather than crashing now that the templated root is mounted", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a real listening address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const res = await fetch(`${baseUrl}/theme-assets/storefront/screenshots/index.jpg`);
  assert.equal(res.status, 404);
});
