import { executeCommand } from "@jini-ai/cms/core";
import type { JsonObject } from "@jini-ai/cms/core";

import { PublishContentApplyRowError } from "./apply-errors.js";
import { contentHash, CONTENT_HASH_VERSION } from "./content-hash.js";
import { addressHeldByOther, changedSincePlan, notWired, trashedAtDestination } from "./precheck-reasons.js";
import type { PackedEntity, PublishContentContributor, PublishContentDeps, PublishContentHandler } from "./type-registry.js";

/**
 * @file Slice F1 of `ADS-memory/.local-artifacts/plan-publish-all-types-2026-09-25.md` (§2): the
 * generic `PublishContentHandler` factory. It owns what every repo-backed handler (post/page, media,
 * menu, redirect) repeats: the trash skip on pack, the second-address and trashed-destination
 * prechecks, the three version (CAS) checks at apply, domain-error-to-row-outcome mapping, and the
 * optional `executeCommand` wrapping with compensating rollback. A type supplies only a config.
 *
 * Imports only `type-registry.ts` TYPES plus the zero-import helpers, the same dependency shape as a
 * hand-written `features/<type>/publish-content.ts`, so a config built on it sits at the same place in
 * the module graph (see `type-registry.ts`'s header for the cycle this avoids).
 */

/** `"transferred"` is packed and hashed; `"provenance"` is packed but not hashed (a value the
 *  destination cannot be made to hold identically); `"local"` never leaves the row. */
export type FieldDisposition = "transferred" | "provenance" | "local";

type ErrorClass = abstract new (...args: never[]) => Error;

/** What {@link RepoPublishTypeConfig.write} and `undo` receive. `existing` is the destination row,
 *  already version-checked. */
export interface RepoWriteContext<Row, Ports> {
  readonly ports: Ports;
  readonly deps: PublishContentDeps;
  readonly workspaceId: string;
  readonly id: string;
  readonly state: Record<string, unknown>;
  readonly existing: Row | null;
  readonly expectedVersion: number | undefined;
  readonly principalId: string;
}

/** What `write` may return. `version` is the row's version after the write (the change set's revert
 *  guard when `undo` is set); other fields pass through on `apply()`'s result (media's `blobWritten`). */
export interface RepoWriteResult {
  readonly changeSetId?: string;
  readonly version?: number;
  readonly [extra: string]: unknown;
}

/** One publishable type's config for {@link createRepoPublishHandler} (plan §2.1). */
export interface RepoPublishTypeConfig<Row, Ports> {
  readonly entityType: string;
  /** Defaults to 1. */
  readonly schemaVersion?: number;
  /** The type's own write permission: the handler's `permission` and, with `undo`, the command's. */
  readonly permission: string;
  /** Types that must apply first. Only references the destination validates at write time. */
  readonly dependsOn?: readonly string[];

  /** `undefined` = not wired on this instance: pack yields nothing, inspect is `null`, precheck
   *  refuses, apply throws. */
  readonly ports: (deps: PublishContentDeps) => Ports | undefined;
  readonly list: (ports: Ports, workspaceId: string) => Promise<readonly Row[]>;
  /** Must also return a trashed row, so precheck can refuse it rather than plan a create. */
  readonly find: (ports: Ports, workspaceId: string, id: string) => Promise<Row | null>;
  /** Defaults to `row.id`. */
  readonly idOf?: (row: Row) => string;
  /** Defaults to `row.version`. */
  readonly versionOf?: (row: Row) => number;
  /** Pack filter beyond trash (kind, active status, excluded keys). */
  readonly include?: (row: Row) => boolean;
  /** Pack skips a trashed row; precheck refuses a trashed destination row. */
  readonly isTrashed?: (row: Row) => boolean;
  /** e.g. parent-first for a tree-shaped type. */
  readonly packOrder?: (rows: readonly Row[]) => readonly Row[];

  /** Every field of `Row`, so a new column fails to compile until classified. */
  readonly fields: Record<Extract<keyof Row, string>, FieldDisposition>;
  /** Only for a MIGRATED type whose existing `contentHash` must stay byte-identical (plan §7): replaces
   *  the default hash input (the `"transferred"` fields). A new type never sets it. */
  readonly legacyHashState?: (row: Row, packedState: Record<string, unknown>) => Record<string, unknown>;
  /** Defaults to `[]`. */
  readonly requiredBlobs?: (row: Row) => readonly string[];

  /** A second unique address (slug, key, name). Precheck refuses when `holder` returns a row with a
   *  different `idOf`. An empty value is not checked. */
  readonly address?: {
    readonly field: string;
    readonly holder: (ports: Ports, workspaceId: string, value: string, state: Record<string, unknown>) => Promise<Row | null>;
  };
  /** Type-specific refusals, after the generic ones. Returns a reason or `null`. */
  readonly validate?: (input: { ports: Ports; workspaceId: string; entity: PackedEntity; existing: Row | null }) => Promise<string | null>;

