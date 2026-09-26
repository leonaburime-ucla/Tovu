import { useId, useRef, type ReactNode } from "react";
import type { AdminMedia } from "../../lib/api";
import { ServerLabel } from "@/components/status-labels";
import { RowMenu, ConfirmDialog } from "@jini-ai/admin/react";
import { I18nProvider, MediaProvidersTab, SETTINGS_DIALOG_DICTIONARIES } from "@jini-ai/ui";
import "@jini-ai/ui/settings-dialog.css";
import { agentHandle } from "@jini-ai/agentic";

import { buildAgentListHandles } from "../../lib/agent-list-handles";
import { filterMediaByTab, hasUntypedMedia, mediaRowMenuItems, sortMediaByOrder, MEDIA_ORDER_OPTIONS, type MediaOrderBy } from "./rules";
import { useWiredMedia, type MediaController } from "./hooks/use-media.hooks";
import { useWiredMediaPreview } from "./hooks/use-media-preview.hooks";
import { useWiredEditMediaPanel, type EditMediaPanelController } from "./hooks/use-edit-media-panel.hooks";
import { useEditMediaModal } from "./hooks/use-edit-media-modal.hooks";
import { useMediaLightbox } from "./hooks/use-media-lightbox.hooks";
import { useMediaTabs, type MediaContentTabId, type MediaTabId, type MediaTabsController } from "./hooks/use-media-tabs.hooks";
import { MEDIA_PROVIDER_CATALOG, PINNED_MEDIA_PROVIDER_IDS } from "./media-provider-catalog";
import { mediaProvidersPort } from "./media-providers-port";
import { TabBar } from "../../components/TabBar";
import { resolveMediaTabChange, resolveMediaTabs } from "./Media.hooks";
import { PublishSectionButton } from "../publish-content/PublishSectionButton";

/**
 * @file Media admin screen — list + upload + trash/purge ladder, wiring the `media` backend into
 * the admin UI. Markup only: state, effects, and API calls for all four components in this file
 * (`Media`, `MediaPreview`, `EditMediaPanel`, `MediaLightbox`) live in their own `hooks/use-<thing>
 * .hooks.ts`; computed values (alt-text fallback, the row-menu builder, the editing-item lookup,
 * the lightbox index math) live in `rules.ts`.
 *
 * MSG-05: rewritten from a `.list-table` of filenames into a preview grid (image/video on top,
 * title underneath) now that a byte-serving route exists —
 * `GET /workspaces/{workspaceId}/media/{mediaId}/original` (authenticated, same-origin, Range
 * support for video seeking, `Content-Type` sniffed server-side from magic bytes). See
 * `api.mediaOriginalUrl`'s own comment for the URL contract.
 *
 * CONTENT TYPE (updated 2026-08-24): the media list response now DOES carry one — `AdminMedia
 * .contentType`, sniffed server-side from the stored bytes and persisted on `asset_blobs
 * .content_type`. That is what the "Images"/"Videos" tabs filter on (`rules.ts`'s
 * `filterMediaByTab`), replacing the "not wired up yet" placeholders those tabs used to render.
 *
 * `MediaPreview` below is deliberately UNCHANGED by that: it still resolves each card's preview
 * with its own optimistic probe rather than branching on `contentType`. The reasoning below still
 * holds — the probe already handles every case correctly (including the security defusal), costs
 * nothing extra for the common one, and a card that renders whatever the bytes really are cannot
 * be desynced from a stored field. The original description of the gap follows, since it is the
 * rationale for the probe's design:
 *
 * The hard problem this rewrite had to solve: **the media list response carried no content type**
 * (neither `media` nor `asset_blobs` stored one — upload validated `contentType` then discarded
 * it), so nothing in `AdminMedia` told the client whether a given asset was an image, a video, or
 * something unpreviewable. `MediaPreview` below resolves this client-side with an optimistic
 * render-and-fall-back chain (`<img>` → onError → `<video>` → onError → placeholder) rather than a
 * HEAD probe per card. Chosen over the HEAD approach because: (1) the byte route's documented
 * contract covers GET — sniffing/Range were specified for that, not for HEAD, so building on HEAD
 * would be assuming a behavior nobody confirmed; (2) a HEAD-first design means every card blocks on
 * a round trip before any pixel paints, working against the fixed-aspect-box + lazy-loading this
 * grid needs anyway, whereas the optimistic path costs nothing extra for the common case (a real
 * image just loads) and only "wastes" a request for the video/unsupported minority — and even then,
 * a browser's image decoder typically fails off the header bytes rather than pulling the whole
 * file; (3) it composes for free with the server's security defusal: a sniffed HTML/SVG comes back
 * as `application/octet-stream` with `Content-Disposition: attachment`, which is not a valid image
 * OR video MIME, so it fails both probes and lands on the placeholder with zero special-casing —
 * this file never needs to detect "is this the defused case" itself.
 *
 * SPEC-037 REQ-01: `EditMediaPanel` (renamed from `EditMediaRow` — no longer a table row now that
 * this screen is a card grid, not a table) is the `api.updateMedia` metadata-edit affordance:
 * title/alt/caption/credit, sending only the fields the user actually changed (partial-patch,
 * matching `updateMediaMetadata`'s own optional-field contract) rather than the whole draft object.
 *
 * MODAL (2026-09-07, owner ask): `EditMediaPanel` used to render inline as a full-width `.card`
 * above the grid, pushing every card down while open. It now renders inside `EditMediaModal`, a
 * single shared `<dialog>` (same "one instance, toggle its `item` prop" shape as `MediaLightbox`/
 * `ConfirmDialog` below — see `use-edit-media-modal.hooks.ts`'s own header) reachable from either
 * the row's existing `RowMenu` "Edit metadata" action OR a new eye-icon button on the card itself
 * (`MediaPreview`'s `onEdit`, mirroring its existing `onExpand` corner button). Both entry points
 * call the SAME `toggleEditing(item)` from `use-media.hooks.ts` — there is only ever one edit UI,
 * just two doors into it. `key={item.id}` still lives on `EditMediaPanel` itself (not the dialog),
 * preserving the 2026-08-12 audit fix documented at that `key`'s own call site below: the dialog box
 * stays mounted across an edit-target switch, but its form content still remounts and reseeds.
 *
 * Row actions moved into a `RowMenu` (one More menu per card, per MSG-05) instead of always-visible
 * buttons — Edit metadata, and Trash or Delete permanently depending on `status`. The
 * `window.confirm` that used to guard permanent delete is now `ConfirmDialog`, matching
 * `Posts.tsx`'s pattern: `pendingPurge` + `rowSavingId` state, dialog mounted unconditionally.
 * Trashing stays a single unconfirmed action (as before) — only the irreversible purge step gates
 * on the dialog, matching the original code's own trash-vs-purge asymmetry.
 *
 * Lightbox: `MediaLightbox` below opens a card's asset large. It is ONE shared `<dialog>` instance
 * for the whole grid — `lightboxIndex: number | null` state in `Media()` indexes into `media`,
 * exactly the same shape as `pendingPurge` already driving the single shared `ConfirmDialog` above
 * — not one `<dialog>` mounted per card. A grid can hold dozens of assets; mounting N real
 * `<dialog>` elements (each portaled into the browser's top layer by `showModal()`) to show at
 * most one open at a time buys nothing and costs N DOM subtrees. `useId()` is still used for the
 * shared instance's own heading id (not a hardcoded string) — not because a *second* concurrent
 * `MediaLightbox` exists today (it doesn't; one shared instance structurally cannot self-collide),
 * but because "no hardcoded dialog id" is this codebase's standing rule after the `ConfirmDialog`/
 * `Roles.tsx` incident (see that component's own doc comment), and a future caller mounting a
 * second `MediaLightbox` elsewhere should not have to rediscover that the hard way.
 */

