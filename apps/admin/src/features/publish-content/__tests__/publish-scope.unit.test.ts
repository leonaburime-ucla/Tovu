import { describe, expect, it } from "vitest";

import { publishScopeDescriptionKey, publishScopeTitleKey } from "../publish-scope";

/**
 * @file `plan-publish-sections-2026-09-25.md` §2 S2 — the pure label rules the dialog title, the
 * idle-state primary button, and (in S3) each section's own button all read from. Kept pure and
 * tested on its own so the dialog's own test file only has to assert on the rendered result, never
 * re-derive the mapping.
 */
describe("publishScopeTitleKey", () => {
  it("no scope at all reads as publishing everything", () => {
    expect(publishScopeTitleKey(undefined)).toBe("Publish all content");
  });

  it("a single-type scope with no entityKeys reads as that type's section label", () => {
    expect(publishScopeTitleKey({ entityTypes: ["page"] })).toBe("Publish pages");
    expect(publishScopeTitleKey({ entityTypes: ["post"] })).toBe("Publish posts");
    expect(publishScopeTitleKey({ entityTypes: ["media"] })).toBe("Publish media");
    expect(publishScopeTitleKey({ entityTypes: ["menu"] })).toBe("Publish menus");
    expect(publishScopeTitleKey({ entityTypes: ["redirect"] })).toBe("Publish redirects");
    expect(publishScopeTitleKey({ entityTypes: ["theme-files", "active-theme"] })).toBe("Publish themes");
  });

  it("entityKeys present reads as a single-item publish, regardless of entityTypes", () => {
    expect(publishScopeTitleKey({ entityTypes: ["page"], entityKeys: ["page:1"] })).toBe("Publish item");
  });

  it("more than one entityType with no entityKeys falls back to the all-content label", () => {
    expect(publishScopeTitleKey({ entityTypes: ["page", "post"] })).toBe("Publish all content");
  });

  it("an empty entityKeys array is treated as absent, not as a single-item publish", () => {
    expect(publishScopeTitleKey({ entityTypes: ["page"], entityKeys: [] })).toBe("Publish pages");
  });
});

describe("multi-type sections (plan G1)", () => {
  it("a scope equal to one section's whole type set, in any order, reads as that section", () => {
    expect(publishScopeTitleKey({ entityTypes: ["form"] })).toBe("Publish forms");
    expect(publishScopeTitleKey({ entityTypes: ["content-type", "collection-entry"] })).toBe("Publish collections");
    expect(publishScopeTitleKey({ entityTypes: ["term", "taxonomy"] })).toBe("Publish categories & tags");
    expect(publishScopeTitleKey({ entityTypes: ["widget", "widget-area"] })).toBe("Publish widgets");
    expect(publishScopeDescriptionKey({ entityTypes: ["widget", "widget-area"] })).toBe(
      "Sends your widgets and widget regions to the live site.",
    );
  });

  it("part of a section's type set is not that section", () => {
    expect(publishScopeTitleKey({ entityTypes: ["taxonomy"] })).toBe("Publish all content");
  });
});

/** Owner decision 2026-09-25 — the dialog's description line says what THIS dialog sends, not the
 *  all-content sentence in every section. */
describe("publishScopeDescriptionKey", () => {
  it("keeps the all-content sentence when nothing is narrowed", () => {
    const all = "Sends your posts, pages and media to the live site. Deploy ships code; publish ships content.";
    expect(publishScopeDescriptionKey(undefined)).toBe(all);
    expect(publishScopeDescriptionKey({ entityTypes: ["page", "post"] })).toBe(all);
  });

  it("names the section a single-type scope sends", () => {
    expect(publishScopeDescriptionKey({ entityTypes: ["page"] })).toBe("Sends your pages to the live site.");
    expect(publishScopeDescriptionKey({ entityTypes: ["post"] })).toBe("Sends your posts to the live site.");
    expect(publishScopeDescriptionKey({ entityTypes: ["media"] })).toBe("Sends your media to the live site.");
    expect(publishScopeDescriptionKey({ entityTypes: ["menu"] })).toBe("Sends your menus to the live site.");
    expect(publishScopeDescriptionKey({ entityTypes: ["redirect"] })).toBe("Sends your redirects to the live site.");
    expect(publishScopeDescriptionKey({ entityTypes: ["theme-files", "active-theme"] })).toBe("Sends your themes to the live site.");
  });

  it("reads as one item for an entityKeys scope", () => {
    expect(publishScopeDescriptionKey({ entityTypes: ["page"], entityKeys: ["page:1"] })).toBe("Sends this item to the live site.");
  });
});
