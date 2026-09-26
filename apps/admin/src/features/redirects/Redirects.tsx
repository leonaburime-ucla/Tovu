import { DataTable, RowMenu, type RowMenuItem, ConfirmDialog } from "@jini-ai/admin/react";
import { agentHandle } from "@jini-ai/agentic";

import { describeApiError } from "../../lib/api";
import type { Translate } from "../../lib/dictionary-translator";
import { buildAgentListHandles } from "../../lib/agent-list-handles";
import { redirectRowMenuItems } from "./rules";
import { useWiredRedirects } from "./hooks/use-redirects.hooks";
import { ServerLabel } from "@/components/status-labels";
import { useWiredHitCountCell } from "./hooks/use-hit-count-cell.hooks";
import { useWiredImportRedirectsForm } from "./hooks/use-import-redirects-form.hooks";
import { PublishSectionButton } from "../publish-content/PublishSectionButton";
import {
  importRulesLabel,
  importResultSummary,
  createdLabel,
  failedItemLabel,
  deleteRedirectBody,
  actionsForRedirectLabel,
} from "./redirects-i18n";

/**
 * @file Redirects admin screen (SPEC-009 ui.spec.md) — the `/admin/redirects` route.
 * Single-screen list + inline create form + per-row disable/enable + tombstone.
 *
 * SPEC-037 REQ-03/REQ-04: `HitCountCell` wires the previously-unused `api.getRedirectHits` as a
 * lazy per-row fetch (button-triggered, not fired for every row on mount — avoids an N+1 burst on
 * a large list), and `ImportRedirectsForm` wires the new `api.importRedirects` bulk-import
 * affordance, surfacing the route's own `207` per-item created/failed breakdown.
 *
 * ## Pilot for `lib/fetch-query`
 *
 * First screen migrated off the admin's `useState`-triple convention
 * (`data`/`loading`/`error` + a hand-written `load()`), which the other 37
 * fetching files still use. Picked as the pilot because it exercises the whole
 * interface in one small file: a list read, three writes that each used to
 * call `load()` by hand, a gesture-gated lazy read, and an import that
 * refreshes the list.
 *
 * Two things genuinely change beyond line count. Writes now name what they
 * invalidate instead of calling a loader the component happens to own — so a
 * second mounted view of the same key refreshes too, where `load()` only ever
 * refreshed this one. And a background refresh no longer throws the table
 * away: `status` stays `'success'` while `isFetching` is true, so the old
 * `if (!redirects) return <Loading/>` full-screen flash after every write is
 * gone.
 *
 * ## Markup only
 *
 * All state, effects, and `api.*` calls now live in `hooks/use-redirects.hooks.ts`,
 * `hooks/use-hit-count-cell.hooks.ts`, and `hooks/use-import-redirects-form.hooks.ts` — one hook
 * per component in this file. Pure logic (cache keys, payload shaping, the row-menu builder, the
 * import textarea's parse check) lives in `rules.ts`. What stays here is what actually renders.
 *
 * `locale`/`t` are resolved once in `Redirects` via `useRedirectsHook()` (which calls
 * `useAdminLocale()` internally — see `use-redirects.hooks.ts`'s own file header) and threaded down
 * as props — see `Database.tsx`'s file header for why (the hook's `loadLanguage()` isn't
 * memoized). `HitCountCell`/`ImportRedirectsForm` each have their own hook file, so per the
 * standing i18n rule they receive `t` (and, for `ImportRedirectsForm`, `locale`) THROUGH that
 * hook's own parameters rather than importing `redirects-i18n`/`useAdminLocale` directly — but
 * deliberately do NOT resolve `useAdminLocale()` independently inside their own `useWiredX`
 * (unlike every other converted screen in this sweep): `HitCountCell` renders once per table row,
 * so N independent resolutions would mean N concurrent settings fetches for one page load. See
 * `use-hit-count-cell.hooks.ts`'s file header for the full reasoning.
 * `rules.ts`'s row-menu labels stay English — see `redirects-i18n.tsx`'s file header.
 */

export interface HitCountCellProps {
  redirectId: string;
  /** Bound translator, threaded down from `Redirects`'s own hook rather than resolved here — see
   *  this file's header. */
  t: Translate;
  /** This row's own distinct handle base — same reasoning as `Users.tsx`'s `UserRowProps.agentBase`.
   *  Optional (identity-omitted default) since this component is exported and unit-tested directly
   *  without one. */
  agentHandleBase?: string;
  /** Dependency injection seam for tests — see `PostsProps.usePostsHook` for the convention. */
  useHitCountCellHook?: typeof useWiredHitCountCell;
}

/** Lazy hit-count cell (REQ-03) — fetches on first click rather than on mount, so a list of many
 *  rows never fires a synchronous burst of `/hits` requests. A rule with zero recorded hits still
 *  renders `0` (not blank), matching `hits.ts`'s own "still 200s with hitCount: 0" contract. */
