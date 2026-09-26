import { EntrySlugConflictError, InMemoryEntryRepo } from "./index.js";
import type { EntryListPort, EntryRecord, EntryRepoPort, EntryRevisionInput, EntryStatus } from "./index.js";
import type { CollectionListQuery, CollectionSortBy, EntryDisplayListPort, EntryListExcludingTypesPort } from "./public-list.js";

/**
 * @file The in-memory twin of `repo.sqlite.ts`'s Trash rules, for the hermetic composition
 * (`server/runtime/composition/app.ts`), which has no `content.db`. Wraps the package's
 * `InMemoryEntryRepo` and keeps each trashed row's `deletedAt` beside it:
 *  - every read hides a trashed row;
 *  - `save` leaves a trashed row as it is, and refuses a slug a trashed row holds;
 *  - `findAnyById`/`saveAny` are the trash-blind seam the Trash's record-store adapter flips the
 *    marker through (the SQLite root flips `entries.deleted_at` with the generic table adapter).
 */

/** An entry plus its Trash marker, as the Trash's record-store adapter sees it. */
export type TrashableEntryRecord = EntryRecord & { deletedAt: string | null };

/**
 * Reads one custom field's value out of an entry's namespaced `fields.ext.site.<name>` bag — the
 * in-memory twin of `repo.sqlite.ts`'s `json_extract($.ext.site.<name>)`. Unlike the SQLite side,
 * no boolean-to-`1`/`0` conversion is needed here: a JS `boolean`/`number`/`string` compares
 * directly against the same JS type read back from `fieldsJson`, since neither side ever passes
 * through a JSON-in-SQLite round trip.
 *
 * @complexity O(1).
 */
function siteFieldValue(row: EntryRecord, field: string): unknown {
  const fields = row.fieldsJson as { ext?: { site?: Record<string, unknown> } } | null | undefined;
  return fields?.ext?.site?.[field];
}

/**
 * Resolves a {@link CollectionSortBy} into the value `listPublishedForDisplay`'s sort compares —
 * the in-memory twin of `repo.sqlite.ts`'s `sortByExpression`.
 *
 * @complexity O(1).
 */
function sortKey(row: EntryRecord, by: CollectionSortBy): unknown {
  if (by === "published") return row.publishedAt;
  if (by === "updated") return row.updatedAt;
  if (by === "title") return row.title;
  return siteFieldValue(row, by.field);
}

/**
 * Orders two arbitrary, possibly-mixed-type sort key values: `null`/`undefined` sort first,
 * same-typed numbers compare numerically (so `9` sorts before `10`, matching SQLite's
 * `json_extract`-returns-typed-values behavior for the SQLite adapter's own numeric fields),
 * everything else compares as a string. Not a general-purpose comparator — scoped to the sort
 * keys {@link sortKey} can produce (an entry's own scalar column values or one JSON field value).
 *
 * @complexity O(1) (O(n) only in the rare cross-type string-coercion branch's implicit
 * `String()` call, n being the value's own serialized length).
 */
function compareSortKeys(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const aText = String(a);
  const bText = String(b);
  if (aText < bText) return -1;
  if (aText > bText) return 1;
  return 0;
}

export class TrashAwareInMemoryEntryRepo implements EntryRepoPort, EntryListPort, EntryDisplayListPort, EntryListExcludingTypesPort {
  private readonly inner = new InMemoryEntryRepo();
  /** id → when it was trashed. */
  private readonly deletedAt = new Map<string, string>();

  /** @complexity O(n) over stored entries (the inner repo's scan). */
  async findBySlug(params: { workspaceId: string; type: string; slug: string }): Promise<EntryRecord | null> {
    const row = await this.inner.findBySlug(params);
    return row && !this.deletedAt.has(row.id) ? row : null;
  }

  /** @complexity O(1). */
  async findById(params: { workspaceId: string; id: string }): Promise<EntryRecord | null> {
    const row = await this.inner.findById(params);
    return row && !this.deletedAt.has(row.id) ? row : null;
  }

  /**
   * @throws EntrySlugConflictError when a trashed row holds the slug (same text as the SQLite repo).
   * @complexity O(n) over stored entries (one slug scan).
   */
  async save(row: EntryRecord): Promise<void> {
    if (this.deletedAt.has(row.id)) return;
    const holder = await this.inner.findBySlug({ workspaceId: row.workspaceId, type: row.type, slug: row.slug });
    if (holder && holder.id !== row.id && this.deletedAt.has(holder.id)) {
      throw new EntrySlugConflictError(
        `an entry with slug '${row.slug}' is in the Trash — restore it, or delete it permanently from the Trash, to reuse the slug`
      );
    }
    await this.inner.save(row);
  }

