import assert from "node:assert/strict";
import test from "node:test";

import type { ToolExecutionContext, ToolRegistration } from "@jini-ai/core";

import type { AssistantSurfaceDeps } from "../../../contracts/core/tool-surface-exchanges.js";
import { publishContentAgentToolCatalog, PUBLISH_CONTENT_CONNECT_TOOL_ID, PUBLISH_CONTENT_STATUS_TOOL_ID } from "../agent-tools.js";
import type { PublishContentPeerRecord } from "../peers.js";
import { describePublishReadiness, siteLabelFor } from "../publish-readiness.js";
import { buildPublishContentRegistrations, plainSentence, type PublishContentToolDeps } from "../tool-registrations.js";
import { registerPublishContentContributor, resetPublishContentContributorsForTests } from "../type-registry.js";

/**
 * @file The publishing tools' certification. Three things are proved here, in this order:
 *
 * 1. **Reachability, through the REAL composition manifest** — not "a registration object was
 *    built", but "`installFirstPartyToolContributors()`, the function both real boot paths call,
 *    puts these two ids in the catalog the daemon serves". This repo's dominant defect is a
 *    correct primitive with an unwired call site, and a tool nobody surfaces is exactly that.
 * 2. **The verdict**, over all four situations a source install can be in.
 * 3. **The vocabulary rule** — no sentence either of these tools can produce teaches a concept, and
 *    no machine token can reach a person. Asserted over every reachable string rather than
 *    spot-checked, mirroring `publish-trust/__tests__/provisioning.test.ts`'s identical guard.
 *
 * A publish tool and its confirmation dialog used to be certified here too. Both were deleted —
 * `ADS-memory/.local-artifacts/publish-criteria-tool-webmcp-plan-2026-09-24.md` §4 S4 — in favour of
 * the admin Publish dialog, the one surface that can also be reached by WebMCP. See
 * `tool-registrations.ts`'s header for the full reasoning.
 */

const WORKSPACE_ID = "ws-publish-tools";
const PRINCIPAL_ID = "principal-under-test";

/** Vocabulary this surface may never teach. Each is a real word from the machinery underneath. */
const FORBIDDEN_WORDS = [
  "key", "token", "grant", "principal", "capability", "credential", "workspace id",
  "installation", "generation", "peer", "bundle", "entity", "provision", "hkdf", "ed25519",
];

/** An identifier-shaped token — `PEER_NOT_FOUND`, `publish_trust_export_not_wired`. */
const MACHINE_TOKEN = /\b(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[a-z0-9]+(?:_[a-z0-9]+)+)\b/;

function assertReadableByAPerson(sentence: string, where: string): void {
  assert.equal(MACHINE_TOKEN.test(sentence), false, `${where} leaks a machine token: ${sentence}`);
  const lowered = sentence.toLowerCase();
  for (const word of FORBIDDEN_WORDS) {
    assert.equal(lowered.includes(word), false, `${where} names '${word}': ${sentence}`);
  }
}

/** A deps bag with only what the read paths touch. The write path is exercised through its own
 *  ports elsewhere; what is certified here is the decision, the wording and the refusals. */
function toolDeps(overrides: Partial<PublishContentToolDeps> = {}): PublishContentToolDeps {
  const rows: PublishContentPeerRecord[] = [];
  return {
    workspaceId: WORKSPACE_ID,
    authorize: async () => ({ allowed: true }),
    clock: { nowIso: () => "2026-09-19T00:00:00.000Z" },
    idGen: { newId: () => "id-1" },
    pluginBeforeSaveHook: undefined as never,
    outbox: null as never,
    workspaceRepo: { findById: async () => ({ name: "Test Site" }) },
    publishContentPeerRepo: {
      listByWorkspace: async () => rows,
      insert: async () => undefined as never,
      update: async () => undefined as never,
      findById: async () => null,
      delete: async () => undefined,
    } as unknown as PublishContentToolDeps["publishContentPeerRepo"],
    publishContentPeerHttpClient: null as never,
    siteAssistantSecretSealer: null as never,
    siteAssistantSecretKeyring: null as never,
    findPublishCandidate: async () => null,
    publishTrustProvisioning: null as never,
    ...overrides,
  };
}

const NO_SURFACES: AssistantSurfaceDeps = {
  surfaceExchanges: { open: () => { throw new Error("not used in this test"); } },
} as unknown as AssistantSurfaceDeps;