function HitCountCell({ redirectId, t, agentHandleBase, useHitCountCellHook = useWiredHitCountCell }: HitCountCellProps) {
  const { error, data, isFetching, request } = useHitCountCellHook({ redirectId, t });

  if (error) return <span className="save-error">{describeApiError(error, "failed")}</span>;
  // A rule with zero recorded hits still renders `0` (not blank), matching
  // `hits.ts`'s own "still 200s with hitCount: 0" contract — so this branches
  // on the request having completed, never on the count's truthiness.
  if (data) return <span>{data.data.hitCount}</span>;
  return (
    <button
      type="button"
      onClick={request}
      disabled={isFetching}
      {...(agentHandleBase ? agentHandle(`${agentHandleBase}-load-hits`, { role: "button", label: "Load this rule's hit count" }) : {})}
    >
      {isFetching ? t("Loading…") : t("Load hits")}
    </button>
  );
}

export interface ImportRedirectsFormProps {
  /** Bound translator, threaded down from `Redirects`'s own hook rather than resolved here — see
   *  this file's header. */
  t: Translate;
  /** Raw resolved locale — needed alongside `t` because several `redirects-i18n.tsx` helpers take
   *  `(locale, ...)` directly. See this file's header. */
  locale: string;
  /** Dependency injection seam for tests — see `PostsProps.usePostsHook` for the convention. */
  useImportRedirectsFormHook?: typeof useWiredImportRedirectsForm;
}

/** Bulk-import affordance (REQ-04) — paste a JSON array of rule objects, submit through
 * `api.importRedirects`, and surface the `207` per-item created/failed breakdown directly
 * (never collapsed into a single pass/fail toast — a partial-batch failure is the route's own
 * designed behavior, not an edge case). */
