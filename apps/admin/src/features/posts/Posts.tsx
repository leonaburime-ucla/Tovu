import { DataTable, RowMenu, ConfirmDialog } from "@jini-ai/admin/react";
import type { DataTableSortState } from "@jini-ai/admin/core";
import { agentHandle } from "@jini-ai/agentic";
import { useState, type ReactNode } from "react";

import type { AdminPost } from "../../lib/api";
import { siteUrl } from "../../lib/site-url";
import { formatTimestamp } from "../../lib/format-timestamp";
import { navigate } from "../../lib/router";
import {
  postRowMenuItems,
  comparePostsByTitle,
  comparePostsBySlug,
  comparePostsByStatus,
  comparePostsByUpdated,
  postColumnSortLabel,
  updatedColumnSortLabel,
  DEFAULT_POST_SORT,
} from "./rules";
import { useWiredPosts } from "./hooks/use-posts.hooks";
import { ServerLabel } from "@/components/status-labels";
import { useWiredAdminLocale } from "../../hooks/use-admin-locale.hooks";
import { t as translate } from "./posts-i18n";
import { PublishSectionButton } from "../publish-content/PublishSectionButton";

/**
 * @file The Posts list screen — markup only.
 *
 * State and API calls live in `hooks/use-posts.hooks.ts`; the row-menu logic lives in `rules.ts`.
 * What stays here is what actually renders: column definitions, the empty state, and the confirm
 * copy.
 */
export interface PostsProps {
  /**
   * Dependency injection seam for tests — the same convention `@jini-ai/ui`'s `CustomSelect` uses
   * for `useCustomSelect`.
   *
   * Defaulted to the real hook, so production callers (`panels.tsx`) pass nothing and behave
   * exactly as before. A test supplies a stub and drives this component through any state —
   * mid-delete, load failure, empty list — without module mocking, a fake `fetch`, or waiting on a
   * real request. That matters here specifically: this screen has no unit test today, and the
   * reason it is awkward to write one is that every state is behind an un-substitutable `api` call.
   */
  usePostsHook?: typeof useWiredPosts;
}

/**
 * The loading/error guard shown before the table has anything to render — pulled out of `Posts`
 * (2026-08-06, complexity pass, fourth pass) so its two early-return checks collapse into one
 * `if` at the call site. `error && !posts` (not just `error`): once the list has loaded, a later
 * failure (create, delete) surfaces as an inline banner above the table instead of blanking the
 * whole screen — matches Pages.tsx/Media.tsx/Comments.tsx. Mirrors `Pages.tsx`'s identical
 * `pagesListNotice`.
 */
export function postsListNotice(posts: AdminPost[] | null, error: string | null, t: (key: string) => string): ReactNode {
  if (error && !posts) return <div className="notice error">{error}</div>;
  if (!posts) return <div className="notice">{t("Loading posts…")}</div>;
  return null;
}

