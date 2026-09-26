import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { JsonObject } from "@jini-ai/cms/core";
import type { PostRecord } from "#src/features/post/index";
import { loadTheme, type DiscoveredTheme } from "#src/features/theme/index";
import type { ResolveHtmlPageEmbedsResult, ResolvePageWidgetsResult } from "#src/features/widgets/resolver-service";
import type { WidgetRenderIR } from "#src/features/widgets/types";
import {
  injectExtraHeadIntoStaticPage,
  renderBlockSeam,
  renderDocNode,
  renderHtmlPageBody,
  renderSite,
  renderWidgetIr,
  decodeFormSubmissionResultFromQuery,
  encodeFormSubmissionResultQuery,
  injectFormSubmissionResultIntoHtml,
  decodeFormFlashCookieValue,
  encodeFormFlashCookieValue,
  mergeFormFlashIntoResult,
  type FormSubmissionRedirectResult,
  type FormFlashPayload,
  type SiteProduct,
  type SiteRenderContext,
} from "../render.js";

// A saturated machine, not a slow template, is what makes these fire. On 2026-08-19 a 7-agent run
// drove this 8-core box to load average 135 and the sandboxed renders below failed with
// "render exceeded 5000ms timeout" on templates that render in ~50ms idle; the same file passed
// 9/9 when run alone. Raising the PRODUCT default would weaken a real guard (a visitor must never
// wait 30s for a runaway theme) to fix a test-environment problem, so this raises it only here.
// The sandbox's own termination tests pin explicit budgets (500ms) and are unaffected by this.
process.env.TOVU_THEME_RENDER_TIMEOUT_MS ??= "60000";

function textDoc(...content: JsonObject[]): JsonObject {
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

test("renderDocNode: bold/italic/code marks still render (regression)", () => {
  const html = renderDocNode(
    textDoc(
      { type: "text", text: "b", marks: [{ type: "bold" }] },
      { type: "text", text: "i", marks: [{ type: "italic" }] },
      { type: "text", text: "c", marks: [{ type: "code" }] }
    )
  );
  assert.equal(html, "<p><strong>b</strong><em>i</em><code>c</code></p>");
});

test("renderDocNode: underline and strike marks render (Posts toolbar, 2026-08-11 — underline was silently dropped before this fix, strike had never rendered)", () => {
  const html = renderDocNode(
    textDoc(
      { type: "text", text: "u", marks: [{ type: "underline" }] },
      { type: "text", text: "s", marks: [{ type: "strike" }] }
    )
  );
  assert.equal(html, "<p><u>u</u><s>s</s></p>");
});

test("underline/strike compose with bold and with each other — the mark loop wraps progressively, so nesting order must match the marks array", () => {
  const html = renderDocNode(
    textDoc(
      { type: "text", text: "bu", marks: [{ type: "bold" }, { type: "underline" }] },
      { type: "text", text: "us", marks: [{ type: "underline" }, { type: "strike" }] }
    )
  );
  assert.equal(html, "<p><u><strong>bu</strong></u><s><u>us</u></s></p>");
});

test("C7: a link mark renders an anchor with its href", () => {
  const html = renderDocNode(
    textDoc({ type: "text", text: "plugins", marks: [{ type: "link", attrs: { href: "/how-plugins-work" } }] })
  );
  assert.equal(html, '<p><a href="/how-plugins-work">plugins</a></p>');
});

test("C7: relative, http(s) and mailto hrefs are allowed; text is escaped", () => {
  for (const href of ["/about", "#top", "https://tovu.dev", "http://x.io", "mailto:a@b.co"]) {
    const html = renderDocNode(
      textDoc({ type: "text", text: "<x>", marks: [{ type: "link", attrs: { href } }] })
    );
    assert.equal(html, `<p><a href="${href}">&lt;x&gt;</a></p>`);
  }
});

test("C7: javascript:, data: and non-string hrefs collapse to '#' (no script smuggling)", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,<script>", "  javascript:alert(1)", 42, null, undefined]) {
    const html = renderDocNode(
      textDoc({ type: "text", text: "x", marks: [{ type: "link", attrs: { href } as never }] })
    );
    assert.equal(html, '<p><a href="#">x</a></p>');
  }
});

test("C7: protocol-relative and same-origin-lookalike hrefs collapse to '#' (open-redirect fix, 2026-08-20 — 'safeHref accepts protocol-relative URLs' audit finding)", () => {
  // Every one of these starts with a single leading "/" (the same check the OLD safeHref used to
  // decide "same-origin relative, allow unchanged") but resolves off-origin once a real browser (or
  // the WHATWG URL parser) gets to it. `renderDocNode(textDoc(...))` drives the exact same
  // `renderLinkMark` -> `safeHref` path the C7 tests above already use for ordinary post content.
  const hostile = [
    "//evil.example", // bare protocol-relative — inherits the page's own scheme
    "//evil.example/phish", // same, with a path
    "/\\evil.example", // backslash right after the leading slash — a browser folds \ to / for http(s)
    " //evil.example", // leading whitespace in front of the protocol-relative form
    "/\t/evil.example", // a TAB planted between the leading "/" and the rest: the WHATWG URL parser
    // strips tab/newline/CR from ANYWHERE in the string before parsing, so this
    // reconstitutes "//evil.example" the same way a browser would see it
  ];
  for (const href of hostile) {
    const html = renderDocNode(
      textDoc({ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] })
    );
    assert.equal(html, '<p><a href="#">x</a></p>', `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`);
  }
});

test("C7: link composes with an emphasis mark on the same text", () => {
  const html = renderDocNode(
    textDoc({ type: "text", text: "here", marks: [{ type: "bold" }, { type: "link", attrs: { href: "/x" } }] })
  );
  assert.equal(html, '<p><a href="/x"><strong>here</strong></a></p>');
});

test("renderDocNode: a textStyle mark with a color attr renders an inline color style", () => {
  const html = renderDocNode(textDoc({ type: "text", text: "hi", marks: [{ type: "textStyle", attrs: { color: "#ff0000" } }] }));
  assert.equal(html, '<p><span style="color:#ff0000">hi</span></p>');
});

test("a textStyle mark with a backgroundColor attr renders an inline background-color style", () => {
  const html = renderDocNode(textDoc({ type: "text", text: "hi", marks: [{ type: "textStyle", attrs: { backgroundColor: "#00ff00" } }] }));
  assert.equal(html, '<p><span style="background-color:#00ff00">hi</span></p>');
});

test("a textStyle mark with both color and backgroundColor combines into one style attribute on one span", () => {
  const html = renderDocNode(
    textDoc({ type: "text", text: "hi", marks: [{ type: "textStyle", attrs: { color: "#ff0000", backgroundColor: "#00ff00" } }] })
  );
  assert.equal(html, '<p><span style="color:#ff0000;background-color:#00ff00">hi</span></p>');
});

test("a textStyle mark with no recognized attrs (or attrs that all fail the color allowlist) renders no <span> at all", () => {
  assert.equal(renderDocNode(textDoc({ type: "text", text: "hi", marks: [{ type: "textStyle" }] })), "<p>hi</p>");
  assert.equal(
    renderDocNode(textDoc({ type: "text", text: "hi", marks: [{ type: "textStyle", attrs: { color: "red; } body { display:none" } }] })),
    "<p>hi</p>"
  );
});

test("an unsafe backgroundColor is dropped independently — a valid color attr alongside it still renders", () => {
  const html = renderDocNode(
    textDoc({
      type: "text",
      text: "hi",
      marks: [{ type: "textStyle", attrs: { color: "#ff0000", backgroundColor: "url(javascript:alert(1))" } }],
    })
  );
  assert.equal(html, '<p><span style="color:#ff0000">hi</span></p>');
});

test("a textStyle mark with fontFamily/fontSize/lineHeight attrs combines all three into one style attribute", () => {
  const html = renderDocNode(
    textDoc({
      type: "text",
      text: "hi",
      marks: [{ type: "textStyle", attrs: { fontFamily: "Georgia, serif", fontSize: "18px", lineHeight: "1.5" } }],
    })
  );
  assert.equal(html, '<p><span style="font-family:Georgia, serif;font-size:18px;line-height:1.5">hi</span></p>');
});

test("fontFamily/fontSize/lineHeight compose with color/backgroundColor in the documented order", () => {
  const html = renderDocNode(
    textDoc({
      type: "text",
      text: "hi",
      marks: [{ type: "textStyle", attrs: { color: "#111", backgroundColor: "#eee", fontFamily: "Arial, sans-serif", fontSize: "24px", lineHeight: "2" } }],
    })
  );
  assert.equal(html, '<p><span style="color:#111;background-color:#eee;font-family:Arial, sans-serif;font-size:24px;line-height:2">hi</span></p>');
});

test("an unsafe fontFamily/fontSize/lineHeight is dropped independently, same as an unsafe color", () => {
  const html = renderDocNode(
    textDoc({
      type: "text",
      text: "hi",
      marks: [
        {
          type: "textStyle",
          attrs: {
            color: "#111",
            fontFamily: "Arial; } body { display:none",
            fontSize: "18px; background:url(evil)",
            lineHeight: "expression(alert(1))",
          },
        },
      ],
    })
  );
  assert.equal(html, '<p><span style="color:#111">hi</span></p>');
});

test("renderDocNode: subscript and superscript marks render (Posts toolbar, 2026-08-11)", () => {
  const html = renderDocNode(
    textDoc(
      { type: "text", text: "2", marks: [{ type: "subscript" }] },
      { type: "text", text: "2", marks: [{ type: "superscript" }] }
    )
  );
  assert.equal(html, "<p><sub>2</sub><sup>2</sup></p>");
});

test("renderDocNode: a youtube node with a watch-URL src builds a canonical nocookie embed iframe", () => {
  const html = renderDocNode({ type: "doc", content: [{ type: "youtube", attrs: { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }] });
  assert.equal(
    html,
    '<div class="youtube-embed"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>'
  );
});

test("a youtube node's src is recognized from every URL shape the extension itself produces (youtu.be, already-embed, shorts)", () => {
  for (const [src, expectedId] of [
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ] as const) {
    const html = renderDocNode({ type: "doc", content: [{ type: "youtube", attrs: { src } }] });
    assert.match(html, new RegExp(`src="https://www\\.youtube-nocookie\\.com/embed/${expectedId}"`));
  }
});

test("a youtube node's start attr (bounded, positive integer) appends ?start=N; zero/invalid omit it", () => {
  const withStart = renderDocNode({ type: "doc", content: [{ type: "youtube", attrs: { src: "https://youtu.be/dQw4w9WgXcQ", start: 90 } }] });
  assert.match(withStart, /embed\/dQw4w9WgXcQ\?start=90"/);
  const zeroStart = renderDocNode({ type: "doc", content: [{ type: "youtube", attrs: { src: "https://youtu.be/dQw4w9WgXcQ", start: 0 } }] });
  assert.doesNotMatch(zeroStart, /\?start=/);
  const negativeStart = renderDocNode({ type: "doc", content: [{ type: "youtube", attrs: { src: "https://youtu.be/dQw4w9WgXcQ", start: -5 } }] });
  assert.doesNotMatch(negativeStart, /\?start=/);
});

test("a youtube node with an unrecognized/unsafe src degrades to the media placeholder, never an <iframe>", () => {
  for (const src of ["javascript:alert(1)", "https://evil.example.com/embed/x", "not a url at all", 42, null, undefined]) {
    const html = renderDocNode({ type: "doc", content: [{ type: "youtube", attrs: { src } as never }] });
    assert.doesNotMatch(html, /<iframe/);
    assert.match(html, /media-ph/);
  }
});

test("renderDocNode: a codeBlock with a language attr emits a language-X class on <code>", () => {
  const html = renderDocNode({
    type: "doc",
    content: [{ type: "codeBlock", attrs: { language: "typescript" }, content: [{ type: "text", text: "const x = 1;" }] }],
  });
  assert.equal(html, '<pre><code class="language-typescript">const x = 1;</code></pre>');
});

test("a codeBlock with no language attr renders the plain bare <code> from before this feature existed", () => {
  const html = renderDocNode({ type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "x" }] }] });
  assert.equal(html, "<pre><code>x</code></pre>");
});

test("a codeBlock with an unsafe language value (quote/space/angle-bracket) drops the class rather than emitting a malformed attribute", () => {
  for (const language of ['ts"><script>alert(1)</script>', "type script", "a<b", 42, null]) {
    const html = renderDocNode({
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language } as never, content: [{ type: "text", text: "x" }] }],
    });
    assert.equal(html, "<pre><code>x</code></pre>");
  }
});

test("renderDocNode: a task list renders checkbox/label structure, unchecked and checked", () => {
  const html = renderDocNode({
    type: "doc",
    content: [
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Buy milk" }] }] },
          { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Walk dog" }] }] },
        ],
      },
    ],
  });
  assert.equal(
    html,
    '<ul data-type="taskList">' +
      '<li data-type="taskItem"><label><input type="checkbox" disabled/><span></span></label><div><p>Buy milk</p></div></li>' +
      '<li data-type="taskItem"><label><input type="checkbox" checked disabled/><span></span></label><div><p>Walk dog</p></div></li>' +
      "</ul>"
  );
});

test("a taskItem with a non-boolean/missing checked attr renders unchecked (defaults safe)", () => {
  const html = renderDocNode({
    type: "doc",
    content: [{ type: "taskList", content: [{ type: "taskItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }] }],
  });
  assert.equal(
    html,
    '<ul data-type="taskList"><li data-type="taskItem"><label><input type="checkbox" disabled/><span></span></label><div><p>x</p></div></li></ul>'
  );
});

test("renderDocNode: a table renders table/tr/td structure", () => {
  const html = renderDocNode({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
              { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Age" }] }] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Ada" }] }] },
              { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "36" }] }] },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(
    html,
    "<table><tr><th><p>Name</p></th><th><p>Age</p></th></tr><tr><td><p>Ada</p></td><td><p>36</p></td></tr></table>"
  );
});

test("a table cell's colspan/rowspan render only when not the HTML default of 1, bounds-checked", () => {
  const cell = (attrs: Record<string, unknown>) => ({
    type: "tableCell",
    attrs,
    content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
  });
  assert.equal(renderDocNode({ type: "doc", content: [cell({ colspan: 1, rowspan: 1 })] }), "<td><p>x</p></td>");
  assert.equal(renderDocNode({ type: "doc", content: [cell({ colspan: 2, rowspan: 3 })] }), '<td colspan="2" rowspan="3"><p>x</p></td>');
  // Out-of-bounds / non-numeric values collapse to the default rather than an unbounded attribute.
  assert.equal(renderDocNode({ type: "doc", content: [cell({ colspan: 999999 })] }), "<td><p>x</p></td>");
  assert.equal(renderDocNode({ type: "doc", content: [cell({ colspan: "3" as never })] }), "<td><p>x</p></td>");
});

test("a table cell's align attr only accepts left/center/right — never justify, never an unsafe value", () => {
  const cell = (align: unknown) => ({
    type: "tableCell",
    attrs: { align },
    content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
  });
  assert.equal(renderDocNode({ type: "doc", content: [cell("center")] }), '<td style="text-align:center"><p>x</p></td>');
  assert.equal(renderDocNode({ type: "doc", content: [cell("justify")] }), "<td><p>x</p></td>");
  assert.equal(renderDocNode({ type: "doc", content: [cell("left; } body { display:none")] }), "<td><p>x</p></td>");
});

test("renderDocNode: hardBreak renders <br/> (Shift-Enter, 2026-08-11) — before this case existed, an unrecognized hardBreak fell through to `default`'s `renderNodes(content, ...)`, and since a leaf node's `content` is always undefined, that resolved to \"\": the line break silently vanished on the public site with no error", () => {
  const html = renderDocNode(
    textDoc({ type: "text", text: "line one" }, { type: "hardBreak" }, { type: "text", text: "line two" })
  );
  assert.equal(html, "<p>line one<br/>line two</p>");
});

test("renderDocNode: a highlight mark with no color attr renders a bare <mark> (the admin toolbar's plain toggle button)", () => {
  const html = renderDocNode(textDoc({ type: "text", text: "hi", marks: [{ type: "highlight" }] }));
  assert.equal(html, "<p><mark>hi</mark></p>");
});

test("a highlight mark with an allowlisted color attr renders an inline background-color style", () => {
  for (const color of ["#f0a", "#ff00aa", "red", "rgb(255, 0, 170)", "oklch(88.5% 0.062 18.334)"]) {
    const html = renderDocNode(textDoc({ type: "text", text: "hi", marks: [{ type: "highlight", attrs: { color } }] }));
    assert.equal(html, `<p><mark style="background-color:${color}">hi</mark></p>`);
  }
});