function ImportRedirectsForm({ t, locale, useImportRedirectsFormHook = useWiredImportRedirectsForm }: ImportRedirectsFormProps) {
  const { raw, setRaw, error, result, importing, submit } = useImportRedirectsFormHook({ t, locale });

  return (
    <details className="notice redirects-import form-measure">
      <summary>{t("Bulk import")}</summary>
      <form onSubmit={submit}>
        <label htmlFor="redirects-import-json">
          {importRulesLabel(locale, <code>{"{matchType, fromPattern, toTarget, statusCode, override?, priority?}"}</code>)}
        </label>
        <textarea
          id="redirects-import-json"
          rows={6}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder='[{"matchType":"exact","fromPattern":"/old","toTarget":"/new","statusCode":301}]'
          {...agentHandle("redirects-import-json", { role: "field", label: "JSON array of redirect rules to bulk-import" })}
        />
        {/* Secondary, not primary — "Add redirect" above is this screen's one actual create
            action; bulk import is a power-user path to the same result, not a second headline CTA
            competing with it. */}
        <button
          type="submit"
          className="btn-secondary"
          disabled={importing}
          {...agentHandle("redirects-import-submit", { role: "button", label: "Import the pasted redirect rules" })}
        >
          {importing ? t("Importing…") : t("Import")}
        </button>
      </form>
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
      {result ? (
        <div className="redirects-import-result">
          <p>{importResultSummary(locale, result.created.length, result.failed.length)}</p>
          {result.created.length > 0 ? (
            <ul>
              {result.created.map((r) => (
                <li key={r.id}>
                  <span className="save-ok">{createdLabel(locale)}</span> {r.fromPattern} → {r.toTarget}
                </li>
              ))}
            </ul>
          ) : null}
          {result.failed.length > 0 ? (
            <ul>
              {result.failed.map((f) => (
                <li key={f.index}>
                  <span className="save-error">{failedItemLabel(locale, f.index, f.code)}</span>: {f.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

export interface RedirectsProps {
  /**
   * Dependency injection seam for tests — the same convention `@jini-ai/ui`'s `CustomSelect` uses
   * for `useCustomSelect`. Defaulted to the real hook, so production callers (`panels.tsx`) pass
   * nothing and behave exactly as before. See `PostsProps.usePostsHook` for the full rationale.
   */
  useRedirectsHook?: typeof useWiredRedirects;
}

export function Redirects({ useRedirectsHook = useWiredRedirects }: RedirectsProps = {}) {
  const {
    redirects,
    listStatus,
    listError,
    error,
    saving,
    pendingDelete,
    setPendingDelete,
    confirmDelete,
    deletePending,
    submitCreate,
    onToggleStatus,
    onRequestDelete,
    t,
    locale,
  } = useRedirectsHook();

  // Only a FIRST load blocks the screen. A refetch triggered by a write keeps
  // the table on screen (`status` stays `'success'`), where the old
  // `if (!redirects)` guard blanked the whole page after every single edit.
  if (listStatus === "error" && !redirects) {
    return <div className="notice error">{describeApiError(listError, "failed to load redirects")}</div>;
  }
  if (!redirects) return <div className="notice">{t("Loading redirects…")}</div>;

  // Redirect ids are stable and unique, so they disambiguate one row's menu from another's — same
  // reasoning as every other list on this workstream.
  const rowMenuHandles = buildAgentListHandles(
    "redirects-row",
    redirects.map((rule) => rule.id),
  );

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-text">
          <p className="page-kicker">{t("Marketing")}</p>
          <h1 className="page-title">{t("Redirects")}</h1>
          <p className="page-description">
            {t("Manual URL redirect rules. Rules created automatically from a slug change (source")}
            <code> auto_slug_change</code>
            {t(") also show up here.")}
          </p>
        </div>
        <div className="page-actions">
          <PublishSectionButton section="redirects" />
        </div>
      </div>
      {error ? <div className="notice error">{describeApiError(error, "request failed")}</div> : null}

      <form className="card form-measure" onSubmit={submitCreate}>
        <div className="field-group">
          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor="redirect-match-type">{t("Match type")}</label>
              <select
                id="redirect-match-type"
                name="matchType"
                defaultValue="exact"
                {...agentHandle("redirects-create-match-type", { role: "field", label: "New redirect's match type" })}
              >
                <option value="exact">{t("exact")}</option>
                <option value="prefix">{t("prefix")}</option>
                <option value="wildcard">{t("wildcard")}</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="redirect-from-pattern">{t("From path")}</label>
              <input
                id="redirect-from-pattern"
                name="fromPattern"
                placeholder="/old-path"
                required
                {...agentHandle("redirects-create-from-pattern", { role: "field", label: "New redirect's source path or pattern" })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="redirect-to-target">{t("To target")}</label>
              <input
                id="redirect-to-target"
                name="toTarget"
                placeholder="/new-path or https://example.com/..."
                required
                {...agentHandle("redirects-create-to-target", { role: "field", label: "New redirect's destination path or URL" })}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="redirect-status-code">{t("Status code")}</label>
              <select
                id="redirect-status-code"
                name="statusCode"
                defaultValue="301"
                {...agentHandle("redirects-create-status-code", { role: "field", label: "New redirect's HTTP status code" })}
              >
                <option value="301">{t("301 (permanent)")}</option>
                <option value="302">{t("302 (temporary)")}</option>
                <option value="307">{t("307 (temporary, method-preserving)")}</option>
                <option value="308">{t("308 (permanent, method-preserving)")}</option>
              </select>
            </div>
          </div>
        </div>
        <div className="editor-actions form-actions">
          <button
            type="submit"
            disabled={saving}
            {...agentHandle("redirects-create-submit", { role: "button", label: "Add this redirect rule" })}
          >
            {saving ? t("Saving…") : t("Add redirect")}
          </button>
        </div>
      </form>

      <ImportRedirectsForm t={t} locale={locale} />

      <DataTable
        rows={redirects}
        rowKey={(rule) => rule.id}
        empty={
          <div className="card">
            <div className="empty-state">
              <p>{t("No redirect rules yet.")}</p>
            </div>
          </div>
        }
        columns={[
          { key: "from", header: t("From"), cell: (rule) => rule.fromPattern },
          { key: "to", header: t("To"), cell: (rule) => rule.toTarget },
          { key: "type", header: t("Type"), cell: (rule) => rule.matchType },
          { key: "code", header: t("Code"), cell: (rule) => rule.statusCode },
          { key: "source", header: t("Source"), cell: (rule) => rule.source },
          {
            key: "status",
            header: t("Status"),
            cell: (rule) => <span className={`status status-${rule.status}`}><ServerLabel value={rule.status} /></span>,
          },
          {
            key: "hits",
            header: t("Hits"),
            cell: (rule, index) => <HitCountCell t={t} redirectId={rule.id} agentHandleBase={rowMenuHandles[index]} />,
          },
          {
            key: "actions",
            header: t("More"),
            cell: (rule, index) => {
              const items: RowMenuItem[] = redirectRowMenuItems(rule, { onToggleStatus, onRequestDelete }, locale);
              return (
                <RowMenu
                  triggerLabel={actionsForRedirectLabel(locale, rule.fromPattern)}
                  agentHandle={`${rowMenuHandles[index]}-menu`}
                  items={items}
                />
              );
            },
          },
        ]}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        agentHandle="redirects-delete"
        title={t("Delete redirect rule?")}
        body={pendingDelete ? deleteRedirectBody(locale, pendingDelete.fromPattern) : null}
        confirmLabel={t("Delete")}
        destructive
        pending={deletePending}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
