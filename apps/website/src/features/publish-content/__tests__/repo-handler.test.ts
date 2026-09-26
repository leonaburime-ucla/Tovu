import assert from "node:assert/strict";
import test from "node:test";

import type { ChangeSetItemRecord, ChangeSetRecord, ChangeSetRepoPort, OutboxPort } from "@jini-ai/cms/core";

import { PublishContentApplyRowError } from "../apply-errors.js";
import { contentHash } from "../content-hash.js";
import {
  addressHeldByOther,
  changedSincePlan,
  notWired,
  trashedAtDestination,
} from "../precheck-reasons.js";
import { createRepoPublishHandler } from "../repo-handler.js";
import type { RepoPublishTypeConfig } from "../repo-handler.js";
import type { PackedEntity, PublishContentDeps, PublishContentHandler } from "../type-registry.js";

/**
 * @file Slice F1 tests — `ADS-memory/.local-artifacts/plan-publish-all-types-2026-09-25.md` §2.4.
 * A toy `Row`/in-memory repo exercises `createRepoPublishHandler` in isolation: no real
 * publish-content type is wired to the factory yet (that is the M-* migration slices), so every
 * assertion here is about the FACTORY's own behaviour, not any production type's.
 */

const WORKSPACE_ID = "workspace-1";

interface Row {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly title: string;
  /** Provenance-only field: packed, never hashed — proves pack hashes `"transferred"` fields only. */
  readonly note: string;
  readonly status: "active" | "trashed" | "hidden";
  readonly version: number;
}

/** Thrown by the toy `write()` to prove `errors.blocked` mapping. */
class ItemValidationError extends Error {}
/** Thrown by the toy `write()` to prove `errors.conflict` mapping. */
class ItemConflictError extends Error {}
/** Thrown by the toy `write()` WITHOUT being listed in `errors` — proves an unmapped error rethrows. */
class ItemUnexpectedError extends Error {}

class FakeItemRepo {
  private readonly rows = new Map<string, Row>();

  constructor(seed: readonly Row[] = []) {
    for (const row of seed) this.rows.set(row.id, row);
  }

  async list(workspaceId: string): Promise<Row[]> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId);
  }

  async find(workspaceId: string, id: string): Promise<Row | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? row : null;
  }

  async findBySlug(workspaceId: string, slug: string): Promise<Row | null> {
    return [...this.rows.values()].find((row) => row.workspaceId === workspaceId && row.slug === slug) ?? null;
  }

  put(row: Row): void {
    this.rows.set(row.id, row);
  }

  remove(id: string): void {
    this.rows.delete(id);
  }
}

type ItemPorts = { readonly repo: FakeItemRepo };
/** F1's own test-only extension of the real `PublishContentDeps` — F2 (a later slice) is what adds a
 *  real generic `ports` bag to that interface; until then a factory-config test reads off its own ad
 *  hoc field, the same way `features/redirects/__tests__/publish-content.test.ts` casts
 *  `postRepo: undefined as unknown as ...` for a field it has no use for. */
type TestDeps = PublishContentDeps & { itemPorts?: ItemPorts };

function makeDeps(itemPorts: ItemPorts | undefined, overrides: Partial<TestDeps> = {}): TestDeps {
  let clockTick = 0;
  return {
    workspaceId: WORKSPACE_ID,
    ports: {},
    clock: { nowIso: () => `2026-09-25T00:00:${String(clockTick++).padStart(2, "0")}.000Z` },
    idGen: { newId: () => "unused-in-these-tests" },
    authorize: async () => ({ allowed: true, reason: "test-always-allow" }),
    outbox: fakeOutbox(),
    itemPorts,
    ...overrides,
  };
}

function packedEntity(id: string, state: Record<string, unknown>): PackedEntity {
  return { entityType: "item", id, schemaVersion: 1, contentHash: "unused-in-these-tests", hashVersion: 1, requiredBlobs: [], state };
}

/** Throws on `insert()` — forces `executeCommand`'s compensating-rollback path (used by test 6). */
function throwingChangeSets(): ChangeSetRepoPort {
  return {
    insert: async () => {
      throw new Error("boom: change-set insert failed");
    },
    findById: async () => null,
    findByIdempotencyKey: async () => null,
    listByWorkspace: async () => [],
    save: async () => {},
  };
}

