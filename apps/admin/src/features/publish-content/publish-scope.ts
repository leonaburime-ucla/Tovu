import { publishSectionForEntityTypes, type PublishScope, type PublishSection } from "@tovu/publish-content-ui";

/**
 * @file `plan-publish-sections-2026-09-25.md` §2 S2 — the pure label rules behind the dialog's title,
 * its idle-state primary button, and its description line. Kept here rather than inline in
 * `PublishContentDialog.tsx`/`use-publish-content-confirm.hooks.ts` so both read the SAME rules and
 * they can be unit tested without mounting the dialog. The per-section copy itself lives in the one
 * section table, `@tovu/publish-content-ui`'s `PUBLISH_SECTIONS` (plan G1).
 */

/**
 * The English copy key for a scope's dialog title / idle-state primary label, resolved through the
 * screen's own `Translate` at the call site (this module knows nothing about locales).
 *
 * - No `scope` at all (or an `entityTypes` that is not exactly one section's set) reads as publishing
 *   everything.
 * - `entityKeys` (non-empty) always wins and reads as a single-item publish, regardless of what
 *   `entityTypes` also carries — plan §1's "a per-row dialog is titled 'Publish item'".
 * - An `entityTypes` equal to one section's whole set, with no `entityKeys`, reads as that section's label.
 *
 * An empty `entityKeys` array is treated the same as an absent one, matching `PublishScope`'s own
 * contract (`ui/contract.ts`): emptiness is never a real selection here, only "nothing narrowed yet".
 *
 * @complexity O(sections × types).
 */
export function publishScopeTitleKey(scope: PublishScope | undefined): string {
  const section = scopeSection(scope);
  if (section === ITEM) return "Publish item";
  return section === ALL ? "Publish all content" : section.labelKey;
}

/** Owner decision 2026-09-25 — the dialog's description line. The unscoped sentence is unchanged;
 *  a section's own line (`PublishSection.descriptionKey`) names only what that dialog sends. */
const ALL_CONTENT_DESCRIPTION = "Sends your posts, pages and media to the live site. Deploy ships code; publish ships content.";

/**
 * The English copy key for the dialog's description line — the same scope resolution as
 * {@link publishScopeTitleKey}, so a dialog's title and its description can never name different
 * sections.
 *
 * @complexity O(sections × types).
 */
export function publishScopeDescriptionKey(scope: PublishScope | undefined): string {
  const section = scopeSection(scope);
  if (section === ITEM) return "Sends this item to the live site.";
  return section === ALL ? ALL_CONTENT_DESCRIPTION : section.descriptionKey;
}

const ITEM = Symbol("item");
const ALL = Symbol("all");

/**
 * The one scope resolution behind {@link publishScopeTitleKey} and {@link publishScopeDescriptionKey}
 * (rules on {@link publishScopeTitleKey}): a single item, everything, or one section.
 *
 * @complexity O(sections × types).
 */
function scopeSection(scope: PublishScope | undefined): typeof ITEM | typeof ALL | PublishSection {
  if (scope?.entityKeys !== undefined && scope.entityKeys.length > 0) return ITEM;
  if (scope?.entityTypes === undefined) return ALL;
  return publishSectionForEntityTypes(scope.entityTypes) ?? ALL;
}
