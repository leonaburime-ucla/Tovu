import type { Express } from "express";

import type { PublishContentDeps } from "#src/features/publish-content/type-registry";
import type { RouteDeps } from "#src/server/routes/types";

/**
 * @file Task 4 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §1.1/§4 task 4.
 *
 * Narrow `RouteDeps` slice for the `publish-content` server module, mirroring
 * `routes/content/deps.ts`'s `ContentRouteDeps` (SPEC-038's established pattern): a genuine
 * narrowing to the fields the export route actually reads, not a widening of `RouteDeps`.
 *
 * - `workspaceId`/`authorize`/`clock`/`idGen`: the mount-path 404 guard, the `publish_content.read`
 *   gate, and `PublishContentDeps`'s own `clock`/`idGen` fields (plan §3's `PublishContentDeps`).
 * - `postRepo`/`pluginBeforeSaveHook`/`outbox`: threaded into `PublishContentDeps` so the `post`/
 *   `page` contributors' `build()` gets the same repo/hook/outbox instances every other post/page
 *   route in this composition root uses — see `features/post/publish-content.ts`'s `buildHandler`.
 * - `workspaceRepo`: resolves the export bundle's `sourceLabel` (the workspace's own `name`) —
 *   see `export.ts`'s own doc for why a peer needs a human label, not just the raw workspace id.
 * - `blobStore`/`publishContentBundleRepo`: added for Task 6 (blob pre-flight + bundle staging —
 *   `blobs-probe.ts`/`blob-put.ts`/`bundle-create.ts`). `blobStore` is the same real ADR-027
 *   `BlobStorePort` every media route already shares (`RouteDeps.blobStore`'s own doc) — Task 6
 *   reuses `putIfAbsent` directly rather than building a second dedupe path (plan §4 task 6's own
 *   instruction). `publishContentBundleRepo` is new (this task): `publish_content_bundles`
 *   (migration `0066`) had no repo/port until now.
 * - `publishContentBaselineRepo`/`dbOps`/`restorePointsRepo`/`gatedMutations`/
 *   `publishContentApplyPort`: added for Task 7 (the gated `plan`/`confirm`/`execute` import
 *   ceremony — `import.ts`, `gated-hooks.ts`, `execute-import.ts`). `dbOps`/`restorePointsRepo`/
 *   `gatedMutations` are the same instance-wide singletons `taxonomy/merge-term.ts`/`database/
 *   migrate-forward.ts` already read directly off full `RouteDeps` — narrowed here instead of
 *   widening, per this file's own established pattern.
 * - `publishContentPeerRepo`/`publishContentPeerHttpClient`/`siteAssistantSecretSealer`/
 *   `siteAssistantSecretKeyring`: added for Task 10 (peers CRUD + the outbound push/pull driver —
 *   `peers.ts`, `peer-transport.ts`). The sealer/keyring pair is the SHARED ADR-058 pair every
 *   credential table in this codebase uses, narrowed here rather than widened (same reasoning
 *   `routes/types.ts`'s own doc records for the two config routes that already read them).
 *   `publishContentPeerHttpClient` is a guarded `HttpClientPort` built from this feature's own
 *   `createPublishContentPeerEgressPolicy()` — never a client any other consumer shares, because it
 *   is the only one whose `devHostAllowlist` is operator-configurable.
 * - `mediaRepo`/`assetBlobRepo`: added when `media` became a travelling type. Together with
 *   `blobStore` (already present above for Task 6) they are the three ports
 *   `features/media/publish-content.ts` reads; see {@link toPublishContentDeps} for why they are
 *   picked here rather than left to each route file to remember.
 * - `themesDir`/`fileBlobIndex`: S18 (S-F3, `publish-files-plan-2026-09-24.md` §3) — the site's own
 *   themes root and the process-lifetime file-blob address book a file-tree type's `pack()` fills.
 *   `themesDir` reaches `PublishContentDeps` so `features/theme/publish-content.ts`'s handler can
 *   walk it; `fileBlobIndex` reaches BOTH `PublishContentDeps` (so `pack()` can fill it) and
 *   `peer-transport.ts`/`blob-get.ts` directly off `RouteDeps` (so a blob-serving route can read it
 *   without going through the handler registry at all — see those two files' own headers).
 */
