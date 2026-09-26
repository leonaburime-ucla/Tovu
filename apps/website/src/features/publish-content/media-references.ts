import { embedMarkerTarget, scanEmbedMarkers } from "#src/contracts/core/embeds/marker";

/**
 * @file Which media a packed post/page state points at — owner decision 2026-09-25, "images go along
 * with pages and posts": a scoped "Publish pages"/"Publish posts" run carries the media its in-scope
 * items reference (`export-bundle.ts`'s `includeReferencedEntities`, through `content-references.ts`).
 *
 * Reads the packed WIRE state (`features/post/publish-content.ts`'s `toPublishableState`), not a
 * `PostRecord`, because the scope layer only ever holds packed entities. Every reference shape the
 * content DB actually holds is covered:
 * - a ref-based TipTap `image`/`media` node's `attrs.assetId` (ADR-027 §4) — the same walk
 *   `widgets/resolver-service.ts` and `routes/site/media-rendition.ts` each carry a private copy of;
 *   neither is importable from here (both sit above `features/publish-content/` in the layering);
 * - a legacy `image` node's `attrs.src` — an admin `/media/{id}/…` URL or a public `/m/{key}/…` URL;
 * - any mark's string attrs holding such a URL — a `link` mark whose `href` is a media file's copied
 *   public URL (the Media panel shows it for exactly that);
 * - an `"html"` body's `data-embed-config` media marker, by `id ?? slug` via `embedMarkerTarget` (the
 *   same case-insensitive type match and precedence the embed resolver uses), and any `/m/{key}/` URL
 *   in it;
 * - `seoExtJson.ogImage`/`twitterImage`, a `"{assetId}:{transformName}"` ref or an absolute URL
 *   (`seo/types.ts`).
 *
 * Not covered: an old slug kept alive only by `media_slug_history` (matched against the CURRENT slug
 * only). Media an embedded widget holds is not read here: the widget itself is carried
 * (`content-references.ts`), and a widget's config names no media the carry follows.
 *
 * Returns KEYS — an id or a slug — never resolved media: the caller matches them against the media
 * entities it actually holds, so a key naming nothing (a deleted asset, a stray URL) adds nothing.
 */

/** `/m/{key}/…` (public rendition route) and `/media/{id}/…` (admin media route, what a legacy
 *  `image` node's `src` was saved as). The key stops at the next `/`, quote, `?`, `#` or whitespace. */
const MEDIA_URL_PATTERN = /\/(?:m|media)\/([^/"'\s?#<>]+)\//g;

const SEO_IMAGE_FIELDS = ["ogImage", "twitterImage"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adds every media key a URL-bearing string names. @complexity O(n) in the string's length. */
function addUrlKeys(text: string, out: Set<string>): void {
  for (const match of text.matchAll(MEDIA_URL_PATTERN)) {
    try {
      out.add(decodeURIComponent(match[1]!));
    } catch {
      out.add(match[1]!); // a malformed %-escape: keep the raw segment rather than throw
    }
  }
}

/** Adds every media URL key held in a mark's string attrs (a `link` mark's `href`, chiefly).
 *  @complexity O(m) in the marks' total attr length. */
function addMarkKeys(marks: unknown, out: Set<string>): void {
  if (!Array.isArray(marks)) return;
  for (const mark of marks) {
    if (!isPlainObject(mark) || !isPlainObject(mark.attrs)) continue;
    for (const value of Object.values(mark.attrs)) if (typeof value === "string") addUrlKeys(value, out);
  }
}

/** Walks a TipTap tree collecting every `image`/`media` node's `assetId` and legacy `src` key, plus
 *  any media URL in a mark's attrs. @complexity O(n) in the tree's size. */
function addDocKeys(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) addDocKeys(child, out);
    return;
  }
  if (!isPlainObject(node)) return;
  if ((node.type === "image" || node.type === "media") && isPlainObject(node.attrs)) {
    if (typeof node.attrs.assetId === "string") out.add(node.attrs.assetId);
    else if (typeof node.attrs.src === "string") addUrlKeys(node.attrs.src, out);
  }
  addMarkKeys(node.marks, out);
  if (Array.isArray(node.content)) addDocKeys(node.content, out);
}

/** @complexity O(n) over `html`'s length (one shared marker scan plus one URL scan). */
function addHtmlKeys(html: string, out: Set<string>): void {
  for (const marker of scanEmbedMarkers(html).markers) {
    if (marker.type.toLowerCase() !== "media") continue;
    const target = embedMarkerTarget(marker.type, marker.config);
    if (target !== undefined && target.key !== "none") out.add(target.value);
  }
  addUrlKeys(html, out);
}

/** `seoExtJson` is stored as a raw JSON string (`PostRecord.seoExtJson`'s own doc); an unparseable
 *  one contributes nothing. @complexity O(n) in the string's length for the parse. */
function addSeoKeys(raw: unknown, out: Set<string>): void {
  let seo: unknown = raw;
  if (typeof raw === "string") {
    try {
      seo = JSON.parse(raw);
    } catch {
      return;
    }
  }
  if (!isPlainObject(seo)) return;
  for (const field of SEO_IMAGE_FIELDS) {
    const ref = seo[field];
    if (typeof ref !== "string") continue;
    if (ref.includes("/")) {
      addUrlKeys(ref, out); // an absolute URL, not a `"{assetId}:{transformName}"` ref
      continue;
    }
    const assetId = ref.split(":")[0];
    if (assetId) out.add(assetId);
  }
}

/**
 * Every media key (id or slug) one packed post/page state references, across `bodyJson`,
 * `bodyHtml` and `seoExtJson`. Pure; never throws on an unexpected shape — an unreadable field
 * simply contributes nothing, since this only ever ADDS media to a run and never gates one.
 *
 * @complexity O(n) in the total size of the three fields.
 */
export function collectReferencedMediaKeys(state: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const keys = new Set<string>();
  addDocKeys(state.bodyJson, keys);
  if (typeof state.bodyHtml === "string") addHtmlKeys(state.bodyHtml, keys);
  addSeoKeys(state.seoExtJson, keys);
  return keys;
}
