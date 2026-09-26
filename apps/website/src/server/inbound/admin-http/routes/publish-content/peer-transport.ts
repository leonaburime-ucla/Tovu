import type { Response } from "express";
import { computeBlobStorageKey } from "@jini-ai/cms/media";

import { stageBundle } from "#src/features/publish-content/bundle-staging";
import {
  applyPublishScope,
  buildExportBundle,
  includeReferencedEntities,
  selectBundleEntities,
} from "#src/features/publish-content/export-bundle";
import { buildPublishContentCatalog } from "#src/features/publish-content/type-registry";
import type { PublishScope } from "#src/features/publish-content/ui/contract";
import {
  confirmPeerImport,
  executePeerImport,
  pullBlobsFromPeer,
  pullBundleFromPeer,
  pushBundleToPeer,
  PublishContentPeerTransportError,
} from "#src/features/publish-content/peer-transport";
import { createCompositePeerBlobSource } from "#src/features/publish-content/composite-blob-source";
import {
  appendSkippedRowsToPeerPlan,
  keepChangingIncludedEntities,
  labelPeerPlanRows,
} from "#src/features/publish-content/report-labels";
import { resolvePublishDestinationCredential } from "#src/features/publish-content/destination-credential";
import {
  PublishContentPeerCredentialMissingError,
  PublishContentPeerNotFoundError,
  PublishContentPeerSecretStoreUnconfiguredError,
  type ResolvedPeerCredential,
} from "#src/features/publish-content/peers";
import { PublishTrustHandshakeError } from "#src/features/publish-trust/handshake-client";
import { authorizeOrRespond } from "#src/server/inbound/admin-http/authorize-guard";
import { getAuthedPrincipal, rejectUnlessSessionCredential } from "#src/server/inbound/admin-http/dev-auth";

import { toPublishContentDeps, type PublishContentRouteDeps, type PublishContentRouteRegistrar } from "./deps.js";

/**
 * @file Task 10 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §1.6/§4 task 10.
 *
 * The operator-facing half of the outbound leg, under
 * `/api/admin/v1/workspaces/:workspaceId/publish-content/peers/:peerId/...`:
 *
 * - `POST .../push/plan` → build a bundle here, upload the blobs the peer lacks, stage it there,
 *   return the PEER's gated plan.
 * - `POST .../push/confirm` → relay the operator's confirmation to the peer.
 * - `POST .../push/execute` → relay the redemption; the peer applies.
 * - `POST .../pull` → fetch the peer's export and stage it HERE, returning a local `bundleId` that
 *   this instance's own `/import/plan|confirm|execute` then drives. One importer, two directions.
 *
 * ## FROZEN CONTRACT: every route here takes a `peerId`
 *
 * Never a raw URL and never a credential from the client. The URL comes from the
 * `publish_content_peers` row, and the credential is resolved from that row for the lifetime of one
 * request (see the next section). A client that could supply a URL would turn these routes into an SSRF primitive
 * wearing an authorization check; a client that could supply a credential would make the sealed
 * column pointless.
 *
 * ## Where the safety properties live
 *
 * On a PUSH, they live on the DESTINATION: the peer runs its own `gated-mutations` gateway, so
 * `PLAN_STALE`, single-redemption tokens, `AGENT_CANNOT_CONFIRM` and the restore point are enforced
 * by the code that owns the data being written. This file only relays — it cannot assert a principal
 * kind over the wire, so it cannot weaken the agent-confirm guard even in principle.
 *
 * On a PULL, they live HERE, in the existing `/import/*` ceremony — which is exactly why this pull
 * route stops at staging rather than planning: adding a second entry point into `planImport` would
 * be a second place the gate could be forgotten.
 *
 * ## Two kinds of destination, resolved in one place
 *
 * `openPeer` no longer calls `resolvePeerCredential` directly. `destination-credential.ts` decides
 * whether this destination is an explicitly-configured peer (a sealed key, opened per request) or
 * one this install is CONNECTED to (nothing stored; a session token minted by proving possession of
 * the Site Token). Both arrive as the same `ResolvedPeerCredential`, so every route below is
 * unchanged and cannot tell them apart.
 *
 * ## The credential never appears in a response
 *
 * Nothing in this file reads `credential.apiKey`; it is passed straight into the transport driver,
 * which puts it in one `Authorization` header. Every error body below is built from a typed error
 * whose message is derived from the PEER's response, never from the request.
 */

