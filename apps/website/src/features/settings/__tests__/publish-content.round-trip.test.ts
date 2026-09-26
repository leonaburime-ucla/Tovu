import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@jini-ai/cms/core";

import { PublishContentApplyRowError } from "#src/features/publish-content/apply-errors";
import { entityKey } from "#src/features/publish-content/planner";
import { friendlyPublishReason } from "#src/features/publish-content/ui/report-rows";
import { buildPublishContentCatalog, type PackedEntity } from "#src/features/publish-content/type-registry";
import { contributeActiveThemePublish } from "#src/features/theme/active-theme-publish-content";
import type { DiscoveredTheme } from "#src/features/theme/theme";
import { workspaces } from "#src/platform/db/schema.sqlite";

import {
  applyReport,
  makeSite,
  packAll,
  plan,
  registerOnly,
  roundTrip,
  sqliteContentSite,
  WORKSPACE_ID,
} from "../../publish-content/__tests__/round-trip-harness.js";
import { set, type SettingDefinitionRecord, type SettingValueSchema } from "../index.js";
import { contributeSiteSettingPublish } from "../publish-content.js";

/**
 * @file `site-setting` and `active-theme` round-tripped on real SQLite on both sides, plus the
 * allowlist: a secret, a user-scoped value, a non-allowlisted key and a this-computer URL never pack,
 * and the destination refuses a hand-made bundle naming a key outside the allowlist.
 */

const at = "2026-09-01T00:00:00.000Z";
const MEDIA_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type Site = ReturnType<typeof sqliteContentSite>;

function definition(
  site: Site,
  namespace: string,
  key: string,
  opts: { secret?: boolean; scopes?: number; schema?: SettingValueSchema } = {}
): Promise<void> {
  const record: SettingDefinitionRecord = {
    settingId: `${namespace}.${key}`,
    version: 1,
    // `core.*` is the platform partition; `site.*` is the workspace's own.
    workspaceId: namespace.startsWith("site.") ? WORKSPACE_ID : null,
    namespace,
    key,
    ownerKind: namespace.startsWith("site.") ? "site" : "core",
    ownerId: null,
    schema: opts.schema ?? { type: "string", nullable: true },
    defaultValue: null,
    scopes: opts.scopes ?? 2,
    secret: opts.secret ?? false,
    status: "active",
    aliasOfNamespace: null,
    aliasOfKey: null,
    coercionTag: null,
    createdAt: at,
    updatedAt: at,
  };
  return site.settings.saveDefinition(record);
}

async function defineAll(site: Site, secretTwitter: boolean): Promise<void> {
  await definition(site, "core.site", "title");
  await definition(site, "site.seo", "title_template");
  await definition(site, "site.seo", "default_og_image");
  await definition(site, "site.seo", "default_description", { scopes: 6 });
  await definition(site, "site.seo", "twitter_site", { secret: secretTwitter });
  await definition(site, "site.seo", "default_robots_noindex", { schema: { type: "boolean" } });
  await definition(site, "core.execution", "byok.baseUrl");
}

async function write(site: Site, id: string, value: JsonValue): Promise<void> {
  const at = id.indexOf(":");
  await set({
    deps: {
      repo: site.settings,
      clock: { nowIso: () => "2026-09-02T00:00:00.000Z" },
      ids: { newId: () => `rev-${Math.random()}` },
      authorize: async () => ({ allowed: true, reason: "test" }),
      principals: {} as never,
    },
    input: { namespace: id.slice(0, at), key: id.slice(at + 1), scope: "workspace", value, workspaceId: WORKSPACE_ID, callerPrincipalId: "owner", authWorkspaceId: WORKSPACE_ID },
  });
}

async function workspaceValue(site: Site, settingId: string): Promise<JsonValue | null | undefined> {
  return (await site.settings.getWorkspaceValue({ workspaceId: WORKSPACE_ID, settingId }))?.valueJson;
}

function theme(tier: string, id: string): DiscoveredTheme {
  return { status: "valid", manifest: { id }, dir: `/themes/${tier}/${id}` } as unknown as DiscoveredTheme;
}

async function sites() {
  registerOnly([contributeSiteSettingPublish(), contributeActiveThemePublish()]);
  const source = sqliteContentSite();
  const destination = sqliteContentSite();
  for (const site of [source, destination]) {
    site.db.insert(workspaces).values({ id: WORKSPACE_ID, name: "ws", slug: "ws", createdAt: at }).run();
  }
  await defineAll(source, true);
  await defineAll(destination, false);
  return { source, destination, sourceDeps: makeSite(source.ports, "src"), destinationDeps: makeSite(destination.ports, "dst") };
}

const ids = (entities: readonly PackedEntity[]) => entities.map((e) => entityKey(e.entityType, e.id));

