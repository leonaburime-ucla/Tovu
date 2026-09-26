import { DataTable, RowMenu, ConfirmDialog } from "@jini-ai/admin/react";
import type { DataTableSortState } from "@jini-ai/admin/core";
import { agentHandle } from "@jini-ai/agentic";
import { useState, type ReactNode } from "react";

import type { AdminPost } from "../../lib/api";
import type { Translate } from "../../lib/dictionary-translator";
import { siteUrl } from "../../lib/site-url";
import { formatTimestamp } from "../../lib/format-timestamp";
import { adminHref, navigate } from "../../lib/router";
import { TabBar } from "../../components/TabBar";
import { ServerLabel } from "@/components/status-labels";
import { PublishSectionButton } from "../publish-content/PublishSectionButton";
import {
  pageRowMenuItems,
  pagePublicPath,
  pageAdminPath,
  comparePagesByTitle,
  comparePagesBySlug,
  comparePagesByStatus,
  comparePagesByUpdated,
  pageColumnSortLabel,
  updatedPageColumnSortLabel,
  DEFAULT_PAGE_SORT,
} from "./rules";
import { useWiredPages } from "./hooks/use-pages.hooks";
import { useWiredThemePages } from "./hooks/use-theme-pages.hooks";
import { resolvePagesTabFromUrl, writePagesTabToUrl, type PagesTabId } from "./hooks/pages-tab-url.hooks";
import { ThemePagesTab } from "./ThemePagesTab";

/**
 * @file The Pages list screen — markup only.
 *
 * State and API calls live in `hooks/use-pages.hooks.ts` (My Pages) and `hooks/use-theme-
 * pages.hooks.ts` (Theme Pages); the row-menu logic lives in `rules.ts`. What stays here is what
 * actually renders: column definitions, the empty state, and the confirm copy. The "My Pages" side
 * mirrors `features/posts/Posts.tsx` exactly, since this screen is `Posts.tsx`'s twin, backed by
 * the pages-filtered endpoints (`GET/POST .../pages`). A page is a `post` row with `kind: "page"`
 * (see `features/post/post.ts`), so it's edited through the same `PostEditor` reached via
 * `/admin/posts/{id}`.
 *
 * "Theme Pages" (2026-08-10) is a second, deliberately separate tab: the ACTIVE theme's own bundled
 * `pages/*.html` (`static` tier only — see `getPresentation()`'s `activeThemeStaticPageIds`), not
 * database rows. Kept visually and structurally apart from "My Pages" on purpose — the
 * `templateChoice`/`overridesThemePage` work elsewhere this session exists specifically so theme
 * content and an operator's own authored content read as two different things that survive a theme
 * switch independently, and merging them into one list here would blur exactly that distinction.
 * A theme page has no `PostRecord` behind it (no id, no draft/published status to speak of as a
 * database row) — its row offers a publish switch and a "see more" disclosure, not a `RowMenu`. The
 * row's own link goes to the THEME STUDIO (`/admin/themes/explore?theme=&page=`), not the live
 * site. The whole tab body — that link, the publish switch, the disclosure — now lives in its own
 * file, `ThemePagesTab.tsx` (2026-08-30, deep-link/publish-toggle pass), split out once it grew
 * past a bare read-only row link; see that file's own header.
 *
 * The active tab itself is now addressable: `?tab=themes` opens directly on Theme Pages
 * (`hooks/pages-tab-url.hooks.ts`), the same deep-link contract Theme Studio's Explore screen
 * already has for `?theme=`/`?page=`/`?file=`.
 */
export interface PagesProps {
  /**
   * Dependency injection seam for tests — the same convention `@jini-ai/ui`'s `CustomSelect` uses
   * for `useCustomSelect`, and `features/posts/Posts.tsx`'s `usePostsHook`.
   *
   * Defaulted to the real hook, so production callers (`panels.tsx`) pass nothing and behave
   * exactly as before. A test supplies a stub and drives this component through any state —
   * mid-delete, load failure, empty list — without module mocking, a fake `fetch`, or waiting on a
   * real request. That matters here specifically: this screen has no unit test today.
   */
  usePagesHook?: typeof useWiredPages;
  /** Same DI seam as `usePagesHook`, for the Theme Pages tab's own data source. */
  useThemePagesHook?: typeof useWiredThemePages;
}

/**
 * Resolves `Pages`'s two injectable-seam props to their real implementations when a caller passes
 * none — same `??`-avoidance idiom `MenuEditor.tsx`'s `orEmpty`/`AssistantDock.tsx`'s/`App.tsx`'s
 * resolver groups use (2026-08-14, DI migration sweep's complexity follow-up): ESLint's
 * cyclomatic-complexity rule counts a default parameter value inside a function's OWN body as one
 * of that function's own branches — a call out to a separately-scoped resolver does not. Only
 * these two data-fetching seams are touched; `Pages`'s local `activeTab` chrome state (owner
 * ruling, see that declaration's own comment) is untouched by this pass.
 */