function fakeOutbox(): OutboxPort {
  return { enqueue: async () => {}, claimPending: async () => [], markDelivered: async () => {}, markFailed: async () => {} };
}

/** A working `ChangeSetRepoPort` — enough for the tests that expect `apply()` to succeed. `inserted`
 *  collects every recorded change set so a test can read its summary and item version. */
function workingChangeSets(inserted: Array<{ record: ChangeSetRecord; items: ChangeSetItemRecord[] }> = []): ChangeSetRepoPort {
  return {
    insert: async (record, items) => {
      inserted.push({ record, items });
    },
    findById: async () => null,
    findByIdempotencyKey: async () => null,
    listByWorkspace: async () => [],
    save: async () => {},
  };
}

function baseConfig(overrides: Partial<RepoPublishTypeConfig<Row, ItemPorts>> = {}): RepoPublishTypeConfig<Row, ItemPorts> {
  return {
    entityType: "item",
    permission: "admin.items.manage",
    ports: (deps) => (deps as TestDeps).itemPorts,
    list: (ports, workspaceId) => ports.repo.list(workspaceId),
    find: (ports, workspaceId, id) => ports.repo.find(workspaceId, id),
    isTrashed: (row) => row.status === "trashed",
    include: (row) => row.status !== "hidden",
    fields: { id: "local", workspaceId: "local", slug: "transferred", title: "transferred", note: "provenance", status: "transferred", version: "local" },
    address: { field: "slug", holder: (ports, workspaceId, slug) => ports.repo.findBySlug(workspaceId, slug) },
    write: async (ctx) => {
      if (ctx.state.forceError === "blocked") throw new ItemValidationError("item validation failed");
      if (ctx.state.forceError === "conflict") throw new ItemConflictError("item write conflict");
      if (ctx.state.forceError === "unexpected") throw new ItemUnexpectedError("boom");
      const row: Row = {
        id: ctx.id,
        workspaceId: ctx.workspaceId,
        slug: ctx.state.slug as string,
        title: ctx.state.title as string,
        note: (ctx.state.note as string) ?? "",
        status: (ctx.state.status as Row["status"]) ?? "active",
        version: (ctx.existing?.version ?? 0) + 1,
      };
      ctx.ports.repo.put(row);
    },
    errors: { blocked: [ItemValidationError], conflict: [ItemConflictError] },
    ...overrides,
  };
}

