import { describe, expect, it } from "vitest";

import { liveGapLinesFor, overwriteTooltipFor } from "../use-publish-content-confirm.hooks";

/**
 * @file `overwriteTooltipFor` — the pure helper `PublishContentDialog.tsx` now calls for the
 * overwrite checkbox's `title`, extracted out of that file's own nested ternary
 * (`plan-publish-repoint-menus-2026-09-24.md` §2.7/R6). `PublishContentDialog.unit.test.tsx`'s
 * "menu-link repoint copy (R6)" suite already covers the same copy end to end through the rendered
 * dialog; these tests pin the helper's own contract directly so a future regression here fails fast,
 * independent of the dialog's render tree.
 */

/** Bare-key stand-in translator, same convention every hooks/dialog test in this feature uses. */
const t = (key: string): string => key;

describe("overwriteTooltipFor", () => {
  it("returns undefined for a row with no retires target", () => {
    expect(overwriteTooltipFor({ retiresLabel: null, referencedByLabels: [] }, t)).toBeUndefined();
  });

  it("names the retired page alone when no live menu still references it", () => {
    expect(overwriteTooltipFor({ retiresLabel: "About", referencedByLabels: [] }, t)).toBe("About moves to Trash");
  });

  it("appends the referencing menus when at least one still links to the retired page", () => {
    expect(overwriteTooltipFor({ retiresLabel: "About", referencedByLabels: ["Header"] }, t)).toBe(
      "About moves to Trash. Menu links follow: Header"
    );
  });

  it("joins every referencing menu, not just the first", () => {
    expect(overwriteTooltipFor({ retiresLabel: "About", referencedByLabels: ["Header", "Footer"] }, t)).toBe(
      "About moves to Trash. Menu links follow: Header, Footer"
    );
  });
});

describe("liveGapLinesFor", () => {
  const t = (key: string): string => key;

  it("writes one plain line per held-back type, plural name and count", () => {
    expect(
      liveGapLinesFor(
        [
          { entityType: "form", count: 7 },
          { entityType: "collection-entry", count: 1 },
        ],
        t
      )
    ).toEqual([
      "Forms (7) can't publish yet: the live site needs an update first.",
      "Entries (1) can't publish yet: the live site needs an update first.",
    ]);
  });

  it("says nothing for an absent or empty list, or a zero count", () => {
    expect(liveGapLinesFor(undefined, t)).toEqual([]);
    expect(liveGapLinesFor([], t)).toEqual([]);
    expect(liveGapLinesFor([{ entityType: "form", count: 0 }], t)).toEqual([]);
  });

  it("falls back to the raw type id for a type no section names, and translates both parts", () => {
    const upper = (key: string): string => key.toUpperCase();
    expect(liveGapLinesFor([{ entityType: "something-new", count: 3 }], upper)).toEqual([
      "SOMETHING-NEW (3) CAN'T PUBLISH YET: THE LIVE SITE NEEDS AN UPDATE FIRST.",
    ]);
  });
});
