import assert from "node:assert/strict";
import test from "node:test";

import { CONTENT_HASH_VERSION } from "../content-hash.js";
import { PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION } from "../artifact-format.js";
import {
  applyPublishScope,
  includeReferencedEntities,
  selectBundleEntities,
  type PublishContentExportEnvelope,
  type ReferenceHandlers,
} from "../export-bundle.js";
import { collectBodyReferences } from "../content-references.js";
import { entityKey } from "../planner.js";
import type { PackedEntity } from "../type-registry.js";

/**
 * @file `selectBundleEntities` — the point at which an operator unchecking a row in the Publish
 * Content dialog stops being a UI state and becomes a fact about what the destination is given
 * (owner-directed, 2026-09-19).
 *
 * The property under test is the reason the selection is applied HERE rather than at apply time: a
 * deselected entity must be absent from the bundle, not merely skipped by something downstream. The
 * blob-manifest assertions matter for the same reason — the bytes of a deselected image must not be
 * uploaded to the live site either.
 */

function entity(over: { entityType: string; id: string; requiredBlobs?: readonly string[] }): PackedEntity {
  return {
    entityType: over.entityType,
    id: over.id,
    schemaVersion: 1,
    contentHash: `hash-${over.id}`,
    hashVersion: CONTENT_HASH_VERSION,
    requiredBlobs: over.requiredBlobs ?? [],
    state: { slug: over.id },
  };
}

const ENVELOPE: PublishContentExportEnvelope = {
  artifactFormatVersion: PUBLISH_CONTENT_ARTIFACT_FORMAT_VERSION,
  hashVersion: CONTENT_HASH_VERSION,
  sourceLabel: "Tovu",
  entities: [
    entity({ entityType: "media", id: "m1", requiredBlobs: ["sha-a"] }),
    entity({ entityType: "media", id: "m2", requiredBlobs: ["sha-b"] }),
    entity({ entityType: "post", id: "p1" }),
  ],
  blobManifest: ["sha-a", "sha-b"],
  skipped: [],
};

test("keeps exactly the selected entities and drops every other one", () => {
  const narrowed = selectBundleEntities(ENVELOPE, new Set([entityKey("media", "m1"), entityKey("post", "p1")]));

  assert.deepEqual(
    narrowed.entities.map((e) => entityKey(e.entityType, e.id)),
    ["media:m1", "post:p1"]
  );
  assert.equal(narrowed.entities.length, 2, "the deselected entity is absent, not marked");
});

test("recomputes the blob manifest so a deselected asset's bytes are never uploaded", () => {
  const narrowed = selectBundleEntities(ENVELOPE, new Set([entityKey("media", "m1")]));

  assert.deepEqual(narrowed.blobManifest, ["sha-a"]);
  assert.ok(!narrowed.blobManifest.includes("sha-b"), "the deselected media's bytes must not travel");
});

test("an empty selection produces an empty bundle, not the whole corpus", () => {
  // "The operator unchecked everything" and "the operator expressed no preference" are different
  // answers; only the CALLER can tell them apart, so this function never treats one as the other.
  const narrowed = selectBundleEntities(ENVELOPE, new Set());

  assert.deepEqual(narrowed.entities, []);
  assert.deepEqual(narrowed.blobManifest, []);
});

test("a key naming nothing in the bundle adds nothing to it", () => {
  const narrowed = selectBundleEntities(ENVELOPE, new Set(["post:p1", "post:does-not-exist"]));

  assert.deepEqual(
    narrowed.entities.map((e) => e.id),
    ["p1"]
  );
});

test("never narrows `skipped` — a skipped unit was never selectable in the first place", () => {
  const withSkipped: PublishContentExportEnvelope = {
    ...ENVELOPE,
    skipped: [{ entityType: "theme-files", id: "static/x", label: "static/x", reason: "blocked" }],
  };
  const narrowed = selectBundleEntities(withSkipped, new Set(["post:p1"]));
  assert.deepEqual(narrowed.skipped, withSkipped.skipped);
});