  /** The one write. Throws domain errors, which `errors` maps. Without `undo`, a returned
   *  `changeSetId` is the report's (else the packed id); with `undo`, the gateway's id wins. */
  readonly write: (ctx: RepoWriteContext<Row, Ports>) => Promise<RepoWriteResult | void>;
  /** When set, `write` runs inside `executeCommand` (inverse = the prior row; rollback = `restore`
   *  or, for a create, `remove`). When unset, the domain write keeps its own revision (redirect, menu). */
  readonly undo?: {
    readonly restore: (ctx: RepoWriteContext<Row, Ports>, prior: Row) => Promise<void>;
    readonly remove: (ctx: RepoWriteContext<Row, Ports>) => Promise<void>;
    /** Defaults to `Import <type> '<id>' via publish-content`. `ctx.existing` is not read yet. */
    readonly summary?: (ctx: RepoWriteContext<Row, Ports>) => string | Promise<string>;
  };
  /** `blocked` keeps the error's message; `conflict` wraps it in {@link changedSincePlan}. Anything
   *  else rethrows and aborts the run. */
  readonly errors?: { readonly blocked?: readonly ErrorClass[]; readonly conflict?: readonly ErrorClass[] };

  /** Type-specific handler methods, passed through unchanged. */
  readonly extend?: (ctx: { deps: PublishContentDeps; ports: () => Ports | undefined }) => Partial<
    Pick<PublishContentHandler, "planRetire" | "retire" | "referencesTo" | "repointReferences" | "seedHash" | "listSkipped">
  >;
}

/** For a `write` that calls a domain service which runs its own `executeCommand` (no `undo`): the
 *  gateway deps that service needs, or a loud error naming the missing ones. The apply bag
 *  (`apply-loop.ts`'s `PublishContentApplyDeps`) always carries them. */
export function gatewayDeps(deps: PublishContentDeps, entityType: string) {
  const { clock, idGen, changeSets, authorize, outbox } = deps;
  if (!changeSets || !authorize || !outbox) {
    throw new Error(`publish-content: ${entityType}.apply() requires PublishContentDeps.changeSets/authorize/outbox — wire it from the apply-loop composition root (features/publish-content/apply-loop.ts).`);
  }
  return { clock, idGen, changeSets, authorize, outbox };
}

