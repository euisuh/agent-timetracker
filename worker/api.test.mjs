import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { accessJwt, headers, request, reset, start, stop } from "./harness.mjs";

async function dashboardHeaders(payload, key) {
  return {
    Host: "time.example.com",
    "Cf-Access-Jwt-Assertion": await accessJwt(payload, key),
  };
}

async function entry(username, description = "task") {
  const res = await request("/api/timesheets", {
    method: "POST",
    headers: headers(username, "test-token"),
    body: { project: "etc", activity: "Assigned Task", description },
  });
  assert.equal(res.status, 200);
  return res.body;
}

before(start);

beforeEach(reset);
after(stop);

test("auth, create, patch, filtering", async () => {
  assert.equal((await request("/api/projects")).status, 401);
  const created = (await request("/api/timesheets", { method: "POST", headers: headers("alice", "test-token"), body: { project: "etc", activity: "Assigned Task", description: "task", begin: "2026-01-01T00:00:00Z" } })).body;
  assert.equal((await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { end: "2026-01-01T01:00:00Z" } })).body.end, "2026-01-01T01:00:00.000Z");
  assert.deepEqual((await request("/api/timesheets?user=alice", { headers: headers("bob", "test-token") })).body, []);
  assert.equal((await request(`/api/timesheets/${created.id}`, { headers: headers("bob", "test-token") })).status, 403);
});

test("access JWT authenticates dashboard requests", async () => {
  const res = await request("/api/projects", { headers: await dashboardHeaders() });
  assert.equal(res.status, 200);
});

test("access rejects expired, wrong audience, wrong signature, and header-only JWTs", async () => {
  assert.equal((await request("/api/projects", { headers: { Host: "time.example.com", "cf-access-authenticated-user-email": "owner@example.com" } })).status, 401);
  assert.equal((await request("/api/projects", { headers: await dashboardHeaders({ exp: Math.floor(Date.now() / 1000) - 1 }) })).status, 401);
  assert.equal((await request("/api/projects", { headers: await dashboardHeaders({ aud: "wrong-aud" }) })).status, 401);
  assert.equal((await request("/api/projects", { headers: await dashboardHeaders({ exp: undefined }) })).status, 401);
  const wrongKey = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])).privateKey;
  assert.equal((await request("/api/projects", { headers: await dashboardHeaders({}, wrongKey) })).status, 401);
});

test("access dashboard mutations reject cross-origin requests", async () => {
  const denied = await request("/api/projects", {
    method: "POST",
    headers: { ...(await dashboardHeaders()), Origin: "https://evil.example" },
    body: { name: "blocked-origin" },
  });
  assert.equal(denied.status, 403);
  const allowed = await request("/api/projects", {
    method: "POST",
    headers: { ...(await dashboardHeaders()), Origin: "https://time.example.com" },
    body: { name: "same-origin" },
  });
  assert.equal(allowed.status, 200);
});

test("create strips description", async () => assert.equal((await entry("alice", "  padded task  ")).description, "padded task"));

test("new timesheets assign their task id atomically", async () => {
  const created = await entry("alice");
  assert.equal(created.task_id, created.id);
  const workerSource = await readFile(new URL("./index.js", import.meta.url), "utf8");
  assert.match(workerSource, /await db\.batch\(statements\)/);
  assert.match(workerSource, /UPDATE timesheets SET task_id = id WHERE id = last_insert_rowid\(\)/);
});

test("repo is recorded and filters timesheets", async () => {
  const create = repo => request("/api/timesheets", {
    method: "POST",
    headers: headers("alice", "test-token"),
    body: { project: "etc", activity: "Assigned Task", description: repo, repo },
  });
  const alpha = await create("alpha");
  await create("beta");

  assert.equal(alpha.body.repo, "alpha");
  assert.deepEqual(
    (await request("/api/timesheets?repo=alpha", { headers: headers("alice", "test-token") })).body.map(item => item.repo),
    ["alpha"],
  );
});

