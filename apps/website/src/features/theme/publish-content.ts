import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

import { executeCommand } from "@jini-ai/cms/core";

import { computeBlobStorageKey, type BlobStorePort } from "#src/features/media/index";
import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import { contentHash, CONTENT_HASH_VERSION } from "#src/features/publish-content/content-hash";
import {
  checkTreeFiles,
  checkTreePath,
  isIgnoredTreeFileName,
  MAX_SECRET_SCAN_BYTES,
  normalizeMode,
  resolveTreeRelativePath,
  wrapTreePolicyReason,
  type FileTreeFileInput,
} from "#src/features/publish-content/file-tree-policy";
import type { FileBlobIndexPort } from "#src/features/publish-content/file-blob-index";
import type {
  PackedEntity,
  PublishContentContributor,
  PublishContentDeps,
  PublishContentHandler,
  SkippedPackEntity,
} from "#src/features/publish-content/type-registry";

import { MIGRATION_STAGING_DIR_PREFIX, PUBLISH_PREVIOUS_DIR, PUBLISH_STAGING_DIR, THEME_CATALOG_DIR } from "./theme.js";
import { isGeneratedThemePath } from "./theme-files.js";

/**
 * @file `publish-files-plan-2026-09-24.md` §6 S-F3/S-F4 — `theme-files`'s publish-content
 * contribution: the SOURCE half (`pack()`) and the DESTINATION half (`inspect`, `seedHash`,
 * `precheck`, and `apply`'s stage/verify/swap under the themes root's `.publish-staging`).
 * Mirrors `features/media/publish-content.ts`/`features/redirects/publish-content.ts` exactly: a DATA
 * export (`{entityType, dependsOn, build}`) that imports only `type-registry.ts`'s TYPES, never
 * `registerPublishContentContributor` itself — see `type-registry.ts`'s own header for why a value
 * edge here would reopen a real module cycle.
 *
 * `dependsOn` is empty — no other publish-content type depends on a theme's own file tree, and a
 * theme depends on nothing else either.
 *
 * ## What "the tree" means here, and where each exclusion actually lives
 *
 * A theme tree is `<themesDir>/<tier>/<id>/**` for `tier` in {@link THEME_FILE_TREE_TIERS} — a
 * deliberate narrowing to 3 of `theme.ts`'s 4 `ENGINE_SUBFOLDERS` (never `handlebars`, per the plan's
 * own inventory table; flagged, not silently overridden, by the S17 handoff this file continues from).
 * `__original-themes__`/`__marketplace__`/a bare root `README.md` never need an explicit exclusion
 * here at all: both catalog dirs and the themes-root `README.md` are SIBLINGS of `static/`/
 * `templated/`/`declarative/` (`theme.ts`'s own `discoverAllBuiltInThemes` scans them at the themes
 * ROOT, separately from each engine subfolder) — walking `themesDir/<tier>/*` for theme ids never
 * reaches any of them. What DOES land inside a tier folder is `MIGRATION_STAGING_DIR_PREFIX` scratch
 * output (a migration's staging dir is a SIBLING of the real theme folder it is migrating, i.e. inside
 * the same tier) — {@link discoverThemeTreeDirs} skips it by the same prefix `discoverThemes` itself
 * checks. Generated build output INSIDE a real theme's own tree (`preview/**`, root `index.html`) is
 * excluded per-file by {@link isGeneratedThemePath} while walking that one tree.
 *
 * ## Why a blocked tree is reported once, for the whole tree, not per file
 *
 * `checkTreeFiles` (`file-tree-policy.ts`) already returns one reason for the first offending file in
 * a tree — see that module's own header for why a tree is never silently trimmed. This file just
 * prefixes that reason with `"<title> was not published: "`, the exact prefixing S17's handoff flagged
 * as this slice's job (`file-tree-policy.ts`'s own header deliberately leaves the title out).
 *
 * ## `packThemeFilesEntities` is exported in its own right
 *
 * `PublishContentHandler.pack()` is a bare `AsyncIterable<PackedEntity>` with no channel to report a
 * blocked tree — {@link pack} below silently does not yield one. A caller (today, only this module's
 * own test) that needs to see WHY a tree did not travel calls {@link packThemeFilesEntities} directly,
 * which is the one real implementation `pack()` is a thin wrapper over.
 */

