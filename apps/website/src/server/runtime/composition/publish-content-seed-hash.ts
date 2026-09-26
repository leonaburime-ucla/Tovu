import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClockPort, IdGeneratorPort } from "@jini-ai/cms/core";

import { SqliteMenuRepo } from "#src/features/navigation/repo.sqlite";
import { SqlitePostRepo } from "#src/features/post/index";
import { createPublishContentSeedHash, type PublishContentSeedHashFn } from "#src/features/publish-content/seed-hash";
import { SqliteRedirectRepo, type RedirectsWriteDeps } from "#src/features/redirects/index";
import { buildContentPublishPorts } from "#src/features/publish-content/content-ports";
import { SqliteFormDefinitionRepo } from "#src/features/forms/repo.sqlite";
import { SqliteContentTypeRepo } from "#src/features/content-types/repo.sqlite";
import { SqliteTaxonomyRepo, SqliteTermRepo } from "#src/features/taxonomy/repo.sqlite";
import { openContentDb } from "#src/platform/db/sqlite/content-db";
import { SqliteMediaRepo } from "#src/platform/db/sqlite/media-repo.sqlite";

/**
 * @file The SQLite composition root's D1 seed-version lookup: `features/publish-content/seed-hash.ts`
 * over the stock `content.seed.db` this instance was hydrated from
 * (`builtInContentSeedDbPath()`, the same file `hydrateContentDbFromSeed()` copied into `content.db`
 * on first boot).
 *
 * Why a migrated COPY, not the shipped file read-only: the live `content.db` is "seed + every
 * migration since", and the repos below query the CURRENT schema. Opening the seed read-only would
 * hand a newer repo an older schema; migrating the shipped file in place would mutate a stock build
 * artifact. Copying it to a private temp file and running the ordinary `openContentDb()` migration
 * on the copy reproduces exactly what an untouched live row looks like today — so its hash is
 * comparable with the live row's hash by construction. The copy happens once per process, on the
 * first import plan, never at boot.
 */

export interface CreateSqlitePublishContentSeedHashInput {
  /** `builtInContentSeedDbPath()` — absent on any install that ships no seed (answers `null`). */
  readonly seedDbPath: string;
  /** The live workspace id. The live `content.db` IS the seed plus edits, so ids agree; a seed from
   *  another workspace simply finds nothing and every row stays a `conflict`. */
  readonly workspaceId: string;
  readonly clock: ClockPort;
  readonly idGen: IdGeneratorPort;
  /** The live bag, reused only for its non-repo fields; `repo`/`db` are swapped for the seed's. The
   *  redirect handler's `inspect()` reads nothing but `repo`. */
  readonly redirectsWriteDeps: RedirectsWriteDeps;
}

/**
 * A port {@link PublishContentPorts} requires present but which this lookup's own callers
 * (`inspect()` on every registered handler) never actually invoke — `media.assetBlobRepo`/
 * `.blobStore` and `menu.bindingRepo` fall in this bucket (see the field comments above the ports
 * bag below for which handler reads which field). Throws loudly if that assumption is ever wrong,
 * rather than silently returning wrong data.
 * @complexity O(1).
 */
function unusedBySeedInspect<T extends object>(label: string): T {
  return new Proxy(
    {},
    {
      get(): never {
        throw new Error(`publish-content-seed-hash: '${label}' was read by an inspect() call, but this seed lookup never wires it for real use`);
      },
    }
  ) as T;
}

/**
 * @complexity O(1) to create. The first lookup copies and migrates the seed (O(seed bytes)); every
 *   later lookup is one indexed read.
 */
export function createSqlitePublishContentSeedHash(input: CreateSqlitePublishContentSeedHashInput): PublishContentSeedHashFn {
  return createPublishContentSeedHash({
    loadSeedDeps: () => {
      if (!existsSync(input.seedDbPath)) return null;
      const copyPath = join(mkdtempSync(join(tmpdir(), "tovu-publish-seed-")), "content.seed.db");
      copyFileSync(input.seedDbPath, copyPath);
      const seedDb = openContentDb(copyPath);
      const redirectRepo = new SqliteRedirectRepo(seedDb);
      const seedPostRepo = new SqlitePostRepo(seedDb);
      const { workspaceId } = input;
      return {
        workspaceId: input.workspaceId,
        clock: input.clock,
        idGen: input.idGen,
        // F2 — one ports bag. Only the ports each registered type's `inspect()` actually reads need
        // real seed-backed instances (see this file's own header: "the redirect handler's `inspect()`
        // reads nothing but `repo`" is one example of this already being partial by design). The
        // fields `PublishContentPorts` requires but no `inspect()` reads get a throwing stand-in
        // ({@link unusedBySeedInspect}) instead of a real instance, so a future handler that DOES
        // start reading one fails loudly here rather than silently hashing against the wrong store.
        ports: {
          post: { repo: seedPostRepo },
          media: {
            repo: new SqliteMediaRepo(seedDb),
            assetBlobRepo: unusedBySeedInspect("media.assetBlobRepo"),
            blobStore: unusedBySeedInspect("media.blobStore"),
          },
          menu: { repo: new SqliteMenuRepo(seedDb), bindingRepo: unusedBySeedInspect("menu.bindingRepo") },
          redirect: { ...input.redirectsWriteDeps, repo: redirectRepo, db: redirectRepo },
          ...buildContentPublishPorts({
            formDefinitionRepo: new SqliteFormDefinitionRepo(seedDb),
            contentTypeRepo: new SqliteContentTypeRepo(seedDb),
            contentTypeIndexProvisioner: unusedBySeedInspect("contentTypeIndexProvisioner"),
            workspaceId,
            postRepo: seedPostRepo,
            taxonomyRepo: new SqliteTaxonomyRepo({ db: seedDb, workspaceId }),
            termRepo: new SqliteTermRepo({ db: seedDb, workspaceId }),
            entryTermRepo: unusedBySeedInspect("entryTermRepo"),
            taxonomyRevisionRepo: unusedBySeedInspect("taxonomyRevisionRepo"),
            stampWatermark: () => unusedBySeedInspect<{ call: never }>("stampWatermark").call,
          }),
        },
      };
    },
  });
}
