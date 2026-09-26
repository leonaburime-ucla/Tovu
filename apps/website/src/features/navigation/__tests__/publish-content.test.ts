import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryChangeSetRepo } from "#src/contracts/core/commands/index";
import { InMemoryOutbox } from "#src/contracts/core/events/index";
import type { PackedEntity, PublishContentDeps } from "#src/features/publish-content/type-registry";

import {
  InMemoryMenuRepo,
  InMemoryNavLocationBindingRepo,
  type MenuRepoPort,
  type NavLocationBindingRepoPort,
  type NavMenuEntry,
} from "../index.js";
import { contributeMenusPublish } from "../publish-content.js";

/**
 * @file S3 (`menu` publish type) — `features/navigation/publish-content.ts`. Uses Jini's own
 * `InMemoryMenuRepo`/`InMemoryNavLocationBindingRepo` directly (not the host's trash-aware wrapper),
 * mirroring `redirects/__tests__/publish-content.test.ts`'s "real repo, real chokepoint" convention —
 * these assertions exercise the SAME `importMenuEntity` the write chokepoint itself runs.
 *
 * R3 (`ADS-memory/.local-artifacts/plan-publish-repoint-menus-2026-09-24.md` §3) adds
 * `referencesTo()`/`repointReferences()` coverage below, using the same repos plus a real
 * `InMemoryChangeSetRepo` and an `authorize` stub — the same "real chokepoint" convention `retire()`'s
 * own tests (`features/post/__tests__/publish-content.test.ts`) use for `executeCommand`.
 */

const WORKSPACE_ID = "workspace-1";

function makePublishDeps(input: {
  menuRepo?: MenuRepoPort;
  navLocationBindingRepo?: NavLocationBindingRepoPort;
  clock?: { nowIso(): string };
  idGen?: { newId(): string };
  outbox?: InMemoryOutbox;
}): PublishContentDeps {
  return {
    workspaceId: WORKSPACE_ID,
    clock: input.clock ?? { nowIso: () => "2026-09-24T00:00:00.000Z" },
    idGen: input.idGen ?? { newId: () => "unused-in-these-tests" },
    outbox: input.outbox ?? new InMemoryOutbox(),
    ports: {
      menu:
        input.menuRepo === undefined && input.navLocationBindingRepo === undefined
          ? undefined
          : {
              repo: input.menuRepo as MenuRepoPort,
              bindingRepo: input.navLocationBindingRepo as NavLocationBindingRepoPort,
            },
    },
  };
}

function packedEntity(id: string, state: Record<string, unknown>): PackedEntity {
  return { entityType: "menu", id, schemaVersion: 1, contentHash: "unused-in-these-tests", hashVersion: 1, requiredBlobs: [], state };
}

