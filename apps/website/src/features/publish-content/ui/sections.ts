/**
 * @file Plan G1 (`plan-publish-all-types-2026-09-25.md` §4, "Section buttons + dialog type names") —
 * the ONE table of publishable sections. Each admin list page's "Publish …" button, the dialog's
 * title/description for a section-scoped run, and the dialog's type column all read from here, so
 * adding a publishable type is one row (or one `entityTypes` entry) instead of four hand-kept maps.
 *
 * A section sends its WHOLE `entityTypes` list: a collection is its content type plus its entries,
 * a category group is its taxonomy plus its terms. Every registered publish-content contributor sits
 * in exactly one section — `__tests__/sections.test.ts` pins that against the real registry.
 *
 * `labelKey`/`descriptionKey`/`typeLabelKeys` are English copy keys; the admin resolves them through
 * its own dictionary (`dashboard-i18n.ts`). Pure data, no runtime dependency (see `index.ts`).
 */

export interface PublishSection {
  /** Stable id a list page names its button by, e.g. `<PublishSectionButton section="forms" />`. */
  readonly section: string;
  /** Everything this section's button sends — the dialog's `scope.entityTypes`, verbatim. */
  readonly entityTypes: readonly string[];
  /** Button label and the section-scoped dialog's title. */
  readonly labelKey: string;
  /** The section-scoped dialog's description line. */
  readonly descriptionKey: string;
  /** Friendly name per entity type, shown in the dialog's type column. */
  readonly typeLabelKeys: Readonly<Record<string, string>>;
}

export const PUBLISH_SECTIONS = [
  section("pages", "Publish pages", "Sends your pages to the live site.", { page: "Page" }),
  section("posts", "Publish posts", "Sends your posts to the live site.", { post: "Post" }),
  section("media", "Publish media", "Sends your media to the live site.", { media: "Media" }),
  section("menus", "Publish menus", "Sends your menus to the live site.", { menu: "Menu" }),
  section("redirects", "Publish redirects", "Sends your redirects to the live site.", { redirect: "Redirect" }),
  section("themes", "Publish themes", "Sends your themes to the live site.", { "theme-files": "Theme" }),
  section("forms", "Publish forms", "Sends your forms to the live site.", { form: "Form" }),
  section("collections", "Publish collections", "Sends your collections and their entries to the live site.", {
    "content-type": "Collection",
    "collection-entry": "Entry",
  }),
  section("categories", "Publish categories & tags", "Sends your categories and tags to the live site.", {
    taxonomy: "Taxonomy",
    term: "Term",
  }),
  section("widgets", "Publish widgets", "Sends your widgets and widget regions to the live site.", {
    widget: "Widget",
    "widget-area": "Widget region",
  }),
] as const satisfies readonly PublishSection[];

export type PublishSectionId = (typeof PUBLISH_SECTIONS)[number]["section"];

/** @complexity O(sections). */
export function publishSectionById(id: string): PublishSection | undefined {
  return PUBLISH_SECTIONS.find((candidate) => candidate.section === id);
}

/**
 * The section whose `entityTypes` is exactly this set (order-insensitive), or `undefined` — a
 * scope naming some other mix of types is not any one section's button.
 *
 * @complexity O(sections × types).
 */
export function publishSectionForEntityTypes(entityTypes: readonly string[]): PublishSection | undefined {
  const wanted = new Set(entityTypes);
  return PUBLISH_SECTIONS.find(
    (candidate) =>
      candidate.entityTypes.length === wanted.size && candidate.entityTypes.every((type) => wanted.has(type)),
  );
}

/** The friendly type name for the dialog's type column, or the raw `entityType` for a type no
 *  section names yet (degraded, never blank). @complexity O(sections). */
export function publishEntityTypeLabel(entityType: string): string {
  for (const candidate of PUBLISH_SECTIONS) {
    const label: string | undefined = (candidate.typeLabelKeys as Readonly<Record<string, string>>)[entityType];
    if (label !== undefined) return label;
  }
  return entityType;
}

function section<const S extends string, const T extends Record<string, string>>(
  id: S,
  labelKey: string,
  descriptionKey: string,
  typeLabelKeys: T,
): { section: S; entityTypes: readonly (keyof T & string)[]; labelKey: string; descriptionKey: string; typeLabelKeys: T } {
  return { section: id, entityTypes: Object.keys(typeLabelKeys) as (keyof T & string)[], labelKey, descriptionKey, typeLabelKeys };
}