/** No other type depends on a theme's own files, and a theme depends on nothing else. */
const THEME_FILES_DEPENDS_ON: readonly string[] = [];

/** §1's inventory table, narrowed to 3 of `theme.ts`'s 4 `ENGINE_SUBFOLDERS` — see this file's own
 *  header for the deliberate `handlebars` omission. */
const THEME_FILE_TREE_TIERS: readonly string[] = ["static", "templated", "declarative"];

/** One theme tree {@link discoverThemeTreeDirs} found on disk, not yet packed. */
interface ThemeTreeLocation {
  readonly tier: string;
  readonly id: string;
  readonly absDir: string;
}

/** @complexity O(1). */
function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Every theme tree currently on disk under {@link THEME_FILE_TREE_TIERS} — directory NAMES only, no
 * manifest is loaded and no theme.json is parsed here (that happens implicitly: `theme.json` is just
 * another file {@link walkThemeTree} packs). A missing tier folder is treated as empty, mirroring
 * `discoverThemes`'s own "missing dir -> no themes there yet" convention.
 *
 * @complexity O(entries under each tier folder), 3 `readdir` calls.
 */
async function discoverThemeTreeDirs(themesDir: string): Promise<readonly ThemeTreeLocation[]> {
  const found: ThemeTreeLocation[] = [];
  for (const tier of THEME_FILE_TREE_TIERS) {
    const tierDir = path.join(themesDir, tier);
    let entries;
    try {
      entries = await readdir(tierDir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(MIGRATION_STAGING_DIR_PREFIX)) continue;
      if (!entry.isDirectory()) continue;
      found.push({ tier, id: entry.name, absDir: path.join(tierDir, entry.name) });
    }
  }
  return found.sort((a, b) => (a.tier === b.tier ? a.id.localeCompare(b.id) : a.tier.localeCompare(b.tier)));
}

/** One real file {@link walkThemeTree} found and read. `textSample` is the whole file decoded as
 *  UTF-8 when it is small enough to be worth scanning ({@link MAX_SECRET_SCAN_BYTES}) — `checkTreeFiles`
 *  itself decides, per extension, whether to actually scan it; handing every small file's text through
 *  unconditionally is harmless for a binary one (its extension is simply never in that check's
 *  text-like set) and avoids this walker having to duplicate that set. */
interface WalkedThemeFile {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly sha256: string;
  readonly absPath: string;
  readonly textSample?: string;
}

/**
 * Recursively collects every real, publishable-candidate file under one theme tree. Symlinks (to a
 * file or a directory) are never followed and never appear in the result — silently, the same "not
 * part of the tree at all" treatment {@link isGeneratedThemePath} paths get, since neither is a
 * anomaly worth a per-file report (contrast a DENY-LISTED file, which `checkTreeFiles` blocks the
 * WHOLE tree for — see this file's header). A generated path is excluded the same way, per-file,
 * before it is ever read.
 *
 * @complexity O(entries under `absTreeDir`) filesystem calls plus O(bytes) to hash/read each
 *   surviving file; recursion depth is the tree's own folder depth.
 */
