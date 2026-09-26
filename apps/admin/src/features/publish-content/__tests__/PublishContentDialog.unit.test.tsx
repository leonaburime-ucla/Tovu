import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PublishContentReport, PublishCriteria, PublishRequestResult, PublishScope } from "@tovu/publish-content-ui";

import { ApiError } from "@/lib/api";

import { PublishContentDialog } from "../PublishContentDialog";
import { createFakePublishContentPort } from "../hooks/publish-content-dependencies.hooks";
import { usePublishContentConfirm } from "../hooks/use-publish-content-confirm.hooks";

/**
 * @file `PublishContentDialog` — plan §4 task 11's two acceptance criteria, asserted against the
 * rendered dialog:
 *
 * 1. **a conflict row renders its reason and is not selectable for silent apply**, and
 * 2. **the dialog cannot fire execute without a confirmed plan.**
 *
 * Both are asserted through what the operator can actually see and click plus what the port
 * actually received — never through the hook's internal state — so an implementation that renders
 * the right words while calling the wrong endpoint still fails. Both were confirmed RED against a
 * deliberately broken implementation before this file was accepted (`conflict` mapped to `publish`
 * in `report-rows.ts`, and `executePublish` called with a hardcoded token).
 *
 * Harness follows `features/dashboard/__tests__/Dashboard.unit.test.tsx` (RTL, no server), except
 * that the network is replaced at the PORT rather than at `fetch`. The port seam was what let this dialog be built while
 * Task 10's peer routes were still being written; it stays because a URL mock would assert on
 * `lib/api.ts`'s path building rather than on the dialog's own behaviour — see
 * `hooks/publish-content-port.hooks.ts`.
 */

const t = (key: string) => key;

const ONE_PEER = [
  {
    id: "peer-prod",
    label: "tovu.com (production)",
    baseUrl: "https://tovu.com",
    remoteWorkspaceId: "workspace-local",
    masked: "tvp_…8f2a",
    hasCredential: true,
  },
] as const;

const CONFLICT_REASON = "destination hash differs from both source and baseline — it was edited there";

const MIXED_REPORT: PublishContentReport = {
  refused: false,
  refusalReason: null,
  applyOrder: ["media", "post"],
  rows: [
    { entityType: "post", entityId: "post-new", outcome: "created", writes: true, reason: null },
    { entityType: "post", entityId: "post-edited-there", outcome: "conflict", writes: false, reason: CONFLICT_REASON },
    { entityType: "media", entityId: "media-same", outcome: "unchanged", writes: false, reason: null },
  ],
};

/**
 * A plan with more than one publishable row, so "some are checked" is a state that can exist at all
 * — `MIXED_REPORT` above has exactly one and is deliberately left untouched, since the assertions
 * around it are about the conflict row rather than about selection.
 *
 * `media-no-label` carries no `entityLabel` on purpose: it is the older-peer / unnamed-entity case,
 * and it proves the entity column falls back to a SHORT id rather than the full uuid.
 */
const SELECTION_REPORT: PublishContentReport = {
  refused: false,
  refusalReason: null,
  applyOrder: ["media", "post"],
  rows: [
    { entityType: "post", entityId: "11111111-aaaa-4aaa-8aaa-111111111111", entityLabel: "hello-world", outcome: "created", writes: true, reason: null },
    { entityType: "post", entityId: "22222222-bbbb-4bbb-8bbb-222222222222", entityLabel: "about-us", outcome: "applied", writes: true, reason: null },
    { entityType: "media", entityId: "33333333-cccc-4ccc-8ccc-333333333333", outcome: "created", writes: true, reason: null },
    { entityType: "media", entityId: "44444444-dddd-4ddd-8ddd-444444444444", entityLabel: "logo-png", outcome: "unchanged", writes: false, reason: null },
    { entityType: "post", entityId: "55555555-eeee-4eee-8eee-555555555555", entityLabel: "edited-there", outcome: "conflict", writes: false, reason: CONFLICT_REASON },
  ],
};

const HELLO_WORLD = "11111111-aaaa-4aaa-8aaa-111111111111";
const ABOUT_US = "22222222-bbbb-4bbb-8bbb-222222222222";
const UNNAMED_MEDIA = "33333333-cccc-4ccc-8ccc-333333333333";

function renderDialog(port: ReturnType<typeof createFakePublishContentPort>, extra?: { scope?: PublishScope }) {
  return render(<PublishContentDialog onCancel={() => {}} t={t} port={port} scope={extra?.scope} />);
}

/** The dialog's own `<h2>` — plan-publish-sections-2026-09-25.md §2 S2's title. */
function dialogTitle(): string | null {
  return document.querySelector(".settings-dialog h2")?.textContent ?? null;
}

/** The dialog's single forward control, whatever its label currently is. */
function primaryButton(): HTMLButtonElement {
  const button = document.querySelector(".settings-dialog .btn-primary");
  if (!button) throw new Error("the publish dialog has no primary button");
  return button as HTMLButtonElement;
}

function reportRow(entityId: string): HTMLElement {
  const row = document.querySelector(`tr[data-entity-id="${entityId}"]`);
  if (!row) throw new Error(`no report row for "${entityId}"`);
  return row as HTMLElement;
}

/** The one checkbox inside a report row, or `null` when that row offers none. */
function rowCheckbox(entityId: string): HTMLInputElement | null {
  return reportRow(entityId).querySelector("input[type=checkbox]");
}

/** The header's check-everything control. */
function headerCheckbox(): HTMLInputElement {
  const box = document.querySelector("thead input[type=checkbox]");
  if (!box) throw new Error("the report table has no header checkbox");
  return box as HTMLInputElement;
}

/** Same as {@link planFrom}, but with a `scope` prop threaded to the dialog — plan-publish-sections
 *  §2 S2's scoped-plan tests. */
async function planFromScoped(port: ReturnType<typeof createFakePublishContentPort>, scope: PublishScope) {
  const user = userEvent.setup();
  renderDialog(port, { scope });
  await waitFor(() => expect(port.calls.listPeers).toBe(1));
  await user.click(primaryButton());
  await screen.findByRole("table");
  return user;
}

async function planFrom(port: ReturnType<typeof createFakePublishContentPort>) {
  const user = userEvent.setup();
  renderDialog(port);
  await waitFor(() => expect(port.calls.listPeers).toBe(1));
  await user.click(primaryButton());
  await screen.findByRole("table");
  return user;
}

describe("PublishContentDialog — a conflict row is reported, never silently applied", () => {
  it("renders the conflict's own reason text", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    await planFrom(port);

    expect(within(reportRow("post-edited-there")).getByText(CONFLICT_REASON)).toBeTruthy();
  });

  it("marks the conflict row skipped and gives it no control that could publish it", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    await planFrom(port);

    const conflict = reportRow("post-edited-there");
    expect(conflict.getAttribute("data-publish-disposition")).toBe("skipped");
    expect(within(conflict).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(conflict).queryAllByRole("button")).toHaveLength(0);
    expect(within(conflict).getByText("Skipped")).toBeTruthy();

    // The contrast that makes the assertion above mean something: a row that DOES publish is
    // labelled as such in the same table, so "skipped" is a real distinction, not the only state.
    expect(reportRow("post-new").getAttribute("data-publish-disposition")).toBe("publish");
  });

  it("excludes the conflict from the count the publish button commits to", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    await planFrom(port);

    expect(primaryButton().textContent).toBe("Publish 1 item");
  });

  it("never sends the conflicted entity anywhere — execute carries only the bundle and the token", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    const user = await planFrom(port);

    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));
    expect(port.calls.executePublish[0]).toEqual({ peerId: "peer-prod", bundleId: "fake-bundle", confirmationToken: "fake-token" });
  });
});