/** @complexity O(1). */
function statusFor(err: unknown): { status: number; code: string } {
  if (err instanceof PublishContentPeerNotFoundError) return { status: 404, code: "PEER_NOT_FOUND" };
  // A connected destination's handshake. 502 for the same reason a transport error is: this
  // instance is fine and the request was well-formed — the far side (or the path to it) is what
  // failed, and the message is already the sentence the owner needs to act on.
  if (err instanceof PublishTrustHandshakeError) return { status: 502, code: "PUBLISH_TRUST_HANDSHAKE_FAILED" };
  if (err instanceof PublishContentPeerCredentialMissingError) return { status: 409, code: "PEER_CREDENTIAL_MISSING" };
  if (err instanceof PublishContentPeerSecretStoreUnconfiguredError) return { status: 503, code: "SECRET_STORE_UNCONFIGURED" };
  if (err instanceof PublishContentPeerTransportError) {
    // 502: this instance is fine and the request was well-formed; the PEER (or the path to it) is
    // what failed. A 500 here would send an operator looking in the wrong server's logs — and for
    // `EGRESS_REFUSED` specifically, the message is the `devHostAllowlist` diagnosis, which is only
    // actionable if it reaches them intact.
    return { status: 502, code: err.code };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

/** @complexity O(1). */
function respondWithError(res: { status(code: number): { json(body: unknown): void } }, err: unknown): void {
  const { status, code } = statusFor(err);
  const message = status === 500 ? "internal error" : err instanceof Error ? err.message : "internal error";
  res.status(status).json({ error: message, code });
}

/** The per-request transport bag: the guarded client plus the opened credential.
 *  @complexity O(1) plus one repo read and one AEAD open. */
async function openPeer(deps: PublishContentRouteDeps, peerId: string): Promise<{ credential: ResolvedPeerCredential; httpClient: PublishContentRouteDeps["publishContentPeerHttpClient"] }> {
  const credential = await resolvePublishDestinationCredential(
    {
      repo: deps.publishContentPeerRepo,
      sealer: deps.siteAssistantSecretSealer,
      keyring: deps.siteAssistantSecretKeyring,
      httpClient: deps.publishContentPeerHttpClient,
    },
    { workspaceId: deps.workspaceId, id: peerId }
  );
  return { credential, httpClient: deps.publishContentPeerHttpClient };
}

/** Distinguishes "the body carried a malformed selection" (a 400) from "the body carried none"
 *  (`null`, publish everything) — two outcomes a bare `null` return could not tell apart. */
const INVALID_SELECTION = Symbol("invalid-selection");

/**
 * Reads `push/plan`'s optional per-row selection: the `entityKey` strings
 * (`planner.ts`'s `${entityType}:${entityId}`) the operator left checked in the dialog.
 *
 * Absent means "publish everything", which is what every caller before the checkbox column sent and
 * what the dialog still sends when nothing was unchecked — the common path stays a bodyless POST.
 * An empty ARRAY is a real, different answer ("the operator unchecked everything") and is honoured
 * as such: it stages an empty bundle and plans to zero rows rather than quietly publishing the lot.
 *
 * @complexity O(n) in the submitted key count.
 */
function readSelectedEntityKeys(body: unknown): readonly string[] | null | typeof INVALID_SELECTION {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.selectedEntityKeys === undefined || raw.selectedEntityKeys === null) return null;
  if (!Array.isArray(raw.selectedEntityKeys)) return INVALID_SELECTION;
  if (!raw.selectedEntityKeys.every((key): key is string => typeof key === "string")) return INVALID_SELECTION;
  return raw.selectedEntityKeys;
}

/** `scope`'s per-field cap, matching {@link readOverwriteEntityKeys}'s 1000-entry bound below. */
const MAX_SCOPE_ARRAY_LENGTH = 1000;

/** @complexity O(1). */
function isNonEmptyStringArrayField(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_SCOPE_ARRAY_LENGTH && value.every((v) => typeof v === "string");
}

/**
 * Reads `push/plan`'s optional `scope` (`plan-publish-sections-2026-09-25.md` §1) — the section (or
 * section-plus-rows) this plan is about, applied BEFORE `selectedEntityKeys` narrows further (this
 * file's own `push/plan` handler). Absent/`null` means "publish everything", the same "absent, not an
 * empty real answer" contract every other optional array field on this route reads by.
 *
 * A present `entityTypes` or `entityKeys` must be a non-empty array of strings (at most
 * {@link MAX_SCOPE_ARRAY_LENGTH} entries): an empty array is refused rather than silently treated as
 * "everything" or "nothing", since `selectedEntityKeys` already uses an empty array for "nothing" and
 * a caller sending `scope: {entityTypes: []}` almost certainly meant something else.
 *
 * @returns `{scope: null}` when the body carries no `scope`, `{scope}` (the validated
 *   {@link PublishScope}) when it is well-formed, or `{invalidField}` naming which field was wrong
 *   (`"scope"` itself when it is not an object or names neither field — never read as "everything").
 * @complexity O(n) in the submitted array lengths.
 */
function readPublishScope(body: unknown): { scope: PublishScope | null } | { invalidField: "scope" | "entityTypes" | "entityKeys" } {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.scope === undefined || raw.scope === null) return { scope: null };
  if (typeof raw.scope !== "object" || Array.isArray(raw.scope)) return { invalidField: "scope" };
  const scopeBody = raw.scope as Record<string, unknown>;
  // A present scope naming neither field (`{}`, or a typo like `{types: [...]}`) would otherwise
  // narrow nothing — silently widening a one-section dialog to "publish everything". Refused.
  if (scopeBody.entityTypes === undefined && scopeBody.entityKeys === undefined) return { invalidField: "scope" };

  const scope: { entityTypes?: readonly string[]; entityKeys?: readonly string[] } = {};
  if (scopeBody.entityTypes !== undefined) {
    if (!isNonEmptyStringArrayField(scopeBody.entityTypes)) return { invalidField: "entityTypes" };
    scope.entityTypes = scopeBody.entityTypes;
  }
  if (scopeBody.entityKeys !== undefined) {
    if (!isNonEmptyStringArrayField(scopeBody.entityKeys)) return { invalidField: "entityKeys" };
    scope.entityKeys = scopeBody.entityKeys;
  }
  return { scope };
}

