import { agentHandle } from "@jini-ai/agentic";

import type { PublishCriteria, PublishRequestResult, PublishScope } from "@tovu/publish-content-ui";

import type { Translate } from "../../lib/dictionary-translator";
import { overwriteTooltipFor, usePublishContentConfirm } from "./hooks/use-publish-content-confirm.hooks";
import type { PublishContentPort } from "./hooks/publish-content-port.hooks";

/**
 * @file The publish-content slice's dialog, opened from the Dashboard's header button, and the whole
 * plan -> report -> confirm -> execute ceremony behind it
 * (`ADS-memory/reports/2026-09-18-publish-feature-implementation-plan.md` §4 task 11).
 *
 * Its job is educational, not just a yes/no gate: the owner's stated worry is operators deploying
 * the site, seeing no change, and not understanding that a deploy ships CODE while this dialog's
 * action ships CONTENT — two different things this app has never distinguished for anyone before.
 * The body copy says that explicitly rather than assuming it's obvious.
 *
 * ## The report table is the safety feature, not a progress indicator
 *
 * A publish never overwrites something edited on the far side; it reports it and moves on
 * (`features/publish-content/planner.ts`'s seven outcomes). That promise is only worth anything if
 * the operator can SEE which entities were skipped and why before committing — so the plan step runs
 * first, renders one row per entity with its reason, and only then offers a button that writes. A
 * skipped row carries no control that could publish it — not even a disabled checkbox: exclusion is
 * by construction, not by an unchecked box.
 *
 * Rows the run WOULD write are checked by default and can be unchecked (owner-directed, 2026-09-19).
 * That stays consistent with the paragraph above rather than contradicting it: unchecking is how an
 * operator publishes LESS, never more, and it is honoured by re-planning against a bundle narrowed to
 * the checked rows (see `hooks/use-publish-content-confirm.hooks.ts`'s `confirmPlan`), so a
 * deselected entity never reaches the live site at all. `@tovu/publish-content-ui`'s `report-rows.ts`
 * owns which rows may carry a checkbox; this file only renders the answer.
 *
 * Every decision this file renders comes from `hooks/use-publish-content-confirm.hooks.ts`, and
 * every rule the hook applies comes from `@tovu/publish-content-ui` — the same module the server's
 * own planner semantics are pinned against. This component contains no publish logic at all.
 *
 * Markup, classes (`settings-dialog`/`settings-dialog-backdrop`, `btn-secondary`/`btn-primary`),
 * and behaviour (Escape-to-cancel via the paired hook, Cancel default-focused) mirror
 * `features/plugins/AgentPluginDisableConfirmDialog.tsx` — the most recent precedent for this shape
 * of dialog in this app. Confirm is `.btn-primary` here, not `.btn-danger`: publishing isn't
 * destructive the way removing a plugin or an OAuth connection is, it's the app's one deliberate
 * primary action, so it gets the same burnt-orange fill `.btn-primary` already renders everywhere
 * else. Cancel stays the default-focused control anyway: publishing touches the live site and can
 * skip content without the operator noticing, so the interrupting action is still never the one
 * Enter fires by accident, matching every other confirm dialog's own reasoning even though this one
 * isn't destructive.
 *
 * ## "Overwrite on live" (publish-overwrite-live-plan-2026-09-24.md §4/S9)
 *
 * A skipped row whose planner said it COULD be resolved by overwriting live (`row.overwritable`,
 * `@tovu/publish-content-ui`'s `report-rows.ts`) gets its own checkbox in a column this file adds
 * only while there is at least one such row AND the peer this plan targets can actually honour it
 * (`view.liveCanOverwrite`). Ticking one is not itself what overwrites anything — it re-plans through
 * `hooks/use-publish-content-confirm.hooks.ts`'s `onToggleOverwrite`, and the row only leaves
 * `skipped` once that re-plan comes back `forced`. An older live gets one sentence under the table
 * instead of any checkbox at all (`view.overwriteUnavailable`); a live that moved between the first
 * plan and a later tick gets `view.overwriteMismatch` alongside the freshly re-planned rows, never a
 * silently stale table.
 *
 * ## The empty state is the connect action, not a dead end
 *
 * When `view.connectOffer` is set (no peer configured yet), the SAME primary button below becomes
 * the connect action rather than a second button appearing next to a disabled "Publish" — one
 * visible control, whatever the dialog's current job is. `view.connectOffer.message` is the
 * server's own sentence (`routes/publish-content/destination.ts`), rendered verbatim: it already
 * names the pre-filled candidate site, so this file adds no copy of its own about what connecting
 * means. See that route's header for why this dialog is where the action lives at all.
 */

/** Maps a row's disposition to the `.status-*` pill `styles.css` already defines, so the table
 *  reads the same as every other status column in the app in both themes. */
const DISPOSITION_PILL_CLASS = {
  publish: "status status-active",
  unchanged: "status status-draft",
  skipped: "status status-warning",
} as const;

