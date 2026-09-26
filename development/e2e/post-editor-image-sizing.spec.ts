import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsAdmin } from "./auth-fixtures.js";

/** Absolute — `addStyleTag`'s `path` option resolves against `process.cwd()` at test-run time,
 *  which varies by how the suite is invoked; anchoring to `import.meta.dirname` (this file's own directory,
 *  matching `byok-google-live-smoke.spec.ts`/`placeholder-tabs-card-parity.spec.ts`'s own
 *  precedent in this directory) makes the fixture path invocation-independent. */
const BASIC_THEME_CSS_PATH = path.resolve(import.meta.dirname, "../../content/themes/static/tovu-theme/css/styles.css");

/**
 * @file Regression coverage for the owner-reported bug (2026-08-12): "embed an image [in the
 * post editor]. It's showing up really bad, like, excessively large." Reproduced live (private
 * headless Chromium against the real dev server, before any fix) with a 2400x1500 test image: the
 * inserted `<img>` rendered at its raw intrinsic size — `max-width: none`, `display: inline` —
 * blowing out the whole editor pane, on BOTH insertion paths this editor supports.
 *
 * Root cause: `apps/admin/src/styles.css` had `.editor-body .tiptap` rules for paragraphs, code
 * blocks, blockquotes, etc., but no `img` rule at all — an asymmetry with the public theme, which
 * already constrains `.post-detail-body img`. The fix adds one scoped rule mirroring the public
 * theme's own values (`max-width: 100%; height: auto; display: block; border-radius: 10px;
 * margin: 20px 0;`), matched to the pane in test 1 below and matched to the public theme's own
 * values in test 2.
 *
 * A SECOND, related bug was found while verifying the public side per this dispatch's own "check
 * both renderers" instruction (this project has shipped fixes that looked right in one of the two
 * post renderers — Tiptap in-browser vs. `render.ts`'s hand-written `renderDocNode` — while wrong
 * or absent in the other, multiple times before): the public theme's `.post-detail-body img` rule
 * had `max-width: 100%` but no `height: auto`. `render.ts`'s `renderImageTag` emits `width`/
 * `height` HTML attributes independently whenever a media asset has that metadata stored — a real,
 * reachable shape, not hypothetical. Without `height: auto`, the browser's own presentational-hint
 * mapping for the HTML `height` attribute wins over the shrunk `max-width`, squashing the image
 * instead of scaling it. Confirmed live via a standalone HTML fixture loading the theme's real
 * stylesheet with a real PNG carrying both attributes: pre-fix, a 2400x1500 source rendered at
 * 720x1500 (visibly squashed); post-fix, 720x450 (aspect ratio preserved). Test 3 below locks this
 * in at the CSS-rule level (`getComputedStyle`) since the e2e harness has no fixture post whose
 * image node carries stored width/height metadata to exercise the full render path live — see that
 * test's own comment for why a rule-level assertion is the right-sized proof here, not a gap.
 *
 * Both the editor rule and the public theme rule are asserted directly against `getComputedStyle`
 * (this project's own memory: CSS presence is not proof of precedence — a prior bug shipped twice
 * from confirming a rule existed without confirming it actually won against everything else in the
 * cascade).
 */

/** This suite's own hermetic public/API server (`development/playwright.post-editor.config.ts`) —
 *  distinct from Playwright's own `baseURL` fixture, which points at the ADMIN Vite dev server
 *  (7852). The public site lives on the API port, same precedent as
 *  `post-editor-preview-branches.spec.ts`'s own `API_BASE_URL` constant. */
const API_BASE_URL = "http://localhost:7851";
/** Same admin-API convention `post-editor-toolbar.spec.ts` already uses (`fetchBodyJson`'s own
 *  constants) — needed below to read-modify-write `bodyJson` directly, now that there is no toolbar
 *  control left that writes a legacy `src`-only image node (see test 1's own comment). */
const WORKSPACE_ID = "workspace-local";
const API_BASE = "/api/admin/v1";

const BIG_SVG_DATA_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1500"><rect width="2400" height="1500" fill="#4caf7a"/></svg>'
  );

/** Copied (not imported) from `post-editor-preview-branches.spec.ts` — see that file's own header
 *  for why this directory duplicates small scenario setup instead of sharing it. */
async function openFreshPost(page: Page): Promise<{ id: string; slug: string }> {
  await page.goto("/admin/posts");
  await page.getByRole("button", { name: "New Post" }).click();
  await expect(page).toHaveURL(/\/admin\/posts\/[^/]+$/);
  const id = page.url().split("/").pop()!;
  const slug = await page.getByLabel("URL slug").inputValue();
  return { id, slug };
}