/** Distinguishes "the body carried a malformed set of ticks" (a 400) from "the body carried none"
 *  (`null`, force nothing) — the same two-outcome shape {@link readSelectedEntityKeys} above uses. */
const INVALID_OVERWRITE_KEYS = Symbol("invalid-overwrite-keys");

/**
 * publish-overwrite-live-plan §4/S7 — reads `push/plan`'s and `push/execute`'s optional
 * `overwriteEntityKeys`: the `entityKey()` strings (`planner.ts`) the operator ticked "Overwrite on
 * live" for. Absent/`null` means "force nothing", the pre-S7 default every existing caller keeps
 * getting. Bounded at 1000 entries, matching the destination's own cap
 * (`routes/publish-content/import.ts`'s `readOverwriteEntityKeys`) — repeated here rather than
 * imported, the same one-reader-per-route-file convention {@link readSelectedEntityKeys} already
 * follows in this file.
 *
 * @complexity O(n) in the submitted key count.
 */
function readOverwriteEntityKeys(body: unknown): readonly string[] | null | typeof INVALID_OVERWRITE_KEYS {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.overwriteEntityKeys === undefined || raw.overwriteEntityKeys === null) return null;
  if (!Array.isArray(raw.overwriteEntityKeys)) return INVALID_OVERWRITE_KEYS;
  if (raw.overwriteEntityKeys.length > 1000) return INVALID_OVERWRITE_KEYS;
  if (!raw.overwriteEntityKeys.every((key): key is string => typeof key === "string")) return INVALID_OVERWRITE_KEYS;
  return raw.overwriteEntityKeys;
}

/**
 * publish-overwrite-live-plan §7: "Overwrite on live" ticks come only from a person's click. On
 * this relay that means a signed-in admin session; an API key (a script, or a model holding one) is
 * refused. The destination can't tell the difference — it only ever sees this instance's
 * publishing credential — so this is the one place the rule can hold for a push. Empty ticks ask
 * for nothing and pass.
 *
 * @returns `true` when the request may proceed. On `false` the 403 has already been sent.
 * @complexity O(1).
 */
function mayOverwrite(res: Response, overwriteEntityKeys: readonly string[] | null): boolean {
  if (overwriteEntityKeys === null || overwriteEntityKeys.length === 0) return true;
  return rejectUnlessSessionCredential(res, {
    message: "'overwriteEntityKeys' can only be sent from a signed-in admin session",
    permission: "publish_content.apply",
  });
}

