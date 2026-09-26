/**
 * @file S19 / `publish-files-plan-2026-09-24.md` §6 S-F4 — the DESTINATION half of `theme-files`:
 * `inspect`, `seedHash`, `precheck` and `apply` (stage, verify, swap, keep previous copies, roll back).
 *
 * Every test runs against real temp directories: a SOURCE themes dir packed by the real `pack()`
 * walker, and a DESTINATION themes dir standing in for a peer site. Bytes reach the destination the
 * way the real transport delivers them: into its blob store under `computeBlobStorageKey`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { InMemoryChangeSetRepo } from "#src/contracts/core/commands/index";
import { InMemoryOutbox } from "#src/contracts/core/events/index";
import { InMemoryBlobStore } from "#src/features/media/index";
import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import { CONTENT_HASH_VERSION, contentHash } from "#src/features/publish-content/content-hash";
import { entityKey, planImport } from "#src/features/publish-content/planner";
import { PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION } from "#src/features/publish-content/artifact-format";
import {
  registerPublishContentContributor,
  resetPublishContentContributorsForTests,
  type PackedEntity,
  type PublishContentDeps,
} from "#src/features/publish-content/type-registry";

import { contributeThemeFilesPublish, packThemeFilesEntities } from "../publish-content.js";
import { discoverAllBuiltInThemes } from "../theme.js";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const OPERATOR_ID = "operator-1";
const LINK_REASON = "live's themes folder contains a link; nothing was written";

const tempDirs: string[] = [];
afterEach(async () => {
  resetPublishContentContributorsForTests();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A fresh temp dir, realpath'd so macOS's `/var -> /private/var` link never trips the link check. */
async function tempDir(label: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), `theme-s19-${label}-`)));
  tempDirs.push(dir);
  return dir;
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
}

/** Every file under `dir` as `{relPath: text}` — what "the file on disk matches" compares. */
async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function recurse(abs: string, rel: string): Promise<void> {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await recurse(childAbs, childRel);
      else out[childRel] = await readFile(childAbs, "utf8");
    }
  }
  await recurse(dir, "");
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await readdir(p);
    return true;
  } catch {
    return false;
  }
}

const SOURCE_BASIC = {
  "theme.json": '{"id":"basic","name":"Basic"}',
  "render/partials/nav.html": "<nav>new header</nav>",
  "css/theme.css": "header { color: teal; }",
};
const ORIGINAL_BASIC = {
  "theme.json": '{"id":"basic","name":"Basic"}',
  "render/partials/nav.html": "<nav>original header</nav>",
  "css/theme.css": "header { color: black; }",
};

interface Fixture {
  readonly sourceThemes: string;
  readonly destThemes: string;
  readonly blobStore: InMemoryBlobStore;
  readonly changeSets: InMemoryChangeSetRepo;
  readonly deps: PublishContentDeps;
}

async function makeFixture(options: { sourceFiles?: Record<string, string>; destFiles?: Record<string, string> | null } = {}): Promise<Fixture> {
  const sourceThemes = await tempDir("src");
  const destThemes = await tempDir("dest");
  await writeTree(path.join(sourceThemes, "static/basic"), options.sourceFiles ?? SOURCE_BASIC);
  await writeTree(path.join(destThemes, "__original-themes__/static/basic"), ORIGINAL_BASIC);
  if (options.destFiles !== null) await writeTree(path.join(destThemes, "static/basic"), options.destFiles ?? ORIGINAL_BASIC);
  const blobStore = new InMemoryBlobStore();
  const outbox = new InMemoryOutbox();
  const changeSets = new InMemoryChangeSetRepo([], [], outbox);
  let n = 0;
  const deps: PublishContentDeps = {
    workspaceId: WORKSPACE_ID,
    clock: { nowIso: () => "2026-09-24T12:00:00.000Z" },
    idGen: { newId: () => `generated-id-${++n}` },
    outbox,
    changeSets,
    authorize: async () => ({ allowed: true, reason: "test-always-allow" }),
    ports: {
      // `blobStore` lives on `ports.media` — theme's own port has no store of its own; see
      // `theme/publish-content.ts`'s comment above `buildHandler`.
      media: { repo: undefined as never, assetBlobRepo: undefined as never, blobStore },
      "theme-files": { themesDir: destThemes },
    },
  };
  return { sourceThemes, destThemes, blobStore, changeSets, deps };
}

