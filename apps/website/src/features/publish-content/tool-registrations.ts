import path from "node:path";

import {
  buildDomainRegistrations,
  indexCatalogById,
  requireInputRecord,
  requireToolPermission,
  type AgentToolSideEffect,
  type DerivedRiskByToolId,
  type ToolHandler,
  type ToolRegistration,
} from "@jini-ai/cms/core";
// `ToolInputError` specifically — the marker `@jini-ai/daemon`'s `ToolExecutor` reads to classify a
// rejection 400 rather than redacting it into a message-stripped 500. Same import, same reason, as
// `features/site-evidence/tool-registrations.ts`.
import { ToolInputError } from "@jini-ai/core";

import type { ToolContributor } from "#src/assistant/index";

import type { AssistantSurfaceDeps } from "../../contracts/core/tool-surface-exchanges.js";
import {
  connectDestination,
  disconnectDestination,
  findCandidateDestination,
  PublishTrustConnectError,
} from "../publish-trust/connect.js";
import { PublishTrustHandshakeError } from "../publish-trust/handshake-client.js";
import {
  COMMITTED_JSON_CODEC,
  createFileProvisioning,
  PUBLISH_TRUST_CONFIG_PATH,
  type PublishTrustProvisioningPort,
} from "../publish-trust/provisioning.js";
import { nodeProvisioningFileIo, resolveCommittedConfigRoot } from "../publish-trust/provisioning.node-io.js";

import {
  publishContentAgentToolCatalog,
  PUBLISH_CONTENT_CONNECT_TOOL_ID,
  PUBLISH_CONTENT_STATUS_TOOL_ID,
  type AgentToolDefinition,
} from "./agent-tools.js";
import { connectAndRecordDestination } from "./connect-destination.js";
// Kept for its TYPE only — `PublishContentToolDeps.publishContentPeerHttpClient`/
// `siteAssistantSecretSealer`/`siteAssistantSecretKeyring` are still declared against
// `resolvePublishDestinationCredential`'s own parameter shape, even though S4 deleted the one runtime
// caller (`openDestination`, with `publish_content_publish`). Pruning the deps interface itself is out
// of this slice's scope.
import { resolvePublishDestinationCredential } from "./destination-credential.js";
import { normalizePeerBaseUrl } from "./peer-url.js";
import { selectConnectedDestination, type PublishContentPeerRecord, type PublishContentPeerRepoPort } from "./peers.js";
import { PUBLISH_CONTENT_APPLY_PERMISSION, PUBLISH_CONTENT_READ_PERMISSION } from "./permissions.js";
import { describePublishReadiness, siteLabelFor, type PublishReadiness } from "./publish-readiness.js";
import type { BeforeSaveHookPort } from "#src/features/post/post";
import type { OutboxPort } from "@jini-ai/cms/core";

import { listPublishContentContributors } from "./type-registry.js";
import type { PublishContentPorts } from "./type-registry.js";

/**
 * @file Wires publishing into the assistant's tool catalog: the two tools that make "is my site set
 * up to publish, and if not, fix it" answerable by an assistant instead of by a person who has to
 * learn what a key is.
 *
 * The catalog and the per-tool reasoning live in `agent-tools.ts`. This file is the wiring: the
 * permission each tool checks and the ports each handler reaches through.
 *
 * ## There is no `publish_content_publish` here
 *
 * `ADS-memory/.local-artifacts/publish-criteria-tool-webmcp-plan-2026-09-24.md` §0 deleted the chat
 * tool that used to hold its own call open for a human's Publish/Not now click through an MCP-UI
 * exchange. Publishing a bundle to a live site now happens exclusively through the admin **Publish
 * dialog** — the only surface that can also be reached by WebMCP, and the only one that already has
 * per-row selection, the re-plan consistency check and the session-only overwrite rule. The chat
 * assistant reaches that same dialog through the `admin.publish_content` capability
 * (`ui/criteria.ts`), which only opens it — it holds no reference to the dialog's confirm/execute
 * path, so nothing here (or in that capability) can cause a write without a person's own click.
 *
 * ## Why the provisioning port is built here
 *
 * The assistant's deps bag is a `RouteDeps` projection and carries no provisioning port — that port
 * is composed in `server/runtime/composition/modules/publish-content.ts` for the HTTP route. A
 * feature may not import `server/**` (`.dependency-cruiser.mjs`'s `feature-no-server-or-framework-
 * imports`), so the default is composed here from the SAME three exported constants that module
 * uses, which is what stops the two drifting on path or format. The field stays optional so a test
 * substitutes a fake — the identical shape `SiteEvidenceToolDeps.siteEvidenceBrowser` already uses.
 */

const publishContentDerivedRisk: DerivedRiskByToolId = new Map<string, AgentToolSideEffect>([
  // -> one peer-table read, one repo-config read. Writes nothing, contacts nothing.
  [PUBLISH_CONTENT_STATUS_TOOL_ID, "none"],
  // -> connectDestination(): one round trip to the destination, then a write to committed config
  //    and one row in this workspace's destination list.
  [PUBLISH_CONTENT_CONNECT_TOOL_ID, "mutates-durable-state"],
]);