test("a highlight mark with an unsafe/malformed color attr degrades to a bare <mark> (no CSS injection)", () => {
  for (const color of ["red; } body { display:none", "url(javascript:alert(1))", "expression(alert(1))", "red;color:blue", 42, null]) {
    const html = renderDocNode(textDoc({ type: "text", text: "hi", marks: [{ type: "highlight", attrs: { color } as never }] }));
    assert.equal(html, "<p><mark>hi</mark></p>");
  }
});

test("hardBreak composes with surrounding marked text and can appear more than once", () => {
  const html = renderDocNode(
    textDoc(
      { type: "text", text: "bold", marks: [{ type: "bold" }] },
      { type: "hardBreak" },
      { type: "hardBreak" },
      { type: "text", text: "plain" }
    )
  );
  assert.equal(html, "<p><strong>bold</strong><br/><br/>plain</p>");
});

// ---------------------------------------------------------------------------
// ADR-020 §3 (C6) — end-to-end `renderSite` through the real `themes/dispatch`
// Tier-2 demonstrator, exercising the full path: `loadTheme`'s lint,
// `renderLiquidInSandbox`'s worker isolation, the `render_block` seam into
// the component registry, and `{{ content | raw }}`.
// ---------------------------------------------------------------------------

function fakePost(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    workspaceId: "workspace-1",
    title: "<Hello> & Welcome",
    slug: "welcome",
    bodyJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi there." }] }] },
    status: "published",
    updatedAt: "2026-07-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

test("renderSite renders the live themes/dispatch home page: header/footer components, entry grid, escaped titles, no leftover Liquid tags", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid", `expected dispatch to load valid, got errors: ${JSON.stringify(theme.errors)}`);

  const posts = [fakePost(), fakePost({ id: "2", slug: "second", title: "Second Post", updatedAt: "2026-06-01T00:00:00.000Z" })];
  const html = await renderSite({ theme, route: "home", siteTitle: "Dispatch Demo", posts });

  assert.match(html, /site-header/);
  assert.match(html, /site-footer/);
  assert.match(html, /Dispatch Demo/);
  // Both entries render, in a loop authored in Liquid (not a fixed component).
  assert.match(html, /&lt;Hello&gt; &amp; Welcome/);
  assert.match(html, /Second Post/);
  // No unrendered Liquid syntax leaked into the output.
  assert.doesNotMatch(html, /\{\{|\{%/);
});

test("renderSite renders the live themes/dispatch entry (post) page: content injected raw, title escaped in the shell", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");

  const post = fakePost();
  const html = await renderSite({ theme, route: "post", siteTitle: "Dispatch Demo", posts: [post], post });

  // `{{ post.content | raw }}` — the pre-sanitized TipTap body renders as real HTML, not escaped text.
  assert.match(html, /<p>Hi there\.<\/p>/);
  // The post title inside the Liquid body is autoescaped (no explicit `raw`).
  assert.match(html, /&lt;Hello&gt; &amp; Welcome/);
  // The outer page shell's <title> is also escaped.
  assert.match(html, /<title>&lt;Hello&gt; &amp; Welcome — Dispatch Demo<\/title>/);
  assert.doesNotMatch(html, /\{\{|\{%/);
});

test("renderSite: the ADR-054 visitor-chat mount node + script are absent by default, and every pre-existing caller (no siteAssistantEnabled param) keeps getting no widget", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");

  const html = await renderSite({ theme, route: "home", siteTitle: "Dispatch Demo", posts: [] });
  assert.doesNotMatch(html, /tovu-site-assistant-root/);
  assert.doesNotMatch(html, /site-assistant\.js/);
  assert.doesNotMatch(html, /site-assistant\.css/);
});

test("renderSite: siteAssistantEnabled:false is the same as omitting it — no mount node, no script, no stylesheet", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");

  const html = await renderSite({ theme, route: "home", siteTitle: "Dispatch Demo", posts: [], siteAssistantEnabled: false });
  assert.doesNotMatch(html, /tovu-site-assistant-root/);
  assert.doesNotMatch(html, /site-assistant\.js/);
  assert.doesNotMatch(html, /site-assistant\.css/);
});

test("renderSite: siteAssistantEnabled:true injects the stylesheet link, mount node, and deferred script, once each, in the page shell (not a theme template)", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");

  const html = await renderSite({ theme, route: "home", siteTitle: "Dispatch Demo", posts: [], siteAssistantEnabled: true });
  assert.match(html, /<link rel="stylesheet" href="\/site-chat\/site-assistant\.css"\/>/);
  assert.match(html, /<div id="tovu-site-assistant-root"><\/div>/);
  assert.match(html, /<script defer src="\/site-chat\/site-assistant\.js"><\/script>/);
  // Exactly once each: this is the shell every route funnels through, not per-theme injection.
  assert.equal(html.match(/tovu-site-assistant-root/g)?.length, 1);
  assert.equal((html.match(/site-assistant\.css/g) ?? []).length, 1);
  // The stylesheet link lives in <head> (never render-blocked behind the deferred script), and the
  // deferred script comes after the themed page body — never a blocking script ahead of paintable
  // content.
  const headCloseIndex = html.indexOf("</head>");
  const cssLinkIndex = html.indexOf("site-assistant.css");
  const bodyIndex = html.indexOf('class="site"');
  const scriptIndex = html.indexOf("site-assistant.js");
  assert.ok(cssLinkIndex < headCloseIndex, "the stylesheet link must be in <head>");
  assert.ok(bodyIndex < scriptIndex, "the script tag must come after the themed page body");
});

test("renderSite: siteAssistantEnabled:true injects the widget on a static-tier home page too — regression for the ADR-054 gap where `renderStaticTierHomePage` bypasses `pageShell` (and its siteAssistantMarkup splice) entirely, so the widget silently never appeared for any static theme's home route no matter the setting", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "content", "themes", "static", "tovu-theme"), id: "tovu-theme", source: "built-in" });
  assert.equal(theme.status, "valid");
  assert.equal(theme.manifest.tier, "static");

  const html = await renderSite({ theme, route: "home", siteTitle: "Basic Demo", posts: [], siteAssistantEnabled: true });
  assert.match(html, /<div id="tovu-site-assistant-root"><\/div>/);
  assert.match(html, /<script defer src="\/site-chat\/site-assistant\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/site-chat\/site-assistant\.css"\/>/);
});

test("renderSite: siteAssistantEnabled:false (or omitted) shows no widget on a static-tier home page — same fail-closed default as every other tier", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "content", "themes", "static", "tovu-theme"), id: "tovu-theme", source: "built-in" });
  assert.equal(theme.status, "valid");

  const html = await renderSite({ theme, route: "home", siteTitle: "Basic Demo", posts: [] });
  assert.doesNotMatch(html, /tovu-site-assistant-root/);
  assert.doesNotMatch(html, /site-assistant\.js/);
  assert.doesNotMatch(html, /site-assistant\.css/);
});

test("renderSite falls back to the minimal built-in body (never 500s) when a templated theme's source is hostile at render time", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");
  // Simulate a template hot-edited on disk to smuggle a disallowed tag after
  // `loadTheme` already validated it — the worker's defensive re-lint must
  // still catch it, and `renderSite` must degrade instead of throwing.
  theme.liquidTemplates.home = '{% include "leak" %}';

  const html = await renderSite({ theme, route: "home", siteTitle: "Dispatch Demo", posts: [] });
  assert.match(html, /theme render error/);
  // The error message is HTML-escaped (it's injected into an HTML comment).
  assert.match(html, /disallowed tag &quot;include&quot;/);
  // The fallback body still renders (never a 500/empty response).
  assert.match(html, /site-header/);
  assert.match(html, /site-footer/);
});

// ---------------------------------------------------------------------------
// SPEC-043/ADR-047 W-004 — widget region + inline embed rendering
// ---------------------------------------------------------------------------

function declarativeTheme(home: JsonObject): DiscoveredTheme {
  return {
    manifest: { id: "t", name: "T", version: "1.0.0", tier: "declarative", engine: 1, regions: ["footer"] },
    tokens: {},
    templates: { home, entry: { type: "doc", content: [] } },
    liquidTemplates: {},
    handlebarsTemplates: {},
    dir: "/nonexistent/test-theme",
    css: "",
    source: "site",
    status: "valid",
    errors: [],
  };
}

function widgetsResult(overrides: Partial<ResolvePageWidgetsResult> = {}): ResolvePageWidgetsResult {
  return { regions: {}, inlineResolved: new Map(), ...overrides };
}

test("renderSite (declarative tier): a {type:'region',key:'footer'} template node renders every resolved widget in that region, wrapped in a widget-region container", async () => {
  const theme = declarativeTheme({
    type: "doc",
    content: [{ type: "region", key: "footer" }],
  });
  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({
      regions: { footer: [{ componentId: "text", props: { body: "Hello from the footer" } }] },
    }),
  });
  assert.match(html, /<div class="widget-region widget-region--footer">/);
  assert.match(html, /Hello from the footer/);
});

test("renderSite (declarative tier): a region with no resolved widgets (or no widgets param at all) renders nothing for that region — not an error state", async () => {
  const theme = declarativeTheme({ type: "doc", content: [{ type: "region", key: "footer" }] });

  const noWidgetsParam = await renderSite({ theme, route: "home", siteTitle: "Widgets Demo", posts: [] });
  assert.doesNotMatch(noWidgetsParam, /widget-region/);

  const emptyRegion = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({ regions: { footer: [] } }),
  });
  assert.doesNotMatch(emptyRegion, /widget-region/);
});

test("renderSite (Liquid tier): {% render_block region: \"footer\" %} resolves the same widget list over the same render_block seam, no new Liquid capability needed (ADR-047 §2a)", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");
  theme.liquidTemplates.home = '<div id="footer-region">{% render_block region: "footer" %}</div>';

  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({
      regions: { footer: [{ componentId: "social-links", props: { links: [{ platform: "GitHub", url: "https://github.com/tovu" }] } }] },
    }),
  });
  assert.match(html, /<div id="footer-region">/);
  assert.match(html, /widget-social-links/);
  assert.match(html, /GitHub/);
  assert.match(html, /https:\/\/github\.com\/tovu/);
});

test("renderSite (Liquid tier): a menu widget's authored cssClass/rel/openInNewTab reach the page end-to-end through render_block region -> renderBlockSeam -> renderWidgetRegion -> renderWidgetIr — the exact chain a static-tier-only fix would have left silently broken on this tier (COMPONENTS has no 'menu' entry of its own; declarative/Liquid/Handlebars all resolve a menu widget through this one shared function)", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");
  theme.liquidTemplates.home = '<div id="footer-region">{% render_block region: "footer" %}</div>';

  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({
      regions: {
        footer: [
          {
            componentId: "menu",
            props: {
              title: "Footer",
              items: [
                {
                  label: "Docs",
                  href: "/docs",
                  available: true,
                  attrs: { cssClass: "is-featured", rel: "nofollow", openInNewTab: true },
                  children: [],
                },
              ],
            },
          },
        ],
      },
    }),
  });
  assert.match(html, /<li class="is-featured">/);
  assert.match(html, /<a href="\/docs" rel="nofollow" target="_blank">/);
});

// ---------------------------------------------------------------------------
// Stored XSS fix (2026-09-03): `actionsHtml` (hero/cta buttons), `announcement`, `siteNav`, and
// `siteFooterRich` used to build `<a href>` from operator-authored widget props via
// `escapeHtml(str(o.href, "#"))` alone — NO `safeHref` call — so `href: "javascript:alert(1)"`
// rendered verbatim into public HTML: any workspace member who can author a widget prop ran script
// in every visitor's browser. `static-render.ts`'s own `safeHref` doc flagged this exact gap as a
// "KNOWN GAP, not fixed here" for its sibling static-tier menu renderer before this fix closed it.
// These mirror the C7 tests above (`renderLinkMark` -> `safeHref`) but drive the real declarative-
// tier composition end-to-end (`renderSite` -> `renderComponentBlock` -> the named `COMPONENTS`
// entry) instead of calling an internal function directly, and cover each of the seven fixed call
// sites independently since they can regress independently.
// ---------------------------------------------------------------------------

const XSS_HOSTILE_HREFS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)", // mixed case — a naive `startsWith("javascript:")` check would miss this
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "//evil.example", // protocol-relative — inherits the page's own scheme
  "/\\evil.example", // backslash right after the leading "/" — a browser folds \ to / for http(s)
];

const XSS_LEGIT_HREFS = ["/about", "https://example.com", "mailto:x@y.com", "#anchor"];

test("widget/declarative: hero actions button href (actionsHtml) — hostile schemes collapse to '#'", async () => {
  for (const href of XSS_HOSTILE_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/hero", props: { title: "T", actions: [{ href, label: "Go" }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes('<a class="btn btn--primary" href="#">Go</a>'),
      `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`
    );
  }
});

test("widget/declarative: hero actions button href — legitimate hrefs pass through unchanged", async () => {
  for (const href of XSS_LEGIT_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/hero", props: { title: "T", actions: [{ href, label: "Go" }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes(`<a class="btn btn--primary" href="${href}">Go</a>`),
      `expected legit href ${JSON.stringify(href)} to pass through, got: ${html}`
    );
  }
});

test("widget/declarative: cta band actions button href (actionsHtml, second call site) — hostile schemes collapse to '#'", async () => {
  for (const href of XSS_HOSTILE_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/cta", props: { title: "T", actions: [{ href, label: "Go" }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes('<a class="btn btn--primary" href="#">Go</a>'),
      `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`
    );
  }
});

test("widget/declarative: cta band actions button href — legitimate hrefs pass through unchanged", async () => {
  for (const href of XSS_LEGIT_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/cta", props: { title: "T", actions: [{ href, label: "Go" }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes(`<a class="btn btn--primary" href="${href}">Go</a>`),
      `expected legit href ${JSON.stringify(href)} to pass through, got: ${html}`
    );
  }
});

test("widget/declarative: announcement link href — hostile schemes collapse to '#'", async () => {
  for (const href of XSS_HOSTILE_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/announcement", props: { text: "Announcement", link: { href, label: "Go" } } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes('<a class="topbar__link" href="#">Go →</a>'),
      `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`
    );
  }
});

test("widget/declarative: announcement link href — legitimate hrefs pass through unchanged", async () => {
  for (const href of XSS_LEGIT_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/announcement", props: { text: "Announcement", link: { href, label: "Go" } } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes(`<a class="topbar__link" href="${href}">Go →</a>`),
      `expected legit href ${JSON.stringify(href)} to pass through, got: ${html}`
    );
  }
});

test("widget/declarative: siteNav top-level item href — hostile schemes collapse to '#'", async () => {
  for (const href of XSS_HOSTILE_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/nav", props: { items: [{ label: "Item", href }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes('<li class="nav-item"><a class="nav-link" href="#">Item</a></li>'),
      `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`
    );
  }
});

test("widget/declarative: siteNav top-level item href — legitimate hrefs pass through unchanged", async () => {
  for (const href of XSS_LEGIT_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/nav", props: { items: [{ label: "Item", href }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes(`<li class="nav-item"><a class="nav-link" href="${href}">Item</a></li>`),
      `expected legit href ${JSON.stringify(href)} to pass through, got: ${html}`
    );
  }
});

test("widget/declarative: siteNav nested child item href — hostile schemes collapse to '#' (independent of the parent item's own href)", async () => {
  for (const href of XSS_HOSTILE_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [
        {
          type: "component",
          id: "tovu/nav",
          props: { items: [{ label: "Parent", href: "/parent", children: [{ label: "Child", href }] }] },
        },
      ],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes('<li><a href="#">Child</a></li>'),
      `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`
    );
  }
});

test("widget/declarative: siteNav nested child item href — legitimate hrefs pass through unchanged", async () => {
  for (const href of XSS_LEGIT_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [
        {
          type: "component",
          id: "tovu/nav",
          props: { items: [{ label: "Parent", href: "/parent", children: [{ label: "Child", href }] }] },
        },
      ],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes(`<li><a href="${href}">Child</a></li>`),
      `expected legit href ${JSON.stringify(href)} to pass through, got: ${html}`
    );
  }
});

test("widget/declarative: siteNav CTA button href — hostile schemes collapse to '#'", async () => {
  for (const href of XSS_HOSTILE_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/nav", props: { items: [], cta: { href, label: "Go" } } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes('<a class="btn btn--primary nav-cta" href="#">Go</a>'),
      `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`
    );
  }
});

test("widget/declarative: siteNav CTA button href — legitimate hrefs pass through unchanged", async () => {
  for (const href of XSS_LEGIT_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/nav", props: { items: [], cta: { href, label: "Go" } } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes(`<a class="btn btn--primary nav-cta" href="${href}">Go</a>`),
      `expected legit href ${JSON.stringify(href)} to pass through, got: ${html}`
    );
  }
});

test("widget/declarative: siteFooterRich social link href — hostile schemes collapse to '#'", async () => {
  for (const href of XSS_HOSTILE_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/footer", props: { social: [{ href, label: "GH" }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes('<a class="footer__social" href="#">GH</a>'),
      `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`
    );
  }
});

