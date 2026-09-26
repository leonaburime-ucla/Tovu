import { DataTable } from "@jini-ai/admin/react";
import { agentHandle } from "@jini-ai/agentic";
import { buildAgentListHandles } from "../../lib/agent-list-handles";
import { useWiredWidgetRegions } from "./hooks/use-widget-regions.hooks";
import { PublishSectionButton } from "../publish-content/PublishSectionButton";

/**
 * @file `WidgetRegionsScreen` (`ui.spec.md` §2.4/§3.6/§4.5/§9) — `/admin/widgets/regions` — markup
 * only. Lists currently-bound regions; the bind-new-region control is a free-text `regionKey`
 * input, mirroring `Menus.tsx`'s location-assign control exactly (no "theme declares regions" list
 * API exists to source a dropdown from — `ThemeManifest.regions` is read server-side at render
 * time, not exposed as an admin-listable registry; see `ui.spec.md` §9's disclosed dependency-gap
 * note).
 *
 * State, the fetch, and bind live in `hooks/use-widget-regions.hooks.ts`.
 */
export interface WidgetRegionsProps {
  /**
   * Dependency injection seam for tests — the same convention `Posts.tsx`'s `usePostsHook` uses.
   * Defaulted to the real hook, so production callers pass nothing and behave exactly as before.
   */
  useWidgetRegionsHook?: typeof useWiredWidgetRegions;
}

export function WidgetRegions({ useWidgetRegionsHook = useWiredWidgetRegions }: WidgetRegionsProps = {}) {
  const { regions, error, newRegionKey, setNewRegionKey, binding, bind, t } = useWidgetRegionsHook();

  if (error && !regions) return <div className="notice error">{error}</div>;
  if (!regions) return <div className="notice">{t("Loading regions…")}</div>;

  // Region keys are stable and unique, same per-row-handle derivation every other list on this
  // workstream uses (`buildAgentListHandles`) — needed because `DataTable`'s `cell` callback only
  // receives the row, not its index.
  const rowHandles = buildAgentListHandles(
    "widget-regions-row",
    regions.map((region) => region.regionKey),
  );
  const rowHandleByKey = new Map(regions.map((region, index) => [region.regionKey, rowHandles[index]!]));

  return (
    <div className="page">
      {/* `page-header-split` (`styles.css`) — same shared idiom every editor with a back button
          now uses: back link alone at the left rail, title block centred. This screen's own
          right-rail action isn't a Save button but the bind-a-region control (input + Bind
          button); `.page-header-actions` treats it exactly the same way (owner, 2026-09-22 — the
          back link used to float above the header entirely, uncoordinated with the title, and
          read "← Widgets"; it now reads the shared "← Back" every other editor got in the same
          pass). */}
      <div
        className="page-header page-header-split"
        {...agentHandle("widget-regions-header", {
          role: "region",
          label: "Widget Regions header — the back link, the screen's title, and the bind-a-region control",
        })}
      >
        <div className="page-header-lead">
          {/* Visible label shortened to a plain "← Back" (owner, 2026-09-22 — every editor's back
              button reads the same short way now). `aria-label` keeps "Back: Widgets" —
              colon-joined rather than concatenated into a sentence so it needs no new per-locale
              phrase key and still starts with the exact visible text (WCAG 2.5.3 Label in Name). */}
          <a
            className="btn-secondary"
            href="/admin/widgets"
            aria-label={`${t("Back")}: ${t("Widgets")}`}
            {...agentHandle("widget-regions-back", { role: "link", label: "Back to Widgets" })}
          >
            ← {t("Back")}
          </a>
        </div>
        <div className="page-header-text">
          <p className="page-kicker">{t("Content")}</p>
          <h1 className="page-title">{t("Widget Regions")}</h1>
          <p className="page-description">
            {t(
              'A region is a theme-declared placement area (e.g. "header", "footer", "sidebar"). Bind a region by its key to start placing widgets in it.',
            )}
          </p>
        </div>
        <div className="page-header-actions page-actions">
          <PublishSectionButton section="widgets" />
          <input
            value={newRegionKey}
            onChange={(e) => setNewRegionKey(e.target.value)}
            placeholder="e.g. footer"
            {...agentHandle("widget-regions-new-key", { role: "field", label: "New region key to bind, e.g. footer" })}
          />
          <button
            onClick={bind}
            disabled={binding || !newRegionKey.trim()}
            {...agentHandle("widget-regions-bind", { role: "button", label: "Bind this region key" })}
          >
            {binding ? t("Binding…") : t("Bind region")}
          </button>
        </div>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      <DataTable
        rows={regions}
        rowKey={(region) => region.regionKey}
        empty={
          <div className="card">
            <div className="empty-state">
              <p>{t("No regions bound yet.")}</p>
            </div>
          </div>
        }
        columns={[
          {
            key: "region-key",
            header: t("Region key"),
            cell: (region) => (
              <a
                href={`/admin/widgets/regions/${region.regionKey}`}
                {...agentHandle(`${rowHandleByKey.get(region.regionKey)}-key`, { role: "link", label: `Manage the "${region.regionKey}" region` })}
              >
                {region.regionKey}
              </a>
            ),
          },
          { key: "placements", header: t("Placements"), cell: (region) => region.placementCount },
          {
            key: "manage",
            cell: (region) => (
              <a
                className="btn-primary"
                href={`/admin/widgets/regions/${region.regionKey}`}
                {...agentHandle(`${rowHandleByKey.get(region.regionKey)}-manage`, { role: "link", label: `Manage the "${region.regionKey}" region` })}
              >
                {t("Manage")}
              </a>
            ),
          },
        ]}
      />
    </div>
  );
}