const CATALOG_BY_ID = indexCatalogById(publishContentAgentToolCatalog);

/** The fields these two tools need. Everything but the last two is already on `RouteDeps`. */
export interface PublishContentToolDeps {
  workspaceId: string;
  authorize: PublishContentToolAuthorize;
  clock: { nowIso(): string };
  idGen: { newId(): string };
  pluginBeforeSaveHook: BeforeSaveHookPort | undefined;
  outbox: OutboxPort | undefined;
  /** F2 — the same one-bag-per-type ports shape `type-registry.ts` declares, instead of the 7
   *  individually-named repo/store fields this interface used to carry (unused by either handler
   *  in this file today — kept only because this interface intersects into the assistant's wider
   *  `AssistantToolRegistryDeps`, `assistant/tool-registrations.ts:268`). */
  publishContentPorts?: Partial<PublishContentPorts>;
  workspaceRepo: { findById(id: string): Promise<{ name?: string } | null> };
  publishContentPeerRepo: PublishContentPeerRepoPort;
  publishContentPeerHttpClient: Parameters<typeof resolvePublishDestinationCredential>[0]["httpClient"];
  siteAssistantSecretSealer: Parameters<typeof resolvePublishDestinationCredential>[0]["sealer"];
  siteAssistantSecretKeyring: Parameters<typeof resolvePublishDestinationCredential>[0]["keyring"];
  /** Test seam. Absent in production, where the committed-config port is composed below. */
  publishTrustProvisioning?: PublishTrustProvisioningPort;
  /** Test seam. Absent in production, where the repo's own deploy config is read. */
  findPublishCandidate?: () => Promise<string | null>;
}

type PublishContentToolAuthorize = Parameters<typeof requireToolPermission>[0]["authorize"];

/** The real committed-config provisioning port — the same three constants
 *  `server/runtime/composition/modules/publish-content.ts` composes for the HTTP route, resolved
 *  against the same {@link resolveCommittedConfigRoot} so an assistant-tool connect and a dialog
 *  connect never disagree about which file they wrote.
 *  @complexity O(1). */
function defaultProvisioning(): PublishTrustProvisioningPort {
  return createFileProvisioning({
    io: nodeProvisioningFileIo,
    codec: COMMITTED_JSON_CODEC,
    path: path.join(resolveCommittedConfigRoot(), PUBLISH_TRUST_CONFIG_PATH),
  });
}

/** The real deploy-config scan. Repo-relative, therefore resolved against
 *  {@link resolveCommittedConfigRoot} — the same resolution the HTTP route's own `findCandidate`
 *  uses, and NOT the bare process working directory (see that function's own doc for why: own-
 *  server mode's cwd is wherever opened Electron, not the repo root).
 *  @complexity O(1) plus up to four file reads. */
function defaultFindCandidate(): Promise<string | null> {
  const repoRoot = resolveCommittedConfigRoot();
  return findCandidateDestination({ io: nodeProvisioningFileIo, resolvePath: (relative) => path.join(repoRoot, relative) });
}

/** Matches a bare identifier-shaped token — `PEER_NOT_FOUND`, `publish_trust_export_not_wired`,
 *  `EGRESS_REFUSED`. Anchored on word boundaries so ordinary prose and a capitalised site name are
 *  untouched. */
const MACHINE_TOKEN = /\b(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z0-9]+(?:_[a-z0-9]+)+)\b/;

/**
 * Returns `text` only if a person could read it, and `fallback` otherwise.
 *
 * Several errors these handlers catch carry messages that were written for a person — and several
 * carry, or interpolate, a machine code. Review cannot keep that straight for every future error
 * added upstream, so the sentence a person sees passes through one filter that can. The filter is
 * deliberately blunt: a message with an underscore-joined identifier anywhere in it is discarded
 * whole rather than patched, because a half-scrubbed sentence reads worse than the plain one.
 *
 * @complexity O(n) in the message length.
 */
export function plainSentence(text: string, fallback: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || MACHINE_TOKEN.test(trimmed)) return fallback;
  return trimmed;
}

/** The live site this computer publishes to, if there is exactly one obvious answer.
 *
 *  A row with no stored secret is one this computer CONNECTED to; a row with one was configured by
 *  hand. The connected row wins when both exist, because it is the one the zero-setup flow made and
 *  the one a person will have meant.
 *  @complexity O(n) in the workspace's destination count. */
function chooseDestination(rows: readonly PublishContentPeerRecord[]): PublishContentPeerRecord | null {
  const connected = selectConnectedDestination(rows);
  if (connected) return connected;
  return rows.length === 1 ? (rows[0] as PublishContentPeerRecord) : null;
}

/** Reads this install's publish readiness — the shared first step of both handlers.
 *  @complexity O(n) in the workspace's destination count. */
