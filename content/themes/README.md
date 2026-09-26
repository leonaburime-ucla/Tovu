# `src/themes/`

Built-in themes, discovered once at server boot from this directory (`builtInThemesDir()`, `src/server/deps.ts`). The themes guide (layout, creating a theme, every `data-embed-config` marker, styling, common mistakes) lives at **`development/docs/themes/themes-guide.md`**. Read that before building or editing a theme; this file is just an orientation map.

## Layout

Each theme lives one folder deep under one of four tier subfolders (a fifth, `code`, is a declared type value with no implementation — do not build against it):

```
static/<id>/        complete HTML/CSS/JS pages, no templating language — 7 themes, everything live today
declarative/<id>/    JSON block trees, no executable code — 1 theme, reference-only
templated/<id>/      LiquidJS templates, sandboxed — 1 theme
handlebars/<id>/     Handlebars templates, sandboxed — directory exists, currently empty (the render
                     pipeline, security allowlist, and worker isolation are fully implemented and
                     tested; no one has authored a theme here yet)
```

`<id>` must match the folder name (`theme.json`'s `id` field is validated against it).

## Before you write a `theme.json` field and expect it to do something

Not every field in an existing theme's `theme.json` is read by the loader. `pages` is written by every static theme but consumed by nothing in `src/` (page discovery reads the real files under `pages/`, not this declared list) — see the guide's §3 for the verified field-by-field breakdown of what's actually functional vs. documentary-only. `modes`, `defaultMode`, and `slots` **are** read: `defaultMode` sets the page's initial `data-theme`, `modes` is validated against it at load time, and `slots` drives nav/footer partial resolution.

## Nested menus are opt-in, not automatic — and not every theme embeds the CMS menu

Static-theme navs render only top-level menu items by default (`static-render.ts`'s `renderMenuLinks`). A menu marker can opt into nested rendering instead via `{"variant":"tree"}` in its `data-embed-config` (`renderMenuTree`, since `77f567d`) — tovu-theme's docs sidebar is the one theme using it today, and its CSS already ships the `.menu-list.depth-N` styles the tree needs; a theme opting in without shipping equivalent styles gets unstyled nesting. And not every static theme wires a `type:"menu"` marker into its nav — one currently hardcodes its links instead, so CMS menu edits don't reach it. See the guide's §6.3/§8 for exactly which theme and why.

See `development/docs/themes/themes-guide.md` for everything else, including creating a new static theme step by step.