/** Generic "file" glyph for an asset that fails both the image and video probe — stroke-based,
 *  matching `nav.ts`'s icon convention elsewhere in this app (viewBox 0 0 18 18, currentColor). */
function PlaceholderIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M5 2h6l3 3v11H5V2z" strokeLinejoin="round" />
      <path d="M11 2v3h3" strokeLinejoin="round" />
    </svg>
  );
}

/** "Edit metadata" glyph for the card's own eye-icon trigger (owner's chosen affordance for
 *  reaching `EditMediaModal` — see this file's header) — an open-eye shape, same stroke style as
 *  this file's other icons. */
function EyeIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M1.5 9S4.5 3.5 9 3.5 16.5 9 16.5 9 13.5 14.5 9 14.5 1.5 9 1.5 9Z" strokeLinejoin="round" />
      <circle cx="9" cy="9" r="2.25" />
    </svg>
  );
}

/** "View larger" glyph for the lightbox trigger overlaid on a card's preview (four open corners —
 *  the conventional expand/fullscreen affordance), same stroke style as this file's other icons. */
function ExpandIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M6 2H2v4M12 2h4v4M6 16H2v-4M12 16h4v-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "×" close glyph for the lightbox header. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M4 4l10 10M14 4L4 14" strokeLinecap="round" />
    </svg>
  );
}

/** Chevron used for both lightbox nav arrows — `flip` mirrors it horizontally for "next" rather
 *  than shipping a second glyph, the same "one shape, two states" idiom `Sidebar.tsx`'s rail-toggle
 *  chevron already uses (see `styles.css`'s `.cms-nav.is-rail .cms-rail-toggle svg` comment). */