/** Packs the source's `static/basic` and puts every file's bytes where the blob PUT leg would. */
async function packAndStage(fixture: Fixture, options: { skipSha?: string } = {}): Promise<PackedEntity> {
  const { entities } = await packThemeFilesEntities({ themesDir: fixture.sourceThemes });
  const entity = entities.find((e) => e.id === "static/basic");
  assert.ok(entity, "the source basic theme must pack");
  const files = entity.state.files as Array<{ path: string; sha256: string }>;
  for (const file of files) {
    if (file.sha256 === options.skipSha) continue;
    const bytes = await readFile(path.join(fixture.sourceThemes, "static/basic", file.path));
    await fixture.blobStore.putIfAbsent({ workspaceId: WORKSPACE_ID, sha256: file.sha256, bytes });
  }
  return entity;
}

function handlerFor(deps: PublishContentDeps) {
  return contributeThemeFilesPublish().build(deps);
}

/** Re-hashes an entity whose state a test edited, so the hash check is not what refuses it. */
function rehash(entity: PackedEntity, state: Record<string, unknown>): PackedEntity {
  return { ...entity, state, contentHash: contentHash("theme-files", state) };
}

// ---------------------------------------------------------------------------
// inspect / seedHash
// ---------------------------------------------------------------------------

test("inspect() is null when the destination has no such tree", async () => {
  const fixture = await makeFixture({ destFiles: null });
  assert.equal(await handlerFor(fixture.deps).inspect("static/basic"), null);
});

test("inspect() hashes the destination tree with the same state builder as pack(), version 0", async () => {
  const fixture = await makeFixture({ destFiles: SOURCE_BASIC });
  const entity = await packAndStage(fixture);
  assert.deepEqual(await handlerFor(fixture.deps).inspect("static/basic"), { version: 0, hash: entity.contentHash });
});

test("inspect() refuses a malformed id instead of reading outside the themes folder", async () => {
  const fixture = await makeFixture();
  assert.equal(await handlerFor(fixture.deps).inspect("../static/basic"), null);
});

test("seedHash() is the hash of the destination's own __original-themes__ copy", async () => {
  const fixture = await makeFixture();
  const handler = handlerFor(fixture.deps);
  const destination = await handler.inspect("static/basic");
  assert.ok(destination);
  assert.equal(await handler.seedHash?.("static/basic"), destination.hash);
});

test("seedHash() is null when the destination has no original for the tree", async () => {
  const fixture = await makeFixture();
  assert.equal(await handlerFor(fixture.deps).seedHash?.("static/other"), null);
});

// ---------------------------------------------------------------------------
// precheck
// ---------------------------------------------------------------------------

test("precheck() passes a clean tree", async () => {
  const fixture = await makeFixture();
  const entity = await packAndStage(fixture);
  assert.equal(await handlerFor(fixture.deps).precheck(entity), null);
});

test("precheck() blocks a '../x' path in the state with the exact reason", async () => {
  const fixture = await makeFixture();
  const entity = await packAndStage(fixture);
  const files = [...(entity.state.files as Array<Record<string, unknown>>), { path: "../x", sha256: "0".repeat(64), size: 1, mode: 0o644 }];
  const reason = await handlerFor(fixture.deps).precheck(rehash(entity, { ...entity.state, files }));
  assert.equal(reason, `Theme: static/basic was not published: "../x" contains a '..' segment, which is never allowed`);
});

// An OS junk name is skipped by the SOURCE walker, never by the destination's policy check: `apply()`
// stages every incoming file, so a check that ignored `._x` would let it skip the '..' guard and be
// written outside the staging folder.
test("precheck() blocks a '..' path even when its file name looks like OS junk", async () => {
  const fixture = await makeFixture();
  const entity = await packAndStage(fixture);
  const files = [...(entity.state.files as Array<Record<string, unknown>>), { path: "../escape/._x.png", sha256: "0".repeat(64), size: 1, mode: 0o644 }];
  const reason = await handlerFor(fixture.deps).precheck(rehash(entity, { ...entity.state, files }));
  assert.equal(reason, `Theme: static/basic was not published: "../escape/._x.png" contains a '..' segment, which is never allowed`);
});