test("carries the envelope's own versions and label through untouched", () => {
  const narrowed = selectBundleEntities(ENVELOPE, new Set(["post:p1"]));

  assert.equal(narrowed.artifactFormatVersion, ENVELOPE.artifactFormatVersion);
  assert.equal(narrowed.hashVersion, ENVELOPE.hashVersion);
  assert.equal(narrowed.sourceLabel, ENVELOPE.sourceLabel);
  assert.notEqual(narrowed.entities, ENVELOPE.entities, "the original envelope is never mutated");
  assert.equal(ENVELOPE.entities.length, 3);
});

/**
 * @file `applyPublishScope` — `plan-publish-sections-2026-09-25.md` S1. Narrows an export envelope to
 * a section (or a section plus specific rows) BEFORE `selectBundleEntities` runs, so a "Publish pages"
 * dialog never even stages a media blob. `entityTypes` and `entityKeys` both narrow (AND) when both
 * are given. `skipped` is narrowed by the SAME predicate — a refused theme tree only appears in a
 * theme-files-scoped plan, never a pages-scoped one.
 */
const SKIPPED_THEME = { entityType: "theme-files", id: "static/x", label: "Theme: static/x", reason: "blocked" };

const SCOPED_ENVELOPE: PublishContentExportEnvelope = {
  ...ENVELOPE,
  skipped: [SKIPPED_THEME],
};

test("applyPublishScope with entityTypes keeps only that type, and recomputes blobManifest", () => {
  const scoped = applyPublishScope(SCOPED_ENVELOPE, { entityTypes: ["post"] });

  assert.deepEqual(
    scoped.entities.map((e) => entityKey(e.entityType, e.id)),
    ["post:p1"]
  );
  assert.deepEqual(scoped.blobManifest, [], "post p1 has no requiredBlobs");
});

test("applyPublishScope with entityTypes shrinks the blob manifest to the kept type's blobs", () => {
  const scoped = applyPublishScope(SCOPED_ENVELOPE, { entityTypes: ["media"] });

  assert.deepEqual(
    scoped.entities.map((e) => e.id),
    ["m1", "m2"]
  );
  assert.deepEqual(scoped.blobManifest, ["sha-a", "sha-b"]);
});

test("applyPublishScope with entityKeys keeps only those exact rows", () => {
  const scoped = applyPublishScope(SCOPED_ENVELOPE, { entityKeys: [entityKey("media", "m1")] });

  assert.deepEqual(scoped.entities.map((e) => e.id), ["m1"]);
  assert.deepEqual(scoped.blobManifest, ["sha-a"]);
});

test("applyPublishScope with both entityTypes and entityKeys ANDs them", () => {
  // A key from a type not in `entityTypes` matches nothing.
  const scoped = applyPublishScope(SCOPED_ENVELOPE, {
    entityTypes: ["post"],
    entityKeys: [entityKey("media", "m1"), entityKey("post", "p1")],
  });

  assert.deepEqual(scoped.entities.map((e) => entityKey(e.entityType, e.id)), ["post:p1"]);
});

test("applyPublishScope filters `skipped` by the same scope — present under its own type", () => {
  const scoped = applyPublishScope(SCOPED_ENVELOPE, { entityTypes: ["theme-files"] });
  assert.deepEqual(scoped.skipped, [SKIPPED_THEME]);
});

test("applyPublishScope filters `skipped` by the same scope — absent under a different type", () => {
  const scoped = applyPublishScope(SCOPED_ENVELOPE, { entityTypes: ["page"] });
  assert.deepEqual(scoped.skipped, []);
});