function ChevronIcon(props: { flip?: boolean }) {
  return (
    <svg
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
      style={props.flip ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d="M11 3.5 5.5 9l5.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface MediaPreviewProps {
  item: AdminMedia;
  onExpand?: () => void;
  /** This card's own expand-button handle, or `undefined` when this instance has no expand button
   *  at all (the lightbox's own reuse of this component omits it, same as it omits `onExpand`).
   *  Passed down rather than derived here so the uniqueness search runs once, over the whole grid,
   *  in `Media()` — see `Taxonomy.tsx`'s `NewTermForm.agentBase` for why a per-instance search
   *  cannot dedupe across siblings. */
  agentExpandHandle?: string;
  /** Opens `EditMediaModal` for this card's item — the eye-icon trigger (owner ask, 2026-09-07).
   *  `undefined` for the same reason `onExpand` is: the lightbox's own reuse of this component
   *  omits it, since editing metadata from inside the enlarged view isn't part of this ask. */
  onEdit?: () => void;
  /** This card's own eye-button handle — same "passed down, not derived here" reasoning as
   *  `agentExpandHandle`. */
  agentEditHandle?: string;
  /**
   * Dependency injection seam for tests — the same convention `Posts.tsx`'s `usePostsHook` uses.
   * Defaulted to the real (wired) hook, so production callers pass nothing and behave exactly as
   * before. Typed against `useWiredMediaPreview` (the zero-dependencies pair), not the raw
   * `useMediaPreview(item, deps)` — this component has no reason to see `deps` itself, matching
   * `PostsProps.usePostsHook`'s own shape.
   */
  useMediaPreviewHook?: typeof useWiredMediaPreview;
  /** Translator closure — see `Media()`'s own `t` for where this comes from; threaded through the
   *  lightbox too, since it remounts this same component for its enlarged view. */
  t: (key: string) => string;
}

/** Resolves whether an asset previews as an image, a video, or neither — see this file's header
 * comment for why this is a client-side fallback chain rather than a server content-type read.
 *
 * `onExpand`, when passed, overlays a small "view larger" icon button on the preview that calls it
 * (used by the grid card to open `MediaLightbox`; omitted when `MediaLightbox` itself reuses this
 * same component to render its own enlarged content, so the lightbox never grows a nested trigger
 * for itself). Deliberately NOT a click handler on the whole preview box: the `"video"` stage below
 * renders a live `<video controls>`, and (a) interactive content cannot legally nest inside a
 * `<button>`, so a whole-preview `<button>` wrapper is not an option for that stage, and (b) even
 * without the nesting rule, a whole-box click target would swallow clicks aimed at the video's own
 * play/seek bar. A small corner icon works identically for both the `"image"` and `"video"` stages,
 * so the interaction model doesn't change per asset type. Omitted entirely for `"unsupported"` —
 * that stage already renders a "Download original" link, and the lightbox would show nothing more
 * than the exact same placeholder, just bigger. */
function MediaPreview(props: MediaPreviewProps) {
  const { useMediaPreviewHook = useWiredMediaPreview, t } = props;
  const { stage, src, altText, handleImageError, handleVideoError } = useMediaPreviewHook(props.item, t);

  // Computed ahead of the stage branches (unlike `expandButton` below, which the `"unsupported"`
  // branch never needed) — editing an asset's metadata is meaningful regardless of whether its
  // bytes can be previewed, so this renders in all three stages, not just image/video.
  const editButton = props.onEdit ? (
    <button
      type="button"
      className="media-card-edit"
      aria-label={`Edit "${props.item.title}"`}
      onClick={props.onEdit}
      {...(props.agentEditHandle
        ? agentHandle(props.agentEditHandle, { role: "button", label: "Open the edit form for this asset as a modal" })
        : {})}
    >
      <EyeIcon />
    </button>
  ) : null;

  if (stage === "unsupported") {
    // Not a bare icon: a non-previewable asset (most often the server's own defused HTML/SVG
    // response — `application/octet-stream` + `Content-Disposition: attachment`, deliberately
    // non-rendering) is not a *broken* asset. The byte route worked; there's just nothing to draw
    // inline. So this still gives the operator a way to get the file, via the same `/original`
    // URL a working preview would have used as its `src` — the attachment header makes that link a
    // real download/open action, not a failed attempt to render it again.
    return (
      <div className="media-card-placeholder">
        <PlaceholderIcon />
        <p className="media-card-placeholder-text">{t("Preview not available")}</p>
        <a className="media-card-placeholder-link" href={src} target="_blank" rel="noreferrer">
          {t("Download original")}
        </a>
        {editButton}
      </div>
    );
  }

  const expandButton = props.onExpand ? (
    <button
      type="button"
      className="media-card-expand"
      aria-label={`View "${props.item.title}" larger`}
      onClick={props.onExpand}
      {...(props.agentExpandHandle
        ? agentHandle(props.agentExpandHandle, { role: "button", label: "Open this asset larger in the lightbox" })
        : {})}
    >
      <ExpandIcon />
    </button>
  ) : null;

  if (stage === "video") {
    return (
      <>
        <video
          className="media-card-media"
          src={src}
          controls
          preload="metadata"
          aria-label={altText}
          onError={handleVideoError}
        />
        {editButton}
        {expandButton}
      </>
    );
  }

  return (
    <>
      <img
        className="media-card-media"
        src={src}
        alt={altText}
        loading="lazy"
        onError={handleImageError}
      />
      {editButton}
      {expandButton}
    </>
  );
}

interface EditMediaPanelProps {
  item: AdminMedia;
  onSaved: () => void;
  onCancel: () => void;
  /**
   * Dependency injection seam for tests — the same convention `Posts.tsx`'s `usePostsHook` uses.
   * Defaulted to the real hook, so production callers pass nothing and behave exactly as before.
   */
  useEditMediaPanelHook?: typeof useWiredEditMediaPanel;
  /** Translator closure — see `Media()`'s own `t`. */
  t: (key: string) => string;
  /** Applied to this panel's own `<h2>` so `EditMediaModal`'s wrapping `<dialog>` can point its
   *  `aria-labelledby` at a real heading. Optional so this component still renders a valid (if
   *  unlabeled-by-id) heading if ever mounted standalone, e.g. in a unit test. */
  titleId?: string;
}

/** The metadata edit form for one media item's title/alt/caption/credit (REQ-01) plus the
 *  quick-and-dirty sizing/class/HTML-attributes overrides. Presented inside `EditMediaModal`'s `<dialog>` (owner
 *  ask, 2026-09-07 — see this file's header for why this moved off the grid) rather than rendering
 *  its own card chrome: the dialog itself supplies the surface/border/shadow (`media.css`'s
 *  `.media-edit-dialog`), so this component's own root is a plain content wrapper. */
function EditMediaPanel(props: EditMediaPanelProps) {
  const { item, onSaved, onCancel, useEditMediaPanelHook = useWiredEditMediaPanel, t, titleId } = props;
  const {
    draft,
    setTitle,
    setSlug,
    setAlt,
    setCaption,
    setCredit,
    setWidth,
    setHeight,
    setCssClass,
    setHtmlAttributes,
    htmlAttributesError,
    saving,
    error,
    hashCopied,
    urlCopied,
    embedCopied,
    publicUrl,
    embedSnippet,
    copyHash,
    copyUrl,
    copyEmbedCode,
    save,
  } = useEditMediaPanelHook({ item, onSaved, onCancel });

  return (
    <div
      className="media-edit-modal-body"
      {...agentHandle("media-edit-panel", {
        role: "region",
        label: "Edit media metadata — title, alt text, caption, credit, size, CSS class and HTML attributes",
      })}
    >
      <div className="editor-header">
        <h2 id={titleId}>
          {t("Editing")} "{item.title}"
        </h2>
      </div>
      {/* Field layout per the OD reference (od-settings-external-mcp-customform.png): uppercase
          letterspaced label above its control (`.field-label`), short fields pairing into a
          row (`.field-row`) instead of every field stacking full-width regardless of length. */}
      <div className="field-group">
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor={`media-edit-title-${item.id}`}>
              {t("Title")}
            </label>
            <input
              id={`media-edit-title-${item.id}`}
              value={draft.title}
              onChange={(e) => setTitle(e.target.value)}
              {...agentHandle("media-edit-title", { role: "field", label: "This asset's title" })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`media-edit-alt-${item.id}`}>
              {t("Alt")}
            </label>
            <input
              id={`media-edit-alt-${item.id}`}
              value={draft.alt}
              onChange={(e) => setAlt(e.target.value)}
              {...agentHandle("media-edit-alt", { role: "field", label: "This asset's alt text, for screen readers" })}
            />
          </div>
        </div>
        {/* Slug (2026-09-07, owner-directed): a SEPARATE field from Title, own row — auto-derived
            from Title at upload, then edited deliberately here. Renaming Title above never changes
            this value (see `AdminMedia.slug`'s own doc); a duplicate slug is rejected server-side
            (409) and surfaces through the same `error` banner every other save failure uses, rather
            than a client-side pre-check duplicating the server's own uniqueness rule. */}
        <div className="field">
          <label className="field-label" htmlFor={`media-edit-slug-${item.id}`}>
            {t("Slug")}
          </label>
          <input
            id={`media-edit-slug-${item.id}`}
            value={draft.slug}
            onChange={(e) => setSlug(e.target.value)}
            {...agentHandle("media-edit-slug", {
              role: "field",
              label: "This asset's unique lookup slug — separate from Title, must be unique in this workspace",
            })}
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor={`media-edit-caption-${item.id}`}>
              {t("Caption")}
            </label>
            <input
              id={`media-edit-caption-${item.id}`}
              value={draft.caption}
              onChange={(e) => setCaption(e.target.value)}
              {...agentHandle("media-edit-caption", { role: "field", label: "This asset's caption" })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`media-edit-credit-${item.id}`}>
              {t("Credit")}
            </label>
            <input
              id={`media-edit-credit-${item.id}`}
              value={draft.credit}
              onChange={(e) => setCredit(e.target.value)}
              {...agentHandle("media-edit-credit", { role: "field", label: "This asset's credit / attribution" })}
            />
          </div>
        </div>
        <MediaEditRenderOverrideFields
          item={item}
          draft={draft}
          setWidth={setWidth}
          setHeight={setHeight}
          setCssClass={setCssClass}
          setHtmlAttributes={setHtmlAttributes}
          htmlAttributesError={htmlAttributesError}
          t={t}
        />
        {/* User report: "where is the location of the asset? I dont see the location data" — there
            was no answer to that anywhere in this panel. Same read-only+Copy shape as the sha256
            row below (this component's own established idiom for "show it, let it be copied, it
            isn't something you type into"), but a clickable `<a>` instead of `<code>` since this
            value is a real, followable URL, not an opaque identifier.
            `publicUrl` (readable-slugs S5a) can be `null` — trashed asset, or no public transform
            registered yet — and the row is hidden rather than showing a dead link. */}
        {publicUrl !== null && (
          <MediaEditCopyRow
            label={t("File URL")}
            copied={urlCopied}
            onCopy={copyUrl}
            copyButtonHandle={agentHandle("media-edit-copy-url", { role: "button", label: "Copy this asset's file URL to the clipboard" })}
            t={t}
          >
            <a className="field-mono field-readonly" href={publicUrl} target="_blank" rel="noreferrer">
              {publicUrl}
            </a>
          </MediaEditCopyRow>
        )}
        {/* readable-slugs S5a: the embed marker other admin screens (posts/pages body HTML) would
            reference this asset by. Always shown — `item.slug` is never empty, unlike `publicUrl`
            above. */}
        <MediaEditCopyRow
          label={t("Embed code")}
          copied={embedCopied}
          onCopy={copyEmbedCode}
          copyButtonHandle={agentHandle("media-edit-copy-embed", { role: "button", label: "Copy this asset's embed code to the clipboard" })}
          t={t}
        >
          <code className="field-mono field-readonly">{embedSnippet}</code>
        </MediaEditCopyRow>
        {/* Integrity/dedupe metadata, demoted out of the main view — genuinely useful when
            chasing a duplicate upload or verifying a file, noise the rest of the time. Read-only:
            this is a content hash, not something an operator edits. Monospace per the OD idiom
            for values that are code/identifiers, not prose. */}
        <MediaEditCopyRow
          label={t("sha256")}
          copied={hashCopied}
          onCopy={copyHash}
          copyButtonHandle={agentHandle("media-edit-copy-hash", { role: "button", label: "Copy this asset's sha256 hash to the clipboard" })}
          t={t}
        >
          <code className="field-mono field-readonly">{item.sha256}</code>
        </MediaEditCopyRow>
        <span className="editor-actions">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            {...agentHandle("media-edit-save", { role: "button", label: "Save this asset's metadata" })}
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={onCancel}
            disabled={saving}
            {...agentHandle("media-edit-cancel", { role: "button", label: "Close this panel without saving" })}
          >
            {t("Cancel")}
          </button>
        </span>
      </div>
      {error ? (
        <span className="save-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** {@link EditMediaPanel}'s public-render override fields: width/height, CSS class and HTML
 *  attributes. A top-level component so the panel's own branch count stays under the complexity
 *  ceiling — these fields' `??` and ternary reads were half of it. */
function MediaEditRenderOverrideFields(
  props: Pick<EditMediaPanelController, "draft" | "setWidth" | "setHeight" | "setCssClass" | "setHtmlAttributes" | "htmlAttributesError"> & {
    item: AdminMedia;
    t: (key: string) => string;
  }
) {
  const { item, draft, setWidth, setHeight, setCssClass, setHtmlAttributes, htmlAttributesError, t } = props;
  return (
    <>
      {/* Quick-and-dirty public-render sizing fields (owner-directed skip-the-ADR fix — images
          inserted into post bodies were rendering at full native pixel width with no way to
          control size). Both optional, pixel-size numeric inputs: leaving either (or both) blank
          means "render at native/as-is size" — the public renderer omits the attribute entirely
          rather than defaulting to a computed value. Own row directly under Caption/Credit, per
          owner's explicit placement instruction. */}
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={`media-edit-width-${item.id}`}>
            {t("Width (px)")}
          </label>
          <input
            id={`media-edit-width-${item.id}`}
            type="number"
            min={1}
            placeholder="native"
            value={draft.width ?? ""}
            onChange={(e) => setWidth(e.target.value)}
            {...agentHandle("media-edit-width", {
              role: "field",
              label: "Render width in pixels for this asset in post bodies — blank means native size",
            })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`media-edit-height-${item.id}`}>
            {t("Height (px)")}
          </label>
          <input
            id={`media-edit-height-${item.id}`}
            type="number"
            min={1}
            placeholder="native"
            value={draft.height ?? ""}
            onChange={(e) => setHeight(e.target.value)}
            {...agentHandle("media-edit-height", {
              role: "field",
              label: "Render height in pixels for this asset in post bodies — blank means native size",
            })}
          />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`media-edit-css-class-${item.id}`}>
          {t("CSS class (optional)")}
        </label>
        <input
          id={`media-edit-css-class-${item.id}`}
          value={draft.cssClass ?? ""}
          onChange={(e) => setCssClass(e.target.value)}
          {...agentHandle("media-edit-css-class", { role: "field", label: "Optional CSS class applied to this asset in post bodies" })}
        />
      </div>
      {/* HTML attributes (2026-09-07, owner-directed — animations, custom WebMCP hooks on the
          emitted tag). `htmlAttributesError` below is a LIVE, as-you-type hint only — it must
          never disable Save (see `use-edit-media-panel.hooks.ts`'s own header for the regression
          this rule prevents, `a7cce060`): an invalid value here still lets every other field save,
          and the server's own 400 (already enforced independently, not just by this hint) surfaces
          through the `error` banner below exactly like a malformed slug already does. */}
      <div className="field">
        <label className="field-label" htmlFor={`media-edit-html-attributes-${item.id}`}>
          {t("HTML attributes (optional)")}
        </label>
        <input
          id={`media-edit-html-attributes-${item.id}`}
          value={draft.htmlAttributes ?? ""}
          onChange={(e) => setHtmlAttributes(e.target.value)}
          aria-invalid={htmlAttributesError ? true : undefined}
          {...agentHandle("media-edit-html-attributes", {
            role: "field",
            label: "Optional HTML attributes applied to this asset's rendered tag on the public site",
          })}
        />
        {htmlAttributesError ? <p className="field-error">{htmlAttributesError}</p> : null}
      </div>
    </>
  );
}

/** A read-only value plus its Copy button — {@link EditMediaPanel}'s File URL and sha256 rows share
 *  this shape. `copyButtonHandle` is the button's `agentHandle(...)` spread, built at the call site so
 *  each handle id stays a literal in `EditMediaPanel`. */
function MediaEditCopyRow(props: {
  label: string;
  copied: boolean;
  onCopy: () => void;
  copyButtonHandle: ReturnType<typeof agentHandle>;
  t: (key: string) => string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="field-readonly-row">
        {props.children}
        <button type="button" className="btn-ghost" onClick={props.onCopy} {...props.copyButtonHandle}>
          {props.copied ? props.t("Copied") : props.t("Copy")}
        </button>
      </div>
    </div>
  );
}

/** Stable id for `EditMediaModal`'s own accessible name — a static constant, not a generated one,
 *  since exactly one instance is ever mounted at a time (see this component's own doc comment,
 *  same reasoning `ThemePageDetailsModal.tsx`'s `TITLE_ID` documents for its own single instance). */
const EDIT_MEDIA_MODAL_TITLE_ID = "media-edit-modal-title";

interface EditMediaModalProps {
  /** The item currently being edited, or `null` while closed — mirrors
   *  `ThemePageDetailsModalProps.row`'s null-is-closed convention. */
  item: AdminMedia | null;
  onSaved: () => void;
  onCancel: () => void;
  /**
   * Dependency injection seam for tests — the same convention `Posts.tsx`'s `usePostsHook` uses.
   * Defaulted to the real hook, so production callers pass nothing and behave exactly as before.
   */
  useEditMediaModalHook?: typeof useEditMediaModal;
  /** Translator closure — see `Media()`'s own `t`; forwarded to the `EditMediaPanel` this wraps. */
  t: (key: string) => string;
}

/**
 * Single shared `<dialog>` wrapping `EditMediaPanel` — owner ask (2026-09-07): reach the metadata
 * edit form from an eye icon on the card, as a modal, instead of an inline panel pushing the grid
 * down. Same "controlled, never conditionally unmounted" shape as `MediaLightbox`/`ConfirmDialog`
 * (`MediaLibraryPanel` below renders exactly one `<EditMediaModal>`, toggling only its `item` prop),
 * and the same native-`<dialog>` foundation/lifecycle as `ThemePageDetailsModal.tsx` — see
 * `use-edit-media-modal.hooks.ts`'s own header for why that lifecycle hook is a local copy rather
 * than a shared import.
 *
 * `EditMediaPanel` itself still gets `key={item.id}` here, not on the `<dialog>` — the dialog BOX
 * stays mounted across an edit-target switch (so its own open/close transition is never disturbed
 * by which item is inside it), but the form content must still remount and reseed its draft from
 * the new item, preserving the 2026-08-12 audit fix (`MediaLibraryPanel`'s own comment on this same
 * `key` has the full incident writeup).
 */
function EditMediaModal({ item, onSaved, onCancel, useEditMediaModalHook = useEditMediaModal, t }: EditMediaModalProps) {
  const { dialogRef, handleNativeCancel, handleBackdropClick } = useEditMediaModalHook(item !== null, onCancel);

  return (
    <dialog
      ref={dialogRef}
      className="media-edit-dialog"
      aria-labelledby={item ? EDIT_MEDIA_MODAL_TITLE_ID : undefined}
      onCancel={handleNativeCancel}
      onClick={handleBackdropClick}
      {...agentHandle("media-edit-dialog", { role: "region", label: "Edit this asset's metadata, presented as a modal" })}
    >
      {item ? (
        <EditMediaPanel key={item.id} item={item} onSaved={onSaved} onCancel={onCancel} t={t} titleId={EDIT_MEDIA_MODAL_TITLE_ID} />
      ) : null}
    </dialog>
  );
}

interface MediaLightboxProps {
  /** The full grid list, not just the open item — see `use-media-lightbox.hooks.ts`'s
   *  `MediaLightboxHookProps` for why this is the whole array rather than a resolved item. */
  items: AdminMedia[];
  /** Index into `items` that is open, or `null` when closed — see the hook props' own comment for
   *  why an index rather than the item itself. */
  activeIndex: number | null;
  onNavigate: (index: number) => void;
  onClose: () => void;
  /**
   * Dependency injection seam for tests — the same convention `Posts.tsx`'s `usePostsHook` uses.
   * Defaulted to the real hook, so production callers pass nothing and behave exactly as before.
   */
  useMediaLightboxHook?: typeof useMediaLightbox;
  /** Translator closure — see `Media()`'s own `t`; forwarded to the `MediaPreview` this remounts. */
  t: (key: string) => string;
}

/**
 * Single shared lightbox `<dialog>` for the whole Media grid — see this file's header comment for
 * why one shared instance is used instead of one per card. Controlled exactly like `ConfirmDialog`
 * (native `<dialog>`, stays mounted unconditionally, `showModal()`/`close()` driven by an effect,
 * guarded by the same jsdom-compat `typeof` check `ConfirmDialog` uses — jsdom 29 implements
 * neither method) — see that component's own doc comment for the full rationale of building on
 * native `<dialog>` rather than a hand-rolled focus-trap/backdrop `<div>`.
 *
 * Renders the enlarged asset via the SAME `MediaPreview` the grid card uses (not a lightbox-
 * specific clone of the image/video/placeholder fallback chain) — `media.css`'s `.media-lightbox-
 * media` scope re-skins `.media-card-media`/`.media-card-placeholder` for a contain-fit, full-size
 * presentation purely in CSS, so the fallback logic itself (and the property that a defused
 * octet-stream asset lands on the placeholder with zero special-casing) is defined in exactly one
 * place.
 */
function MediaLightbox(props: MediaLightboxProps) {
  const { items, activeIndex, onNavigate, onClose, useMediaLightboxHook = useMediaLightbox, t } = props;
  const { titleId, dialogRef, closeRef, item, hasPrev, hasNext, handleNativeCancel, handleBackdropClick, handleKeyDown, goToPrev, goToNext } =
    useMediaLightboxHook({ items, activeIndex, onNavigate, onClose });

  return (
    <dialog
      ref={dialogRef}
      className="media-lightbox"
      aria-labelledby={item ? titleId : undefined}
      onCancel={handleNativeCancel}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      {item ? (
        <>
          <div className="media-lightbox-header">
            <h2 id={titleId} className="media-lightbox-title">
              {item.title}
            </h2>
            {items.length > 1 ? (
              <span className="media-lightbox-counter">
                {activeIndex! + 1} / {items.length}
              </span>
            ) : null}
            <button
              type="button"
              ref={closeRef}
              className="media-lightbox-close"
              aria-label={t("Close")}
              onClick={onClose}
              {...agentHandle("media-lightbox-close", { role: "button", label: "Close the lightbox" })}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="media-lightbox-stage">
            {hasPrev ? (
              <button
                type="button"
                className="media-lightbox-nav media-lightbox-nav-prev"
                aria-label={t("Previous asset")}
                onClick={goToPrev}
                {...agentHandle("media-lightbox-prev", { role: "button", label: "Show the previous asset" })}
              >
                <ChevronIcon />
              </button>
            ) : null}
            <div className="media-lightbox-media">
              {/* `key` is load-bearing, not a list-reconciliation habit: `useMediaPreview`'s `stage`
                  is component state with no reset-on-`item` effect, and this ONE shared lightbox
                  instance sits at a fixed tree position across prev/next. Without a changing key
                  React keeps the instance, so a PDF that fell all the way through to `"unsupported"`
                  leaves the next asset stuck on the placeholder even when it is a perfectly good
                  image. The grid cards never hit this — each card owns its own instance. */}
              <MediaPreview key={item.id} item={item} t={t} />
            </div>
            {hasNext ? (
              <button
                type="button"
                className="media-lightbox-nav media-lightbox-nav-next"
                aria-label={t("Next asset")}
                onClick={goToNext}
                {...agentHandle("media-lightbox-next", { role: "button", label: "Show the next asset" })}
              >
                <ChevronIcon flip />
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

/** The upload row — file picker, alt-text draft, and the Upload button. Extracted out of `Media`
 *  because its "Uploading…"/"Upload" label ternary was one of that component's independent
 *  branches; as a top-level function it's scored in its own scope instead.
 *
 *  Neither the file picker nor the alt-text field has a visible `<label>` (this toolbar was built
 *  compact, one row, no stacked labels) and the alt-text field's `placeholder` alone is not an
 *  accessible name — a placeholder is erased from the accessibility tree the moment it has a
 *  value, and a bare `<input type="file">` has none at all. Both had only this file's own
 *  `agentHandle(..., { label })`, which is a `data-agent-label` attribute invisible to a real
 *  screen reader or a generic browser agent's accessibility tree (only Tovu's own `data-agent-*`
 *  convention reads it) — so both get an explicit `aria-label` too, reusing the same `t()` key
 *  already shown as the alt field's placeholder rather than inventing a second string for the
 *  same field. */
function MediaToolbar({
  fileInputRef,
  altDraft,
  setAltDraft,
  selectedFileName,
  onFileChange,
  upload,
  uploading,
  t,
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  altDraft: string;
  setAltDraft: (value: string) => void;
  selectedFileName: string;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  upload: () => void;
  uploading: boolean;
  t: (key: string) => string;
}) {
  const fileInputId = useId();

  return (
    <div
      className="toolbar"
      {...agentHandle("media-upload-toolbar", { role: "region", label: "Upload — choose a file, optional alt text, and Upload" })}
    >
      <input
        id={fileInputId}
        ref={fileInputRef}
        className="file-input"
        type="file"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
        // Hand-copied, not imported — same "kept in sync manually with the server's real ceiling"
        // pattern as `FILE_HANDLER_ALLOWED_MIME_TYPES` (`apps/admin/src/features/posts/hooks/
        // use-post-editor.hooks.ts`) and `IMPORTABLE_CONTENT_TYPES` (`apps/website/src/features/
        // media-import/fetch-image.ts`): mirrors `DEFAULT_ALLOWED_MIME_TYPES`
        // (`@jini-ai/cms/media`'s `media-service.ts`), which has accepted `video/mp4`/`video/webm`
        // since 2026-08-24 — this attribute drifted out of sync with that until 2026-09-07 (see the
        // regression test pinning this exact set). Advisory only: `port.uploadMedia` still enforces
        // the real allowlist server-side regardless of what this lets past the file picker.
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm"
        aria-label={t("File to upload")}
        onChange={onFileChange}
        {...agentHandle("media-upload-file", {
          role: "field",
          label: "The file to upload — image/jpeg, png, webp, gif, avif, mp4 or webm",
        })}
      />
      <label className="btn-secondary" htmlFor={fileInputId}>
        {t("Choose file")}
      </label>
      <span style={{ color: "var(--fg-2)", fontSize: "var(--text-sm)" }} aria-live="polite">
        {selectedFileName || t("No file chosen")}
      </span>
      <input
        value={altDraft}
        onChange={(e) => setAltDraft(e.target.value)}
        placeholder={t("Alt text (optional)")}
        aria-label={t("Alt text (optional)")}
        {...agentHandle("media-upload-alt", { role: "field", label: "Alt text for the file being uploaded" })}
      />
      <button
        onClick={upload}
        disabled={uploading}
        {...agentHandle("media-upload-submit", { role: "button", label: "Upload the chosen file" })}
      >
        {uploading ? t("Uploading…") : t("Upload")}
      </button>
    </div>
  );
}

/**
 * The "Order by" dropdown (owner-directed, 2026-09-11) — a plain `<select>`, matching this
 * screen's existing "no new form-control primitive for one field" bar (`MediaToolbar`'s own inputs
 * are plain too). Options come from `MEDIA_ORDER_OPTIONS` (`rules.ts`) so this component and
 * `sortMediaByOrder` can never disagree about which order ids exist. A real `<label htmlFor>`
 * rather than only an `agentHandle`, for the same reason `MediaToolbar`'s own fields get one
 * (see that component's header comment): a bare `<select>` needs an accessible name for a screen
 * reader or a generic browser agent, and `data-agent-label` is invisible to both.
 */
function MediaOrderControl({
  orderBy,
  setOrderBy,
  t,
}: {
  orderBy: MediaOrderBy;
  setOrderBy: (value: MediaOrderBy) => void;
  t: (key: string) => string;
}) {
  return (
    <div
      className="media-order-control"
      {...agentHandle("media-order-by", { role: "field", label: "Order the media grid by Created or Alphabetical" })}
    >
      <label htmlFor="media-order-by-select">{t("Order by")}</label>
      <select id="media-order-by-select" value={orderBy} onChange={(e) => setOrderBy(e.target.value as MediaOrderBy)}>
        {MEDIA_ORDER_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {t(option.label)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The purge-confirmation dialog — extracted out of `Media` for the same reason as
 *  `MediaToolbar`: its `pendingPurge`-derived `body`/`pending` expressions were two more of that
 *  component's independent branches. */
function MediaPurgeDialog({
  pendingPurge,
  rowSavingId,
  onConfirm,
  onCancel,
  t,
}: {
  pendingPurge: AdminMedia | null;
  rowSavingId: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}) {
  return (
    <ConfirmDialog
      open={pendingPurge !== null}
      title={t("Delete permanently?")}
      body={
        pendingPurge ? (
          <p>
            {t("Permanently delete")} &quot;{pendingPurge.title}&quot;? {t("This cannot be undone.")}
          </p>
        ) : null
      }
      confirmLabel={t("Delete permanently")}
      destructive
      pending={pendingPurge !== null && rowSavingId === pendingPurge.id}
      onConfirm={onConfirm}
      onCancel={onCancel}
      agentHandle="media-purge"
    />
  );
}

export interface MediaProps {
  /**
   * Dependency injection seam for tests — the same convention `Posts.tsx`'s `usePostsHook` uses.
   * Defaulted to the real hook, so production callers pass nothing and behave exactly as before.
   */
  useMediaHook?: typeof useWiredMedia;
  /**
   * Dependency injection seam for tests — same convention, no port (see `use-media-tabs.hooks.ts`'s
   * own doc for why this pure-UI-state hook has no `useWiredX()` pair to default to instead).
   */
  useMediaTabsHook?: typeof useMediaTabs;
  /** The `?tab=` query value from `panels.tsx`'s `media` route (`URLSearchParams.get` returns
   *  `null` when the param is absent). See `use-media-tabs.hooks.ts`'s `resolveActiveTab`. */
  tabId?: string | null;
}

/**
 * Resolves `Media`'s two injectable-seam props to their real implementations when a caller passes
 * neither — same "separately-scoped resolver" idiom `App.tsx`'s `resolveSessionHook`/
 * `resolveDrawerHook` group uses and documents in full: ESLint's cyclomatic-complexity rule counts
 * a default-parameter assignment inside a function's OWN body as one of that function's own
 * branches, but not a call out to a resolver declared in its own scope.
 */
function resolveMediaHook(useMediaHook: typeof useWiredMedia | undefined): typeof useWiredMedia {
  return useMediaHook ?? useWiredMedia;
}
function resolveMediaTabsHook(useMediaTabsHook: typeof useMediaTabs | undefined): typeof useMediaTabs {
  return useMediaTabsHook ?? useMediaTabs;
}

/**
 * The grid-or-empty-state half of the "all"/"images"/"videos" tabs — split out of `Media` for the
 * same reason `MediaToolbar`/`MediaPurgeDialog` above already are: `visibleMedia.length === 0`'s
 * nested tab-kind ternary was one of that component's own independent branches (and, per
 * `sonarjs/no-nested-conditional`, a nested ternary in its own right); scored here in its own scope
 * instead.
 */
function MediaGridOrEmpty({
  activeTab,
  visibleMedia,
  mediaExpandHandles,
  editingId,
  locale,
  t,
  onExpand,
  onToggleEdit,
  onTrash,
  onRequestPurge,
}: {
  activeTab: MediaContentTabId;
  visibleMedia: AdminMedia[];
  mediaExpandHandles: string[];
  editingId: string | null;
  locale: string;
  t: (key: string) => string;
  onExpand: (index: number) => void;
  onToggleEdit: (item: AdminMedia) => void;
  onTrash: (item: AdminMedia) => void;
  onRequestPurge: (item: AdminMedia | null) => void;
}) {
  if (visibleMedia.length === 0) {
    if (activeTab === "all") {
      return (
        <div className="card">
          <div className="empty-state">
            <p>{t("No media uploaded yet.")}</p>
            <p className="page-description">{t("Choose a file above and upload it to get started.")}</p>
          </div>
        </div>
      );
    }
    return <MediaTypeEmptyState kind={activeTab} t={t} />;
  }

  return (
    <div className="media-grid">
      {visibleMedia.map((item, index) => (
        <div className="media-card" key={item.id}>
          <div className="media-card-preview">
            <MediaPreview
              item={item}
              onExpand={() => onExpand(index)}
              agentExpandHandle={`${mediaExpandHandles[index]}-expand`}
              onEdit={() => onToggleEdit(item)}
              agentEditHandle={`${mediaExpandHandles[index]}-edit`}
              t={t}
            />
          </div>
          <div className="media-card-body">
            <p className="media-card-title" title={item.title}>
              {item.title}
            </p>
            <div className="media-card-meta">
              <span className={`status status-${item.status}`}><ServerLabel value={item.status} /></span>
              <RowMenu
                triggerLabel={t('Actions for "{title}"').replace("{title}", item.title)}
                agentHandle={`${mediaExpandHandles[index]}-menu`}
                items={mediaRowMenuItems(item, editingId, { onToggleEdit, onTrash, onRequestPurge }, locale)}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Everything the "all"/"images"/"videos" tabs render — split out of `Media` for the same
 * "independent branches scored in their own scope" reasoning as `MediaToolbar`/`MediaPurgeDialog`/
 * `MediaGridOrEmpty` above: the error notice, edit-panel, and untyped-note ternaries were three
 * more of that component's own branches.
 *
 * Takes `Media`'s own controller spread rather than 20 individual props (`{...controller}` at the
 * call site below) — `media` is overridden with the already-null-checked value, since `Media` has
 * already handled the `!media` loading state by the time this renders.
 */
function MediaLibraryPanel(
  props: Omit<MediaController, "media"> & {
    media: AdminMedia[];
    activeTab: MediaContentTabId;
    visibleMedia: AdminMedia[];
    mediaExpandHandles: string[];
  },
) {
  const {
    media,
    error,
    activeTab,
    visibleMedia,
    mediaExpandHandles,
    uploading,
    altDraft,
    setAltDraft,
    selectedFileName,
    onFileChange,
    fileInputRef,
    upload,
    editingId,
    editingItem,
    toggleEditing,
    onMetadataSaved,
    setEditingId,
    trash,
    pendingPurge,
    setPendingPurge,
    rowSavingId,
    purge,
    lightboxIndex,
    setLightboxIndex,
    orderBy,
    setOrderBy,
    t,
    locale,
  } = props;

  return (
    <>
      {error ? <div className="notice error">{error}</div> : null}
      <MediaToolbar
        fileInputRef={fileInputRef}
        altDraft={altDraft}
        setAltDraft={setAltDraft}
        selectedFileName={selectedFileName}
        onFileChange={onFileChange}
        upload={upload}
        uploading={uploading}
        t={t}
      />

      <MediaOrderControl orderBy={orderBy} setOrderBy={setOrderBy} t={t} />

      {/* `key` on `EditMediaPanel` INSIDE `EditMediaModal` (2026-08-12 audit round 2, blocker F1 —
          domain 4, writing to the wrong record; the modal wrapper added 2026-09-07 does not change
          this). Without it this panel is a single reused instance: `toggleEditing` goes from item
          A's id straight to item B's id (`setEditingId((id) => id === item.id ? null : item.id)` —
          it only passes through `null` when you re-click the SAME row, and `mediaRowMenuItems`
          leaves every other row's "Edit metadata" enabled while one is open), so React re-renders
          rather than remounting. `useEditMediaPanel` seeds `draft` in a `useState` initializer,
          which runs once per mount and never re-reads `item` — so `draft` stayed bound to A while
          `item` became B, and `save()` PATCHed B's id with A's title/alt/caption/credit/dimensions.
          Two ordinary clicks, no race, no adversarial input, and zero test coverage.
          This surface was wrongly recorded as already covered by the `panels.tsx` `key=` sweep —
          it is not router-driven, so that sweep never reached it. See `EditMediaModal`'s own doc
          comment for why the `key` lives on `EditMediaPanel`, not on the `<dialog>` around it. */}
      <EditMediaModal item={editingItem} onSaved={onMetadataSaved} onCancel={() => setEditingId(null)} t={t} />

      {activeTab !== "all" && hasUntypedMedia(media) ? <UntypedMediaNote t={t} /> : null}

      <MediaGridOrEmpty
        activeTab={activeTab}
        visibleMedia={visibleMedia}
        mediaExpandHandles={mediaExpandHandles}
        editingId={editingId}
        locale={locale}
        t={t}
        onExpand={setLightboxIndex}
        onToggleEdit={toggleEditing}
        onTrash={trash}
        onRequestPurge={setPendingPurge}
      />

      {/* `items` MUST be the same array the grid above maps, not the unfiltered `media`:
          `lightboxIndex` is a positional index produced by that map, so handing the lightbox a
          different array would open the wrong asset (and mis-clamp its prev/next arrows) on
          every filtered tab. */}
      <MediaLightbox
        items={visibleMedia}
        activeIndex={lightboxIndex}
        onNavigate={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
        t={t}
      />

      <MediaPurgeDialog
        pendingPurge={pendingPurge}
        rowSavingId={rowSavingId}
        onConfirm={purge}
        onCancel={() => setPendingPurge(null)}
        t={t}
      />
    </>
  );
}

/**
 * The empty state for a tab whose filter matched nothing — distinct from the All tab's "No media
 * uploaded yet.", which would be a lie on a filtered tab holding a library full of other types.
 *
 * NOTE (2026-09-07, fixed): this comment used to explain why the Videos tab was normally empty —
 * first "the server allowlist rejects video" (false since 2026-08-24), then, after that was
 * corrected, "this screen's own file-input `accept` filter lists only the image types" (Agent H's
 * finding, `MediaToolbar`'s `accept` above — that gap was real and is now fixed too). With both the
 * server ceiling AND this screen's own file picker accepting `video/mp4`/`video/webm`, a video is a
 * completely ordinary upload now — the Videos tab's copy below matches the Images tab's own
 * "appears here once you add them" phrasing instead of claiming videos aren't supported.
 */
function MediaTypeEmptyState({ kind, t }: { kind: "images" | "videos"; t: (key: string) => string }) {
  return (
    <div className="card">
      <div className="empty-state">
        <p>{kind === "images" ? t("No images yet.") : t("No videos yet.")}</p>
        <p className="page-description">
          {kind === "images"
            ? t("Uploaded images appear here once you add them.")
            : t("Uploaded videos appear here once you add them.")}
        </p>
      </div>
    </div>
  );
}

/** Note shown on a filtered tab when some assets have no detected type. See `rules.ts`'s
 *  `hasUntypedMedia` for why this is normally absent, and why silence would be the wrong default. */
function UntypedMediaNote({ t }: { t: (key: string) => string }) {
  return (
    <div className="notice">
      {t("Some items have no detected type and aren't shown in this tab.")}{" "}
      {t("You can find them on the All tab.")}
    </div>
  );
}

/**
 * The "External Providers" tab body — credentials for outside media generation services (API
 * keys for image/video/audio-generation vendors), extracted the same way `MediaToolbar`/
 * `MediaGridOrEmpty` above are: an independent branch of `Media`'s own render, scored in its own
 * scope.
 *
 * Landed here 2026-09-10 (owner call, second pass) after one day on
 * `features/providers/Providers.tsx` as its "Media" tab — see that file's own header for the full
 * move history, and `media-provider-catalog.ts`/`media-providers-port.ts` (both moved into this
 * feature alongside it) for why the catalog is keyed off the generation engine's own spellings, not
 * `@jini-ai/ui`'s sample one.
 *
 * `I18nProvider` is load-bearing here, not decoration — same trap `Providers.tsx`'s own header
 * documents in full: `MediaProvidersTab` resolves its own copy through `@jini-ai/ui`'s `useT()`,
 * which silently falls through to raw English keys with no ancestor provider, in every non-English
 * locale, with no error anywhere. `data-theme="light"` on the inner wrapper is the same
 * `media-providers-panel` class `styles.css`'s "Media providers tab: neutralize Jini's warm 'paper'
 * tokens" section targets — kept byte-for-byte through both moves so that CSS keeps applying
 * unmoved.
 */
function ExternalProvidersPanel({ locale }: { locale: string }) {
  return (
    <I18nProvider
      initialLocale={locale}
      dictionaries={SETTINGS_DIALOG_DICTIONARIES}
      fallbackLocale="en"
      syncDocumentAttributes={false}
    >
      <div className="media-providers-panel" data-theme="light">
        <MediaProvidersTab port={mediaProvidersPort} catalog={MEDIA_PROVIDER_CATALOG} pinnedProviderIds={PINNED_MEDIA_PROVIDER_IDS} />
      </div>
    </I18nProvider>
  );
}

/**
 * The page header and tab bar every `Media` tab shares — extracted so `Media`'s own early return
 * on the External Providers tab (see that function's own comment) does not have to duplicate this
 * markup between two `return` statements. `children` is whichever tab body is active: either
 * `MediaLibraryPanel`'s grid or `ExternalProvidersPanel`.
 */
function MediaPageShell({
  t,
  activeTab,
  setActiveTab,
  children,
}: {
  t: (key: string) => string;
  activeTab: MediaTabId;
  setActiveTab: MediaTabsController["setActiveTab"];
  children: React.ReactNode;
}) {
  return (
    <div className="page">
      <div
        className="page-header"
        {...agentHandle("media-header", { role: "region", label: "Media header — page title" })}
      >
        <div className="page-header-text">
          <p className="page-kicker">{t("Content")}</p>
          <h1 className="page-title">{t("Media")}</h1>
          <p className="page-description">{t("Upload and manage image and video assets used across the site.")}</p>
        </div>
        <div className="page-actions">
          <PublishSectionButton section="media" />
        </div>
      </div>

      {/* Tab bar (OD-parity pass, 2026-08-08), `?tab=` deep-linked — see `use-media-tabs.hooks.ts`
          for the URL-sync convention. Drawn by the shared `components/TabBar` since 2026-09-06
          (owner: "give the tabs icons … every other tab row in this admin already pairs an icon
          with its label — match that"): the same underline-and-icon primitive Roles, Source
          Control, Database, Sites, Themes and Pages use, replacing the pill row this screen used
          to draw itself (`media.css`'s retired `.media-tabs`). Tabs, ids, order, the translated
          labels and every per-tab agent handle are unchanged — `Media.hooks.tsx`'s
          `resolveMediaTabs` builds them from the same `MEDIA_TABS` list.
          "External Providers" JOINED this screen 2026-09-10 (owner-approved nav restructure, second
          pass) — it spent one day as the "Media" tab on `features/providers/Providers.tsx` before
          landing here for good; see that file's own header for the full move history. It is the
          fourth, LAST tab — "all"/"images"/"videos" are the three content-filter tabs an operator
          reaches for far more often, and read as one group with this one set apart. */}
      <TabBar ariaLabel={t("Media")} tabs={resolveMediaTabs(t)} activeId={activeTab} onChange={resolveMediaTabChange(setActiveTab)} />

      {children}
    </div>
  );
}

export function Media(props: MediaProps) {
  // No `MediaProps = {}` default on the parameter itself (same reasoning as `App.tsx`'s own
  // `AppProps` — see that file's comment): every real call site is JSX (`<Media />` in
  // `panels.tsx`/tests), and JSX's `createElement`/`jsx` runtime always constructs an actual props
  // object — `{}` when no attributes are given, never `undefined` — so `Media` is never invoked
  // with zero arguments the way a plain function call could be. `MediaProps`' three fields are all
  // optional, so `{}` satisfies the type and this compiles the same as before for every existing
  // call site.
  const useMediaHook = resolveMediaHook(props.useMediaHook);
  const useMediaTabsHook = resolveMediaTabsHook(props.useMediaTabsHook);
  const controller = useMediaHook();
  const { media, error, t } = controller;
  const { activeTab, setActiveTab } = useMediaTabsHook(props.tabId);

  if (error && !media) return <div className="notice error">{error}</div>;
  if (!media) return <div className="notice">{t("Loading media…")}</div>;

  // External Providers renders no grid, no filter, and has no concept of the grid's "empty" state —
  // an early return here (rather than a ternary further down) is what lets `MediaContentTabId`
  // narrow `activeTab` for the REST of this function, so `filterMediaByTab`/`MediaLibraryPanel`
  // below can declare that narrower type directly instead of re-widening to the full tab set (see
  // `MediaContentTabId`'s own doc comment in `use-media-tabs.hooks.ts`).
  if (activeTab === "external-providers") {
    return (
      <MediaPageShell t={t} activeTab={activeTab} setActiveTab={setActiveTab}>
        <ExternalProvidersPanel locale={controller.locale} />
      </MediaPageShell>
    );
  }

  // Computed after every early return so `media` is non-null and `activeTab` is narrowed to
  // `MediaContentTabId`. Not memoized: a single filter over a media library is cheap next to the
  // render it feeds, and a `useMemo` here cannot be hoisted above the early returns without
  // changing hook order.
  const visibleMedia = sortMediaByOrder(filterMediaByTab(media, activeTab), controller.orderBy);
  // Asset ids are stable and unique, so they disambiguate one card's expand button from another's —
  // same reasoning as every other list on this workstream.
  const mediaExpandHandles = buildAgentListHandles(
    "media-item",
    visibleMedia.map((item) => item.id),
  );

  return (
    <MediaPageShell t={t} activeTab={activeTab} setActiveTab={setActiveTab}>
      {/* "all", "images" and "videos" all render the SAME grid, differing only in which items reach
          it — one code path, so a card looks and behaves identically whichever tab it is viewed
          from, and the lightbox/edit/row-menu wiring below cannot drift per tab. */}
      <MediaLibraryPanel
        {...controller}
        media={media}
        activeTab={activeTab}
        visibleMedia={visibleMedia}
        mediaExpandHandles={mediaExpandHandles}
      />
    </MediaPageShell>
  );
}