test("widget/declarative: siteFooterRich social link href — legitimate hrefs pass through unchanged", async () => {
  for (const href of XSS_LEGIT_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/footer", props: { social: [{ href, label: "GH" }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes(`<a class="footer__social" href="${href}">GH</a>`),
      `expected legit href ${JSON.stringify(href)} to pass through, got: ${html}`
    );
  }
});

test("widget/declarative: siteFooterRich column link href — hostile schemes collapse to '#'", async () => {
  for (const href of XSS_HOSTILE_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/footer", props: { columns: [{ title: "Col", links: [{ href, label: "Link" }] }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes('<li><a href="#">Link</a></li>'),
      `expected ${JSON.stringify(href)} to collapse to "#", got: ${html}`
    );
  }
});

test("widget/declarative: siteFooterRich column link href — legitimate hrefs pass through unchanged", async () => {
  for (const href of XSS_LEGIT_HREFS) {
    const theme = declarativeTheme({
      type: "doc",
      content: [{ type: "component", id: "tovu/footer", props: { columns: [{ title: "Col", links: [{ href, label: "Link" }] }] } }],
    });
    const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
    assert.ok(
      html.includes(`<li><a href="${href}">Link</a></li>`),
      `expected legit href ${JSON.stringify(href)} to pass through, got: ${html}`
    );
  }
});

test("renderDocNode: a widgetEmbed node resolves through inlineResolved to its widget's IR (REQ-21) — the theme never sees a raw widgetEmbed reference", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "widgetEmbed", attrs: { placementId: "p1", widgetEntryId: "w1" } }],
  };
  const inlineResolved = new Map<string, WidgetRenderIR>([
    ["p1", { componentId: "text", props: { body: "Inline widget content" } }],
  ]);
  const html = renderDocNode(doc, inlineResolved);
  assert.match(html, /widget-text/);
  assert.match(html, /Inline widget content/);
  assert.doesNotMatch(html, /widgetEmbed/);
});

test("renderDocNode: a widgetEmbed node with no matching entry in inlineResolved (unresolved/not-yet-wired) degrades to the public-safe placeholder, never a crash or raw attrs dump (REQ-28)", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "widgetEmbed", attrs: { placementId: "missing", widgetEntryId: "w1" } }],
  };
  const html = renderDocNode(doc);
  assert.match(html, /widget-placeholder/);
  assert.doesNotMatch(html, /w1|missing/);
});

// ---------------------------------------------------------------------------
// D7 — TipTap `image` nodes were silently dropped (no `case "image"` in
// `renderDocNode`, so a childless image node fell to the `default` branch,
// which renders `node.content` — undefined for a leaf node). Fixed by
// degrading to the same aspect-ratio placeholder convention `hero`/`section`
// media props already use (`mediaPlaceholder`), rather than emitting a real
// `<img src>`: today's editor writes `data:` URLs, arbitrary external URLs,
// or the authenticated admin media-preview URL into `attrs.src` — none of
// which are safe/correct to embed unescaped on the public site (see D7 recon
// note). `title` is never read at all, so there is nothing to escape or
// reject there.
//
// UPDATE (2026-08-12, `ed727041`): `src` is no longer refused unconditionally.
// The owner reversed the blanket ban — "why is that even bad to refuse an
// attribute source? If the user is saying they want it, why bar it?" — and
// render.ts grew `safeImageSrc`, an http(s)-only ALLOWLIST (not a denylist):
// a plain https URL now renders a real `<img src>`; only a rejected scheme
// (`javascript:`/`data:`/`blob:`/`file:`) or the authenticated admin media
// URL still degrades to the placeholder below. See
// `tiptap-render-contract.test.ts`'s "LEGACY src-only node" rows for the full
// allow/reject matrix; this block only needs one rejected-src case to keep
// proving the placeholder/alt-label contract D7 established.
// ---------------------------------------------------------------------------

test("renderDocNode: an image node no longer vanishes — a hostile-scheme src degrades to the media placeholder using alt text as the label, and never emits src/title (D7, updated for the 2026-08-12 safeImageSrc allowlist)", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "before" }] },
      { type: "image", attrs: { src: "javascript:alert(1)", alt: '<A> cat & "friend"', title: "ignored" } },
      { type: "paragraph", content: [{ type: "text", text: "after" }] },
    ],
  };
  const html = renderDocNode(doc);
  assert.match(html, /<p>before<\/p>/);
  assert.match(html, /<p>after<\/p>/);
  assert.match(html, /media-ph/);
  assert.match(html, /&lt;A&gt; cat &amp; &quot;friend&quot;/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /ignored/);
  assert.doesNotMatch(html, /<img/);
});

test("renderDocNode: an image node with no/non-string alt falls back to a generic 'Image' label, never crashes", () => {
  // No `src` at all (as opposed to a rejected one) — still the placeholder path this test exercises,
  // per safeImageSrc's 2026-08-12 allowlist (see the D7 block's own update note above): a valid https
  // URL now renders a real <img>, which would take this case off the placeholder path entirely.
  const noAlt = renderDocNode({ type: "doc", content: [{ type: "image", attrs: {} }] });
  assert.match(noAlt, /media-ph__label">Image</);

  const nonStringAlt = renderDocNode({ type: "doc", content: [{ type: "image", attrs: { src: "x", alt: 42 } as never }] });
  assert.match(nonStringAlt, /media-ph__label">Image</);
});

// ---------------------------------------------------------------------------
// ADR-027 §4 — ref-based `{assetId, transformName}` image nodes. Extends D7's
// placeholder default with a SECOND case that emits a real `<img src>`:
// a node whose `transformName` has a resolved entry in `mediaTransformVersions`
// (the caller-supplied map straight off `transform_registry`, per `render.ts`'s
// own `EMPTY_MEDIA_TRANSFORM_VERSIONS` doc). An unregistered/unresolved
// `transformName`, or a malformed id, must still degrade to the exact same D7
// placeholder; that backward-compat guarantee is asserted here as directly as
// the happy path, not assumed from the happy-path test alone.
//
// A legacy `src`-only node is NOT in that "still degrades" set as of
// 2026-08-12 (see the D7 block's own update note above) — a `src` that passes
// `safeImageSrc`'s allowlist now renders too, via a DIFFERENT branch than the
// ref path. What this section still needs to prove is narrower than the
// original comment claimed: that a non-empty `mediaTransformVersions` map
// does not accidentally activate the ref path for a plain `src`-only node
// (no `assetId`/`transformName` attrs at all) — the ref path is gated on
// those two attrs being present, never inferred from the map alone.
// ---------------------------------------------------------------------------

test("renderDocNode: a ref-based image node with a resolved transformName renders a real <img> against the public /m/ URL, never a placeholder", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: '<A> & "friend"' } }],
  };
  const html = renderDocNode(doc, undefined, new Map([["public", 3]]));
  assert.match(html, /<img src="\/m\/asset-1\/public\.v3\/image\.jpg" alt="&lt;A&gt; &amp; &quot;friend&quot;" loading="lazy">/);
  assert.doesNotMatch(html, /media-ph/);
});

test("renderDocNode: a ref-based image node with NO entry for its transformName in mediaTransformVersions degrades to the placeholder (unregistered/not-yet-resolved), never a guessed or malformed URL", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "unknown-name", alt: "x" } }],
  };
  // Non-empty map, but no key for "unknown-name" — proves the branch checks the SPECIFIC name,
  // not merely "is the map non-empty".
  const html = renderDocNode(doc, undefined, new Map([["public", 3]]));
  assert.match(html, /media-ph/);
  assert.doesNotMatch(html, /<img/);
});

test("renderDocNode: a ref-based image node with an empty mediaTransformVersions map degrades to the placeholder (default param, every pre-existing caller)", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(doc); // no 3rd arg at all — exercises the default EMPTY_MEDIA_TRANSFORM_VERSIONS
  assert.match(html, /media-ph/);
  assert.doesNotMatch(html, /<img/);
});

test("renderDocNode: a ref-based image node with a resolved mediaAssetMetadata entry emits width/height/class on the <img> — owner-directed quick-and-dirty sizing fix", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: 800, height: 600, cssClass: "rounded" }]])
  );
  assert.match(html, /<img src="\/m\/asset-1\/public\.v3\/image\.jpg" alt="x" width="800" height="600" class="rounded" loading="lazy">/);
});

test("renderDocNode: a resolved image with only width set omits height/class entirely — both are independently optional, neither defaults to a computed value", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: 800, height: null, cssClass: null }]])
  );
  assert.match(html, /<img src="\/m\/asset-1\/public\.v3\/image\.jpg" alt="x" width="800" loading="lazy">/);
  assert.doesNotMatch(html, /height=/);
  assert.doesNotMatch(html, /class=/);
});

test("renderDocNode: an asset absent from mediaAssetMetadata (never uploaded through the sizing UI, or the default empty map) renders without width/height/class — no regression on the pre-existing <img> shape", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(doc, undefined, new Map([["public", 3]])); // no 4th arg — default EMPTY_MEDIA_ASSET_METADATA
  assert.equal(html, '<img src="/m/asset-1/public.v3/image.jpg" alt="x" loading="lazy">');
});

test("renderDocNode: a hostile stored cssClass is HTML-escaped, same as alt — public HTML never trusts a stored string raw", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: '"><script>alert(1)</script>' }]])
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /class="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

// ---------------------------------------------------------------------------
// htmlAttributes (2026-09-07) — render-path enforcement (defense-in-depth) of the same allowlist
// updateMediaMetadata already applies at the write path. See MediaRecord.htmlAttributes's own doc.
// ---------------------------------------------------------------------------

test("renderDocNode: a resolved htmlAttributes value emits the extra allowlisted attributes on the <img>", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: 'data-motion="fade-in"' }]])
  );
  assert.match(html, /<img src="\/m\/asset-1\/public\.v3\/image\.jpg" alt="x" data-motion="fade-in" loading="lazy">/);
});

test("renderDocNode: an operator's own htmlAttributes loading value OVERRIDES the hardcoded 'lazy' default instead of emitting loading twice", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: 'loading="eager"' }]])
  );
  assert.match(html, /loading="eager"/);
  const loadingCount = (html.match(/loading=/g) ?? []).length;
  assert.equal(loadingCount, 1, "loading must appear exactly once, never duplicated");
});

test("renderDocNode: a stored htmlAttributes value that would now fail validation (e.g. an on* handler smuggled in some other way) fails CLOSED — no extra attributes emitted, no crash", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: 'onerror="alert(1)"' }]])
  );
  assert.doesNotMatch(html, /onerror/, "an invalid stored value must never reach the emitted tag, defense-in-depth");
  assert.match(html, /<img src="\/m\/asset-1\/public\.v3\/image\.jpg" alt="x" loading="lazy">/);
});

test("renderDocNode: an asset with no htmlAttributes set renders exactly as before this feature — no regression", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: null }]])
  );
  assert.equal(html, '<img src="/m/asset-1/public.v3/image.jpg" alt="x" loading="lazy">');
});

// --- readable-slugs S3: renderImageTag/renderVideoTag emit the resolved asset's slug, not its id ---

test("renderDocNode: a resolved mediaAssetMetadata entry carrying a slug renders the /m/ URL keyed by the SLUG, not the assetId (readable-slugs S3)", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: null, slug: "fox" }]])
  );
  assert.equal(html, '<img src="/m/fox/public.v3/image.jpg" alt="x" loading="lazy">');
});

test("renderDocNode: an INVALID slug (fails isValidMediaSlugFormat — e.g. contains '/') in mediaAssetMetadata falls back to the id, never emitting the bad value into the URL", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: null, slug: "../etc" }]])
  );
  assert.equal(html, '<img src="/m/asset-1/public.v3/image.jpg" alt="x" loading="lazy">');
});

test("renderDocNode: no slug on the mediaAssetMetadata entry (absent field, or a resolved asset that never had one) renders keyed by the id exactly as before this feature — no regression", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: null, slug: null }]])
  );
  assert.equal(html, '<img src="/m/asset-1/public.v3/image.jpg" alt="x" loading="lazy">');
});

test("renderDocNode: a generic media VIDEO node with a slug in mediaAssetMetadata renders the /original URL keyed by the SLUG too", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "media", attrs: { assetId: "asset-vid", transformName: "public", alt: "A clip" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    undefined,
    new Map([["asset-vid", { width: null, height: null, cssClass: null, htmlAttributes: null, contentType: "video/mp4", slug: "fox" }]])
  );
  assert.match(html, /<video src="\/m\/fox\/original" controls>A clip<\/video>/);
});

test("renderDocNode: a malformed assetId/transformName (embedded '/', empty, or over-length) degrades to the placeholder even when the name would otherwise resolve — never a malformed /m/ URL", () => {
  const resolved = new Map([["public", 1], ["", 1]]);
  const cases: Array<{ assetId: string; transformName: string }> = [
    { assetId: "asset/1", transformName: "public" }, // '/' in assetId would smuggle an extra path segment
    { assetId: "asset 1", transformName: "public" }, // whitespace
    { assetId: "asset-1", transformName: "" }, // empty transformName, even though "" is (adversarially) a map key
    { assetId: "", transformName: "public" }, // empty assetId
    { assetId: "a".repeat(201), transformName: "public" }, // over MAX_MEDIA_REF_ID_LENGTH
  ];
  for (const attrs of cases) {
    const doc: JsonObject = { type: "doc", content: [{ type: "image", attrs: { ...attrs, alt: "x" } }] };
    const html = renderDocNode(doc, undefined, resolved);
    assert.match(html, /media-ph/, `expected placeholder for ${JSON.stringify(attrs)}`);
    assert.doesNotMatch(html, /<img/, `expected no <img> for ${JSON.stringify(attrs)}`);
  }
});

test("renderDocNode: a legacy src-only node with a hostile-scheme src still degrades to the placeholder even when mediaTransformVersions is non-empty — the ref path only activates on assetId+transformName, never on src", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { src: "javascript:alert(1)", alt: "legacy" } }],
  };
  const html = renderDocNode(doc, undefined, new Map([["public", 1]]));
  assert.match(html, /media-ph/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /javascript:/);
});

test("renderSite: a ref-based image node embedded in a real post body renders a real <img> end-to-end through the declarative slot path, when the caller resolves mediaTransformVersions", async () => {
  const post = fakePost({
    bodyJson: {
      type: "doc",
      content: [{ type: "image", attrs: { assetId: "asset-42", transformName: "public", alt: "Team photo" } }],
    },
  });
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");
  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "Dispatch Demo",
    posts: [post],
    post,
    mediaTransformVersions: new Map([["public", 5]]),
  });
  assert.match(html, /<img src="\/m\/asset-42\/public\.v5\/image\.jpg" alt="Team photo" loading="lazy">/);
  assert.doesNotMatch(html, /media-ph/);
});

test("renderSite: an image node embedded in a real post body renders the placeholder end-to-end through both the declarative slot path and the shared Liquid/Handlebars `post.content` builder", async () => {
  const post = fakePost({
    bodyJson: {
      type: "doc",
      content: [{ type: "image", attrs: { src: "data:image/png;base64,AAAA", alt: "Team photo" } }],
    },
  });
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");
  const html = await renderSite({ theme, route: "post", siteTitle: "Dispatch Demo", posts: [post], post });
  assert.match(html, /media-ph/);
  assert.match(html, /Team photo/);
  assert.doesNotMatch(html, /base64,AAAA/);
});

test("renderSite: every v1 widget componentId renders correctly and escapes untrusted props (text/social-links/recent-entries+entry-list-item/menu/contact-form/unknown->placeholder)", async () => {
  const theme = declarativeTheme({ type: "doc", content: [{ type: "region", key: "footer" }] });
  const ir: WidgetRenderIR[] = [
    { componentId: "text", props: { body: "<script>alert(1)</script>" } },
    { componentId: "social-links", props: { links: [{ platform: "<X>", url: "javascript:alert(1)" }] } },
    {
      componentId: "recent-entries",
      props: { layout: "list", columns: 3, typeKey: "recent-entries" },
      children: [
        { componentId: "entry-list-item", props: { title: "<Post>", href: "/post-1", dateIso: "2026-01-01T00:00:00.000Z", dateLabel: "Jan 1, 2026", fields: [] } },
      ],
    },
    { componentId: "menu", props: { title: "Main", items: [{ label: "Home", href: "/", available: true }, { label: "Hidden", available: false }] } },
    { componentId: "contact-form", props: { slug: "contact", fields: [{ id: "email", label: "Email", type: "email", required: true }], successMessage: null } },
    { componentId: "unknown-future-type", props: { secret: "leak-me" } },
  ];
  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({ regions: { footer: ir } }),
  });

  // text: escaped, no script execution surface
  assert.match(html, /widget-text/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);

  // social-links: escaped label, javascript: href collapsed to '#' (C7 safeHref discipline)
  assert.match(html, /widget-social-links/);
  assert.match(html, /&lt;X&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);

  // recent-entries -> entry-list-item child, escaped title, real resolved link
  assert.match(html, /widget-recent-entries/);
  assert.match(html, /&lt;Post&gt;/);
  assert.match(html, /href="\/post-1"/);

  // menu: available item links, unavailable item renders as inert text (mirrors siteNav's own rule)
  assert.match(html, /widget-menu/);
  assert.match(html, /<a href="\/">Home<\/a>/);
  assert.match(html, /widget-menu-item--unavailable">Hidden</);

  // contact-form: posts to Forms' existing public route unmodified (REQ-37/39), field vocabulary rendered
  assert.match(html, /widget-contact-form/);
  assert.match(html, /action="\/forms\/contact\/submit"/);
  assert.match(html, /type="email"/);

  // unknown componentId -> the same public-safe placeholder, no secret leaked
  assert.match(html, /widget-placeholder/);
  assert.doesNotMatch(html, /leak-me/);
});

