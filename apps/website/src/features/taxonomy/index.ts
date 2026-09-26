/**
 * @file Public surface (barrel) for taxonomy — re-exported from `@jini-ai/cms/taxonomy`.
 *
 * The domain moved into the package on 2026-08-03 so a second host can use the same taxonomies,
 * terms, hierarchy rules, and term-assignment chokepoint. What is left in this directory is only
 * what is genuinely this host's:
 *
 * - `repo.sqlite.ts` — the Drizzle adapters. They name `db/schema.sqlite.ts`, this repo's shared
 *   1,246-line schema covering every domain, so they are host persistence, not library code.
 * - `gated-hooks.ts` — the `mergeTerm` ceremony's `GatedMutationHooks` factory. It composes
 *   `core/gated-mutations`, a kernel that has not been extracted, so it is composition over a
 *   host-owned module.
 * - `tool-registrations.ts` — the same, plus it binds the gateway's `plan()` into the agent-tool
 *   layer and is the seam `assistant/tool-registrations.ts` reaches uniformly across domains.
 *
 * Everything else here is a re-export, and the shape of what is *not* re-exported is the point:
 * there is no SQLite, hooks, or registration export on this barrel, so nothing outside the
 * composition root can accidentally depend on this host's persistence or gateway choice.
 */
export {
  TaxonomyNotApplicableError,
  WorkspaceMismatchError,
  ContentTypeMismatchError,
  TaxonomyNotHierarchicalError,
  ParentCrossTaxonomyError,
  TermNotFoundError,
  HierarchyCycleDetectedError,
  wouldCreateCycle,
  validateContentJoin,
  validateHierarchyAssignment,
  TAXONOMY_ALLOWED_CONTENT_TYPES,
  isContentTypeOnAllowList,
  TaxonomyRecordNotFoundError,
  TermRecordNotFoundError,
  ContentRecordNotFoundError,
  createTaxonomy,
  createTerm,
  renameTerm,
  assignTerms,
  unassignTerms,
  deleteTerm,
  deleteTaxonomy,
  TermHasAssignedContentError,
  TermHasChildTermsError,
  TaxonomyHasAssignedContentError,
  onContentDeleted,
  listTaxonomiesWithTerms,
  SameTermMergeError,
  planMergeTerm,
  confirmMergeTerm,
  executeMergeTerm,
  InMemoryTaxonomyRepo,
  InMemoryTermRepo,
  InMemoryEntryTermRepo,
  InMemoryTaxonomyRevisionRepo,
  InMemoryContentLookup,
  noopStampWatermark,
  toTaxonomyOutbox,
  createPostBackedContentLookup,
  createContentLookup,
  taxonomyAgentToolCatalog,
  importTaxonomy,
  importTerm,
  TaxonomyVersionConflictError,
} from "@jini-ai/cms/taxonomy";

export type {
  TermTreeLookup,
  AuthorizeFn,
  Taxonomy,
  Term,
  TaxonomyRepoPort,
  TermRepoPort,
  EntryTermRepoPort,
  ContentLookupPort,
  ContentRecordLookupPort,
  ContentTypeTaxonomyPolicyPort,
  TaxonomyRevisionRow,
  TaxonomyRevisionRepoPort,
  ClockPort,
  IdGeneratorPort,
  WriteServiceDeps,
  CreateTaxonomyRequired,
  CreateTermRequired,
  RenameTermRequired,
  AssignTermsRequired,
  UnassignTermsRequired,
  UnassignableEntryTermRepoPort,
  DeleteTermRequired,
  DeleteTaxonomyRequired,
  DeletableTaxonomyRepoPort,
  DeletableTermRepoPort,
  AssignmentCountEntryTermRepoPort,
  TransactionalRepoPort,
  EntryTermsCleanupPort,
  OnContentDeletedRequired,
  TaxonomyListPort,
  TermListPort,
  TaxonomyWithTerms,
  MergeTermPlanDetails,
  PlanMergeTermRequired,
  ConfirmMergeTermRequired,
  ExecuteMergeTermRequired,
  TaxonomyAgentToolDefinition,
  TaxonomyAgentToolSideEffect,
  TaxonomyAgentToolActorClassRule,
  ImportableTaxonomyRepoPort,
  ImportableTermRepoPort,
} from "@jini-ai/cms/taxonomy";
