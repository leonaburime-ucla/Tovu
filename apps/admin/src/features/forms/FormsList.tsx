import { navigate } from "../../lib/router";
import { ConfirmDialog, DataTable, RowMenu } from "@jini-ai/admin/react";
import { agentHandle } from "@jini-ai/agentic";
import { buildAgentListHandles } from "../../lib/agent-list-handles";
import { formRowMenuItems } from "./rules";
import { useWiredFormsList } from "./hooks/use-forms-list.hooks";
import { RecipientLabel, ServerLabel } from "@/components/status-labels";
import { PublishSectionButton } from "../publish-content/PublishSectionButton";

/**
 * @file Forms list screen (SPEC-010 ui.spec.md §2.1/§3.1) — the `/admin/forms` route.
 * Mirrors `Menus.tsx`/`Posts.tsx`'s fetch/loading/error/table convention. Layout now follows the
 * Posts/Media page-primitive pass (`.page`/`.page-header`/`.card`/`.table-scroll`/`.empty-state`,
 * see `styles.css`) instead of the bare `.editor-header` this screen used before — see
 * `FormEditor.tsx`'s file comment for the fuller rationale (both screens were audited together).
 *
 * Row actions: `Posts.tsx`/`Pages.tsx`'s `RowMenu` pattern, INCLUDING a Delete item (T7a,
 * 2026-09-21) — `api.ts`'s generic `trash` route (`POST /trash/items`, `type: "form"`) now covers
 * forms, so there is a server capability to wire. Reached through `RowMenu`'s "Delete" ->
 * `ConfirmDialog` ("Move to trash?") -> `useFormsList`'s `removeForm`, the same three-step gate
 * `Posts.tsx`/`Pages.tsx` already use for their own row deletes; see `use-forms-list.hooks.ts`'s own
 * doc for why a click alone can never delete. What ALSO exists (unchanged by this pass) is
 * `api.updateForm`'s `status` patch, the exact call `FormEditor.tsx`'s own Disable/Enable button
 * already makes — surfaced here too so an operator doesn't have to open the editor just to toggle
 * it. That action stays un-confirmed: `FormEditor.tsx` treats it as reversible either direction (no
 * confirm step there either), so this list doesn't invent a heavier gate the editor itself doesn't
 * have. `.btn-warning`'s tone applies only going active -> disabled, same asymmetry as
 * `FormEditor.tsx`'s "Re-enabling is the safe direction" comment.
 *
 * ## Markup only
 *
 * State, the load effect, and the `api.*` calls live in `hooks/use-forms-list.hooks.ts`. That hook
 * was written during the hooks extraction but never wired — this component kept a byte-identical
 * inline copy of the same logic, so the hook was dead code and this screen was never actually
 * markup-only. Wired here; the duplicate is gone. The two copies had NOT drifted, so this is a
 * pure de-duplication with no behaviour change.
 */
export interface FormsListProps {
  /**
   * Dependency injection seam for tests — see `RedirectsProps.useRedirectsHook` for the
   * convention. Defaulted to the real hook, so `panels.tsx` passes nothing.
   */
  useFormsListHook?: typeof useWiredFormsList;
}

export function FormsList({ useFormsListHook = useWiredFormsList }: FormsListProps = {}) {
  const { forms, error, rowSavingId, toggleStatus, pendingDelete, setPendingDelete, removeForm, t } = useFormsListHook();

  if (error && !forms) return <div className="notice error">{error}</div>;
  if (!forms) return <div className="notice">{t("Loading forms…")}</div>;

  // Form ids are stable and unique, so they disambiguate one row's edit link from another's —
  // same reasoning as every other list on this workstream. Each row's "Actions" menu (Edit/Disable/
  // Enable via `RowMenu`) shares this same per-row base (`${rowHandles[index]}-menu`) now that
  // `RowMenu` (`@jini-ai/admin/react`) accepts an `agentHandle` prop — before this session it
  // published none, so its trigger and dropdown items were invisible to `page.find_elements`
  // regardless of what this file did. The Disable/Enable action also stays reachable another way:
  // `FormEditor.tsx`'s own status toggle (`form-editor-status-toggle`) does the identical
  // `api.updateForm({ status })` call.
  const rowHandles = buildAgentListHandles(
    "forms-row",
    forms.map((form) => form.id),
  );

  return (
    <div className="page">
      <div
        className="page-header"
        {...agentHandle("forms-header", { role: "region", label: "Forms list header — page title and the New form button" })}
      >
        <div className="page-header-text">
          <p className="page-kicker">{t("Content")}</p>
          <h1 className="page-title">{t("Forms")}</h1>
          <p className="page-description">{t("Manage the forms embedded across the site and their submissions.")}</p>
        </div>
        <div className="page-actions">
          <PublishSectionButton section="forms" />
          {/* Plain `<a className="btn-primary">`, not a `<button>` nested inside an `<a>` (invalid
              HTML, undefined activation behaviour) — same `a.btn-*` mechanism `Dashboard.tsx`'s
              "View site ↗" already uses. */}
          <a
            className="btn-primary"
            href="/admin/forms/new"
            {...agentHandle("forms-new", { role: "link", label: "Create a new form" })}
          >
            {t("New form")}
          </a>
        </div>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      <DataTable
        rows={forms}
        rowKey={(form) => form.id}
        empty={
          <div className="card">
            <div className="empty-state">
              <p>{t("No forms yet.")}</p>
              <p className="page-description">{t("Create your first form to start collecting submissions.")}</p>
            </div>
          </div>
        }
        columns={[
          {
            key: "name",
            header: t("Name"),
            cell: (form, index) => (
              <a
                href={`/admin/forms/${form.slug}`}
                {...agentHandle(`${rowHandles[index]}-edit`, {
                  role: "link",
                  label: "Open this form's editor",
                })}
              >
                {form.name}
              </a>
            ),
          },
          { key: "slug", header: t("Slug"), cell: (form) => form.slug },
          {
            key: "status",
            header: t("Status"),
            cell: (form) => <span className={`status status-${form.status}`}><ServerLabel value={form.status} /></span>,
          },
          { key: "fields", header: t("Fields"), cell: (form) => form.fields.length },
          {
            key: "notify",
            header: t("Notify"),
            cell: (form) => (form.notify.enabled ? <>{form.notify.recipients.length} <RecipientLabel count={form.notify.recipients.length} /></> : t("off")),
          },
          {
            key: "actions",
            header: t("More"),
            cell: (form, index) => (
              <RowMenu
                triggerLabel={t('Actions for form "{name}"').replace("{name}", form.name)}
                agentHandle={`${rowHandles[index]}-menu`}
                items={formRowMenuItems(
                  form,
                  {
                    onEdit: (f) => navigate(`/forms/${f.slug}`),
                    onToggleStatus: (f) => void toggleStatus(f),
                    onDelete: (f) => setPendingDelete(f),
                  },
                  t,
                )}
              />
            ),
          },
        ]}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        agentHandle="forms-delete"
        title={t("Move to trash?")}
        body={
          pendingDelete ? (
            <p>
              {t("Move")} &quot;{pendingDelete.name}&quot; {t("to trash? It will disappear from the site and from this list.")}
            </p>
          ) : null
        }
        confirmLabel={t("Move to trash")}
        destructive
        pending={pendingDelete !== null && rowSavingId === pendingDelete.id}
        onConfirm={removeForm}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