describe("PublishContentDialog — execute is gated on a confirmed plan", () => {
  it("does not call plan, confirm or execute merely by opening", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    renderDialog(port);
    await waitFor(() => expect(port.calls.listPeers).toBe(1));

    expect(port.calls.planPublish).toHaveLength(0);
    expect(port.calls.confirmPublish).toHaveLength(0);
    expect(port.calls.executePublish).toHaveLength(0);
  });

  it("plans on the first click and executes nothing", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    await planFrom(port);

    expect(port.calls.planPublish).toEqual([{ peerId: "peer-prod" }]);
    expect(port.calls.confirmPublish).toHaveLength(0);
    expect(port.calls.executePublish).toHaveLength(0);
  });

  it("never executes when confirm fails, and says why", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: MIXED_REPORT,
      confirmError: new Error("principal 'user-1' is not authorized for 'publish_content.apply'"),
    });
    const user = await planFrom(port);

    await user.click(primaryButton());
    await screen.findByText("principal 'user-1' is not authorized for 'publish_content.apply'");

    expect(port.calls.confirmPublish).toHaveLength(1);
    expect(port.calls.executePublish).toHaveLength(0);
  });

  it("executes with exactly the token confirm returned, against the planned peer", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: MIXED_REPORT,
      bundleId: "bundle-from-plan",
      confirmationToken: "tok-from-server",
      executeResult: { restorePointId: "rp-9", runId: "run-9", changeSetIds: ["cs-1", "cs-2"] },
    });
    const user = await planFrom(port);

    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));

    expect(port.calls.confirmPublish).toEqual([{ peerId: "peer-prod", planId: "fake-plan", planHash: "fake-plan-hash" }]);
    expect(port.calls.executePublish).toEqual([
      { peerId: "peer-prod", bundleId: "bundle-from-plan", confirmationToken: "tok-from-server" },
    ]);
    expect(await screen.findByText("Published 2 changes.")).toBeTruthy();
  });

  it("offers no forward control at all when the plan would write nothing", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: {
        refused: false,
        refusalReason: null,
        applyOrder: ["post"],
        rows: [{ entityType: "post", entityId: "p1", outcome: "conflict", writes: false, reason: CONFLICT_REASON }],
      },
    });
    const user = await planFrom(port);

    expect(primaryButton().disabled).toBe(true);
    await user.click(primaryButton());
    expect(port.calls.confirmPublish).toHaveLength(0);
    expect(port.calls.executePublish).toHaveLength(0);
  });

  it("refuses a refused plan outright and shows the refusal reason", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: {
        refused: true,
        refusalReason: "these two instances are on different content-hash versions; upgrade the older one",
        applyOrder: [],
        rows: [],
      },
    });
    const user = userEvent.setup();
    renderDialog(port);
    await waitFor(() => expect(port.calls.listPeers).toBe(1));
    await user.click(primaryButton());

    await screen.findByText("these two instances are on different content-hash versions; upgrade the older one");
    expect(primaryButton().disabled).toBe(true);
    expect(port.calls.confirmPublish).toHaveLength(0);
    expect(port.calls.executePublish).toHaveLength(0);
  });
});

describe("PublishContentDialog — the rest of the surface", () => {
  it("no longer claims publishing is unavailable", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    const { container } = renderDialog(port);
    await waitFor(() => expect(port.calls.listPeers).toBe(1));

    expect(container.querySelector(".notice.warning")).toBeNull();
    expect(screen.queryByText(/Not available yet/)).toBeNull();
  });

  it("offers no connect action and stays disabled when nothing is deployed to connect to", async () => {
    // The fake's default `getDestination()` result (no `destination` override) is the honest-floor
    // response: a fresh install that has never deployed, so there is no candidate to pre-fill.
    const port = createFakePublishContentPort({ peers: [] });
    renderDialog(port);

    await screen.findByText("No live site is set up yet. Deploy this site once, then come back here.");
    expect(primaryButton().disabled).toBe(true);
    expect(primaryButton().textContent).toBe("Connect");
    expect(port.calls.planPublish).toHaveLength(0);
    expect(port.calls.connectDestination).toHaveLength(0);
  });

  it("offers a one-click connect, pre-filled from deploy config, when nothing is configured yet", async () => {
    const port = createFakePublishContentPort({
      peers: [],
      destination: {
        connected: false,
        site: null,
        candidateUrl: "https://tovu.dev",
        message: "Publish to tovu.dev?",
        nextStep: null,
      },
      report: MIXED_REPORT,
    });
    const user = userEvent.setup();
    renderDialog(port);

    await screen.findByText("Publish to tovu.dev?");
    expect(primaryButton().disabled).toBe(false);
    expect(primaryButton().textContent).toBe("Connect");

    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.connectDestination).toHaveLength(1));

    // Connecting folds straight into planning against the newly connected peer — no second click to
    // "confirm" the connection itself, and no separate settings screen involved anywhere.
    await screen.findByRole("table");
    expect(port.calls.planPublish).toEqual([{ peerId: "peer-connected" }]);
  });

  it("reports a failed connect without stranding the dialog, and lets the operator retry", async () => {
    const port = createFakePublishContentPort({
      peers: [],
      destination: {
        connected: false,
        site: null,
        candidateUrl: "https://tovu.dev",
        message: "Publish to tovu.dev?",
        nextStep: null,
      },
      connectError: new Error("could not reach tovu.dev"),
    });
    const user = userEvent.setup();
    renderDialog(port);

    await screen.findByText("Publish to tovu.dev?");
    await user.click(primaryButton());

    await screen.findByText("could not reach tovu.dev");
    expect(primaryButton().disabled).toBe(false);
    expect(primaryButton().textContent).toBe("Connect");
    expect(port.calls.planPublish).toHaveLength(0);
  });

  it("surfaces a failed plan without stranding the dialog", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, planError: new Error("PLAN_STALE") });
    const user = userEvent.setup();
    renderDialog(port);
    await waitFor(() => expect(port.calls.listPeers).toBe(1));

    await user.click(primaryButton());
    await screen.findByText("PLAN_STALE");
    expect(primaryButton().disabled).toBe(false);
  });
});

describe("PublishContentDialog — the entity column names entities, never uuids", () => {
  it("shows the entity's own slug, keeping the id reachable as a tooltip", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    await planFrom(port);

    const cell = reportRow(HELLO_WORLD).querySelectorAll("td")[2];
    expect(cell.textContent).toBe("hello-world");
    expect(cell.getAttribute("title")).toBe(HELLO_WORLD);
    // The regression this column exists to close: the full uuid was the visible text.
    expect(cell.textContent).not.toBe(HELLO_WORLD);
  });

  it("falls back to a short id, never the whole uuid, for an entity with no human name", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    await planFrom(port);

    const cell = reportRow(UNNAMED_MEDIA).querySelectorAll("td")[2];
    expect(cell.textContent).toBe("33333333");
  });
});

describe("PublishContentDialog — per-row selection", () => {
  it("checks every publishable row by default, and offers no control on the rows it would not write", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    await planFrom(port);

    expect(rowCheckbox(HELLO_WORLD)?.checked).toBe(true);
    expect(rowCheckbox(ABOUT_US)?.checked).toBe(true);
    expect(rowCheckbox(UNNAMED_MEDIA)?.checked).toBe(true);
    // Not a disabled checkbox — no checkbox at all, for both non-writing dispositions.
    expect(rowCheckbox("44444444-dddd-4ddd-8ddd-444444444444")).toBeNull();
    expect(rowCheckbox("55555555-eeee-4eee-8eee-555555555555")).toBeNull();
    expect(headerCheckbox().checked).toBe(true);
    expect(headerCheckbox().indeterminate).toBe(false);
  });

  it("follows the selection in the count the button commits to", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    const user = await planFrom(port);
    expect(primaryButton().textContent).toBe("Publish 3 items");

    await user.click(rowCheckbox(ABOUT_US)!);
    expect(primaryButton().textContent).toBe("Publish 2 items");

    await user.click(rowCheckbox(UNNAMED_MEDIA)!);
    expect(primaryButton().textContent).toBe("Publish 1 item");
  });

  it("puts the header checkbox in the indeterminate state while only some rows are checked", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    const user = await planFrom(port);

    await user.click(rowCheckbox(ABOUT_US)!);
    expect(headerCheckbox().checked).toBe(false);
    expect(headerCheckbox().indeterminate).toBe(true);
  });

  it("clears and restores the whole selection from the header checkbox", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    const user = await planFrom(port);

    await user.click(headerCheckbox());
    expect(rowCheckbox(HELLO_WORLD)?.checked).toBe(false);
    expect(rowCheckbox(ABOUT_US)?.checked).toBe(false);
    expect(primaryButton().textContent).toBe("Nothing to publish");
    expect(primaryButton().disabled).toBe(true);

    await user.click(headerCheckbox());
    expect(rowCheckbox(HELLO_WORLD)?.checked).toBe(true);
    expect(primaryButton().textContent).toBe("Publish 3 items");
    expect(primaryButton().disabled).toBe(false);
  });

  it("publishes nothing at all while every row is unchecked", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    const user = await planFrom(port);

    await user.click(headerCheckbox());
    await user.click(primaryButton());

    expect(port.calls.planPublish).toHaveLength(1);
    expect(port.calls.confirmPublish).toHaveLength(0);
    expect(port.calls.executePublish).toHaveLength(0);
  });
});

