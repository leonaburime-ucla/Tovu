import { type AdminWidgetType } from "../../lib/api";
import { WIDGET_TYPE_OPTIONS } from "../../components/WidgetConfigFields/WidgetConfigFields";
import { ConfirmDialog, DataTable } from "@jini-ai/admin/react";
import { agentHandle } from "@jini-ai/agentic";
import { buildAgentListHandles } from "../../lib/agent-list-handles";
import { widgetTypeLabel } from "./rules";
import { useWiredWidgetsLibrary } from "./hooks/use-widgets-library.hooks";
import { ServerLabel } from "@/components/status-labels";
import { PublishSectionButton } from "../publish-content/PublishSectionButton";

/**
 * @file `WidgetsLibraryScreen` (`ui.spec.md` §2.1/§3.1/§4.1) — the widget library/list screen,
 * `/admin/widgets` — markup only. Mirrors `Menus.tsx`'s list-table/status-badge/header-action
 * shape exactly.
 *
 * State and the fetch live in `hooks/use-widgets-library.hooks.ts`; the shared type-label
 * derivation lives in `rules.ts`. Delete always confirms first (`pendingTrash`/`ConfirmDialog`
 * below) and moves the widget to the Trash — there is no purge/force-purge escalation here any
 * more (2026-09-21, `trash-delete-architecture.md`): the server's widget purge route was removed,
 * a trashed widget is hidden from this list by the server, and the Trash screen owns
 * restore/purge from here.
 */
export interface WidgetsLibraryProps {
  /**
   * Dependency injection seam for tests — the same convention `Posts.tsx`'s `usePostsHook` uses.
   * Defaulted to the real hook, so production callers pass nothing and behave exactly as before.
   */
  useWidgetsLibraryHook?: typeof useWiredWidgetsLibrary;
}

/** The list screen's two independent notices — a fetch/action error, and malformed widget records
 *  the server could not read — pulled out of `WidgetsLibrary`'s own render body as a top-level
 *  component under the tightened ≤9/≤9 pass. */