test("only allowlisted, non-secret workspace values pack; secrets, user values, crawl controls and other namespaces never do", async () => {
  const { source, sourceDeps } = await sites();
  await write(source, "core.site:title", "Tovu");
  await write(source, "site.seo:title_template", "%s | Tovu");
  await write(source, "site.seo:default_og_image", `${MEDIA_ID}:public`);
  await write(source, "site.seo:default_robots_noindex", true);
  await write(source, "core.execution:byok.baseUrl", "http://localhost:11434");
  // A secret definition's value, saved straight to the table (the write path refuses secrets).
  await source.settings.saveWorkspaceValue({
    settingId: "site.seo.twitter_site", scope: "workspace", workspaceId: WORKSPACE_ID, principalId: null, valueJson: "@secret",
    state: "set", defVersion: 1, seq: 999, updatedBy: "owner", updatedAt: at, originPluginId: null,
  });
  // A user's own value for an allowlisted key.
  await source.settings.saveUserValue({
    settingId: "site.seo.default_description", scope: "user", workspaceId: WORKSPACE_ID, principalId: "owner", valueJson: "mine",
    state: "set", defVersion: 1, seq: 998, updatedBy: "owner", updatedAt: at, originPluginId: null,
  });

  const packed = await packAll(sourceDeps);
  assert.deepEqual(ids(packed), ["site-setting:core.site:title", "site-setting:site.seo:title_template", "site-setting:site.seo:default_og_image"]);
  assert.equal(JSON.stringify(packed).includes("@secret"), false);
  assert.equal(JSON.stringify(packed).includes("mine"), false);
  assert.equal(JSON.stringify(packed).includes("11434"), false);
  assert.deepEqual(packed.find((e) => e.id === "core.site:title")!.state, { label: "Site title", value: "Tovu" });

  const handler = buildPublishContentCatalog(sourceDeps).handlerByType.get("site-setting")!;
  assert.deepEqual(handler.references!(packed.find((e) => e.id === "site.seo:default_og_image")!), [{ entityType: "media", key: MEDIA_ID }]);
});

test("a share image URL on this computer does not pack, and a hand-made one is refused", async () => {
  const { source, sourceDeps, destinationDeps } = await sites();
  await write(source, "site.seo:default_og_image", "http://127.0.0.1:3000/uploads/x.png");
  assert.deepEqual(ids(await packAll(sourceDeps)), []);
  await write(source, "site.seo:default_og_image", "https://cdn.example.com/x.png");
  const [entity] = await packAll(sourceDeps);
  const crafted = { ...entity!, state: { ...entity!.state, value: "http://localhost:3000/x.png" } };
  const report = await plan([crafted], destinationDeps);
  assert.equal(report.rows[0]!.outcome, "blocked");
  assert.equal(report.rows[0]!.reason, "site-setting 'site.seo:default_og_image' points at this computer");
  assert.equal(friendlyPublishReason(report.rows[0]!.reason!), "This image link only works on this computer. Pick an image from Media instead.");
});

test("the destination refuses a bundle naming a setting outside the allowlist, and never writes it", async () => {
  const { source, destination, sourceDeps, destinationDeps } = await sites();
  await write(source, "core.site:title", "Tovu");
  const [title] = await packAll(sourceDeps);
  const crafted: PackedEntity = { ...title!, id: "core.execution:byok.baseUrl", state: { label: "x", value: "https://evil.example" } };
  const report = await plan([crafted], destinationDeps);
  assert.equal(report.rows[0]!.outcome, "blocked");
  assert.equal(report.rows[0]!.reason, "site-setting 'core.execution:byok.baseUrl' is not one this site publishes");
  assert.equal(friendlyPublishReason(report.rows[0]!.reason!), "Only the site title and SEO basics can be published.");

  const handler = buildPublishContentCatalog(destinationDeps).handlerByType.get("site-setting")!;
  await assert.rejects(
    handler.apply({ entity: crafted, expectedVersion: undefined, principalId: "owner", idempotencyKey: "k" }),
    (err: unknown) => err instanceof PublishContentApplyRowError && err.rowOutcome === "blocked"
  );
  assert.equal(await workspaceValue(destination, "core.execution.byok.baseUrl"), undefined);
});

