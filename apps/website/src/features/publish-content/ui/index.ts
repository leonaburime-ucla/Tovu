/**
 * @file Task 11 — the public surface of `features/publish-content/ui/`, imported by `apps/admin` as
 * `@tovu/publish-content-ui` (see `apps/admin/tsconfig.json` `paths` AND `apps/admin/vite.config.ts`
 * `resolve.alias` — both are required; a tsconfig path alone does not resolve at build time).
 *
 * ## What belongs in this folder, and what does not
 *
 * Everything here is **pure TypeScript with no runtime dependency at all** — no React, no `node:*`,
 * no repo, no `planner.ts`. It holds the publish dialog's *semantics*: which rows a run writes, what
 * each outcome is called, and when the ceremony may advance. It lives in `apps/website` rather than
 * `apps/admin` because a second copy of those rules in the admin package could drift from
 * `planner.ts`'s real behaviour without anything going red.
 *
 * The React component and the hook that calls the API stay in `apps/admin`. They must: `apps/website/
 * src` contains zero `.tsx` files, the root tsconfig has no `"jsx"` setting, and React is not a root
 * dependency — a component here would force all three into the server package permanently. Admin
 * also dedupes React across five copies (`vite.config.ts` `resolve.dedupe`, because each
 * `@jini-ai/*` package bundles its own); anything under this folder is built by admin's Vite and
 * inherits that dedupe, which is a second reason it must never grow a React dependency of its own.
 *
 * `__tests__/ui-stays-client-safe.boundary.test.ts` enforces both rules.
 */
export type {
  PublishContentConfirmResult,
  PublishContentExecuteResult,
  PublishContentOutcomeKind,
  PublishContentOutcomeRow,
  PublishContentPeerSummary,
  PublishContentPlanResult,
  PublishContentReport,
  PublishScope,
} from "./contract.js";

export type { PublishReportRow, PublishReportSummary, PublishRowDisposition } from "./report-rows.js";
export {
  countSelectedPublishing,
  publishRowDisposition,
  rowPublishesWithSelection,
  selectableRowKeys,
  summarizePublishReport,
  toPublishReportRows,
} from "./report-rows.js";

export type { CriteriaSelection, PublishCriteria, PublishRequestResult } from "./criteria.js";
export {
  applyPublishCriteria,
  decodePublishCriteriaFromQuery,
  encodePublishCriteriaToQuery,
  parsePublishContentToolInput,
  PUBLISH_CONTENT_CAPABILITY,
  PUBLISH_CRITERIA_QUERY_PARAM,
} from "./criteria.js";

export type { PublishSection, PublishSectionId } from "./sections.js";
export {
  PUBLISH_SECTIONS,
  publishEntityTypeLabel,
  publishSectionById,
  publishSectionForEntityTypes,
} from "./sections.js";

export type { PublishContentPhase } from "./phase.js";
export { canConfirmPlan, canRequestPlan, confirmationTokenFor, planOnScreen } from "./phase.js";