function buildHandler(config: RepoPublishTypeConfig<Row, ItemPorts>, deps: TestDeps): PublishContentHandler {
  return createRepoPublishHandler(config).build(deps);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// 1. pack: skips trashed and include-false rows, hashes only "transferred" fields
// ---------------------------------------------------------------------------

test("pack skips trashed and include-false rows, and hashes only transferred fields", async () => {
  const repo = new FakeItemRepo([
    { id: "a", workspaceId: WORKSPACE_ID, slug: "a", title: "A", note: "note-1", status: "active", version: 1 },
    { id: "b", workspaceId: WORKSPACE_ID, slug: "b", title: "B", note: "note-2", status: "trashed", version: 1 },
    { id: "c", workspaceId: WORKSPACE_ID, slug: "c", title: "C", note: "note-3", status: "hidden", version: 1 },
  ]);
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  const packed = await collect(handler.pack());
  assert.deepEqual(packed.map((entity) => entity.id).sort(), ["a"]);

  // Same transferred fields, different "note" (provenance) -> same hash.
  const sameContentDifferentNote = contentHash("item", { slug: "a", title: "A", status: "active" });
  assert.equal(packed[0]!.contentHash, sameContentDifferentNote);
  assert.deepEqual(packed[0]!.state, { slug: "a", title: "A", note: "note-1", status: "active" });
});

test("pack honours packOrder, requiredBlobs and legacyHashState; extend's methods reach the handler", async () => {
  const repo = new FakeItemRepo([
    { id: "a", workspaceId: WORKSPACE_ID, slug: "a", title: "A", note: "n", status: "active", version: 1 },
    { id: "b", workspaceId: WORKSPACE_ID, slug: "b", title: "B", note: "n", status: "active", version: 1 },
  ]);
  const seedHash = async () => "seed";
  const handler = buildHandler(
    baseConfig({
      packOrder: (rows) => [...rows].reverse(),
      requiredBlobs: (row) => [`sha-${row.id}`],
      // Post's legacy rule: hash every packed field, provenance included.
      legacyHashState: (_row, packedState) => packedState,
      extend: () => ({ seedHash }),
    }),
    makeDeps({ repo })
  );

  const packed = await collect(handler.pack());
  assert.deepEqual(packed.map((entity) => entity.id), ["b", "a"]);
  assert.deepEqual(packed[1]!.requiredBlobs, ["sha-a"]);
  assert.equal(packed[1]!.contentHash, contentHash("item", { slug: "a", title: "A", note: "n", status: "active" }));
  assert.equal((await handler.inspect("a"))?.hash, packed[1]!.contentHash);
  assert.equal(handler.seedHash, seedHash);
});

// ---------------------------------------------------------------------------
// 2. Missing ports: pack empty, inspect null, precheck notWired text, apply throws
// ---------------------------------------------------------------------------

test("missing ports: pack yields nothing, inspect is null, precheck refuses, apply throws", async () => {
  const handler = buildHandler(baseConfig(), makeDeps(undefined));

  assert.deepEqual(await collect(handler.pack()), []);
  assert.equal(await handler.inspect("missing"), null);

  const reason = await handler.precheck(packedEntity("missing", { slug: "x", title: "X" }));
  assert.equal(reason, notWired("item", "missing", "item ports"));

  await assert.rejects(() =>
    handler.apply({ entity: packedEntity("missing", { slug: "x", title: "X" }), expectedVersion: undefined, principalId: "op-1", idempotencyKey: "key-1" })
  );
});

// ---------------------------------------------------------------------------
// 3. Precheck refusals: address held, trashed destination, validate passthrough
// ---------------------------------------------------------------------------

test("precheck refuses when the address is held by a different id", async () => {
  const repo = new FakeItemRepo([{ id: "holder", workspaceId: WORKSPACE_ID, slug: "taken", title: "Holder", note: "", status: "active", version: 1 }]);
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  const reason = await handler.precheck(packedEntity("incoming", { slug: "taken", title: "Incoming" }));
  assert.equal(reason, addressHeldByOther("item", "slug", "taken", "holder"));
});

test("precheck refuses when the destination row is trashed", async () => {
  const repo = new FakeItemRepo([{ id: "x", workspaceId: WORKSPACE_ID, slug: "x", title: "X", note: "", status: "trashed", version: 1 }]);
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  const reason = await handler.precheck(packedEntity("x", { slug: "x", title: "X" }));
  assert.equal(reason, trashedAtDestination("item", "x"));
});

test("precheck passes through a type-specific validate refusal after the generic checks", async () => {
  const repo = new FakeItemRepo();
  const handler = buildHandler(
    baseConfig({ validate: async () => "item-specific refusal" }),
    makeDeps({ repo })
  );

  const reason = await handler.precheck(packedEntity("x", { slug: "x", title: "X" }));
  assert.equal(reason, "item-specific refusal");
});

test("precheck compares the address holder by idOf, so a natural-key type is not refused by its own row", async () => {
  const repo = new FakeItemRepo([{ id: "row-1", workspaceId: WORKSPACE_ID, slug: "taken", title: "Same", note: "", status: "active", version: 1 }]);
  const handler = buildHandler(
    baseConfig({
      idOf: (row) => row.slug,
      find: (ports, workspaceId, slug) => ports.repo.findBySlug(workspaceId, slug),
      address: { field: "slug", holder: (ports, workspaceId, slug) => ports.repo.findBySlug(workspaceId, slug) },
    }),
    makeDeps({ repo })
  );

  assert.equal(await handler.precheck(packedEntity("taken", { slug: "taken", title: "Same" })), null);
});

test("precheck skips the address check for an empty value (nothing to collide on)", async () => {
  const repo = new FakeItemRepo([{ id: "other", workspaceId: WORKSPACE_ID, slug: "", title: "Slugless", note: "", status: "active", version: 1 }]);
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  assert.equal(await handler.precheck(packedEntity("x", { slug: "", title: "X" })), null);
});

test("precheck returns null when nothing blocks", async () => {
  const repo = new FakeItemRepo();
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  const reason = await handler.precheck(packedEntity("x", { slug: "x", title: "X" }));
  assert.equal(reason, null);
});

// ---------------------------------------------------------------------------
// 4. The three CAS conflict cases, each with the exact text
// ---------------------------------------------------------------------------

test("apply: expectedVersion undefined but a row already exists at the destination -> conflict", async () => {
  const repo = new FakeItemRepo([{ id: "x", workspaceId: WORKSPACE_ID, slug: "x", title: "X", note: "", status: "active", version: 3 }]);
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  await assert.rejects(
    () => handler.apply({ entity: packedEntity("x", { slug: "x", title: "X" }), expectedVersion: undefined, principalId: "op-1", idempotencyKey: "key-1" }),
    (err: unknown) => {
      assert.ok(err instanceof PublishContentApplyRowError);
      assert.equal(err.rowOutcome, "conflict");
      assert.equal(err.message, changedSincePlan("item", "x", "expected no existing row, found version 3"));
      return true;
    }
  );
});

test("apply: expectedVersion set but no row exists -> conflict", async () => {
  const repo = new FakeItemRepo();
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  await assert.rejects(
    () => handler.apply({ entity: packedEntity("x", { slug: "x", title: "X" }), expectedVersion: 2, principalId: "op-1", idempotencyKey: "key-1" }),
    (err: unknown) => {
      assert.ok(err instanceof PublishContentApplyRowError);
      assert.equal(err.message, changedSincePlan("item", "x", "expected version 2, but the row is gone"));
      return true;
    }
  );
});

test("apply: expectedVersion set but differs from the destination's version -> conflict", async () => {
  const repo = new FakeItemRepo([{ id: "x", workspaceId: WORKSPACE_ID, slug: "x", title: "X", note: "", status: "active", version: 5 }]);
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  await assert.rejects(
    () => handler.apply({ entity: packedEntity("x", { slug: "x", title: "X" }), expectedVersion: 2, principalId: "op-1", idempotencyKey: "key-1" }),
    (err: unknown) => {
      assert.ok(err instanceof PublishContentApplyRowError);
      assert.equal(err.message, changedSincePlan("item", "x", "expected version 2, found version 5"));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 5. errors mapping for blocked/conflict; an unmapped error rethrows
// ---------------------------------------------------------------------------

test("apply maps a configured blocked error class to a blocked row outcome", async () => {
  const repo = new FakeItemRepo();
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  await assert.rejects(
    () =>
      handler.apply({
        entity: packedEntity("x", { slug: "x", title: "X", forceError: "blocked" }),
        expectedVersion: undefined,
        principalId: "op-1",
        idempotencyKey: "key-1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PublishContentApplyRowError);
      assert.equal(err.rowOutcome, "blocked");
      assert.equal(err.message, "item validation failed");
      return true;
    }
  );
});

test("apply maps a configured conflict error class to a conflict row outcome", async () => {
  const repo = new FakeItemRepo();
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  await assert.rejects(
    () =>
      handler.apply({
        entity: packedEntity("x", { slug: "x", title: "X", forceError: "conflict" }),
        expectedVersion: undefined,
        principalId: "op-1",
        idempotencyKey: "key-1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PublishContentApplyRowError);
      assert.equal(err.rowOutcome, "conflict");
      // Same sentence `apply-loop.ts` builds for post's conflict classes today, so M-POST can delete
      // that special case without changing the reason text.
      assert.equal(err.message, changedSincePlan("item", "x", "item write conflict"));
      return true;
    }
  );
});

test("apply rethrows an error not listed in errors.blocked/conflict unchanged", async () => {
  const repo = new FakeItemRepo();
  const handler = buildHandler(baseConfig(), makeDeps({ repo }));

  await assert.rejects(
    () =>
      handler.apply({
        entity: packedEntity("x", { slug: "x", title: "X", forceError: "unexpected" }),
        expectedVersion: undefined,
        principalId: "op-1",
        idempotencyKey: "key-1",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ItemUnexpectedError);
      assert.ok(!(err instanceof PublishContentApplyRowError));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 6. undo: a write that fails after executeCommand has started -> rollback restores/removes
// ---------------------------------------------------------------------------

test("undo.restore is called on rollback when a prior row existed", async () => {
  const repo = new FakeItemRepo([{ id: "x", workspaceId: WORKSPACE_ID, slug: "x", title: "Old", note: "", status: "active", version: 1 }]);
  let restoreCalledWith: Row | undefined;
  const handler = buildHandler(
    baseConfig({
      undo: {
        restore: async (ctx, prior) => {
          restoreCalledWith = prior;
          ctx.ports.repo.put(prior);
        },
        remove: async () => {
          throw new Error("remove should not be called when a prior row existed");
        },
      },
    }),
    makeDeps({ repo }, { changeSets: throwingChangeSets() })
  );

  await assert.rejects(
    () =>
      handler.apply({
        entity: packedEntity("x", { slug: "x", title: "New" }),
        expectedVersion: 1,
        principalId: "op-1",
        idempotencyKey: "key-1",
      }),
    /boom: change-set insert failed/
  );
  assert.equal(restoreCalledWith?.id, "x");
  assert.equal(restoreCalledWith?.title, "Old");
  // The write itself landed (execute ran) before the record failed and rollback restored the row.
  assert.equal((await repo.find(WORKSPACE_ID, "x"))?.title, "Old");
});

test("undo.remove is called on rollback when there was no prior row (a create)", async () => {
  const repo = new FakeItemRepo();
  let removeCalledWithId: string | undefined;
  const handler = buildHandler(
    baseConfig({
      undo: {
        restore: async () => {
          throw new Error("restore should not be called when there was no prior row");
        },
        remove: async (ctx) => {
          removeCalledWithId = ctx.id;
          ctx.ports.repo.remove(ctx.id);
        },
      },
    }),
    makeDeps({ repo }, { changeSets: throwingChangeSets() })
  );

  await assert.rejects(
    () =>
      handler.apply({
        entity: packedEntity("new-x", { slug: "new-x", title: "Brand New" }),
        expectedVersion: undefined,
        principalId: "op-1",
        idempotencyKey: "key-1",
      }),
    /boom: change-set insert failed/
  );
  assert.equal(removeCalledWithId, "new-x");
  assert.equal(await repo.find(WORKSPACE_ID, "new-x"), null);
});

test("with undo and a working change-set repo, apply succeeds and the row lands", async () => {
  const repo = new FakeItemRepo();
  const handler = buildHandler(
    baseConfig({ undo: { restore: async () => {}, remove: async () => {} } }),
    makeDeps({ repo }, { changeSets: workingChangeSets() })
  );

  const { changeSetId } = await handler.apply({
    entity: packedEntity("x", { slug: "x", title: "X" }),
    expectedVersion: undefined,
    principalId: "op-1",
    idempotencyKey: "key-1",
  });
  assert.ok(changeSetId.length > 0);
  assert.equal((await repo.find(WORKSPACE_ID, "x"))?.title, "X");
});

test("with undo, the change set records write's version and the (async) summary, and apply returns write's extra fields", async () => {
  const repo = new FakeItemRepo();
  const inserted: Array<{ record: ChangeSetRecord; items: ChangeSetItemRecord[] }> = [];
  const handler = buildHandler(
    baseConfig({
      write: async () => ({ version: 7, blobWritten: true }),
      undo: { restore: async () => {}, remove: async () => {}, summary: async (ctx) => `custom summary for ${ctx.id}` },
    }),
    makeDeps({ repo }, { changeSets: workingChangeSets(inserted) })
  );

  const result = await handler.apply({ entity: packedEntity("x", { slug: "x", title: "X" }), expectedVersion: undefined, principalId: "op-1", idempotencyKey: "key-1" });

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]!.record.summary, "custom summary for x");
  assert.equal(inserted[0]!.items[0]!.entityVersionAtApply, 7);
  assert.equal(inserted[0]!.record.id, result.changeSetId);
  assert.equal((result as { blobWritten?: boolean }).blobWritten, true);
});

test("with undo, apply refuses to run when authorize or outbox is not wired, before writing anything", async () => {
  for (const missing of ["authorize", "outbox"] as const) {
    const repo = new FakeItemRepo();
    let writes = 0;
    const handler = buildHandler(
      baseConfig({
        write: async () => {
          writes += 1;
        },
        undo: { restore: async () => {}, remove: async () => {} },
      }),
      makeDeps({ repo }, { changeSets: workingChangeSets(), [missing]: undefined })
    );

    await assert.rejects(
      () => handler.apply({ entity: packedEntity("x", { slug: "x", title: "X" }), expectedVersion: undefined, principalId: "op-1", idempotencyKey: "key-1" }),
      /requires PublishContentDeps\.changeSets\/authorize\/outbox/
    );
    assert.equal(writes, 0, `no write may run when ${missing} is missing`);
  }
});

test("without undo, changeSetId is what write returned, else the packed id", async () => {
  const repo = new FakeItemRepo();
  const returning = buildHandler(baseConfig({ write: async () => ({ changeSetId: "domain-row-9" }) }), makeDeps({ repo }));
  const silent = buildHandler(baseConfig({ write: async () => {} }), makeDeps({ repo }));
  const apply = (handler: PublishContentHandler) =>
    handler.apply({ entity: packedEntity("x", { slug: "x", title: "X" }), expectedVersion: undefined, principalId: "op-1", idempotencyKey: "key-1" });

  assert.equal((await apply(returning)).changeSetId, "domain-row-9");
  assert.equal((await apply(silent)).changeSetId, "x");
});

// ---------------------------------------------------------------------------
// 7. Round trip: export -> apply to an empty destination -> re-pack -> identical contentHash,
//    a second plan-equivalent comparison reports "unchanged"; an edit then reports "applied"; a
//    destination edited after the baseline reports "conflict" at apply.
// ---------------------------------------------------------------------------

test("round trip: pack -> apply to an empty destination -> re-pack yields an identical contentHash", async () => {
  const sourceRepo = new FakeItemRepo([{ id: "x", workspaceId: WORKSPACE_ID, slug: "x", title: "Round Trip", note: "n", status: "active", version: 9 }]);
  const sourceHandler = buildHandler(baseConfig(), makeDeps({ repo: sourceRepo }));
  const [sourceEntity] = await collect(sourceHandler.pack());
  assert.ok(sourceEntity);

  const destRepo = new FakeItemRepo();
  const destHandler = buildHandler(baseConfig(), makeDeps({ repo: destRepo }));

  const baselineDestInspect = await destHandler.inspect(sourceEntity.id);
  assert.equal(baselineDestInspect, null); // "created" — no destination row yet.

  await destHandler.apply({ entity: sourceEntity, expectedVersion: undefined, principalId: "op-1", idempotencyKey: "key-1" });

  const [destEntity] = await collect(destHandler.pack());
  assert.ok(destEntity);
  assert.equal(destEntity.contentHash, sourceEntity.contentHash); // "unchanged" on a second plan.

  // A second plan against the now-populated destination reports "unchanged": inspect's hash matches
  // the source's own contentHash exactly, the planner's own "unchanged" test (`planner.ts`).
  const secondInspect = await destHandler.inspect(sourceEntity.id);
  assert.equal(secondInspect?.hash, sourceEntity.contentHash);

  // Edit the source -> its repack no longer matches the destination's baseline hash ("applied").
  const sourceRowBeforeEdit = await sourceRepo.find(WORKSPACE_ID, "x");
  assert.ok(sourceRowBeforeEdit);
  sourceRepo.put({ ...sourceRowBeforeEdit, title: "Edited" });
  const [editedSourceEntity] = await collect(sourceHandler.pack());
  assert.notEqual(editedSourceEntity!.contentHash, secondInspect?.hash);

  // Edit the destination directly (bypassing publish) after the baseline was captured, then apply
  // the (stale) expectedVersion from the baseline -> a version-mismatch conflict.
  const destRowBeforeConflictEdit = await destRepo.find(WORKSPACE_ID, sourceEntity.id);
  assert.ok(destRowBeforeConflictEdit);
  destRepo.put({ ...destRowBeforeConflictEdit, title: "Changed on destination", version: destRowBeforeConflictEdit.version + 1 });

  await assert.rejects(
    () =>
      destHandler.apply({
        entity: editedSourceEntity!,
        expectedVersion: destRowBeforeConflictEdit.version, // stale on purpose
        principalId: "op-1",
        idempotencyKey: "key-2",
      }),
    (err: unknown) => {
      assert.ok(err instanceof PublishContentApplyRowError);
      assert.equal(err.rowOutcome, "conflict");
      return true;
    }
  );
});