describe("PublishContentDialog — a deselected row never reaches the destination", () => {
  it("re-plans against only the checked rows, then confirms and executes THAT plan", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    const user = await planFrom(port);

    await user.click(rowCheckbox(ABOUT_US)!);
    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));

    // The narrowed plan names exactly the rows left checked — the deselected entity is not in the
    // bundle the destination is given to plan, so there is no later step that has to skip it.
    expect(port.calls.planPublish).toEqual([
      { peerId: "peer-prod" },
      { peerId: "peer-prod", selectedEntityKeys: [`post:${HELLO_WORLD}`, `media:${UNNAMED_MEDIA}`] },
    ]);
    expect(port.calls.planPublish[1].selectedEntityKeys).not.toContain(`post:${ABOUT_US}`);

    // Confirm and execute redeem the SECOND plan, not the one the operator first saw.
    expect(port.calls.confirmPublish).toEqual([
      { peerId: "peer-prod", planId: "fake-plan-narrowed", planHash: "fake-plan-hash-narrowed" },
    ]);
    expect(port.calls.executePublish).toEqual([
      { peerId: "peer-prod", bundleId: "fake-bundle-narrowed", confirmationToken: "fake-token" },
    ]);
  });

  it("drops the deselected row from the table it publishes, and stops offering checkboxes once committed", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    // Execute is held open so the assertions below land during the `executing` phase — the window
    // where the report is still on screen and the operator has already committed. Once execute
    // resolves the dialog is `done` and the table is gone, which asserts nothing about selection.
    port.executePublish = () => new Promise(() => {});
    const user = await planFrom(port);

    await user.click(rowCheckbox(ABOUT_US)!);
    await user.click(primaryButton());
    await waitFor(() => expect(primaryButton().textContent).toBe("Publishing…"));

    expect(document.querySelector(`tr[data-entity-id="${ABOUT_US}"]`)).toBeNull();
    expect(rowCheckbox(HELLO_WORLD)?.disabled).toBe(true);
    expect(headerCheckbox().disabled).toBe(true);
  });

  it("re-plans nothing when the operator left every row checked", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    const user = await planFrom(port);

    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));

    expect(port.calls.planPublish).toEqual([{ peerId: "peer-prod" }]);
    expect(port.calls.confirmPublish).toEqual([{ peerId: "peer-prod", planId: "fake-plan", planHash: "fake-plan-hash" }]);
  });
});

describe("PublishContentDialog — a failure's own words reach the operator", () => {
  it("renders an EGRESS_REFUSED message verbatim, devHostAllowlist instruction and all", async () => {
    // A peer on a private address answers 502 with this sentence as `body.error`, and `request()`
    // throws it as an `ApiError` whose message IS that string. It is the operator's ONLY
    // instruction for fixing the problem, so nothing between here and the screen may rewrite it.
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      planError: new Error("this peer's host resolves to a private address; add it to devHostAllowlist (TOVU_DEV_HOST_ALLOWLIST) to reach it"),
    });
    const user = userEvent.setup();
    renderDialog(port);
    await waitFor(() => expect(port.calls.listPeers).toBe(1));

    await user.click(primaryButton());
    expect(await screen.findByText("this peer's host resolves to a private address; add it to devHostAllowlist (TOVU_DEV_HOST_ALLOWLIST) to reach it")).toBeTruthy();
  });

  it("falls back to its own copy when the failure carries no message of its own", async () => {
    // `describeApiError`'s base case: a thrown non-Error has nothing to show, and a blank error
    // notice reads as a rendering bug rather than a failure.
    const port = createFakePublishContentPort({ peers: ONE_PEER });
    port.planPublish = async () => {
      throw "not an Error at all";
    };
    const user = userEvent.setup();
    renderDialog(port);
    await waitFor(() => expect(port.calls.listPeers).toBe(1));

    await user.click(primaryButton());
    expect(await screen.findByText("Could not work out what would be published.")).toBeTruthy();
  });
});

// terra review 2026-09-20, finding 2 (High). A plan is minted by ONE peer, for the bundle that peer
// was given. Confirm and execute used to read whatever the picker said at click time, so switching
// the picker after planning sent the operator's click to a site whose report they never saw — and
// with a row unchecked, the narrowed re-plan made that a fully self-consistent plan/confirm/execute
// at the new site, which every server-side check accepts.
describe("PublishContentDialog — a plan belongs to the site it was made for (terra #2)", () => {
  const TWO_PEERS = [
    ONE_PEER[0],
    {
      id: "peer-staging",
      label: "staging.tovu.com",
      baseUrl: "https://staging.tovu.com",
      remoteWorkspaceId: "workspace-local",
      masked: null,
      hasCredential: true,
    },
  ] as const;

  async function planAgainstProduction(port: ReturnType<typeof createFakePublishContentPort>) {
    const user = userEvent.setup();
    renderDialog(port);
    const picker = await screen.findByRole("combobox");
    await user.selectOptions(picker, "peer-prod");
    await user.click(primaryButton());
    await screen.findByRole("table");
    return { user, picker };
  }

  it("switching the site after planning takes the other site's report off screen, and the next click plans the new site", async () => {
    const port = createFakePublishContentPort({ peers: TWO_PEERS, report: SELECTION_REPORT });
    const { user, picker } = await planAgainstProduction(port);

    await user.click(rowCheckbox(ABOUT_US)!);
    await user.selectOptions(picker, "peer-staging");

    expect(screen.queryByRole("table")).toBeNull();
    expect(primaryButton().textContent).toBe("Publish all content");

    await user.click(primaryButton());
    await screen.findByRole("table");
    // A full plan of the new site, for the operator to read — not production's selection carried over.
    expect(port.calls.planPublish).toEqual([{ peerId: "peer-prod" }, { peerId: "peer-staging" }]);
    expect(port.calls.confirmPublish).toEqual([]);
    expect(port.calls.executePublish).toEqual([]);
    // Every row of the new plan starts checked; production's unchecked row does not follow it.
    expect(rowCheckbox(ABOUT_US)!.checked).toBe(true);
  });

  it("the site can't be changed while its plan is still being worked out, or once the publish is committed", async () => {
    const port = createFakePublishContentPort({ peers: TWO_PEERS, report: MIXED_REPORT });
    let releasePlan: () => void = () => {};
    const heldPort = {
      ...port,
      planPublish: (input: Parameters<typeof port.planPublish>[0]) =>
        new Promise<Awaited<ReturnType<typeof port.planPublish>>>((resolve, reject) => {
          releasePlan = () => port.planPublish(input).then(resolve, reject);
        }),
      // Recorded by the fake, then held open so the assertions below land during `executing`.
      executePublish: (input: Parameters<typeof port.executePublish>[0]) => {
        void port.executePublish(input);
        return new Promise<never>(() => {});
      },
    };
    const user = userEvent.setup();
    renderDialog(heldPort as typeof port);
    const picker = await screen.findByRole("combobox");
    await user.selectOptions(picker, "peer-prod");
    expect(picker).toBeEnabled();

    await user.click(primaryButton());
    expect(primaryButton().textContent).toBe("Planning…");
    expect(picker).toBeDisabled();

    releasePlan();
    await screen.findByRole("table");
    expect(picker).toBeEnabled();

    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));
    expect(picker).toBeDisabled();
    expect(port.calls.executePublish[0].peerId).toBe("peer-prod");
  });
  it("a plan that answers after the site was changed in the same tick is dropped, never shown against the new site", async () => {
    const port = createFakePublishContentPort({ peers: TWO_PEERS, report: MIXED_REPORT });
    const { result } = renderHook(() => usePublishContentConfirm({ onCancel: () => {}, t, port }));
    await waitFor(() => expect(result.current.peers).toHaveLength(2));
    act(() => result.current.onSelectPeer("peer-prod"));

    // One snapshot, two handlers: the picker's guard still sees the pre-click phase, so only the
    // plan's own peer check stands between production's answer and a staging-labelled report.
    const view = result.current;
    await act(async () => {
      view.onPrimary();
      view.onSelectPeer("peer-staging");
    });

    expect(port.calls.planPublish).toEqual([{ peerId: "peer-prod" }]);
    expect(result.current.selectedPeerId).toBe("peer-staging");
    expect(result.current.phase).toEqual({ kind: "idle" });
    expect(result.current.rows).toEqual([]);
  });

  it("a plan FAILURE that answers after the site was changed is dropped too — the new site did not fail", async () => {
    const port = createFakePublishContentPort({ peers: TWO_PEERS, planError: new Error("production is down") });
    const { result } = renderHook(() => usePublishContentConfirm({ onCancel: () => {}, t, port }));
    await waitFor(() => expect(result.current.peers).toHaveLength(2));
    act(() => result.current.onSelectPeer("peer-prod"));

    const view = result.current;
    await act(async () => {
      view.onPrimary();
      view.onSelectPeer("peer-staging");
    });

    expect(result.current.phase).toEqual({ kind: "idle" });
    expect(result.current.errorMessage).toBeNull();
  });
});

