/**
 * @file Task 11 of the publish-content (Publish Content) feature —
 * `ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 11.
 *
 * The report-table semantics the admin dialog renders. These live in `features/publish-content/ui/`
 * rather than in `apps/admin` because they restate the planner's own safety property — which rows a
 * run writes and which it skips — and a second copy in the admin package could drift from
 * `planner.ts` without anything going red.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PublishContentOutcomeRow, PublishContentReport } from "../contract.js";
import { entityKey } from "../../planner.js";
import { addressHeldByOther, addressHeldInTrash, trashedAtDestination } from "../../precheck-reasons.js";
import {
  countSelectedPublishing,
  friendlyPublishReason,
  publishRowDisposition,
  selectableRowKeys,
  summarizePublishReport,
  toPublishReportRows,
} from "../report-rows.js";

function row(over: Partial<PublishContentOutcomeRow> & { outcome: PublishContentOutcomeRow["outcome"] }): PublishContentOutcomeRow {
  return {
    entityType: "post",
    entityId: "post-1",
    writes: over.outcome === "created" || over.outcome === "applied" || over.outcome === "forced",
    reason: null,
    ...over,
  };
}

function report(rows: readonly PublishContentOutcomeRow[]): PublishContentReport {
  return { refused: false, refusalReason: null, applyOrder: ["media", "post"], rows };
}

test("a conflict row is skipped, never publishable", () => {
  assert.equal(publishRowDisposition(row({ outcome: "conflict", reason: "edited on the live site" })), "skipped");
});

test("a blocked row is skipped", () => {
  assert.equal(publishRowDisposition(row({ outcome: "blocked", reason: "slug taken by a different id" })), "skipped");
});

test("created and applied rows publish; unchanged rows are their own disposition", () => {
  assert.equal(publishRowDisposition(row({ outcome: "created" })), "publish");
  assert.equal(publishRowDisposition(row({ outcome: "applied" })), "publish");
  assert.equal(publishRowDisposition(row({ outcome: "unchanged" })), "unchanged");
  assert.equal(publishRowDisposition(row({ outcome: "forced" })), "publish");
});

test("every row carries a stable key, a disposition label and its planner reason", () => {
  const rows = toPublishReportRows(
    report([
      row({ outcome: "created", entityId: "post-a" }),
      row({ outcome: "conflict", entityType: "media", entityId: "media-b", reason: "edited on the live site" }),
    ])
  );

  assert.deepEqual(
    rows.map((r) => ({ key: r.key, disposition: r.disposition, label: r.dispositionLabel, reason: r.reason })),
    [
      { key: "post:post-a", disposition: "publish", label: "Will publish — new", reason: null },
      { key: "media:media-b", disposition: "skipped", label: "Skipped", reason: "edited on the live site" },
    ]
  );
});

test("a skipped row with no planner reason still reads as skipped rather than blank", () => {
  const [only] = toPublishReportRows(report([row({ outcome: "blocked", reason: null })]));
  assert.equal(only.reason, "No reason recorded.");
});

test("the summary counts what the run writes, and excludes conflicts", () => {
  const summary = summarizePublishReport(
    toPublishReportRows(
      report([
        row({ outcome: "created", entityId: "a" }),
        row({ outcome: "applied", entityId: "b" }),
        row({ outcome: "unchanged", entityId: "c" }),
        row({ outcome: "conflict", entityId: "d", reason: "edited on the live site" }),
        row({ outcome: "blocked", entityId: "e", reason: "slug taken" }),
      ])
    )
  );

  assert.deepEqual(summary, { total: 5, publishing: 2, unchanged: 1, skipped: 2 });
});

test("a refused report produces no rows at all", () => {
  const rows = toPublishReportRows({
    refused: true,
    refusalReason: "these two instances are on different content-hash versions",
    applyOrder: [],
    rows: [],
  });
  assert.deepEqual(rows, []);
});

// ---------------------------------------------------------------------------
// The entity column, and which rows may carry a checkbox (owner-directed, 2026-09-19)
// ---------------------------------------------------------------------------

test("a row renders its own human label rather than its id", () => {
  const [shaped] = toPublishReportRows(
    report([row({ outcome: "created", entityId: "d4bf2a26-2ed2-4143-b3ae-78404ca1b36b", entityLabel: "spring-sale" })])
  );

  assert.equal(shaped.entityLabel, "spring-sale");
  assert.equal(shaped.entityId, "d4bf2a26-2ed2-4143-b3ae-78404ca1b36b", "the id itself is still carried, just not what is displayed");
});

test("a row with no label falls back to a short id, never the whole uuid", () => {
  const uuid = "d4bf2a26-2ed2-4143-b3ae-78404ca1b36b";
  for (const missing of [null, undefined, "   "]) {
    const [shaped] = toPublishReportRows(report([row({ outcome: "created", entityId: uuid, entityLabel: missing })]));
    assert.equal(shaped.entityLabel, "d4bf2a26", `entityLabel ${JSON.stringify(missing)} must degrade to a short id`);
    assert.notEqual(shaped.entityLabel, uuid);
  }
});

test("the type column reads as a plain word, not the raw entity type id", () => {
  // publish-content-copy-2026-09-25.md — the dialog rendered `row.entityType` raw ("redirect",
  // "theme-files"), which the fixed-width type column then clipped to "redire…"; a short plain word
  // both fits the column and reads as English.
  const rows = toPublishReportRows(
    report([
      row({ outcome: "created", entityType: "post", entityId: "p1" }),
      row({ outcome: "created", entityType: "page", entityId: "pg1" }),
      row({ outcome: "created", entityType: "media", entityId: "m1" }),
      row({ outcome: "created", entityType: "menu", entityId: "menu1" }),
      row({ outcome: "created", entityType: "redirect", entityId: "exact:/old-promo" }),
      row({ outcome: "created", entityType: "theme-files", entityId: "official/basic" }),
      row({ outcome: "created", entityType: "some-future-type", entityId: "x" }),
    ])
  );
  assert.deepEqual(
    rows.map((r) => r.entityTypeLabel),
    ["Post", "Page", "Media", "Menu", "Redirect", "Theme", "some-future-type"]
  );
});

test("only a row the run would write is selectable", () => {
  const rows = toPublishReportRows(
    report([
      row({ outcome: "created", entityId: "a" }),
      row({ outcome: "applied", entityId: "b" }),
      row({ outcome: "forced", entityId: "c", reason: "operator accepted the conflict" }),
      row({ outcome: "unchanged", entityId: "d" }),
      row({ outcome: "conflict", entityId: "e", reason: "edited on the live site" }),
      row({ outcome: "blocked", entityId: "f", reason: "slug taken" }),
    ])
  );

  assert.deepEqual(
    rows.map((r) => [r.entityId, r.selectable]),
    [["a", true], ["b", true], ["c", true], ["d", false], ["e", false], ["f", false]]
  );
  assert.deepEqual(selectableRowKeys(rows), ["post:a", "post:b", "post:c"]);
});

test("selectable row keys are byte-identical to the planner's own entity keys", () => {
  const rows = toPublishReportRows(report([row({ outcome: "created", entityType: "media", entityId: "m-1" })]));
  assert.deepEqual(selectableRowKeys(rows), [entityKey("media", "m-1")]);
});

test("the button's count is the intersection of the selection and what is selectable", () => {
  const rows = toPublishReportRows(
    report([
      row({ outcome: "created", entityId: "a" }),
      row({ outcome: "applied", entityId: "b" }),
      row({ outcome: "conflict", entityId: "c", reason: "edited on the live site" }),
    ])
  );

  assert.equal(countSelectedPublishing(rows, new Set(["post:a", "post:b"])), 2);
  assert.equal(countSelectedPublishing(rows, new Set(["post:a"])), 1);
  assert.equal(countSelectedPublishing(rows, new Set()), 0);
  // A key naming a row that cannot be published, or no row at all, must never inflate the promise
  // the primary button makes out loud.
  assert.equal(countSelectedPublishing(rows, new Set(["post:c", "post:gone"])), 0);
});

// ---------------------------------------------------------------------------
// "Overwrite on live" (publish-overwrite-live-plan-2026-09-24.md §4/S9)
// ---------------------------------------------------------------------------

test("overwritable is true only for a skipped row whose planner canOverwrite is true", () => {
  const rows = toPublishReportRows(
    report([
      row({ outcome: "blocked", entityId: "a", canOverwrite: true, reason: "slug taken" }),
      row({ outcome: "conflict", entityId: "b", canOverwrite: true, reason: "edited on the live site" }),
      row({ outcome: "blocked", entityId: "c", canOverwrite: false, reason: "blob missing" }),
      // A `forced` row is already `publish`, not `skipped` — it never gets a SECOND control
      // offering to do the same overwrite again, whatever its own `canOverwrite` says.
      row({ outcome: "forced", entityId: "d", canOverwrite: true, reason: "operator accepted the conflict" }),
      row({ outcome: "created", entityId: "e" }),
      row({ outcome: "unchanged", entityId: "f" }),
    ])
  );

  assert.deepEqual(
    rows.map((r) => [r.entityId, r.overwritable]),
    [["a", true], ["b", true], ["c", false], ["d", false], ["e", false], ["f", false]]
  );
});

test("retiresLabel names the live row an overwrite would retire, falling back to a short id", () => {
  const [withLabel] = toPublishReportRows(
    report([
      row({
        outcome: "blocked",
        entityId: "a",
        canOverwrite: true,
        reason: "slug taken",
        retires: { entityType: "post", entityId: "post-about", entityLabel: "About", hash: "h1" },
      }),
    ])
  );
  assert.equal(withLabel.retiresLabel, "About");

  const [withoutLabel] = toPublishReportRows(
    report([
      row({
        outcome: "blocked",
        entityId: "b",
        canOverwrite: true,
        reason: "slug taken",
        retires: { entityType: "post", entityId: "d4bf2a26-2ed2-4143-b3ae-78404ca1b36b", entityLabel: null, hash: "h2" },
      }),
    ])
  );
  assert.equal(withoutLabel.retiresLabel, "d4bf2a26");

  const [none] = toPublishReportRows(report([row({ outcome: "created", entityId: "c" })]));
  assert.equal(none.retiresLabel, null);
});

// ---------------------------------------------------------------------------
// referencedByLabels (plan-publish-repoint-menus-2026-09-24.md §2.2/R6)
// ---------------------------------------------------------------------------

test("referencedByLabels names every live holder of this row's retire target, falling back to a short id", () => {
  const [withHolders] = toPublishReportRows(
    report([
      row({
        outcome: "blocked",
        entityId: "a",
        reason: "slug taken",
        referencedBy: [
          { entityType: "menu", entityId: "menu-header", entityLabel: "Header", referencedId: "post-about-old" },
          { entityType: "menu", entityId: "menu-footer-long-id", entityLabel: null, referencedId: "post-about-old" },
        ],
      }),
    ])
  );
  assert.deepEqual(withHolders.referencedByLabels, ["Header", "menu-foo"]);
});

test("referencedByLabels is empty for a row with no referencedBy at all", () => {
  const [none] = toPublishReportRows(report([row({ outcome: "created", entityId: "b" })]));
  assert.deepEqual(none.referencedByLabels, []);
});

// ---------------------------------------------------------------------------
// friendlyPublishReason (publish-content-copy-2026-09-25.md) — the planner's and its handlers' own
// jargon-heavy reason strings, rewritten for a non-technical owner.
// ---------------------------------------------------------------------------

test("friendlyPublishReason rewrites every reason planner.ts and its handlers can currently produce", () => {
  const cases: ReadonlyArray<[string, string]> = [
    [
      "no registered publish-content handler for entity type 'widget' on this instance",
      "This kind of content can't be published from here yet.",
    ],
    [
      "required blob 'abc123' is not available on this instance",
      "A file this item needs is missing on the live site, and couldn't be sent from here.",
    ],
    [
      "required blob 'abc123' is not available on this destination",
      "A file this item needs is missing on the live site, and couldn't be sent from here.",
    ],
    [
      "post 'p1' has been edited on the destination since the last sync with this peer",
      "Different version already on the live site. Tick Overwrite to replace it.",
    ],
    [
      "no prior sync baseline for media 'c0bf1802-f30a-4ac6-9de3-fa65e3667897' with this peer — the destination already holds different content",
      "Different version already on the live site. Tick Overwrite to replace it.",
    ],
    [
      "slug 'about' is already held by a different post ('post-2')",
      "Another item on the live site already uses this name.",
    ],
    [
      "'post-1' is in the trash at this destination — restore it before publishing over it, or publishing would resurrect it as live content",
      "This item is in the trash on the live site. Restore it there before publishing.",
    ],
    [
      "'p1' is a 'post' at this destination but a 'page' at the source — kind is fixed at creation and cannot be changed by publishing",
      "This item's type doesn't match the live site's version, so it can't be published over it.",
    ],
    [
      "post entity 'p1' has no usable slug to check for a collision",
      "This item has no name set, so it can't be checked against the live site.",
    ],
    [
      "media entity 'm1' cannot be prechecked — no mediaRepo wired for this deps bag",
      "Publishing isn't available for this item right now.",
    ],
    [
      "redirect entity 'r1' has a malformed natural key (expected 'matchType:fromPattern')",
      "This item's data is incomplete and can't be published.",
    ],
    [
      "Theme: static/basic was not published: 'basic' is not a valid theme tree address",
      "This theme's files aren't in a valid location.",
    ],
    [
      "Theme: static/basic was not published: this site has no themes folder",
      "This site doesn't have a themes folder set up.",
    ],
    [
      "live's themes folder spans two disks; nothing was written",
      "The site's themes folder isn't set up correctly.",
    ],
  ];

  for (const [raw, friendly] of cases) {
    assert.equal(friendlyPublishReason(raw), friendly, raw);
  }
});

// Verbatim from the handlers' own templates (the entity type/id prefix included), not a hand-trimmed
// variant: `post/publish-content.ts`'s trash precheck starts with "<type> '<id>'", and
// `navigation/publish-content.ts`'s slug precheck starts with "menu slug", so an anchored pattern
// written against a trimmed fixture passes its test and leaks the raw id in the real dialog.
test("friendlyPublishReason rewrites the post trash and menu slug reasons exactly as their handlers word them", () => {
  const cases: ReadonlyArray<[string, string]> = [
    [
      "page 'c0bf1802-f30a-4ac6-9de3-fa65e3667897' is in the trash at this destination — restore it before publishing over it, or publishing would resurrect it as live content",
      "This item is in the trash on the live site. Restore it there before publishing.",
    ],
    [
      "menu slug 'main' is already held by a different menu ('c0bf1802-f30a-4ac6-9de3-fa65e3667897') at this destination",
      "Another item on the live site already uses this name.",
    ],
  ];

  for (const [raw, friendly] of cases) {
    assert.equal(friendlyPublishReason(raw), friendly, raw);
  }
});

// The factory's (`repo-handler.ts`) hyphenated types and its non-slug addresses (taxonomy/term
// `name`), worded by `precheck-reasons.ts` — a `\w+` type prefix never matched them, leaking the id.
test("friendlyPublishReason rewrites the factory types' trash and address reasons", () => {
  const trash = "This item is in the trash on the live site. Restore it there before publishing.";
  const held = "Another item on the live site already uses this name.";
  const cases: ReadonlyArray<[string, string]> = [
    [trashedAtDestination("collection-entry", "e-1"), trash],
    [trashedAtDestination("content-type", "recipe"), trash],
    [addressHeldInTrash("widget", "slug", "about", "w-9"), trash],
    [addressHeldByOther("collection-entry", "slug", "soup", "e-2"), held],
    [addressHeldByOther("taxonomy", "name", "Category", "tx-2"), held],
  ];

  for (const [raw, friendly] of cases) {
    assert.equal(friendlyPublishReason(raw), friendly, raw);
  }
});

test("friendlyPublishReason leaves an already-final \"Can't publish:\" reason untouched", () => {
  assert.equal(
    friendlyPublishReason("Can't publish: contains a video file (deadpool3-cinedaily-hero.mp4)"),
    "Can't publish: contains a video file (deadpool3-cinedaily-hero.mp4)"
  );
  assert.equal(
    friendlyPublishReason("Can't publish: contains a file type that isn't allowed (notes.exe)"),
    "Can't publish: contains a file type that isn't allowed (notes.exe)"
  );
});

test("friendlyPublishReason falls back to a generic sentence for an unrecognized file-tree wrap", () => {
  assert.equal(
    friendlyPublishReason("Theme: static/basic was not published: \"x/../y\" contains a '..' segment, which is never allowed"),
    "Theme: static/basic can't be published — one of its files isn't allowed."
  );
});

test("friendlyPublishReason passes through text it does not recognize, unchanged", () => {
  assert.equal(friendlyPublishReason("some future handler's own wording"), "some future handler's own wording");
});

test("toPublishReportRows rewrites a skipped row's reason for a non-technical owner", () => {
  const [shaped] = toPublishReportRows(
    report([
      row({
        outcome: "conflict",
        entityType: "media",
        entityId: "c0bf1802-f30a-4ac6-9de3-fa65e3667897",
        reason:
          "no prior sync baseline for media 'c0bf1802-f30a-4ac6-9de3-fa65e3667897' with this peer — the destination already holds different content",
      }),
    ])
  );
  assert.equal(shaped.reason, "Different version already on the live site. Tick Overwrite to replace it.");
});

/**
 * Owner decision 2026-09-25 — media carried along with a scoped pages/posts run
 * (`report-labels.ts`'s `keepChangingIncludedMedia` sets `includedFor`). Pre-ticked and untickable:
 * never selectable, but counted as publishing whenever a page/post that uses it is still ticked.
 */
