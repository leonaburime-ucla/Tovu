import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryOutbox } from "#src/contracts/core/events/index";
import { createVerifiedOrigin, InMemoryOriginSettingRepo, OriginRegistry } from "#src/features/origin/index";
import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import type { PackedEntity, PublishContentDeps } from "#src/features/publish-content/type-registry";

import { redirectMatcher } from "../matcher.js";
import type { RedirectDbHandle } from "../ports.internal.js";
import { contributeRedirectPublish } from "../publish-content.js";
import { createRedirect, tombstoneRedirect, type RedirectsWriteDeps } from "../redirects.js";
import { InMemoryRedirectRepo } from "../repo.memory.js";
import { isNeverInTrash, removeVia, restoreVia } from "./remove-redirect-double.js";

/**
 * @file S2 (`redirect` publish type) — `features/redirects/publish-content.ts`. Mirrors
 * `redirects.test.ts`'s own `makeDeps()` fixture exactly (same real `redirectMatcher`, real
 * `OriginRegistry`, `InMemoryOutbox`, `removeVia`) rather than a second, drifting fake write-deps
 * builder, so this file's `precheck()`/`apply()` assertions exercise the SAME validation rules the
 * write chokepoint itself runs.
 */

const WORKSPACE_ID = "workspace-1";
const ACTOR_ID = "user-1";

function makeWriteDeps(opts: { redirectAllowlist?: string[] } = {}): RedirectsWriteDeps {
  const repo = new InMemoryRedirectRepo();
  const originRepo = new InMemoryOriginSettingRepo([
    {
      workspaceId: WORKSPACE_ID,
      origin: createVerifiedOrigin({
        scheme: "https",
        host: "trusted.example",
        verifiedAt: "2026-07-13T00:00:00.000Z",
        source: "workspace-setting",
      }),
      redirectAllowlist: opts.redirectAllowlist ?? [],
    },
  ]);
  let clockTick = 0;
  let idTick = 0;
  return {
    repo,
    remove: removeVia(repo as unknown as Parameters<typeof removeVia>[0]),
    isInTrash: isNeverInTrash,
    restore: restoreVia(repo as unknown as Parameters<typeof removeVia>[0]),
    db: repo as unknown as RedirectDbHandle,
    transaction: async (fn) => fn(),
    matcher: redirectMatcher,
    originRegistry: new OriginRegistry({ repo: originRepo }),
    clock: { nowIso: () => `2026-09-24T00:00:${String(clockTick++).padStart(2, "0")}.000Z` },
    idGen: { newId: () => `redirect-${++idTick}` },
    outbox: new InMemoryOutbox(),
  };
}

function makePublishDeps(redirectsWriteDeps?: RedirectsWriteDeps): PublishContentDeps {
  return {
    workspaceId: WORKSPACE_ID,
    clock: { nowIso: () => "2026-09-24T00:00:00.000Z" },
    idGen: { newId: () => "unused-in-these-tests" },
    ports: redirectsWriteDeps === undefined ? {} : { redirect: redirectsWriteDeps },
  };
}

/** A minimal, otherwise-valid `PackedEntity` — every test overrides only what it cares about. */
function packedEntity(id: string, state: Record<string, unknown>): PackedEntity {
  return { entityType: "redirect", id, schemaVersion: 1, contentHash: "unused-in-these-tests", hashVersion: 1, requiredBlobs: [], state };
}

// ---------------------------------------------------------------------------
// pack()
// ---------------------------------------------------------------------------

test("pack() yields nothing when redirectsWriteDeps is absent", async () => {
  const handler = contributeRedirectPublish().build(makePublishDeps(undefined));
  const entities: PackedEntity[] = [];
  for await (const entity of handler.pack()) entities.push(entity);
  assert.deepEqual(entities, []);
});