/** Builds a `PublishContentContributor` from a {@link RepoPublishTypeConfig}. */
export function createRepoPublishHandler<Row, Ports>(config: RepoPublishTypeConfig<Row, Ports>): PublishContentContributor {
  const { entityType, permission } = config;
  const schemaVersion = config.schemaVersion ?? 1;
  const dependsOn = config.dependsOn ?? [];
  const idOf = config.idOf ?? ((row: Row) => (row as { id: string }).id);
  const versionOf = config.versionOf ?? ((row: Row) => (row as { version: number }).version);
  const fieldsWhere = (keep: (d: FieldDisposition) => boolean) =>
    Object.entries<FieldDisposition>(config.fields).filter(([, d]) => keep(d)).map(([field]) => field);
  const packedFields = fieldsWhere((d) => d !== "local");
  const hashedFields = fieldsWhere((d) => d === "transferred");

  /** Missing values become `null`, so an unset column and SQL `NULL` pack and hash alike. */
  const pick = (row: Row, fields: readonly string[]) =>
    Object.fromEntries(fields.map((field) => [field, (row as Record<string, unknown>)[field] ?? null]));
  const hashOf = (row: Row) =>
    contentHash(entityType, config.legacyHashState ? config.legacyHashState(row, pick(row, packedFields)) : pick(row, hashedFields));

  function toRowError(err: unknown, id: string): unknown {
    if (err instanceof PublishContentApplyRowError || !(err instanceof Error)) return err;
    if (config.errors?.blocked?.some((cls) => err instanceof cls)) return new PublishContentApplyRowError("blocked", err.message);
    if (config.errors?.conflict?.some((cls) => err instanceof cls)) {
      return new PublishContentApplyRowError("conflict", changedSincePlan(entityType, id, err.message));
    }
    return err;
  }

  function build(deps: PublishContentDeps): PublishContentHandler {
    const ports = () => config.ports(deps);
    const { workspaceId } = deps;

    async function* pack(): AsyncIterable<PackedEntity> {
      const p = ports();
      if (!p) return;
      const rows = (await config.list(p, workspaceId)).filter((row) => !config.isTrashed?.(row) && (config.include?.(row) ?? true));
      for (const row of config.packOrder ? config.packOrder(rows) : rows) {
        yield {
          entityType,
          id: idOf(row),
          schemaVersion,
          contentHash: hashOf(row),
          hashVersion: CONTENT_HASH_VERSION,
          requiredBlobs: config.requiredBlobs?.(row) ?? [],
          state: pick(row, packedFields),
        };
      }
    }

    async function inspect(id: string): Promise<{ version: number; hash: string } | null> {
      const p = ports();
      const row = p ? await config.find(p, workspaceId, id) : null;
      return row ? { version: versionOf(row), hash: hashOf(row) } : null;
    }

    /** Order (plan §2.2): not wired, address held, destination trashed, then `validate`. */
    async function precheck(entity: PackedEntity): Promise<string | null> {
      const p = ports();
      if (!p) return notWired(entityType, entity.id, `${entityType} ports`);
      const { address } = config;
      const value = address ? entity.state[address.field] : undefined;
      if (address && typeof value === "string" && value) {
        const holder = await address.holder(p, workspaceId, value, entity.state);
        if (holder && idOf(holder) !== entity.id) return addressHeldByOther(entityType, address.field, value, idOf(holder));
      }
      const existing = await config.find(p, workspaceId, entity.id);
      if (existing && config.isTrashed?.(existing)) return trashedAtDestination(entityType, entity.id);
      return (await config.validate?.({ ports: p, workspaceId, entity, existing })) ?? null;
    }

    async function apply(input: {
      entity: PackedEntity;
      expectedVersion: number | undefined;
      principalId: string;
      idempotencyKey: string;
    }): Promise<{ changeSetId: string }> {
      const unwired = (what: string) =>
        new Error(`publish-content: ${entityType}.apply() requires ${what} — wire it from the apply-loop composition root (features/publish-content/apply-loop.ts).`);
      const p = ports();
      if (!p) throw unwired("its ports");
      const { entity, expectedVersion } = input;
      const ctx = (existing: Row | null): RepoWriteContext<Row, Ports> => ({
        ports: p,
        deps,
        workspaceId,
        id: entity.id,
        state: entity.state,
        existing,
        expectedVersion,
        principalId: input.principalId,
      });

      /** The three CAS failures (plan §2.2 step 2), then the write with its errors mapped. */
      async function write(existing: Row | null): Promise<RepoWriteResult> {
        const found = existing ? versionOf(existing) : null;
        const mismatch =
          expectedVersion === undefined
            ? found !== null && `expected no existing row, found version ${found}`
            : found === null
              ? `expected version ${expectedVersion}, but the row is gone`
              : found !== expectedVersion && `expected version ${expectedVersion}, found version ${found}`;
        if (mismatch) throw new PublishContentApplyRowError("conflict", changedSincePlan(entityType, entity.id, mismatch));
        try {
          return (await config.write(ctx(existing))) ?? {};
        } catch (err) {
          throw toRowError(err, entity.id);
        }
      }

      const { undo } = config;
      if (!undo) {
        const written = await write(await config.find(p, workspaceId, entity.id));
        return { ...written, changeSetId: written.changeSetId ?? entity.id };
      }
      const { changeSets, authorize, outbox } = deps;
      if (!changeSets || !authorize || !outbox) throw unwired("PublishContentDeps.changeSets/authorize/outbox");

      let prior: Row | null = null;
      const { result, changeSetId } = await executeCommand<RepoWriteResult>({
        deps: { clock: deps.clock, idGen: deps.idGen, changeSets, outbox, authorize },
        command: {
          workspaceId,
          actor: { id: input.principalId, kind: "user" },
          summary: (await undo.summary?.(ctx(null))) ?? `Import ${entityType} '${entity.id}' via publish-content`,
          permission,
          idempotencyKey: input.idempotencyKey,
        },
        mutation: {
          entityType,
          entityId: entity.id,
          operation: expectedVersion === undefined ? "create" : "update",
          // Read inside the gateway so the CAS check and the inverse are the same, freshest read.
          captureInverse: async () => {
            prior = await config.find(p, workspaceId, entity.id);
            return prior ? ({ ...prior } as unknown as JsonObject) : null;
          },
          execute: () => write(prior),
          captureEntityVersion: (written) => written.version ?? null,
          rollback: () => (prior ? undo.restore(ctx(prior), prior) : undo.remove(ctx(null))),
        },
      });
      return { ...result, changeSetId };
    }

    return {
      entityType,
      schemaVersion,
      permission,
      dependsOn,
      pack,
      inspect,
      precheck,
      apply,
      ...config.extend?.({ deps, ports }),
    };
  }

  return { entityType, dependsOn, build };
}