test("resume_of preserves task identity and end_reason", async () => {
  const created = await request("/api/timesheets", {
    method: "POST",
    headers: headers("alice", "test-token"),
    body: { project: "etc", activity: "Assigned Task", description: "resume task", repo: "timetracker" },
  });
  assert.equal(created.status, 200);
  const paused = await request(`/api/timesheets/${created.body.id}`, {
    method: "PATCH",
    headers: headers("alice", "test-token"),
    body: { end_reason: "paused" },
  });
  assert.equal(paused.body.end_reason, "paused");

  const resumed = await request("/api/timesheets", {
    method: "POST",
    headers: headers("alice", "test-token"),
    body: { resume_of: created.body.id },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.project_id, created.body.project_id);
  assert.equal(resumed.body.description, created.body.description);
  assert.equal(resumed.body.repo, created.body.repo);
  assert.equal(resumed.body.task_id, created.body.task_id);
  assert.equal(resumed.body.end_reason, null);
});

test("projects create, dedupe", async () => {
  const opts = { method: "POST", headers: headers("alice", "test-token"), body: { name: "new-proj" } };
  assert.equal((await request("/api/projects", opts)).status, 200);
  assert.equal((await request("/api/projects", opts)).status, 409);
  assert.equal((await request("/api/projects", { method: "POST", body: { name: "anon" } })).status, 401);
});

test("project deletion admin-only, blocks used", async () => {
  const project = await request("/api/projects", { method: "POST", headers: headers("admin", "test-token"), body: { name: "empty" } });
  assert.equal((await request(`/api/projects/${project.body.id}`, { method: "DELETE", headers: headers("alice", "test-token") })).status, 403);
  assert.equal((await request(`/api/projects/${project.body.id}`, { method: "DELETE", headers: headers("admin", "test-token") })).status, 204);
  const used = await request("/api/projects", { method: "POST", headers: headers("admin", "test-token"), body: { name: "used" } });
  await request("/api/timesheets", { method: "POST", headers: headers("alice", "test-token"), body: { project: used.body.id, activity: 1, description: "logged" } });
  assert.equal((await request(`/api/projects/${used.body.id}`, { method: "DELETE", headers: headers("admin", "test-token") })).status, 409);
});

test("projects rename admin-only, dedupe", async () => {
  const admin = headers("admin", "test-token");
  const first = await request("/api/projects", { method: "POST", headers: admin, body: { name: "a" } });
  await request("/api/projects", { method: "POST", headers: admin, body: { name: "b" } });
  assert.equal((await request(`/api/projects/${first.body.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { name: "x" } })).status, 403);
  assert.equal((await request(`/api/projects/${first.body.id}`, { method: "PATCH", headers: admin, body: { name: "b" } })).status, 409);
});

test("projects PATCH updates description and archive status", async () => {
  const admin = headers("admin", "test-token");
  const updated = await request("/api/projects/1", {
    method: "PATCH",
    headers: admin,
    body: { description: "Internal tooling", archived: true },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.description, "Internal tooling");
  assert.equal(updated.body.archived, true);
  assert.equal((await request("/api/projects/1", {
    method: "PATCH",
    headers: headers("alice", "test-token"),
    body: { archived: false },
  })).status, 403);
});

test("recommended tasks CRUD admin-only", async () => {
  const admin = headers("admin", "test-token");
  assert.equal((await request("/api/recommended-tasks", { method: "POST", headers: headers("alice", "test-token"), body: { project: "etc", description: "task" } })).status, 403);
  const created = await request("/api/recommended-tasks", { method: "POST", headers: admin, body: { project: "etc", description: "task" } });
  assert.equal((await request(`/api/recommended-tasks/${created.body.id}`, { method: "DELETE", headers: admin })).status, 204);
});

test("patch reassigns project without ending", async () => {
  const created = await entry("alice");
  const updated = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { project: "research" } });
  assert.equal(updated.body.project_id, 2);
  assert.equal(updated.body.end, null);
});

test("patch corrects description without ending", async () => {
  const created = await entry("alice");
  const updated = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { description: " corrected " } });
  assert.equal(updated.body.description, "corrected");
  assert.equal(updated.body.end, null);
  assert.equal((await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { description: " " } })).status, 400);
});

test("patch tracks tokens", async () => {
  const created = await entry("alice");
  const updated = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { tokens: { input: 10, output: 20 } } });
  assert.equal(updated.body.tokens_input, 10);
  assert.equal(updated.body.tokens_output, 20);
  assert.notEqual(updated.body.end, null);
});

test("patch splits tokens by agent", async () => {
  const created = await entry("alice");
  const updated = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { tokens_by_agent: { alice: { input: 10 }, bob: { output: 20 } } } });
  assert.equal(updated.body.tokens_input, 10);
  assert.equal(updated.body.tokens_output, 20);
  assert.equal(updated.body.tokens_by_agent.length, 2);
});

test("seed includes documented projects", async () => {
  const projects = await request("/api/projects", { headers: headers("alice", "test-token") });
  assert.deepEqual(projects.body.map(project => project.name), ["etc", "research", "work", "personal"]);
});

test("migration seed slugs match PROJECTS.md", async () => {
  const [projects, migration] = await Promise.all([
    readFile(new URL("../PROJECTS.md", import.meta.url), "utf8"),
    readFile(new URL("../migrations/0005_project_meta.sql", import.meta.url), "utf8"),
  ]);
  const documented = [...projects.matchAll(/^## ([a-z0-9-]+)$/gm)].map(([, slug]) => slug);
  const seeded = [...migration.matchAll(/\('([a-z0-9-]+)', \(SELECT id FROM customers WHERE name = 'Internal'\),/g)].map(([, slug]) => slug);
  assert.deepEqual(new Set(seeded), new Set(documented));
});

test("rotate token invalidates old token", async () => {
  const users = await request("/api/users", { headers: headers("admin", "test-token") });
  const bob = users.body.find(user => user.username === "bob");
  const rotated = await request(`/api/users/${bob.id}/rotate-token`, { method: "POST", headers: headers("admin", "test-token") });
  assert.equal((await request("/api/timesheets", { headers: headers("bob", "test-token") })).status, 401);
  assert.equal((await request("/api/timesheets", { headers: headers("bob", rotated.body.token) })).status, 200);
});

test("health is unauthenticated", async () => assert.deepEqual((await request("/health")).body, { status: "ok", database: "D1" }));

test("stale entry closes on next start", async () => {
  const stale = await request("/api/timesheets", { method: "POST", headers: headers("alice", "test-token"), body: { project: "etc", activity: 1, description: "old", begin: "2020-01-01T00:00:00Z" } });
  await entry("alice", "next");
  const closed = await request(`/api/timesheets/${stale.body.id}`, { headers: headers("alice", "test-token") });
  assert.equal(closed.body.auto_closed, true);
});

test("reopen rejects stale entry without changing duration", async () => {
  const created = await request("/api/timesheets", { method: "POST", headers: headers("alice", "test-token"), body: { project: "etc", activity: 1, description: "old", begin: "2020-01-01T00:00:00Z" } });
  await request(`/api/timesheets/${created.body.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { end: "2020-01-01T00:05:00Z" } });
  const reopened = await request(`/api/timesheets/${created.body.id}`, { method: "PATCH", headers: headers("alice", "test-token"), body: { end: null } });
  assert.equal(reopened.status, 409);
  assert.equal((await request(`/api/timesheets/${created.body.id}`, { headers: headers("alice", "test-token") })).body.end, "2020-01-01T00:05:00.000Z");
});

test("recent entry remains open", async () => {
  const created = await entry("alice");
  await request("/api/timesheets", { headers: headers("alice", "test-token") });
  assert.equal((await request(`/api/timesheets/${created.id}`, { headers: headers("alice", "test-token") })).body.end, null);
});

test("deployment uses the eight-hour stale threshold", async () => {
  const [config, docs] = await Promise.all([
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    readFile(new URL("../docs/MODEL_API.md", import.meta.url), "utf8"),
  ]);
  assert.match(config, /"TIMETRACKER_STALE_HOURS": "8"/);
  assert.match(docs, /deployed default 8; code fallback 2/);
});

test("scheduled sweep closes stale entries but GET does not", async () => {
  const stale = await request("/api/timesheets", { method: "POST", headers: headers("alice", "test-token"), body: { project: "etc", activity: 1, description: "old", begin: "2020-01-01T00:00:00Z" } });
  await request("/api/timesheets", { headers: headers("alice", "test-token") });
  assert.equal((await request(`/api/timesheets/${stale.body.id}`, { headers: headers("alice", "test-token") })).body.end, null);
  assert.equal((await request("/__scheduled")).status, 200);
  assert.equal((await request(`/api/timesheets/${stale.body.id}`, { headers: headers("alice", "test-token") })).body.auto_closed, true);
});

test("archived project rejects new entries", async () => {
  const archived = await request("/api/projects/1", { method: "PATCH", headers: headers("admin", "test-token"), body: { archived: true } });
  assert.equal(archived.status, 200);
  const res = await request("/api/timesheets", { method: "POST", headers: headers("alice", "test-token"), body: { project: "etc", activity: 1, description: "blocked" } });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /archived/);
});


test("review capabilities require authentication and advertise commit guards", async () => {
  assert.equal((await request("/api/capabilities")).status, 401);
  const result = await request("/api/capabilities", { headers: headers("alice", "test-token") });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { purpose_review: { version: 1, closed_only: true } });
  assert.equal((await request("/api/capabilities", { method: "POST", headers: headers("alice", "test-token"), body: {} })).status, 404);
});