export const registerPublishContentPeerTransportRoutes: PublishContentRouteRegistrar = (app, deps) => {
  const base = "/api/admin/v1/workspaces/:workspaceId/publish-content/peers/:peerId";

  /** Every route here shares the same preamble: mount-path 404, authenticated principal, and the
   *  `publish_content.apply` gate. Factored so a new peer action cannot accidentally ship without
   *  one of the three. Returns the principal id, or `null` when a response has already been sent. */
  const guard = async (req: { params: Record<string, string | undefined> }, res: Parameters<Parameters<typeof app.post>[1]>[1]): Promise<string | null> => {
    if (String(req.params.workspaceId ?? "") !== deps.workspaceId) {
      res.status(404).json({ error: "workspace was not found" });
      return null;
    }
    const principal = getAuthedPrincipal(res);
    const allowed = await authorizeOrRespond(res, deps.authorize, {
      principalId: principal.id,
      permission: "publish_content.apply",
      workspaceId: deps.workspaceId,
    });
    return allowed ? principal.id : null;
  };

  app.post(`${base}/push/plan`, async (req, res) => {
    try {
      const principalId = await guard(req, res);
      if (principalId === null) return;

      const selectedEntityKeys = readSelectedEntityKeys(req.body);
      if (selectedEntityKeys === INVALID_SELECTION) {
        res.status(400).json({ error: "'selectedEntityKeys' must be an array of strings", code: "VALIDATION_ERROR" });
        return;
      }
      const scopeResult = readPublishScope(req.body);
      if ("invalidField" in scopeResult) {
        res.status(400).json({
          error:
            scopeResult.invalidField === "scope"
              ? "'scope' must be an object with 'entityTypes' and/or 'entityKeys'"
              : `'scope.${scopeResult.invalidField}' must be a non-empty array of strings`,
          code: "VALIDATION_ERROR",
        });
        return;
      }
      const overwriteEntityKeys = readOverwriteEntityKeys(req.body);
      if (overwriteEntityKeys === INVALID_OVERWRITE_KEYS) {
        res.status(400).json({ error: "'overwriteEntityKeys' must be an array of strings", code: "VALIDATION_ERROR" });
        return;
      }
      if (!mayOverwrite(res, overwriteEntityKeys)) return;

      const peer = await openPeer(deps, String(req.params.peerId ?? ""));
      const workspace = await deps.workspaceRepo.findById(deps.workspaceId);
      const publishContentDeps = toPublishContentDeps(deps);
      const fullBundle = await buildExportBundle({
        workspaceId: deps.workspaceId,
        principalId,
        authorize: deps.authorize,
        publishContentDeps,
        sourceLabel: workspace?.name ?? deps.workspaceId,
      });
      // `scope` narrows first (`plan-publish-sections-2026-09-25.md` §1 — "Publish pages" never even
      // uploads a media blob), THEN `selectedEntityKeys` narrows that result further, so an operator's
      // row selection inside a scoped dialog can only ever shrink what the scope already allowed.
      // `skipped` is narrowed by `scope` alone: a skipped unit was never selectable in the first place
      // (`export-bundle.ts`'s own `selectBundleEntities` doc), so a row selection has nothing to add.
      const scoped = scopeResult.scope === null ? fullBundle : applyPublishScope(fullBundle, scopeResult.scope);
      // A selection narrows what is STAGED, before the peer plans it — so a deselected entity is
      // never uploaded, never planned and never applied, rather than being filtered out by some
      // later step that could forget. See `export-bundle.ts`'s `selectBundleEntities`.
      const selected = selectedEntityKeys === null ? scoped : selectBundleEntities(scoped, new Set(selectedEntityKeys));
      // Owner decision 2026-09-25 (plan G3): a SCOPED run carries along what its (still-selected)
      // rows use — a page's images and widgets, a widget's form, an entry's collection — drawn from
      // the full bundle, derived after the selection, so a deselected page brings nothing and a
      // narrowed re-plan re-derives the same rule. An unscoped run already holds every row as an
      // ordinary one. See `includeReferencedEntities`.
      const { envelope: bundle, includedFor } =
        scopeResult.scope === null
          ? { envelope: selected, includedFor: new Map<string, readonly string[]>() }
          : includeReferencedEntities(selected, fullBundle, buildPublishContentCatalog(publishContentDeps).handlerByType);

      const result = await pushBundleToPeer(
        {
          ...peer,
          // S18 (S-F3) — sources a blob from the media blob store FIRST, falling back to
          // `RouteDeps.fileBlobIndex` (a file-tree type's `pack()` fill) so a blob that was never
          // copied into the blob store can still be pushed. See `composite-blob-source.ts`'s header.
          blobSource: createCompositePeerBlobSource({ blobStore: deps.blobStore, fileBlobIndex: deps.fileBlobIndex }),
          computeStorageKey: (sha256) => computeBlobStorageKey({ workspaceId: deps.workspaceId, sha256 }),
        },
        { bundle, ...(overwriteEntityKeys === null ? {} : { overwriteEntityKeys }) }
      );

      // S-F1: `pushBundleToPeer` probes the peer's own capabilities and trims the bundle to what it
      // accepts BEFORE staging anything, so `bundle.entities.length` (the selection this route built)
      // can be larger than what was actually sent. `entityCount` reports what was actually sent;
      // `notSupportedByLive` names what was not, and why — see `peer-transport.ts`'s (feature)
      // `PushBundleResult.notSupportedByLive` doc.
      const heldBackCount = result.notSupportedByLive.reduce((sum, entry) => sum + entry.count, 0);

      // The peer's gated plan is SPREAD at the top level, not nested under a `plan` key: this route
      // answers with the same `{domain, planId, planHash, details}` shape the LOCAL `/import/plan`
      // route does, so a client renders one plan shape regardless of direction (Task 11 binds
      // `details` as its `PublishContentReport`). The push-only fields sit alongside it.
      //
      // `bundleId` is load-bearing, not informational: the peer's `/import/execute` requires the
      // same bundle it planned, so a client MUST carry this value from here into `push/execute`.
      // Holding it server-side instead would mean remembering per-operator state between two
      // requests, which is exactly the kind of implicit session the gated ceremony avoids.
      res.json({
        peerId: peer.credential.id,
        peerLabel: peer.credential.label,
        bundleId: result.bundleId,
        entityCount: bundle.entities.length - heldBackCount,
        blobsUploaded: result.blobsUploaded,
        blobsUnavailable: result.blobsUnavailable,
        notSupportedByLive: result.notSupportedByLive,
        // publish-overwrite-live-plan §4/S7 — whether the peer just probed can honour a forced
        // overwrite at all. The admin dialog and the chat tool (S8/S9) read this before ever
        // offering an "Overwrite on live" tick.
        liveCanOverwrite: result.liveCanOverwrite,
        // Echoed back exactly as received — never defaulted to `[]` — so a client can carry the SAME
        // set from this plan into `push/execute` (`ui/contract.ts`'s `PublishContentPlanResult`)
        // without keeping its own parallel copy in sync. Omitted entirely when nothing was ticked,
        // the same "absent, not an empty real answer" contract `selectedEntityKeys` itself reads by
        // (this file's own `readSelectedEntityKeys` doc).
        ...(overwriteEntityKeys === null ? {} : { overwriteEntityKeys }),
        // The peer's plan, with each row named from the bundle we just sent it — a live site
        // deployed before `entityLabel` existed answers rows with no label, and this side can name
        // its own content regardless. See `features/publish-content/report-labels.ts`.
        //
        // Then: every whole unit THIS instance refused to pack (`scoped.skipped` — e.g. a theme
        // tree `file-tree-policy.ts` blocked) appended as its own non-selectable row. It never
        // reached the peer's bundle at all, so the peer's own plan has no way to report it — this is
        // the one place a caller holds both reports at once. Read off `scoped`, not the
        // (possibly selection-narrowed) `bundle`: a skipped unit was never selectable, so an
        // operator's row selection has nothing to say about whether it is still shown, but `scope`
        // itself still applies — a refused theme tree only belongs in a theme-files-scoped plan.
        //
        // Last, a carried-along row that live would write is tagged with the rows that use it, an
        // unchanged one is dropped, and a conflicting/blocked one stays as an ordinary row so the
        // operator sees it — `report-labels.ts`'s `keepChangingIncludedEntities`.
        ...appendSkippedRowsToPeerPlan(
          keepChangingIncludedEntities(labelPeerPlanRows(result.plan, bundle.entities), includedFor),
          scoped.skipped
        ),
      });
    } catch (err) {
      respondWithError(res, err);
    }
  });

  app.post(`${base}/push/confirm`, async (req, res) => {
    try {
      const principalId = await guard(req, res);
      if (principalId === null) return;

      const { planId, planHash } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof planId !== "string" || typeof planHash !== "string") {
        res.status(400).json({ error: "'planId' and 'planHash' (strings) are required", code: "VALIDATION_ERROR" });
        return;
      }

      const peer = await openPeer(deps, String(req.params.peerId ?? ""));
      res.json(await confirmPeerImport(peer, { planId, planHash }));
    } catch (err) {
      respondWithError(res, err);
    }
  });

  app.post(`${base}/push/execute`, async (req, res) => {
    try {
      const principalId = await guard(req, res);
      if (principalId === null) return;

      const { bundleId, confirmationToken } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof bundleId !== "string" || typeof confirmationToken !== "string") {
        res.status(400).json({ error: "'bundleId' and 'confirmationToken' (strings) are required", code: "VALIDATION_ERROR" });
        return;
      }
      const overwriteEntityKeys = readOverwriteEntityKeys(req.body);
      if (overwriteEntityKeys === INVALID_OVERWRITE_KEYS) {
        res.status(400).json({ error: "'overwriteEntityKeys' must be an array of strings", code: "VALIDATION_ERROR" });
        return;
      }
      if (!mayOverwrite(res, overwriteEntityKeys)) return;

      const peer = await openPeer(deps, String(req.params.peerId ?? ""));
      res.json(
        await executePeerImport(peer, {
          bundleId,
          confirmationToken,
          ...(overwriteEntityKeys === null ? {} : { overwriteEntityKeys }),
        })
      );
    } catch (err) {
      respondWithError(res, err);
    }
  });

  app.post(`${base}/pull`, async (req, res) => {
    try {
      const principalId = await guard(req, res);
      if (principalId === null) return;

      const peer = await openPeer(deps, String(req.params.peerId ?? ""));
      const envelope = await pullBundleFromPeer(peer);

      // Blobs BEFORE staging, for the same reason the push driver uploads before it stages: this
      // instance's own `planImport` marks an entity `blocked` when a required blob is absent HERE,
      // so bytes that arrive after the plan would produce a plan that is wrong the moment it is
      // acted on. Bytes are verified against the sha that was requested before they are stored —
      // see `pullBlobsFromPeer`'s own doc; a peer serving mismatched bytes aborts the pull and
      // stages nothing.
      const blobs = await pullBlobsFromPeer(
        {
          ...peer,
          blobSink: deps.blobStore,
          // THIS instance's workspace id: the bytes are being stored locally. The peer's id appears
          // only in the request path, which `peerRoute` builds from the credential.
          workspaceId: deps.workspaceId,
          computeStorageKey: (sha256) => computeBlobStorageKey({ workspaceId: deps.workspaceId, sha256 }),
        },
        { blobManifest: envelope.blobManifest }
      );

      // Staged through the SAME `stageBundle` a pushed bundle arrives by, so `expiresAt` is
      // server-computed and `sourcePrincipalId` is this request's AUTHENTICATED principal — never a
      // peer-declared identity (plan §1.6 / §5 risk #9: baselines key on the authenticated
      // principal, and a pulled bundle must not be able to claim someone else's sync memory).
      const { bundleId, expiresAt } = await stageBundle(
        {
          workspaceId: deps.workspaceId,
          sourcePrincipalId: principalId,
          artifactFormatVersion: envelope.artifactFormatVersion,
          hashVersion: envelope.hashVersion,
          sourceLabel: envelope.sourceLabel,
          entities: envelope.entities as unknown[],
          blobManifest: envelope.blobManifest as string[],
        },
        { repo: deps.publishContentBundleRepo, clock: deps.clock, idGen: deps.idGen }
      );

      res.status(201).json({
        peerId: peer.credential.id,
        peerLabel: peer.credential.label,
        bundleId,
        expiresAt,
        entityCount: envelope.entities.length,
        blobManifest: envelope.blobManifest,
        blobsDownloaded: blobs.downloaded,
        blobsAlreadyPresent: blobs.alreadyPresent,
        // Reported, not thrown: the peer no longer holds these bytes, so whatever entity requires
        // one will be `blocked` by this instance's own plan — the fail-closed outcome, and the
        // mirror of `push/plan`'s `blobsUnavailable`.
        blobsUnavailable: blobs.unavailable,
        // Beyond one pull's blob cap. Nothing is lost — pull again and these are fetched next
        // (`PUBLISH_CONTENT_PULL_MAX_BLOBS`).
        blobsDeferred: blobs.deferredOverCap,
      });
    } catch (err) {
      respondWithError(res, err);
    }
  });
};