/**
 * Collections plan R1 — "Recent Entries" becomes "Collection list". D7: list layout is the
 * historical default and must keep its exact old classes; the only visible change to an old config
 * is a `null` href (D1, entry pages off) rendering as plain text instead of the old dead
 * `href="/<slug>"` link.
 */
test("recent-entries (list layout): a null href renders plain text, not a link — and the legacy widget/widget-entry-summary classes are unchanged", () => {
  const html = renderWidgetIr({
    componentId: "recent-entries",
    props: { layout: "list", columns: 3, typeKey: "recent-entries" },
    children: [
      { componentId: "entry-list-item", props: { title: "No Page Yet", href: null, dateIso: "2026-01-01T00:00:00.000Z", dateLabel: "Jan 1, 2026", fields: [] } },
    ],
  });
  assert.match(html, /<ul class="widget widget-recent-entries">/);
  assert.match(html, /<li class="widget-entry-summary">No Page Yet<\/li>/);
  assert.doesNotMatch(html, /<a /, `expected plain text, no link, got: ${html}`);
});

test("recent-entries (cards layout): delegates to C3's renderEntryList — entry-list/entry-card classes and field <dl> appear", () => {
  const html = renderWidgetIr({
    componentId: "recent-entries",
    props: { layout: "cards", columns: 2, typeKey: "recipe" },
    children: [
      {
        componentId: "entry-list-item",
        props: {
          title: "Pasta",
          href: null,
          dateIso: "2026-01-01T00:00:00.000Z",
          dateLabel: "Jan 1, 2026",
          fields: [{ name: "cuisine", label: "Cuisine", kind: "text", value: "Italian" }],
        },
      },
    ],
  });
  assert.match(html, /class="entry-list entry-list--recipe"/);
  assert.match(html, /class="entry-card"/);
  assert.match(html, /<h3 class="entry-card__title">Pasta<\/h3>/);
  assert.match(html, /<dt>Cuisine<\/dt><dd>Italian<\/dd>/);
  assert.doesNotMatch(html, /<a /, `title has no href, must not be a link, got: ${html}`);
});

test("recent-entries: zero items renders the same 'No entries yet.' fallback regardless of layout", () => {
  const listEmpty = renderWidgetIr({ componentId: "recent-entries", props: { layout: "list", columns: 3, typeKey: "recent-entries" }, children: [] });
  const cardsEmpty = renderWidgetIr({ componentId: "recent-entries", props: { layout: "cards", columns: 3, typeKey: "recent-entries" }, children: [] });
  assert.equal(listEmpty, '<ul class="widget widget-recent-entries"><li class="widget-empty">No entries yet.</li></ul>');
  assert.equal(cardsEmpty, listEmpty);
});

/**
 * Review fix 3a (2026-09-23-review-E4-R1-report.md): the default `.entry-list`/`.entry-card` style
 * used to be injected only by `static-render.ts`'s `renderStaticPage` (the static-tier pipeline) —
 * `pageShell`, which every templated/handlebars/declarative theme (and no-theme) render goes
 * through, never called `withEntryListStyleOnce` at all, so a cards-layout Collection list widget
 * rendered as unstyled div soup on any non-static theme.
 */
test("renderSite (pageShell, declarative tier): a recent-entries cards-layout widget gets the shared entry-list/entry-card style injected into <head> — review fix 3a", async () => {
  const theme = declarativeTheme({ type: "doc", content: [{ type: "region", key: "footer" }] });
  const ir: WidgetRenderIR[] = [
    {
      componentId: "recent-entries",
      props: { layout: "cards", columns: 3, typeKey: "recipe" },
      children: [
        { componentId: "entry-list-item", props: { title: "Pasta", href: null, dateIso: "2026-01-01T00:00:00.000Z", dateLabel: "Jan 1, 2026", fields: [] } },
      ],
    },
  ];
  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Cards Demo",
    posts: [],
    widgets: widgetsResult({ regions: { footer: ir } }),
  });
  assert.match(html, /<style data-tovu-entry-list>/);
  assert.ok(html.indexOf("<style data-tovu-entry-list>") < html.indexOf("</head>"), "the style must land inside <head>");
});

/**
 * The trap this same fix had to avoid (review 3a): declarative themes already use the plain
 * `entry-list`/`entry-list--<route>` classes for their OWN built-in post/product index
 * (`productEntryList`, exercised here via the fallback body since this theme declares no `products`
 * template). Wiring `withEntryListStyleOnce` into `pageShell` must never turn that unrelated
 * vertical list into a grid.
 */
test("renderSite (pageShell, declarative tier): the theme's own built-in entry-list (unrelated to collections) never triggers the collection card style — review fix 3a trap", async () => {
  const theme = declarativeTheme({ type: "doc", content: [{ type: "region", key: "footer" }] });
  const html = await renderSite({
    theme,
    route: "products",
    siteTitle: "No Grid Here",
    posts: [],
    products: [],
  });
  assert.match(html, /class="entry-list entry-list--products"/, "sanity: the built-in product index still uses the entry-list class");
  assert.doesNotMatch(html, /data-tovu-entry-list/, "an unrelated entry-list class must never trigger the collection card style");
});

test("menu widget: authored cssClass/rel/openInNewTab/icon/description reach the rendered <li>/<a> — previously silently dropped (the resolver already attaches NavItemAttrs to every ResolvedNavItem; only static-tier themes' tree variant read it)", () => {
  const html = renderWidgetIr({
    componentId: "menu",
    props: {
      title: "Main",
      items: [
        {
          label: "Docs",
          href: "/docs",
          available: true,
          attrs: { cssClass: "is-featured", rel: "nofollow", openInNewTab: true, icon: "book", description: "Guides" },
          children: [],
        },
      ],
    },
  });
  assert.match(html, /<li class="is-featured">/);
  assert.match(html, /<a href="\/docs" rel="nofollow" target="_blank">/);
  assert.match(html, /data-icon="book"/);
  assert.match(html, /widget-menu-item-desc">Guides</);
  assert.match(html, /Docs/);
});

test("menu widget: an item with no attrs at all renders exactly as before this feature existed (no stray class/rel/target attributes)", () => {
  const html = renderWidgetIr({
    componentId: "menu",
    props: { items: [{ label: "Home", href: "/", available: true }] },
  });
  assert.match(html, /<li><a href="\/">Home<\/a><\/li>/);
});

test("widgets: protocol-relative hrefs never reach public HTML through any widget href surface (open-redirect fix, 2026-08-20)", () => {
  // social-links and menu both go THROUGH safeHref (render.ts:1408/1436) — fixed by the same
  // safeHref change the C7 test above proves.
  const social = renderWidgetIr({ componentId: "social-links", props: { links: [{ platform: "X", url: "//evil.example" }] } });
  assert.match(social, /href="#"/, `social-links did not neutralize the href, got: ${social}`);
  assert.doesNotMatch(social, /evil\.example/);

  const menu = renderWidgetIr({
    componentId: "menu",
    props: { title: "Main", items: [{ label: "Evil", href: "//evil.example", available: true }] },
  });
  assert.match(menu, /href="#"/, `menu did not neutralize the href, got: ${menu}`);
  assert.doesNotMatch(menu, /evil\.example/);

  // entry-summary is a SECOND, INDEPENDENT bypass (render.ts:1417, pre-fix): it built
  // `href="/${slug}"` itself and never called safeHref at all. A `props.slug` of "/evil.example"
  // (a leading slash inside the widget prop) reconstructs the identical "//evil.example"
  // protocol-relative shape once concatenated behind the hardcoded "/" — same attack, different
  // route, so it needs its own fix (slug format validation), not a safeHref call.
  const entry = renderWidgetIr({ componentId: "entry-summary", props: { slug: "/evil.example", title: "Evil" } });
  assert.doesNotMatch(entry, /href="\/\/evil\.example"/, `entry-summary reconstructed a protocol-relative href, got: ${entry}`);
  assert.doesNotMatch(entry, /evil\.example/);
});

// ---------------------------------------------------------------------------
// contact-form field className/attributes — the admin "field attributes" modal's data reaching
// this public render path. `forms.ts`'s `validateFieldDescriptors` is the real gate (see that
// file's own tests); these pin what THIS renderer does with the two new properties once they've
// arrived here, including the defensive re-check `renderExtraFieldAttrs` does on the attribute
// NAME (see that function's own header for why a value's escaping is not enough for a name).
// ---------------------------------------------------------------------------

test("contact-form widget: a field's maxLength reaches the rendered input as maxlength, so the browser stops typing at the limit instead of the server rejecting the whole submission as too_long", async () => {
  const theme = declarativeTheme({ type: "doc", content: [{ type: "region", key: "footer" }] });
  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({
      regions: {
        footer: [
          {
            componentId: "contact-form",
            props: {
              slug: "contact",
              fields: [
                { id: "message", label: "Message", type: "textarea", required: true, maxLength: 500 },
                { id: "email", label: "Email", type: "email", required: true, maxLength: 120 },
                { id: "agree", label: "Agree", type: "checkbox", required: false },
              ],
              successMessage: null,
            },
          },
        ],
      },
    }),
  });
  assert.match(html, /<textarea name="message" id="widget-contact-message" required maxlength="500"/);
  assert.match(html, /<input type="email" name="email" id="widget-contact-email" required maxlength="120"/);
  assert.doesNotMatch(html, /name="agree"[^>]*maxlength/);
});

test("contact-form widget: a Tailwind-style className survives intact on the rendered input", async () => {
  const theme = declarativeTheme({ type: "doc", content: [{ type: "region", key: "footer" }] });
  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({
      regions: {
        footer: [
          {
            componentId: "contact-form",
            props: {
              slug: "contact",
              fields: [{ id: "email", label: "Email", type: "email", required: true, className: "md:col-span-2 w-1/2 focus:ring-2" }],
              successMessage: null,
            },
          },
        ],
      },
    }),
  });
  assert.match(html, /class="md:col-span-2 w-1\/2 focus:ring-2"/);
});

test("contact-form widget: an allowlisted attribute renders, its value escaped (\" and < cannot break out of the attribute)", async () => {
  const theme = declarativeTheme({ type: "doc", content: [{ type: "region", key: "footer" }] });
  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({
      regions: {
        footer: [
          {
            componentId: "contact-form",
            props: {
              slug: "contact",
              fields: [
                {
                  id: "email",
                  label: "Email",
                  type: "email",
                  required: true,
                  attributes: { "aria-label": 'Say "<hi>"', "data-testid": "email-field" },
                },
              ],
              successMessage: null,
            },
          },
        ],
      },
    }),
  });
  assert.match(html, /aria-label="Say &quot;&lt;hi&gt;&quot;"/);
  assert.match(html, /data-testid="email-field"/);
  assert.doesNotMatch(html, /Say "<hi>"/);
});

test("contact-form widget: a non-allowlisted attribute name (e.g. an 'onclick' that reached storage some other way) is never emitted, even though its value would otherwise escape safely", async () => {
  const theme = declarativeTheme({ type: "doc", content: [{ type: "region", key: "footer" }] });
  const html = await renderSite({
    theme,
    route: "home",
    siteTitle: "Widgets Demo",
    posts: [],
    widgets: widgetsResult({
      regions: {
        footer: [
          {
            componentId: "contact-form",
            props: {
              slug: "contact",
              fields: [
                { id: "email", label: "Email", type: "email", required: true, attributes: { onclick: "alert(1)", style: "x" } },
              ],
              successMessage: null,
            },
          },
        ],
      },
    }),
  });
  assert.doesNotMatch(html, /onclick=/);
  assert.doesNotMatch(html, /style=/);
});

// ---------------------------------------------------------------------------
// contact-form widget — Bug 1 (unstyled everywhere) and Bug 2 (raw JSON on submit), 2026-08-31.
//
// Root cause of Bug 1: every theme in content/themes/ was grepped for `widget-contact-form` /
// `widget-form-field` and NONE had a single rule — confirmed with
// `grep -rln "widget-contact-form\|widget-form-field" content/themes/*/*/css/*.css` returning
// nothing, and cross-checked against a bare `\.widget\b` scan across every theme's css/ directory
// (also empty). The class hooks were always there; nothing anywhere ever styled them, in ANY theme,
// not just the active `basic` one — so the fix ships baseline styles WITH the widget itself.
// ---------------------------------------------------------------------------

test("contact-form widget: ships its own baseline <style> block (Bug 1 fix) — no theme has ever had CSS for these class hooks (grep -rl over content/themes/ returns nothing), so the widget must be usable without any theme-author work", () => {
  const html = renderWidgetIr({
    componentId: "contact-form",
    props: { slug: "contact-us", fields: [{ id: "email", label: "Email", type: "email", required: true }], successMessage: null },
  });
  assert.match(html, /<style>/);
  // Generalized 2026-08-31: the baseline CSS now keys ONLY on the generic `.tovu-form`/
  // `.widget-form-field` hooks (`:not([hidden])` still guards the display-setting one, Fix 1) — a
  // theme override still works because the RENDERED markup carries the legacy class too (see the
  // next assertion), which is what a theme's own selector actually targets, not this internal
  // stylesheet.
  assert.match(html, /\.tovu-form(:not\(\[hidden\]\))?\)/);
  assert.match(html, /\.widget-form-field(:not\(\[hidden\]\))?\)/);
  // The pre-existing class hooks and POST target must survive unchanged in the MARKUP — a theme CAN
  // still override them (a real theme selector, without `:where()`, naturally outranks this baseline
  // stylesheet regardless of cascade order) — alongside the new generic `tovu-form`/`data-form-slug`
  // hooks any other form-rendering widget can share.
  assert.match(html, /class="widget tovu-form widget-contact-form"/);
  assert.match(html, /data-form-slug="contact-us" data-contact-form-slug="contact-us"/);
  assert.match(html, /action="\/forms\/contact-us\/submit"/);
});

test("contact-form widget: baseline CSS must not force display on a hidden form (Fix 1 — [hidden] must win over the widget's own display:flex)", () => {
  const html = renderWidgetIr({
    componentId: "contact-form",
    props: { slug: "contact-us", fields: [{ id: "email", label: "Email", type: "email", required: true }], successMessage: null },
  });
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(styleMatch, "baseline style block must be present");
  const css = styleMatch![1];
  // Any rule that sets `display` on a widget-* class an instance could carry `hidden` on must scope
  // itself with `:not([hidden])` — otherwise a zero-specificity `:where()` author rule still beats the
  // UA stylesheet's `[hidden]{display:none}`, and the empty form stays visible under the success
  // message (2026-08-31 regression: /contact?form=contact-us&form_status=success showed both).
  // Selector body allows one level of nested parens (e.g. `:not([hidden])` inside `:where(...)`).
  const displayRules = [...css.matchAll(/:where\(((?:[^()]|\([^()]*\))*)\)\s*\{[^}]*\bdisplay\s*:/g)].map((m) => m[1]);
  assert.ok(displayRules.length > 0, "expected at least one display-setting rule to audit");
  for (const selector of displayRules) {
    assert.match(selector, /:not\(\[hidden\]\)/, `display-setting selector "${selector}" must exclude [hidden] elements`);
  }
});

// ---------------------------------------------------------------------------
// Fallback-chain auditing helpers for the "only references tokens that exist, or carry a
// guaranteed fallback" test below. Matching a token by NAME (as the test used to) is not enough —
// `var(--danger)` with no fallback at all passes a name check just as well as the correct
// `var(--danger, var(--tovu-form-danger-fallback))` does, while silently producing a broken/default
// value at runtime. These walk the actual `var(...)` call site(s) and confirm the fallback chain
// bottoms out in a literal value rather than stopping at another undefined custom property.
// ---------------------------------------------------------------------------

/** Extracts the full argument list of the `var(...)` call whose opening paren sits at
 *  `openParenIndex` in `css`, respecting paren balance so a nested `var(--x, var(--y))` fallback
 *  doesn't truncate the outer call at its own inner `)`. Returns the text strictly between the
 *  outer parens. */
