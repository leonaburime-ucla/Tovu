import { InMemoryChangeSetRepo } from "#src/contracts/core/commands/index";
import { InMemoryOutbox } from "#src/contracts/core/events/index";

import { PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION } from "../artifact-format.js";
import { CONTENT_HASH_VERSION } from "../content-hash.js";
import { entityKey, planImport, type PublishContentReport } from "../planner.js";
import {
  buildPublishContentCatalog,
  registerPublishContentContributor,
  resetPublishContentContributorsForTests,
  type PackedEntity,
  type PublishContentContributor,
  type PublishContentDeps,
  type PublishContentPorts,
} from "../type-registry.js";

/**
 * @file Shared round trip for a factory-built type's test: pack the source, plan against the
 * destination, apply every writing row in apply order, then plan the same bundle again. Not a test
 * file itself (no `.test.ts`), so a scoped runner never picks it up on its own.
 *
 * `registerOnly` registers exactly `contributors`, plus an empty stand-in for any `dependsOn` type not among them,
 * so a type can be tested without wiring every type it depends on.
 */
export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/** One instance's apply-capable deps over `ports`: in-memory change sets and outbox, allow-all
 *  authorize, a ticking clock and counting ids. */
export function makeSite(ports: Partial<PublishContentPorts>, name = "site"): PublishContentDeps {
  const outbox = new InMemoryOutbox();
  let tick = 0;
  let id = 0;
  return {
    workspaceId: WORKSPACE_ID,
    clock: { nowIso: () => new Date(Date.UTC(2026, 8, 26, 0, 0, tick++)).toISOString() },
    idGen: { newId: () => `${name}-id-${++id}` },
    outbox,
    changeSets: new InMemoryChangeSetRepo([], [], outbox),
    authorize: async () => ({ allowed: true, reason: "test-allow" }),
    ports,
  };
}

export function registerOnly(contributors: readonly PublishContentContributor[]): void {
  resetPublishContentContributorsForTests();
  const known = new Set(contributors.map((c) => c.entityType));
  for (const dep of new Set(contributors.flatMap((c) => c.dependsOn))) {
    if (known.has(dep)) continue;
    known.add(dep);
    registerPublishContentContributor(emptyContributor(dep));
  }
  for (const contributor of contributors) registerPublishContentContributor(contributor);
}

function emptyContributor(entityType: string): PublishContentContributor {
  return {
    entityType,
    dependsOn: [],
    build: () => ({
      entityType,
      schemaVersion: 1,
      permission: "test.none",
      dependsOn: [],
      async *pack() {},
      inspect: async () => null,
      precheck: async () => null,
      apply: async () => {
        throw new Error(`stand-in ${entityType} cannot apply`);
      },
    }),
  };
}

export async function packAll(deps: PublishContentDeps): Promise<PackedEntity[]> {
  const entities: PackedEntity[] = [];
  for (const handler of buildPublishContentCatalog(deps).handlers) {
    for await (const entity of handler.pack()) entities.push(entity);
  }
  return entities;
}

/** No baselines, so a changed row plans `conflict`; `force` lists `entityKey`s to push past it. */
export async function plan(entities: readonly PackedEntity[], destination: PublishContentDeps, force: readonly string[] = []): Promise<PublishContentReport> {
  return planImport(
    { artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION, hashVersion: CONTENT_HASH_VERSION, entities },
    { publishContentDeps: destination, getBaseline: async () => null, hasBlob: async () => true, forcedEntityKeys: new Set(force) }
  );
}

/** Applies every writing row of `report` in its apply order; `expectedVersion` from `inspect()`. */
export async function applyReport(report: PublishContentReport, entities: readonly PackedEntity[], destination: PublishContentDeps): Promise<void> {
  const { handlerByType } = buildPublishContentCatalog(destination);
  const byKey = new Map(entities.map((e) => [entityKey(e.entityType, e.id), e] as const));
  for (const row of report.rows) {
    if (!row.writes) continue;
    const handler = handlerByType.get(row.entityType)!;
    const entity = byKey.get(entityKey(row.entityType, row.entityId))!;
    // As `apply-loop.ts`: a `created` row is always a create; otherwise the freshly read version.
    const expectedVersion = row.outcome === "created" ? undefined : (await handler.inspect(entity.id))?.version;
    await handler.apply({ entity, expectedVersion, principalId: "owner", idempotencyKey: `idem-${row.entityType}-${row.entityId}` });
  }
}

/** Plan → apply → re-plan. Returns both reports and both sides' packs after the apply. */
export async function roundTrip(source: PublishContentDeps, destination: PublishContentDeps) {
  const entities = await packAll(source);
  const first = await plan(entities, destination);
  await applyReport(first, entities, destination);
  const second = await plan(await packAll(source), destination);
  return { entities, first, second, destinationPack: await packAll(destination) };
}
