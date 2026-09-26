import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createApp, createRouteDeps } from "../runtime/composition/app.js";

test("packet-one admin and content routes expose the seeded post loop", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Admin routes are gated by requireAdminSession — establish a session first.
  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const postResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts/post-home`, {
    headers: { cookie },
  });
  assert.equal(postResponse.status, 200);
  const postPayload = (await postResponse.json()) as {
    post: { id: string; slug: string; title: string };
  };
  assert.equal(postPayload.post.id, "post-home");
  assert.equal(postPayload.post.slug, "welcome");

  // "column" was archived (commit 4f6ce567, "6 new static themes... archive old ones") and is no
  // longer a discoverable built-in theme, so `validThemeIds` rejects it with a 400. "basic" is a
  // live theme under `content/themes/static/` this seeded workspace can actually switch to.
  const themeUpdate = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/presentation`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ activeThemeId: "tovu-theme" }),
  });
  assert.equal(themeUpdate.status, 200);
  const themePayload = (await themeUpdate.json()) as {
    settings: { activeThemeId: string };
  };
  assert.equal(themePayload.settings.activeThemeId, "tovu-theme");

  const saveResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts/post-home`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Welcome to Tovu",
      slug: "welcome",
      bodyJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Packet one is alive." }],
          },
        ],
      },
      status: "published",
    }),
  });
  assert.equal(saveResponse.status, 200);

  const contentResponse = await fetch(`${baseUrl}/api/content/v1/workspaces/workspace-local/posts/welcome`);
  assert.equal(contentResponse.status, 200);
  const contentPayload = (await contentResponse.json()) as {
    post: { title: string; workspaceId?: string; version?: number; status?: string };
    presentation: { activeThemeId: string };
  };
  assert.equal(contentPayload.post.title, "Welcome to Tovu");
  assert.equal(contentPayload.post.workspaceId, undefined);
  assert.equal(contentPayload.post.version, undefined);
  assert.equal(contentPayload.post.status, undefined);
  assert.equal(contentPayload.presentation.activeThemeId, "tovu-theme");
});

test("POST posts creates a blank draft and it's immediately listed", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const createResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Draft Idea" }),
  });
  assert.equal(createResponse.status, 201);
  const createPayload = (await createResponse.json()) as {
    post: { id: string; slug: string; title: string; status: string; version: number };
  };
  assert.equal(createPayload.post.title, "Draft Idea");
  assert.equal(createPayload.post.slug, "draft-idea");
  assert.equal(createPayload.post.status, "draft");
  assert.equal(createPayload.post.version, 1);

  const listResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    headers: { cookie },
  });
  const listPayload = (await listResponse.json()) as { posts: Array<{ post: { id: string } }> };
  assert.ok(listPayload.posts.some((entry) => entry.post.id === createPayload.post.id));
});

test("POST_CREATE: honors caller-supplied slug/bodyJson/status instead of always deriving/blanking/drafting them", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const bodyJson = { type: "doc", content: [{ type: "paragraph" }] };
  const createResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Draft Idea", slug: "custom-slug", bodyJson, status: "published" }),
  });
  assert.equal(createResponse.status, 201);
  const createPayload = (await createResponse.json()) as {
    post: { slug: string; status: string; bodyJson: unknown };
  };
  assert.equal(createPayload.post.slug, "custom-slug");
  assert.equal(createPayload.post.status, "published");
  assert.deepEqual(createPayload.post.bodyJson, bodyJson);
});

// SPEC-002 api.spec.md §4 / behavior.spec.md §4 — 1 MiB route-layer body cap (Security review
// SEC-snapshot-and-post-create-2026-07-28, Finding 1). The oversized request must never reach
// `createPost`/the command gateway: confirmed here by asserting nothing is created for the slug.
test("POST_CREATE: 413 PAYLOAD_TOO_LARGE for a body over 1 MiB, nothing written; a body just under the cap still succeeds", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const oversizedResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Oversized Post",
      slug: "oversized-post",
      bodyJson: { type: "doc", content: [{ type: "text", text: "a".repeat(1_100_000) }] },
    }),
  });
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), {
    error: "Content too large to save.",
    code: "PAYLOAD_TOO_LARGE",
  });

  const notCreated = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    headers: { cookie },
  });
  const notCreatedPayload = (await notCreated.json()) as { posts: Array<{ post: { slug: string } }> };
  assert.ok(!notCreatedPayload.posts.some((entry) => entry.post.slug === "oversized-post"));

  // Regression guard: a body comfortably under the 1 MiB cap must still succeed (no over-rejection).
  const underCapResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Comfortably Under Cap",
      slug: "under-cap-post",
      bodyJson: { type: "doc", content: [{ type: "text", text: "a".repeat(1000) }] },
    }),
  });
  assert.equal(underCapResponse.status, 201);
});

// Same 1 MiB cap, sibling update endpoint: api.spec.md §4 / behavior.spec.md §4 scope the bound to
// the content-entry create *and* update endpoints. Proof the oversized request never reaches
// `updatePost`/the command gateway: the stored post is still at its seeded title and version.
test("POST_UPDATE: 413 PAYLOAD_TOO_LARGE for a body over 1 MiB, nothing persisted; a body just under the cap still succeeds", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const oversizedResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts/post-home`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Oversized Update",
      slug: "welcome",
      bodyJson: { type: "doc", content: [{ type: "text", text: "a".repeat(1_100_000) }] },
      status: "published",
    }),
  });
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), {
    error: "Content too large to save.",
    code: "PAYLOAD_TOO_LARGE",
  });

  const notUpdated = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts/post-home`, {
    headers: { cookie },
  });
  const notUpdatedPayload = (await notUpdated.json()) as { post: { title: string; version: number } };
  assert.equal(notUpdatedPayload.post.title, "Welcome to Tovu");
  assert.equal(notUpdatedPayload.post.version, 1);

  // Regression guard: a body comfortably under the 1 MiB cap must still update (no over-rejection).
  const underCapResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts/post-home`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Comfortably Under Cap",
      slug: "welcome",
      bodyJson: { type: "doc", content: [{ type: "text", text: "a".repeat(1000) }] },
      status: "published",
    }),
  });
  assert.equal(underCapResponse.status, 200);
  assert.equal(((await underCapResponse.json()) as { post: { title: string } }).post.title, "Comfortably Under Cap");
});