function varCallArgsAt(css: string, openParenIndex: number): string {
  let depth = 0;
  let i = openParenIndex;
  for (; i < css.length; i++) {
    if (css[i] === "(") depth++;
    if (css[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  return css.slice(openParenIndex + 1, i);
}

/** Every `var(<token>...)` call site's full argument list in `css` — a stylesheet can reference the
 *  same token more than once with different (or missing) fallbacks, so each call site is audited
 *  independently rather than the token being checked once by name. */
function findVarCallSites(css: string, token: string): string[] {
  const sites: string[] = [];
  const marker = `var(${token}`;
  for (let i = css.indexOf(marker); i !== -1; i = css.indexOf(marker, i + 1)) {
    sites.push(varCallArgsAt(css, i + 3)); // i+3: "var" is 3 chars, lands on the "("
  }
  return sites;
}

/** True when a `var(...)` call's argument list carries a fallback that itself resolves to a
 *  literal value — either directly (`var(--danger, #f87171)`), or one level of
 *  `var(--other-token)` indirection where `--other-token` is declared somewhere in `css` with a
 *  literal (never another `var()`) value. Returns false when the chain never bottoms out this way:
 *  no fallback argument at all, or a fallback that only points at another undefined token. */
function varChainBottomsOutInLiteral(css: string, callArgs: string): boolean {
  const commaIndex = callArgs.indexOf(",");
  if (commaIndex === -1) return false; // no fallback argument supplied
  const fallback = callArgs.slice(commaIndex + 1).trim();
  if (!fallback.startsWith("var(")) return true; // a literal fallback (hex, keyword, ...)
  const nestedArgs = varCallArgsAt(fallback, 3);
  const nestedToken = nestedArgs.split(",")[0].trim();
  const literalDecls = [...css.matchAll(new RegExp(`${nestedToken}:([^;]+);`, "g"))];
  return literalDecls.length > 0 && literalDecls.every((m) => !m[1].includes("var("));
}

test("contact-form widget: baseline CSS only references design tokens that actually exist in a theme's token set, OR a token that carries its own guaranteed fallback (Fix 2 — --danger/--danger-bg/--success-bg/--success-fg exist in no theme's tokens.json; Fix 3, 2026-08-31 — --danger/--success are now used deliberately, each wrapped in a var(--x, var(--tovu-form-*-fallback)) chain whose innermost fallback is a literal hex, so an undefined token can never silently produce a broken/default value)", () => {
  const html = renderWidgetIr({
    componentId: "contact-form",
    props: { slug: "contact-us", fields: [{ id: "email", label: "Email", type: "email", required: true }], successMessage: null },
  });
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(styleMatch, "baseline style block must be present");
  const css = styleMatch![1];
  // The set every `basic`/`basic-2` theme's tokens.json + tokens.light.json actually defines
  // (verified 2026-08-31) — mode-aware (dark on bare :root, light on :root[data-theme="light"]).
  const existingTokens = new Set([
    "--bg", "--surface", "--surface-2", "--fg", "--muted", "--border", "--border-strong",
    "--accent", "--accent-fg", "--font-display", "--font-body", "--container",
  ]);
  // --danger/--success: no theme defines these, by design — a theme that ever adds one to its own
  // tokens.json overrides the widget's hardcoded fallback automatically (var()'s fallback rule, not a
  // source-order one). Every reference to one of these must carry a fallback chain that bottoms out
  // in a literal — asserted below, by call site, not just by name.
  const chainedTokens = new Set(["--danger", "--success"]);
  // The two --tovu-form-*-fallback names are FORM_BASELINE_STYLE's own private custom properties
  // (never a theme's to define) that supply that hardcoded, mode-aware fallback — see
  // FORM_BASELINE_STYLE's own doc for the contrast math on why the fallback itself must vary by
  // :root[data-theme="light"] rather than being one hex for both modes. Their own literal-ness is
  // asserted as part of resolving chainedTokens' fallback chains below, not here.
  const fallbackLiteralTokens = new Set(["--tovu-form-danger-fallback", "--tovu-form-success-fallback"]);
  const deliberateFallbackTokens = new Set([...chainedTokens, ...fallbackLiteralTokens]);
  const referencedTokens = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(referencedTokens.length > 0, "expected at least one var(--token) reference to audit");
  for (const token of referencedTokens) {
    assert.ok(
      existingTokens.has(token) || deliberateFallbackTokens.has(token),
      `token ${token} referenced in widget CSS does not exist in the theme token set and is not a deliberate fallback-guaranteed token`
    );
  }
  // Name-matching alone (above) lets a bare `var(--danger)` — no fallback, or a fallback that only
  // points at another undefined token — slip through unnoticed, even though it silently produces a
  // broken/default value at runtime. Walk every var(--danger.../--success...) call site's full
  // fallback chain and assert it actually terminates in a literal.
  for (const token of chainedTokens) {
    const callSites = findVarCallSites(css, token);
    assert.ok(callSites.length > 0, `expected at least one var(${token}...) call site to audit`);
    for (const callArgs of callSites) {
      assert.ok(
        varChainBottomsOutInLiteral(css, callArgs),
        `var(${callArgs}) does not terminate in a literal value — every ${token} reference must ` +
          "carry a fallback chain that bottoms out, not a bare reference or another undefined token"
      );
    }
  }
});

test("contact-form widget: the baseline <style> tag itself carries no attributes — must never trip the existing 'no style= attribute leaks from field attrs' guard a few tests above", () => {
  const html = renderWidgetIr({
    componentId: "contact-form",
    props: { slug: "contact", fields: [{ id: "email", label: "Email", type: "email", required: true }], successMessage: null },
  });
  assert.match(html, /<style>/); // present...
  assert.doesNotMatch(html, /<style /); // ...but never `<style anything=`
});

test("contact-form widget: renders a hidden success slot from props.successMessage, escaped, and a hidden per-field error slot — the anchors injectFormSubmissionResultIntoHtml fills in later", () => {
  const html = renderWidgetIr({
    componentId: "contact-form",
    props: {
      slug: "contact",
      fields: [{ id: "email", label: "Email", type: "email", required: true }],
      successMessage: "Thanks <for> reaching out",
    },
  });
  // Generic `tovu-form-success`/`data-form-slug` hooks alongside the legacy `widget-contact-form-*`/
  // `data-contact-form-slug` ones (2026-08-31 generalization) — any form-rendering widget gets the
  // former; contact-form additionally keeps the latter for theme back-compat.
  assert.match(
    html,
    /<div class="tovu-form-success widget-contact-form-success" data-form-slug="contact" data-contact-form-slug="contact" hidden>Thanks &lt;for&gt; reaching out<\/div>/
  );
  assert.match(html, /<div class="tovu-form-error widget-contact-form-error" data-form-slug="contact" data-contact-form-slug="contact" hidden><\/div>/);
  assert.match(html, /<div class="widget-form-field-error" data-field="email" id="widget-contact-email-error" hidden><\/div>/);
  assert.match(html, /aria-describedby="widget-contact-email-error"/);
});

// ---------------------------------------------------------------------------
// injectFormSubmissionResultIntoHtml / decode+encodeFormSubmissionResultQuery — Bug 2's
// Post/Redirect/Get round trip. `forms-submit.ts` builds the query with `encode...`; `pages.ts`
// reads it back with `decode...` and passes the result here to splice into the already-rendered page.
// ---------------------------------------------------------------------------

function contactFormPageHtml(slug = "contact"): string {
  return renderWidgetIr({
    componentId: "contact-form",
    props: { slug, fields: [{ id: "email", label: "Email", type: "email", required: true }], successMessage: "All set!" },
  });
}

test("injectFormSubmissionResultIntoHtml: undefined result is a byte-identical no-op", () => {
  const html = contactFormPageHtml();
  assert.equal(injectFormSubmissionResultIntoHtml(html, undefined), html);
});

test("injectFormSubmissionResultIntoHtml: a result for a slug NOT present on the page is a silent no-op (stale or forged query string)", () => {
  const html = contactFormPageHtml("contact");
  const result: FormSubmissionRedirectResult = { kind: "success", slug: "some-other-form" };
  assert.equal(injectFormSubmissionResultIntoHtml(html, result), html);
});

test("injectFormSubmissionResultIntoHtml: success reveals the success message and hides the form", () => {
  const html = contactFormPageHtml();
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "success", slug: "contact" });
  assert.match(updated, /<div class="tovu-form-success widget-contact-form-success" data-form-slug="contact" data-contact-form-slug="contact">All set!<\/div>/);
  assert.match(updated, /<form hidden class="widget tovu-form widget-contact-form"/);
});

test("injectFormSubmissionResultIntoHtml: validation reveals the matching field's error, escaped, and leaves an unrelated field's slot untouched", () => {
  const html = renderWidgetIr({
    componentId: "contact-form",
    props: {
      slug: "contact",
      fields: [
        { id: "email", label: "Email", type: "email", required: true },
        { id: "message", label: "Message", type: "textarea", required: true },
      ],
      successMessage: null,
    },
  });
  const updated = injectFormSubmissionResultIntoHtml(html, {
    kind: "validation",
    slug: "contact",
    fieldErrors: [{ field: "email", reason: "<script>bad</script>" }],
  });
  assert.match(updated, /<div class="widget-form-field-error" data-field="email" id="widget-contact-email-error">&lt;script&gt;bad&lt;\/script&gt;<\/div>/);
  assert.doesNotMatch(updated, /<script>bad<\/script><\/div>/, "reason text must be escaped, not raw HTML");
  assert.match(updated, /data-field="message"[^>]*hidden><\/div>/, "an untouched field's error slot must stay hidden");
  assert.match(updated, /Please fix the highlighted fields below\./);
});

test("injectFormSubmissionResultIntoHtml: a field reason containing an apostrophe is HTML-escaped, not left to survive raw (2026-09-06 escapeHtml fix — form-render.ts's copy omitted the apostrophe entity)", () => {
  const html = contactFormPageHtml();
  const updated = injectFormSubmissionResultIntoHtml(html, {
    kind: "validation",
    slug: "contact",
    fieldErrors: [{ field: "email", reason: "Don't leave this blank" }],
  });
  assert.match(updated, /Don&#39;t leave this blank/, "an apostrophe in attacker-influenced text must be escaped");
  assert.doesNotMatch(updated, /Don't leave this blank</, "a raw, unescaped apostrophe must never survive into rendered HTML");
});

test("injectFormSubmissionResultIntoHtml: a field reason containing '$&'/'$1'-shaped text renders literally instead of corrupting the surrounding HTML (String.prototype.replace's own replacement-pattern syntax)", () => {
  const html = contactFormPageHtml();
  const updated = injectFormSubmissionResultIntoHtml(html, {
    kind: "validation",
    slug: "contact",
    fieldErrors: [{ field: "email", reason: "cost is $1.00, not $&" }],
  });
  assert.match(updated, /cost is \$1\.00, not \$&amp;/);
  // A `$&` mis-substitution would have duplicated the matched substring inline — the baseline count
  // (success slot + form tag + the form's own error-summary div, all three carry the attribute) must
  // stay exactly 3, not grow. Checked on BOTH the legacy attribute and the generic one it now stands
  // alongside (2026-08-31 generalization).
  assert.equal((updated.match(/data-contact-form-slug="contact"/g) ?? []).length, 3);
  assert.equal((updated.match(/data-form-slug="contact"/g) ?? []).length, 3);
});

test("injectFormSubmissionResultIntoHtml: rate-limited reveals the error summary with the retry seconds", () => {
  const html = contactFormPageHtml();
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "rate-limited", slug: "contact", retryAfterSeconds: 42 });
  assert.match(updated, /<div class="tovu-form-error widget-contact-form-error" data-form-slug="contact" data-contact-form-slug="contact">Too many submissions.*42 seconds\.<\/div>/);
});

test("injectFormSubmissionResultIntoHtml: generic error reveals a generic message", () => {
  const html = contactFormPageHtml();
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "error", slug: "contact" });
  assert.match(updated, /Something went wrong — please try again\./);
});

test("encodeFormSubmissionResultQuery + decodeFormSubmissionResultFromQuery round-trip every result kind", () => {
  const cases: FormSubmissionRedirectResult[] = [
    { kind: "success", slug: "contact" },
    { kind: "validation", slug: "contact", fieldErrors: [{ field: "email", reason: "Required" }] },
    { kind: "rate-limited", slug: "contact", retryAfterSeconds: 30 },
    { kind: "error", slug: "contact" },
  ];
  for (const result of cases) {
    const params = encodeFormSubmissionResultQuery(result);
    const query = Object.fromEntries(params.entries());
    assert.deepEqual(decodeFormSubmissionResultFromQuery(query), result);
  }
});

test("decodeFormSubmissionResultFromQuery: malformed/hostile query input degrades to undefined or an empty error list rather than throwing", () => {
  assert.equal(decodeFormSubmissionResultFromQuery({}), undefined);
  assert.equal(decodeFormSubmissionResultFromQuery({ form: "contact" }), undefined, "status missing");
  assert.equal(decodeFormSubmissionResultFromQuery({ form: "contact", form_status: "bogus" }), undefined);
  assert.deepEqual(decodeFormSubmissionResultFromQuery({ form: "contact", form_status: "validation", form_errors: "not json" }), {
    kind: "validation",
    slug: "contact",
    fieldErrors: [],
  });
  assert.deepEqual(decodeFormSubmissionResultFromQuery({ form: "contact", form_status: "validation", form_errors: '{"not":"an array"}' }), {
    kind: "validation",
    slug: "contact",
    fieldErrors: [],
  });
  // Oversized array is truncated, not rejected outright or allowed to grow unbounded.
  const manyErrors = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ field: `f${i}`, reason: "bad" })));
  const decoded = decodeFormSubmissionResultFromQuery({ form: "contact", form_status: "validation", form_errors: manyErrors });
  assert.equal(decoded?.kind, "validation");
  assert.equal(decoded?.kind === "validation" ? decoded.fieldErrors.length : -1, 20);
});

test("decodeFormSubmissionResultFromQuery -> injectFormSubmissionResultIntoHtml: a hand-crafted hostile form_errors query value round-trips as raw text and is only ever escaped at the HTML sink, never double-escaped or left raw", () => {
  // Simulates an attacker hitting a page directly with a hand-crafted `form_errors` query string
  // (not one this app's own redirect produced) whose `reason` carries an HTML-breaking payload, and
  // whose `field` carries a lookalike-but-wrong name — this exercises readFieldErrorsFromQuery's
  // JSON.parse path end-to-end through injectFormSubmissionResultIntoHtml's actual HTML sink,
  // instead of constructing the already-parsed { field, reason } object directly as the tests above
  // do.
  const html = renderWidgetIr({
    componentId: "contact-form",
    props: {
      slug: "contact",
      fields: [{ id: "email", label: "Email", type: "email", required: true }],
      successMessage: null,
    },
  });

  const hostileReason = '"><script>alert(1)</script>';
  const query = {
    form: "contact",
    form_status: "validation",
    form_errors: JSON.stringify([
      { field: "email", reason: hostileReason },
      { field: "__proto__", reason: "should never match any real field slot" },
      { field: "no-such-field", reason: "stale/forged field name is a silent no-op" },
    ]),
  };

  const decoded = decodeFormSubmissionResultFromQuery(query);
  assert.equal(decoded?.kind, "validation");
  // Decoded value is the RAW, unescaped string — proves this module's own "escape at the sink, not
  // at the decode boundary" rule, not merely that the final HTML happens to be safe.
  assert.equal(decoded?.kind === "validation" ? decoded.fieldErrors[0]?.reason : undefined, hostileReason);
  // `__proto__` as a field name is read as a plain data property, never used to write through an
  // object's prototype — Object.prototype itself is untouched by decoding this query.
  assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false);

  const updated = injectFormSubmissionResultIntoHtml(html, decoded);
  assert.doesNotMatch(updated, /<script>alert\(1\)<\/script>/, "the hostile reason must never reach the response as live markup");
  assert.match(
    updated,
    /<div class="widget-form-field-error" data-field="email" id="widget-contact-email-error">&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/div>/,
    "the email field's error slot must show the reason, HTML-escaped"
  );
});

// ---------------------------------------------------------------------------
// Validation flash cookie (2026-08-31 field-wipe fix) — OPEN BUG B from the 2026-08-31 handoff: a
// failed validation used to wipe EVERY typed value, not just the invalid field, because PRG's fresh
// GET cannot see the prior POST body. `forms-submit.ts` sets a short-lived, HttpOnly cookie on a
// validation failure; `pages.ts` decodes it and merges it into the query-string result via
// `mergeFormFlashIntoResult` before splicing. These tests exercise the pure encode/decode/merge/
// splice layer in isolation from the two Express route files.
// ---------------------------------------------------------------------------

test("encodeFormFlashCookieValue + decodeFormFlashCookieValue round-trip a small payload", () => {
  const payload: FormFlashPayload = { slug: "contact", values: { name: "Ada Lovelace", email: "ada@example.com" } };
  const json = encodeFormFlashCookieValue(payload);
  assert.ok(json, "small payload must fit and encode to a real string");
  assert.deepEqual(decodeFormFlashCookieValue(json), payload);
});