test("applyPublishScope carries envelope metadata through untouched and never mutates the input", () => {
  const scoped = applyPublishScope(SCOPED_ENVELOPE, { entityTypes: ["post"] });

  assert.equal(scoped.artifactFormatVersion, SCOPED_ENVELOPE.artifactFormatVersion);
  assert.equal(scoped.hashVersion, SCOPED_ENVELOPE.hashVersion);
  assert.equal(scoped.sourceLabel, SCOPED_ENVELOPE.sourceLabel);
  assert.equal(SCOPED_ENVELOPE.entities.length, 3, "the original envelope is never mutated");
  assert.equal(SCOPED_ENVELOPE.skipped.length, 1, "the original envelope is never mutated");
});

/**
 * @file `includeReferencedEntities` — owner decision 2026-09-25 ("images go along with pages and
 * posts"), generalized by plan G3: a scoped run carries along what its in-scope rows use, and nothing
 * else. Matched by id OR slug (a `/m/{slug}/…` URL), never adding a row the narrowed bundle already
 * holds, and following carried rows' own references.
 */
function stated(entityType: string, id: string, state: Record<string, unknown>, requiredBlobs: readonly string[] = []): PackedEntity {
  return { ...entity({ entityType, id, requiredBlobs }), state };
}

const bodyReferences = { references: (e: PackedEntity) => collectBodyReferences(e.state) };
const REF_HANDLERS: ReferenceHandlers = new Map([
  ["page", bodyReferences],
  ["post", bodyReferences],
]);

const REF_SOURCE: PublishContentExportEnvelope = {
  ...ENVELOPE,
  entities: [
    stated("media", "m1", { slug: "logo" }, ["sha-a"]),
    stated("media", "m2", { slug: "hero" }, ["sha-b"]),
    stated("media", "m3", { slug: "unused" }, ["sha-c"]),
    stated("page", "pg1", { bodyJson: { type: "doc", content: [{ type: "image", attrs: { assetId: "m1" } }] } }),
    stated("page", "pg2", { bodyHtml: `<img src="/m/hero/original">`, seoExtJson: JSON.stringify({ ogImage: "m1:public" }) }),
    stated("redirect", "r1", { bodyJson: { type: "doc", content: [{ type: "image", attrs: { assetId: "m3" } }] } }),
  ],
  blobManifest: ["sha-a", "sha-b", "sha-c"],
};

test("includeReferencedEntities adds exactly the media the kept pages reference, by id or slug", () => {
  const scoped = applyPublishScope(REF_SOURCE, { entityTypes: ["page"] });
  const { envelope, includedFor } = includeReferencedEntities(scoped, REF_SOURCE, REF_HANDLERS);

  assert.deepEqual(
    envelope.entities.map((e) => entityKey(e.entityType, e.id)).sort(),
    ["media:m1", "media:m2", "page:pg1", "page:pg2"]
  );
  assert.deepEqual(envelope.blobManifest.slice().sort(), ["sha-a", "sha-b"], "an unreferenced asset's bytes never travel");
  assert.deepEqual(Object.fromEntries(includedFor), { "media:m1": ["page:pg1", "page:pg2"], "media:m2": ["page:pg2"] });
});

test("includeReferencedEntities follows the operator's row selection — a deselected page brings nothing", () => {
  const scoped = applyPublishScope(REF_SOURCE, { entityTypes: ["page"] });
  const selected = selectBundleEntities(scoped, new Set([entityKey("page", "pg1")]));
  const { envelope, includedFor } = includeReferencedEntities(selected, REF_SOURCE, REF_HANDLERS);

  assert.deepEqual(envelope.entities.map((e) => entityKey(e.entityType, e.id)).sort(), ["media:m1", "page:pg1"]);
  assert.deepEqual(Object.fromEntries(includedFor), { "media:m1": ["page:pg1"] });
});

test("includeReferencedEntities never reads references off a type whose handler has no references()", () => {
  const scoped = applyPublishScope(REF_SOURCE, { entityTypes: ["redirect"] });
  const { envelope, includedFor } = includeReferencedEntities(scoped, REF_SOURCE, REF_HANDLERS);

  assert.deepEqual(envelope.entities.map((e) => e.id), ["r1"]);
  assert.equal(includedFor.size, 0);
});