export function Posts({ usePostsHook = useWiredPosts }: PostsProps) {
  const {
    posts,
    error,
    creating,
    rowSavingId,
    pendingDelete,
    setPendingDelete,
    createPost,
    togglePostPublish,
    removePost,
    rowMenuHandleById,
  } = usePostsHook();
  const locale = useWiredAdminLocale();
  const t = (key: string): string => translate(locale, key);
  // Owner ruling (2026-08-14): pure interactive DOM-chrome state — a client-side sort toggle with
  // no I/O behind it — stays LOCAL rather than moving into `use-posts.hooks.ts`, unlike every other
  // piece of state on this screen. The line to draw: async/API/data state always moves into the
  // hook; view-only chrome (active tab, expanded/collapsed, dialog open, sort direction) stays here
  // UNLESS a test needs to observe it. `Posts.tsx` is the file everyone else copies this pattern
  // from (this file's own `PostsProps` doc comment) — this is the canonical example of the
  // exception, not an oversight to "finish" later.
  //
  // 2026-09-02: generalized from a single Updated-only direction to `DataTableSortState`, which
  // also names the active column — Title/Slug/Status became sortable too — and only one column is
  // ever active at a time. Migrated onto `DataTable`'s own shared sort mechanism the same day: this
  // state and its setter are now passed straight through as `sort`/`onSortChange` below, and
  // `DataTable` itself applies each column's comparator, computes the next click's state, and
  // renders the caret/`aria-sort` — see `rules.ts`'s "Column sort" section for what's left here.
  const [sort, setSort] = useState<DataTableSortState>(DEFAULT_POST_SORT);

  const notice = postsListNotice(posts, error, t);
  if (notice) return notice;
  // Unreachable in practice — `postsListNotice` already returns a non-null notice whenever `posts`
  // is null — but restores the narrowing TS lost by moving that check behind a function call, so
  // `rows={posts}` below type-checks as `AdminPost[]` without an `as`/`!` assertion.
  if (!posts) return null;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-text">
          <p className="page-kicker">{t("Content")}</p>
          <h1 className="page-title">{t("Posts")}</h1>
          <p className="page-description">{t("Manage and publish every post on this site.")}</p>
        </div>
        <div className="page-actions">
          <PublishSectionButton section="posts" />
          <button
            onClick={createPost}
            disabled={creating}
            {...agentHandle("posts-new", { role: "button", label: "Create a new post" })}
          >
            {creating ? t("Creating…") : t("New Post")}
          </button>
        </div>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      <DataTable
        rows={posts}
        rowKey={(post) => post.id}
        sort={sort}
        onSortChange={setSort}
        empty={
          <div className="card">
            <div className="empty-state">
              <p>{t("No posts yet.")}</p>
              <p className="page-description">{t("Create your first post to get started.")}</p>
            </div>
          </div>
        }
        columns={[
          {
            key: "title",
            header: t("Title"),
            // Sortable headers (2026-08-10, Updated only; generalized to all four 2026-09-02;
            // migrated onto `DataTable`'s own shared sort mechanism 2026-09-02) — `DataTable` now
            // renders the button, caret, and `aria-sort` itself from this descriptor; only the
            // domain-specific comparator and label wording stay here (`rules.ts`).
            sort: { compare: comparePostsByTitle, label: (direction) => postColumnSortLabel(t, t("Title"), direction) },
            cell: (post) => (
              <a
                href={`/admin/posts/${post.slug}`}
                {...agentHandle(`${rowMenuHandleById.get(post.id)}-edit`, { role: "link", label: "Open this post's editor" })}
              >
                {post.title}
              </a>
            ),
          },
          {
            key: "slug",
            header: "Slug",
            sort: { compare: comparePostsBySlug, label: (direction) => postColumnSortLabel(t, t("Slug"), direction) },
            cell: (post) => (
              <a
                href={siteUrl(`/${post.slug}`)}
                target="_blank"
                rel="noreferrer"
                {...agentHandle(`${rowMenuHandleById.get(post.id)}-view-live`, { role: "link", label: "Open this post on the live public site" })}
              >
                /{post.slug}
              </a>
            ),
          },
          {
            key: "status",
            header: t("Status"),
            sort: { compare: comparePostsByStatus, label: (direction) => postColumnSortLabel(t, t("Status"), direction) },
            cell: (post) => <span className={`status status-${post.status}`}><ServerLabel value={post.status} /></span>,
          },
          {
            key: "updated",
            header: t("Updated"),
            // "desc" (newest first) is this column's own starting direction, unlike the other
            // three's ascending default — unchanged from the pre-existing Updated-only feature.
            sort: { compare: comparePostsByUpdated, defaultDirection: "desc", label: (direction) => updatedColumnSortLabel(t, direction) },
            cell: (post) => formatTimestamp(post.updatedAt),
          },
          {
            key: "actions",
            header: t("More"),
            cell: (post) => (
              <RowMenu
                triggerLabel={t('Actions for "{title}"').replace("{title}", post.title)}
                agentHandle={`${rowMenuHandleById.get(post.id)}-menu`}
                items={postRowMenuItems(
                  post,
                  {
                    onEdit: (p) => navigate(`/posts/${p.slug}`),
                    onTogglePublish: togglePostPublish,
                    onDelete: setPendingDelete,
                  },
                  locale,
                )}
              />
            ),
          },
        ]}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        agentHandle="posts-delete"
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
        onConfirm={removePost}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
