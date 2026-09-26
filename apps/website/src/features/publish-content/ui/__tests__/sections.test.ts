/**
 * @file Plan G1 — the one section table (`sections.ts`) against the real publish-content registry: a
 * contributor no section names would have no Publish button and a raw-id type column; a contributor
 * two sections name would make a scope resolve to the wrong title.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { installFirstPartyPublishContentTypes } from "#src/server/runtime/composition/publish-content-manifest";
import {
  listPublishContentContributors,
  resetPublishContentContributorsForTests,
} from "#src/features/publish-content/type-registry";

import {
  PUBLISH_SECTIONS,
  publishEntityTypeLabel,
  publishEntityTypePluralLabel,
  publishSectionById,
  publishSectionForEntityTypes,
} from "../sections.js";

test("every registered publish-content contributor sits in exactly one section", () => {
  resetPublishContentContributorsForTests();
  installFirstPartyPublishContentTypes();
  const registered = listPublishContentContributors().map((c) => c.entityType);
  assert.ok(registered.length > 0);
  for (const entityType of registered) {
    const owners = PUBLISH_SECTIONS.filter((s) => (s.entityTypes as readonly string[]).includes(entityType));
    assert.equal(owners.length, 1, `${entityType} sits in ${owners.map((s) => s.section).join(", ") || "no section"}`);
  }
  const named = PUBLISH_SECTIONS.flatMap((s) => [...s.entityTypes]);
  assert.deepEqual([...named].sort(), [...registered].sort(), "a section names a type the registry does not hold");
  resetPublishContentContributorsForTests();
});

test("section ids are unique and every section's entityTypes are exactly its typeLabelKeys", () => {
  assert.equal(new Set(PUBLISH_SECTIONS.map((s) => s.section)).size, PUBLISH_SECTIONS.length);
  for (const s of PUBLISH_SECTIONS) assert.deepEqual([...s.entityTypes], Object.keys(s.typeLabelKeys));
  for (const s of PUBLISH_SECTIONS) assert.deepEqual(Object.keys(s.typePluralLabelKeys), Object.keys(s.typeLabelKeys));
});

test("the existing six sections still send exactly the one type they sent before", () => {
  const sent = Object.fromEntries(
    ["pages", "posts", "media", "menus", "redirects", "themes"].map((id) => [id, [...publishSectionById(id)!.entityTypes]]),
  );
  assert.deepEqual(sent, {
    pages: ["page"],
    posts: ["post"],
    media: ["media"],
    menus: ["menu"],
    redirects: ["redirect"],
    themes: ["theme-files"],
  });
});

test("the new sections send their whole type set", () => {
  assert.deepEqual([...publishSectionById("forms")!.entityTypes], ["form"]);
  assert.deepEqual([...publishSectionById("collections")!.entityTypes], ["content-type", "collection-entry"]);
  assert.deepEqual([...publishSectionById("categories")!.entityTypes], ["taxonomy", "term"]);
  assert.deepEqual([...publishSectionById("widgets")!.entityTypes], ["widget", "widget-area"]);
  assert.equal(publishSectionById("nope"), undefined);
});

test("publishSectionForEntityTypes matches a whole set in any order, and nothing else", () => {
  assert.equal(publishSectionForEntityTypes(["term", "taxonomy"])?.section, "categories");
  assert.equal(publishSectionForEntityTypes(["page"])?.section, "pages");
  assert.equal(publishSectionForEntityTypes(["taxonomy"]), undefined);
  assert.equal(publishSectionForEntityTypes(["page", "post"]), undefined);
  assert.equal(publishSectionForEntityTypes([]), undefined);
});

test("publishEntityTypeLabel names each type for an owner and falls back to the raw id", () => {
  assert.equal(publishEntityTypeLabel("theme-files"), "Theme");
  assert.equal(publishEntityTypeLabel("collection-entry"), "Entry");
  assert.equal(publishEntityTypeLabel("widget-area"), "Widget region");
  assert.equal(publishEntityTypeLabel("something-new"), "something-new");
});

test("publishEntityTypePluralLabel names each type in the plural and falls back to the raw id", () => {
  assert.equal(publishEntityTypePluralLabel("form"), "Forms");
  assert.equal(publishEntityTypePluralLabel("theme-files"), "Themes");
  assert.equal(publishEntityTypePluralLabel("collection-entry"), "Entries");
  assert.equal(publishEntityTypePluralLabel("taxonomy"), "Taxonomies");
  assert.equal(publishEntityTypePluralLabel("widget-area"), "Widget regions");
  assert.equal(publishEntityTypePluralLabel("media"), "Media");
  assert.equal(publishEntityTypePluralLabel("something-new"), "something-new");
});