test("pack() skips a disabled (tombstoned) row and packs an active one, keyed by natural key", async () => {
  const writeDeps = makeWriteDeps();
  await createRedirect({
    deps: writeDeps,
    input: { workspaceId: WORKSPACE_ID, matchType: "exact", fromPattern: "/live", toTarget: "/new-live", statusCode: 301, actorId: ACTOR_ID },
  });
  const { record: disabledSeed } = await createRedirect({
    deps: writeDeps,
    input: { workspaceId: WORKSPACE_ID, matchType: "exact", fromPattern: "/gone", toTarget: "/new-gone", statusCode: 301, actorId: ACTOR_ID },
  });
  await tombstoneRedirect({ deps: writeDeps, input: { workspaceId: WORKSPACE_ID, id: disabledSeed.id, actorId: ACTOR_ID } });

  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));
  const entities: PackedEntity[] = [];
  for await (const entity of handler.pack()) entities.push(entity);

  assert.deepEqual(
    entities.map((e) => e.id),
    ["exact:/live"]
  );
  assert.equal(entities[0].state.fromPattern, "/live");
});

test("pack() packs a plain-English title so the Publish dialog never falls back to a short id", async () => {
  // planner.ts's `entityDisplayLabel` only reads `slug`/`title`/`name`/`filename` off packed state,
  // and no `RedirectRecord` field is named any of those — without a `title` here, the dialog fell
  // back to `entityId.slice(0, 8)`, and a redirect's natural key (`"exact:/old-promo"`) truncated to
  // an unreadable `"exact:/o"` (owner report, 2026-09-25).
  const writeDeps = makeWriteDeps();
  await createRedirect({
    deps: writeDeps,
    input: { workspaceId: WORKSPACE_ID, matchType: "exact", fromPattern: "/old-promo", toTarget: "/new-promo", statusCode: 301, actorId: ACTOR_ID },
  });
  await createRedirect({
    deps: writeDeps,
    input: { workspaceId: WORKSPACE_ID, matchType: "prefix", fromPattern: "/blog", toTarget: "/posts", statusCode: 301, actorId: ACTOR_ID },
  });

  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));
  const entities: PackedEntity[] = [];
  for await (const entity of handler.pack()) entities.push(entity);
  const titleByFromPattern = new Map(entities.map((e) => [e.state.fromPattern, e.state.title]));

  assert.equal(titleByFromPattern.get("/old-promo"), "/old-promo → /new-promo");
  assert.equal(titleByFromPattern.get("/blog"), "starts with /blog → /posts");
});

// ---------------------------------------------------------------------------
// inspect() — natural-key resolution (S2 design: the packed id is NEVER the per-install row id)
// ---------------------------------------------------------------------------

test("inspect() resolves an existing destination row by natural key, not by the per-install row id", async () => {
  const writeDeps = makeWriteDeps();
  const { record } = await createRedirect({
    deps: writeDeps,
    input: { workspaceId: WORKSPACE_ID, matchType: "exact", fromPattern: "/old-docs", toTarget: "/new-docs", statusCode: 301, actorId: ACTOR_ID },
  });
  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));

  const naturalKeyId = "exact:/old-docs";
  assert.notEqual(naturalKeyId, record.id, "the natural key must not collide with the minted row id");

  const result = await handler.inspect(naturalKeyId);
  assert.ok(result);
  assert.equal(result?.version, record.version);
});

test("inspect() returns null for a malformed id, a missing row, or an absent redirectsWriteDeps", async () => {
  const writeDeps = makeWriteDeps();
  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));
  assert.equal(await handler.inspect("no-colon-in-this-id"), null);
  assert.equal(await handler.inspect("exact:/does-not-exist"), null);

  const noDepsHandler = contributeRedirectPublish().build(makePublishDeps(undefined));
  assert.equal(await noDepsHandler.inspect("exact:/whatever"), null);
});

// ---------------------------------------------------------------------------
// precheck()
// ---------------------------------------------------------------------------

test("precheck() rejects a loop with the exact chokepoint message text", async () => {
  const writeDeps = makeWriteDeps();
  await createRedirect({
    deps: writeDeps,
    input: { workspaceId: WORKSPACE_ID, matchType: "exact", fromPattern: "/a", toTarget: "/b", statusCode: 301, actorId: ACTOR_ID },
  });
  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));

  const reason = await handler.precheck(
    packedEntity("exact:/b", { matchType: "exact", fromPattern: "/b", toTarget: "/a", statusCode: 301, status: "active", override: false, priority: 0 })
  );

  assert.equal(reason, "redirect from '/b' would create a cycle via '/a' (resolves back to '/b')");
});