test("a carried-along media row is untickable and notes the pages that use it", () => {
  const [media] = toPublishReportRows(
    report([row({ outcome: "created", entityType: "media", entityId: "m1", includedFor: ["page:pg1", "page:pg2"] })])
  );
  assert.equal(media?.selectable, false);
  assert.equal(media?.disposition, "publish");
  assert.deepEqual(media?.includedFor, ["page:pg1", "page:pg2"]);
  assert.equal(media?.usedByNote, "Used by these pages");
});

test("the carried-along note names posts, or both, by the referrers' own types", () => {
  const rows = toPublishReportRows(
    report([
      row({ outcome: "created", entityType: "media", entityId: "m1", includedFor: ["post:p1"] }),
      row({ outcome: "applied", entityType: "media", entityId: "m2", includedFor: ["page:pg1", "post:p1"] }),
      row({ outcome: "created", entityType: "media", entityId: "m3" }),
    ])
  );
  assert.deepEqual(
    rows.map((r) => r.usedByNote),
    ["Used by these posts", "Used by these pages and posts", null]
  );
  assert.deepEqual(rows[2]?.includedFor, [], "an ordinary row carries no referrers");
  assert.equal(rows[2]?.selectable, true);
});

test("a carried-along row counts toward the button only while a page that uses it is ticked", () => {
  const rows = toPublishReportRows(
    report([
      row({ outcome: "created", entityType: "media", entityId: "m1", includedFor: ["page:pg1"] }),
      row({ outcome: "created", entityType: "page", entityId: "pg1" }),
      row({ outcome: "created", entityType: "page", entityId: "pg2" }),
    ])
  );
  assert.deepEqual(selectableRowKeys(rows), ["page:pg1", "page:pg2"], "the media row is never a selection key");
  assert.equal(countSelectedPublishing(rows, new Set(["page:pg1", "page:pg2"])), 3);
  assert.equal(countSelectedPublishing(rows, new Set(["page:pg2"])), 1);
});