/** Reads the box a real browser would paint from, not just declared CSS — `getBoundingClientRect`
 *  plus the three cascade-precedence properties this bug (and its public-theme sibling) hinge on. */
async function measureImage(locator: Locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      width: rect.width,
      height: rect.height,
      naturalWidth: (el as HTMLImageElement).naturalWidth,
      naturalHeight: (el as HTMLImageElement).naturalHeight,
      maxWidth: style.maxWidth,
      height_css: style.height,
      display: style.display,
    };
  });
}

test.describe("post editor — inserted image sizing", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("a legacy src-only image node (pre-existing content, no assetId/transformName) is constrained to the editor pane, not its raw intrinsic size", async ({
    page,
  }) => {
    // Was: click the toolbar's "Insert image by URL" button (`window.prompt`s for the URL/alt).
    // That control was REMOVED 2026-08-12 in the same dispatch as this rewrite (owner-reported
    // bug: it wrote exactly this `src`-only node shape, which never renders on the public site —
    // see `PostEditor.tsx`'s own comment on the removal). The node shape itself is still real,
    // reachable content: any post SAVED before the removal (or written some other way) can still
    // carry it, and `MediaImageNodeView`'s legacy branch (`media-image-extension.tsx`) still renders
    // it for exactly that backward-compat reason. There is no toolbar path left that produces this
    // shape, so this test now writes it directly through the same authenticated admin API the editor
    // itself uses (`post-editor-toolbar.spec.ts`'s own `fetchBodyJson` pattern), then reloads —
    // simulating "open a post that already has one", the one way this shape is reached now.
    const { id } = await openFreshPost(page);
    const editorBody = page.locator(".editor-body");
    const paneWidth = await editorBody.evaluate((el) => el.getBoundingClientRect().width);

    // `PUT /posts/:id` (`src/server/inbound/admin-http/routes/posts/update.ts`) has no partial-update path — it
    // reads `title`/`slug`/`status` off the request body with `?? ""`/`undefined` fallbacks and
    // `updatePost` then rejects an empty title/invalid status outright, so the full current record
    // (not just the one field this test cares about) has to travel in every PUT.
    const post = await page.evaluate(
      async ({ url }) => {
        const res = await fetch(url, { credentials: "same-origin" });
        const data = await res.json();
        return data.post;
      },
      { url: `${API_BASE}/workspaces/${WORKSPACE_ID}/posts/${id}` }
    );
    post.bodyJson.content.push({ type: "image", attrs: { src: BIG_SVG_DATA_URI, alt: "legacy image" } });
    const putResult = await page.evaluate(
      async ({ url, post }) => {
        const res = await fetch(url, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: post.title, slug: post.slug, status: post.status, bodyJson: post.bodyJson }),
        });
        return { status: res.status, text: await res.text() };
      },
      { url: `${API_BASE}/workspaces/${WORKSPACE_ID}/posts/${id}`, post }
    );
    expect(putResult.status, `seeding the legacy image node must succeed — got ${putResult.status}: ${putResult.text}`).toBe(200);
    await page.reload();

    const img = page.locator('[data-agent-element="post-body"] img').last();
    await img.waitFor({ state: "attached", timeout: 5000 });
    const m = await measureImage(img);

    // The regression: pre-fix this was `naturalWidth` (2400) with `maxWidth: "none"`, overflowing
    // the pane. Post-fix it must be constrained to (at most) the pane's own width, scaled down from
    // the 2400x1500 source with its aspect ratio intact.
    expect(m.naturalWidth).toBe(2400);
    expect(m.width).toBeLessThanOrEqual(paneWidth + 1); // +1: sub-pixel rounding
    expect(m.width).toBeLessThan(m.naturalWidth);
    expect(m.maxWidth).toBe("100%");
    expect(m.display).toBe("block");
    expect(m.height / m.width).toBeCloseTo(1500 / 2400, 2);
  });

  test("an image inserted by drag/paste upload (FileHandler -> MediaImage node view) is equally constrained", async ({
    page,
  }) => {
    await openFreshPost(page);
    const editorBody = page.locator(".editor-body");
    const paneWidth = await editorBody.evaluate((el) => el.getBoundingClientRect().width);

    // Builds a real 2400x1500 PNG in-browser (canvas -> toBlob -> File) so this test needs no
    // binary fixture checked into the repo, then dispatches a real `drop` DragEvent onto the
    // ProseMirror editable — the same path `FileHandler.onDrop` (`use-post-editor.hooks.ts`)
    // listens on. TOVU_DB=memory for this suite's hermetic server (see
    // `playwright.post-editor.config.ts`), so the resulting upload is discarded with the rest of
    // the test DB — unlike the live dev server, no manual cleanup is needed here.
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 2400;
      canvas.height = 1500;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#4caf7a";
      ctx.fillRect(0, 0, 2400, 1500);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const file = new File([blob], "big-drop-test.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('[data-agent-element="post-body"] .ProseMirror')!;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        })
      );
    });

    const img = page.locator(".media-image-node__preview").last();
    await img.waitFor({ state: "attached", timeout: 15_000 });
    const m = await measureImage(img);

    expect(m.naturalWidth).toBe(2400);
    expect(m.width).toBeLessThanOrEqual(paneWidth + 1);
    expect(m.width).toBeLessThan(m.naturalWidth);
    expect(m.maxWidth).toBe("100%");
    expect(m.display).toBe("block");
    expect(m.height / m.width).toBeCloseTo(1500 / 2400, 2);
  });
});

