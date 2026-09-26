/**
 * @file Public surface (barrel) for `features/entries` — re-exported from `@jini-ai/cms/entries`.
 *
 * The domain moved into the package on 2026-08-03 so a second host can use the same entry write
 * path, revision machinery, and field validation. What is left in this directory is only what is
 * genuinely this host's:
 *
 * - `repo.sqlite.ts` — the Drizzle adapter. It names `db/schema.sqlite.ts`, which is this repo's shared
 *   1,246-line schema covering every domain, so it is host persistence, not library code.
 *
 * Everything else here is a re-export, and the shape of what is *not* re-exported is the point:
 * there is no SQLite export on this barrel, so nothing outside the composition root can
 * accidentally depend on this host's persistence choice.
 *
 * A handful of the moved files also survive as per-file re-export shims (`errors.ts`, `list.ts`,
 * `repo.memory.ts`, `types.ts`, `write-service.ts`). They exist only because `src/widgets/` still
 * deep-imports those paths and is being ported by separate work in flight; when that lands, the
 * shims retire and its imports come through this barrel like everyone else's.
 */
export type {
  EntryStatus,
  EntryFieldsJson,
  EntryRecord,
  OwningContentType,
  ActorIdentityInput,
  Result,
} from "@jini-ai/cms/entries";

export type { EntryListPort } from "@jini-ai/cms/entries";
export { listEntries } from "@jini-ai/cms/entries";

export type { FieldValidationError, ValidateFieldsResult } from "@jini-ai/cms/entries";
export { validateFieldsAgainstSchema, selectVisibleEntryFields } from "@jini-ai/cms/entries";

/**
 * Re-exported as **values**, not types: callers catch them with `instanceof`. Because this file
 * re-exports rather than redeclares, there is exactly one class object for each — the package's. A
 * local re-declaration would produce a second constructor that every existing `instanceof` check
 * would silently fail against, turning a handled domain error into an unhandled 500.
 */
export {
  ForbiddenError,
  EntryNotFoundError,
  ContentTypeNotFoundError,
  ContentTypeNotActiveError,
  EntrySlugConflictError,
  VersionConflictError,
  EntryFieldValidationError,
} from "@jini-ai/cms/entries";

export type { EntryLifecycleOp, EntryLifecycleHandler } from "@jini-ai/cms/entries";
export {
  ENTRY_LIFECYCLE_OP_NAMES,
  ENTRY_LIFECYCLE_OPS,
  parseEntryLifecycleOp,
} from "@jini-ai/cms/entries";

export type {
  AuthorizeFn,
  EntryRevisionInput,
  EntryRepoPort,
  ContentTypeLookupPort,
  OutboxPort,
  WatermarkPort,
  CreateEntryRequired,
  UpdateEntryRequired,
  PublishUnpublishEntryRequired,
} from "@jini-ai/cms/entries";
export { createEntry, updateEntry, publishEntry, unpublishEntry, importEntry } from "@jini-ai/cms/entries";

export { InMemoryEntryRepo, toEntryOutbox } from "@jini-ai/cms/entries";

/** The agent-tool surface for this domain (see the package's `agent-tools.ts` for what is deliberately omitted). */
export {
  entriesAgentToolCatalog,
  type EntriesAgentToolDefinition,
  type EntriesAgentToolSideEffect,
} from "@jini-ai/cms/entries";

/**
 * The agent-tool wiring for this domain. Also re-exported (unchanged) by `tool-registrations.ts`
 * as a thin shim, since `assistant/tool-registrations.ts` imports every domain uniformly as
 * `../<domain>/tool-registrations` — see that file's own header for why it stays a separate file
 * rather than being deleted in favor of this barrel export.
 */
export {
  buildEntriesRegistrations,
  entriesDerivedRisk,
  type EntriesToolDeps,
} from "@jini-ai/cms/entries";