/**
 * Owner decision 2026-09-25 — a theme blocked by the per-file size limit or by a secret-looking file
 * names the file, the way the video reason already does. Every raw wording below is quoted from
 * `file-tree-policy.ts` (`checkTreeFiles`/`checkTreePath`) wrapped by `wrapTreePolicyReason`. The
 * secret scan's own pattern name is never shown, and neither is any matched text.
 */
test("friendlyPublishReason names the file a theme's size limit refused", () => {
  assert.equal(
    friendlyPublishReason(
      "Theme: static/basic was not published: \"assets/img/hero.png\" is 99999999 bytes, larger than the 52428800-byte per-file limit"
    ),
    "Can't publish: a file is too large (hero.png)"
  );
});

test("friendlyPublishReason names the secret-looking file that refused a theme, never what matched", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["\"config/.env\" looks like an environment file", ".env"],
    ["\".env.local\" looks like an environment file", ".env.local"],
    ["\".npmrc\" is a package-manager credential file", ".npmrc"],
    ["\".mcp.prod.json\" is an MCP server configuration file, which can hold secrets", ".mcp.prod.json"],
    ["\"keys/id_rsa\" looks like a private SSH key", "id_rsa"],
    ["\"certs/site.pem\" has a '.pem' extension, which is never published", "site.pem"],
    ["\"assets/app.js\" looks like it holds a key (aws-access-key-id)", "app.js"],
  ];
  for (const [detail, name] of cases) {
    assert.equal(
      friendlyPublishReason(`Theme: static/basic was not published: ${detail}`),
      `Can't publish: a file looks like it contains a key or password (${name})`,
      detail
    );
  }
});