test("precheck() reports a message rather than throwing when redirectsWriteDeps is absent", async () => {
  const handler = contributeRedirectPublish().build(makePublishDeps(undefined));
  const reason = await handler.precheck(packedEntity("exact:/x", {}));
  assert.match(reason ?? "", /no redirect port wired/);
});

// ---------------------------------------------------------------------------
// apply()
// ---------------------------------------------------------------------------

test("apply() creates a new redirect via createRedirect and carries override (D3: a published redirect must win over a live page)", async () => {
  const writeDeps = makeWriteDeps();
  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));

  const { changeSetId } = await handler.apply({
    entity: packedEntity("exact:/folded-stub", {
      matchType: "exact",
      fromPattern: "/folded-stub",
      toTarget: "/new-home",
      statusCode: 301,
      status: "active",
      override: true,
      priority: 0,
    }),
    expectedVersion: undefined,
    principalId: "operator-1",
    idempotencyKey: "idem-1",
  });

  assert.ok(changeSetId);
  const landed = await writeDeps.repo.findById({ workspaceId: WORKSPACE_ID, id: changeSetId });
  assert.equal(landed?.fromPattern, "/folded-stub");
  assert.equal(landed?.override, true, "override must carry through so the redirect wins over an existing live page (D3)");
  assert.equal(landed?.source, "import");
});

test("apply() updates an existing destination row, re-resolved by natural key", async () => {
  const writeDeps = makeWriteDeps();
  const { record: seed } = await createRedirect({
    deps: writeDeps,
    input: { workspaceId: WORKSPACE_ID, matchType: "exact", fromPattern: "/old-docs", toTarget: "/new-docs", statusCode: 301, actorId: ACTOR_ID },
  });
  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));

  const { changeSetId } = await handler.apply({
    entity: packedEntity("exact:/old-docs", {
      matchType: "exact",
      fromPattern: "/old-docs",
      toTarget: "/newer-docs",
      statusCode: 301,
      status: "active",
      override: false,
      priority: 5,
    }),
    expectedVersion: seed.version,
    principalId: "operator-1",
    idempotencyKey: "idem-2",
  });

  assert.equal(changeSetId, seed.id);
  const landed = await writeDeps.repo.findById({ workspaceId: WORKSPACE_ID, id: seed.id });
  assert.equal(landed?.toTarget, "/newer-docs");
  assert.equal(landed?.priority, 5);
  assert.equal(landed?.version, seed.version + 1);
});

test("apply() throws loudly (not a row downgrade) when redirectsWriteDeps is absent", async () => {
  const handler = contributeRedirectPublish().build(makePublishDeps(undefined));
  await assert.rejects(
    () =>
      handler.apply({
        entity: packedEntity("exact:/x", {}),
        expectedVersion: undefined,
        principalId: "operator-1",
        idempotencyKey: "idem-3",
      }),
    /requires PublishContentDeps\.ports\.redirect/
  );
});

test("apply() downgrades a refused write (disallowed target) to a blocked row instead of aborting the run", async () => {
  const writeDeps = makeWriteDeps(); // empty allowlist -> an off-site absolute target is refused
  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));

  await assert.rejects(
    () =>
      handler.apply({
        entity: packedEntity("exact:/blocked", {
          matchType: "exact",
          fromPattern: "/blocked",
          toTarget: "https://not-allowed.example/x",
          statusCode: 301,
          status: "active",
          override: false,
          priority: 0,
        }),
        expectedVersion: undefined,
        principalId: "operator-1",
        idempotencyKey: "idem-4",
      }),
    (err: unknown) => err instanceof PublishContentApplyRowError && err.rowOutcome === "blocked"
  );
});

test("apply() reports a conflict when the destination row disappeared between plan and apply", async () => {
  const writeDeps = makeWriteDeps();
  const handler = contributeRedirectPublish().build(makePublishDeps(writeDeps));

  await assert.rejects(
    () =>
      handler.apply({
        entity: packedEntity("exact:/never-existed", {
          matchType: "exact",
          fromPattern: "/never-existed",
          toTarget: "/x",
          statusCode: 301,
          status: "active",
          override: false,
          priority: 0,
        }),
        expectedVersion: 1,
        principalId: "operator-1",
        idempotencyKey: "idem-5",
      }),
    (err: unknown) => err instanceof PublishContentApplyRowError && err.rowOutcome === "conflict"
  );
});
