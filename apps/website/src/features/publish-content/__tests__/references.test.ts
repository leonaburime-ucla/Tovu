import assert from "node:assert/strict";
import test from "node:test";

import { contributeCollectionEntryPublish } from "#src/features/entries/publish-content";
import { contributeMenusPublish } from "#src/features/navigation/publish-content";
import { contributePagePublish, contributePostPublish } from "#src/features/post/publish-content";
import { contributeTermPublish } from "#src/features/taxonomy/publish-content";
import { contributeWidgetAreaPublish, contributeWidgetPublish } from "#src/features/widgets/publish-content";

import type { PackedEntity, PublishContentContributor, PublishContentDeps } from "../type-registry.js";

/**
 * @file Plan G3 — each registered type's `references()`: what a scoped publish carries along with it
 * (`export-bundle.ts`'s `includeReferencedEntities` is tested on its own in
 * `export-bundle-selection.test.ts`). Built from the real contributors; `references()` reads only the
 * packed entity, so a bare deps bag is enough.
 */

const DEPS = { ports: {} } as unknown as PublishContentDeps;

function referencesOf(contributor: PublishContentContributor, entityType: string, state: Record<string, unknown>) {
  const packed: PackedEntity = { entityType, id: "x", schemaVersion: 1, contentHash: "h", hashVersion: 1, requiredBlobs: [], state };
  const handler = contributor.build(DEPS);
  return (handler.references?.(packed) ?? []).map((ref) => `${ref.entityType}:${ref.key}`).sort();
}

test("a page or post carries its images, its embedded widgets (node or html marker, by id or slug) and its terms", () => {
  const state = {
    bodyJson: {
      type: "doc",
      content: [
        { type: "image", attrs: { assetId: "m1" } },
        { type: "paragraph", content: [{ type: "widgetEmbed", attrs: { placementId: "p1", widgetEntryId: "w1" } }] },
      ],
    },
    bodyHtml: `<div data-embed-config='{"type":"widget","slug":"signup"}'></div><div data-embed-config='{"type":"post","id":"other"}'></div>`,
    termIds: ["t1", "t2"],
  };
  const expected = ["media:m1", "term:t1", "term:t2", "widget:signup", "widget:w1"];
  assert.deepEqual(referencesOf(contributePagePublish(), "page", state), expected);
  assert.deepEqual(referencesOf(contributePostPublish(), "post", state), expected, "another post's embed is not carried");
});

test("a collection entry carries its collection and what its body embeds", () => {
  const state = { type: "recipe", bodyJson: { type: "doc", content: [{ type: "widgetEmbed", attrs: { widgetEntryId: "w1" } }] } };
  assert.deepEqual(referencesOf(contributeCollectionEntryPublish(), "collection-entry", state), ["content-type:recipe", "widget:w1"]);
});

test("a widget carries the form, menu or term its config names", () => {
  const widget = contributeWidgetPublish();
  assert.deepEqual(referencesOf(widget, "widget", { widgetType: "contact-form", config: { formDefinitionId: "contact" } }), ["form:contact"]);
  assert.deepEqual(referencesOf(widget, "widget", { widgetType: "menu", config: { menuRef: "nav-1" } }), ["menu:nav-1"]);
  assert.deepEqual(referencesOf(widget, "widget", { widgetType: "recent-entries", config: { categoryTermId: "t1", maxItems: 3 } }), ["term:t1"]);
  assert.deepEqual(referencesOf(widget, "widget", { widgetType: "text", config: { body: "hi" } }), []);
});

test("a widget area carries the widgets it places", () => {
  const placements = [
    { placementId: "p1", widgetEntryId: "w1", enabled: true },
    { placementId: "p2", widgetEntryId: "w2", enabled: false },
  ];
  assert.deepEqual(referencesOf(contributeWidgetAreaPublish(), "widget-area", { regionKey: "sidebar", placements }), ["widget:w1", "widget:w2"]);
});

test("a term carries its taxonomy and its parent", () => {
  const term = contributeTermPublish();
  assert.deepEqual(referencesOf(term, "term", { taxonomyId: "tx1", parentId: "t0", name: "Soup" }), ["taxonomy:tx1", "term:t0"]);
  assert.deepEqual(referencesOf(term, "term", { taxonomyId: "tx1", parentId: null, name: "Soup" }), ["taxonomy:tx1"]);
});

test("a menu carries nothing: its links point at other content rather than being part of it", () => {
  const items = [{ id: "i1", label: "Home", target: { kind: "entryRef", entryId: "pg1" } }];
  assert.deepEqual(referencesOf(contributeMenusPublish(), "menu", { slug: "main", doc: { items } }), []);
});