async function walkThemeTree(absTreeDir: string): Promise<readonly WalkedThemeFile[]> {
  const files: WalkedThemeFile[] = [];

  async function recurse(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      const relPath = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue; // never followed, never part of the tree.
      // OS junk (macOS's `.DS_Store`, `.Spotlight-V100`, `.Trashes`, AppleDouble `._*`; Windows'
      // `Thumbs.db`/`desktop.ini`) is excluded HERE, at the source of the file list every downstream
      // consumer (state, upload, contentHash, `inspect()`'s live re-hash) builds from — never a
      // whole-tree DENY (`file-tree-policy.ts`'s own header on `isIgnoredTreeFileName`).
      if (isIgnoredTreeFileName(entry.name)) continue;
      if (entry.isDirectory()) {
        await recurse(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue; // a socket, fifo, or other non-regular entry — never a theme file.
      if (isGeneratedThemePath(relPath)) continue; // regenerated on every build; never real source.

      const info = await lstat(absPath);
      if (info.isSymbolicLink() || !info.isFile()) continue; // defends a TOCTOU swap between readdir and here.
      const bytes = await readFile(absPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const mode = normalizeMode(info.mode);
      files.push({
        path: relPath,
        size: bytes.length,
        mode,
        sha256,
        absPath,
        textSample: bytes.length <= MAX_SECRET_SCAN_BYTES ? bytes.toString("utf8") : undefined,
      });
    }
  }

  await recurse(absTreeDir, "");
  return files;
}

/** One tree {@link packOneThemeTree} could not pack — the WHOLE tree, never a per-file entry (this
 *  file's own header). */
export interface SkippedThemeTree {
  readonly treeKey: string;
  readonly reason: string;
}

/** @complexity O(1). */
function treeTitle(treeKey: string): string {
  return `Theme: ${treeKey}`;
}

/** @complexity O(n log n) in `files.length`. */
function sortByPath<T extends { readonly path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The one `state` shape both sides hash (plan §0): the source's `pack()` and the destination's
 * `inspect()`/`seedHash()`/staged-tree check. One builder, so a tree that is byte-identical on both
 * machines always hashes identically. `files` must already be sorted by path.
 *
 * @complexity O(files).
 */
function buildTreeState(
  treeKey: string,
  sortedFiles: readonly { readonly path: string; readonly sha256: string; readonly size: number; readonly mode: number }[]
): Record<string, unknown> {
  const files = sortedFiles.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size, mode: file.mode }));
  return { title: treeTitle(treeKey), kind: "theme-files", treeKey, files };
}

/**
 * Packs ONE theme tree into a {@link PackedEntity}, or reports why it was left out — the per-tree unit
 * both {@link packThemeFilesEntities} and (indirectly, via that function) `pack()` build on.
 *
 * Order matches `file-tree-policy.ts` §2: the tree's id shape is checked first (this module's own
 * concern — {@link resolveTreeRelativePath} is the same validator every other file-tree kind shares),
 * then {@link checkTreeFiles} runs the full allow-list/deny-list/cap/secret-scan pass over every file
 * the walk found. Only once both pass does this record entries into `fileBlobIndex` — a blocked tree's
 * files are never indexed, so a rejected tree can never be served to a peer by sha alone.
 *
 * @complexity O(files under the tree) — one walk, one policy pass, one sort, one hash.
 */
async function packOneThemeTree(input: {
  readonly tier: string;
  readonly id: string;
  readonly absDir: string;
  readonly fileBlobIndex?: FileBlobIndexPort;
}): Promise<{ entity: PackedEntity } | { skippedTree: SkippedThemeTree }> {
  const treeKey = `${input.tier}/${input.id}`;
  const title = treeTitle(treeKey);

  if (resolveTreeRelativePath("theme-files", [input.tier, input.id]) === null) {
    return { skippedTree: { treeKey, reason: `${title} was not published: '${treeKey}' is not a valid theme tree address` } };
  }

  const walked = await walkThemeTree(input.absDir);
  const policyInputs: FileTreeFileInput[] = walked.map((file) => ({
    path: file.path,
    size: file.size,
    mode: file.mode,
    textSample: file.textSample,
  }));
  const blockReason = checkTreeFiles("theme-files", policyInputs);
  if (blockReason) {
    return { skippedTree: { treeKey, reason: wrapTreePolicyReason(title, blockReason) } };
  }

  const sortedFiles = sortByPath(walked);
  const state = buildTreeState(treeKey, sortedFiles);

  for (const file of sortedFiles) {
    input.fileBlobIndex?.set(file.sha256, { absPath: file.absPath, size: file.size });
  }

  return {
    entity: {
      entityType: "theme-files",
      id: treeKey,
      schemaVersion: 1,
      contentHash: contentHash("theme-files", state),
      hashVersion: CONTENT_HASH_VERSION,
      requiredBlobs: sortedFiles.map((file) => file.sha256),
      state,
    },
  };
}

