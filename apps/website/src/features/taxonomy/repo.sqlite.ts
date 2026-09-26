import type Database from "better-sqlite3";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";

import { stampWatermarkTx, type ContentDbTransaction } from "../../platform/db/sqlite/watermark.js";
import { entryTerms, taxonomies, taxonomyRevisions, terms } from "../../platform/db/schema.sqlite.js";
import type { ContentDb } from "../../platform/db/sqlite/content-db.js";
import { findOneBy } from "../../platform/db/sqlite/repo-helpers.js";
import type {
  EntryTermRepoPort,
  ImportableTaxonomyRepoPort,
  ImportableTermRepoPort,
  Taxonomy,
  TaxonomyListPort,
  TaxonomyRepoPort,
  TaxonomyRevisionRepoPort,
  TaxonomyRevisionRow,
  Term,
  TermListPort,
  TermRepoPort,
  UnassignableEntryTermRepoPort,
} from "./index.js";

/**
 * @file Real SQLite adapters for the `taxonomy` package's write/list ports (ADR-006 rule-of-two
 * "second adapter" half — `repo.memory.ts`'s in-memory doubles are the first). Same disclosed gap
 * closure as `features/content-types/repo.sqlite.ts`/`features/entries/repo.sqlite.ts`.
 *
 * Purpose:
 * `TaxonomyRepoPort`/`TermRepoPort`/`EntryTermRepoPort`/`TaxonomyRevisionRepoPort` (this package's
 * own certified `write-service.ts`) never thread a `workspaceId` through their method signatures
 * (see that file's own header: "no `workspaceId` is threaded through this slice's certified
 * write-service tests"). Every adapter class here is therefore constructed workspace-scoped
 * instead — the same "scoped at construction" precedent `db/sqlite/database-journal-repo.ts`
 * already established for `siteId` — rather than widening a certified port signature that isn't
 * mine to change.
 *
 * Architectural role:
 * Infrastructure adapters. ADR-042 item 1: single-row lookups reuse `repo-helpers.ts`'s
 * `findOneBy`.
 *
 * T6 (trash parallel plan §2, owner decision 5): tags/categories are trashable, but this domain
 * never imports `features/trash` (binding rule "own-column read filtering" — each domain repo
 * filters on its own column and imports nothing from trash). `TRASH_STATUS`/`taxonomyIsLive`/
 * `termIsLive` below reproduce, on this domain's own `status` columns, exactly the two rules
 * `features/trash/not-trashed.ts`'s `notTrashed` encodes generically for the Trash's OWN reads:
 * a row is hidden by its own marker, and a term is ALSO hidden the instant its taxonomy is
 * (`registry.ts`'s `hiddenWithParent` — there is no second write that cascades the hide onto
 * every member term, so every term read must re-check the parent taxonomy's status itself).
 * Every read below excludes trashed rows; `SqliteTermRepo.update` (the rename path) additionally
 * guards its `WHERE` so a stale write can never resurrect or edit an already-trashed row.
 */

const TRASH_STATUS = "trash";

/** Publish-content's taxonomy read (`publish-content.ts`): the full row, trashed ones included
 *  (`status` = `"trash"`), so a precheck refuses a trashed destination instead of colliding. */
export interface TaxonomyPublishReadPort {
  findAnyById(id: string): Promise<Taxonomy | null>;
}

/** Publish-content's term read — see {@link TaxonomyPublishReadPort}. */
export interface TermPublishReadPort {
  findAnyById(id: string): Promise<Term | null>;
}

/** `taxonomies.status <> 'trash'` — the taxonomy read half of the rule (own marker only; a
 *  taxonomy has no parent to inherit trashed-ness from). @complexity O(1) to build. */
function taxonomyIsLive(): SQL {
  return ne(taxonomies.status, TRASH_STATUS);
}

/** `terms.status <> 'trash' AND NOT EXISTS (the term's own taxonomy is trashed)` — see the file
 *  header. The `NOT EXISTS` is built with `sql` over column objects only, never caller input,
 *  same discipline `not-trashed.ts`'s own `parentNotTrashed` documents for the identical shape.
 *  @complexity O(1) to build; the `NOT EXISTS` costs whatever index `taxonomies`'s own primary key
 *  already provides. */