test("POST_CREATE: 400 VALIDATION_ERROR for a malformed slug, 409 SLUG_CONFLICT for a taken slug", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const badSlug = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Bad Slug Post", slug: "Not A Slug!" }),
  });
  assert.equal(badSlug.status, 400);
  assert.equal(((await badSlug.json()) as { code: string }).code, "VALIDATION_ERROR");

  const firstPost = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "First Post" }),
  });
  const firstPostPayload = (await firstPost.json()) as { post: { slug: string } };

  const slugTaken = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Second Post", slug: firstPostPayload.post.slug }),
  });
  assert.equal(slugTaken.status, 409);
  assert.equal(((await slugTaken.json()) as { code: string }).code, "SLUG_CONFLICT");
});

test("POST pages creates a blank draft with kind 'page', it's listed under pages but not posts", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const createResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "About Us" }),
  });
  assert.equal(createResponse.status, 201);
  const createPayload = (await createResponse.json()) as {
    post: { id: string; slug: string; title: string; status: string; version: number };
  };
  assert.equal(createPayload.post.title, "About Us");
  assert.equal(createPayload.post.slug, "about-us");
  assert.equal(createPayload.post.status, "draft");
  assert.equal(createPayload.post.version, 1);

  const pagesListResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    headers: { cookie },
  });
  const pagesListPayload = (await pagesListResponse.json()) as {
    posts: Array<{ post: { id: string } }>;
  };
  assert.ok(pagesListPayload.posts.some((entry) => entry.post.id === createPayload.post.id));

  // The new page must NOT show up on the posts list.
  const postsListResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    headers: { cookie },
  });
  const postsListPayload = (await postsListResponse.json()) as {
    posts: Array<{ post: { id: string } }>;
  };
  assert.ok(!postsListPayload.posts.some((entry) => entry.post.id === createPayload.post.id));

  // The generic posts/:id GET route still works for a page — same table, same editor.
  const getResponse = await fetch(
    `${baseUrl}/api/admin/v1/workspaces/workspace-local/posts/${createPayload.post.id}`,
    { headers: { cookie } }
  );
  assert.equal(getResponse.status, 200);
});

test("PAGE_CREATE: honors caller-supplied slug/bodyJson/status, 400 VALIDATION_ERROR / 409 SLUG_CONFLICT on bad input", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const bodyJson = { type: "doc", content: [{ type: "paragraph" }] };
  const createResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Contact", slug: "custom-contact", bodyJson, status: "published" }),
  });
  assert.equal(createResponse.status, 201);
  const createPayload = (await createResponse.json()) as {
    post: { slug: string; status: string; bodyJson: unknown };
  };
  assert.equal(createPayload.post.slug, "custom-contact");
  assert.equal(createPayload.post.status, "published");
  assert.deepEqual(createPayload.post.bodyJson, bodyJson);

  const badSlug = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Bad Slug Page", slug: "Not A Slug!" }),
  });
  assert.equal(badSlug.status, 400);
  assert.equal(((await badSlug.json()) as { code: string }).code, "VALIDATION_ERROR");

  const slugTaken = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Another Contact", slug: "custom-contact" }),
  });
  assert.equal(slugTaken.status, 409);
  assert.equal(((await slugTaken.json()) as { code: string }).code, "SLUG_CONFLICT");
});