export interface PublishContentDialogProps {
  onCancel: () => void;
  /** The screen's own bound translator, threaded down rather than resolved again here — same
   *  convention `AgentPluginDisableConfirmDialog` uses for its own `t`. */
  t: Translate;
  /** Dependency injection seam for tests — see `hooks/publish-content-port.hooks.ts`. */
  port?: PublishContentPort;
  /** `publish-criteria-tool-webmcp-plan-2026-09-24.md` §4 S2 — threaded straight through to
   *  `usePublishContentConfirm`; see that hook's own `props.criteria` doc for what it does. */
  criteria?: PublishCriteria;
  /** `plan-publish-sections-2026-09-25.md` §2 S2 — threaded straight through to
   *  `usePublishContentConfirm`; see that hook's own `props.scope` doc for what it does. */
  scope?: PublishScope;
  /** Threaded straight through to `usePublishContentConfirm`; see that hook's own `props.onPlanned`
   *  doc for when it fires. */
  onPlanned?: (result: PublishRequestResult) => void;
}

export function PublishContentDialog({ onCancel, t, port, criteria, scope, onPlanned }: PublishContentDialogProps) {
  const view = usePublishContentConfirm({ onCancel, t, port, criteria, scope, onPlanned });
  const titleId = "dashboard-publish-content-confirm-title";
  // publish-overwrite-live-plan §4/S9. The column exists only while the peer this plan targets can
  // honour a forced overwrite AND at least one row is offering one — decided in the hook.
  const { showOverwriteColumn } = view;

  return (
    <div className="settings-dialog-backdrop" onClick={view.onDismiss}>
      <div
        className={`settings-dialog${view.rows.length > 0 ? " publish-content-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId}>{t(view.title)}</h2>
        <p>{t(view.description)}</p>
        <p>{t("Anything edited on the live site is skipped unless you tick Overwrite on live.")}</p>

        {view.peers.length > 1 && (
          <label className="field">
            <span>{t("Publish to")}</span>
            <select
              value={view.selectedPeerId ?? ""}
              disabled={!view.peerSelectionEnabled}
              onChange={(e) => view.onSelectPeer(e.target.value)}
              {...agentHandle("dashboard-publish-content-peer", {
                // `AgentElementRole` has no `select` member — a `<select>` is a `field` in that
                // vocabulary, same as every other value-carrying control.
                role: "field",
                label: "Which site to publish this content to",
              })}
            >
              <option value="">{t("Choose a site…")}</option>
              {view.peers.map((peer) => (
                <option key={peer.id} value={peer.id}>
                  {peer.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {view.peers.length === 1 && (
          <p className="muted publish-content-target">
            {t("Publishing to")} <strong>{view.peers[0].label}</strong>
          </p>
        )}

        {view.connectOffer && <p className="notice">{view.connectOffer.message}</p>}
        {view.refusalReason && (
          <p className="notice error" role="alert">
            {view.refusalReason}
          </p>
        )}
        {view.errorMessage && (
          <p className="notice error" role="alert">
            {view.errorMessage}
          </p>
        )}
        {view.doneMessage && (
          <p className="notice" role="status">
            {view.doneMessage}
          </p>
        )}
        {view.doneNotices.map((line) => (
          <p key={line} className="notice">
            {line}
          </p>
        ))}
        {view.liveGapNotices.map((line) => (
          <p key={line} className="notice publish-content-live-gap" role="status">
            {line}
          </p>
        ))}

        {view.rows.length > 0 && (
          <>
            <div className="table-scroll publish-content-report">
              <table className="list-table">
                <thead>
                  <tr>
                    <th className="publish-content-select">
                      <input
                        type="checkbox"
                        checked={view.allSelected}
                        // React has no `indeterminate` prop — the partial state is a DOM property
                        // only, so it is set on the node itself every render.
                        ref={(node) => {
                          if (node) node.indeterminate = view.someSelected;
                        }}
                        disabled={!view.selectionEnabled || view.rows.every((row) => !row.selectable)}
                        onChange={view.onToggleAll}
                        aria-label={t("Publish every item that can be published")}
                        {...agentHandle("dashboard-publish-content-select-all", {
                          role: "field",
                          label: "Check or uncheck every publishable row at once",
                        })}
                      />
                    </th>
                    <th>{t("Type")}</th>
                    <th>{t("Entity")}</th>
                    <th>{t("What happens")}</th>
                    <th>{t("Why")}</th>
                    {showOverwriteColumn && (
                      <th className="publish-content-overwrite">
                        <input
                          type="checkbox"
                          checked={view.allOverwriteTicked}
                          // Same DOM-only indeterminate handling as the select-all box above — React
                          // has no prop for it.
                          ref={(node) => {
                            if (node) node.indeterminate = view.someOverwriteTicked;
                          }}
                          disabled={!view.selectionEnabled}
                          onChange={view.onToggleAllOverwrite}
                          aria-label={t("Overwrite every item that can replace something on live")}
                          {...agentHandle("dashboard-publish-content-overwrite-all", {
                            role: "field",
                            label: "Check or uncheck every 'Overwrite on live' row at once",
                          })}
                        />{" "}
                        {t("Overwrite on live")}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.key} data-entity-id={row.entityId} data-publish-disposition={row.disposition}>
                      <td className="publish-content-select">
                        {/* A row the run would not write carries NO control at all, not a disabled
                            one: plan §4 task 11's property is that nothing in this dialog can move a
                            skipped row into the set that gets published. */}
                        {row.selectable && (
                          <input
                            type="checkbox"
                            checked={view.selectedKeys.has(row.key)}
                            disabled={!view.selectionEnabled}
                            onChange={() => view.onToggleRow(row.key)}
                            // No `agentHandle` here: a handle must be lowercase words joined by
                            // hyphens, and a row key is an entity id. The row's own
                            // `data-entity-id` is the stable address instead — an agent (or a test)
                            // finds the row, then the one checkbox inside it.
                            data-publish-row-select=""
                            aria-label={`${t("Publish")} ${row.entityType} ${row.entityLabel}`}
                          />
                        )}
                        {/* Owner decision 2026-09-25 — media carried along with the pages/posts
                            that use it: shown ticked while one of them is, and never clickable
                            itself (it follows those rows, not the operator). */}
                        {row.includedFor.length > 0 && (
                          <input
                            type="checkbox"
                            checked={view.carriedAlongKeys.has(row.key)}
                            disabled
                            readOnly
                            data-publish-row-carried=""
                            aria-label={`${t("Publish")} ${row.entityType} ${row.entityLabel}`}
                          />
                        )}
                      </td>
                      <td>{t(row.entityTypeLabel)}</td>
                      {/* The id stays reachable as a tooltip — it is what a support conversation
                          needs — but it is never what the column reads as. */}
                      <td title={row.entityId}>{row.entityLabel}</td>
                      <td>
                        <span className={DISPOSITION_PILL_CLASS[row.disposition]}>{row.dispositionLabel}</span>
                      </td>
                      <td className="publish-content-reason">{row.usedByNote ? t(row.usedByNote) : (row.reason ?? "")}</td>
                      {showOverwriteColumn && (
                        <td className="publish-content-overwrite">
                          {/* Only an offered row (overwritable, or already ticked) carries this
                              control — same "no affordance at all on a row it doesn't apply to" rule
                              the select column follows above. */}
                          {view.overwriteOfferKeys.has(row.key) && (
                            <input
                              type="checkbox"
                              checked={view.overwriteKeys.has(row.key)}
                              disabled={!view.selectionEnabled}
                              onChange={() => view.onToggleOverwrite(row.key)}
                              data-publish-row-overwrite=""
                              aria-label={
                                row.retiresLabel
                                  ? `${t("Overwrite on live")}: ${row.retiresLabel}`
                                  : t("Overwrite on live")
                              }
                              // R6 (`plan-publish-repoint-menus-2026-09-24.md` §2.7) — when the
                              // retired holder still feeds a live menu, the tooltip names it too, so
                              // an operator ticking "overwrite" can see what else moves with it. The
                              // copy itself is built in the hooks file, not here — see
                              // `overwriteTooltipFor`'s own doc.
                              title={overwriteTooltipFor(row, t)}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {view.summary && (
              <p className="muted publish-content-summary">
                {view.summary.publishing} {t("to publish")} · {view.summary.unchanged} {t("unchanged")} ·{" "}
                {view.summary.skipped} {t("skipped")}
              </p>
            )}
            {view.overwriteWarning && (
              <p className="notice publish-content-overwrite-warning" role="status">
                {view.overwriteWarning}
              </p>
            )}
            {view.overwriteMismatch && (
              <p className="notice error" role="alert">
                {view.overwriteMismatch}
              </p>
            )}
            {view.overwriteUnavailable && (
              <p className="notice publish-content-overwrite-unavailable">{view.overwriteUnavailable}</p>
            )}
          </>
        )}

        <span className="editor-actions">
          {/* Cancel is the default-focused control — see this file's header for why, even though
              this dialog isn't destructive. */}
          <button
            type="button"
            className="btn-secondary"
            autoFocus
            disabled={!view.dismissible}
            onClick={view.onDismiss}
            {...agentHandle("dashboard-publish-content-cancel", {
              role: "button",
              label: "Close this dialog without publishing",
            })}
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={view.primaryDisabled}
            onClick={view.onPrimary}
            {...agentHandle("dashboard-publish-content-confirm", {
              role: "button",
              // Same control, different job: while `connectOffer` is set this button connects the
              // pre-filled site instead of reviewing a plan — see this file's header.
              label: view.connectOffer
                ? "Connect this site so it can publish, using the pre-filled site address"
                : "Review what would be published, then publish it to the live site",
            })}
          >
            {view.primaryLabel}
          </button>
        </span>
      </div>
    </div>
  );
}