function termIsLive(): SQL {
  return and(
    ne(terms.status, TRASH_STATUS),
    sql`NOT EXISTS (SELECT 1 FROM ${taxonomies} WHERE ${taxonomies.id} = ${terms.taxonomyId} AND ${taxonomies.status} = ${TRASH_STATUS})`
  )!;
}

function toTaxonomy(row: typeof taxonomies.$inferSelect): Taxonomy {
  return {
    id: row.id,
    name: row.name,
    hierarchical: row.hierarchical === 1,
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function toTerm(row: typeof terms.$inferSelect): Term {
  return {
    id: row.id,
    taxonomyId: row.taxonomyId,
    parentId: row.parentId,
    name: row.name,
    status: row.status,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export class SqliteTaxonomyRepo implements TaxonomyRepoPort, TaxonomyListPort, ImportableTaxonomyRepoPort, TaxonomyPublishReadPort {
  constructor(private readonly deps: { db: ContentDb; workspaceId: string }) {}

  async insert(row: Taxonomy): Promise<unknown> {
    this.deps.db
      .insert(taxonomies)
      .values({
        id: row.id,
        workspaceId: this.deps.workspaceId,
        name: row.name,
        hierarchical: row.hierarchical ? 1 : 0,
        status: row.status,
        updatedAt: row.updatedAt,
        version: row.version,
      })
      .run();
    return row;
  }

  async findById(id: string): Promise<{ id: string; hierarchical: boolean; allowList?: string[] } | null> {
    return findOneBy(
      this.deps.db,
      taxonomies,
      [eq(taxonomies.workspaceId, this.deps.workspaceId), eq(taxonomies.id, id), taxonomyIsLive()],
      (row) => ({ id: row.id, hierarchical: row.hierarchical === 1 })
    );
  }

  /** `ImportableTaxonomyRepoPort` (`importTaxonomy`'s CAS read) — the full live row. */
  async findByIdFull(id: string): Promise<Taxonomy | null> {
    return findOneBy(this.deps.db, taxonomies, [eq(taxonomies.workspaceId, this.deps.workspaceId), eq(taxonomies.id, id), taxonomyIsLive()], toTaxonomy);
  }

  /** Publish-content's read (`publish-content.ts`): the full row even when trashed (`status` =
   *  `"trash"`), so a precheck can refuse it instead of planning a create that would collide. */
  async findAnyById(id: string): Promise<Taxonomy | null> {
    return findOneBy(this.deps.db, taxonomies, [eq(taxonomies.workspaceId, this.deps.workspaceId), eq(taxonomies.id, id)], toTaxonomy);
  }

  /** `ImportableTaxonomyRepoPort` — live rows only, same no-revive guard as `SqliteTermRepo.update`. */
  async update(row: Taxonomy): Promise<unknown> {
    this.deps.db
      .update(taxonomies)
      .set({ name: row.name, hierarchical: row.hierarchical ? 1 : 0, status: row.status, updatedAt: row.updatedAt, version: row.version })
      .where(and(eq(taxonomies.workspaceId, this.deps.workspaceId), eq(taxonomies.id, row.id), taxonomyIsLive()))
      .run();
    return row;
  }

  async list(): Promise<Taxonomy[]> {
    const rows = this.deps.db
      .select()
      .from(taxonomies)
      .where(and(eq(taxonomies.workspaceId, this.deps.workspaceId), taxonomyIsLive()))
      .all();
    return rows.map(toTaxonomy);
  }

  /** Trash display read for `trashTaxonomy` (`trash-term.ts`) — additive, not part of the
   *  certified `TaxonomyRepoPort`, same precedent as `SqliteEntryTermRepo.listForContent` below.
   *  Excludes an already-trashed taxonomy, same as every other read here (`moveToTrash`'s own
   *  "the caller cannot re-trash what is already gone" rule, reproduced on this domain's columns).
   *  @complexity O(1) plus whatever index the workspace/id match uses. */
  async findForTrash(id: string): Promise<{ id: string; name: string; version: number } | null> {
    return findOneBy(
      this.deps.db,
      taxonomies,
      [eq(taxonomies.workspaceId, this.deps.workspaceId), eq(taxonomies.id, id), taxonomyIsLive()],
      (row) => ({ id: row.id, name: row.name, version: row.version })
    );
  }

  /** `DeletableTaxonomyRepoPort` (`@jini-ai/cms/taxonomy`) — additive capability behind
   * `deleteTaxonomy`, workspace-scoped like every other method on this class. */
  async delete(id: string): Promise<void> {
    this.deps.db.delete(taxonomies).where(and(eq(taxonomies.workspaceId, this.deps.workspaceId), eq(taxonomies.id, id))).run();
  }

  /**
   * `TransactionalRepoPort` (`@jini-ai/cms/taxonomy`) — backs `deleteTerm`/`deleteTaxonomy`'s
   * guard-and-cascade atomicity (coordinator review hazards #1/#2: no FK/CASCADE exists at the
   * schema level, so an application-level transaction is the only thing that can undo a
   * mid-cascade failure, and it must wrap the guard reads too or they go stale the instant they
   * return). Manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` against the raw better-sqlite3 handle
   * rather than Drizzle's `db.transaction((tx) => ...)` wrapper — that wrapper requires a
   * *synchronous* callback (better-sqlite3 itself is synchronous), but `fn` here does `await`ed
   * repo calls. Exact same precedent and safety argument as `SqliteSettingsRepo.transaction`/
   * `SqliteNewsletterCampaignRepo`'s: manual BEGIN/COMMIT is safe because better-sqlite3 has no
   * real async I/O — every call resolves on the same microtask tick, so no other statement can
   * interleave on this single connection between awaits. `terms`/`entryTerms`/`taxonomyRevisions`/
   * the outbox all share this SAME `db` handle (constructed together in `server/deps.ts`), so
   * every write any of them makes while `fn` is running lands inside this one transaction too —
   * not just the calls made directly through this class.
   *
   * **Deliberately NOT reentrant** — same rationale as `SqliteSettingsRepo.transaction`'s own doc
   * comment (an instance-level depth counter cannot distinguish legitimate nesting from a second,
   * unrelated concurrent transaction; merging them is worse than the non-atomicity it would fix).
   * `deleteTerm`/`deleteTaxonomy` are each written to call this exactly once per invocation, at
   * the outermost level of their own body — never from within an already-open transaction.
   *
   * @complexity O(1) fixed overhead plus whatever `fn` itself costs.
   * @overallScore 100
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // `$client` — see `SqliteSettingsRepo.transaction`'s identical comment for why this cast is
    // necessary and safe (a known drizzle-orm typing gap, not an unsound cast).
    const client = (this.deps.db as unknown as { $client: Database.Database }).$client;
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
}

export class SqliteTermRepo implements TermRepoPort, TermListPort, ImportableTermRepoPort, TermPublishReadPort {
  constructor(private readonly deps: { db: ContentDb; workspaceId: string }) {}

  async insert(row: Term): Promise<unknown> {
    this.deps.db
      .insert(terms)
      .values({
        id: row.id,
        workspaceId: this.deps.workspaceId,
        taxonomyId: row.taxonomyId,
        parentId: row.parentId,
        name: row.name,
        status: row.status,
        updatedAt: row.updatedAt,
        version: row.version,
      })
      .run();
    return row;
  }

  /** `setWhere`-guarded (T6): a stale rename can never write over an already-trashed row — the
   *  same "no zombie write" guard `db-port.ts`'s `TrashDbAssignment` doc names for the generic
   *  Trash's own writes, reproduced here so `renameTerm` (`@jini-ai/cms/taxonomy`) silently no-ops
   *  against a trashed term rather than reviving it with a new name. A 0-row update is not
   *  reported as an error here — `renameTerm`'s own `findById` (also trash-filtered, above/below)
   *  already turns a trashed term into a 404 before this ever runs; this is defense in depth
   *  against a race between that read and this write, not the primary guard. */
  async update(row: Term): Promise<unknown> {
    this.deps.db
      .update(terms)
      .set({
        taxonomyId: row.taxonomyId,
        parentId: row.parentId,
        name: row.name,
        status: row.status,
        updatedAt: row.updatedAt,
        version: row.version,
      })
      .where(and(eq(terms.workspaceId, this.deps.workspaceId), eq(terms.id, row.id), termIsLive()))
      .run();
    return row;
  }

  async findById(id: string): Promise<{ id: string; taxonomyId: string; name?: string } | null> {
    return findOneBy(
      this.deps.db,
      terms,
      [eq(terms.workspaceId, this.deps.workspaceId), eq(terms.id, id), termIsLive()],
      (row) => ({ id: row.id, taxonomyId: row.taxonomyId, name: row.name })
    );
  }

  /** `ImportableTermRepoPort` (`importTerm`'s CAS read) — the full live row. */
  async findByIdFull(id: string): Promise<Term | null> {
    return findOneBy(this.deps.db, terms, [eq(terms.workspaceId, this.deps.workspaceId), eq(terms.id, id), termIsLive()], toTerm);
  }

  /** Publish-content's read: the full row even when trashed (see `SqliteTaxonomyRepo.findAnyById`). */
  async findAnyById(id: string): Promise<Term | null> {
    return findOneBy(this.deps.db, terms, [eq(terms.workspaceId, this.deps.workspaceId), eq(terms.id, id)], toTerm);
  }

  async listByTaxonomy(params: { taxonomyId: string }): Promise<Term[]> {
    const rows = this.deps.db
      .select()
      .from(terms)
      .where(and(eq(terms.workspaceId, this.deps.workspaceId), eq(terms.taxonomyId, params.taxonomyId), termIsLive()))
      .all();
    return rows.map(toTerm);
  }

  /** Trash display read for `trashTerm` (`trash-term.ts`) — the term's own name plus its
   *  taxonomy's name, the same join `registry.ts`'s `term` entry uses for the generic Trash's
   *  display. Additive, not part of the certified `TermRepoPort`. Excludes an already-trashed
   *  term (own marker or `hiddenWithParent`), same rule every other read here applies.
   *  @complexity O(1) plus whatever index the workspace/id match and the taxonomy join use. */
  async findForTrash(id: string): Promise<{ id: string; name: string; taxonomyId: string; taxonomyName: string; version: number } | null> {
    const rows = this.deps.db
      .select({ id: terms.id, name: terms.name, taxonomyId: terms.taxonomyId, taxonomyName: taxonomies.name, version: terms.version })
      .from(terms)
      .innerJoin(taxonomies, eq(taxonomies.id, terms.taxonomyId))
      .where(and(eq(terms.workspaceId, this.deps.workspaceId), eq(terms.id, id), termIsLive()))
      .limit(1)
      .all();
    return rows[0] ?? null;
  }

  /** Purge-audit read for `taxonomy-trash-follow-ups.ts`'s term `beforePurge` hook — deliberately
   *  trash-BLIND (no `termIsLive()` filter), unlike every other read on this class. A purge only
   *  ever runs on a row that is already hidden (its own marker or `hiddenWithParent`), so
   *  `findForTrash`'s live filter would return `null` at exactly the moment the follow-up needs to
   *  read the term's name/taxonomy for the revision it is about to write. Additive, not part of
   *  the certified `TermRepoPort`. @complexity O(1). */
  async findForPurgeAudit(id: string): Promise<{ id: string; name: string; taxonomyId: string } | null> {
    return findOneBy(
      this.deps.db,
      terms,
      [eq(terms.workspaceId, this.deps.workspaceId), eq(terms.id, id)],
      (row) => ({ id: row.id, name: row.name, taxonomyId: row.taxonomyId })
    );
  }

  /** Purge-audit read for `taxonomy-trash-follow-ups.ts`'s taxonomy `beforePurge` hook — the ids of
   *  EVERY member term regardless of status, because `registry.ts`'s taxonomy `purgeFirst` cascade
   *  physically deletes all of them along with the taxonomy row, whether or not each one carries
   *  its own trash marker (`hiddenWithParent` means most never do). `listByTaxonomy` cannot serve
   *  this: it excludes rows under an already-trashed taxonomy, which is always true by the time a
   *  purge runs. Additive, not part of the certified `TermRepoPort`. @complexity O(1) plus
   *  whatever index the taxonomy id match uses. */
  async listIdsForPurgeAudit(taxonomyId: string): Promise<string[]> {
    const rows = this.deps.db
      .select({ id: terms.id })
      .from(terms)
      .where(and(eq(terms.workspaceId, this.deps.workspaceId), eq(terms.taxonomyId, taxonomyId)))
      .all();
    return rows.map((row) => row.id);
  }

  /** Ancestor-chain lookup for `validation-chain.ts`'s `wouldCreateCycle` — mirrors
   * `InMemoryTermRepo.getParentId`'s optional, not-yet-wired-by-any-route seam. */
  getParentId(termId: string): string | null {
    const row = findOneBy(this.deps.db, terms, [eq(terms.workspaceId, this.deps.workspaceId), eq(terms.id, termId)], (r) => r.parentId);
    return row ?? null;
  }

  /** `DeletableTermRepoPort` (`@jini-ai/cms/taxonomy`) — additive capability behind `deleteTerm`. */
  async delete(id: string): Promise<void> {
    this.deps.db.delete(terms).where(and(eq(terms.workspaceId, this.deps.workspaceId), eq(terms.id, id))).run();
  }

  /** `DeletableTermRepoPort.countChildren` — direct children only (one level), workspace-scoped;
   * see `write-service.ts`'s `DeletableTermRepoPort` doc comment for why `deleteTerm` doesn't
   * recurse past this. */
  async countChildren(params: { parentId: string }): Promise<number> {
    const rows = this.deps.db
      .select({ id: terms.id })
      .from(terms)
      .where(and(eq(terms.workspaceId, this.deps.workspaceId), eq(terms.parentId, params.parentId)))
      .all();
    return rows.length;
  }
}

/**
 * One term assigned to a piece of content, joined with its own name and its owning taxonomy's name
 * — the shape {@link EntryTermReadPort.listForContent} returns, and the ONLY shape the public-render
 * surface needs (`pages.ts`'s `resolveAssignedTermsForRender`/`renderAssignedTermsBlock`): a term's
 * `status`/`parentId`/etc. are admin-surface concerns, not a reader's.
 */
export interface AssignedTermView {
  termId: string;
  termName: string;
  taxonomyName: string;
}

/**
 * Additive capability beyond the certified `EntryTermRepoPort` (which has no by-content READ method
 * at all — see that port's own doc, `@jini-ai/cms/taxonomy`'s `write-service.ts`) — same "implemented
 * directly on the concrete class, not folded into the certified port" precedent
 * `MergeableEntryTermRepoPort` (`gated-hooks.ts`) and `AssignmentCountEntryTermRepoPort`
 * (`@jini-ai/cms/taxonomy`) already establish for `countOverlap`/`repointTerm`/`countByTerm` above.
 *
 * Deliberately kept as a SEPARATE, OPTIONAL field on `RouteDeps` (`entryTermReadRepo`, `routes/
 * types.ts`) rather than folded into the existing `entryTermRepo: EntryTermRepoPort & …`
 * intersection those other two additive ports widen: unlike them, `@jini-ai/cms/taxonomy`'s
 * `InMemoryEntryTermRepo` does NOT implement this method (it has no by-content read at all), and
 * `server/runtime/composition/app.ts`'s hermetic composition wires that exact class as
 * `entryTermRepo` — widening `entryTermRepo`'s own declared type would break that composition's
 * typecheck for a capability this dispatch has no in-memory adapter for. A `TemplateRenderDeps`
 * caller missing this field (every hermetic/unit test that doesn't opt in) degrades to "no terms
 * rendered" — see `resolveAssignedTermsForRender`'s own doc — never a throw.
 */
export interface EntryTermReadPort {
  listForContent(params: { contentType: string; contentId: string }): Promise<readonly AssignedTermView[]>;
}

export class SqliteEntryTermRepo implements EntryTermRepoPort, EntryTermReadPort, UnassignableEntryTermRepoPort {
  constructor(private readonly deps: { db: ContentDb; workspaceId: string }) {}

  /** Idempotent upsert keyed by `entry_terms_unique` (`workspaceId`, `contentType`, `contentId`,
   * `termId`) — mirrors `InMemoryEntryTermRepo.upsert`'s find-or-replace behavior. */
  async upsert(row: { contentType: string; contentId: string; termId: string; addedAt: string }): Promise<unknown> {
    const values = {
      workspaceId: this.deps.workspaceId,
      contentType: row.contentType,
      contentId: row.contentId,
      termId: row.termId,
      addedAt: row.addedAt,
    };
    this.deps.db
      .insert(entryTerms)
      .values(values)
      .onConflictDoUpdate({ target: [entryTerms.workspaceId, entryTerms.contentType, entryTerms.contentId, entryTerms.termId], set: { addedAt: row.addedAt } })
      .run();
    return row;
  }

  async deleteByContent(params: { workspaceId: string; contentType: string; contentId: string }): Promise<number> {
    const result = this.deps.db
      .delete(entryTerms)
      .where(
        and(
          eq(entryTerms.workspaceId, params.workspaceId),
          eq(entryTerms.contentType, params.contentType),
          eq(entryTerms.contentId, params.contentId)
        )
      )
      .run();
    return Number(result.changes ?? 0);
  }

  /** `UnassignableEntryTermRepoPort` (`@jini-ai/cms/taxonomy`) — additive capability for
   * `unassignTerms`. Returns the number of rows actually removed (0 or 1, given
   * `entry_terms_unique`'s `(workspaceId, contentType, contentId, termId)` uniqueness) rather than
   * throwing on a no-op — mirrors `deleteByContent`'s own "return the removed count" convention. */
  async remove(row: { contentType: string; contentId: string; termId: string }): Promise<number> {
    const result = this.deps.db
      .delete(entryTerms)
      .where(
        and(
          eq(entryTerms.workspaceId, this.deps.workspaceId),
          eq(entryTerms.contentType, row.contentType),
          eq(entryTerms.contentId, row.contentId),
          eq(entryTerms.termId, row.termId)
        )
      )
      .run();
    return Number(result.changes ?? 0);
  }

  /**
   * SPEC-018 C-207 (`mergeTerm`'s plan-time overlap disclosure, REQ-16) — counts content already
   * assigned to BOTH `fromTermId` and `intoTermId`. Not part of the certified `EntryTermRepoPort`
   * (that port has no by-term enumeration method at all) — an additive capability this dispatch's
   * gated-mutation composition needs, implemented identically on `InMemoryEntryTermRepo` so both
   * `server/app.ts`'s hermetic composition and `server/deps.ts`'s real one can drive the same
   * merge ceremony. Bounded by taxonomy's own low-volume assumption (ADR-044) — no cap needed.
   *
   * @complexity O(f + i) where f/i are the row counts for each term.
   * @overallScore 100
   */
  async countOverlap(params: { fromTermId: string; intoTermId: string }): Promise<number> {
    const fromRows = this.deps.db
      .select({ contentType: entryTerms.contentType, contentId: entryTerms.contentId })
      .from(entryTerms)
      .where(and(eq(entryTerms.workspaceId, this.deps.workspaceId), eq(entryTerms.termId, params.fromTermId)))
      .all();
    const intoKeys = new Set(
      this.deps.db
        .select({ contentType: entryTerms.contentType, contentId: entryTerms.contentId })
        .from(entryTerms)
        .where(and(eq(entryTerms.workspaceId, this.deps.workspaceId), eq(entryTerms.termId, params.intoTermId)))
        .all()
        .map((r) => `${r.contentType}::${r.contentId}`)
    );
    return fromRows.filter((r) => intoKeys.has(`${r.contentType}::${r.contentId}`)).length;
  }

  /**
   * SPEC-018 C-207 — the actual merge execution: re-points every `entry_terms` row from
   * `fromTermId` to `intoTermId` (upsert dedupes automatically via `entry_terms_unique`, so
   * content already assigned to both collapses to one row — the disclosed, ADR-044-named loss
   * mode `merge-term.ts`'s own header names), then deletes the now-empty `fromTermId` rows.
   *
   * @complexity O(f) in the number of rows currently assigned to `fromTermId`.
   * @overallScore 100
   */
  async repointTerm(params: { fromTermId: string; intoTermId: string }): Promise<{ repointedCount: number }> {
    const fromRows = this.deps.db
      .select()
      .from(entryTerms)
      .where(and(eq(entryTerms.workspaceId, this.deps.workspaceId), eq(entryTerms.termId, params.fromTermId)))
      .all();
    for (const row of fromRows) {
      await this.upsert({ contentType: row.contentType, contentId: row.contentId, termId: params.intoTermId, addedAt: row.addedAt });
    }
    this.deps.db
      .delete(entryTerms)
      .where(and(eq(entryTerms.workspaceId, this.deps.workspaceId), eq(entryTerms.termId, params.fromTermId)))
      .run();
    return { repointedCount: fromRows.length };
  }

  /**
   * `AssignmentCountEntryTermRepoPort` (`@jini-ai/cms/taxonomy`) — the guard `deleteTerm`/
   * `deleteTaxonomy` use to refuse destroying a live content assignment. Mirrors
   * `countOverlap`'s bounded-by-taxonomy's-own-low-volume-assumption rationale (ADR-044) — no cap
   * needed.
   *
   * @complexity O(n) in the number of `entry_terms` rows currently assigned to `termId`.
   * @overallScore 100
   */
  async countByTerm(params: { termId: string }): Promise<number> {
    const rows = this.deps.db
      .select({ id: entryTerms.id })
      .from(entryTerms)
      .where(and(eq(entryTerms.workspaceId, this.deps.workspaceId), eq(entryTerms.termId, params.termId)))
      .all();
    return rows.length;
  }

  /**
   * `EntryTermReadPort` (this file, above) — the public-render read path (2026-09-02 taxonomy
   * render-surface gap fix): every term currently assigned to one `(contentType, contentId)` pair,
   * joined with its own name and its owning taxonomy's name in one query rather than N+1 `findById`
   * calls. Ordered by `addedAt` so a page lists terms in the order they were assigned, not an
   * arbitrary join order.
   *
   * @complexity O(n) in the number of terms assigned to this one piece of content (typically single
   * digits) — one join query.
   */
  /**
   * T6 (required — "the terms read change is the widest", trash parallel plan §6): trashing never
   * touches `entry_terms` (decision 5 — a trashed term/taxonomy stays assigned), so the assignment
   * row survives untouched and must be filtered out HERE, at read time, exactly like every other
   * `entryTerms`<->`terms` read in this file. `termIsLive()`'s `NOT EXISTS` already covers the
   * `hiddenWithParent` case (a term whose taxonomy is trashed), so a taxonomy trash hides every one
   * of its terms from this render path with no extra join.
   */
  async listForContent(params: { contentType: string; contentId: string }): Promise<readonly AssignedTermView[]> {
    return this.deps.db
      .select({ termId: terms.id, termName: terms.name, taxonomyName: taxonomies.name })
      .from(entryTerms)
      .innerJoin(terms, eq(terms.id, entryTerms.termId))
      .innerJoin(taxonomies, eq(taxonomies.id, terms.taxonomyId))
      .where(
        and(
          eq(entryTerms.workspaceId, this.deps.workspaceId),
          eq(entryTerms.contentType, params.contentType),
          eq(entryTerms.contentId, params.contentId),
          termIsLive()
        )
      )
      .orderBy(entryTerms.addedAt)
      .all();
  }
}

export class SqliteTaxonomyRevisionRepo implements TaxonomyRevisionRepoPort {
  constructor(private readonly deps: { db: ContentDb; workspaceId: string }) {}

  async insert(row: TaxonomyRevisionRow): Promise<unknown> {
    this.deps.db
      .insert(taxonomyRevisions)
      .values({
        workspaceId: this.deps.workspaceId,
        taxonomyId: row.taxonomyId,
        op: row.op,
        previousStateJson: row.previousState == null ? null : JSON.stringify(row.previousState),
        actorId: row.actorId,
        recordedAt: row.recordedAt,
      })
      .run();
    return row;
  }
}

/** Sync `WriteServiceDeps.stampWatermark` binding over the real `content.db` watermark
 * (`db/sqlite/watermark.ts`'s certified `stampWatermarkTx`) — see that module's own
 * doc comment for why passing the plain `db` handle is safe here (no `db.transaction()` wraps
 * `taxonomy/write-service.ts`'s own mutations, so each call is its own implicit autocommit
 * statement; this stamp call is likewise its own autocommit statement, same atomicity envelope
 * every other individual write in this write-service already has). Disclosed narrowing, not a
 * silent gap: this package's write-service never wraps its own multi-row writes in one
 * transaction at all (see `write-service.ts`'s header), so the watermark stamp cannot be made any
 * more atomic with its sibling writes than those sibling writes already are with each other. */
export function sqliteStampWatermark(db: ContentDb): () => void {
  return () => {
    stampWatermarkTx({ tx: db as unknown as ContentDbTransaction });
  };
}
