import assert from "node:assert/strict";
import test from "node:test";

import { makeSite, registerOnly, roundTrip, packAll, plan, applyReport, WORKSPACE_ID } from "#src/features/publish-content/__tests__/round-trip-harness";
import { contributeFormPublish } from "../publish-content.js";
import { InMemoryFormDefinitionRepo } from "../repo.memory.js";
import type { FormDefinitionRecord } from "../types.js";

function form(overrides: Partial<FormDefinitionRecord> = {}): FormDefinitionRecord {
  return {
    id: "src-form-1",
    workspaceId: WORKSPACE_ID,
    name: "Contact",
    slug: "contact",
    fields: [{ id: "email", label: "Email", type: "email", required: true }],
    notify: { enabled: true, recipients: ["owner@example.com"] },
    status: "disabled",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

async function sites(sourceRows: FormDefinitionRecord[]) {
  registerOnly([contributeFormPublish()]);
  const sourceRepo = new InMemoryFormDefinitionRepo();
  for (const row of sourceRows) await sourceRepo.create(row);
  const destRepo = new InMemoryFormDefinitionRepo();
  return { source: makeSite({ form: { repo: sourceRepo } }, "src"), dest: makeSite({ form: { repo: destRepo } }, "dst"), sourceRepo, destRepo };
}

test("form round trip: created on an empty destination, then unchanged, keyed by slug", async () => {
  const { source, dest, destRepo } = await sites([form(), form({ id: "src-form-2", slug: "signup", name: "Signup", status: "active" })]);
  const { first, second, entities, destinationPack } = await roundTrip(source, dest);

  assert.deepEqual(first.rows.map((r) => [r.entityId, r.outcome]), [["contact", "created"], ["signup", "created"]]);
  assert.deepEqual(second.rows.map((r) => r.outcome), ["unchanged", "unchanged"]);
  assert.deepEqual(destinationPack.map((e) => e.contentHash), entities.map((e) => e.contentHash));
  const landed = await destRepo.findBySlug({ workspaceId: WORKSPACE_ID, slug: "contact" });
  assert.equal(landed?.status, "disabled");
  assert.deepEqual(landed?.notify, { enabled: true, recipients: ["owner@example.com"] });
  assert.notEqual(landed?.id, "src-form-1", "the destination mints its own id; slug is the address");
});

test("form: a destination edit after the plan is a conflict, not an overwrite", async () => {
  const { source, dest, destRepo } = await sites([form()]);
  const entities = await packAll(source);
  const report = await plan(entities, dest);
  await destRepo.create(form({ id: "dst-form-9", name: "Someone else's" }));
  await assert.rejects(applyReport(report, entities, dest), (err: Error & { rowOutcome?: string }) => {
    assert.equal(err.rowOutcome, "conflict");
    assert.match(err.message, /expected no existing row/);
    return true;
  });
});

test("form: a slug held only by a trashed destination form is refused at precheck", async () => {
  const { source, dest, destRepo } = await sites([form()]);
  await destRepo.save({ ...form({ id: "dst-trashed" }), deletedAt: "2026-09-20T00:00:00.000Z", version: 2 });
  const report = await plan(await packAll(source), dest);
  assert.equal(report.rows[0]?.outcome, "blocked");
  assert.match(report.rows[0]?.reason ?? "", /trash/i);
});

test("form: submissions never pack, and packed state carries no instance-local fields", async () => {
  const { source } = await sites([form()]);
  const [entity] = await packAll(source);
  assert.deepEqual(Object.keys(entity!.state).sort(), ["fields", "name", "notify", "slug", "status"]);
});

test("form: a changed source form updates the destination row in place (forced past the no-baseline conflict)", async () => {
  const { source, dest, sourceRepo, destRepo } = await sites([form()]);
  await roundTrip(source, dest);
  const before = await destRepo.findBySlug({ workspaceId: WORKSPACE_ID, slug: "contact" });
  await sourceRepo.update(form({ name: "Contact us", status: "active", fields: [...form().fields, { id: "msg", label: "Message", type: "textarea", required: false }] }));

  const entities = await packAll(source);
  const report = await plan(entities, dest, ["form:contact"]);
  assert.equal(report.rows[0]?.outcome, "forced");
  await applyReport(report, entities, dest);

  const after = await destRepo.findBySlug({ workspaceId: WORKSPACE_ID, slug: "contact" });
  assert.equal(after?.id, before?.id);
  assert.equal(after?.name, "Contact us");
  assert.equal(after?.status, "active");
  assert.equal(after?.fields.length, 2);
  assert.deepEqual((await plan(await packAll(source), dest)).rows.map((r) => r.outcome), ["unchanged"]);
});