async function readReadiness(
  deps: PublishContentToolDeps,
  findCandidate: () => Promise<string | null>
): Promise<{ readiness: PublishReadiness; rows: readonly PublishContentPeerRecord[] }> {
  const rows = await deps.publishContentPeerRepo.listByWorkspace({ workspaceId: deps.workspaceId });
  const connected = selectConnectedDestination(rows);
  const readiness = describePublishReadiness({
    connectedSiteLabel: connected ? connected.label : null,
    otherSiteLabels: rows.filter((row) => row.sealed !== null).map((row) => row.label),
    // Only consulted when nothing is connected, so the file read is skipped in the common case.
    candidateUrl: connected || rows.length > 0 ? null : await findCandidate(),
    publishableTypeCount: listPublishContentContributors().length,
  });
  return { readiness, rows };
}

export function buildPublishContentRegistrations(
  routeDeps: PublishContentToolDeps,
  surfaces: AssistantSurfaceDeps
): ToolRegistration[] {
  const findCandidate = routeDeps.findPublishCandidate ?? defaultFindCandidate;
  const provisioning = routeDeps.publishTrustProvisioning ?? defaultProvisioning();

  const handlers: Record<string, ToolHandler> = {
    [PUBLISH_CONTENT_STATUS_TOOL_ID]: async (ctx) => {
      await requireToolPermission(routeDeps, {
        principalId: ctx.principal.id,
        permission: PUBLISH_CONTENT_READ_PERMISSION,
      });
      const { readiness } = await readReadiness(routeDeps, findCandidate);
      return readiness;
    },

    [PUBLISH_CONTENT_CONNECT_TOOL_ID]: async (ctx) => {
      const input = requireInputRecord(ctx.input);
      await requireToolPermission(routeDeps, {
        principalId: ctx.principal.id,
        permission: PUBLISH_CONTENT_APPLY_PERMISSION,
      });

      const supplied = input.siteUrl;
      if (supplied !== undefined && typeof supplied !== "string") {
        throw new ToolInputError("'siteUrl' must be a website address as a string when provided");
      }
      const raw = typeof supplied === "string" && supplied.trim() !== "" ? supplied : await findCandidate();
      if (raw === null) {
        // The never-deployed install. An ordinary empty state, reported as a result rather than
        // thrown, so the model can relay the sentence instead of a failure.
        return {
          connected: false,
          message: "There is no live site to publish to yet.",
          nextStep: "Put this site online once, then come back and connect this computer to it.",
        };
      }

      const normalized = normalizePeerBaseUrl(raw);
      if ("error" in normalized) {
        return { connected: false, message: "That does not look like a website address.", nextStep: null };
      }

      // What this computer may publish is its OWN registered types, never a list anyone chooses.
      // An empty grant can do nothing, so an install with nothing publishable is refused here
      // rather than connected into something that would silently publish nothing.
      const entityTypes = listPublishContentContributors().map((contributor) => contributor.entityType);
      if (entityTypes.length === 0) {
        return {
          connected: false,
          message: "There is nothing on this site that can be copied to a live site yet.",
          nextStep: "Add something to this site first, then come back.",
        };
      }

      try {
        const trustDeps = {
          httpClient: routeDeps.publishContentPeerHttpClient,
          keyring: routeDeps.siteAssistantSecretKeyring,
          provisioning,
          clock: routeDeps.clock,
          workspaceId: routeDeps.workspaceId,
        };
        const { site, grant } = await connectAndRecordDestination(
          {
            repo: routeDeps.publishContentPeerRepo,
            clock: routeDeps.clock,
            idGen: routeDeps.idGen,
            connectGrant: (connectInput) => connectDestination(trustDeps, connectInput),
            reverseGrant: () => disconnectDestination(trustDeps),
          },
          { workspaceId: routeDeps.workspaceId, baseUrl: normalized.baseUrl, entityTypes }
        );

        return {
          connected: true,
          message: `This computer publishes to ${site.label}.`,
          nextStep: plainSentence(grant.nextStep, "Put this site online once more for the change to take effect."),
        };
      } catch (err) {
        if (err instanceof PublishTrustHandshakeError) {
          return {
            connected: false,
            message: plainSentence(
              err.message,
              `${siteLabelFor(normalized.baseUrl)} could not be reached, or it is not a site this can publish to.`
            ),
            nextStep: "Check the address and that the site is online, then try connecting again.",
          };
        }
        if (err instanceof PublishTrustConnectError) {
          return {
            connected: false,
            message: "This site's publishing settings could not be saved on this computer.",
            nextStep: "Check that this project's files can be written to, then try connecting again.",
          };
        }
        throw err;
      }
    },
  };

  return buildDomainRegistrations({
    domain: "publish-content",
    catalogModule: "features/publish-content/agent-tools.ts",
    catalog: CATALOG_BY_ID as ReadonlyMap<string, AgentToolDefinition>,
    handlers,
    derivedRisk: publishContentDerivedRisk,
  });
}

export { publishContentDerivedRisk };

/**
 * Contributes the two publishing tools to the assistant's catalog — called once by
 * `server/runtime/composition/tool-catalog-manifest.ts`'s `installFirstPartyToolContributors()`.
 */
export function contributePublishContentTools(): ToolContributor {
  return { domain: "publish-content", build: buildPublishContentRegistrations, risk: publishContentDerivedRisk };
}