test("pages routes 404 for an unknown workspace id", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const listResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/nope/pages`, {
    headers: { cookie },
  });
  assert.equal(listResponse.status, 404);

  const createResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/nope/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Nope" }),
  });
  assert.equal(createResponse.status, 404);
});

test("GET/PUT a page round-trips, and both 404 when the id belongs to a post (kind mismatch)", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const createResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Contact" }),
  });
  assert.equal(createResponse.status, 201);
  const createPayload = (await createResponse.json()) as { post: { id: string } };
  const pageId = createPayload.post.id;

  const getResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/${pageId}`, {
    headers: { cookie },
  });
  assert.equal(getResponse.status, 200);
  const getPayload = (await getResponse.json()) as { post: { id: string; kind: string; title: string } };
  assert.equal(getPayload.post.id, pageId);
  assert.equal(getPayload.post.kind, "page");
  assert.equal(getPayload.post.title, "Contact");

  const updateResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/${pageId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Contact Us",
      slug: "contact-us",
      bodyJson: { type: "doc", content: [] },
      status: "published",
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updatePayload = (await updateResponse.json()) as {
    post: { title: string; slug: string; status: string; version: number };
  };
  assert.equal(updatePayload.post.title, "Contact Us");
  assert.equal(updatePayload.post.slug, "contact-us");
  assert.equal(updatePayload.post.status, "published");
  assert.equal(updatePayload.post.version, 2);

  // `post-home` (seeded, kind "post") must 404 through the pages id routes — kind mismatch is
  // indistinguishable from not-found (api.spec.md SPEC-002 §6/§7), and both new endpoints carry
  // the required `code: "ENTRY_NOT_FOUND"` (errors.spec.md §1/§4 — new endpoints require `code`,
  // unlike the legacy message-only `/posts` 404s).
  const getKindMismatch = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/post-home`, {
    headers: { cookie },
  });
  assert.equal(getKindMismatch.status, 404);
  assert.equal(((await getKindMismatch.json()) as { code: string }).code, "ENTRY_NOT_FOUND");

  const putKindMismatch = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/post-home`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "x", slug: "x", bodyJson: {}, status: "draft" }),
  });
  assert.equal(putKindMismatch.status, 404);
  assert.equal(((await putKindMismatch.json()) as { code: string }).code, "ENTRY_NOT_FOUND");

  // An entirely unknown id 404s too (ordinary not-found, not just kind mismatch).
  const getUnknown = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/does-not-exist`, {
    headers: { cookie },
  });
  assert.equal(getUnknown.status, 404);
  assert.equal(((await getUnknown.json()) as { code: string }).code, "ENTRY_NOT_FOUND");
});

test("PAGE_UPDATE: 400 VALIDATION_ERROR for a blank title, 409 SLUG_CONFLICT for a taken slug", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const firstPage = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "First Page" }),
  });
  const firstPagePayload = (await firstPage.json()) as { post: { id: string; slug: string } };

  const secondPage = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Second Page" }),
  });
  const secondPagePayload = (await secondPage.json()) as { post: { id: string } };

  const blankTitle = await fetch(
    `${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/${secondPagePayload.post.id}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "  ", slug: "second-page", bodyJson: {}, status: "draft" }),
    }
  );
  assert.equal(blankTitle.status, 400);
  assert.equal(((await blankTitle.json()) as { code: string }).code, "VALIDATION_ERROR");

  const slugTaken = await fetch(
    `${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/${secondPagePayload.post.id}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        title: "Second Page",
        slug: firstPagePayload.post.slug,
        bodyJson: {},
        status: "draft",
      }),
    }
  );
  assert.equal(slugTaken.status, 409);
  assert.equal(((await slugTaken.json()) as { code: string }).code, "SLUG_CONFLICT");
});

// Same 1 MiB cap as `PAGE_CREATE` (api.spec.md §4 / behavior.spec.md §4 cover the sibling update
// endpoints too). Proof the oversized request never reaches `updatePost`/the command gateway: the
// stored page is still at its post-create title and version.
test("PAGE_UPDATE: 413 PAYLOAD_TOO_LARGE for a body over 1 MiB, nothing persisted; a body just under the cap still succeeds", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const createResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title: "Sizable Page" }),
  });
  assert.equal(createResponse.status, 201);
  const pageId = ((await createResponse.json()) as { post: { id: string } }).post.id;

  const oversizedResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/${pageId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Oversized Page Update",
      slug: "sizable-page",
      bodyJson: { type: "doc", content: [{ type: "text", text: "a".repeat(1_100_000) }] },
      status: "published",
    }),
  });
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), {
    error: "Content too large to save.",
    code: "PAYLOAD_TOO_LARGE",
  });

  const notUpdated = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/${pageId}`, {
    headers: { cookie },
  });
  const notUpdatedPayload = (await notUpdated.json()) as { post: { title: string; version: number } };
  assert.equal(notUpdatedPayload.post.title, "Sizable Page");
  assert.equal(notUpdatedPayload.post.version, 1);

  // Regression guard: a body comfortably under the 1 MiB cap must still update (no over-rejection).
  const underCapResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/pages/${pageId}`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      title: "Comfortably Under Cap Page",
      slug: "sizable-page",
      bodyJson: { type: "doc", content: [{ type: "text", text: "a".repeat(1000) }] },
      status: "published",
    }),
  });
  assert.equal(underCapResponse.status, 200);
  assert.equal(
    ((await underCapResponse.json()) as { post: { title: string } }).post.title,
    "Comfortably Under Cap Page"
  );
});

test("GET themes lists discovered built-in themes, TB-01 ordered, exactly one marked active", async (t) => {
  const server = createServer(createApp());
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

  const themesResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/themes`, {
    headers: { cookie },
  });
  assert.equal(themesResponse.status, 200);
  const themesPayload = (await themesResponse.json()) as {
    themes: Array<{
      id: string;
      name: string;
      version: string;
      source: string;
      status: string;
      errors: Array<{ code: string | null; file: string | null; message: string }>;
      active: boolean;
    }>;
  };

  // The seeded built-in theme folders (`themes/` top level + `themes/templated/` + the Handlebars
  // tier under `themes/handlebars/`), TB-01 ordered (built-in first, id asc). `storefront` shipped
  // templates/home.liquid and templates/products.liquid but no templates/entry.liquid for a while
  // (a genuine WIP gap, since fixed) — this endpoint reports every discovered theme regardless of
  // validity, not just the valid ones, so a still-invalid theme would appear here too.
  //
  // Adding a theme folder means updating this list; it is an exact match on purpose, so a theme
  // that silently stops being discovered fails here rather than going unnoticed.
  assert.deepEqual(
    themesPayload.themes.map((t) => t.id),
    [
      "basic-2",
      "basic-declarative",
      "fashion-modern",
      // No `mui-marketing` here on purpose. That folder was swept in by 39096e15 (the ESM root
      // flip) alongside the ARCH-001 scratch dirs, and its own manifest called it a "Test theme
      // ... experiment" that "bypasses the conformance gate rather than passing it" — so it was
      // removed from the product rather than blessed into this list. Restore with
      // `git checkout 39096e15 -- content/themes/static/mui-marketing`, and if you do, add it back
      // here: this endpoint reports EVERY discovered theme regardless of validity (see the
      // comment above), so a restored folder WILL appear and fail this exact-match assertion.
      "storefront",
      "tailark-dusk",
      "tailark-quartz-dark",
      "tailark-quartz-libre",
      "tovu-theme",
    ]
  );
  assert.ok(themesPayload.themes.every((t) => t.source === "built-in"));
  assert.ok(themesPayload.themes.every((t) => Array.isArray(t.errors)));

  // Exactly one theme is active, matching the seeded default (server/seed.ts).
  const activeThemes = themesPayload.themes.filter((t) => t.active);
  assert.equal(activeThemes.length, 1);
  assert.equal(activeThemes[0].id, "tovu-theme");
});