test("encodeFormFlashCookieValue: never puts field values in the URL/query layer — the query round-trip functions are untouched by `values`", () => {
  // Regression guard for the explicit "do NOT put submitted values in the query string" requirement:
  // even a validation result that ALREADY carries `values` (as `mergeFormFlashIntoResult` would
  // attach) must not leak them through `encodeFormSubmissionResultQuery`.
  const result: FormSubmissionRedirectResult = {
    kind: "validation",
    slug: "contact",
    fieldErrors: [{ field: "message", reason: "Required" }],
    values: { name: "Ada Lovelace", email: "ada@example.com" },
  };
  const params = encodeFormSubmissionResultQuery(result);
  const serialized = params.toString();
  assert.doesNotMatch(serialized, /Ada/);
  assert.doesNotMatch(serialized, /example\.com/);
  assert.doesNotMatch(serialized, /values/);
});

test("encodeFormFlashCookieValue: a value longer than the per-field bound is truncated, not rejected", () => {
  const longValue = "x".repeat(5000); // MAX_BODY_STRING_LENGTH's own bound in forms-submit.ts
  const json = encodeFormFlashCookieValue({ slug: "contact", values: { message: longValue } });
  assert.ok(json);
  const decoded = decodeFormFlashCookieValue(json);
  assert.equal(decoded?.values.message.length, 300);
  assert.ok(longValue.startsWith(decoded!.values.message), "the truncated preview must be a real prefix of what was typed");
});

test("encodeFormFlashCookieValue: a form with many long fields that would not fit in one cookie drops LATER fields, keeping earlier ones, rather than emitting an oversized/broken cookie", () => {
  const fields = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, "y".repeat(300)]));
  const json = encodeFormFlashCookieValue({ slug: "contact", values: fields });
  assert.ok(json, "must still encode SOMETHING — dropping fields, not giving up entirely");
  assert.ok(Buffer.byteLength(json, "utf8") <= 3000, "encoded cookie value must respect the byte budget");
  const decoded = decodeFormFlashCookieValue(json)!;
  const keptCount = Object.keys(decoded.values).length;
  assert.ok(keptCount > 0 && keptCount < 20, `expected some but not all fields to survive, got ${keptCount}`);
  assert.ok("field0" in decoded.values, "the FIRST-declared field must survive the drop");
  assert.ok(!("field19" in decoded.values), "the LAST-declared field must be the one dropped");
});

test("decodeFormFlashCookieValue: malformed/hostile cookie input degrades to undefined rather than throwing", () => {
  assert.equal(decodeFormFlashCookieValue(undefined), undefined);
  assert.equal(decodeFormFlashCookieValue(""), undefined);
  assert.equal(decodeFormFlashCookieValue("not json"), undefined);
  assert.equal(decodeFormFlashCookieValue('{"slug":""}'), undefined, "empty slug is not a usable flash");
  assert.equal(decodeFormFlashCookieValue('{"slug":"contact"}'), undefined, "missing values object");
  assert.equal(decodeFormFlashCookieValue('{"slug":"contact","values":"not an object"}'), undefined);
  assert.deepEqual(decodeFormFlashCookieValue('{"slug":"contact","values":{"a":"ok","b":123}}'), {
    slug: "contact",
    values: { a: "ok" },
  });
});

test("mergeFormFlashIntoResult: attaches values only to a validation result for the SAME slug", () => {
  const validation: FormSubmissionRedirectResult = { kind: "validation", slug: "contact", fieldErrors: [] };
  assert.deepEqual(mergeFormFlashIntoResult(validation, { slug: "contact", values: { name: "Ada" } }), {
    ...validation,
    values: { name: "Ada" },
  });
  assert.equal(mergeFormFlashIntoResult(validation, { slug: "newsletter", values: { name: "Ada" } }), validation, "different slug: unchanged");
  assert.equal(mergeFormFlashIntoResult(validation, undefined), validation, "no flash: unchanged");
  assert.equal(mergeFormFlashIntoResult(undefined, { slug: "contact", values: { name: "Ada" } }), undefined, "no result: unchanged");
  const success: FormSubmissionRedirectResult = { kind: "success", slug: "contact" };
  assert.equal(mergeFormFlashIntoResult(success, { slug: "contact", values: { name: "Ada" } }), success, "non-validation kind: unchanged");
});

test("injectFormSubmissionResultIntoHtml: validation WITH flash values re-populates the untouched fields' <input>/<textarea>, escaped, instead of leaving them wiped", () => {
  const html = renderWidgetIr({
    componentId: "contact-form",
    props: {
      slug: "contact",
      fields: [
        { id: "name", label: "Name", type: "text", required: true },
        { id: "email", label: "Email", type: "email", required: true },
        { id: "message", label: "Message", type: "textarea", required: true },
      ],
      successMessage: null,
    },
  });
  const updated = injectFormSubmissionResultIntoHtml(html, {
    kind: "validation",
    slug: "contact",
    fieldErrors: [{ field: "message", reason: "Required" }],
    values: { name: "Ada <Lovelace>", email: "ada@example.com" },
  });
  // The two fields that were VALID (no error) must come back with what the visitor typed — this is
  // the actual bug: before the fix, a 303 PRG reload wiped these even though only "message" failed.
  assert.match(updated, /<input type="text" name="name" id="widget-contact-name"[^>]*aria-describedby="widget-contact-name-error"[^>]* value="Ada &lt;Lovelace&gt;"\/>/);
  assert.match(updated, /<input type="email" name="email" id="widget-contact-email"[^>]*aria-describedby="widget-contact-email-error"[^>]* value="ada@example\.com"\/>/);
  // The invalid field has no flash entry (only name/email were supplied above) — its own error slot
  // still gets its message, and its <textarea> is untouched (not forced empty, not crashed on).
  assert.match(updated, /<div class="widget-form-field-error" data-field="message"[^>]*>Required<\/div>/);
});

test("injectFormSubmissionResultIntoHtml: a flash value naming a field this page's form does not have is a silent no-op for that entry (stale/forged flash)", () => {
  const html = contactFormPageHtml(); // one field: "email"
  const updated = injectFormSubmissionResultIntoHtml(html, {
    kind: "validation",
    slug: "contact",
    fieldErrors: [],
    values: { "no-such-field": "whatever" },
  });
  assert.doesNotMatch(updated, /whatever/, "a value for a field the form doesn't have must never appear anywhere in the output");
  assert.doesNotMatch(updated, /value="/, "the form's own real field ('email') has no flash entry here, so it must stay unpopulated");
});

// ---------------------------------------------------------------------------
// showOneFieldValue (private, driven through injectFormSubmissionResultIntoHtml) — 2026-09-03 fix.
// `<input>` repopulation was a silent no-op for standard HTML5 markup (bug a: the old regex required
// an XHTML-style self-closing `/>`) and, separately, a no-op whenever the input already carried a
// `value="..."` attribute (bug b: the fix appended a SECOND `value=` rather than replacing the first —
// browsers only ever honor the first one). Hand-crafted raw HTML below (not `renderWidgetIr`, which
// only ever emits the XHTML-self-closed shape) so every input shape is exercised directly.
// ---------------------------------------------------------------------------

function rawFormPageHtml(fieldHtml: string, slug = "contact"): string {
  return `<form data-form-slug="${slug}">${fieldHtml}</form>`;
}

test("injectFormSubmissionResultIntoHtml: repopulates a standard HTML5 <input name=\"x\"> (no self-close, no existing value) — bug (a)", () => {
  const html = rawFormPageHtml(`<input type="text" name="x">`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "hello" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" value="hello">`));
});

test("injectFormSubmissionResultIntoHtml: repopulates <input name=\"x\" value=\"\"> by REPLACING the empty value, not appending a second value= — bug (b)", () => {
  const html = rawFormPageHtml(`<input type="text" name="x" value="">`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "hello" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" value="hello">`));
  assert.equal((updated.match(/\bvalue="/g) ?? []).length, 1, "exactly one value= attribute — never two");
});

test("injectFormSubmissionResultIntoHtml: repopulates a non-self-closing <input name=\"x\" value=\"old\"> by REPLACING the stale value — bug (b), non-XHTML shape", () => {
  const html = rawFormPageHtml(`<input type="text" name="x" value="old">`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "new" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" value="new">`));
  assert.equal((updated.match(/\bvalue="/g) ?? []).length, 1, "exactly one value= attribute — never two");
});

test("injectFormSubmissionResultIntoHtml: repopulates a self-closing XHTML <input name=\"x\" value=\"old\"/> by REPLACING the stale value, keeping the /> form — bug (b), existing path must not regress", () => {
  const html = rawFormPageHtml(`<input type="text" name="x" value="old"/>`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "new" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" value="new"/>`));
  assert.equal((updated.match(/\bvalue="/g) ?? []).length, 1, "exactly one value= attribute — never two");
});

test("injectFormSubmissionResultIntoHtml: self-closing XHTML <input name=\"x\"/> with no existing value still repopulates, keeping the /> form — existing path must not regress", () => {
  const html = rawFormPageHtml(`<input type="text" name="x"/>`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "hello" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" value="hello"/>`));
});

test("injectFormSubmissionResultIntoHtml: a raw <textarea name=\"x\"> still repopulates — existing path must not regress", () => {
  const html = rawFormPageHtml(`<textarea name="x"></textarea>`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "hello" } });
  assert.equal(updated, rawFormPageHtml(`<textarea name="x">hello</textarea>`));
});

test("injectFormSubmissionResultIntoHtml: a field name matching no input/textarea in the form is a byte-identical no-op", () => {
  const html = rawFormPageHtml(`<input type="text" name="x">`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { "no-such-field": "whatever" } });
  assert.equal(updated, html);
});

test("injectFormSubmissionResultIntoHtml: a custom data-default-value attribute survives untouched -- BUG (c), 2026-09-05 Gemini audit finding #5: setInputValueAttr's \\b-bounded regex matches mid-attribute-name (data-default-VALUE=\"...\" has a \\b right before \"value\" because \"-\" precedes it), so the theme author's own preset gets silently overwritten with the flash value instead of a real value= attribute being added", () => {
  const html = rawFormPageHtml(`<input type="text" name="x" data-default-value="preset">`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "hello" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" data-default-value="preset" value="hello">`));
});

test("injectFormSubmissionResultIntoHtml: a single-quoted value='old' attribute is REPLACED, not duplicated -- bug (d), 2026-09-05 Gemini audit finding #5: the regex only ever matched value=\"...\" (double quotes), so a theme's hand-authored value='...' input was invisible to the existing-attribute check and got a SECOND, double-quoted value= appended -- regressing the exact stale-value-wins bug already fixed once for double quotes, since browsers only honor the first same-named attribute", () => {
  const html = rawFormPageHtml(`<input type="text" name="x" value='old'>`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "new" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" value="new">`));
  assert.equal((updated.match(/\bvalue=/g) ?? []).length, 1, "exactly one value= attribute -- never two");
});

test("injectFormSubmissionResultIntoHtml: a double-quoted value=\"Don't know\" containing an apostrophe is REPLACED, not duplicated -- bug (e): the 2026-09-05 fix's own existing-attribute check, /(\\s)value=([\"'])[^\"']*\\2/i, excludes BOTH quote characters from the value body, so it cannot span an embedded apostrophe inside a double-quoted value and never matches at all here -- the code falls through to the append branch and adds a second value=, and the browser honors only the first (the stale \"Don't know\")", () => {
  const html = rawFormPageHtml(`<input type="text" name="x" value="Don't know">`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "hello" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" value="hello">`));
  assert.equal((updated.match(/\bvalue=/g) ?? []).length, 1, "exactly one value= attribute -- never two");
});

test("injectFormSubmissionResultIntoHtml: a single-quoted value='say \"hi\"' containing a double quote is REPLACED, not duplicated -- bug (e), sibling case with quotes swapped", () => {
  const html = rawFormPageHtml(`<input type="text" name="x" value='say "hi"'>`);
  const updated = injectFormSubmissionResultIntoHtml(html, { kind: "validation", slug: "contact", fieldErrors: [], values: { x: "hello" } });
  assert.equal(updated, rawFormPageHtml(`<input type="text" name="x" value="hello">`));
  assert.equal((updated.match(/\bvalue=/g) ?? []).length, 1, "exactly one value= attribute -- never two");
});

// ---------------------------------------------------------------------------
// SPEC-047 Slice 1/2 — "html"-format Page rendering, and `data-embed-type` embeds
// ---------------------------------------------------------------------------

function htmlPage(overrides: Partial<PostRecord> = {}): PostRecord {
  return fakePost({
    kind: "page",
    bodyFormat: "html",
    bodyHtml: "<p>hello</p>",
    ...overrides,
  });
}

function htmlEmbeds(byType: Readonly<Record<string, ReadonlyMap<string, WidgetRenderIR>>> = {}): ResolveHtmlPageEmbedsResult {
  return new Map(Object.entries(byType));
}

test("renderSite (Slice 1): an 'html'-format post's body_html renders raw through the live dispatch theme's post.content — its bodyJson is never walked", async () => {
  const theme = loadTheme({ themeDir: path.join(process.cwd(), "development", "fixtures", "theme-archive", "dispatch"), id: "dispatch", source: "built-in" });
  assert.equal(theme.status, "valid");

  const post = htmlPage({
    bodyHtml: '<section class="hero"><h1>Bespoke</h1></section>',
    bodyJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "SHOULD NOT APPEAR" }] }] },
  });
  const html = await renderSite({ theme, route: "post", siteTitle: "Dispatch Demo", posts: [post], post });

  assert.match(html, /<section class="hero"><h1>Bespoke<\/h1><\/section>/);
  assert.doesNotMatch(html, /SHOULD NOT APPEAR/);
});

test("renderSite (Slice 1, declarative tier): the 'content' slot renders an html Page's bodyHtml raw", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: "<p>Slice 1 via slot</p>" });

  const html = await renderSite({ theme, route: "post", siteTitle: "T", posts: [post], post });
  assert.match(html, /<div class="prose"><p>Slice 1 via slot<\/p><\/div>/);
});

test("renderSite (Slice 2): a data-embed-config type=\"widget\" embed substitutes to its resolved widget IR; an id with no matching entry in the resolved map degrades to the REQ-28 placeholder", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({
    bodyHtml:
      `<div data-embed-config='{"type":"widget","id":"widget-1"}'></div>` +
      `<div data-embed-config='{"type":"widget","id":"widget-missing"}'></div>`,
  });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      widget: new Map([["widget-1", { componentId: "text", props: { body: "Embedded!" } }]]),
    }),
  });

  assert.match(html, /widget-text">Embedded!/);
  assert.equal((html.match(/widget-placeholder/g) ?? []).length, 1, "only the unresolved id degrades to the placeholder");
});

test("renderSite (Slice 2): a contact-form WIDGET embed substitutes to its resolved contact-form IR — since `form` was removed as an embed type (2026-08-10) this is the ONE way a Page embeds a form, and it goes through the widget renderer unchanged", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"widget","id":"cf-widget-1"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      widget: new Map([
        ["cf-widget-1", { componentId: "contact-form", props: { slug: "contact-us", fields: [], successMessage: null } }],
      ]),
    }),
  });

  assert.match(html, /widget-contact-form/);
  assert.match(html, /action="\/forms\/contact-us\/submit"/);
});

test("renderSite (Slice 2): an html Page's embed placeholders degrade safely when pageHtmlEmbeds is omitted entirely — never leaks the raw data-embed-config markup", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"widget","id":"widget-1"}'></div>` });

  const html = await renderSite({ theme, route: "post", siteTitle: "T", posts: [post], post });

  assert.doesNotMatch(html, /data-embed-config/);
  assert.match(html, /widget-placeholder/);
});

test("renderSite (Slice 2): an unknown embed type degrades to the REQ-28 placeholder exactly like a known-type resolution failure — render.ts never distinguishes the two externally", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1"}'></div>` });

  const html = await renderSite({ theme, route: "post", siteTitle: "T", posts: [post], post, pageHtmlEmbeds: htmlEmbeds() });

  assert.doesNotMatch(html, /data-embed-config/);
  assert.match(html, /widget-placeholder/);
});

// ---------------------------------------------------------------------------
// SPEC-047 Slice 3 (2026-08-07) — "media-image" widget IR: the render side of a
// data-embed-config type="media" Page embed, resolved by resolver-service.ts's resolveMediaTypeEmbeds.
// ---------------------------------------------------------------------------

test("renderSite (Slice 2, media): a resolved data-embed-config type=\"media\" embed renders a real <img> through the same /m/ URL contract the TipTap ref-image case uses", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1","variant":"public"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      media: new Map([
        [
          "asset-1",
          { componentId: "media-image", props: { assetId: "asset-1", transformName: "public", version: 3, alt: "A photo", width: 640, height: 480, cssClass: "rounded" } },
        ],
      ]),
    }),
  });

  assert.match(html, /<img src="\/m\/asset-1\/public\.v3\/image\.jpg" alt="A photo" width="640" height="480" class="rounded" loading="lazy">/);
});