// plan-server.md BLOCKED-CLAIMED residual of terra #2: the picker's blank "Choose a site…" option
// stores `value=""` (`PublishContentDialog.tsx`'s own `<option value="">`), and `canStart` used to
// check only `!== null` — so the primary button stayed enabled and a click sent
// `planPublish({peerId: ""})`, which 404s at the server (Express's `:peerId` segment can't match an
// empty one) instead of the button simply staying disabled.
describe("PublishContentDialog — the blank 'Choose a site…' option is not a chosen site (plan-server.md BLOCKED-CLAIMED)", () => {
  const TWO_PEERS = [
    ONE_PEER[0],
    {
      id: "peer-staging",
      label: "staging.tovu.com",
      baseUrl: "https://staging.tovu.com",
      remoteWorkspaceId: "workspace-local",
      masked: null,
      hasCredential: true,
    },
  ] as const;

  it("choosing the blank option disables Publish and sends no plan request", async () => {
    const user = userEvent.setup();
    const port = createFakePublishContentPort({ peers: TWO_PEERS, report: SELECTION_REPORT });
    renderDialog(port);
    const picker = await screen.findByRole("combobox");

    await user.selectOptions(picker, "peer-prod");
    expect(primaryButton()).toBeEnabled();

    await user.selectOptions(picker, "");
    expect(primaryButton()).toBeDisabled();

    await user.click(primaryButton());
    expect(port.calls.planPublish).toHaveLength(0);
  });

  it("the hook's own guards refuse an empty peer id even if a caller bypasses the disabled button", async () => {
    const port = createFakePublishContentPort({ peers: TWO_PEERS, report: SELECTION_REPORT });
    const { result } = renderHook(() => usePublishContentConfirm({ onCancel: () => {}, t, port }));
    await waitFor(() => expect(result.current.peers).toHaveLength(2));

    act(() => result.current.onSelectPeer(""));

    expect(result.current.selectedPeerId).toBeNull();
    expect(result.current.primaryDisabled).toBe(true);

    await act(async () => {
      result.current.onPrimary();
    });

    expect(port.calls.planPublish).toHaveLength(0);
    expect(result.current.phase).toEqual({ kind: "idle" });
  });

  // a3-review-4 handoff, 2026-09-21: f1c9e5213 guarded the four READS of a peer id (canStart,
  // runPrimary's ternary, confirmPlan, the execute effect), but never `requestPlan` itself. `onConnect`
  // calls `requestPlan(site.id)` with no `isChosenPeerId` check of its own — a contract violation in
  // `connectDestination`'s response (it should never answer with an empty site id) would still reach
  // `planPublish({ peerId: "" })` because nothing between `onConnect` and the port stops it. This is the
  // "correct primitive, unwired call site" shape: `isChosenPeerId` exists, but `requestPlan`, the one
  // function every network call in this hook goes through, does not use it on itself.
  it("requestPlan refuses an empty peer id itself — even from onConnect, the one caller with no guard of its own", async () => {
    const port = createFakePublishContentPort({
      peers: [],
      destination: { connected: false, site: null, candidateUrl: "https://tovu.dev", message: "Publish to tovu.dev?", nextStep: null },
      // A contract-violating connect response: a site with an empty id. Nothing upstream of
      // `requestPlan` checks this before calling it.
      connectResult: {
        connected: true,
        site: { id: "", label: "tovu.dev", baseUrl: "https://tovu.dev", remoteWorkspaceId: "workspace-local", masked: null, hasCredential: false },
        candidateUrl: null,
        message: "This computer publishes to tovu.dev.",
        nextStep: null,
      },
    });
    const { result } = renderHook(() => usePublishContentConfirm({ onCancel: () => {}, t, port }));
    await waitFor(() => expect(result.current.connectOffer).not.toBeNull());

    await act(async () => {
      result.current.onPrimary();
    });

    // Fails today: onConnect's `void requestPlan(site.id)` has nothing stopping it, so
    // `port.planPublish` is called with `{ peerId: "" }` and the phase moves to `planned`.
    expect(port.calls.planPublish).toHaveLength(0);
    expect(result.current.phase).toEqual({ kind: "idle" });
  });
});

// terra review 2026-09-20, finding 3 (High). Once confirm is sent, the publish is the live site's to
// finish — there is no abort. Closing the dialog then cancelled nothing, and because every post-await
// update is dropped once unmounted, the operator never learned whether it published, failed, or
// what restore point it made. The three close paths are Escape, the backdrop and Cancel.
describe("PublishContentDialog — a committed publish can't be closed out from under its result (terra #3)", () => {
  function backdrop(): HTMLElement {
    const node = document.querySelector(".settings-dialog-backdrop");
    if (!node) throw new Error("the publish dialog has no backdrop");
    return node as HTMLElement;
  }

  function cancelButton(): HTMLButtonElement {
    return screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  }

  /** Tries all three close paths, returning how many of them reached `onCancel`. */
  async function tryEveryWayToClose(user: ReturnType<typeof userEvent.setup>, onCancel: ReturnType<typeof vi.fn>): Promise<number> {
    const before = onCancel.mock.calls.length;
    await user.keyboard("{Escape}");
    await user.click(backdrop());
    if (!cancelButton().disabled) await user.click(cancelButton());
    return onCancel.mock.calls.length - before;
  }

  it("still closes every way while nothing is committed — before planning and with a plan on screen", async () => {
    const onCancel = vi.fn();
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    const user = userEvent.setup();
    render(<PublishContentDialog onCancel={onCancel} t={t} port={port} />);
    await waitFor(() => expect(port.calls.listPeers).toBe(1));

    expect(await tryEveryWayToClose(user, onCancel)).toBe(3);
    await user.click(primaryButton());
    await screen.findByRole("table");
    expect(await tryEveryWayToClose(user, onCancel)).toBe(3);
  });

  it("refuses every close path while confirming and executing, then reports the outcome and closes normally", async () => {
    const onCancel = vi.fn();
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: MIXED_REPORT,
      executeResult: { restorePointId: "rp-9", runId: "run-9", changeSetIds: ["cs-1", "cs-2"] },
    });
    let releaseConfirm: () => void = () => {};
    let releaseExecute: () => void = () => {};
    let executeStarted = false;
    const heldPort = {
      ...port,
      confirmPublish: (input: Parameters<typeof port.confirmPublish>[0]) =>
        new Promise<Awaited<ReturnType<typeof port.confirmPublish>>>((resolve, reject) => {
          releaseConfirm = () => port.confirmPublish(input).then(resolve, reject);
        }),
      executePublish: (input: Parameters<typeof port.executePublish>[0]) =>
        new Promise<Awaited<ReturnType<typeof port.executePublish>>>((resolve, reject) => {
          executeStarted = true;
          releaseExecute = () => port.executePublish(input).then(resolve, reject);
        }),
    };
    const user = userEvent.setup();
    render(<PublishContentDialog onCancel={onCancel} t={t} port={heldPort as typeof port} />);
    await waitFor(() => expect(port.calls.listPeers).toBe(1));
    await user.click(primaryButton());
    await screen.findByRole("table");

    await user.click(primaryButton());
    expect(primaryButton().textContent).toBe("Publishing…");
    expect(await tryEveryWayToClose(user, onCancel)).toBe(0);
    expect(cancelButton()).toBeDisabled();

    await act(async () => releaseConfirm());
    await waitFor(() => expect(executeStarted).toBe(true));
    expect(await tryEveryWayToClose(user, onCancel)).toBe(0);
    expect(cancelButton()).toBeDisabled();

    await act(async () => releaseExecute());
    expect(await screen.findByText("Published 2 changes.")).toBeTruthy();
    expect(cancelButton()).toBeEnabled();
    expect(await tryEveryWayToClose(user, onCancel)).toBe(3);
  });
});