test("GET themes 404s for an unknown workspace id and 403s without theme.set", async (t) => {
  const deps = createRouteDeps();
  const server = createServer(createApp(deps));
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const ownerCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const bareCookie = await loginAsBarePrincipal(deps, baseUrl, "themes");

  const unknownWorkspace = await fetch(`${baseUrl}/api/admin/v1/workspaces/nope/themes`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(unknownWorkspace.status, 404);

  const denied = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/themes`, {
    headers: { cookie: bareCookie },
  });
  assert.equal(denied.status, 403);
  const deniedBody = (await denied.json()) as { code: string; details: { permission: string } };
  assert.equal(deniedBody.code, "FORBIDDEN");
  assert.equal(deniedBody.details.permission, "theme.set");
});

/**
 * Registers a principal with a login but no role/policy grants at all — `authorize()` returns
 * `no_grant` for any permission it's checked against (mirrors `identity-routes.test.ts`'s viewer
 * construction, minus the role assignment). Used below to prove the denied side of `theme.set` /
 * `changeset.read` / `changeset.revert`.
 */
async function loginAsBarePrincipal(
  deps: ReturnType<typeof createRouteDeps>,
  baseUrl: string,
  usernameSuffix: string
): Promise<string> {
  await deps.identityReady;
  const bareId = `bare-principal-${usernameSuffix}`;
  await deps.principalRepo.save({
    id: bareId,
    workspaceId: deps.workspaceId,
    kind: "user",
    displayName: "No Grants",
    status: "active",
    createdAt: deps.clock.nowIso(),
  });
  await deps.userRepo.save({
    principalId: bareId,
    workspaceId: deps.workspaceId,
    username: `bare-${usernameSuffix}`,
    passwordHash: await deps.passwordHasher.hash("bare-pw"),
  });

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: `bare-${usernameSuffix}`, password: "bare-pw" }),
  });
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie")?.split(";")[0] ?? "";
}

test("SPEC-006 REQ-05: presentation routes are gated by theme.set — a principal without it is denied 403, the owner still succeeds", async (t) => {
  const deps = createRouteDeps();
  const server = createServer(createApp(deps));
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const ownerCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const bareCookie = await loginAsBarePrincipal(deps, baseUrl, "presentation");

  const getDenied = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/presentation`, {
    headers: { cookie: bareCookie },
  });
  assert.equal(getDenied.status, 403);
  const getDeniedBody = (await getDenied.json()) as { code: string; details: { permission: string; reason: string } };
  assert.equal(getDeniedBody.code, "FORBIDDEN");
  assert.equal(getDeniedBody.details.permission, "theme.set");
  assert.equal(getDeniedBody.details.reason, "no_grant");

  const patchDenied = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/presentation`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: bareCookie },
    body: JSON.stringify({ activeThemeId: "column" }),
  });
  assert.equal(patchDenied.status, 403);

  const getAllowed = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/presentation`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(getAllowed.status, 200);
});