function registrationFor(deps: PublishContentToolDeps, toolId: string): ToolRegistration {
  const found = buildPublishContentRegistrations(deps, NO_SURFACES).find((r) => r.descriptor.id === toolId);
  assert.ok(found, `${toolId} was not built`);
  return found;
}

function execContext(input: unknown, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    executionId: "exec-1",
    principal: { id: PRINCIPAL_ID } as ToolExecutionContext["principal"],
    run: { id: "run-1" },
    input,
    signal: new AbortController().signal,
    ...extra,
  } as ToolExecutionContext;
}

// ---------------------------------------------------------------------------
// 1. Reachability — through the real manifest both boot paths call
// ---------------------------------------------------------------------------

test("the two tools reach the catalog the daemon serves, via the real composition manifest", async () => {
  const { resetToolContributorsForTests, listToolContributors } = await import("../../../assistant/tool-contribution-registry.js");
  const { installFirstPartyToolContributors } = await import("../../../server/runtime/composition/tool-catalog-manifest.js");

  resetToolContributorsForTests();
  // Positive control: nothing is installed until the manifest runs, so a pass below cannot be an
  // artifact of some earlier import having registered these for us.
  assert.equal(listToolContributors().length, 0);

  installFirstPartyToolContributors();

  const contributor = listToolContributors().find((c) => c.domain === "publish-content");
  assert.ok(contributor, "installFirstPartyToolContributors() did not install publish-content");

  const ids = contributor.build(toolDeps() as never, NO_SURFACES).map((r) => r.descriptor.id);
  assert.deepEqual([...ids].sort(), [PUBLISH_CONTENT_CONNECT_TOOL_ID, PUBLISH_CONTENT_STATUS_TOOL_ID].sort());

  // Every wired tool must carry a risk classification, or `assertRiskMetadataIsWirable` refuses the
  // whole catalog at boot — the gate that turns a missing entry into a dead assistant, not a quiet gap.
  for (const id of ids) assert.ok(contributor.risk.has(id), `${id} has no risk classification`);
});

// ---------------------------------------------------------------------------
// 2. The verdict
// ---------------------------------------------------------------------------

test("a connected computer is ready", () => {
  const r = describePublishReadiness({ connectedSiteLabel: "example.com", otherSiteLabels: [], candidateUrl: null, publishableTypeCount: 2 });
  assert.equal(r.ready, true);
  assert.equal(r.verdict, "ready");
  assert.equal(r.summary, "This computer publishes to example.com.");
  assert.equal(r.nextStep, null);
});

test("a hand-configured destination counts as ready too — it is the same capability", () => {
  const r = describePublishReadiness({ connectedSiteLabel: null, otherSiteLabels: ["a.com", "b.com"], candidateUrl: null, publishableTypeCount: 2 });
  assert.equal(r.ready, true);
  assert.equal(r.summary, "This computer publishes to a.com and b.com.");
});

test("a live site exists but this computer was never connected to it", () => {
  const r = describePublishReadiness({ connectedSiteLabel: null, otherSiteLabels: [], candidateUrl: "https://example.com/x", publishableTypeCount: 2 });
  assert.equal(r.ready, false);
  assert.equal(r.verdict, "not-connected");
  assert.match(r.summary, /example\.com/);
  assert.match(r.nextStep ?? "", /^Connect this computer to example\.com/);
});

test("the never-deployed install is an empty state, not a fault", () => {
  const r = describePublishReadiness({ connectedSiteLabel: null, otherSiteLabels: [], candidateUrl: null, publishableTypeCount: 2 });
  assert.equal(r.ready, false);
  assert.equal(r.verdict, "no-live-site");
  assert.equal(r.summary, "There is no live site to publish to yet.");
  assert.ok(r.nextStep);
});

test("nothing publishable is checked BEFORE connectedness — it blocks the thing actually asked about", () => {
  const r = describePublishReadiness({ connectedSiteLabel: "example.com", otherSiteLabels: [], candidateUrl: null, publishableTypeCount: 0 });
  assert.equal(r.ready, false);
  assert.equal(r.verdict, "nothing-publishable");
});

test("siteLabelFor is the host, and an unparseable address does not throw", () => {
  assert.equal(siteLabelFor("https://example.com/a/b"), "example.com");
  assert.equal(siteLabelFor("not a url"), "not a url");
});

// ---------------------------------------------------------------------------
// 3. The vocabulary rule
// ---------------------------------------------------------------------------