export function WidgetsLibraryNotices({
  error,
  skippedCount,
  skippedIds = [],
  t = (key: string) => key,
}: {
  error: string | null;
  skippedCount: number;
  skippedIds?: string[];
  /** Translator closure — see `WidgetsLibrary()`'s own `t`. Optional (identity default) since this
   *  component is exported and unit-tested directly without one — same "default to the real thing,
   *  a stub renders English" convention every `use*Hook` prop in this app already follows. */
  t?: (key: string) => string;
}) {
  return (
    <>
      {error ? <div className="notice error">{error}</div> : null}
      {skippedCount > 0 ? (
        <div className="notice">
          {skippedCount === 1
            ? t("1 widget record in this workspace could not be read.")
            : t("{n} widget records in this workspace could not be read.").replace("{n}", String(skippedCount))}
          {skippedIds.length > 0 ? (
            <details>
              <summary>{t("Show ids")}</summary>
              <ul>{skippedIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function WidgetsLibrary({ useWidgetsLibraryHook = useWiredWidgetsLibrary }: WidgetsLibraryProps = {}) {
  const {
    widgets,
    error,
    skippedCount,
    skippedIds,
    createType,
    setCreateType,
    pendingTrash,
    trashing,
    requestTrash,
    confirmTrash,
    cancelTrash,
    t,
    locale,
  } = useWidgetsLibraryHook();

  if (error && !widgets) return <div className="notice error">{error}</div>;
  if (!widgets) return <div className="notice">{t("Loading widgets…")}</div>;

  // Widget ids are stable and unique, same per-row-handle derivation every other list on this
  // workstream uses (`buildAgentListHandles`) — the title link and the Trash/Delete button both
  // need one, since `DataTable`'s `cell` callback only receives the row, not its index.
  const rowHandles = buildAgentListHandles(
    "widgets-row",
    widgets.map((widget) => widget.id),
  );
  const rowHandleById = new Map(widgets.map((widget, index) => [widget.id, rowHandles[index]!]));

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-text">
          <p className="page-kicker">{t("Content")}</p>
          <h1 className="page-title">{t("Widgets")}</h1>
          <p className="page-description">
            {t("Create reusable content blocks and place them into your theme's widget regions.")}
          </p>
        </div>
        <div className="page-actions">
          <PublishSectionButton section="widgets" />
          <a
            href="/admin/widgets/regions"
            {...agentHandle("widgets-regions-link", { role: "link", label: "Go to Widget Regions" })}
          >
            {t("Regions →")}
          </a>
          <select
            value={createType}
            onChange={(e) => setCreateType(e.target.value as AdminWidgetType)}
            aria-label={t("Widget type to create")}
            {...agentHandle("widgets-create-type", { role: "field", label: "Widget type to create" })}
          >
            {WIDGET_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {widgetTypeLabel(o.value, locale)}
              </option>
            ))}
          </select>
          <a
            className="btn-primary"
            href={`/admin/widgets/new?type=${createType}`}
            {...agentHandle("widgets-add-new", { role: "link", label: "Create a new widget of the selected type" })}
          >
            {t("Add New")}
          </a>
        </div>
      </div>
      <WidgetsLibraryNotices error={error} skippedCount={skippedCount} skippedIds={skippedIds} t={t} />
      <DataTable
        rows={widgets}
        rowKey={(widget) => widget.id}
        empty={
          <div className="card">
            <div className="empty-state">
              <p>{t("No widgets yet.")}</p>
              <p className="page-description">{t("Create one above to get started.")}</p>
            </div>
          </div>
        }
        columns={[
          {
            key: "title",
            header: t("Title"),
            cell: (widget) => (
              <a
                // Slug, not id (2026-09-22, URL-uses-slug — mirrors `FormsList.tsx`'s
                // `/admin/forms/${form.slug}` row link): the editor resolves either
                // (`read-service.ts`'s `getWidgetInstance`), but the slug is the readable one.
                href={`/admin/widgets/${widget.slug}`}
                {...agentHandle(`${rowHandleById.get(widget.id)}-edit`, { role: "link", label: `Edit the "${widget.title}" widget` })}
              >
                {widget.title}
              </a>
            ),
          },
          {
            key: "type",
            header: t("Type"),
            cell: (widget) => widgetTypeLabel(widget.widgetType, locale),
          },
          {
            key: "slug",
            header: t("Slug"),
            // Monospace like Collections' "Key" column (`Collections.tsx`) — a slug is an
            // identifier, not prose.
            cell: (widget) => <code>{widget.slug}</code>,
          },
          {
            key: "status",
            header: t("Status"),
            cell: (widget) => <span className={`status status-${widget.status}`}><ServerLabel value={widget.status} /></span>,
          },
          {
            key: "actions",
            // Not converted to a `RowMenu` — this is the row's only action (see report: a menu
            // with one item is pure overhead over a direct button). Still labeled for
            // accessibility, matching `Roles.tsx`/`Users.tsx`'s existing pattern for an actions
            // column that isn't a bare `<th></th>`.
            headerLabel: t("Actions"),
            cell: (widget) => (
              <button
                onClick={() => requestTrash(widget)}
                {...agentHandle(`${rowHandleById.get(widget.id)}-trash`, {
                  role: "button",
                  label: `Move "${widget.title}" to trash`,
                })}
              >
                {t("Trash")}
              </button>
            ),
          },
        ]}
      />
      <ConfirmDialog
        open={pendingTrash !== null}
        agentHandle="widgets-trash"
        title={t("Move to trash?")}
        body={pendingTrash ? <p>{t('Move "{title}" to trash?').replace("{title}", pendingTrash.title)}</p> : null}
        confirmLabel={t("Move to trash")}
        destructive
        pending={trashing}
        onConfirm={confirmTrash}
        onCancel={cancelTrash}
      />
    </div>
  );
}