test("renderSite (Slice 2, media): a media-image IR carrying props.slug renders the /m/ URL keyed by the SLUG, not props.assetId (readable-slugs S3)", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1","variant":"public"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      media: new Map([
        [
          "asset-1",
          { componentId: "media-image", props: { assetId: "asset-1", slug: "fox", transformName: "public", version: 3, alt: "A photo", width: null, height: null, cssClass: null } },
        ],
      ]),
    }),
  });

  assert.match(html, /<img src="\/m\/fox\/public\.v3\/image\.jpg" alt="A photo" loading="lazy">/);
});

test("renderSite (Slice 2, media): a media-image VIDEO IR carrying props.slug renders the /original URL keyed by the SLUG too", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      media: new Map([
        [
          "asset-1",
          { componentId: "media-image", props: { assetId: "asset-1", slug: "fox", contentType: "video/mp4", alt: "A hero clip", width: null, height: null, cssClass: null } },
        ],
      ]),
    }),
  });

  assert.match(html, /<video src="\/m\/fox\/original" controls>A hero clip<\/video>/);
});

test("renderSite (Slice 2, media): width/height/class are each omitted independently when null, never a zeroed/empty attribute", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      media: new Map([
        ["asset-1", { componentId: "media-image", props: { assetId: "asset-1", transformName: "public", version: 1, alt: "", width: null, height: null, cssClass: null } }],
      ]),
    }),
  });

  const imgMatch = html.match(/<img[^>]*>/);
  assert.ok(imgMatch, "expected exactly one <img> tag in the rendered page");
  assert.equal(imgMatch![0], '<img src="/m/asset-1/public.v1/image.jpg" alt="" loading="lazy">', "no width/height/class attribute on the <img> itself — the page shell's own <meta viewport>/wrapper <div class> must not be mistaken for these");
});

test("renderSite (Slice 2, media): a malformed media-image IR (missing assetId — should never happen from this codebase's own resolver, defense-in-depth only) degrades to the ordinary widget placeholder rather than a malformed <img>", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      media: new Map([["asset-1", { componentId: "media-image", props: { transformName: "public", version: 1 } }]]),
    }),
  });

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /widget-placeholder/);
});

test("renderSite (Slice 2, media): a valid assetId with no resolvable transformName (non-video) degrades to the placeholder rather than a malformed <img> — the branch normalizeMediaDimensions's extraction left in renderWidgetMediaImage, not covered by the missing-assetId case above", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      // assetId is valid and present; transformName/version are absent and contentType is not "video/*"
      // — must still fall through to the placeholder, not throw or emit a malformed /m/ URL.
      media: new Map([["asset-1", { componentId: "media-image", props: { assetId: "asset-1", alt: "x" } }]]),
    }),
  });

  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<video/);
  assert.match(html, /widget-placeholder/);
});

// ---------------------------------------------------------------------------
// Video/embed capability (2026-08-24) — a "media" embed whose IR carries `contentType` starting
// with "video/" (resolver-service.ts's resolveMediaTypeEmbeds, when the asset is a recorded video)
// renders a real <video> instead of an <img>, pointed at the original-bytes route rather than the
// versioned transform URL.
// ---------------------------------------------------------------------------

test('renderSite (video/embed): a resolved media-image IR carrying contentType "video/mp4" renders a real <video> pointed at /m/{assetId}/original, not an <img>', async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      media: new Map([
        [
          "asset-1",
          { componentId: "media-image", props: { assetId: "asset-1", contentType: "video/mp4", alt: "A hero clip", width: 1920, height: 1080, cssClass: "hero-video" } },
        ],
      ]),
    }),
  });

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<video src="\/m\/asset-1\/original" controls width="1920" height="1080" class="hero-video">A hero clip<\/video>/);
});

test("renderSite (video/embed): htmlAttributes' boolean attributes (muted/loop/autoplay/playsinline) render on the <video> tag", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      media: new Map([
        [
          "asset-1",
          {
            componentId: "media-image",
            props: {
              assetId: "asset-1",
              contentType: "video/mp4",
              alt: "A hero clip",
              width: null,
              height: null,
              cssClass: null,
              htmlAttributes: "muted loop autoplay playsinline",
            },
          },
        ],
      ]),
    }),
  });

  assert.match(html, /<video src="\/m\/asset-1\/original" controls muted="" loop="" autoplay="" playsinline="">A hero clip<\/video>/);
});

test("renderSite (video/embed): width/height/class are each omitted independently when null, and an empty alt falls back to the no-support message, same conventions <img> already follows", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  theme.templates.entry = { type: "doc", content: [{ type: "slot", name: "content" }] };
  const post = htmlPage({ bodyHtml: `<div data-embed-config='{"type":"media","id":"asset-1"}'></div>` });

  const html = await renderSite({
    theme,
    route: "post",
    siteTitle: "T",
    posts: [post],
    post,
    pageHtmlEmbeds: htmlEmbeds({
      media: new Map([
        ["asset-1", { componentId: "media-image", props: { assetId: "asset-1", contentType: "video/webm", alt: "", width: null, height: null, cssClass: null } }],
      ]),
    }),
  });

  const videoMatch = html.match(/<video[^>]*>[^<]*<\/video>/);
  assert.ok(videoMatch, "expected exactly one <video> tag in the rendered page");
  assert.equal(videoMatch![0], '<video src="/m/asset-1/original" controls>Your browser does not support the video tag.</video>');
});

/**
 * Heading anchors (docs sidebar, 2026-08-10). A menu of `#anchor` links is inert unless the rendered
 * headings carry matching ids, and until now `renderDocNode` emitted a bare `<hN>` — so every
 * in-page anchor on the site pointed at nothing. Additive: an `id` changes no rendering, only what
 * a link can target.
 */

function headingDoc(...headings: Array<[string, number]>): JsonObject {
  return {
    type: "doc",
    content: headings.map(([text, level]) => ({
      type: "heading",
      attrs: { level },
      content: [{ type: "text", text }],
    })),
  };
}

test("renderDocNode: headings get a slugified id an in-page anchor can target", () => {
  const html = renderDocNode(headingDoc(["Getting Started", 2], ["What is a theme?", 3]));
  assert.ok(html.includes('<h2 id="getting-started">Getting Started</h2>'));
  assert.ok(html.includes('<h3 id="what-is-a-theme">What is a theme?</h3>'));
});

test("renderDocNode: the anchor slug matches post.ts's slugify dialect, not a second one", () => {
  // Same rule: lowercase, every non-alphanumeric run collapses to one dash, edges trimmed.
  const html = renderDocNode(headingDoc(["C++ & Rust — a Comparison!", 2]));
  assert.ok(html.includes('id="c-rust-a-comparison"'), html);
});

test("renderDocNode: repeated headings are suffixed within one document, first one unsuffixed", () => {
  const html = renderDocNode(headingDoc(["Overview", 2], ["Overview", 2], ["Overview", 3]));
  assert.ok(html.includes('<h2 id="overview">'));
  assert.ok(html.includes('<h2 id="overview-2">'));
  assert.ok(html.includes('<h3 id="overview-3">'));
});

test("renderDocNode: dedupe is per-document — two documents may each own the same anchor", () => {
  const a = renderDocNode(headingDoc(["Overview", 2]));
  const b = renderDocNode(headingDoc(["Overview", 2]));
  assert.equal(a, b, "a second post's #overview must not inherit the first post's suffix");
  assert.ok(a.includes('id="overview"'));
});

test("renderDocNode: a heading whose text slugifies to nothing gets no id, never id=\"\"", () => {
  const html = renderDocNode(headingDoc(["🎉", 2], ["...", 2]));
  assert.ok(!html.includes('id=""'));
  assert.ok(html.includes("<h2>🎉</h2>"));
});

test("renderDocNode: the slug comes from the heading's text, ignoring inline marks", () => {
  const html = renderDocNode({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [
          { type: "text", text: "Design ", marks: [{ type: "bold" }] },
          { type: "text", text: "tokens" },
        ],
      },
    ],
  });
  assert.ok(html.includes('<h2 id="design-tokens">'), html);
  assert.ok(html.includes("<strong>Design </strong>"), "the visible markup is untouched");
});

// ---------------------------------------------------------------------------
// TextAlign (@tiptap/extension-text-align, admin PostEditor.tsx Toolbar, 2026-08-11)
// ---------------------------------------------------------------------------

test("renderDocNode: a paragraph's textAlign attr renders as an inline style", () => {
  const html = renderDocNode({
    type: "doc",
    content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Hi" }] }],
  });
  assert.ok(html.includes('<p style="text-align:center">Hi</p>'), html);
});

test("renderDocNode: a heading's textAlign attr renders alongside its own id attribute, id first", () => {
  const html = renderDocNode({
    type: "doc",
    content: [{ type: "heading", attrs: { level: 2, textAlign: "right" }, content: [{ type: "text", text: "Overview" }] }],
  });
  assert.ok(html.includes('<h2 id="overview" style="text-align:right">Overview</h2>'), html);
});

test("renderDocNode: textAlign 'left' (the CSS default) never emits an explicit style attribute", () => {
  const html = renderDocNode({
    type: "doc",
    content: [{ type: "paragraph", attrs: { textAlign: "left" }, content: [{ type: "text", text: "Hi" }] }],
  });
  assert.equal(html, "<p>Hi</p>");
});

test("renderDocNode: no textAlign attr at all renders exactly as before this feature (regression)", () => {
  const html = renderDocNode({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] });
  assert.equal(html, "<p>Hi</p>");
});

// ---------------------------------------------------------------------------
// CSS injection via textAlign/ratio (architecture-p2-plan-2026-09-24 §D3) —
// `escapeHtml` alone stops attribute BREAKOUT, not a value that stays inside
// the `style="…"` quotes and smuggles a second declaration. `styleForAlign`
// and `mediaPlaceholder` now allowlist through `safeTextAlign`/`safeAspectRatio`
// (platform/html/style-values.ts) instead of escaping-and-emitting whatever a
// doc node's attrs carry.
// ---------------------------------------------------------------------------

test("renderDocNode: a textAlign value that smuggles a second CSS declaration emits no style attribute at all, not an escaped copy of the payload", () => {
  const centerPayload = renderDocNode({
    type: "doc",
    content: [{ type: "paragraph", attrs: { textAlign: "center;position:fixed" }, content: [{ type: "text", text: "Hi" }] }],
  });
  assert.equal(centerPayload, "<p>Hi</p>");
  assert.doesNotMatch(centerPayload, /position/);

  const leftPayload = renderDocNode({
    type: "doc",
    content: [{ type: "paragraph", attrs: { textAlign: "left;background:url(x)" }, content: [{ type: "text", text: "Hi" }] }],
  });
  assert.equal(leftPayload, "<p>Hi</p>");
  assert.doesNotMatch(leftPayload, /background/);
});

test("renderDocNode: a legitimate textAlign still renders its inline style (regression guard for the allowlist fix)", () => {
  const html = renderDocNode({
    type: "doc",
    content: [{ type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Hi" }] }],
  });
  assert.equal(html, '<p style="text-align:center">Hi</p>');
});

test("widget/declarative: media-placeholder's ratio prop is CSS-injection-safe — a payload that smuggles a second declaration falls back to the default 16/9 ratio, never emitting the payload", async () => {
  const theme = declarativeTheme({
    type: "doc",
    content: [{ type: "component", id: "tovu/media-placeholder", props: { label: "Photo", ratio: "1;background:url(//evil.example)" } }],
  });
  const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
  assert.match(html, /style="aspect-ratio:16 \/ 9"/);
  assert.doesNotMatch(html, /background/);
  assert.doesNotMatch(html, /evil\.example/);
});

test("widget/declarative: media-placeholder ratio — a ratio-shaped prefix followed by a smuggled declaration is rejected whole, not truncated to the valid prefix", async () => {
  const theme = declarativeTheme({
    type: "doc",
    content: [{ type: "component", id: "tovu/media-placeholder", props: { label: "Photo", ratio: "1/1;position:fixed" } }],
  });
  const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
  assert.match(html, /style="aspect-ratio:16 \/ 9"/);
  assert.doesNotMatch(html, /position/);
});

test("widget/declarative: media-placeholder — a legitimate ratio still renders unchanged (regression guard for the allowlist fix)", async () => {
  const theme = declarativeTheme({
    type: "doc",
    content: [{ type: "component", id: "tovu/media-placeholder", props: { label: "Photo", ratio: "4 / 3" } }],
  });
  const html = await renderSite({ theme, route: "home", siteTitle: "T", posts: [] });
  assert.match(html, /style="aspect-ratio:4 \/ 3"/);
});

// ---------------------------------------------------------------------------
// Post-title-in-document (apps/admin/src/lib/post-title-extension.ts, 2026-08-11)
// ---------------------------------------------------------------------------

test("renderDocNode: a 'title' node contributes nothing to a generic doc walk — every OTHER render path prints post.title separately, so this node rendering text too would duplicate it", () => {
  const html = renderDocNode({
    type: "doc",
    content: [
      { type: "title", content: [{ type: "text", text: "My Post" }] },
      { type: "paragraph", content: [{ type: "text", text: "Body." }] },
    ],
  });
  assert.equal(html, "<p>Body.</p>", "the title node's own text must not leak into the generic body render");
});

test("renderWidgetIr('post-content'): a body with NO title node falls back to props.title exactly as before this feature (back-compat for every pre-existing post)", () => {
  const html = renderWidgetIr({
    componentId: "post-content",
    props: { title: "Legacy Post", bodyJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body." }] }] } },
  });
  assert.ok(html.includes("<h1>Legacy Post</h1>"), html);
  assert.equal((html.match(/<h1/g) ?? []).length, 1, "exactly one <h1>, never two");
  assert.ok(html.includes("<p>Body.</p>"));
});

test("renderWidgetIr('post-content'): a body WITH a title node renders the node's own text/marks as the <h1>, not props.title", () => {
  const html = renderWidgetIr({
    componentId: "post-content",
    props: {
      // Deliberately a STALE props.title, proving the title node — not this field — drives the <h1>
      // once one is present (props.title still feeds the admin list/slug/search elsewhere; it just
      // isn't what renders here anymore).
      title: "Stale Title",
      bodyJson: {
        type: "doc",
        content: [
          { type: "title", content: [{ type: "text", text: "Fresh " }, { type: "text", text: "Title", marks: [{ type: "bold" }] }] },
          { type: "paragraph", content: [{ type: "text", text: "Body." }] },
        ],
      },
    },
  });
  assert.ok(html.includes("<h1>Fresh <strong>Title</strong></h1>"), html);
  assert.ok(!html.includes("Stale Title"));
  assert.equal((html.match(/<h1/g) ?? []).length, 1, "exactly one <h1>, never two");
});

test("renderWidgetIr('post-content'): the title node's textAlign attr renders on the <h1> — centering it in the editor must center it here", () => {
  const html = renderWidgetIr({
    componentId: "post-content",
    props: {
      title: "Ignored",
      bodyJson: {
        type: "doc",
        content: [
          { type: "title", attrs: { textAlign: "center" }, content: [{ type: "text", text: "Centered" }] },
          { type: "paragraph", content: [{ type: "text", text: "Body." }] },
        ],
      },
    },
  });
  assert.ok(html.includes('<h1 style="text-align:center">Centered</h1>'), html);
});

test("renderWidgetIr('post-content'): an empty title node (freshly synthesized, not yet typed into) renders a real but empty <h1>, never the placeholder or a crash", () => {
  const html = renderWidgetIr({
    componentId: "post-content",
    props: {
      title: "",
      bodyJson: { type: "doc", content: [{ type: "title", content: [] }, { type: "paragraph", content: [{ type: "text", text: "Body." }] }] },
    },
  });
  assert.ok(html.includes("<h1></h1>"), html);
  assert.ok(!html.includes("widget-placeholder"));
});

// ---------------------------------------------------------------------------
// `header` opt-out (2026-09-04) — a "content" marker's `header:false` (threaded here via
// `resolver-service.ts`'s `resolveContentTypeEmbeds`, `props.header`) lets a template suppress the
// `.post-detail-header` (<h1> + date byline) wrapper this function previously emitted
// unconditionally. No-silent-behavior-change requirement: `props.header` absent renders
// BYTE-IDENTICAL to the pre-existing output (every current template — about, docs, the listing
// page, every kind:"post" detail page — omits this key and must keep its byline with zero edits).
// ---------------------------------------------------------------------------

const POST_CONTENT_BASE_PROPS = {
  title: "Legacy Post",
  bodyJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Body." }] }] },
};

test("renderWidgetIr('post-content'): props.header ABSENT renders byte-identical to the pre-header-field output — the no-silent-behavior-change default", () => {
  const html = renderWidgetIr({ componentId: "post-content", props: POST_CONTENT_BASE_PROPS });
  assert.equal(html, `<div class="post-detail-header"><h1>Legacy Post</h1></div><div class="post-detail-body"><p>Body.</p></div>`);
});

test("renderWidgetIr('post-content'): props.header: true renders identically to header being absent", () => {
  const html = renderWidgetIr({ componentId: "post-content", props: { ...POST_CONTENT_BASE_PROPS, header: true } });
  assert.equal(html, `<div class="post-detail-header"><h1>Legacy Post</h1></div><div class="post-detail-body"><p>Body.</p></div>`);
});

test("renderWidgetIr('post-content'): props.header: false emits NO .post-detail-header node at all — the .post-detail-body is unchanged", () => {
  const html = renderWidgetIr({ componentId: "post-content", props: { ...POST_CONTENT_BASE_PROPS, header: false } });
  assert.equal(html, `<div class="post-detail-body"><p>Body.</p></div>`);
  assert.ok(!html.includes("post-detail-header"));
  assert.ok(!html.includes("<h1"));
});

test("renderWidgetIr('post-content'): props.header: false also suppresses the date byline (post-meta), not just the <h1> — the whole header block is one unit", () => {
  const html = renderWidgetIr({
    componentId: "post-content",
    props: { ...POST_CONTENT_BASE_PROPS, updatedAt: "2026-08-11T00:00:00.000Z", header: false },
  });
  assert.equal(html, `<div class="post-detail-body"><p>Body.</p></div>`);
  assert.ok(!html.includes("post-meta"));
});

/** A `depth`-deep chain of nested `bulletList > listItem`, bottoming out in one paragraph — the
 *  shape genuine repeated list-indentation produces, not an artificial malformed doc. Matches
 *  `request-cost-traversal.measurement.test.ts`'s own `deepDoc` helper (that file is measurement-
 *  only; this one is the permanent regression). */
function deepBulletChain(depth: number): JsonObject {
  let node: JsonObject = { type: "paragraph", content: [{ type: "text", text: "leaf" }] };
  for (let i = 0; i < depth; i++) {
    node = { type: "bulletList", content: [{ type: "listItem", content: [node] }] };
  }
  return { type: "doc", content: [node] };
}

test("renderDocNode: worklist #5 regression — a document nested past MAX_RENDER_DEPTH renders a placeholder instead of crashing the whole render", () => {
  // Below the bound: renders in full, no placeholder at all — the bound must not clip ordinary
  // (if unusually deep) legitimate content.
  const shallow = renderDocNode(deepBulletChain(50));
  assert.ok(shallow.includes("leaf"), "content within the bound must render exactly as authored");
  assert.ok(!shallow.includes("content-ph"), "content within the bound must not show any placeholder");

  // At/above the bound: the RangeError this worklist item exists for (measured directly in
  // `request-cost-traversal.measurement.test.ts`: real crash between depth 500 and depth 1000,
  // binary-searched to exactly depth 500 ok / depth 501 crashing) must now degrade to a placeholder
  // instead of throwing. `deepBulletChain(600)` is comfortably past both the crash boundary this
  // fix guards against AND `MAX_RENDER_DEPTH` itself, so this is testing the ACTUAL fix, not a value
  // that happens to sit below both.
  const tooDeep = renderDocNode(deepBulletChain(600));
  assert.ok(tooDeep.includes("content-ph"), "an over-deep document must degrade to the placeholder, not crash");
  assert.ok(!tooDeep.includes("leaf"), "content past the bound must not appear — it was never reached, not truncated mid-render");
});

test("renderDocNode: worklist #5 regression — content above the bound still renders in full; only the over-deep branch degrades", () => {
  // Two siblings under the doc root: one shallow (renders fully), one past the bound (placeholder).
  // Proves the bound is per-branch, not "the whole page degrades because ONE part is too deep."
  const doc: JsonObject = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "this paragraph is fine" }] },
      deepBulletChain(600).content![0] as JsonObject,
    ],
  };
  const html = renderDocNode(doc);
  assert.ok(html.includes("this paragraph is fine"), "sibling content above the bound must render normally");
  assert.ok(html.includes("content-ph"), "the over-deep sibling must degrade to the placeholder");
});

