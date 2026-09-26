/**
 * @file Certifies `withModelFacingRegistrationErrors` — the `ToolRegistration[]`-shaped sibling of
 * `withModelFacingErrors` added for the registry-converted domains (`features/entries` and its
 * siblings), whose `build*Registrations` returns an array of `{descriptor, handler, policy}` rather
 * than a `Record<toolId, handler>`. Same allowlist mechanics (`reclassifyToolError`), different
 * container shape — see that file's header for the security contract.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EntryNotFoundError } from "@jini-ai/cms/entries";
import { ToolInputError } from "@jini-ai/core";
import type { ToolExecutionContext, ToolPolicy, ToolRegistration } from "@jini-ai/core";

import { forbiddenRule, withModelFacingRegistrationErrors, type ModelFacingErrorRule } from "../model-facing-tool-errors.js";

const ENTRIES_RULES: readonly ModelFacingErrorRule[] = [
  { error: EntryNotFoundError, code: "ENTRIES_NOT_FOUND" },
  forbiddenRule("ENTRIES"),
];

const NOOP_POLICY: ToolPolicy = { authorize: () => ({ allowed: true }) as never };

const CTX: ToolExecutionContext = {
  executionId: "exec-1",
  principal: { id: "principal-1" },
  run: { id: "run-1" },
  input: {},
  signal: new AbortController().signal,
};

function registrationThatThrows(id: string, error: unknown): ToolRegistration {
  return {
    descriptor: { id },
    policy: NOOP_POLICY,
    handler: async () => {
      throw error;
    },
  };
}

test("a listed class rejects with a ToolInputError carrying the coded message", async () => {
  const [wrapped] = withModelFacingRegistrationErrors(
    [registrationThatThrows("entries_get", new EntryNotFoundError("entry 'e1' was not found"))],
    ENTRIES_RULES
  );
  await assert.rejects(
    () => wrapped.handler(CTX),
    (err: unknown) => {
      assert.ok(err instanceof ToolInputError, "expected a ToolInputError");
      assert.match((err as Error).message, /^ENTRIES_NOT_FOUND: /);
      return true;
    }
  );
});

test("an unlisted error passes through as the identical object", async () => {
  const boom = new Error("boom");
  const [wrapped] = withModelFacingRegistrationErrors([registrationThatThrows("entries_get", boom)], ENTRIES_RULES);
  await assert.rejects(() => wrapped.handler(CTX), (err: unknown) => err === boom);
});

test("descriptor and policy pass through unchanged; only the handler is wrapped", () => {
  const original = registrationThatThrows("entries_get", new Error("boom"));
  const [wrapped] = withModelFacingRegistrationErrors([original], ENTRIES_RULES);
  assert.equal(wrapped.descriptor, original.descriptor);
  assert.equal(wrapped.policy, original.policy);
  assert.notEqual(wrapped.handler, original.handler);
});
