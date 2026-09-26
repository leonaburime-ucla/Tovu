import type Database from "better-sqlite3";
import { and, asc, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

import { entries, entryRevisions } from "../../platform/db/schema.sqlite.js";
import type { ContentDb } from "../../platform/db/sqlite/content-db.js";
import { findOneBy } from "../../platform/db/sqlite/repo-helpers.js";
import { EntrySlugConflictError } from "./index.js";
import type {
  EntryListPort,
  EntryRecord,
  EntryRepoPort,
  EntryRevisionInput,
  EntryStatus,
} from "./index.js";
import type {
  CollectionListQuery,
  CollectionSortBy,
  CollectionWhereClause,
  EntryDisplayListPort,
  EntryListExcludingTypesPort,
} from "./public-list.js";
import type { TrashableEntryRecord } from "./trash-aware-memory-repo.js";

/**
 * @file Real SQLite `EntryRepoPort` + `EntryListPort` adapter (ADR-006 rule-of-two "second
 * adapter" half — `repo.memory.ts`'s `InMemoryEntryRepo` is the first). Same disclosed gap
 * closure as `features/content-types/repo.sqlite.ts` — see that file's header for the full
 * rationale, which applies identically here.
 *
 * Architectural role:
 * Infrastructure adapter. ADR-042 item 1: `findBySlug`/`findById` reuse `repo-helpers.ts`'s
 * `findOneBy` rather than hand-rolling the lookup shape.
 *
 * Trash: a row with `deleted_at` set is in the Trash (only widgets get there today). Every read here
 * hides it, so every widget reader — region placements, embeds, the admin list — treats a trashed
 * widget as missing (the REQ-28 placeholder). `save` never writes `deleted_at` and never touches a
 * trashed row; only the Trash moves a row in or out.
 */

/** A row that is not in the Trash. */
const LIVE = isNull(entries.deletedAt);

/** SQLite's own text for the `entries_workspace_type_slug_unique` index. */
const SLUG_UNIQUE_VIOLATION = "UNIQUE constraint failed: entries.workspace_id, entries.type, entries.slug";

function toRecord(row: typeof entries.$inferSelect): EntryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    slug: row.slug,
    status: row.status as EntryStatus,
    title: row.title,
    bodyJson: row.bodyJson == null ? null : (JSON.parse(row.bodyJson) as unknown),
    fieldsJson: JSON.parse(row.fieldsJson) as unknown,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/**
 * Builds the namespaced JSON pointer path (`$.ext.site.<field>`) a custom field's value lives at
 * inside `entries.fields_json`. C1's `parseCollectionListConfig` has already validated `field`
 * against the content type's declared fields before a `CollectionListQuery` reaches this repo,
 * but this function's own contract does not rely on that: every caller below passes its return
 * value as a bound SQL parameter to `json_extract`, never splices it into the SQL text, so even a
 * field name an attacker fully controlled could only ever act as a literal (non-matching) JSON
 * pointer — defense in depth below C1's rejection, not instead of it.
 *
 * @complexity O(1).
 */
function siteFieldJsonPath(field: string): string {
  return `$.ext.site.${field}`;
}

/**
 * One validated `{field, value}` filter clause as a bound `json_extract` equality check. SQLite's
 * JSON functions have no boolean type — `json_extract` reads a JSON `true`/`false` back as the
 * integer `1`/`0` — so a boolean filter value is converted to match before binding (plan §1
 * unknown 3). Both the path and the value are template-literal placeholders drizzle's `sql`
 * builds into separate bound parameters; the field name is never string-concatenated into SQL
 * text (see {@link siteFieldJsonPath}).
 *
 * @complexity O(1) to build; the actual `json_extract` scan is charged once per matched row by
 * SQLite, not once per clause here.
 */
function whereClauseSql(clause: CollectionWhereClause): SQL {
  return sql`json_extract(${entries.fieldsJson}, ${siteFieldJsonPath(clause.field)}) = ${toBoundWhereValue(clause.value)}`;
}

/** Converts a validated `where` value into the scalar SQLite's `json_extract` comparison expects
 * — see {@link whereClauseSql}'s boolean-encoding note. @complexity O(1). */
function toBoundWhereValue(value: CollectionWhereClause["value"]): string | number {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

/**
 * Resolves a {@link CollectionSortBy} into the `ORDER BY` target: the three built-in keywords map
 * to real, indexed columns; a `{field}` reference falls back to the same bound `json_extract`
 * pattern {@link whereClauseSql} uses for `where`. `asc`/`desc` in `listPublishedForDisplay`
 * accept either a column or a `SQL` fragment uniformly (both satisfy drizzle's `SQLWrapper`).
 *
 * @complexity O(1).
 */
function sortByExpression(by: CollectionSortBy): AnyColumn | SQL {
  if (by === "published") return entries.publishedAt;
  if (by === "updated") return entries.updatedAt;
  if (by === "title") return entries.title;
  return sql`json_extract(${entries.fieldsJson}, ${siteFieldJsonPath(by.field)})`;
}

/** Publish-content's entry read (`publish-content.ts`): the row plus its Trash marker, trashed rows
 *  included, so a precheck refuses a trashed destination instead of planning a create that `save`
 *  would then silently skip. */
export interface EntryPublishReadPort {
  findAnyById(params: { workspaceId: string; id: string }): Promise<TrashableEntryRecord | null>;
}

export class SqliteEntryRepo implements EntryRepoPort, EntryListPort, EntryDisplayListPort, EntryListExcludingTypesPort, EntryPublishReadPort {
  constructor(private readonly db: ContentDb) {}

  async findBySlug(params: { workspaceId: string; type: string; slug: string }): Promise<EntryRecord | null> {
    return findOneBy(
      this.db,
      entries,
      [eq(entries.workspaceId, params.workspaceId), eq(entries.type, params.type), eq(entries.slug, params.slug), LIVE],
      toRecord
    );
  }

  async findById(params: { workspaceId: string; id: string }): Promise<EntryRecord | null> {
    return findOneBy(this.db, entries, [eq(entries.workspaceId, params.workspaceId), eq(entries.id, params.id), LIVE], toRecord);
  }

  /** Trash-blind: see {@link EntryPublishReadPort}. @complexity O(1). */
  async findAnyById(params: { workspaceId: string; id: string }): Promise<TrashableEntryRecord | null> {
    return findOneBy(this.db, entries, [eq(entries.workspaceId, params.workspaceId), eq(entries.id, params.id)], (row) => ({
      ...toRecord(row),
      deletedAt: row.deletedAt,
    }));
  }

  /**
   * Upserts an `entries` row by id — full-replace semantics, matching `InMemoryEntryRepo.save`'s
   * `Map.set` behavior exactly. A trashed row is left as it is (a stale save cannot bring it back).
   *
   * @throws EntrySlugConflictError when a trashed row holds the slug: the reads above hide it, so the
   *         chokepoint's own slug check could not see it.
   * @complexity O(1).
   */
  async save(row: EntryRecord): Promise<void> {
    const values = {
      id: row.id,
      workspaceId: row.workspaceId,
      type: row.type,
      slug: row.slug,
      status: row.status,
      title: row.title,
      bodyJson: row.bodyJson == null ? null : JSON.stringify(row.bodyJson),
      fieldsJson: JSON.stringify(row.fieldsJson),
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
    };
    try {
      this.db.insert(entries).values(values).onConflictDoUpdate({ target: entries.id, set: values, setWhere: LIVE }).run();
    } catch (error) {
      if (error instanceof Error && error.message.includes(SLUG_UNIQUE_VIOLATION)) {
        throw new EntrySlugConflictError(
          `an entry with slug '${row.slug}' is in the Trash — restore it, or delete it permanently from the Trash, to reuse the slug`
        );
      }
      throw error;
    }
  }

  async appendRevision(revision: EntryRevisionInput): Promise<void> {
    this.db
      .insert(entryRevisions)
      .values({
        entryId: revision.entryId,
        workspaceId: revision.workspaceId,
        op: revision.op,
        stateJson: JSON.stringify(revision.stateJson),
        actorId: revision.actorId,
        delegatedByWorkspaceId: revision.delegatedByWorkspaceId,
        delegatedById: revision.delegatedById,
        recordedAt: revision.recordedAt,
      })
      .run();
  }

  async listByWorkspace(params: {
    workspaceId: string;
    type?: string;
    status?: EntryStatus;
    orderBy?: "updatedAt";
    orderDirection?: "asc" | "desc";
    limit?: number;
  }): Promise<EntryRecord[]> {
    const conditions = [eq(entries.workspaceId, params.workspaceId), LIVE];
    if (params.type) conditions.push(eq(entries.type, params.type));
    if (params.status) conditions.push(eq(entries.status, params.status));

    let query = this.db.select().from(entries).where(and(...conditions)).$dynamic();
    if (params.orderBy === "updatedAt") {
      query = query.orderBy(params.orderDirection === "asc" ? asc(entries.updatedAt) : desc(entries.updatedAt));
    }
    if (typeof params.limit === "number") {
      query = query.limit(params.limit);
    }
    const rows = query.all();
    return rows.map(toRecord);
  }

  /**
   * Review fix 3b (`public-list.ts`'s {@link EntryListExcludingTypesPort} doc) — same shape as
   * {@link listByWorkspace}, but `excludeTypes` rows are filtered out in SQL, before `LIMIT`, so
   * they can never crowd a bounded result out of real content.
   *
   * @complexity O(log n + k) via `idx_entries_workspace(workspace_id, type)`; `k` is bounded by
   * `params.limit`, never a full-table scan.
   */
  async listByWorkspaceExcludingTypes(params: {
    workspaceId: string;
    excludeTypes: readonly string[];
    status?: EntryStatus;
    orderBy?: "updatedAt";
    orderDirection?: "asc" | "desc";
    limit?: number;
  }): Promise<EntryRecord[]> {
    const conditions = [eq(entries.workspaceId, params.workspaceId), LIVE];
    if (params.excludeTypes.length > 0) conditions.push(notInArray(entries.type, params.excludeTypes as string[]));
    if (params.status) conditions.push(eq(entries.status, params.status));

    let query = this.db.select().from(entries).where(and(...conditions)).$dynamic();
    if (params.orderBy === "updatedAt") {
      query = query.orderBy(params.orderDirection === "asc" ? asc(entries.updatedAt) : desc(entries.updatedAt));
    }
    if (typeof params.limit === "number") {
      query = query.limit(params.limit);
    }
    const rows = query.all();
    return rows.map(toRecord);
  }

  /** Manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` — mirrors `SqliteContentTypeRepo.transaction`.
   *  Joins a transaction already open on this connection (the widget adoption runs an entry update
   *  and its Trash move as one). */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = (this.db as unknown as { $client: Database.Database }).$client;
    if (client.inTransaction) return fn();
    client.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      client.exec("COMMIT");
      return result;
    } catch (error) {
      client.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * C2 (plan lines 149-167) — the `{"type":"collection"}` marker's read path: published,
   * non-trashed rows of `query.type`, narrowed by every `query.where` clause, ordered by
   * `query.sort`, bounded to `query.limit`. Every `where`/`sort` field name and value reaches
   * SQL only as a bound parameter (see {@link whereClauseSql}/{@link sortByExpression}), never
   * interpolated into the query text. `entries.id` is the final tiebreak so a query result is
   * stable across calls when the primary sort key ties.
   *
   * @complexity O(log n + k): SQLite's `idx_entries_workspace(workspace_id, type)` index narrows
   * to the workspace+type first; each matched row is then charged one `json_extract` per `where`
   * clause plus the sort key (no expression index yet — plan §1 unknown 3's "queryable index
   * provisioner" follow-up is later work, not this slice). `k` is the matched row count, always
   * bounded below by `query.limit` at the SQL layer, never a full-table or full-type scan result
   * materialized in memory first.
   */
  async listPublishedForDisplay(params: { workspaceId: string; query: CollectionListQuery }): Promise<EntryRecord[]> {
    const { workspaceId, query } = params;
    const conditions = [
      eq(entries.workspaceId, workspaceId),
      eq(entries.type, query.type),
      eq(entries.status, "published"),
      LIVE,
      ...query.where.map(whereClauseSql),
    ];
    const direction = query.sort.dir === "asc" ? asc : desc;
    const orderColumn = sortByExpression(query.sort.by);

    const rows = this.db
      .select()
      .from(entries)
      .where(and(...conditions))
      .orderBy(direction(orderColumn), asc(entries.id))
      .limit(query.limit)
      .all();
    return rows.map(toRecord);
  }
}
