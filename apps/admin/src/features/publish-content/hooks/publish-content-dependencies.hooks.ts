import type {
  PublishContentConfirmResult,
  PublishContentExecuteResult,
  PublishContentPeerSummary,
  PublishContentPlanResult,
  PublishContentReport,
  PublishScope,
} from "@tovu/publish-content-ui";

import { api, type AdminPublishDestinationView } from "@/lib/api";

import type { PublishContentPort } from "./publish-content-port.hooks";

/**
 * @file The only place under `features/publish-content` that reaches `lib/api` for publishing — see
 * `publish-content-port.hooks.ts` for why the split exists.
 */

/** The live implementation, as a module-level singleton. Each method wraps its `api` counterpart
 *  explicitly rather than pointing at it directly, matching `dashboard-dependencies.hooks.ts`'s own
 *  reasoning — a route's own parameter shape stays `lib/api.ts`'s to own. */
export const defaultPublishContentPort: PublishContentPort = {
  listPeers: () => api.listPublishContentPeers(),
  getDestination: () => api.getPublishDestination(),
  connectDestination: (input) => api.connectPublishDestination(input),
  planPublish: (input) => api.planPublishContent(input),
  confirmPublish: (input) => api.confirmPublishContent(input),
  executePublish: (input) => api.executePublishContent(input),
};

/** Seed state for {@link createFakePublishContentPort}. Every stage can be made to fail
 *  independently, because the three stages fail for genuinely different reasons in production —
 *  `plan` on a `PLAN_STALE`/network error, `confirm` on a permission or an expired token, `execute`
 *  on `RESTORE_POINT_UNAVAILABLE` — and the dialog owes the operator a different sentence for each. */
export interface FakePublishContentPortOptions {
  peers?: readonly PublishContentPeerSummary[];
  report?: PublishContentReport;
  planId?: string;
  planHash?: string;
  bundleId?: string;
  confirmationToken?: string;
  executeResult?: PublishContentExecuteResult;
  listPeersError?: Error;
  planError?: Error;
  confirmError?: Error;
  executeError?: Error;
  /** What `getDestination()` returns when the caller doesn't override it. Defaults to the honest
   *  floor — a fresh install with no deploy config yet — so a test that only sets `peers: []` still
   *  gets a real (not-yet-connectable) response rather than an undefined one. */
  destination?: AdminPublishDestinationView;
  destinationError?: Error;
  /** What `connectDestination()` returns on success. Defaults to a connected single-peer result
   *  derived from `destination.candidateUrl`, matching what the real route returns on `201`. */
  connectResult?: AdminPublishDestinationView;
  connectError?: Error;
  /** publish-overwrite-live-plan §4/S9 — what `planPublish` echoes as `liveCanOverwrite`. Defaults to
   *  `true`, the honest floor for a fake that otherwise has no peer-capability concept at all; a test
   *  for the older-live case sets this to `false`. */
  liveCanOverwrite?: boolean;
  /** What `planPublish` echoes as `notSupportedByLive` — the types an older live can't take yet.
   *  Omitted from the result when not set, same as a live that took everything. */
  notSupportedByLive?: PublishContentPlanResult["notSupportedByLive"];
}

/** The honest-floor default {@link FakePublishContentPortOptions.destination} — mirrors
 *  `destination.ts`'s own `GET` response for a fresh install that has never deployed. */
const DEFAULT_DESTINATION: AdminPublishDestinationView = {
  connected: false,
  site: null,
  candidateUrl: null,
  message: "No live site is set up yet. Deploy this site once, then come back here.",
  nextStep: null,
};

/** What {@link createFakePublishContentPort} recorded, so a test can assert on what was NOT called —
 *  which is the whole point for `executePublish` (plan §4 task 11: the dialog cannot fire execute
 *  without a confirmed plan). */
export interface FakePublishContentPortCalls {
  readonly listPeers: number;
  readonly getDestination: number;
  readonly connectDestination: Array<{ siteUrl?: string }>;
  readonly planPublish: Array<{
    peerId: string;
    selectedEntityKeys?: readonly string[];
    overwriteEntityKeys?: readonly string[];
    scope?: PublishScope;
  }>;
  readonly confirmPublish: Array<{ peerId: string; planId: string; planHash: string }>;
  readonly executePublish: Array<{ peerId: string; bundleId: string; confirmationToken: string; overwriteEntityKeys?: readonly string[] }>;
}

/**
 * An in-memory {@link PublishContentPort} for tests — "every port gets a fake" (see
 * `dashboard-dependencies.hooks.ts`). Also the reason this dialog could be built and tested against
 * the frozen route contract while Task 10 was still writing the routes themselves.
 *
 * @complexity O(1) per call; the recorded call log grows with the number of calls made.
 */