// terra review 2026-09-20, finding 5's sibling. The primary button is disabled from render-time
// phase, which two calls in one tick (an agent's scripted double click, say) both read as
// `planned` — so both confirmed, and each confirmed phase fired its own execute at the live site.
// publish-overwrite-live-plan-2026-09-24.md §4/S9.
describe("PublishContentDialog — Overwrite on live", () => {
  const RETIRES = { entityType: "post", entityId: "post-about", entityLabel: "About", hash: "h1" } as const;
  const CLASH_REASON = "slug 'about' is already held by a different post";

  const OVERWRITE_REPORT: PublishContentReport = {
    refused: false,
    refusalReason: null,
    applyOrder: ["post"],
    rows: [
      { entityType: "post", entityId: "post-new", outcome: "created", writes: true, reason: null },
      {
        entityType: "post",
        entityId: "post-clash",
        entityLabel: "About (new)",
        outcome: "blocked",
        writes: false,
        reason: CLASH_REASON,
        canOverwrite: true,
        retires: RETIRES,
      },
    ],
  };

  function overwriteCheckbox(entityId: string): HTMLInputElement | null {
    return reportRow(entityId).querySelector("input[data-publish-row-overwrite]");
  }

  it("renders one unchecked box on the overwritable row, and none on the rest", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: OVERWRITE_REPORT });
    await planFrom(port);

    expect(overwriteCheckbox("post-clash")?.checked).toBe(false);
    expect(overwriteCheckbox("post-new")).toBeNull();
  });

  it("ticking re-plans with overwriteEntityKeys and leaves selectedEntityKeys unset", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: OVERWRITE_REPORT });
    const user = await planFrom(port);

    await user.click(overwriteCheckbox("post-clash")!);
    await waitFor(() => expect(port.calls.planPublish).toHaveLength(2));

    expect(port.calls.planPublish[1]).toEqual({ peerId: "peer-prod", overwriteEntityKeys: ["post:post-clash"] });
    // The row the peer now answers `forced` for moves out of `skipped` — the re-plan actually landed.
    await waitFor(() => expect(reportRow("post-clash").getAttribute("data-publish-disposition")).toBe("publish"));
  });

  it("a re-plan that leaves live's OTHER writing rows different lands on planned with the exact mismatch line", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: OVERWRITE_REPORT });
    const user = await planFrom(port);

    // Once ticked, live also (for this test) drops `post-new` from what it would write — as if
    // someone had published it there directly in the meantime.
    port.planPublish = async (input) => {
      const base = await createFakePublishContentPort({ peers: ONE_PEER, report: OVERWRITE_REPORT }).planPublish(input);
      if (input.overwriteEntityKeys === undefined) return base;
      return { ...base, details: { ...base.details, rows: base.details.rows.filter((r) => r.entityId !== "post-new") } };
    };

    await user.click(overwriteCheckbox("post-clash")!);
    await screen.findByText("tovu.com (production) changed while you were deciding. Check the list again.");
    expect(screen.queryByRole("table")).toBeTruthy();
  });

  it("execute carries the plan's own overwriteEntityKeys", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: OVERWRITE_REPORT });
    const user = await planFrom(port);

    await user.click(overwriteCheckbox("post-clash")!);
    await waitFor(() => expect(reportRow("post-clash").getAttribute("data-publish-disposition")).toBe("publish"));
    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));

    expect(port.calls.executePublish[0]).toEqual({
      peerId: "peer-prod",
      bundleId: "fake-bundle-overwrite",
      confirmationToken: "fake-token",
      overwriteEntityKeys: ["post:post-clash"],
    });
  });

  it("shows no checkbox and a plain notice when the live peer can't overwrite yet", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: OVERWRITE_REPORT, liveCanOverwrite: false });
    await planFrom(port);

    expect(overwriteCheckbox("post-clash")).toBeNull();
    expect(
      await screen.findByText("tovu.com (production) is on an older Tovu and can't overwrite these yet. Update it, then publish again.")
    ).toBeTruthy();
  });
});

// plan-publish-sections-2026-09-25.md §2 S2 — the dialog's own `scope` prop: its title, its
// idle-state primary label, and every `port.planPublish` call it makes while a scope is threaded in.
describe("PublishContentDialog — scope (plan-publish-sections §2 S2)", () => {
  it("no scope reads the dialog as publishing everything", () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER });
    renderDialog(port);

    expect(dialogTitle()).toBe("Publish all content");
    expect(primaryButton().textContent).toBe("Publish all content");
  });

  it("a single-type scope titles the dialog and its idle button with that section's label", () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER });
    renderDialog(port, { scope: { entityTypes: ["page"] } });

    expect(dialogTitle()).toBe("Publish pages");
    expect(primaryButton().textContent).toBe("Publish pages");
  });

  it("the description line names what a section's dialog sends (owner decision 2026-09-25)", () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER });
    renderDialog(port, { scope: { entityTypes: ["redirect"] } });

    expect(screen.getByText("Sends your redirects to the live site.")).toBeTruthy();
    expect(screen.queryByText(/Sends your posts, pages and media/)).toBeNull();
  });

  it("an unscoped dialog keeps the all-content description", () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER });
    renderDialog(port);

    expect(
      screen.getByText("Sends your posts, pages and media to the live site. Deploy ships code; publish ships content.")
    ).toBeTruthy();
  });

  it("an entityKeys scope titles the dialog 'Publish item'", () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER });
    renderDialog(port, { scope: { entityTypes: ["page"], entityKeys: ["page:page-1"] } });

    expect(dialogTitle()).toBe("Publish item");
  });

  it("the initial plan carries the scope", async () => {
    // `MIXED_REPORT`'s rows are `post`/`media` only — the scope here matches all of them so the
    // dialog still has a table to plan against; the fake port's own row filtering is exercised
    // elsewhere and is not what this test is about.
    const scope: PublishScope = { entityTypes: ["post", "media"] };
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    await planFromScoped(port, scope);

    expect(port.calls.planPublish).toEqual([{ peerId: "peer-prod", scope }]);
  });

  it("an overwrite-tick re-plan carries the scope alongside overwriteEntityKeys", async () => {
    const scope: PublishScope = { entityTypes: ["post"] };
    // A local, minimal stand-in for the "Overwrite on live" describe block's own `OVERWRITE_REPORT`
    // (out of scope here) — one row this test doesn't touch, one overwritable clash it does.
    const report: PublishContentReport = {
      refused: false,
      refusalReason: null,
      applyOrder: ["post"],
      rows: [
        { entityType: "post", entityId: "post-new", outcome: "created", writes: true, reason: null },
        {
          entityType: "post",
          entityId: "post-clash",
          entityLabel: "About (new)",
          outcome: "blocked",
          writes: false,
          reason: "slug 'about' is already held by a different post",
          canOverwrite: true,
          retires: { entityType: "post", entityId: "post-about", entityLabel: "About", hash: "h1" },
        },
      ],
    };
    const port = createFakePublishContentPort({ peers: ONE_PEER, report });
    const user = await planFromScoped(port, scope);

    const overwriteCheckbox = (entityId: string): HTMLInputElement | null =>
      reportRow(entityId).querySelector("input[data-publish-row-overwrite]");
    await user.click(overwriteCheckbox("post-clash")!);
    await waitFor(() => expect(port.calls.planPublish).toHaveLength(2));

    expect(port.calls.planPublish[1]).toEqual({ peerId: "peer-prod", overwriteEntityKeys: ["post:post-clash"], scope });
  });

  it("a deselect-narrowed confirm re-plan carries the scope alongside selectedEntityKeys", async () => {
    const scope: PublishScope = { entityTypes: ["post", "media"] };
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: SELECTION_REPORT });
    const user = await planFromScoped(port, scope);

    await user.click(rowCheckbox(ABOUT_US)!);
    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.planPublish).toHaveLength(2));

    expect(port.calls.planPublish[1]).toEqual({
      peerId: "peer-prod",
      selectedEntityKeys: [`post:${HELLO_WORLD}`, `media:${UNNAMED_MEDIA}`],
      scope,
    });
  });
});