test.describe("public theme — post body image sizing (the second bug this dispatch found)", () => {
  /**
   * `render.ts`'s `renderImageTag` emits BOTH `width` and `height` HTML attributes whenever a
   * media asset has that metadata stored (`meta?.width`/`meta?.height`, independent of each
   * other). This suite's hermetic post has no such asset (creating one needs a real upload +
   * transform-registry entry, which is what test 2 above already exercises against the ADMIN
   * side of the same node). What matters for THIS bug is the CSS rule alone: given an `<img>`
   * with explicit `width`/`height` attributes, does `.post-detail-body img` preserve aspect ratio
   * or squash it? That is a direct, deterministic function of the stylesheet, asserted here
   * against a minimal fixture that loads the real theme CSS — not a live post render, but not a
   * gap either, since the CSS rule (not the render path that reaches it) is what this dispatch
   * changed.
   */
  test("`.post-detail-body img` scales height when the img carries explicit width/height attributes", async ({
    page,
  }) => {
    await page.setContent(`<!doctype html><html><body>
      <div class="post-detail-body">
        <img id="probe" width="2400" height="1500"
             src="data:image/svg+xml,${encodeURIComponent(
               '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1500"><rect width="2400" height="1500" fill="#4caf7a"/></svg>'
             )}" alt="probe">
      </div>
    </body></html>`);
    await page.addStyleTag({ path: BASIC_THEME_CSS_PATH });

    const img = page.locator("#probe");
    const m = await measureImage(img);

    // Pre-fix this was `height_css: "1500px"` regardless of the shrunk width — a squashed image.
    expect(m.maxWidth).toBe("100%");
    expect(m.height / m.width).toBeCloseTo(1500 / 2400, 2);
  });
});

/**
 * Second owner-reported bug, same dispatch, next escalation (2026-08-12): "the actual image is not
 * showing up. Just has the … or the name of the file" — worse than oversized, the picture never
 * rendered at all, everywhere: the editor's own "Preview" tab AND the published public page.
 *
 * Root cause (`src/widgets/resolver-service.ts`, `src/server/http/site/render.ts`): the "post-
 * content" widget IR — what BOTH the Preview tab (`renderViaTemplate`'s `pendingBodyJson` override)
 * and the published page (`renderViaTemplate`'s normal DB-fetch path) render a post's body through
 * — never resolved `mediaTransformVersions`/`mediaAssetMetadata` for its own embedded ref-based
 * images. `render.ts`'s `renderWidgetPostContent` called `renderDocNode(bodyJson)` with only ONE
 * argument, so those maps silently defaulted to EMPTY — every ref-image's transform lookup was
 * unconditionally a miss, degrading to a `<figure class="media-ph">` labelled with the image's
 * `alt` (the filename, for a freshly dropped file) — regardless of whether the asset, its "public"
 * transform, and the `/m/` rendition route all genuinely worked (confirmed live before this fix:
 * they did).
 *
 * `src/widgets/__tests__/integration/resolve-html-page-embeds.integration.test.ts` pins this fix at
 * the unit/integration level with controlled fakes — the exact seam that was missing the data, for
 * both the `"content"`/`"post"` DB-fetch builders AND the `pendingContentOverride` branch the
 * Preview tab uses — and is the SAVED, deterministic, RED-then-GREEN-proven regression guard for
 * this bug.
 *
 * The true end-to-end proof (drop a real image, publish, fetch the real public page over HTTP) was
 * run live and confirmed working — twice: once against THIS suite's own hermetic
 * `TOVU_DB=memory` boot (see `test.fixme` below for why that run's assertion can't be saved as-is),
 * and once against the real, long-running dev server the owner is actually using (screenshot on
 * file in that session's own report, a real gradient PNG rendering correctly on a real published
 * post). The fix is not in doubt; only THIS harness's ability to prove it via a rerunnable e2e
 * assertion is.
 */