test("includeReferencedEntities leaves a media row the bundle already holds as an ordinary row", () => {
  const scoped = applyPublishScope(REF_SOURCE, { entityTypes: ["page", "media"] });
  const { envelope, includedFor } = includeReferencedEntities(scoped, REF_SOURCE, REF_HANDLERS);

  assert.equal(envelope.entities.length, scoped.entities.length, "nothing is added twice");
  assert.equal(includedFor.size, 0, "an in-scope media row is the operator's own choice, not an add-on");
});

// page → widget (by slug, from an html marker) → form, and a widget area → the same widget.
const refsFrom = (field: string, entityType: string) => ({
  references: (e: PackedEntity) => (typeof e.state[field] === "string" ? [{ entityType, key: e.state[field] as string }] : []),
});
const CHAIN_HANDLERS: ReferenceHandlers = new Map([
  ["page", bodyReferences],
  ["widget", refsFrom("formSlug", "form")],
  ["widget-area", refsFrom("widgetId", "widget")],
  ["term", refsFrom("parentId", "term")],
]);
const CHAIN_SOURCE: PublishContentExportEnvelope = {
  ...ENVELOPE,
  entities: [
    stated("form", "contact", { slug: "contact" }),
    stated("form", "other", { slug: "other" }),
    stated("widget", "w1", { slug: "signup", formSlug: "contact" }),
    stated("widget-area", "sidebar", { widgetId: "w1" }),
    stated("page", "pg1", { bodyHtml: `<div data-embed-config='{"type":"widget","slug":"signup"}'></div>` }),
    stated("term", "t1", { parentId: "t2" }),
    stated("term", "t2", { parentId: "t3" }),
    stated("term", "t3", { parentId: "t2" }),
  ],
  blobManifest: [],
};

test("includeReferencedEntities follows carried rows' own references, naming the in-scope roots for each", () => {
  const scoped = applyPublishScope(CHAIN_SOURCE, { entityTypes: ["page", "widget-area"] });
  const { envelope, includedFor } = includeReferencedEntities(scoped, CHAIN_SOURCE, CHAIN_HANDLERS);

  assert.deepEqual(
    envelope.entities.map((e) => entityKey(e.entityType, e.id)),
    ["widget:w1", "form:contact", "widget-area:sidebar", "page:pg1"],
    "carried rows come first, in the order they were reached"
  );
  assert.deepEqual(Object.fromEntries(includedFor), {
    "widget:w1": ["page:pg1", "widget-area:sidebar"],
    "form:contact": ["page:pg1", "widget-area:sidebar"],
  });
});

test("includeReferencedEntities does not walk through a row the bundle already holds", () => {
  const scoped = applyPublishScope(CHAIN_SOURCE, { entityTypes: ["widget", "widget-area"] });
  const { envelope, includedFor } = includeReferencedEntities(scoped, CHAIN_SOURCE, CHAIN_HANDLERS);

  assert.deepEqual(envelope.entities.map((e) => entityKey(e.entityType, e.id)), ["form:contact", "widget:w1", "widget-area:sidebar"]);
  assert.deepEqual(Object.fromEntries(includedFor), { "form:contact": ["widget:w1"] }, "the form is the widget's, not the area's");
});

test("includeReferencedEntities stops on a reference cycle instead of looping", () => {
  const scoped = selectBundleEntities(CHAIN_SOURCE, new Set([entityKey("term", "t1")]));
  const { envelope, includedFor } = includeReferencedEntities(scoped, CHAIN_SOURCE, CHAIN_HANDLERS);

  assert.deepEqual(envelope.entities.map((e) => entityKey(e.entityType, e.id)), ["term:t2", "term:t3", "term:t1"]);
  assert.deepEqual(Object.fromEntries(includedFor), { "term:t2": ["term:t1"], "term:t3": ["term:t1"] });
});