test("precheck() blocks an incoming OS junk file instead of staging it unchecked", async () => {
  const fixture = await makeFixture();
  const entity = await packAndStage(fixture);
  const files = [...(entity.state.files as Array<Record<string, unknown>>), { path: ".DS_Store", sha256: "0".repeat(64), size: 1, mode: 0o644 }];
  const reason = await handlerFor(fixture.deps).precheck(rehash(entity, { ...entity.state, files }));
  assert.equal(reason, `Theme: static/basic was not published: ".DS_Store" is a system file that is never published`);
});

test("precheck() blocks a state whose treeKey does not match the entity id", async () => {
  const fixture = await makeFixture();
  const entity = await packAndStage(fixture);
  const reason = await handlerFor(fixture.deps).precheck(rehash(entity, { ...entity.state, treeKey: "static/other" }));
  assert.equal(reason, "Theme: static/basic was not published: its file list does not describe 'static/basic'");
});

test("precheck() re-runs the secret scan on the destination against the staged bytes", async () => {
  const fixture = await makeFixture({ sourceFiles: SOURCE_BASIC });
  const entity = await packAndStage(fixture);
  // Swap one staged blob's bytes for a key-bearing file under a sha the state now claims.
  const leaked = new TextEncoder().encode(`a { content: "${"sk-ant-" + "a".repeat(95)}"; }`);
  const sha256 = createHash("sha256").update(leaked).digest("hex");
  await fixture.blobStore.putIfAbsent({ workspaceId: WORKSPACE_ID, sha256, bytes: leaked });
  const files = (entity.state.files as Array<Record<string, unknown>>).map((f) => (f.path === "css/theme.css" ? { ...f, sha256, size: leaked.length } : f));
  const reason = await handlerFor(fixture.deps).precheck(rehash(entity, { ...entity.state, files }));
  assert.match(reason ?? "", /^Theme: static\/basic was not published: "css\/theme\.css" looks like it holds a key/);
});

test("precheck() blocks when the destination's static/ tier folder is a symlink", async () => {
  const fixture = await makeFixture({ destFiles: null });
  const elsewhere = await tempDir("elsewhere");
  await symlink(elsewhere, path.join(fixture.destThemes, "static"));
  const entity = await packAndStage(fixture);
  assert.equal(await handlerFor(fixture.deps).precheck(entity), LINK_REASON);
});

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

test("apply() creates a tree the destination did not have, and leaves no staging behind", async () => {
  const fixture = await makeFixture({ destFiles: null });
  const entity = await packAndStage(fixture);
  const result = await handlerFor(fixture.deps).apply({ entity, expectedVersion: undefined, principalId: OPERATOR_ID, idempotencyKey: "key-create" });
  assert.ok(result.changeSetId);
  assert.deepEqual(await readTree(path.join(fixture.destThemes, "static/basic")), SOURCE_BASIC);
  assert.deepEqual(await readdir(path.join(fixture.destThemes, ".publish-staging")), []);
});

test("apply() replaces an existing tree and keeps the old one under .publish-previous", async () => {
  const fixture = await makeFixture();
  const entity = await packAndStage(fixture);
  await handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: "key-replace" });
  assert.deepEqual(await readTree(path.join(fixture.destThemes, "static/basic")), SOURCE_BASIC);
  const previousKeys = await readdir(path.join(fixture.destThemes, ".publish-previous"));
  assert.equal(previousKeys.length, 1);
  assert.deepEqual(await readTree(path.join(fixture.destThemes, ".publish-previous", previousKeys[0], "static/basic")), ORIGINAL_BASIC);
});