export function createFakePublishContentPort(
  options: FakePublishContentPortOptions = {}
): PublishContentPort & { readonly calls: FakePublishContentPortCalls } {
  const calls: FakePublishContentPortCalls = {
    listPeers: 0,
    getDestination: 0,
    connectDestination: [],
    planPublish: [],
    confirmPublish: [],
    executePublish: [],
  };

  return {
    calls,
    async listPeers() {
      (calls as { listPeers: number }).listPeers += 1;
      if (options.listPeersError) throw options.listPeersError;
      return { peers: options.peers ?? [] };
    },
    async getDestination(): Promise<AdminPublishDestinationView> {
      (calls as { getDestination: number }).getDestination += 1;
      if (options.destinationError) throw options.destinationError;
      return options.destination ?? DEFAULT_DESTINATION;
    },
    async connectDestination(input = {}): Promise<AdminPublishDestinationView> {
      calls.connectDestination.push(input);
      if (options.connectError) throw options.connectError;
      if (options.connectResult) return options.connectResult;
      // Default success shape: connects to whatever candidate `destination` (or its own default)
      // offered, as one peer — matching the real route's `201` response.
      const candidateUrl = options.destination?.candidateUrl ?? DEFAULT_DESTINATION.candidateUrl;
      const baseUrl = input.siteUrl ?? candidateUrl ?? "https://example.test";
      const site: PublishContentPeerSummary = {
        id: "peer-connected",
        label: new URL(baseUrl).host,
        baseUrl,
        remoteWorkspaceId: "workspace-local",
        masked: null,
        hasCredential: false,
      };
      return { connected: true, site, candidateUrl: null, message: `This computer publishes to ${site.label}.`, nextStep: null };
    },
    async planPublish(input): Promise<PublishContentPlanResult> {
      calls.planPublish.push(input);
      if (options.planError) throw options.planError;
      const report = options.report ?? { refused: false, refusalReason: null, applyOrder: [], rows: [] };
      const liveCanOverwrite = options.liveCanOverwrite ?? true;

      // A narrowed push stages a DIFFERENT bundle and therefore gets a different plan back — the
      // real route returns a fresh `bundleId` from `pushBundleToPeer` every call, and the peer plans
      // only what it was actually given (`export-bundle.ts`'s `selectBundleEntities`). Modelled here
      // so a test can tell the plans apart and prove which one execute redeemed.
      let rows = report.rows;
      let idSuffix = "";
      // `plan-publish-sections-2026-09-25.md` §1 — scope narrows FIRST, mirroring the real route's
      // own order (`peer-transport.ts`: `scoped = applyPublishScope(fullBundle, scope)`, then
      // `selectBundleEntities` on top of that). AND, not OR, when both `entityTypes` and `entityKeys`
      // are given — same contract `applyPublishScope` documents.
      if (input.scope !== undefined) {
        const { entityTypes, entityKeys } = input.scope;
        const types = entityTypes === undefined ? null : new Set(entityTypes);
        const keys = entityKeys !== undefined && entityKeys.length > 0 ? new Set(entityKeys) : null;
        rows = rows.filter((row) => {
          if (types !== null && !types.has(row.entityType)) return false;
          if (keys !== null && !keys.has(`${row.entityType}:${row.entityId}`)) return false;
          return true;
        });
        idSuffix += "-scoped";
      }
      if (input.selectedEntityKeys !== undefined) {
        const selected = new Set(input.selectedEntityKeys);
        rows = rows.filter((row) => selected.has(`${row.entityType}:${row.entityId}`));
        idSuffix += "-narrowed";
      }
      // publish-overwrite-live-plan §4/S9 — a row named in `overwriteEntityKeys` comes back `forced`,
      // the same outcome a real peer's planner gives a resolvable slug clash or conflict once the
      // operator ticks it, so the fake exercises the same "ticking turns a skipped row into a
      // publishable one" path the dialog and hook actually depend on.
      if (input.overwriteEntityKeys !== undefined && input.overwriteEntityKeys.length > 0) {
        const overwrite = new Set(input.overwriteEntityKeys);
        rows = rows.map((row) =>
          overwrite.has(`${row.entityType}:${row.entityId}`) ? { ...row, outcome: "forced" as const, writes: true } : row
        );
        idSuffix += "-overwrite";
      }

      return {
        planId: `${options.planId ?? "fake-plan"}${idSuffix}`,
        planHash: `${options.planHash ?? "fake-plan-hash"}${idSuffix}`,
        bundleId: `${options.bundleId ?? "fake-bundle"}${idSuffix}`,
        details: idSuffix === "" ? report : { ...report, rows },
        liveCanOverwrite,
        ...(options.notSupportedByLive === undefined ? {} : { notSupportedByLive: options.notSupportedByLive }),
        ...(input.overwriteEntityKeys === undefined ? {} : { overwriteEntityKeys: input.overwriteEntityKeys }),
      };
    },
    async confirmPublish(input): Promise<PublishContentConfirmResult> {
      calls.confirmPublish.push(input);
      if (options.confirmError) throw options.confirmError;
      return { confirmationToken: options.confirmationToken ?? "fake-token" };
    },
    async executePublish(input): Promise<PublishContentExecuteResult> {
      calls.executePublish.push(input);
      if (options.executeError) throw options.executeError;
      return options.executeResult ?? { restorePointId: "fake-restore-point", runId: "fake-run", changeSetIds: ["fake-change-set"] };
    },
  };
}