  async appendRevision(revision: EntryRevisionInput): Promise<void> {
    await this.inner.appendRevision(revision);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.inner.transaction(fn);
  }

  /** `limit` applies after trashed rows are dropped, as the SQLite `LIMIT` does.
   *  @complexity O(n log n) over the workspace's entries when ordered. */
  async listByWorkspace(params: {
    workspaceId: string;
    type?: string;
    status?: EntryStatus;
    orderBy?: "updatedAt";
    orderDirection?: "asc" | "desc";
    limit?: number;
  }): Promise<EntryRecord[]> {
    const { limit, ...rest } = params;
    const live = (await this.inner.listByWorkspace(rest)).filter((row) => !this.deletedAt.has(row.id));
    return typeof limit === "number" ? live.slice(0, limit) : live;
  }

  /**
   * Review fix 3b — the in-memory twin of `SqliteEntryRepo.listByWorkspaceExcludingTypes`:
   * `excludeTypes` and the trash filter are both applied to the FULL scan before `limit` slices
   * it, so newer system rows can never crowd real content out of a bounded result (the bug this
   * method replaces: the old call site applied its own type filter after `listByWorkspace`'s own
   * `limit` had already run).
   * @complexity O(n log n) over the workspace's live rows when ordered (see `listByWorkspace`).
   */
  async listByWorkspaceExcludingTypes(params: {
    workspaceId: string;
    excludeTypes: readonly string[];
    status?: EntryStatus;
    orderBy?: "updatedAt";
    orderDirection?: "asc" | "desc";
    limit?: number;
  }): Promise<EntryRecord[]> {
    const { workspaceId, excludeTypes, status, orderBy, orderDirection, limit } = params;
    const rows = (await this.inner.listByWorkspace({ workspaceId, status, orderBy, orderDirection })).filter(
      (row) => !this.deletedAt.has(row.id) && !excludeTypes.includes(row.type)
    );
    return typeof limit === "number" ? rows.slice(0, limit) : rows;
  }

  /** Trash seam: the row whether or not it is trashed. @complexity O(1). */
  async findAnyById(params: { workspaceId: string; id: string }): Promise<TrashableEntryRecord | null> {
    const row = await this.inner.findById(params);
    return row ? { ...row, deletedAt: this.deletedAt.get(row.id) ?? null } : null;
  }

  /** The `(type, slug)` holder whether or not it is trashed. @complexity O(n) (one slug scan). */
  async findAnyBySlug(params: { workspaceId: string; type: string; slug: string }): Promise<TrashableEntryRecord | null> {
    const row = await this.inner.findBySlug(params);
    return row ? { ...row, deletedAt: this.deletedAt.get(row.id) ?? null } : null;
  }

  /** Trash seam: writes the row and its marker as given. @complexity O(1). */
  async saveAny(record: TrashableEntryRecord): Promise<void> {
    const { deletedAt, ...row } = record;
    await this.inner.save(row);
    if (deletedAt === null) this.deletedAt.delete(row.id);
    else this.deletedAt.set(row.id, deletedAt);
  }

  /**
   * C2 (plan lines 149-167) — the in-memory twin of `SqliteEntryRepo.listPublishedForDisplay`:
   * same filter/sort/limit semantics (published, non-trashed, `query.type`, every `where` clause
   * matched, `query.sort` order with an `id` tiebreak, `query.limit` applied last), reached
   * through this host's own `InMemoryEntryRepo.listByWorkspace` plus the trash filter every other
   * read method here applies, rather than a raw `json_extract` SQL query.
   *
   * @complexity O(n log n) over the workspace+type's live rows: one full scan (bounded by
   * `listByWorkspace`'s own workspace+type filter) plus a JS sort. `n` is never the full table —
   * `InMemoryEntryRepo` only ever backs the hermetic composition root (`server/runtime/
   * composition/app.ts`), which has no real persistence and no production-sized data.
   */
  async listPublishedForDisplay(params: { workspaceId: string; query: CollectionListQuery }): Promise<EntryRecord[]> {
    const { workspaceId, query } = params;
    const rows = (await this.inner.listByWorkspace({ workspaceId, type: query.type, status: "published" })).filter(
      (row) => !this.deletedAt.has(row.id)
    );
    const matching = rows.filter((row) => query.where.every((clause) => siteFieldValue(row, clause.field) === clause.value));

    const direction = query.sort.dir === "asc" ? 1 : -1;
    const sorted = [...matching].sort((a, b) => {
      const primary = compareSortKeys(sortKey(a, query.sort.by), sortKey(b, query.sort.by)) * direction;
      if (primary !== 0) return primary;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return sorted.slice(0, query.limit);
  }
}
