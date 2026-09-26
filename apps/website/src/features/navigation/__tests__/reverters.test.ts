import assert from "node:assert/strict";
import test from "node:test";

import { createRevertRegistry, InMemoryChangeSetRepo, revertChangeSet, RevertConflictError } from "#src/contracts/core/commands/index";
import { InMemoryOutbox } from "#src/contracts/core/events/index";
import type { PublishContentDeps } from "#src/features/publish-content/type-registry";

import { InMemoryMenuRepo, type MenuRepoPort, type NavLocationBindingRepoPort, type NavMenuEntry } from "../index.js";
import { contributeMenusPublish } from "../publish-content.js";
import { registerMenuReverters } from "../reverters.js";

/**
 * @file R4 (`ADS-memory/.local-artifacts/plan-publish-repoint-menus-2026-09-24.md` §2.4/§3) —
 * `registerMenuReverters` (`../reverters.ts`). Produces a REAL repoint change set through R3's
 * `repointReferences` (`../publish-content.ts`), same "real chokepoint" convention
 * `features/post/__tests__/publish-content.test.ts:467`'s own revert test uses, then reverts it
 * through the standard `revertChangeSet` path with a registry built by `registerMenuReverters`.
 */

const WORKSPACE_ID = "workspace-1";

function menuState(overrides: Partial<Pick<NavMenuEntry, "slug" | "title" | "status" | "doc" | "locations">> = {}) {
  return {
    slug: "primary-nav",
    title: "Header",
    status: "published",
    doc: { type: "menu", version: 1, items: [] },
    locations: [],
    ...overrides,
  };
}

function menuRow(overrides: Partial<NavMenuEntry> & Pick<NavMenuEntry, "id">): NavMenuEntry {
  return {
    workspaceId: WORKSPACE_ID,
    ...menuState(),
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  } as NavMenuEntry;
}

function entryRefItem(id: string, entryId: string) {
  return { id, label: "About", target: { kind: "entryRef" as const, entryId } };
}

/** Builds `PublishContentDeps` plus a real `changeSets`/`authorize` — what `repointReferences()`
 *  requires (see its own doc). `authorize` always allows. */
function makeRepointDeps(menuRepo: MenuRepoPort): PublishContentDeps & { changeSets: InMemoryChangeSetRepo } {
  const outbox = new InMemoryOutbox();
  return {
    workspaceId: WORKSPACE_ID,
    clock: { nowIso: () => "2026-09-24T00:00:00.000Z" },
    idGen: (() => {
      let n = 0;
      return { newId: () => `generated-${++n}` };
    })(),
    outbox,
    ports: { menu: { repo: menuRepo, bindingRepo: undefined as unknown as NavLocationBindingRepoPort } },
    changeSets: new InMemoryChangeSetRepo([], [], outbox),
    authorize: async () => ({ allowed: true, reason: "test-always-allow" }),
  };
}

test("revertChangeSet undoes a repoint change set, restoring the prior entryRef", async () => {
  const menuRepo = new InMemoryMenuRepo([
    menuRow({ id: "menu-header", ...menuState({ doc: { type: "menu", version: 1, items: [entryRefItem("item-1", "post-about")] } }) }),
  ]);
  const deps = makeRepointDeps(menuRepo);
  const handler = contributeMenusPublish().build(deps);

  const result = await handler.repointReferences!({
    replacements: [{ entityType: "post", oldId: "post-about", newId: "post-about-new" }],
    skipIds: new Set(),
    principalId: "operator-1",
    runId: "run-1",
  });
  assert.equal(result.linksUpdated, 1);
  const changeSetId = result.changeSetIds[0]!;

  const landedBeforeRevert = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header" });
  assert.equal((landedBeforeRevert?.doc.items[0]?.target as { entryId: string }).entryId, "post-about-new");

  const registry = registerMenuReverters(createRevertRegistry(), {
    menuRepo,
    clock: deps.clock,
    idGen: deps.idGen,
    outbox: deps.outbox!,
  });

  await revertChangeSet({
    deps: { changeSets: deps.changeSets, registry, clock: deps.clock, idGen: deps.idGen },
    input: { workspaceId: WORKSPACE_ID, changeSetId },
  });

  const reverted = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header" });
  assert.equal((reverted?.doc.items[0]?.target as { entryId: string }).entryId, "post-about", "revert must restore the prior entryRef");
});

test("revertChangeSet refuses a repoint change set whose menu changed since — the standard conflict", async () => {
  const menuRepo = new InMemoryMenuRepo([
    menuRow({ id: "menu-header", ...menuState({ doc: { type: "menu", version: 1, items: [entryRefItem("item-1", "post-about")] } }) }),
  ]);
  const deps = makeRepointDeps(menuRepo);
  const handler = contributeMenusPublish().build(deps);

  const result = await handler.repointReferences!({
    replacements: [{ entityType: "post", oldId: "post-about", newId: "post-about-new" }],
    skipIds: new Set(),
    principalId: "operator-1",
    runId: "run-1",
  });
  const changeSetId = result.changeSetIds[0]!;

  // An unrelated later edit lands on the menu — the exact case the version guard exists for.
  const afterRepoint = await menuRepo.findById({ workspaceId: WORKSPACE_ID, id: "menu-header" });
  await menuRepo.save({ ...afterRepoint!, version: afterRepoint!.version + 1 });

  const registry = registerMenuReverters(createRevertRegistry(), {
    menuRepo,
    clock: deps.clock,
    idGen: deps.idGen,
    outbox: deps.outbox!,
  });

  await assert.rejects(
    () =>
      revertChangeSet({
        deps: { changeSets: deps.changeSets, registry, clock: deps.clock, idGen: deps.idGen },
        input: { workspaceId: WORKSPACE_ID, changeSetId },
      }),
    (err: unknown) => err instanceof RevertConflictError
  );
});
