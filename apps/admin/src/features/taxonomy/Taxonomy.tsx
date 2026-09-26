import type { AdminTaxonomy, AdminTaxonomyWithTerms, AdminTerm } from "../../lib/api";
import { ConfirmDialog, RowMenu } from "@jini-ai/admin/react";
import { agentHandle } from "@jini-ai/agentic";
import { buildAgentListHandles } from "../../lib/agent-list-handles";
import { termDepth, otherMergeTargets, type DeleteBlockedState } from "./rules";
import { useWiredNewTermForm } from "./hooks/use-new-term-form.hooks";
import { useWiredNewTaxonomyForm } from "./hooks/use-new-taxonomy-form.hooks";
import { useWiredMergeTermSection } from "./hooks/use-merge-term-section.hooks";
import { useWiredTermDetailPanel } from "./hooks/use-term-detail-panel.hooks";
import { useWiredTaxonomy } from "./hooks/use-taxonomy.hooks";
import { ServerLabel } from "@/components/status-labels";
import { PublishSectionButton } from "../publish-content/PublishSectionButton";

/**
 * @file Categories & Tags screen (design-spec.md §2, ADR-044) — the `/admin/taxonomy` route.
 * Markup only.
 *
 * State and API calls live in one hook per component: `hooks/use-new-term-form.hooks.ts`,
 * `hooks/use-new-taxonomy-form.hooks.ts`, `hooks/use-merge-term-section.hooks.ts`,
 * `hooks/use-term-detail-panel.hooks.ts`, `hooks/use-taxonomy.hooks.ts` (the top-level screen).
 * `termDepth`, `otherMergeTargets`, and `findSelectedTerm` (used inside `use-taxonomy.hooks.ts`)
 * live in `rules.ts`.
 *
 * Structural reference, CORRECTED (web-design pass, 2026-08-05): the original comment here named
 * `Settings.tsx`'s two-pane namespace-list + detail-panel layout as the structural reference. That
 * was wrong on inspection — `panels.tsx` routes `/admin/settings` to `SettingsUi.tsx` (the Open
 * Design dialog-shell port), not to `Settings.tsx`, which was `features/settings-raw`'s SPEC-007 raw
 * namespace/key ledger inspector, a debug tool for engineers to browse `content.db` layer-by-layer
 * (since deleted — `/settings` was judged to cover the same rows on its own).
 * This screen DOES still borrow that debug tool's `.settings-body`/`.settings-row`/
 * `.settings-namespace-*` classes (true, unlike the old comment's framing of them as a deliberate
 * parity choice) — and that borrowing is exactly why the owner flagged this screen as looking worse
 * than `Posts.tsx`/`Media.tsx`/`Menus.tsx`: `.settings-body`'s grid permanently reserves a detail
 * column even with no term selected (a dead void `Posts.tsx`'s full-width `DataTable` never has),
 * `.settings-namespace-group`'s padding is tighter than `.card`'s, and `.settings-row-key`/
 * `.settings-detail-panel h2` render term/taxonomy names in `--font-mono` — correct for the ledger's
 * `namespace.key` strings, wrong for ordinary content names. Fixed below with three additive,
 * taxonomy-scoped overrides in `styles.css` (`taxonomy-namespace-group`/`taxonomy-term-list`/
 * `taxonomy-term-detail`) plus one JSX change (the detail column only renders once a term is
 * selected) — the base `.settings-*` rules in `styles.css` are left untouched, since the
 * now-deleted ledger tool's own two-pane layout and monospace keys were correct for what IT showed,
 * and this screen is now their only consumer.
 *
 * Scope note (disclosed): list/create-taxonomy/create-term/rename-term/assign-terms/merge-term are
 * backed by real routes; merge-term (ADR-044, SPEC-018 C-207) is wired to the real
 * `core/gated-mutations`-backed ceremony (Session 5-6 backend gap closure). Reparent and Deprecate
 * — named in design-spec.md §2.3/§2.4 — still have no route (`renameTerm`'s own route only accepts
 * `newName`, no `parentId`; no deprecate-term route was wired). Rather than render dead buttons for
 * those two, this screen omits them entirely.
 *
 * Also disclosed: the production `Term` type (`features/taxonomy/write-service.ts`) has no `slug`
 * field — design-spec.md §2.3 assumed one; this screen does not render a slug control.
 *
 * SPEC-037 REQ-02: `NewTaxonomyForm` wires the previously-unused `api.createTaxonomy` — a plain
 * name + hierarchical-toggle form above the taxonomy list, reusing `NewTermForm`'s shape.
 *
 * Web-design pass (2026-08-05): both create forms used to render permanently open, which is why
 * this screen read as heavier/different from every sibling list screen (`Media.tsx`,
 * `Comments.tsx`, `Menus.tsx`, `Integrations.tsx`) — those default to a compact list with the
 * create form collapsed behind a `.page-actions` header button (`Integrations.tsx`'s `formOpen`
 * idiom, reused verbatim here) or a small inline trigger. `NewTaxonomyForm` now follows that same
 * toggle idiom via `useTaxonomy`'s `formOpen`; each group's `NewTermForm` gets its own collapsed
 * trigger via `useNewTermForm`'s `open` (see that hook's own comment) since a taxonomy group has no
 * header slot to put a page-level toggle in. No new classes were introduced — this reuses
 * `.page-actions`/`.btn-secondary`/`.btn-ghost` exactly as `Integrations.tsx` does.
 *
 * Delete term/taxonomy (web-design pass, 2026-08-05): the owner's other complaint — dummy
 * categories/tags created to test creation, with no way to remove them — closes here through the
 * generic single-item Trash route. Both use the same
 * `RowMenu`("Delete …") → `ConfirmDialog` idiom `Media.tsx`/`Comments.tsx`/`Menus.tsx` already use
 * for their own destructive actions — no new interaction pattern introduced. State (the pending
 * row, the busy flag, and the *blocked* outcome) lives in `useTaxonomy`; see that hook's own comment
 * for why a 409 refusal is a distinct state from a hard failure. `deleteTermBlocked`/
 * `deleteTaxonomyBlocked` render as a scoped `.notice.error` inside the specific group whose term or
 * taxonomy was refused, naming the remedy (`rules.ts`'s `describeDeleteBlocked`) — never a silent
 * disabled control.
 */