function resolvePagesHook(override: typeof useWiredPages | undefined): typeof useWiredPages {
  return override ?? useWiredPages;
}
function resolveThemePagesHook(override: typeof useWiredThemePages | undefined): typeof useWiredThemePages {
  return override ?? useWiredThemePages;
}

/**
 * The loading/error guard shown before the table has anything to render — pulled out of `Pages`
 * (2026-08-06, complexity pass, fourth pass) so its two early-return checks collapse into one
 * `if` at the call site. `error && !pages` (not just `error`), matching Media.tsx/Comments.tsx:
 * once the list has loaded, a later failure (create, delete) surfaces as an inline banner above
 * the table instead of blanking out the whole screen behind it. Mirrors `Posts.tsx`'s identical
 * `postsListNotice`, matching this pair's existing "twin screens" convention (this file's own
 * header).
 */
export function pagesListNotice(pages: AdminPost[] | null, error: string | null, t: Translate): ReactNode {
  if (error && !pages) return <div className="notice error">{error}</div>;
  if (!pages) return <div className="notice">{t("Loading pages…")}</div>;
  return null;
}

export function Pages(props: PagesProps) {
  const usePagesHook = resolvePagesHook(props.usePagesHook);
  const useThemePagesHook = resolveThemePagesHook(props.useThemePagesHook);
  const {
    pages,
    error,
    creating,
    rowSavingId,
    pendingDelete,
    setPendingDelete,
    createPage,
    togglePagePublish,
    removePage,
    t,
    locale,
    rowMenuHandleById,
  } = usePagesHook();
  const {
    pages: themePages,
    pageCount: themePagesCount,
    activeThemeId: themeId,
    error: themePagesError,
    savingPageId: themePageSavingId,
    setPagePublished: setThemePagePublished,
  } = useThemePagesHook();
  // Owner ruling (2026-08-14): pure interactive DOM-chrome state — which tab is showing, no I/O
  // behind it — stays LOCAL rather than moving into `use-pages.hooks.ts`, unlike every other piece
  // of state on this screen. The line to draw: async/API/data state always moves into the hook;
  // view-only chrome (active tab, expanded/collapsed, dialog open, sort direction) stays here
  // UNLESS a test needs to observe it — see `Posts.tsx`'s identical `sort` state, the canonical
  // example this mirrors. Initialized from `?tab=` (`resolvePagesTabFromUrl`) rather than a fixed
  // `"mine"`, so a deep link opens directly on the right tab; read once, matching `useState`'s own
  // lazy-initializer contract — this must NOT re-resolve on every render, or a later in-page
  // `writePagesTabToUrl` call would immediately fight with it.
  const [activeTab, setActiveTab] = useState<PagesTabId>(() => resolvePagesTabFromUrl());
  // Same "My Pages" sort state as `Posts.tsx`'s `sort` (2026-09-02, multi-column sort pass; migrated
  // onto `DataTable`'s own shared sort mechanism the same day) — one active column at a time, local
  // chrome state per the same owner ruling above, passed straight through as `sort`/`onSortChange`.
  const [sort, setSort] = useState<DataTableSortState>(DEFAULT_PAGE_SORT);

  function selectTab(id: PagesTabId) {
    setActiveTab(id);
    writePagesTabToUrl(id);
  }

  const notice = pagesListNotice(pages, error, t);
  if (notice) return notice;
  // Unreachable in practice — `pagesListNotice` already returns a non-null notice whenever `pages`
  // is null — but restores the narrowing TS lost by moving that check behind a function call, so
  // `rows={pages}` below type-checks as `AdminPost[]` without an `as`/`!` assertion.
  if (!pages) return null;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-text">
          <p className="page-kicker">{t("Content")}</p>
          <h1 className="page-title">{t("Pages")}</h1>
          <p className="page-description">{t("Manage every standalone page on this site.")}</p>
        </div>
        <div className="page-actions">
          <PublishSectionButton section="pages" />
          {activeTab === "mine" ? (
            <button
              onClick={createPage}
              disabled={creating}
              {...agentHandle("pages-new", { role: "button", label: "Create a new page" })}
            >
              {creating ? t("Creating…") : t("New Page")}
            </button>
          ) : null}
        </div>
      </div>
      <TabBar
        ariaLabel={t("Pages")}
        tabs={[
          { id: "mine", label: t("My Pages"), count: pages.length, handle: "pages-tab-mine", handleLabel: "Switch to My Pages" },
          { id: "theme", label: t("Theme Pages"), count: themePagesCount, handle: "pages-tab-theme", handleLabel: "Switch to Theme Pages" },
        ]}
        activeId={activeTab}
        onChange={(id) => selectTab(id as PagesTabId)}
        containerHandle="pages-tab-bar"
      />
      {activeTab === "mine" ? (
        <>
          {error ? <div className="notice error">{error}</div> : null}
          <DataTable
            rows={pages}
            rowKey={(page) => page.id}
            sort={sort}
            onSortChange={setSort}
            empty={
              <div className="card">
                <div className="empty-state">
                  <p>{t("No pages yet.")}</p>
                  <p className="page-description">{t("Create your first page to get started.")}</p>
                </div>
              </div>
            }
            columns={[
              {
                key: "title",
                header: t("Title"),
                // Sortable headers (2026-09-02, ported from `Posts.tsx`'s identical block; migrated
                // onto `DataTable`'s own shared sort mechanism the same day) — `DataTable` now
                // renders the button, caret, and `aria-sort` itself from this descriptor; only the
                // domain-specific comparator and label wording stay here (`rules.ts`).
                sort: { compare: comparePagesByTitle, label: (direction) => pageColumnSortLabel(t, t("Title"), direction) },
                // The admin editor route (`panels.tsx`'s `/:slug` pattern) is one path segment, so a
                // Page holding the root slug `"/"` (`pagePublicPath`'s own doc) can't be expressed in
                // slug form at all — `pageAdminPath` (`rules.ts`) picks slug-vs-id per page so this
                // link reads as a slug for every ordinary page and falls back to the id only for that
                // one. `adminHref` (`lib/router.ts`) turns the bare route path into a real `<a href>`.
                cell: (page) => (
                  <a
                    href={adminHref(pageAdminPath(page))}
                    {...agentHandle(`${rowMenuHandleById.get(page.id)}-edit`, { role: "link", label: "Open this page's editor" })}
                  >
                    {page.title}
                  </a>
                ),
              },
              {
                key: "slug",
                header: "Slug",
                sort: { compare: comparePagesBySlug, label: (direction) => pageColumnSortLabel(t, t("Slug"), direction) },
                // The public site link and its visible text both go through `pagePublicPath` so the
                // root-slug page reads "/" — a bare `/${page.slug}` template would render "//" and
                // link nowhere real for that one page.
                cell: (page) => (
                  <a
                    href={siteUrl(pagePublicPath(page.slug))}
                    target="_blank"
                    rel="noreferrer"
                    {...agentHandle(`${rowMenuHandleById.get(page.id)}-view-live`, { role: "link", label: "Open this page on the live public site" })}
                  >
                    {pagePublicPath(page.slug)}
                  </a>
                ),
              },
              {
                key: "status",
                header: t("Status"),
                sort: { compare: comparePagesByStatus, label: (direction) => pageColumnSortLabel(t, t("Status"), direction) },
                cell: (page) => <span className={`status status-${page.status}`}><ServerLabel value={page.status} /></span>,
              },
              {
                key: "updated",
                header: t("Updated"),
                // "desc" (newest first) is this column's own starting direction, unlike the other
                // three's ascending default — unchanged from the pre-existing Updated-only feature.
                sort: { compare: comparePagesByUpdated, defaultDirection: "desc", label: (direction) => updatedPageColumnSortLabel(t, direction) },
                cell: (page) => formatTimestamp(page.updatedAt),
              },
              {
                key: "actions",
                header: t("More"),
                cell: (page) => (
                  <RowMenu
                    triggerLabel={t('Actions for "{title}"').replace("{title}", page.title)}
                    agentHandle={`${rowMenuHandleById.get(page.id)}-menu`}
                    items={pageRowMenuItems(
                      page,
                      {
                        // Same `pageAdminPath` slug-vs-id reasoning as the Title column's own edit
                        // link above; `navigate` takes the bare route path directly.
                        onEdit: (p) => navigate(pageAdminPath(p)),
                        onTogglePublish: togglePagePublish,
                        onDelete: setPendingDelete,
                      },
                      locale,
                    )}
                  />
                ),
              },
            ]}
          />
        </>
      ) : (
        <ThemePagesTab
          pages={themePages}
          activeThemeId={themeId}
          error={themePagesError}
          savingPageId={themePageSavingId}
          setPagePublished={setThemePagePublished}
          t={t}
        />
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        agentHandle="pages-delete"
        title={t("Move to trash?")}
        body={
          pendingDelete ? (
            <p>
              {t("Move")} &quot;{pendingDelete.title}&quot; {t("to trash? It will disappear from the site and from this list.")}
            </p>
          ) : null
        }
        confirmLabel={t("Move to trash")}
        destructive
        pending={pendingDelete !== null && rowSavingId === pendingDelete.id}
        onConfirm={removePage}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