// plan-publish-repoint-menus-2026-09-24.md §2.7/R6 — the overwrite checkbox's tooltip names the live
// menus that still point at the row being retired, and the done banner counts repointed menu links.
describe("PublishContentDialog — menu-link repoint copy (R6)", () => {
  const RETIRES = { entityType: "post", entityId: "post-about-old", entityLabel: "About", hash: "h1" } as const;
  const CLASH_REASON = "slug 'about' is already held by a different post";

  const REPOINT_REPORT: PublishContentReport = {
    refused: false,
    refusalReason: null,
    applyOrder: ["post"],
    rows: [
      {
        entityType: "post",
        entityId: "post-clash",
        entityLabel: "About (new)",
        outcome: "blocked",
        writes: false,
        reason: CLASH_REASON,
        canOverwrite: true,
        retires: RETIRES,
        referencedBy: [{ entityType: "menu", entityId: "menu-header", entityLabel: "Header", referencedId: "post-about-old" }],
      },
    ],
  };

  function overwriteCheckbox(entityId: string): HTMLInputElement | null {
    return reportRow(entityId).querySelector("input[data-publish-row-overwrite]");
  }

  it("the overwrite checkbox's title names the menu the retired page still feeds", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: REPOINT_REPORT });
    await planFrom(port);

    expect(overwriteCheckbox("post-clash")?.title).toBe("About moves to Trash. Menu links follow: Header");
  });

  it("a row with no referencedBy keeps the plain retire tooltip, unchanged", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: { ...REPOINT_REPORT, rows: [{ ...REPOINT_REPORT.rows[0], referencedBy: undefined }] },
    });
    await planFrom(port);

    expect(overwriteCheckbox("post-clash")?.title).toBe("About moves to Trash");
  });

  it("the done banner reports repointed menu links only when the run actually repointed one", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: MIXED_REPORT,
      executeResult: { restorePointId: "rp-9", runId: "run-9", changeSetIds: ["cs-1"], menuLinksUpdated: 1 },
    });
    const user = await planFrom(port);

    await user.click(primaryButton());
    expect(await screen.findByText("Published 1 change. Menu links updated: 1.")).toBeTruthy();
  });

  it("the done banner says nothing about menus when nothing was repointed", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: MIXED_REPORT,
      executeResult: { restorePointId: "rp-9", runId: "run-9", changeSetIds: ["cs-1"], menuLinksUpdated: 0 },
    });
    const user = await planFrom(port);

    await user.click(primaryButton());
    expect(await screen.findByText("Published 1 change.")).toBeTruthy();
  });

  // Review 2026-09-24: plan §2.7 — a menu the run could NOT repoint is reported, never silent. The
  // server's lines reached the client (`menuLinksNotUpdated`) but nothing rendered them.
  it("shows each menu the run could not repoint under the done banner", async () => {
    const NOT_UPDATED = "Menu links were not updated: this publishing grant doesn't cover menus.";
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: MIXED_REPORT,
      executeResult: {
        restorePointId: "rp-9",
        runId: "run-9",
        changeSetIds: ["cs-1"],
        menuLinksUpdated: 0,
        menuLinksNotUpdated: [NOT_UPDATED],
      },
    });
    const user = await planFrom(port);

    await user.click(primaryButton());
    expect(await screen.findByText("Published 1 change.")).toBeTruthy();
    expect(screen.getByText(NOT_UPDATED)).toBeTruthy();
  });
});