test("SPEC-006 REQ-05: change-set routes are gated by changeset.read/changeset.revert — a principal without them is denied 403, the owner still succeeds", async (t) => {
  const deps = createRouteDeps();
  const server = createServer(createApp(deps));
  server.listen(0);
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/admin/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "tovu-dev" }),
  });
  const ownerCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const bareCookie = await loginAsBarePrincipal(deps, baseUrl, "changesets");

  // Owner creates a post — the command gateway auto-records a change set to revert.
  const createResponse = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ title: "Revert Me" }),
  });
  assert.equal(createResponse.status, 201);

  const listAllowed = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/change-sets`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(listAllowed.status, 200);
  const { changeSets } = (await listAllowed.json()) as { changeSets: Array<{ id: string }> };
  assert.ok(changeSets.length > 0, "the post create recorded a change set");
  const changeSetId = changeSets[0].id;

  const listDenied = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/change-sets`, {
    headers: { cookie: bareCookie },
  });
  assert.equal(listDenied.status, 403);
  const listDeniedBody = (await listDenied.json()) as { code: string; details: { permission: string; reason: string } };
  assert.equal(listDeniedBody.code, "FORBIDDEN");
  assert.equal(listDeniedBody.details.permission, "changeset.read");
  assert.equal(listDeniedBody.details.reason, "no_grant");

  const getDenied = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/change-sets/${changeSetId}`, {
    headers: { cookie: bareCookie },
  });
  assert.equal(getDenied.status, 403);

  const revertDenied = await fetch(
    `${baseUrl}/api/admin/v1/workspaces/workspace-local/change-sets/${changeSetId}/revert`,
    { method: "POST", headers: { cookie: bareCookie } }
  );
  assert.equal(revertDenied.status, 403);
  const revertDeniedBody = (await revertDenied.json()) as {
    code: string;
    details: { permission: string; reason: string };
  };
  assert.equal(revertDeniedBody.details.permission, "changeset.revert");

  // The change set survives the denied revert attempt untouched (still "applied").
  const getAllowed = await fetch(`${baseUrl}/api/admin/v1/workspaces/workspace-local/change-sets/${changeSetId}`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(getAllowed.status, 200);
  const getAllowedBody = (await getAllowed.json()) as { changeSet: { status: string } };
  assert.equal(getAllowedBody.changeSet.status, "applied", "the denied revert must not have applied");
});