test("apply() keeps only the last 2 previous copies of a tree", async () => {
  const fixture = await makeFixture();
  for (let i = 0; i < 4; i += 1) {
    await writeFile(path.join(fixture.sourceThemes, "static/basic/css/theme.css"), `header { order: ${i}; }`);
    const entity = await packAndStage(fixture);
    await handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: `key-${i}` });
  }
  const kept = await readdir(path.join(fixture.destThemes, ".publish-previous"));
  assert.equal(kept.length, 2);
  const css = await Promise.all(kept.map((k) => readFile(path.join(fixture.destThemes, ".publish-previous", k, "static/basic/css/theme.css"), "utf8")));
  assert.deepEqual(css.sort(), ["header { order: 1; }", "header { order: 2; }"]);
});

test("a mid-write failure (a missing blob) leaves the old tree serving and no staging dir", async () => {
  const fixture = await makeFixture();
  const { entities } = await packThemeFilesEntities({ themesDir: fixture.sourceThemes });
  const cssSha = (entities[0].state.files as Array<{ path: string; sha256: string }>).find((f) => f.path === "css/theme.css")!.sha256;
  const entity = await packAndStage(fixture, { skipSha: cssSha });
  await assert.rejects(
    handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: "key-missing" }),
    (error: unknown) =>
      error instanceof PublishContentApplyRowError &&
      error.rowOutcome === "blocked" &&
      error.message === `Theme: static/basic was not published: the bytes for "css/theme.css" never reached this site`
  );
  assert.deepEqual(await readTree(path.join(fixture.destThemes, "static/basic")), ORIGINAL_BASIC);
  assert.deepEqual(await readdir(path.join(fixture.destThemes, ".publish-staging")), []);
  assert.equal(await exists(path.join(fixture.destThemes, ".publish-previous")), false);
});

test("apply() refuses a symlinked static/ with the exact reason and writes nothing", async () => {
  const fixture = await makeFixture({ destFiles: null });
  const elsewhere = await tempDir("elsewhere");
  await symlink(elsewhere, path.join(fixture.destThemes, "static"));
  const entity = await packAndStage(fixture);
  await assert.rejects(
    handlerFor(fixture.deps).apply({ entity, expectedVersion: undefined, principalId: OPERATOR_ID, idempotencyKey: "key-link" }),
    (error: unknown) => error instanceof PublishContentApplyRowError && error.rowOutcome === "blocked" && error.message === LINK_REASON
  );
  assert.deepEqual(await readdir(elsewhere), []);
});

test("rollback (change-set record fails after the swap) restores the old tree", async () => {
  const fixture = await makeFixture();
  const entity = await packAndStage(fixture);
  fixture.changeSets.insert = async () => {
    throw new Error("change-set store is down");
  };
  await assert.rejects(
    handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: "key-rollback" }),
    /change-set store is down/
  );
  assert.deepEqual(await readTree(path.join(fixture.destThemes, "static/basic")), ORIGINAL_BASIC);
});

test("rollback of a CREATE removes the tree it added", async () => {
  const fixture = await makeFixture({ destFiles: null });
  const entity = await packAndStage(fixture);
  fixture.changeSets.insert = async () => {
    throw new Error("change-set store is down");
  };
  await assert.rejects(
    handlerFor(fixture.deps).apply({ entity, expectedVersion: undefined, principalId: OPERATOR_ID, idempotencyKey: "key-rollback-create" }),
    /change-set store is down/
  );
  assert.equal(await exists(path.join(fixture.destThemes, "static/basic")), false);
});

test("discovery never lists .publish-staging or .publish-previous as themes", async () => {
  const fixture = await makeFixture();
  const entity = await packAndStage(fixture);
  await handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: "key-discover" });
  await mkdir(path.join(fixture.destThemes, ".publish-staging", "leftover"), { recursive: true });
  const ids = discoverAllBuiltInThemes({ dir: fixture.destThemes, source: "site" }).map((t) => t.manifest.id);
  assert.deepEqual(ids, ["basic"]);
});

// ---------------------------------------------------------------------------
// End-to-end local round trip: pack -> plan -> apply on a fake peer site dir
// ---------------------------------------------------------------------------

function planDeps(fixture: Fixture, forced?: ReadonlySet<string>) {
  return {
    publishContentDeps: fixture.deps,
    getBaseline: async () => null,
    hasBlob: async () => true,
    ...(forced ? { forcedEntityKeys: forced } : {}),
  };
}