// c7n-ow-review2 (2026-09-24): the S9 review's defects, each RED against 6ed1e20fc before its fix.
describe("PublishContentDialog — Overwrite on live, review fixes", () => {
  const CLASH_REASON = "slug is already held by a different post";
  const TWO_CLASH_REPORT: PublishContentReport = {
    refused: false,
    refusalReason: null,
    applyOrder: ["post"],
    rows: [
      { entityType: "post", entityId: "post-new", outcome: "created", writes: true, reason: null },
      { entityType: "post", entityId: "clash-a", outcome: "blocked", writes: false, reason: CLASH_REASON, canOverwrite: true },
      { entityType: "post", entityId: "clash-b", outcome: "blocked", writes: false, reason: CLASH_REASON, canOverwrite: true },
    ],
  };
  const MISMATCH = "tovu.com (production) changed while you were deciding. Check the list again.";

  function overwriteCheckbox(entityId: string): HTMLInputElement | null {
    return reportRow(entityId).querySelector("input[data-publish-row-overwrite]");
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("a ticked row keeps its checked box after the re-plan turns it forced, and unticking restores the skip", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const user = await planFrom(port);

    await user.click(overwriteCheckbox("clash-a")!);
    await waitFor(() => expect(reportRow("clash-a").getAttribute("data-publish-disposition")).toBe("publish"));
    expect(overwriteCheckbox("clash-a")?.checked).toBe(true);

    await user.click(overwriteCheckbox("clash-a")!);
    await waitFor(() => expect(reportRow("clash-a").getAttribute("data-publish-disposition")).toBe("skipped"));
    expect(overwriteCheckbox("clash-a")?.checked).toBe(false);
  });

  it("the overwrite column stays when its only overwritable row has been ticked", async () => {
    const report: PublishContentReport = { ...TWO_CLASH_REPORT, rows: TWO_CLASH_REPORT.rows.slice(0, 2) };
    const port = createFakePublishContentPort({ peers: ONE_PEER, report });
    const user = await planFrom(port);

    await user.click(overwriteCheckbox("clash-a")!);
    await waitFor(() => expect(reportRow("clash-a").getAttribute("data-publish-disposition")).toBe("publish"));
    expect(overwriteCheckbox("clash-a")?.checked).toBe(true);
    expect(document.querySelector("thead th.publish-content-overwrite")).toBeTruthy();
  });

  it("the header box keeps an earlier tick when it ticks the rest", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const user = await planFrom(port);

    await user.click(overwriteCheckbox("clash-a")!);
    await waitFor(() => expect(reportRow("clash-a").getAttribute("data-publish-disposition")).toBe("publish"));
    const headerOverwrite = document.querySelector("thead th.publish-content-overwrite input") as HTMLInputElement;
    await user.click(headerOverwrite);
    await waitFor(() => expect(port.calls.planPublish).toHaveLength(3));

    expect([...(port.calls.planPublish[2].overwriteEntityKeys ?? [])].sort()).toEqual(["post:clash-a", "post:clash-b"]);
  });

  it("an older tick re-plan answering after a newer one never replaces it", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const user = await planFrom(port);
    const real = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const pending: Array<ReturnType<typeof deferred<Awaited<ReturnType<typeof real.planPublish>>>>> = [];
    port.planPublish = (input) => {
      port.calls.planPublish.push(input);
      const d = deferred<Awaited<ReturnType<typeof real.planPublish>>>();
      pending.push(d);
      return d.promise;
    };

    await user.click(overwriteCheckbox("clash-a")!);
    await user.click(overwriteCheckbox("clash-b")!);
    expect(pending).toHaveLength(2);

    // Newer ({a, b}) lands first, then the older ({a}) arrives late.
    await act(async () => pending[1].resolve(await real.planPublish(port.calls.planPublish[2])));
    await waitFor(() => expect(reportRow("clash-b").getAttribute("data-publish-disposition")).toBe("publish"));
    await act(async () => pending[0].resolve(await real.planPublish(port.calls.planPublish[1])));

    expect(reportRow("clash-b").getAttribute("data-publish-disposition")).toBe("publish");
    expect(overwriteCheckbox("clash-b")?.checked).toBe(true);
  });

  it("Publish can't confirm the old plan while a tick's re-plan is still out", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const real = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const { result } = renderHook(() => usePublishContentConfirm({ onCancel: () => {}, t, port }));
    await waitFor(() => expect(result.current.selectedPeerId).toBe("peer-prod"));
    await act(async () => result.current.onPrimary());
    await waitFor(() => expect(result.current.phase.kind).toBe("planned"));

    const d = deferred<Awaited<ReturnType<typeof real.planPublish>>>();
    port.planPublish = (input) => {
      port.calls.planPublish.push(input);
      return d.promise;
    };
    act(() => result.current.onToggleOverwrite("post:clash-a"));
    expect(result.current.primaryDisabled).toBe(true);
    await act(async () => result.current.onPrimary());
    expect(port.calls.confirmPublish).toHaveLength(0);

    await act(async () => d.resolve(await real.planPublish(port.calls.planPublish[1])));
    expect(result.current.primaryDisabled).toBe(false);
    await act(async () => result.current.onPrimary());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));
    expect(port.calls.executePublish[0].overwriteEntityKeys).toEqual(["post:clash-a"]);
  });

  it("unchecking a ticked row drops its overwrite key from the narrowed re-plan", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const user = await planFrom(port);

    await user.click(overwriteCheckbox("clash-a")!);
    await user.click(overwriteCheckbox("clash-b")!);
    await waitFor(() => expect(reportRow("clash-b").getAttribute("data-publish-disposition")).toBe("publish"));
    await user.click(rowCheckbox("clash-a")!);
    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));

    const narrowed = port.calls.planPublish[port.calls.planPublish.length - 1];
    expect(narrowed.selectedEntityKeys).toEqual(["post:post-new", "post:clash-b"]);
    expect(narrowed.overwriteEntityKeys).toEqual(["post:clash-b"]);
  });

  it("after a mismatch, the next tick is checked against the list now on screen, not the stale first plan", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const user = await planFrom(port);
    // From the first tick on, live has published `post-new` itself.
    port.planPublish = async (input) => {
      port.calls.planPublish.push(input);
      const base = await createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT }).planPublish(input);
      return { ...base, details: { ...base.details, rows: base.details.rows.filter((r) => r.entityId !== "post-new") } };
    };

    await user.click(overwriteCheckbox("clash-a")!);
    await screen.findByText(MISMATCH);
    await user.click(overwriteCheckbox("clash-b")!);
    await waitFor(() => expect(reportRow("clash-b").getAttribute("data-publish-disposition")).toBe("publish"));
    expect(screen.queryByText(MISMATCH)).toBeNull();
  });

  it("after a mismatch, unticking everything asks live again instead of showing the stale first plan", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const user = await planFrom(port);
    port.planPublish = async (input) => {
      port.calls.planPublish.push(input);
      const base = await createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT }).planPublish(input);
      return { ...base, details: { ...base.details, rows: base.details.rows.filter((r) => r.entityId !== "post-new") } };
    };

    await user.click(overwriteCheckbox("clash-a")!);
    await screen.findByText(MISMATCH);
    await user.click(overwriteCheckbox("clash-a")!);
    await waitFor(() => expect(port.calls.planPublish).toHaveLength(3));

    expect(port.calls.planPublish[2]).toEqual({ peerId: "peer-prod" });
    await waitFor(() => expect(document.querySelector('tr[data-entity-id="post-new"]')).toBeNull());
  });

  it("shows PEER_CANNOT_OVERWRITE's own sentence when a tick's re-plan is refused", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const user = await planFrom(port);
    const refusal =
      "https://tovu.com is on an older Tovu, so it can't overwrite these yet. Update https://tovu.com, then publish again.";
    port.planPublish = async () => {
      throw new ApiError(refusal, 502, "PEER_CANNOT_OVERWRITE", { error: refusal, code: "PEER_CANNOT_OVERWRITE" });
    };

    await user.click(overwriteCheckbox("clash-a")!);
    expect((await screen.findByRole("alert")).textContent).toBe(refusal);
  });

  it("shows a 403 credential_kind_not_permitted refusal's own sentence", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: TWO_CLASH_REPORT });
    const user = await planFrom(port);
    const refusal = "'overwriteEntityKeys' can only be sent from a signed-in admin session or a publishing instance";
    port.planPublish = async () => {
      throw new ApiError(refusal, 403, "FORBIDDEN", {
        error: refusal,
        code: "FORBIDDEN",
        details: { permission: "publish_content.apply", reason: "credential_kind_not_permitted" },
      });
    };

    await user.click(overwriteCheckbox("clash-a")!);
    expect((await screen.findByRole("alert")).textContent).toBe(refusal);
  });
});

describe("PublishContentDialog — the Publish button is agent-drivable, like the rest of the dialog", () => {
  it("the Publish button carries its agent handle", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    await planFrom(port);

    const publishButton = screen.getByRole("button", { name: /publish/i });
    expect(publishButton).toHaveAttribute("data-agent-element", "dashboard-publish-content-confirm");
  });
});

describe("PublishContentDialog — the primary action can't be doubled in one tick (terra #5)", () => {
  it("two confirms from the same render send one confirm and one execute", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    const { result } = renderHook(() => usePublishContentConfirm({ onCancel: () => {}, t, port }));
    await waitFor(() => expect(result.current.selectedPeerId).toBe("peer-prod"));
    await act(async () => {
      result.current.onPrimary();
    });
    await waitFor(() => expect(result.current.phase.kind).toBe("planned"));

    const view = result.current;
    await act(async () => {
      view.onPrimary();
      view.onPrimary();
    });
    await waitFor(() => expect(result.current.phase.kind).toBe("done"));

    expect(port.calls.confirmPublish).toHaveLength(1);
    expect(port.calls.executePublish).toHaveLength(1);
  });

  it("two plan requests from the same render send one plan", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: MIXED_REPORT });
    const { result } = renderHook(() => usePublishContentConfirm({ onCancel: () => {}, t, port }));
    await waitFor(() => expect(result.current.selectedPeerId).toBe("peer-prod"));

    const view = result.current;
    await act(async () => {
      view.onPrimary();
      view.onPrimary();
    });
    await waitFor(() => expect(result.current.phase.kind).toBe("planned"));
    expect(port.calls.planPublish).toHaveLength(1);
  });

  it("two connects from the same render send one connect", async () => {
    const port = createFakePublishContentPort({
      peers: [],
      destination: { connected: false, site: null, candidateUrl: "https://tovu.com", message: "Connect tovu.com?", nextStep: null },
    });
    const { result } = renderHook(() => usePublishContentConfirm({ onCancel: () => {}, t, port }));
    await waitFor(() => expect(result.current.connectOffer).not.toBeNull());

    const view = result.current;
    await act(async () => {
      view.onPrimary();
      view.onPrimary();
    });
    await waitFor(() => expect(result.current.phase.kind).toBe("planned"));
    expect(port.calls.connectDestination).toHaveLength(1);
  });
});

// publish-criteria-tool-webmcp-plan-2026-09-24.md §4 S2. A caller with no button of its own (chat,
// WebMCP, the admin's own `?publish=` deep link) hands the dialog a `PublishCriteria` instead of a
// click: the dialog must plan on its own, apply the criteria as its starting selection, and report
// back through `onPlanned` — all without the operator touching anything.
describe("PublishContentDialog — criteria-driven open (publish-criteria plan §4 S2)", () => {
  const CRITERIA_REPORT: PublishContentReport = {
    refused: false,
    refusalReason: null,
    applyOrder: ["page", "post", "menu"],
    rows: [
      { entityType: "page", entityId: "page-home", entityLabel: "Home", outcome: "created", writes: true, reason: null },
      { entityType: "post", entityId: "post-new", entityLabel: "Hello World", outcome: "created", writes: true, reason: null },
      {
        entityType: "menu",
        entityId: "menu-main",
        entityLabel: "Main Menu",
        outcome: "blocked",
        writes: false,
        reason: "slug 'main' is already held by a different menu",
        canOverwrite: true,
        retires: { entityType: "menu", entityId: "menu-main-old", entityLabel: "Main Menu (old)", hash: "h1" },
      },
    ],
  };

  function overwriteCheckbox(entityId: string): HTMLInputElement | null {
    return reportRow(entityId).querySelector("input[data-publish-row-overwrite]");
  }

  it("plans and applies criteria with no click, and reports what it planned via onPlanned", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: CRITERIA_REPORT });
    const onPlanned = vi.fn<(result: PublishRequestResult) => void>();
    const criteria: PublishCriteria = { types: ["page", "menu"], overwrite: true };

    render(<PublishContentDialog onCancel={() => {}} t={t} port={port} criteria={criteria} onPlanned={onPlanned} />);

    // No click anywhere in this test — the auto-plan effect stands in for the person's first click,
    // since planning writes nothing (plan §3's gate is about confirm/execute only).
    await waitFor(() => expect(port.calls.planPublish).toHaveLength(2));
    expect(port.calls.planPublish).toEqual([
      { peerId: "peer-prod" },
      { peerId: "peer-prod", overwriteEntityKeys: ["menu:menu-main"] },
    ]);

    // "menu" and "page" match the criteria's `types`; "post" does not, so the post row (selectable,
    // since it's a `publish` disposition) starts unchecked.
    await waitFor(() => expect(rowCheckbox("post-new")?.checked).toBe(false));
    // The menu row's tick took: the re-plan turned it `forced`, and its box stays checked.
    await waitFor(() => expect(overwriteCheckbox("menu-main")?.checked).toBe(true));

    await waitFor(() => expect(onPlanned).toHaveBeenCalledTimes(1));
    const result = onPlanned.mock.calls[0]?.[0] as PublishRequestResult;
    expect(result.willPublish).toEqual(expect.arrayContaining(["Home", "Main Menu"]));
  });
});

