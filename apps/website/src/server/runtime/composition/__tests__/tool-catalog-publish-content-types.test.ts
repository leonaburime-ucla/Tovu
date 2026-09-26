/**
 * @file Regression (2026-09-23): the assistant's `publish_content_*` tools run in the agent daemon,
 * a separate process that boots through `installFirstPartyToolContributors()` and never calls
 * `createApp()`. Only `createApp()`'s publish-content module registered the publishable content
 * types, so in the daemon `listPublishContentContributors()` was empty and every publish answer was
 * "This site has no pages, posts or other content set up to be published." — on a site with 33 pages
 * and 6 posts. Any process that hosts the publish tools must also hold the types they read.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resetToolContributorsForTests } from "#src/assistant/tool-contribution-registry";
import { describePublishReadiness } from "#src/features/publish-content/publish-readiness";
import {
  listPublishContentContributors,
  resetPublishContentContributorsForTests,
} from "#src/features/publish-content/type-registry";

import { installFirstPartyPublishContentTypes } from "../publish-content-manifest.js";
import { installFirstPartyToolContributors } from "../tool-catalog-manifest.js";

test.beforeEach(() => {
  resetPublishContentContributorsForTests();
  resetToolContributorsForTests();
});

test("installFirstPartyToolContributors also registers the publishable content types the publish tools read", () => {
  installFirstPartyToolContributors();
  const viaTools = listPublishContentContributors().map((c) => c.entityType);
  resetPublishContentContributorsForTests();
  installFirstPartyPublishContentTypes();
  assert.deepEqual(viaTools, listPublishContentContributors().map((c) => c.entityType));
});

test("a tool-hosting process booted only through installFirstPartyToolContributors is not told its site has nothing to publish", () => {
  installFirstPartyToolContributors();
  const readiness = describePublishReadiness({
    connectedSiteLabel: null,
    otherSiteLabels: [],
    candidateUrl: "https://tovu.com",
    publishableTypeCount: listPublishContentContributors().length,
  });
  assert.equal(readiness.verdict, "not-connected");
  assert.equal(readiness.missing, "This computer has not been connected to tovu.com.");
});
