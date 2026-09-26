/**
 * @file Shared reason-string builders for `repo-handler.ts`'s factory —
 * `ADS-memory/.local-artifacts/plan-publish-all-types-2026-09-25.md` §2.3.
 *
 * Every factory-built handler's precheck/apply refusals come from here, so the SAME sentence a
 * type-specific handler already throws today (`features/post/publish-content.ts`,
 * `features/media/publish-content.ts`, `features/navigation/publish-content.ts`) keeps matching
 * `ui/report-rows.ts`'s `REASON_REWRITES` regexes verbatim once that handler migrates onto the
 * factory — see each builder's own doc for the exact existing sentence it mirrors. Each builder has a
 * planned user: `malformedKey` (M-RED, redirect's existing sentence), `tombstonedAtDestination`
 * (H-CT, content-type), `missingDependency` (H-EN, collection-entry). G2 adds the `ui/report-rows.ts`
 * rewrites for the last two.
 *
 * Zero imports — mirrors `apply-errors.ts`'s own zero-import property (that file's header explains
 * why: it lets both `repo-handler.ts` and any type-specific `publish-content.ts` value-import this
 * module without ever creating a cycle back into `type-registry.ts`).
 */

/** Ports for this type are absent on the current deps bag, so nothing here can even be looked up.
 *  Mirrors `features/media/publish-content.ts`'s/`features/navigation/publish-content.ts`'s existing
 *  `cannot be prechecked — no ... wired for this deps bag` wording exactly — matched by
 *  `ui/report-rows.ts`'s `/cannot be prechecked — no \w+ wired for this deps bag/`.
 *  @complexity O(1). */
export function notWired(entityType: string, id: string, portName: string): string {
  return `${entityType} entity '${id}' cannot be prechecked — no ${portName} wired for this deps bag`;
}

/** A second unique address (slug, key, name, ...) besides `id` is already held by a different id at
 *  the destination. Mirrors `features/post/publish-content.ts`'s/`features/media/publish-content.ts`'s
 *  existing `slug '...' is already held by a different <type> ('<id>')` wording exactly — matched by
 *  `ui/report-rows.ts`'s `/^(?:menu )?slug '.+' is already held by a different \w+/`.
 *  @complexity O(1). */
export function addressHeldByOther(entityType: string, field: string, value: string, holderId: string): string {
  return `${field} '${value}' is already held by a different ${entityType} ('${holderId}')`;
}

/** Like {@link addressHeldByOther}, but the holder is in the Trash: a trashed row keeps its unique
 *  address, so the create would collide. Worded to match the trash rewrite in `ui/report-rows.ts`.
 *  @complexity O(1). */
export function addressHeldInTrash(entityType: string, field: string, value: string, holderId: string): string {
  return `${entityType} '${holderId}' is in the trash at this destination and still holds ${field} '${value}' — restore it, or delete it permanently from the Trash, before publishing`;
}

/** The destination's own row for this id is in the Trash — restoring it there is the operator's move,
 *  not an overwrite. Mirrors `features/post/publish-content.ts`'s existing wording exactly — matched
 *  by `ui/report-rows.ts`'s `/^(?:\w+ )?'.+' is in the trash at this destination/`.
 *  @complexity O(1). */
export function trashedAtDestination(entityType: string, id: string): string {
  return `${entityType} '${id}' is in the trash at this destination — restore it before publishing over it, or publishing would resurrect it as live content`;
}

/** The destination moved on between plan and apply — the optimistic-concurrency mismatch, with
 *  `detail` phrasing which of the three CAS failures occurred. Mirrors
 *  `features/media/publish-content.ts`'s existing `<type> '<id>' changed on the destination during
 *  apply: <detail>` wording exactly.
 *  @complexity O(1). */
export function changedSincePlan(entityType: string, id: string, detail: string): string {
  return `${entityType} '${id}' changed on the destination during apply: ${detail}`;
}

/** A type-specific `validate()` refusal: `id` references `depType:depId`, which this destination is
 *  missing and which is not itself part of the same bundle. New wording — no existing handler has a
 *  `dependsOn` this specific yet; G2 adds a `ui/report-rows.ts` rewrite once a real type uses it.
 *  @complexity O(1). */
export function missingDependency(entityType: string, id: string, depType: string, depId: string): string {
  return `${entityType} '${id}' depends on ${depType} '${depId}', which is missing at this destination`;
}

/** A packed entity's natural key could not be parsed back into its component parts. New wording,
 *  generalizing `features/redirects/publish-content.ts`'s equivalent ad hoc message for any factory
 *  type with a composite `idOf`.
 *  @complexity O(1). */
export function malformedKey(entityType: string, id: string, expectedShape: string): string {
  return `${entityType} entity '${id}' has a malformed natural key (expected '${expectedShape}')`;
}

/** The destination's row for this id is a permanent tombstone rather than an ordinary Trash entry —
 *  distinct from {@link trashedAtDestination} because it can never be restored, so publishing over it
 *  is refused outright. New wording; G2 adds a rewrite once a real type uses it.
 *  @complexity O(1). */
export function tombstonedAtDestination(entityType: string, id: string): string {
  return `${entityType} '${id}' is permanently removed at this destination and cannot be republished over`;
}