export type PublishContentRouteDeps = Pick<
  RouteDeps,
  | "workspaceId"
  | "authorize"
  | "clock"
  | "idGen"
  | "postRepo"
  | "pluginBeforeSaveHook"
  | "outbox"
  | "workspaceRepo"
  | "blobStore"
  | "publishContentBundleRepo"
  | "publishContentRunRepo"
  | "publishContentBaselineRepo"
  | "dbOps"
  | "restorePointsRepo"
  | "gatedMutations"
  | "publishContentApplyPort"
  | "publishContentSeedHash"
  | "publishContentPeerRepo"
  | "publishContentPeerHttpClient"
  | "siteAssistantSecretSealer"
  | "siteAssistantSecretKeyring"
  | "mediaRepo"
  | "assetBlobRepo"
  | "redirectsWriteDeps"
  | "menuRepo"
  | "navLocationBindingRepo"
  | "themesDir"
  | "fileBlobIndex"
>;

export type PublishContentRouteRegistrar = (app: Express, deps: PublishContentRouteDeps) => void;

/**
 * Narrows this module's `RouteDeps` slice to the `PublishContentDeps` bag every registered
 * contributor's `build()` closes over.
 *
 * **One copy, shared by every route file in this directory — deliberately, and the reason is a bug
 * this replaced.** `export.ts`, `import.ts` and `peer-transport.ts` each used to keep their own
 * private copy of this six-line function, following the per-route-file convention the rest of the
 * directory uses for handlers. When `media` became a travelling type, all three copies (plus both
 * composition roots' apply bags) had to learn three new fields, and none of them did: media packed
 * nothing, planned as `blocked`, and never reached `apply()`. Nothing failed loudly, because
 * `features/media/publish-content.ts` degrades silently on an absent `mediaRepo` (`pack()` returns,
 * `inspect()` returns `null`) — exactly as its own doc says it should for a caller that has no use
 * for media. A per-file copy makes "every caller learns the new field" a thing someone has to
 * remember; one function makes it structural, and the next content type gets it for free.
 *
 * `mediaRepo`/`assetBlobRepo`/`blobStore` are REQUIRED on `RouteDeps`, so a route file physically
 * cannot build a bag without them any more — the omission is now a compile error, not a silent skip.
 *
 * `beforeSaveHook` is the one renamed field: `RouteDeps` calls it `pluginBeforeSaveHook` (it is the
 * plugin runtime's hook), `PublishContentDeps` calls it `beforeSaveHook`. Mapped here once.
 *
 * @complexity O(1) — a field projection, no I/O.
 */
export function toPublishContentDeps(deps: PublishContentRouteDeps): PublishContentDeps {
  return {
    workspaceId: deps.workspaceId,
    clock: deps.clock,
    idGen: deps.idGen,
    outbox: deps.outbox,
    beforeSaveHook: deps.pluginBeforeSaveHook,
    // F2 — one ports bag keyed by entityType, instead of nine flat fields. See `type-registry.ts`'s
    // `PublishContentPorts` header for why. Apply-only ports (`post.forgetRemoved`/`.remove`,
    // `theme-files.onReplaced`) are supplied only by the apply bag (`apply-loop.ts`'s
    // `toPublishContentApplyDeps`), never here — this route bag only ever packs/inspects/prechecks.
    ports: {
      post: { repo: deps.postRepo },
      media: { repo: deps.mediaRepo, assetBlobRepo: deps.assetBlobRepo, blobStore: deps.blobStore },
      redirect: deps.redirectsWriteDeps,
      menu: { repo: deps.menuRepo, bindingRepo: deps.navLocationBindingRepo },
      "theme-files": { themesDir: deps.themesDir, fileBlobIndex: deps.fileBlobIndex },
    },
  };
}