/**
 * Every theme tree on this machine, packed or reported as skipped — the one real implementation
 * `pack()` below wraps. Exported so a caller (today, this module's own test) can see WHY a tree did
 * not travel, a channel `PublishContentHandler.pack()`'s bare `AsyncIterable` has no room for (this
 * file's own header).
 *
 * @complexity O(trees) sequential `packOneThemeTree` calls (each already documented above).
 */
export async function packThemeFilesEntities(input: {
  readonly themesDir: string;
  readonly fileBlobIndex?: FileBlobIndexPort;
}): Promise<{ entities: readonly PackedEntity[]; skipped: readonly SkippedThemeTree[] }> {
  const trees = await discoverThemeTreeDirs(input.themesDir);
  const entities: PackedEntity[] = [];
  const skipped: SkippedThemeTree[] = [];
  for (const tree of trees) {
    const result = await packOneThemeTree({ tier: tree.tier, id: tree.id, absDir: tree.absDir, fileBlobIndex: input.fileBlobIndex });
    if ("entity" in result) entities.push(result.entity);
    else skipped.push(result.skippedTree);
  }
  return { entities, skipped };
}

// ---------------------------------------------------------------------------
// Destination half (S-F4): inspect, seedHash, precheck, apply
// ---------------------------------------------------------------------------

/** Plan §3 step 2's one link/escape refusal, shared by `precheck()` and `apply()`. */
const LINK_REASON = "live's themes folder contains a link; nothing was written";

/** Plan §3 step 6. */
const KEEP_PREVIOUS_COPIES = 2;

/** One entity id (`"<tier>/<themeId>"`) split and validated, or `null` for anything else. */
interface ThemeTreeAddress {
  readonly tier: string;
  readonly themeId: string;
  readonly treeKey: string;
}

/**
 * Parses an entity id through the same `resolveTreeRelativePath` validator `pack()` used, so an id
 * the source could never have produced (`../x`, a 3-segment path, the `handlebars` tier) never
 * resolves to a directory here.
 *
 * @complexity O(id length).
 */
function parseTreeAddress(id: string): ThemeTreeAddress | null {
  const segments = id.split("/");
  if (segments.length !== 2) return null;
  const [tier, themeId] = segments;
  if (!THEME_FILE_TREE_TIERS.includes(tier)) return null;
  if (resolveTreeRelativePath("theme-files", [tier, themeId]) === null) return null;
  return { tier, themeId, treeKey: id };
}

/**
 * The `contentHash` of the tree at `absDir`, built exactly like `pack()` builds it, or `null` when
 * there is no real directory there. A symlinked tree root is treated as absent (never followed);
 * `precheck()` is what refuses it with a reason.
 *
 * @complexity O(files under `absDir`) reads + hashes.
 */