function bundleOf(entity: PackedEntity) {
  return { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities: [entity] };
}

test("round trip: a destination still equal to its original plans 'applied', and apply lands the source files", async () => {
  const fixture = await makeFixture();
  registerPublishContentContributor(contributeThemeFilesPublish());
  const entity = await packAndStage(fixture);

  const report = await planImport(bundleOf(entity), planDeps(fixture));
  assert.deepEqual(report.rows, [
    { entityType: "theme-files", entityId: "static/basic", entityLabel: "Theme: static/basic", outcome: "applied", writes: true, reason: null, canOverwrite: false, retires: null },
  ]);

  await handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: "key-rt" });
  assert.deepEqual(await readTree(path.join(fixture.destThemes, "static/basic")), SOURCE_BASIC);
  const replanned = await planImport(bundleOf(entity), planDeps(fixture));
  assert.equal(replanned.rows[0].outcome, "unchanged");
});

test("round trip: a theme edited on live plans 'conflict' offered as an overwrite; forcing it replaces the tree and keeps .publish-previous", async () => {
  const edited = { ...ORIGINAL_BASIC, "render/partials/nav.html": "<nav>edited on live</nav>" };
  const fixture = await makeFixture({ destFiles: edited });
  registerPublishContentContributor(contributeThemeFilesPublish());
  const entity = await packAndStage(fixture);

  const report = await planImport(bundleOf(entity), planDeps(fixture));
  assert.equal(report.rows[0].outcome, "conflict");
  assert.equal(report.rows[0].writes, false);
  assert.equal(report.rows[0].canOverwrite, true);
  assert.equal(report.rows[0].reason, "no prior sync baseline for theme-files 'static/basic' with this peer — the destination already holds different content");

  const forcedReport = await planImport(bundleOf(entity), planDeps(fixture, new Set([entityKey("theme-files", "static/basic")])));
  assert.equal(forcedReport.rows[0].outcome, "forced");
  assert.equal(forcedReport.rows[0].writes, true);

  await handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: "key-forced" });
  assert.deepEqual(await readTree(path.join(fixture.destThemes, "static/basic")), SOURCE_BASIC);
  const [previousKey] = await readdir(path.join(fixture.destThemes, ".publish-previous"));
  assert.deepEqual(await readTree(path.join(fixture.destThemes, ".publish-previous", previousKey, "static/basic")), edited);
});

// ---------------------------------------------------------------------------
// in-memory theme refresh (2026-09-24 live bug: assets updated, rendered header stayed old)
// ---------------------------------------------------------------------------

/** Records what `static/basic/render/partials/nav.html` held on disk each time the handler asked the
 *  running site to re-read its themes — the renderer serves `DiscoveredTheme.partials` from memory. */
function recordReloads(fixture: Fixture): string[] {
  const seen: string[] = [];
  (fixture.deps.ports["theme-files"] as { onReplaced?: () => Promise<void> }).onReplaced = async () => {
    seen.push(await readFile(path.join(fixture.destThemes, "static/basic/render/partials/nav.html"), "utf8").catch(() => "<missing>"));
  };
  return seen;
}

test("apply() asks the running site to re-read its themes after the swap, so new partials render", async () => {
  const fixture = await makeFixture();
  const seen = recordReloads(fixture);
  const entity = await packAndStage(fixture);
  await handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: "key-reload" });
  assert.deepEqual(seen, ["<nav>new header</nav>"]);
});

test("rollback asks the running site to re-read its themes again, so the restored partials render", async () => {
  const fixture = await makeFixture();
  const seen = recordReloads(fixture);
  const entity = await packAndStage(fixture);
  fixture.changeSets.insert = async () => {
    throw new Error("change-set store is down");
  };
  await assert.rejects(
    handlerFor(fixture.deps).apply({ entity, expectedVersion: 0, principalId: OPERATOR_ID, idempotencyKey: "key-reload-rollback" }),
    /change-set store is down/
  );
  assert.equal(seen.at(-1), "<nav>original header</nav>");
});