test("settings round-trip: created, then unchanged; the ledger records the write; a live edit is a conflict", async () => {
  const { source, destination, sourceDeps, destinationDeps } = await sites();
  await write(source, "core.site:title", "Tovu");
  await write(source, "site.seo:title_template", "%s | Tovu");

  const { entities, first, second, destinationPack } = await roundTrip(sourceDeps, destinationDeps);
  assert.deepEqual(first.rows.map((r) => r.outcome), ["created", "created"]);
  assert.deepEqual(second.rows.map((r) => r.outcome), ["unchanged", "unchanged"]);
  assert.deepEqual(destinationPack.map((e) => e.contentHash), entities.map((e) => e.contentHash));
  assert.equal(await workspaceValue(destination, "core.site.title"), "Tovu");
  assert.equal((await destination.settings.listRevisions({ settingId: "core.site.title" })).length, 1);

  await write(destination, "core.site:title", "Edited live");
  await write(source, "core.site:title", "Tovu 2");
  const edited = await packAll(sourceDeps);
  const conflict = await plan(edited, destinationDeps);
  assert.equal(conflict.rows.find((r) => r.entityId === "core.site:title")!.outcome, "conflict");

  const forced = await plan(edited, destinationDeps, ["site-setting:core.site:title"]);
  await applyReport(forced, edited, destinationDeps);
  assert.equal(await workspaceValue(destination, "core.site.title"), "Tovu 2");
});

test("a title the destination's bounds reject is blocked, not written", async () => {
  const { source, destination, sourceDeps, destinationDeps } = await sites();
  await write(source, "core.site:title", "Tovu");
  const [title] = await packAll(sourceDeps);
  const handler = buildPublishContentCatalog(destinationDeps).handlerByType.get("site-setting")!;
  await assert.rejects(
    handler.apply({ entity: { ...title!, state: { ...title!.state, value: "   " } }, expectedVersion: undefined, principalId: "owner", idempotencyKey: "k" }),
    (err: unknown) => err instanceof PublishContentApplyRowError && err.rowOutcome === "blocked"
  );
  assert.equal(await workspaceValue(destination, "core.site.title"), undefined);
});

test("active theme: a missing theme folder is refused; once it is there the switch lands and re-plans unchanged", async () => {
  const { source, destination, sourceDeps, destinationDeps } = await sites();
  source.themes.push(theme("static", "basic"));
  await source.presentation.save({ workspaceId: WORKSPACE_ID, activeThemeId: "basic", updatedAt: at });
  await destination.presentation.save({ workspaceId: WORKSPACE_ID, activeThemeId: "paper", updatedAt: at });
  destination.themes.push(theme("static", "paper"));

  const entities = await packAll(sourceDeps);
  assert.deepEqual(ids(entities), ["active-theme:site"]);
  // Packed under its current name, with the folder a scoped publish carries.
  assert.deepEqual(entities[0]!.state, { label: "tovu-theme", themeId: "tovu-theme", tree: "static/basic" });
  const handler = buildPublishContentCatalog(sourceDeps).handlerByType.get("active-theme")!;
  assert.deepEqual(handler.references!(entities[0]!), [{ entityType: "theme-files", key: "static/basic" }]);

  const forced = await plan(entities, destinationDeps, ["active-theme:site"]);
  assert.equal(forced.rows[0]!.outcome, "forced");
  await assert.rejects(applyReport(forced, entities, destinationDeps), (err: unknown) => {
    assert.ok(err instanceof PublishContentApplyRowError && err.rowOutcome === "blocked");
    assert.equal(err.message, "active theme 'tovu-theme' is not installed at this destination");
    assert.equal(friendlyPublishReason(err.message), "This theme isn't on the live site yet. Publish the theme too.");
    return true;
  });
  assert.equal((await destination.presentation.findByWorkspaceId(WORKSPACE_ID))!.activeThemeId, "paper");

  // An older destination holding only the retired `basic` folder.
  destination.themes.push(theme("static", "basic"));
  await applyReport(forced, entities, destinationDeps);
  assert.equal((await destination.presentation.findByWorkspaceId(WORKSPACE_ID))!.activeThemeId, "basic");
  assert.deepEqual((await plan(entities, destinationDeps)).rows.map((r) => r.outcome), ["unchanged"]);

  // Once the renamed folder arrives too, the current name wins.
  destination.themes.push(theme("static", "tovu-theme"));
  await destination.presentation.save({ workspaceId: WORKSPACE_ID, activeThemeId: "paper", updatedAt: at });
  const again = await plan(entities, destinationDeps, ["active-theme:site"]);
  await applyReport(again, entities, destinationDeps);
  assert.equal((await destination.presentation.findByWorkspaceId(WORKSPACE_ID))!.activeThemeId, "tovu-theme");
});

test("active theme: a destination with no presentation row is refused cleanly", async () => {
  const { source, destination, sourceDeps, destinationDeps } = await sites();
  await source.presentation.save({ workspaceId: WORKSPACE_ID, activeThemeId: "paper", updatedAt: at });
  destination.themes.push(theme("static", "paper"));
  const entities = await packAll(sourceDeps);
  const report = await plan(entities, destinationDeps);
  assert.equal(report.rows[0]!.outcome, "created");
  await assert.rejects(
    applyReport(report, entities, destinationDeps),
    (err: unknown) => err instanceof PublishContentApplyRowError && err.rowOutcome === "blocked"
  );
  assert.equal(await destination.presentation.findByWorkspaceId(WORKSPACE_ID), null);
});