export interface NewTermFormProps {
  taxonomy: AdminTaxonomyWithTerms;
  onCreated: () => void;
  /** This group's own distinct handle base — computed once, across every rendered group, by
   *  `namespaceList` (via `buildAgentListHandles`) and passed down; a `Set`-based uniqueness
   *  search only works when it runs once over the whole list, not once per `NewTermForm` instance. */
  agentBase: string;
  /** Dependency injection seam for tests — the same convention `@jini-ai/ui`'s `CustomSelect` uses
   *  for `useCustomSelect`. */
  useNewTermFormHook?: typeof useWiredNewTermForm;
  /** Translator closure — see `Taxonomy()`'s own `t`. */
  t: (key: string) => string;
}

function NewTermForm({ taxonomy, onCreated, agentBase: base, useNewTermFormHook = useWiredNewTermForm, t }: NewTermFormProps) {
  const { open, setOpen, name, setName, parentId, setParentId, error, saving, submit } = useNewTermFormHook({
    taxonomy,
    onCreated,
  });

  // Collapsed resting state — see this hook's own comment for why every group's form now starts
  // closed instead of permanently open. `.btn-ghost` (not `.btn-secondary`): this trigger sits
  // inline in the group's own flow, not in a `.page-actions` header slot, so it reads as a quiet
  // "add a row" affordance rather than a page-level action.
  if (!open) {
    return (
      <button
        type="button"
        className="btn-ghost taxonomy-add-term-trigger"
        onClick={() => setOpen(true)}
        {...agentHandle(`${base}-open`, {
          role: "button",
          label: `Open the "add term" form for the "${taxonomy.taxonomy.name}" taxonomy`,
        })}
      >
        {t("+ Add term")}
      </button>
    );
  }

  return (
    <form className="notice taxonomy-new-term-form" onSubmit={submit}>
      <label htmlFor={`new-term-name-${taxonomy.taxonomy.id}`}>
        {t("New term in {name}").replace("{name}", taxonomy.taxonomy.name)}
      </label>
      <span className="editor-actions">
        <input
          id={`new-term-name-${taxonomy.taxonomy.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("Term name")}
          autoFocus
          {...agentHandle(`${base}-name`, { role: "field", label: "The new term's name" })}
        />
        {taxonomy.taxonomy.hierarchical ? (
          <select
        aria-label={t("Parent term")}
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            {...agentHandle(`${base}-parent`, {
              role: "field",
              label: "The new term's parent term, or top level — set with page.select_option, not click",
            })}
          >
            <option value="">{t("(top level)")}</option>
            {taxonomy.terms.map((term) => (
              <option key={term.id} value={term.id}>
                {term.name}
              </option>
            ))}
          </select>
        ) : null}
        {/* Secondary — repeated once per taxonomy group, not this page's one headline create
            ("Create taxonomy" above owns that). */}
        <button
          type="submit"
          className="btn-secondary"
          disabled={saving}
          {...agentHandle(`${base}-submit`, { role: "button", label: "Add this term to the taxonomy" })}
        >
          {saving ? t("Saving…") : t("Add term")}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setOpen(false)}
          disabled={saving}
          {...agentHandle(`${base}-cancel`, { role: "button", label: "Close this form without adding a term" })}
        >
          {t("Cancel")}
        </button>
      </span>
      {error ? (
        <span className="save-error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

export interface NewTaxonomyFormProps {
  onCreated: () => void;
  useNewTaxonomyFormHook?: typeof useWiredNewTaxonomyForm;
  /** Translator closure — see `Taxonomy()`'s own `t`. */
  t: (key: string) => string;
}

/** New-taxonomy form (REQ-02) — name + hierarchical toggle, calling `api.createTaxonomy`. Mirrors
 * `NewTermForm`'s local-state/submit/error shape. */
function NewTaxonomyForm({ onCreated, useNewTaxonomyFormHook = useWiredNewTaxonomyForm, t }: NewTaxonomyFormProps) {
  const { name, setName, hierarchical, setHierarchical, error, saving, submit } = useNewTaxonomyFormHook({ onCreated });

  return (
    <form className="notice taxonomy-new-term-form" onSubmit={submit}>
      <label htmlFor="new-taxonomy-name">{t("New taxonomy")}</label>
      <span className="editor-actions">
        <input
          id="new-taxonomy-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("e.g. Category")}
          {...agentHandle("taxonomy-new-name", { role: "field", label: "The new taxonomy's name" })}
        />
        <label>
          <input
            type="checkbox"
            checked={hierarchical}
            onChange={(e) => setHierarchical(e.target.checked)}
            {...agentHandle("taxonomy-new-hierarchical", {
              role: "checkbox",
              label: "Whether this taxonomy's terms can be nested under a parent term",
            })}
          />
          {t("Hierarchical")}
        </label>
        {/* The one page-level primary — the entry point for the whole feature. Everything below
            (per-group "Add term", the merge wizard's "Plan"/"Confirm") is scoped and repeated
            rather than a single headline action, so those stay secondary; see their own comments. */}
        <button
          type="submit"
          disabled={saving}
          {...agentHandle("taxonomy-new-submit", { role: "button", label: "Create this taxonomy" })}
        >
          {saving ? t("Saving…") : t("Create taxonomy")}
        </button>
      </span>
      {error ? (
        <span className="save-error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

export interface MergeTermSectionProps {
  taxonomy: AdminTaxonomyWithTerms;
  term: AdminTerm;
  onMerged: () => void;
  useMergeTermSectionHook?: typeof useWiredMergeTermSection;
  /** Translator closure — see `Taxonomy()`'s own `t`. */
  t: (key: string) => string;
}

interface MergeIdleStepProps {
  otherTerms: AdminTerm[];
  intoTermId: string;
  setIntoTermId: (id: string) => void;
  busy: boolean;
  startPlan: () => void;
  t: (key: string) => string;
}

/** The "choose a target, Plan merge" step — extracted out of `MergeTermSection`, which was still
 *  13/13 after the file's first extraction pass (the three `step === "..."` branches' own content,
 *  including each step's `busy` label ternary, were still counted in its scope). Same
 *  "the step, not the wizard shell, was the actual size" split `Users.tsx`'s
 *  `UserRow` -> `UserManagePanel` already used. */
function MergeIdleStep({ otherTerms, intoTermId, setIntoTermId, busy, startPlan, t }: MergeIdleStepProps) {
  return (
    <span className="editor-actions">
      <select
        aria-label={t("Merge into")}
        value={intoTermId}
        onChange={(e) => setIntoTermId(e.target.value)}
        {...agentHandle("term-merge-target", {
          role: "field",
          label: "The term this one will be merged into — set with page.select_option, not click",
        })}
      >
        <option value="">{t("Choose a term…")}</option>
        {otherTerms.map((term) => (
          <option key={term.id} value={term.id}>
            {term.name}
          </option>
        ))}
      </select>
      {/* Secondary throughout this wizard's first two steps — planning/confirming a merge
          commits nothing yet ("nothing is merged yet" below), so neither reads as this
          screen's primary action. Only Execute (genuinely irreversible) escalates. */}
      <button
        type="button"
        className="btn-secondary"
        onClick={startPlan}
        disabled={!intoTermId || busy}
        {...agentHandle("term-merge-plan", {
          role: "button",
          label: "Plan the merge into the selected term — commits nothing yet",
        })}
      >
        {busy ? t("Planning…") : t("Plan merge")}
      </button>
    </span>
  );
}

interface MergePlannedStepProps {
  termName: string;
  overlappingContentCount: number;
  busy: boolean;
  doConfirm: () => void;
  t: (key: string) => string;
}

/** The "review the plan, Confirm merge" step — extracted out of `MergeTermSection`. */
function MergePlannedStep({ termName, overlappingContentCount, busy, doConfirm, t }: MergePlannedStepProps) {
  return (
    <div>
      <p>
        {t("This will move {count} overlapping content assignment(s) onto the target term and merge").replace(
          "{count}",
          String(overlappingContentCount),
        )}{" "}
        <strong>{termName}</strong> {t("away. Confirming issues a one-time execution token — nothing is merged yet.")}
      </p>
      <button
        type="button"
        className="btn-secondary"
        onClick={doConfirm}
        disabled={busy}
        {...agentHandle("term-merge-confirm", {
          role: "button",
          label: "Confirm the plan and issue a one-time execution token — still commits nothing",
        })}
      >
        {busy ? t("Confirming…") : t("Confirm merge")}
      </button>
    </div>
  );
}

interface MergeConfirmedStepProps {
  busy: boolean;
  doExecute: () => void;
  t: (key: string) => string;
}

/** The "confirmed, Execute merge" step — extracted out of `MergeTermSection`. */
function MergeConfirmedStep({ busy, doExecute, t }: MergeConfirmedStepProps) {
  return (
    <div>
      <p>{t("Confirmed. Executing merges the terms now — this cannot be undone.")}</p>
      {/* Genuinely irreversible, per the copy right above — `.btn-danger`, unlike Plan/Confirm. */}
      <button
        type="button"
        className="btn-danger"
        onClick={doExecute}
        disabled={busy}
        {...agentHandle("term-merge-execute", {
          role: "button",
          label: "Execute the merge now — this cannot be undone",
        })}
      >
        {busy ? t("Merging…") : t("Execute merge")}
      </button>
    </div>
  );
}

function MergeTermSection({ taxonomy, term, onMerged, useMergeTermSectionHook = useWiredMergeTermSection, t }: MergeTermSectionProps) {
  const otherTerms = otherMergeTargets(taxonomy, term.id);
  const { intoTermId, setIntoTermId, step, busy, error, plan, confirmationToken, startPlan, doConfirm, doExecute } = useMergeTermSectionHook({
    term,
    onMerged,
  });

  if (otherTerms.length === 0) return null;

  return (
    <div className="notice taxonomy-merge-section">
      <h3>{t("Merge into another term")}</h3>
      {error ? <span className="save-error">{error}</span> : null}

      {step === "idle" ? (
        <MergeIdleStep otherTerms={otherTerms} intoTermId={intoTermId} setIntoTermId={setIntoTermId} busy={busy} startPlan={startPlan} t={t} />
      ) : null}

      {step === "planned" && plan ? (
        <MergePlannedStep
          termName={term.name}
          overlappingContentCount={plan.overlappingContentCount}
          busy={busy}
          doConfirm={doConfirm}
          t={t}
        />
      ) : null}

      {step === "confirmed" && confirmationToken ? <MergeConfirmedStep busy={busy} doExecute={doExecute} t={t} /> : null}
    </div>
  );
}

export interface TermDetailPanelProps {
  taxonomy: AdminTaxonomyWithTerms;
  term: AdminTerm;
  onRenamed: () => void;
  onMerged: () => void;
  useTermDetailPanelHook?: typeof useWiredTermDetailPanel;
  /** Translator closure — see `Taxonomy()`'s own `t`. */
  t: (key: string) => string;
}

function TermDetailPanel({ taxonomy, term, onRenamed, onMerged, useTermDetailPanelHook = useWiredTermDetailPanel, t }: TermDetailPanelProps) {
  const { newName, setNewName, saving, message, error, rename } = useTermDetailPanelHook({ term, onRenamed });

  return (
    <div className="settings-detail-panel taxonomy-term-detail">
      <h2>{term.name}</h2>
      <p className="muted-cell">{taxonomy.taxonomy.name}</p>
      <div className="settings-layer-grid">
        <div className="settings-layer-cell">
          <span className="settings-layer-label">{t("Status")}</span>
          <span className={`status status-${term.status}`}><ServerLabel value={term.status} /></span>
        </div>
        <div className="settings-layer-cell">
          <span className="settings-layer-label">{t("Parent")}</span>
          <span>
            {term.parentId ? taxonomy.terms.find((candidate) => candidate.id === term.parentId)?.name ?? term.parentId : "—"}
          </span>
        </div>
        <div className="settings-layer-cell">
          <span className="settings-layer-label">{t("Version")}</span>
          <span>{term.version}</span>
        </div>
      </div>
      <form onSubmit={rename} className="collections-field-row">
        <label htmlFor="term-rename-input">{t("Rename")}</label>
        <input
          id="term-rename-input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          {...agentHandle("term-detail-rename", { role: "field", label: "This term's new name" })}
        />
        <span className="editor-actions">
          <button
            type="submit"
            className="btn-secondary"
            disabled={saving}
            {...agentHandle("term-detail-rename-save", { role: "button", label: "Save this term's new name" })}
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
          {message ? <span className="save-ok">{message}</span> : null}
          {error ? <span className="save-error">{error}</span> : null}
        </span>
      </form>
      <MergeTermSection taxonomy={taxonomy} term={term} onMerged={onMerged} t={t} />
    </div>
  );
}

export interface TaxonomyProps {
  /** Dependency injection seam for tests — the same convention `@jini-ai/ui`'s `CustomSelect` uses
   *  for `useCustomSelect`. Defaulted to the real hook, so production callers (`panels.tsx`) pass
   *  nothing and behave exactly as before. */
  useTaxonomyHook?: typeof useWiredTaxonomy;
}

interface TaxonomyPageHeaderProps {
  formOpen: boolean;
  setFormOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  t: (key: string) => string;
}

/** The page title plus the "New taxonomy"/"Cancel" toggle button — extracted from `Taxonomy`
 *  verbatim, same reason `Users.tsx`'s `UsersPageHeader` split off its own `formOpen` ternaries:
 *  `Taxonomy` was still 13/10 (cyclomatic over the ceiling) with them inline. */
function TaxonomyPageHeader({ formOpen, setFormOpen, t }: TaxonomyPageHeaderProps) {
  return (
    <div
      className="page-header"
      {...agentHandle("taxonomy-header", {
        role: "region",
        label: "Categories & Tags header — page title and the New taxonomy button",
      })}
    >
      <div className="page-header-text">
        <p className="page-kicker">{t("Content")}</p>
        <h1 className="page-title">{t("Categories & Tags")}</h1>
        <p className="page-description">
          {t("Organize content with taxonomies and terms — categories, tags, and any custom hierarchy you define.")}
        </p>
      </div>
      {/* Same `formOpen` toggle idiom as `Integrations.tsx`'s "Add webhook" button — see
          `useTaxonomy`'s own comment for why this replaced the old always-open form. */}
      <div className="page-actions">
        <PublishSectionButton section="categories" />
        <button
          className={formOpen ? "btn-secondary" : undefined}
          onClick={() => setFormOpen((v) => !v)}
          {...agentHandle("taxonomy-new-toggle", {
            role: "button",
            label: "Open or close the new-taxonomy form",
          })}
        >
          {formOpen ? t("Cancel") : t("New taxonomy")}
        </button>
      </div>
    </div>
  );
}

interface TermDeleteDialogProps {
  pendingDeleteTerm: AdminTerm | null;
  deleteTermBusy: boolean;
  confirmDeleteTerm: () => Promise<void>;
  requestDeleteTerm: (term: AdminTerm | null) => void;
  t: (key: string) => string;
}

/** The term-delete confirm dialog — extracted from `Taxonomy` verbatim. */
function TermDeleteDialog({ pendingDeleteTerm, deleteTermBusy, confirmDeleteTerm, requestDeleteTerm, t }: TermDeleteDialogProps) {
  return (
    <ConfirmDialog
      open={pendingDeleteTerm !== null}
      agentHandle="taxonomy-delete-term"
      title={t("Move to trash?")}
      body={
        pendingDeleteTerm ? (
          <p>{t('Move "{name}" to trash?').replace("{name}", pendingDeleteTerm.name)}</p>
        ) : null
      }
      confirmLabel={t("Move to trash")}
      destructive
      pending={deleteTermBusy}
      onConfirm={confirmDeleteTerm}
      onCancel={() => requestDeleteTerm(null)}
    />
  );
}

interface TaxonomyDeleteDialogProps {
  pendingDeleteTaxonomy: AdminTaxonomy | null;
  deleteTaxonomyBusy: boolean;
  confirmDeleteTaxonomy: () => Promise<void>;
  requestDeleteTaxonomy: (taxonomy: AdminTaxonomy | null) => void;
  t: (key: string) => string;
}

/** The taxonomy-delete confirm dialog — extracted from `Taxonomy` verbatim. */
function TaxonomyDeleteDialog({
  pendingDeleteTaxonomy,
  deleteTaxonomyBusy,
  confirmDeleteTaxonomy,
  requestDeleteTaxonomy,
  t,
}: TaxonomyDeleteDialogProps) {
  return (
    <ConfirmDialog
      open={pendingDeleteTaxonomy !== null}
      agentHandle="taxonomy-delete-taxonomy"
      title={t("Move to trash?")}
      body={
        pendingDeleteTaxonomy ? (
          <p>
            {t('Move "{name}" and its terms to trash?').replace(
              "{name}",
              pendingDeleteTaxonomy.name,
            )}
          </p>
        ) : null
      }
      confirmLabel={t("Move to trash")}
      destructive
      pending={deleteTaxonomyBusy}
      onConfirm={confirmDeleteTaxonomy}
      onCancel={() => requestDeleteTaxonomy(null)}
    />
  );
}

export function Taxonomy({ useTaxonomyHook = useWiredTaxonomy }: TaxonomyProps = {}) {
  const {
    taxonomies,
    error,
    selectedTermId,
    setSelectedTermId,
    selected,
    load,
    formOpen,
    setFormOpen,
    pendingDeleteTerm,
    requestDeleteTerm,
    deleteTermBusy,
    deleteTermBlocked,
    confirmDeleteTerm,
    pendingDeleteTaxonomy,
    requestDeleteTaxonomy,
    deleteTaxonomyBusy,
    deleteTaxonomyBlocked,
    confirmDeleteTaxonomy,
    t,
  } = useTaxonomyHook();
  const deleteState = { requestDeleteTerm, deleteTermBlocked, requestDeleteTaxonomy, deleteTaxonomyBlocked };

  if (error && !taxonomies) return <div className="notice error">{error}</div>;
  if (!taxonomies) return <div className="notice">{t("Loading taxonomies…")}</div>;

  return (
    <div className="page">
      <TaxonomyPageHeader formOpen={formOpen} setFormOpen={setFormOpen} t={t} />
      {error ? <div className="notice error">{error}</div> : null}

      {formOpen ? (
        <NewTaxonomyForm
          onCreated={() => {
            load();
            setFormOpen(false);
          }}
          t={t}
        />
      ) : null}

      {/* Web-design pass (2026-08-05): `.settings-body` is the raw ledger's permanent two-column
          grid (`minmax(16rem,1.1fr) minmax(20rem,1.4fr)`) — reserving that second column even with
          no `selected` term left a large dead void on this screen (the concrete defect the owner
          was seeing). Only wrapping in `.settings-body` once a term IS selected means the list
          renders full-width the rest of the time, matching every reference page's full-width
          content instead of a permanently-split master/detail pane. See this file's own header
          comment for the fuller diagnosis. */}
      {selected ? (
        <div className="settings-body">
          {namespaceList(taxonomies, selectedTermId, setSelectedTermId, load, deleteState, t)}
          <TermDetailPanel
            taxonomy={selected.taxonomy}
            term={selected.term}
            onRenamed={load}
            onMerged={() => {
              setSelectedTermId(null);
              load();
            }}
            t={t}
          />
        </div>
      ) : (
        namespaceList(taxonomies, selectedTermId, setSelectedTermId, load, deleteState, t)
      )}

      <TermDeleteDialog
        pendingDeleteTerm={pendingDeleteTerm}
        deleteTermBusy={deleteTermBusy}
        confirmDeleteTerm={confirmDeleteTerm}
        requestDeleteTerm={requestDeleteTerm}
        t={t}
      />
      <TaxonomyDeleteDialog
        pendingDeleteTaxonomy={pendingDeleteTaxonomy}
        deleteTaxonomyBusy={deleteTaxonomyBusy}
        confirmDeleteTaxonomy={confirmDeleteTaxonomy}
        requestDeleteTaxonomy={requestDeleteTaxonomy}
        t={t}
      />
    </div>
  );
}

/** Extracted so both branches above (two-column with a detail panel, or full-width alone) render
 *  the exact same list markup — see the `selected ? … : …` comment for why there are two branches
 *  at all. `taxonomy-namespace-group`/`taxonomy-term-list` are additive classes (see `styles.css`'s
 *  own comment on that block) that converge this list's padding and type on the reference idiom
 *  without touching the shared `.settings-*` base rules, kept as originally defined for the
 *  since-deleted `settings-raw/Settings.tsx`.
 *
 * `deleteState` (web-design pass, 2026-08-05): bundles the five `useTaxonomy` fields this list needs
 * to offer "Delete taxonomy"/"Delete term" and show a blocked-delete reason — passed as one object
 * rather than five more positional params now that this function's signature already has four.
 *
 * The `buildAgentListHandles`/`Map` calls below are not `useMemo`d: this is a plain helper, not a
 * component (it is called conditionally from the `selected ? … : …` branch in `Taxonomy`'s render),
 * so it has no hook access to begin with. Each call is O(n) over one operator's own taxonomies/terms
 * (see `buildAgentListHandles`'s own `@complexity` doc) — cheap enough next to the list render it
 * feeds that hoisting the computation up into `Taxonomy` to memoize it was not judged worth the
 * added indirection. */
function namespaceList(
  taxonomies: AdminTaxonomyWithTerms[],
  selectedTermId: string | null,
  setSelectedTermId: (id: string) => void,
  load: () => void,
  deleteState: {
    requestDeleteTerm: (term: AdminTerm | null) => void;
    deleteTermBlocked: { termId: string; state: DeleteBlockedState } | null;
    requestDeleteTaxonomy: (taxonomy: AdminTaxonomy | null) => void;
    deleteTaxonomyBlocked: { taxonomyId: string; state: DeleteBlockedState } | null;
  },
  t: (key: string) => string,
) {
  // Computed once, across every group, so two taxonomies whose names slugify identically still get
  // distinct handles — see `NewTermForm`'s own `agentBase` doc for why this cannot be derived
  // independently inside each group's own `NewTermForm` instance.
  const newTermFormBases = buildAgentListHandles(
    "taxonomy-new-term",
    taxonomies.map((group) => group.taxonomy.id),
  );
  // Same id list as `newTermFormBases` above, so a taxonomy's "Delete taxonomy" menu handle and its
  // "+ Add term" form handle share the same id-derived slug (e.g. `taxonomy-new-term-tax-a-open` /
  // `taxonomy-menu-tax-a`) — an agent reading `page.find_elements` can tell they belong to the same
  // group without cross-referencing anything else. `RowMenu`'s `agentHandle` prop only reached this
  // package this session; before that, this menu (and the per-term one below) published no handle at
  // all and its trigger/items were invisible to `page.find_elements` regardless of what this file did.
  const taxonomyMenuHandles = buildAgentListHandles(
    "taxonomy-menu",
    taxonomies.map((group) => group.taxonomy.id),
  );
  // Term ids are globally unique across every taxonomy, not scoped per group — same reasoning
  // `CollectionEntryEditor.tsx`'s `TermPicker` documents for its own flat `term-picker-term` list.
  const termHandles = buildAgentListHandles(
    "taxonomy-term",
    taxonomies.flatMap((group) => group.terms.map((term) => term.id)),
  );
  let termHandleIndex = 0;

  return (
    <div className="settings-namespace-list">
      {taxonomies.map((group, groupIndex) => {
        const byId = new Map(group.terms.map((term) => [term.id, term]));
        return (
          <section key={group.taxonomy.id} className="settings-namespace-group taxonomy-namespace-group">
            <div className="taxonomy-namespace-group-header">
              <h2>{group.taxonomy.name}</h2>
              <RowMenu
                triggerLabel={t('Actions for taxonomy "{name}"').replace("{name}", group.taxonomy.name)}
                agentHandle={taxonomyMenuHandles[groupIndex]}
                items={[
                  {
                    key: "delete",
                    label: t("Delete taxonomy"),
                    destructive: true,
                    onSelect: () => deleteState.requestDeleteTaxonomy(group.taxonomy),
                  },
                ]}
              />
            </div>
            {deleteState.deleteTaxonomyBlocked?.taxonomyId === group.taxonomy.id ? (
              <p className="notice error" role="alert">
                {t("Can't delete")} &quot;{group.taxonomy.name}&quot;: {deleteState.deleteTaxonomyBlocked.state.message}
              </p>
            ) : null}
            {group.terms.length === 0 ? (
              <p className="muted-cell">{t("No terms yet.")}</p>
            ) : (
              /* `<ul>` carries native list semantics on its own — no explicit `role="list"` needed
                 (it was redundant even before the row fix below). Left off entirely now rather than
                 kept: an explicit `list` role formally expects `listitem`-family children, and each
                 row below is now `role="button"` (see that comment), so an explicit `role="list"`
                 here would assert a parent/child relationship that no longer holds. */
              <ul className="settings-row-list taxonomy-term-list">
                {group.terms.map((term) => {
                  const depth = group.taxonomy.hierarchical ? termDepth({ term, byId }) : 0;
                  // Gated on `hierarchical` for the same reason `depth` is: a term's `parentId` can
                  // still be set on a taxonomy that has since been switched to flat (or seeded with
                  // one before hierarchical mode existed), and this row renders with zero
                  // indentation either way. Without this gate the `aria-label` below announced a
                  // "subcategory of" relationship a screen-reader user could not corroborate from
                  // the (unindented) visual layout — an accessibility mismatch between the two
                  // channels describing the same row.
                  const parentName =
                    group.taxonomy.hierarchical && term.parentId ? byId.get(term.parentId)?.name : undefined;
                  // Consumed in rendered (group, then term) order, matching how `termHandles` was
                  // built above via the identical `flatMap` order.
                  const termHandle = termHandles[termHandleIndex];
                  termHandleIndex += 1;
                  return (
                    <li
                      key={term.id}
                      // `role="button"` (audit finding, not "listitem"): this row is independently
                      // focusable (`tabIndex={0}`) and Enter/Space-activatable below — the exact
                      // keyboard contract WAI-ARIA defines for a button, not a passive list member.
                      // `aria-selected` used to sit here too, but `aria-selected` is only defined for
                      // `option`/`row`/`gridcell`/`tab`/`treeitem`-family roles — on `listitem` (and
                      // still on `button`) it is simply dropped by the accessible-name/state
                      // computation, so no screen reader or accessibility-tree consumer ever saw this
                      // row's selected state (verified: `getAllByRole("listitem", { selected: true })`
                      // throws `"aria-selected" is not supported on role "listitem"` — the existing
                      // test only ever asserted the raw attribute string, not the computed state).
                      // `aria-current` is the correct fit instead — a global state, valid on `button`,
                      // meaning "the current item in a set" — and needs no matching `listbox`/`option`
                      // composite-widget conversion, which would additionally imply a roving-tabindex
                      // keyboard model this row does not (and, given every row is independently
                      // tabbable today, should not) implement.
                      role="button"
                      className={`settings-row${selectedTermId === term.id ? " is-selected" : ""}`}
                      style={depth > 0 ? { marginLeft: `${depth * 1.1}rem` } : undefined}
                      // Explicit now in EVERY case, not only the `parentName` branch: making this
                      // row a real `role="button"` (above) means its name-from-content computation
                      // now matters, and it was garbled — concatenating the term-name span and the
                      // adjacent status span with no separator (verified live: "Selected Termactive"
                      // for a term named "Selected Term" with status "active"). An explicit
                      // `aria-label` is the fix either way, so the `parentName` case no longer needs
                      // to be the only one that sets it.
                      aria-label={parentName ? `${term.name}, subcategory of ${parentName}` : term.name}
                      onClick={() => setSelectedTermId(term.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedTermId(term.id);
                        }
                      }}
                      tabIndex={0}
                      aria-current={selectedTermId === term.id ? "true" : undefined}
                    >
                      {/* The handle sits on this `<span>`, not the `<li>` it lives inside: the `<li>`
                          also contains the RowMenu trigger button below as a descendant, and
                          `controlOf`'s wrapper-descent (`element-handles.ts` in `@jini-ai/agentic`)
                          would adopt that unrelated, unpublished button as "the control" for any
                          handle placed on an ancestor that contains it — silently turning
                          `page.click` on this row into "open the row menu" instead of "select this
                          term". A plain `<span>` has no such descendant, so `page.click`'s
                          `.click()` call on it bubbles a real click event up to the `<li>`'s own
                          `onClick`, exactly as a user's click would. */}
                      <span
                        className="settings-row-key"
                        {...agentHandle(termHandle, {
                          role: "button",
                          label: "Select this term to view and edit its details",
                        })}
                      >
                        {term.name}
                      </span>
                      <span className={`status status-${term.status}`}><ServerLabel value={term.status} /></span>
                      {/* Stops the click before it reaches the `<li>`'s own `onClick` above — without
                          this, opening the row menu (or picking an item in it) would ALSO select the
                          row and pop the detail panel open behind the menu, since this trigger sits
                          inside a listitem that is itself a click target. No other screen in this app
                          combines a `RowMenu` with a click-to-select row, so there was no existing
                          precedent to follow here. */}
                      <span onClick={(e) => e.stopPropagation()}>
                        <RowMenu
                          triggerLabel={t('Actions for term "{name}"').replace("{name}", term.name)}
                          agentHandle={`${termHandle}-menu`}
                          items={[
                            {
                              key: "delete",
                              label: t("Delete term"),
                              destructive: true,
                              onSelect: () => deleteState.requestDeleteTerm(term),
                            },
                          ]}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {deleteState.deleteTermBlocked && byId.has(deleteState.deleteTermBlocked.termId) ? (
              <p className="notice error" role="alert">
                {t("Can't delete")} &quot;{byId.get(deleteState.deleteTermBlocked.termId)?.name}&quot;:{" "}
                {deleteState.deleteTermBlocked.state.message}
              </p>
            ) : null}
            <NewTermForm taxonomy={group} onCreated={load} agentBase={newTermFormBases[groupIndex]!} t={t} />
          </section>
        );
      })}
    </div>
  );
}