test("no verdict this function can produce teaches a concept or leaks a code", () => {
  const cases = [
    { connectedSiteLabel: "example.com", otherSiteLabels: [], candidateUrl: null, publishableTypeCount: 2 },
    { connectedSiteLabel: null, otherSiteLabels: ["a.com"], candidateUrl: null, publishableTypeCount: 2 },
    { connectedSiteLabel: null, otherSiteLabels: [], candidateUrl: "https://example.com", publishableTypeCount: 2 },
    { connectedSiteLabel: null, otherSiteLabels: [], candidateUrl: null, publishableTypeCount: 2 },
    { connectedSiteLabel: null, otherSiteLabels: [], candidateUrl: null, publishableTypeCount: 0 },
  ];
  for (const input of cases) {
    const r = describePublishReadiness(input);
    for (const [field, value] of Object.entries({ summary: r.summary, missing: r.missing, nextStep: r.nextStep })) {
      if (typeof value === "string") assertReadableByAPerson(value, `${r.verdict}.${field}`);
    }
  }
});

test("plainSentence passes a person's sentence through and discards one carrying a machine token", () => {
  assert.equal(plainSentence("The site could not be reached.", "fallback"), "The site could not be reached.");
  assert.equal(plainSentence("refused: PEER_NOT_FOUND", "fallback"), "fallback");
  assert.equal(plainSentence("reason publish_trust_export_not_wired", "fallback"), "fallback");
  assert.equal(plainSentence("   ", "fallback"), "fallback");
  // A capitalised site name is ordinary prose and must survive.
  assert.equal(plainSentence("Example Site is offline.", "fallback"), "Example Site is offline.");
});

// ---------------------------------------------------------------------------
// 4. The two tools themselves
// ---------------------------------------------------------------------------

test("the status tool reads and the connect tool does not claim to be read-only", () => {
  const byId = new Map(publishContentAgentToolCatalog.map((t) => [t.name, t]));
  assert.equal(byId.get(PUBLISH_CONTENT_STATUS_TOOL_ID)?.sideEffects, "none");
  assert.equal(byId.get(PUBLISH_CONTENT_STATUS_TOOL_ID)?.authorization.permission, "publish_content.read");
  assert.equal(byId.get(PUBLISH_CONTENT_CONNECT_TOOL_ID)?.sideEffects, "mutates-durable-state");
  assert.equal(byId.get(PUBLISH_CONTENT_CONNECT_TOOL_ID)?.authorization.permission, "publish_content.apply");
});

test("the status tool answers the never-connected install in plain sentences", async () => {
  resetPublishContentContributorsForTests();
  registerPublishContentContributor({ entityType: "post", dependsOn: [], build: () => null as never });

  const result = (await registrationFor(toolDeps({ findPublishCandidate: async () => "https://example.com" }), PUBLISH_CONTENT_STATUS_TOOL_ID).handler(
    execContext({})
  )) as Record<string, unknown>;

  assert.equal(result.ready, false);
  assert.equal(result.verdict, "not-connected");
  for (const field of ["summary", "missing", "nextStep"]) {
    assertReadableByAPerson(String(result[field]), `status.${field}`);
  }
});

test("connect refuses plainly when there is no live site to connect to, rather than throwing", async () => {
  resetPublishContentContributorsForTests();
  registerPublishContentContributor({ entityType: "post", dependsOn: [], build: () => null as never });

  const result = (await registrationFor(toolDeps(), PUBLISH_CONTENT_CONNECT_TOOL_ID).handler(execContext({}))) as Record<string, unknown>;
  assert.equal(result.connected, false);
  assertReadableByAPerson(String(result.message), "connect.message");
  assertReadableByAPerson(String(result.nextStep), "connect.nextStep");
});

test("connect refuses an address that is not one, without naming a validation rule", async () => {
  resetPublishContentContributorsForTests();
  registerPublishContentContributor({ entityType: "post", dependsOn: [], build: () => null as never });

  const result = (await registrationFor(toolDeps(), PUBLISH_CONTENT_CONNECT_TOOL_ID).handler(
    execContext({ siteUrl: "definitely not a url" })
  )) as Record<string, unknown>;
  assert.equal(result.connected, false);
  assert.equal(result.message, "That does not look like a website address.");
});

test("connect refuses an install with nothing publishable rather than connecting it to nothing", async () => {
  resetPublishContentContributorsForTests();

  const result = (await registrationFor(toolDeps(), PUBLISH_CONTENT_CONNECT_TOOL_ID).handler(
    execContext({ siteUrl: "https://example.com" })
  )) as Record<string, unknown>;
  assert.equal(result.connected, false);
  assertReadableByAPerson(String(result.message), "connect.nothing-publishable");
});