/**
 * Owner decision 2026-09-25 — media carried along with a scoped pages/posts run (`includedFor` on the
 * row, set by `push/plan`) shows as a normal row, pre-ticked and untickable, noting who uses it, and
 * counts toward the button only while a page that uses it is still ticked.
 */
const CARRIED_MEDIA_REPORT: PublishContentReport = {
  refused: false,
  refusalReason: null,
  applyOrder: ["media", "page"],
  rows: [
    { entityType: "media", entityId: "m-hero", entityLabel: "hero-png", outcome: "created", writes: true, reason: null, includedFor: ["page:pg-home"] },
    { entityType: "page", entityId: "pg-home", entityLabel: "home", outcome: "applied", writes: true, reason: null },
    { entityType: "page", entityId: "pg-about", entityLabel: "about", outcome: "created", writes: true, reason: null },
  ],
};

describe("PublishContentDialog — media carried along with pages", () => {
  it("renders the carried-along media row ticked, untickable, and noted", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: CARRIED_MEDIA_REPORT });
    await planFrom(port);

    const box = rowCheckbox("m-hero");
    expect(box?.checked).toBe(true);
    expect(box?.disabled).toBe(true);
    expect(within(reportRow("m-hero")).getByText("Used by these pages")).toBeTruthy();
    expect(primaryButton().textContent).toBe("Publish 3 items");
  });

  it("stops counting the media once the page that uses it is unticked", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: CARRIED_MEDIA_REPORT });
    const user = await planFrom(port);

    await user.click(rowCheckbox("pg-home")!);
    expect(primaryButton().textContent).toBe("Publish 1 item");
  });
});

/**
 * A carried-along media row live reports as a conflict is an ordinary skipped row (the server leaves
 * it untagged — `report-labels.ts`'s `keepChangingIncludedEntities`), so the operator sees its reason
 * and can tick "Overwrite on live". Once ticked, the re-plan answers it `forced` and tagged
 * `includedFor` again. Deselecting an unrelated page must not then silently drop that tick from the
 * narrowed confirm re-plan: the page that uses the media is still being published.
 */
describe("PublishContentDialog — a carried-along media conflict", () => {
  const MEDIA_CLASH = "destination hash differs from both source and baseline — it was edited there";
  const CARRIED_CONFLICT_REPORT: PublishContentReport = {
    refused: false,
    refusalReason: null,
    applyOrder: ["media", "page"],
    rows: [
      { entityType: "media", entityId: "m-hero", entityLabel: "hero-png", outcome: "conflict", writes: false, reason: MEDIA_CLASH, canOverwrite: true },
      { entityType: "page", entityId: "pg-home", entityLabel: "home", outcome: "applied", writes: true, reason: null },
      { entityType: "page", entityId: "pg-about", entityLabel: "about", outcome: "created", writes: true, reason: null },
    ],
  };

  /** The fake port has no carry-along rule of its own; this adds the one tag `push/plan` would. */
  function carryingPort() {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: CARRIED_CONFLICT_REPORT });
    const plan = port.planPublish;
    port.planPublish = async (input) => {
      const base = await plan(input);
      const rows = base.details.rows.map((row) =>
        row.entityId === "m-hero" && row.outcome === "forced" ? { ...row, includedFor: ["page:pg-home"] } : row
      );
      return { ...base, details: { ...base.details, rows } };
    };
    return port;
  }

  it("shows the conflict's reason and an Overwrite on live box, never a hidden or pre-ticked row", async () => {
    await planFrom(carryingPort());

    expect(within(reportRow("m-hero")).getByText(MEDIA_CLASH)).toBeTruthy();
    expect(reportRow("m-hero").getAttribute("data-publish-disposition")).toBe("skipped");
    expect(reportRow("m-hero").querySelector("input[data-publish-row-overwrite]")).toBeTruthy();
    expect(reportRow("m-hero").querySelector("input[data-publish-row-select], input[data-publish-row-carried]")).toBeNull();
  });

  it("keeps the media's overwrite tick in a narrowed re-plan while the page using it is still checked", async () => {
    const port = carryingPort();
    const user = await planFrom(port);

    await user.click(reportRow("m-hero").querySelector<HTMLInputElement>("input[data-publish-row-overwrite]")!);
    await waitFor(() => expect(reportRow("m-hero").getAttribute("data-publish-disposition")).toBe("publish"));
    await user.click(rowCheckbox("pg-about")!);
    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.executePublish).toHaveLength(1));

    const narrowed = port.calls.planPublish[port.calls.planPublish.length - 1];
    expect(narrowed.selectedEntityKeys).toEqual(["page:pg-home"]);
    expect(narrowed.overwriteEntityKeys).toEqual(["media:m-hero"]);
  });
});

describe("PublishContentDialog — types the live site can't take yet", () => {
  const EMPTY_REPORT: PublishContentReport = { refused: false, refusalReason: null, applyOrder: [], rows: [] };

  async function planWithoutTable(port: ReturnType<typeof createFakePublishContentPort>) {
    const user = userEvent.setup();
    renderDialog(port, { scope: { entityTypes: ["form"] } });
    await waitFor(() => expect(port.calls.listPeers).toBe(1));
    await user.click(primaryButton());
    await waitFor(() => expect(port.calls.planPublish).toHaveLength(1));
  }

  it("names each held-back type and never says 'Nothing to publish' for an empty report", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: EMPTY_REPORT,
      notSupportedByLive: [
        { entityType: "form", count: 7 },
        { entityType: "widget-area", count: 1 },
      ],
    });
    await planWithoutTable(port);

    await waitFor(() => expect(primaryButton().textContent).toBe("Update the live site first"));
    expect(primaryButton().disabled).toBe(true);
    expect([...document.querySelectorAll(".publish-content-live-gap")].map((line) => line.textContent)).toEqual([
      "Forms (7) can't publish yet: the live site needs an update first.",
      "Widget regions (1) can't publish yet: the live site needs an update first.",
    ]);
  });

  it("still says 'Nothing to publish' when the live took every type", async () => {
    const port = createFakePublishContentPort({ peers: ONE_PEER, report: EMPTY_REPORT, notSupportedByLive: [] });
    await planWithoutTable(port);

    await waitFor(() => expect(primaryButton().textContent).toBe("Nothing to publish"));
    expect(document.querySelectorAll(".publish-content-live-gap")).toHaveLength(0);
  });

  it("shows the held-back line alongside a report that has rows, keeping the counted button", async () => {
    const port = createFakePublishContentPort({
      peers: ONE_PEER,
      report: MIXED_REPORT,
      notSupportedByLive: [{ entityType: "menu", count: 2 }],
    });
    await planFrom(port);

    expect(primaryButton().textContent).toBe("Publish 1 item");
    expect(document.querySelector(".publish-content-live-gap")?.textContent).toBe(
      "Menus (2) can't publish yet: the live site needs an update first."
    );
  });
});