function menuState(overrides: Partial<Pick<NavMenuEntry, "slug" | "title" | "status" | "doc" | "locations">> = {}) {
  return {
    slug: "primary-nav",
    title: "Primary Nav",
    status: "published",
    doc: { type: "menu", version: 1, items: [] },
    locations: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pack()
// ---------------------------------------------------------------------------

test("pack() yields nothing when menuRepo is absent", async () => {
  const handler = contributeMenusPublish().build(makePublishDeps({}));
  const entities: PackedEntity[] = [];
  for await (const entity of handler.pack()) entities.push(entity);
  assert.deepEqual(entities, []);
});

test("pack() skips a trashed menu and packs a live one, keyed by the menu's own id", async () => {
  const menuRepo = new InMemoryMenuRepo([
    { id: "menu-live", workspaceId: WORKSPACE_ID, ...menuState({ slug: "live-nav" }), updatedAt: "2026-01-01T00:00:00.000Z", version: 1 },
    {
      id: "menu-trashed",
      workspaceId: WORKSPACE_ID,
      ...menuState({ slug: "gone-nav", status: "trash" }),
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    },
  ] as NavMenuEntry[]);
  const handler = contributeMenusPublish().build(makePublishDeps({ menuRepo }));

  const entities: PackedEntity[] = [];
  for await (const entity of handler.pack()) entities.push(entity);

  assert.deepEqual(entities.map((e) => e.id), ["menu-live"]);
  assert.equal(entities[0].state.slug, "live-nav");
});

// ---------------------------------------------------------------------------
// apply() — id-preserving create, OCC update, location displacement, entryRef degrade
// ---------------------------------------------------------------------------

test("apply() creates a new menu under the SOURCE id (never mints its own, unlike createMenu)", async () => {
  const menuRepo = new InMemoryMenuRepo();
  const bindingRepo = new InMemoryNavLocationBindingRepo();
  const handler = contributeMenusPublish().build(
    makePublishDeps({ menuRepo, navLocationBindingRepo: bindingRepo, idGen: { newId: () => "generated-1" } })
  );

  const { changeSetId } = await handler.apply({
    entity: packedEntity("menu-header-nav", menuState({ slug: "header-nav" })),
    expectedVersion: undefined,
    principalId: "operator-1",
    idempotencyKey: "idem-1",
  });

  assert.equal(changeSetId, "menu-header-nav");
  const landed = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header-nav" });
  assert.equal(landed?.id, "menu-header-nav");
  assert.equal(landed?.slug, "header-nav");
  assert.equal(landed?.version, 1);
});

test("apply() updates an existing destination row under OCC, re-resolved by its own id", async () => {
  const menuRepo = new InMemoryMenuRepo([
    { id: "menu-header-nav", workspaceId: WORKSPACE_ID, ...menuState({ slug: "header-nav" }), updatedAt: "2026-01-01T00:00:00.000Z", version: 3 },
  ] as NavMenuEntry[]);
  const bindingRepo = new InMemoryNavLocationBindingRepo();
  const handler = contributeMenusPublish().build(makePublishDeps({ menuRepo, navLocationBindingRepo: bindingRepo }));

  const { changeSetId } = await handler.apply({
    entity: packedEntity("menu-header-nav", menuState({ slug: "header-nav", title: "New Title" })),
    expectedVersion: 3,
    principalId: "operator-1",
    idempotencyKey: "idem-2",
  });

  assert.equal(changeSetId, "menu-header-nav");
  const landed = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header-nav" });
  assert.equal(landed?.title, "New Title");
  assert.equal(landed?.version, 4);
});

test("apply() rebinds a location away from whatever destination menu previously held it (displacement)", async () => {
  const menuRepo = new InMemoryMenuRepo([
    { id: "menu-old-header", workspaceId: WORKSPACE_ID, ...menuState({ slug: "old-header", locations: ["primary"] }), updatedAt: "2026-01-01T00:00:00.000Z", version: 1 },
  ] as NavMenuEntry[]);
  const bindingRepo = new InMemoryNavLocationBindingRepo([
    { workspaceId: WORKSPACE_ID, locationKey: "primary", menuId: "menu-old-header", boundAt: "2026-01-01T00:00:00.000Z" },
  ]);
  const handler = contributeMenusPublish().build(
    makePublishDeps({ menuRepo, navLocationBindingRepo: bindingRepo, idGen: { newId: () => "evt-1" } })
  );

  await handler.apply({
    entity: packedEntity("menu-header-nav", menuState({ slug: "header-nav", locations: ["primary"] })),
    expectedVersion: undefined,
    principalId: "operator-1",
    idempotencyKey: "idem-3",
  });

  const binding = await bindingRepo.findByLocation({ workspaceId: WORKSPACE_ID, locationKey: "primary" });
  assert.equal(binding?.menuId, "menu-header-nav", "the location must now point at the newly-published menu");

  const displaced = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-old-header" });
  assert.deepEqual(displaced?.locations, [], "the displaced menu must lose the location from its own locations field");
  assert.equal(displaced?.version, 2);
});

test("apply() accepts a doc item whose entryRef target does not exist at the destination — no precheck on refs", async () => {
  const menuRepo = new InMemoryMenuRepo();
  const bindingRepo = new InMemoryNavLocationBindingRepo();
  const handler = contributeMenusPublish().build(makePublishDeps({ menuRepo, navLocationBindingRepo: bindingRepo }));

  const doc = {
    type: "menu",
    version: 1,
    items: [{ id: "item-1", label: "Missing Page", target: { kind: "entryRef", entryId: "page-does-not-exist" } }],
  };

  const { changeSetId } = await handler.apply({
    entity: packedEntity("menu-with-dead-ref", menuState({ slug: "dead-ref-nav", doc })),
    expectedVersion: undefined,
    principalId: "operator-1",
    idempotencyKey: "idem-4",
  });

  assert.ok(changeSetId, "applying a menu whose entryRef target is missing must still succeed — resolution degrades at RENDER time, not publish time");
  const landed = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-with-dead-ref" });
  assert.equal(landed?.doc.items[0]?.target.kind, "entryRef");
});

test("apply() round-trip (simulated rollback): publishing the prior record back restores the prior binding owner", async () => {
  const menuRepo = new InMemoryMenuRepo([
    { id: "menu-old-header", workspaceId: WORKSPACE_ID, ...menuState({ slug: "old-header", locations: ["primary"] }), updatedAt: "2026-01-01T00:00:00.000Z", version: 1 },
  ] as NavMenuEntry[]);
  const bindingRepo = new InMemoryNavLocationBindingRepo([
    { workspaceId: WORKSPACE_ID, locationKey: "primary", menuId: "menu-old-header", boundAt: "2026-01-01T00:00:00.000Z" },
  ]);
  const handler = contributeMenusPublish().build(
    makePublishDeps({ menuRepo, navLocationBindingRepo: bindingRepo, idGen: { newId: () => "evt" } })
  );

  // Forward: publish a new menu that takes over "primary" from menu-old-header.
  await handler.apply({
    entity: packedEntity("menu-header-nav", menuState({ slug: "header-nav", locations: ["primary"] })),
    expectedVersion: undefined,
    principalId: "operator-1",
    idempotencyKey: "idem-5",
  });
  assert.equal((await bindingRepo.findByLocation({ workspaceId: WORKSPACE_ID, locationKey: "primary" }))?.menuId, "menu-header-nav");

  // Rollback: re-publish menu-old-header's own prior state (still claiming "primary") — the same
  // shape a restore-point/undo flow would replay.
  await handler.apply({
    entity: packedEntity("menu-old-header", menuState({ slug: "old-header", locations: ["primary"] })),
    expectedVersion: 2, // bumped once already by the displacement above
    principalId: "operator-1",
    idempotencyKey: "idem-6",
  });

  const binding = await bindingRepo.findByLocation({ workspaceId: WORKSPACE_ID, locationKey: "primary" });
  assert.equal(binding?.menuId, "menu-old-header", "restoring the prior record must restore the prior binding owner");
});

// ---------------------------------------------------------------------------
// precheck()
// ---------------------------------------------------------------------------

test("precheck() rejects a slug already held by a different menu", async () => {
  const menuRepo = new InMemoryMenuRepo([
    { id: "menu-other", workspaceId: WORKSPACE_ID, ...menuState({ slug: "header-nav" }), updatedAt: "2026-01-01T00:00:00.000Z", version: 1 },
  ] as NavMenuEntry[]);
  const handler = contributeMenusPublish().build(makePublishDeps({ menuRepo }));

  const reason = await handler.precheck(packedEntity("menu-incoming", menuState({ slug: "header-nav" })));
  assert.match(reason ?? "", /already held by a different menu/);
});

test("precheck() reports the tree validator's own message for an invalid doc", async () => {
  const menuRepo = new InMemoryMenuRepo();
  const handler = contributeMenusPublish().build(makePublishDeps({ menuRepo }));

  const badDoc = { type: "menu", version: 1, items: [{ id: "", label: "Bad", target: { kind: "url", href: "/ok" } }] };
  const reason = await handler.precheck(packedEntity("menu-bad", menuState({ doc: badDoc })));
  assert.equal(reason, "every menu item requires a non-empty id");
});

// ---------------------------------------------------------------------------
// referencesTo() / repointReferences() — R3
// (`ADS-memory/.local-artifacts/plan-publish-repoint-menus-2026-09-24.md` §2.1-§2.4, §3 R3)
// ---------------------------------------------------------------------------

function menuRow(overrides: Partial<NavMenuEntry> & Pick<NavMenuEntry, "id">): NavMenuEntry {
  return {
    workspaceId: WORKSPACE_ID,
    ...menuState(),
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  } as NavMenuEntry;
}

/** Same as {@link makePublishDeps} plus a real `changeSets`/`authorize` — what `repointReferences()`
 *  actually requires (see its own doc). `authorize` always allows unless overridden. */
function makeRepointDeps(input: {
  menuRepo: MenuRepoPort;
  authorize?: PublishContentDeps["authorize"];
}): PublishContentDeps & { changeSets: InMemoryChangeSetRepo } {
  const outbox = new InMemoryOutbox();
  return {
    ...makePublishDeps({ menuRepo: input.menuRepo, outbox }),
    changeSets: new InMemoryChangeSetRepo([], [], outbox),
    authorize: input.authorize ?? (async () => ({ allowed: true, reason: "test-always-allow" })),
  };
}

/**
 * A `MenuRepoPort` wrapper whose `findById` hands back a version one higher on every call after the
 * first — simulating a concurrent edit landing between `repointOneMenu`'s own read (to compute
 * `expectedVersion`) and `updateMenuTree`'s internal re-read inside `execute()`. Used only by the
 * "changed during publish" test below; every other method delegates unchanged.
 */
class VersionRacingMenuRepo implements MenuRepoPort {
  private readonly inner: MenuRepoPort;
  private calls = 0;

  constructor(rows: NavMenuEntry[]) {
    this.inner = new InMemoryMenuRepo(rows);
  }

  async findById(required: { workspaceId: string; id: string }): Promise<NavMenuEntry | null> {
    const row = await this.inner.findById(required);
    if (!row) return row;
    this.calls += 1;
    return { ...row, version: row.version + (this.calls - 1) };
  }

  findBySlug(required: { workspaceId: string; slug: string }) {
    return this.inner.findBySlug(required);
  }

  list(required: { workspaceId: string }) {
    return this.inner.list(required);
  }

  save(record: NavMenuEntry) {
    return this.inner.save(record);
  }

  remove(required: { workspaceId: string; id: string }) {
    return this.inner.remove(required);
  }
}

function entryRefItem(id: string, entryId: string) {
  return { id, label: "About", target: { kind: "entryRef" as const, entryId } };
}

test("referencesTo() finds a menu whose nested entryRef targets one of the given ids", async () => {
  const menuRepo = new InMemoryMenuRepo([
    menuRow({
      id: "menu-header",
      ...menuState({
        title: "Header",
        doc: {
          type: "menu",
          version: 1,
          items: [
            { id: "item-1", label: "Company", target: { kind: "url", href: "/contact" }, children: [entryRefItem("item-1a", "post-about")] },
          ],
        },
      }),
    }),
  ]);
  const handler = contributeMenusPublish().build(makePublishDeps({ menuRepo }));

  const holders = await handler.referencesTo!(["post-about"]);

  assert.deepEqual(holders, [{ entityType: "menu", entityId: "menu-header", entityLabel: "Header", referencedId: "post-about" }]);
});

test("referencesTo() finds nothing for a menu whose only item is a url target", async () => {
  const menuRepo = new InMemoryMenuRepo([
    menuRow({
      id: "menu-footer",
      ...menuState({ title: "Footer", doc: { type: "menu", version: 1, items: [{ id: "item-1", label: "Contact", target: { kind: "url", href: "/contact" } }] } }),
    }),
  ]);
  const handler = contributeMenusPublish().build(makePublishDeps({ menuRepo }));

  const holders = await handler.referencesTo!(["post-about"]);
  assert.deepEqual(holders, []);
});

test("repointReferences() rewrites a live menu's entryRef and records one revertible change set", async () => {
  const menuRepo = new InMemoryMenuRepo([
    menuRow({ id: "menu-header", ...menuState({ title: "Header", doc: { type: "menu", version: 1, items: [entryRefItem("item-1", "post-about")] } }), version: 5 }),
  ]);
  const deps = makeRepointDeps({ menuRepo });
  const handler = contributeMenusPublish().build(deps);

  const result = await handler.repointReferences!({
    replacements: [{ entityType: "post", oldId: "post-about", newId: "post-about-new" }],
    skipIds: new Set(),
    principalId: "operator-1",
    runId: "run-1",
  });

  assert.equal(result.linksUpdated, 1);
  assert.equal(result.changeSetIds.length, 1);
  assert.deepEqual(result.notUpdated, []);

  const landed = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header" });
  assert.equal((landed?.doc.items[0]?.target as { entryId: string }).entryId, "post-about-new");

  const recorded = await deps.changeSets.findById({ workspaceId: WORKSPACE_ID, id: result.changeSetIds[0]! });
  assert.equal(recorded?.changeSet.status, "applied");
  assert.equal(recorded?.items[0]?.entityType, "menu");
  assert.equal(recorded?.items[0]?.operation, "update");
  assert.deepEqual(recorded?.items[0]?.inversePayload, { items: [entryRefItem("item-1", "post-about")] });
});

test("repointReferences() leaves a menu named in skipIds untouched", async () => {
  const menuRepo = new InMemoryMenuRepo([
    menuRow({ id: "menu-header", ...menuState({ title: "Header", doc: { type: "menu", version: 1, items: [entryRefItem("item-1", "post-about")] } }) }),
  ]);
  const deps = makeRepointDeps({ menuRepo });
  const handler = contributeMenusPublish().build(deps);

  const result = await handler.repointReferences!({
    replacements: [{ entityType: "post", oldId: "post-about", newId: "post-about-new" }],
    skipIds: new Set(["menu-header"]),
    principalId: "operator-1",
    runId: "run-1",
  });

  assert.equal(result.linksUpdated, 0);
  assert.deepEqual(result.changeSetIds, []);
  const landed = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header" });
  assert.equal((landed?.doc.items[0]?.target as { entryId: string }).entryId, "post-about", "a skipped menu must be unchanged");
});

test("repointReferences() called a second time finds nothing left to repoint — no new change set", async () => {
  const menuRepo = new InMemoryMenuRepo([
    menuRow({ id: "menu-header", ...menuState({ title: "Header", doc: { type: "menu", version: 1, items: [entryRefItem("item-1", "post-about")] } }) }),
  ]);
  const deps = makeRepointDeps({ menuRepo });
  const handler = contributeMenusPublish().build(deps);
  const replacements = [{ entityType: "post", oldId: "post-about", newId: "post-about-new" }];

  const first = await handler.repointReferences!({ replacements, skipIds: new Set(), principalId: "operator-1", runId: "run-1" });
  assert.equal(first.linksUpdated, 1);

  const second = await handler.repointReferences!({ replacements, skipIds: new Set(), principalId: "operator-1", runId: "run-2" });
  assert.equal(second.linksUpdated, 0);
  assert.deepEqual(second.changeSetIds, []);
});

test("repointReferences() reports a denied authorization without writing", async () => {
  const menuRepo = new InMemoryMenuRepo([
    menuRow({ id: "menu-header", ...menuState({ title: "Header", doc: { type: "menu", version: 1, items: [entryRefItem("item-1", "post-about")] } }) }),
  ]);
  const deps = makeRepointDeps({ menuRepo, authorize: async () => ({ allowed: false, reason: "grant excludes menus" }) });
  const handler = contributeMenusPublish().build(deps);

  const result = await handler.repointReferences!({
    replacements: [{ entityType: "post", oldId: "post-about", newId: "post-about-new" }],
    skipIds: new Set(),
    principalId: "operator-1",
    runId: "run-1",
  });

  assert.deepEqual(result.notUpdated, ["Menu links were not updated: this publishing grant doesn't cover menus."]);
  assert.equal(result.linksUpdated, 0);
  const landed = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header" });
  assert.equal((landed?.doc.items[0]?.target as { entryId: string }).entryId, "post-about", "a denied authorization must never write");
});

test("repointReferences() skips a menu that keeps conflicting after one retry, with the exact operator-facing line", async () => {
  const menuRepo = new VersionRacingMenuRepo([
    menuRow({ id: "menu-header", ...menuState({ title: "Header", doc: { type: "menu", version: 1, items: [entryRefItem("item-1", "post-about")] } }) }),
  ]);
  const deps = makeRepointDeps({ menuRepo });
  const handler = contributeMenusPublish().build(deps);

  const result = await handler.repointReferences!({
    replacements: [{ entityType: "post", oldId: "post-about", newId: "post-about-new" }],
    skipIds: new Set(),
    principalId: "operator-1",
    runId: "run-1",
  });

  assert.deepEqual(result.notUpdated, ["Menu 'Header' was not updated: it changed during publish."]);
  assert.equal(result.linksUpdated, 0);
  assert.deepEqual(result.changeSetIds, []);
});

/** A change-set ledger whose `insert` always fails — the "mutation landed, record did not" window
 *  `executeCommand` closes with `mutation.rollback` (INV-01: no mutation without a record). */
class FailingInsertChangeSetRepo extends InMemoryChangeSetRepo {
  override async insert(): Promise<void> {
    throw new Error("change-set ledger unavailable");
  }
}

test("repointReferences() puts the prior tree back when the change-set record fails after the write landed", async () => {
  const priorItems = [entryRefItem("item-1", "post-about")];
  const menuRepo = new InMemoryMenuRepo([
    menuRow({ id: "menu-header", ...menuState({ title: "Header", doc: { type: "menu", version: 1, items: priorItems } }), version: 5 }),
  ]);
  const outbox = new InMemoryOutbox();
  const deps = { ...makeRepointDeps({ menuRepo }), outbox, changeSets: new FailingInsertChangeSetRepo([], [], outbox) };
  const handler = contributeMenusPublish().build(deps);

  await assert.rejects(
    () =>
      handler.repointReferences!({
        replacements: [{ entityType: "post", oldId: "post-about", newId: "post-about-new" }],
        skipIds: new Set(),
        principalId: "operator-1",
        runId: "run-1",
      }),
    /change-set ledger unavailable/
  );

  const landed = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header" });
  // JSON round-trip: Jini's `validateAndCloneTree` writes an explicit `children: undefined`, which a
  // persisted tree never carries — the comparison is of the stored shape.
  assert.deepEqual(
    JSON.parse(JSON.stringify(landed?.doc.items)),
    priorItems,
    "an unrecorded repoint must be rolled back, never left live and unrevertible"
  );
});