async function hashTreeAt(absDir: string, treeKey: string): Promise<string | null> {
  try {
    const info = await lstat(absDir);
    if (!info.isDirectory()) return null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  const walked = await walkThemeTree(absDir);
  return contentHash("theme-files", buildTreeState(treeKey, sortByPath(walked)));
}

/**
 * Plan §3 step 2: `realpath(root) === root`, and every existing component from the root down to the
 * target (plus publish's own scratch dirs) is a real directory, never a link. Also refuses a tier
 * folder on a different device than the root, since the swap's renames must stay on one filesystem
 * (no `EXDEV` half-swap). A missing root or component is fine — apply creates it.
 *
 * @complexity O(1) — at most 5 `lstat`/`stat` calls.
 */
async function checkDestinationLinks(themesDir: string, address: ThemeTreeAddress): Promise<string | null> {
  let rootReal: string;
  try {
    rootReal = await realpath(themesDir);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  if (rootReal !== path.resolve(themesDir)) return LINK_REASON;
  const rootDev = (await stat(themesDir)).dev;
  const components = [
    path.join(themesDir, address.tier),
    path.join(themesDir, address.tier, address.themeId),
    path.join(themesDir, PUBLISH_STAGING_DIR),
    path.join(themesDir, PUBLISH_PREVIOUS_DIR),
  ];
  for (const component of components) {
    let info;
    try {
      info = await lstat(component);
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return LINK_REASON;
    if (info.dev !== rootDev) return "live's themes folder spans two disks; nothing was written";
  }
  return null;
}

/** One `state.files[]` entry after shape validation. */
interface IncomingThemeFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

/**
 * Validates an incoming entity's `state` shape — the destination never trusts the source (plan §3
 * step 1). Returns the files, or a reason (without the title prefix).
 *
 * @complexity O(files).
 */
function readIncomingFiles(entity: PackedEntity): { files: readonly IncomingThemeFile[] } | { reason: string } {
  const notDescribed = { reason: `its file list does not describe '${entity.id}'` };
  const { state } = entity;
  if (state.kind !== "theme-files" || state.treeKey !== entity.id || !Array.isArray(state.files)) return notDescribed;
  const files: IncomingThemeFile[] = [];
  for (const raw of state.files as unknown[]) {
    const file = raw as Partial<IncomingThemeFile> | null;
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      typeof file.size !== "number" ||
      typeof file.mode !== "number"
    ) {
      return notDescribed;
    }
    files.push({ path: file.path, sha256: file.sha256, size: file.size, mode: normalizeMode(file.mode) });
  }
  return { files };
}

/** Reads one staged blob, or `null` when this destination never received it.
 *  @complexity O(blob size). */
async function readBlob(blobStore: BlobStorePort, workspaceId: string, sha256: string): Promise<Uint8Array | null> {
  const storageKey = computeBlobStorageKey({ workspaceId, sha256 });
  if (!(await blobStore.exists({ storageKey }))) return null;
  return blobStore.get({ storageKey });
}

/** @complexity O(bytes). */
function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Removes every previous copy of `address` beyond the newest {@link KEEP_PREVIOUS_COPIES}, newest by
 * the key folder's own mtime (ns). Housekeeping only: it runs after the swap has landed, so a failure
 * here must never fail the publish — it leaves an extra copy on disk, nothing worse.
 *
 * @complexity O(previous key folders) `stat` calls.
 */
async function prunePreviousCopies(themesDir: string, address: ThemeTreeAddress): Promise<void> {
  const previousRoot = path.join(themesDir, PUBLISH_PREVIOUS_DIR);
  try {
    const copies: { keyDir: string; mtimeNs: bigint }[] = [];
    for (const key of await readdir(previousRoot)) {
      const keyDir = path.join(previousRoot, key);
      try {
        await lstat(path.join(keyDir, address.tier, address.themeId));
      } catch {
        continue;
      }
      copies.push({ keyDir, mtimeNs: (await stat(keyDir, { bigint: true })).mtimeNs });
    }
    copies.sort((a, b) => (a.mtimeNs > b.mtimeNs ? -1 : a.mtimeNs < b.mtimeNs ? 1 : 0));
    for (const { keyDir } of copies.slice(KEEP_PREVIOUS_COPIES)) {
      await rm(path.join(keyDir, address.tier, address.themeId), { recursive: true, force: true });
      for (const emptied of [path.join(keyDir, address.tier), keyDir]) {
        await rmdir(emptied).catch(() => undefined); // still holds another tree's copy — keep it.
      }
    }
  } catch {
    // See this function's doc: never fail a landed publish over housekeeping.
  }
}

function buildHandler(deps: PublishContentDeps): PublishContentHandler {
  const entityType = "theme-files";
  const schemaVersion = 1;
  // F2 — `theme-files`' own port. `blobStore` is deliberately NOT part of it: it reuses the SAME
  // ADR-027 store instance `ports.media` carries (one composition-root singleton, threaded to both).
  const themePort = deps.ports["theme-files"];

  async function* pack(): AsyncIterable<PackedEntity> {
    // Absent the port degrades to "nothing to export" — the same convention every other optional
    // port already follows (`type-registry.ts`'s own header on `PublishContentPorts`).
    if (!themePort) return;
    const { entities } = await packThemeFilesEntities({ themesDir: themePort.themesDir, fileBlobIndex: themePort.fileBlobIndex });
    for (const entity of entities) yield entity;
  }

  /**
   * `type-registry.ts`'s `PublishContentHandler.listSkipped` — every theme tree this machine found
   * but refused to pack, for an export envelope to surface as a non-selectable, reason-carrying row.
   *
   * Re-walks every theme tree via {@link packThemeFilesEntities} rather than sharing a single pass
   * with {@link pack}: `pack()` is a bare `AsyncIterable` with no room to also report a skip (this
   * file's own header), and `PublishContentHandler` gives no caller a way to ask for both from one
   * call. The extra walk costs one more `readFile`+`sha256` pass over every already-packed file,
   * which is bounded by this machine's own theme corpus (never remote, never per-request-multiplied)
   * — accepted here rather than restructuring `pack()`'s contract for every other handler to satisfy.
   *
   * @complexity O(trees) — see {@link packThemeFilesEntities}'s own doc.
   */
  async function listSkipped(): Promise<readonly SkippedPackEntity[]> {
    if (!themePort) return [];
    const { skipped } = await packThemeFilesEntities({ themesDir: themePort.themesDir });
    return skipped.map((tree) => ({ entityType, id: tree.treeKey, label: treeTitle(tree.treeKey), reason: tree.reason }));
  }

  /** The destination's tree, hashed like `pack()` hashes it. `version` is always 0 (plan §3): the
   *  apply loop re-inspects and compares hashes before every write. */
  async function inspect(id: string): Promise<{ version: number; hash: string } | null> {
    const address = parseTreeAddress(id);
    if (!themePort || !address) return null;
    const hash = await hashTreeAt(path.join(themePort.themesDir, address.tier, address.themeId), address.treeKey);
    return hash === null ? null : { version: 0, hash };
  }

  /** What this destination was seeded with: its own `__original-themes__/<tier>/<id>` copy (plan §4). */
  async function seedHash(id: string): Promise<string | null> {
    const address = parseTreeAddress(id);
    if (!themePort || !address) return null;
    return hashTreeAt(path.join(themePort.themesDir, THEME_CATALOG_DIR, address.tier, address.themeId), address.treeKey);
  }

  /**
   * Plan §3 steps 1-2, read-only: the state's shape, the link check, then the whole
   * `file-tree-policy` pass again — including the secret scan, over the bytes that actually arrived
   * in this site's blob store (a blob not here yet is left to the planner's `hasBlob` leg).
   *
   * @complexity O(files) plus O(bytes) for the text files small enough to scan.
   */
  async function precheck(entity: PackedEntity): Promise<string | null> {
    const title = treeTitle(entity.id);
    const address = parseTreeAddress(entity.id);
    if (!address) return `${title} was not published: '${entity.id}' is not a valid theme tree address`;
    if (!themePort) return `${title} was not published: this site has no themes folder`;
    const incoming = readIncomingFiles(entity);
    if ("reason" in incoming) return `${title} was not published: ${incoming.reason}`;

    const linkReason = await checkDestinationLinks(themePort.themesDir, address);
    if (linkReason) return linkReason;

    // Reuses `ports.media`'s blob store — the SAME ADR-027 instance a composition root threads to
    // both (see this function's own header comment above `buildHandler`). `theme-files` has no blob
    // store of its own; a caller with `themesDir` wired but no `media` port simply skips this scan.
    const blobStore = deps.ports.media?.blobStore;
    const policyInputs: FileTreeFileInput[] = [];
    for (const file of incoming.files) {
      let textSample: string | undefined;
      if (blobStore && file.size <= MAX_SECRET_SCAN_BYTES && checkTreePath(file.path) === null) {
        const bytes = await readBlob(blobStore, deps.workspaceId, file.sha256);
        if (bytes && bytes.length <= MAX_SECRET_SCAN_BYTES) textSample = Buffer.from(bytes).toString("utf8");
      }
      policyInputs.push({ path: file.path, size: file.size, mode: file.mode, textSample });
    }
    const policyReason = checkTreeFiles("theme-files", policyInputs);
    return policyReason ? wrapTreePolicyReason(title, policyReason) : null;
  }

  /**
   * Plan §3 steps 3-6, inside `executeCommand` (permission `theme.set`): stage every file into
   * `<themesDir>/.publish-staging/<keyHash>/` (`O_CREAT|O_EXCL|O_NOFOLLOW`, normalized mode, sha
   * re-verified), hash the staged tree against `entity.contentHash`, then swap with two renames —
   * the old tree to `<themesDir>/.publish-previous/<keyHash>/<tier>/<id>`, the staged tree into
   * place. Staging and previous copies live under the SAME themes root as the target, so both
   * renames stay on one filesystem. Any failure before the swap removes the staging folder and
   * leaves the old tree serving; `rollback` (a change-set record failing after the swap) moves the
   * old tree back.
   *
   * @complexity O(files) blob reads + writes, one staged-tree hash pass, O(previous copies) pruning.
   */
  async function apply(input: {
    entity: PackedEntity;
    expectedVersion: number | undefined;
    principalId: string;
    idempotencyKey: string;
  }): Promise<{ changeSetId: string }> {
    const { changeSets, authorize, outbox } = deps;
    const blobStore = deps.ports.media?.blobStore;
    const themesDir = themePort?.themesDir;
    if (!changeSets || !authorize || !outbox || !blobStore || !themesDir) {
      throw new Error(
        "publish-content: theme-files.apply() requires PublishContentDeps.changeSets/authorize/outbox, " +
          "ports.media.blobStore and ports['theme-files'].themesDir — wire them from the real " +
          "apply-loop composition root (features/publish-content/apply-loop.ts)."
      );
    }
    const { entity } = input;
    const title = treeTitle(entity.id);
    const address = parseTreeAddress(entity.id);
    const keyHash = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);
    const stagingRoot = path.join(themesDir, PUBLISH_STAGING_DIR);
    const stagingDir = path.join(stagingRoot, keyHash);
    const target = address ? path.join(themesDir, address.tier, address.themeId) : "";
    const previousPath = address ? path.join(themesDir, PUBLISH_PREVIOUS_DIR, keyHash, address.tier, address.themeId) : "";
    let swapped: { previous: string | null } | null = null;

    const blocked = (reason: string): never => {
      throw new PublishContentApplyRowError("blocked", reason);
    };

    async function stageFiles(files: readonly IncomingThemeFile[]): Promise<void> {
      await mkdir(stagingRoot, { recursive: true });
      await rm(stagingDir, { recursive: true, force: true }); // a crashed earlier attempt under this same key.
      await mkdir(stagingDir);
      for (const file of files) {
        const bytes = await readBlob(blobStore!, deps.workspaceId, file.sha256);
        if (!bytes) blocked(`${title} was not published: the bytes for "${file.path}" never reached this site`);
        if (sha256Of(bytes!) !== file.sha256) blocked(`${title} was not published: the bytes for "${file.path}" do not match their checksum`);
        const abs = path.join(stagingDir, ...file.path.split("/"));
        await mkdir(path.dirname(abs), { recursive: true });
        const handle = await open(abs, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, file.mode);
        try {
          await handle.writeFile(bytes!);
        } finally {
          await handle.close();
        }
        await chmod(abs, file.mode); // `open`'s mode is masked by the process umask.
      }
      if ((await hashTreeAt(stagingDir, entity.id)) !== entity.contentHash) {
        blocked(`${title} was not published: the copy written on this site does not match what was sent`);
      }
    }

    async function swapIntoPlace(): Promise<{ previous: string | null }> {
      await mkdir(path.dirname(target), { recursive: true });
      let hadTarget = true;
      try {
        await lstat(target);
      } catch (err) {
        if (!isMissing(err)) throw err;
        hadTarget = false;
      }
      if (hadTarget) {
        await rm(previousPath, { recursive: true, force: true });
        await mkdir(path.dirname(previousPath), { recursive: true });
        await rename(target, previousPath);
      }
      try {
        await rename(stagingDir, target);
      } catch (err) {
        if (hadTarget) await rename(previousPath, target);
        throw err;
      }
      return { previous: hadTarget ? previousPath : null };
    }

    const { changeSetId } = await executeCommand({
      deps: { clock: deps.clock, idGen: deps.idGen, changeSets, outbox, authorize },
      command: {
        workspaceId: deps.workspaceId,
        actor: { id: input.principalId, kind: "user" as const },
        summary: `Publish ${title} via publish-content`,
        permission: "theme.set",
        idempotencyKey: input.idempotencyKey,
      },
      mutation: {
        entityType,
        entityId: entity.id,
        operation: input.expectedVersion === undefined ? "create" : "update",
        // The tree this publish replaces is kept on disk, not in the ledger — the inverse names where.
        captureInverse: async () => ({ treeKey: entity.id, previousPath: previousPath || null }),
        execute: async (): Promise<{ previous: string | null }> => {
          // Authoritative re-check inside the gateway, after `authorize` (same order as media).
          const reason = await precheck(entity);
          if (reason) blocked(reason);
          const incoming = readIncomingFiles(entity);
          if ("reason" in incoming) return blocked(`${title} was not published: ${incoming.reason}`);
          try {
            await stageFiles(incoming.files);
            swapped = await swapIntoPlace();
          } catch (err) {
            await rm(stagingDir, { recursive: true, force: true });
            throw err;
          }
          await prunePreviousCopies(themesDir, address!);
          // The renderer serves partials/pages from memory, not disk — re-read them now.
          await themePort?.onReplaced?.();
          return swapped;
        },
        captureEntityVersion: () => 0,
        rollback: async () => {
          if (!swapped) return;
          const discard = `${stagingDir}.rollback`;
          await rename(target, discard);
          if (swapped.previous) await rename(swapped.previous, target);
          await rm(discard, { recursive: true, force: true });
          await themePort?.onReplaced?.();
        },
      },
    });
    return { changeSetId };
  }

  return {
    entityType,
    schemaVersion,
    // Theme content's own existing write permission (`features/theme/agent-tools.ts`,
    // `routes/themes/*`) — never a flat transport-wide permission, per
    // `PublishContentHandler.permission`'s own contract.
    permission: "theme.set",
    dependsOn: THEME_FILES_DEPENDS_ON,
    pack,
    inspect,
    precheck,
    apply,
    seedHash,
    listSkipped,
  };
}

/**
 * `theme-files`'s publish-content contribution. Called from a composition root
 * (`server/runtime/composition/publish-content-manifest.ts`), NOT from within `features/theme` itself
 * — see this file's header.
 */
export function contributeThemeFilesPublish(): PublishContentContributor {
  return { entityType: "theme-files", dependsOn: THEME_FILES_DEPENDS_ON, build: buildHandler };
}