test.describe("public page — inserted image actually renders (not a filename placeholder)", () => {
  // FIXME (2026-08-12, discovered writing this test, unrelated to the fix above): a direct,
  // repeatedly-retried probe of `/m/{assetId}/public.v1/...` — the public rendition route,
  // bypassing `render.ts`/`resolveHtmlPageEmbeds` entirely — 404s for 25+ seconds on THIS suite's
  // `TOVU_DB=memory` hermetic boot, for an asset whose `/original` route (a different route,
  // confirmed) serves correctly within ~2 seconds of upload. That rules out both this dispatch's
  // fix (never on this code path) and a simple boot-order race (25s is far past
  // `ensureCoreMediaTransform`'s own "few milliseconds" assumption). Root cause not yet isolated —
  // candidates include the transform-generation pipeline (`resolveMediaRendition`,
  // `SharpImageTransformer`) behaving differently under this specific harness's memory-DB
  // combination, or a shared `infra/uploads` blob-store path colliding across concurrent hermetic
  // boots (`mediaUploadsDir()` is NOT TOVU_DB-scoped — same directory as the real dev server and
  // every other suite's hermetic boot). Flagged for separate investigation; not blocking this
  // dispatch's actual fix, which is proven at the integration level above and live against the real
  // dev server (see this describe block's own header).
  test.fixme(
    'a drag/paste-uploaded image renders as a real <img src="/m/..."> on the published public page, not a media-ph placeholder',
    async ({ page }) => {
      const { id: postId, slug } = await openFreshPost(page);

      await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 600;
        canvas.height = 400;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#e0703a";
        ctx.fillRect(0, 0, 600, 400);
        const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
        const file = new File([blob], "public-render-test.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const target = document.querySelector('[data-agent-element="post-body"] .ProseMirror')!;
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          })
        );
      });

      const nodeImg = page.locator(".media-image-node__preview").last();
      await nodeImg.waitFor({ state: "attached", timeout: 15_000 });

      await page.getByRole("button", { name: "Publish" }).click();
      await expect(page.locator(".save-ok")).toContainText("Published", { timeout: 10_000 });

      const publicHtml = await (await page.request.get(`${API_BASE_URL}/${slug}`)).text();
      expect(publicHtml).not.toContain("media-ph");
      expect(publicHtml).toMatch(/<img src="\/m\/[^"]+"[^>]*alt="public-render-test\.png"/);

      await page.request.delete(`${API_BASE_URL}/api/admin/v1/workspaces/workspace-local/posts/${postId}`);
    }
  );
});

test.describe("media image node — Replace/Remove button spacing (owner-reported, same dispatch)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("the Replace and Remove buttons have a visible gap, not flush edges", async ({ page }) => {
    const { id: postId } = await openFreshPost(page);

    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#4caf7a";
      ctx.fillRect(0, 0, 400, 300);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const file = new File([blob], "button-gap-test.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('[data-agent-element="post-body"] .ProseMirror')!;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        })
      );
    });

    await page.locator(".media-image-node__preview").last().waitFor({ state: "attached", timeout: 15_000 });

    const buttons = page.locator(".media-image-node__actions").last().locator("button");
    const replaceBox = await buttons.nth(0).boundingBox();
    const removeBox = await buttons.nth(1).boundingBox();
    if (!replaceBox || !removeBox) throw new Error("Replace/Remove buttons did not render a bounding box");

    // Pre-fix this gap was 0 — the two buttons' edges touched exactly. First shipped at 3px (the
    // middle of the owner's initial "2-3px" ask); he then looked at it live and asked to double it,
    // so 6px is the signed-off value and this assertion tracks `.media-image-node__actions`'s `gap`
    // in styles.css. If you are widening this range to make a red test pass, check that rule first —
    // a drift between the two means someone changed the CSS without re-asking.
    const gap = removeBox.x - (replaceBox.x + replaceBox.width);
    expect(gap).toBeGreaterThanOrEqual(5);
    expect(gap).toBeLessThanOrEqual(7);

    await page.request.delete(`${API_BASE_URL}/api/admin/v1/workspaces/workspace-local/posts/${postId}`);
  });
});