// ---------------------------------------------------------------------------
// 2026-08-12 (Commerce catalog wiring) — `fallbackBody()`'s "products"/"product" branch bug.
//
// `fallbackBody()` existed before `route: "products" | "product"` had any real data source (both
// were added to `SiteRenderContext.route`'s union for the sample store plugin, but the fallback
// body itself was written only against `"post"` and never extended): its ternary routed EVERY
// non-post/non-product route, including `"products"`, to `entryList(ctx, {})`, which reads only
// `ctx.posts` — never `ctx.products`. `"product"` fared no better: it shared `"post"`'s branch,
// `entryContent(ctx)`, which reads only `ctx.post` — never `ctx.product`. A theme with no dedicated
// `products`/`product` template (the seeded default active theme, `"basic"`, among them — see
// `server/seed.ts`) therefore rendered an EMPTY entry list for `/products` and an empty `<article>`
// for `/products/:id`, regardless of how many real products a caller passed in. This is the exact
// path `routes/site/products.ts`'s new Commerce wiring renders through for any workspace whose
// active theme lacks bespoke product templates — silently invisible, never a crash, so nothing
// short of asserting on product content in the output would have caught it.
// ---------------------------------------------------------------------------

function sampleSiteProduct(overrides: Partial<SiteProduct> = {}): SiteProduct {
  return { id: "prod-1", slug: "classic-boxy-tee", title: "Classic Boxy Tee", price: 3500, ...overrides };
}

test("renderSite (products route, no theme template): the fallback body lists real products, not an empty post list (regression)", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  const html = await renderSite({
    theme,
    route: "products",
    siteTitle: "Fallback Demo",
    posts: [],
    products: [sampleSiteProduct(), sampleSiteProduct({ id: "prod-2", title: "Linen Shirt", price: 4200 })],
  });
  assert.match(html, /Classic Boxy Tee/);
  assert.match(html, /Linen Shirt/);
  assert.doesNotMatch(html, /No published posts yet/, "must not fall through to the post-list empty state");
});

test("renderSite (products route, no theme template): an empty product list shows a real empty state, not a silently blank one", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  const html = await renderSite({ theme, route: "products", siteTitle: "Fallback Demo", posts: [], products: [] });
  assert.match(html, /No products available yet/);
});

// readable-slugs S7 (2026-09-23): the product grid links by slug, not the raw id — same rule
// posts/pages/menus already follow.
test("renderSite (products route, no theme template): the grid links each product by its slug, not its id", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  const html = await renderSite({
    theme,
    route: "products",
    siteTitle: "Fallback Demo",
    posts: [],
    products: [sampleSiteProduct({ id: "prod-1", slug: "classic-boxy-tee" })],
  });
  assert.match(html, /href="\/products\/classic-boxy-tee"/);
  assert.doesNotMatch(html, /href="\/products\/prod-1"/);
});

test("renderSite (product route, no theme template): the fallback body shows the single product's own title, not an empty article (regression)", async () => {
  const theme = declarativeTheme({ type: "doc", content: [] });
  const html = await renderSite({
    theme,
    route: "product",
    siteTitle: "Fallback Demo",
    posts: [],
    products: [sampleSiteProduct()],
    product: sampleSiteProduct(),
  });
  assert.match(html, /Classic Boxy Tee/);
});

// `page-shell.html`'s head opens with an explanatory comment whose prose mentions `<title>` — the
// SEO splice used to strip the theme's own title with an unanchored `/<title>[\s\S]*?<\/title>/`,
// which matched THAT mention and deleted everything through the real title, taking the comment's
// own `-->` with it. Every downstream head element then parsed as comment text, so `/contact`,
// `/team`, `/faq` and `/terms-of-service` shipped with no stylesheet at all.
const HEAD_COMMENT_MENTIONING_TITLE = [
  "<!doctype html>",
  '<html lang="en"><head>',
  "<meta charset=\"utf-8\" />",
  "<!-- the tag directly below carries a <title> placeholder the renderer substitutes -->",
  "<title>Theme Title</title>",
  '<link rel="stylesheet" href="/theme-assets/basic/css/theme.css" />',
  "</head><body><h1>Get in touch</h1></body></html>",
].join("\n");

const SEO_HEAD = '<title>Contact</title><link rel="canonical" href="/contact"/>';

test("injectExtraHeadIntoStaticPage: a <title> mentioned inside a head comment does not swallow the rest of the head (regression)", () => {
  const out = injectExtraHeadIntoStaticPage(HEAD_COMMENT_MENTIONING_TITLE, SEO_HEAD);

  assert.equal((out.match(/-->/g) ?? []).length, 1, "the head comment must still be terminated");
  assert.ok(
    out.indexOf("-->") < out.indexOf('rel="stylesheet"'),
    "the theme stylesheet must sit outside the comment, not be commented out by it"
  );
});

test("injectExtraHeadIntoStaticPage: the theme's own title is still the one removed, not the comment's mention", () => {
  const out = injectExtraHeadIntoStaticPage(HEAD_COMMENT_MENTIONING_TITLE, SEO_HEAD);

  const afterComment = out.slice(out.indexOf("-->") + "-->".length);
  assert.equal((afterComment.match(/<title>/g) ?? []).length, 1, "exactly one real <title> element ships");
  assert.ok(out.includes("<title>Contact</title>"), "the SEO fold's title wins");
  assert.ok(!out.includes("<title>Theme Title</title>"), "the theme's own title is suppressed");
  assert.ok(out.includes("a <title> placeholder"), "the comment's prose is left alone");
});

test("injectExtraHeadIntoStaticPage: extraHead without a title leaves the theme's own title in place", () => {
  const out = injectExtraHeadIntoStaticPage(HEAD_COMMENT_MENTIONING_TITLE, '<link rel="canonical" href="/contact"/>');

  assert.ok(out.includes("<title>Theme Title</title>"), "nothing to suppress it, so it stays");
  assert.equal((out.match(/-->/g) ?? []).length, 1, "and the comment is untouched");
});

// ---------------------------------------------------------------------------
// renderHtmlPageBody: lookup-key widening for `slug` (2026-08-31). `resolved` is a plain
// type -> key -> IR map here (not built via a real resolver), matching how `resolveHtmlPageEmbeds`
// itself keys a slug-based ref's result — by the SLUG the marker carried, never by the id that slug
// happened to resolve to. See `resolveWidgetTypeEmbeds`'s own doc for why.
// ---------------------------------------------------------------------------

const TEXT_WIDGET_IR: WidgetRenderIR = { componentId: "text", props: { body: "hi" } };

function resolvedMap(type: string, key: string, ir: WidgetRenderIR): ResolveHtmlPageEmbedsResult {
  return new Map([[type, new Map([[key, ir]])]]);
}

test("renderHtmlPageBody: an id-carrying widget marker still resolves by id (UUID markers keep working unchanged)", () => {
  const html = `<div data-embed-config='{"type":"widget","id":"w1"}'></div>`;
  const out = renderHtmlPageBody(html, resolvedMap("widget", "w1", TEXT_WIDGET_IR));
  assert.equal(out, renderWidgetIr(TEXT_WIDGET_IR));
});

test("renderHtmlPageBody: a slug-only widget marker (no id key at all) resolves via the slug-keyed entry in the resolved map", () => {
  const html = `<div data-embed-config='{"type":"widget","slug":"contact-form"}'></div>`;
  const out = renderHtmlPageBody(html, resolvedMap("widget", "contact-form", TEXT_WIDGET_IR));
  assert.equal(out, renderWidgetIr(TEXT_WIDGET_IR));
});

test("renderHtmlPageBody: a marker carrying BOTH id and slug looks up by id — slug is never consulted once id is present", () => {
  const html = `<div data-embed-config='{"type":"widget","id":"w1","slug":"stale-slug"}'></div>`;
  // Only the id-keyed entry is populated; if this function fell back to slug it would find nothing
  // and render the placeholder instead of TEXT_WIDGET_IR.
  const out = renderHtmlPageBody(html, resolvedMap("widget", "w1", TEXT_WIDGET_IR));
  assert.equal(out, renderWidgetIr(TEXT_WIDGET_IR));
});

test("renderHtmlPageBody: an unresolvable slug (typo, no matching entry) degrades to the REQ-28 placeholder — never a crash, never raw marker markup", () => {
  const html = `<div data-embed-config='{"type":"widget","slug":"does-not-exist"}'></div>`;
  const out = renderHtmlPageBody(html, new Map([["widget", new Map()]]));
  assert.equal(out, renderWidgetIr({ componentId: "widget-placeholder", props: {} }));
});

// ---------------------------------------------------------------------------
// renderHtmlPageBody: D4 guard (2026-09-23) — a "content"/"post" marker naming NEITHER an id nor a
// slug is left exactly as authored, instead of degrading to the REQ-28 placeholder. Needed for the
// static theme's own `index.html`, whose `{"type":"content","header":false}` marker names no id —
// D2's `finishStaticTierDocument` runs this stage over assembled HTML, and without this guard that
// marker would be replaced by an empty placeholder div on every render.
// ---------------------------------------------------------------------------

test('renderHtmlPageBody: an id-less, slug-less "content" marker is left exactly as written, not replaced by the placeholder', () => {
  const html = `<div data-embed-config='{"type":"content","header":false}'>keep</div>`;
  const out = renderHtmlPageBody(html, undefined);
  assert.equal(out, html);
});

test('renderHtmlPageBody: an id-less, slug-less "post" marker is left exactly as written, not replaced by the placeholder', () => {
  const html = `<div data-embed-config='{"type":"post"}'>keep</div>`;
  const out = renderHtmlPageBody(html, undefined);
  assert.equal(out, html);
});

test('renderHtmlPageBody: an id-carrying "content" marker still resolves normally — the D4 guard is id-less AND slug-less only', () => {
  const html = `<div data-embed-config='{"type":"content","id":"c1"}'></div>`;
  const out = renderHtmlPageBody(html, resolvedMap("content", "c1", TEXT_WIDGET_IR));
  // "content" always keeps its wrapper element (WRAPPER_PRESERVING_EMBED_TYPES), unlike the
  // keep-if-attributed "widget" rule the tests above this section exercise.
  assert.equal(out, `<div>${renderWidgetIr(TEXT_WIDGET_IR)}</div>`);
});

test('renderHtmlPageBody: an unresolvable id-less "content" marker still degrades to the placeholder when it DOES carry a slug', () => {
  const html = `<div data-embed-config='{"type":"content","slug":"does-not-exist"}'></div>`;
  const out = renderHtmlPageBody(html, new Map([["content", new Map()]]));
  // "content" always keeps its wrapper element, same as the id-carrying case above.
  assert.equal(out, `<div>${renderWidgetIr({ componentId: "widget-placeholder", props: {} })}</div>`);
});

// ---------------------------------------------------------------------------
// htmlAttributes attribute-NAME injection (2026-09-07 audit, claim #1).
// `formatHtmlAttributes` interpolates the attribute NAME raw — only the value is escaped — and the
// allowlist accepted ANY name starting with `data-`/`aria-`, while the tokenizer's name class
// (`[^\s="']+`) permits `<`, `>` and `/`. A stored `data-x><svg/onload=alert(1)` therefore closed
// the `<img>` and opened a live `<svg onload>` on the public page: stored XSS.
// ---------------------------------------------------------------------------

test("renderDocNode: an htmlAttributes name carrying '>' cannot break out of the <img> tag and open a live element (stored XSS)", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  const html = renderDocNode(
    doc,
    undefined,
    new Map([["public", 3]]),
    new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: "data-x><svg/onload=alert(1)" }]])
  );
  assert.doesNotMatch(html, /<svg/i, "an attribute name must never be able to terminate the tag and start a new element");
  assert.doesNotMatch(html, /onload/i, "no event handler may reach the emitted markup");
  assert.equal(html, '<img src="/m/asset-1/public.v3/image.jpg" alt="x" loading="lazy">');
});

test("renderDocNode: an htmlAttributes name outside the [a-z][a-z0-9-]* shape is rejected wholesale, not emitted raw", () => {
  const doc: JsonObject = {
    type: "doc",
    content: [{ type: "image", attrs: { assetId: "asset-1", transformName: "public", alt: "x" } }],
  };
  for (const payload of ['data-a/onerror="alert(1)"', 'aria-x<img', 'data-"x"="y"', "data-x`y=1"]) {
    const html = renderDocNode(
      doc,
      undefined,
      new Map([["public", 3]]),
      new Map([["asset-1", { width: null, height: null, cssClass: null, htmlAttributes: payload }]])
    );
    assert.equal(
      html,
      '<img src="/m/asset-1/public.v3/image.jpg" alt="x" loading="lazy">',
      `payload ${JSON.stringify(payload)} must fail closed`
    );
  }
});
