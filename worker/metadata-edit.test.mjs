import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { headers, request, reset, start, stop } from "./harness.mjs";

const auth = username => headers(username, "test-token");
const patch = (path, body, username = "alice") => request(path, { method: "PATCH", headers: auth(username), body });
const get = path => request(path, { headers: auth("alice") });
const projects = () => request("/api/projects", { headers: auth("admin") });
async function create(body = {}) {
  const result = await request("/api/timesheets", { method: "POST", headers: auth("alice"), body: {
    project: "etc", activity: "Assigned Task", description: "metadata fixture", repo: "old", ...body,
  } });
  assert.equal(result.status, 200);
  return result.body;
}

before(start);
beforeEach(reset);
after(stop);

test("project description trims and clears without changing other metadata", async () => {
  await patch("/api/projects/1", { archived: true }, "admin");
  const original = (await projects()).body[0];
  for (const [value, stored] of [["  x ", "x"], ["", ""], ["  ", ""]]) {
    const result = await patch("/api/projects/1", { description: value }, "admin");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ...original, description: stored });
    assert.deepEqual((await projects()).body[0], result.body);
  }
});

test("invalid project descriptions and non-admin changes never write", async () => {
  const original = (await projects()).body;
  for (const value of [123, null, [], {}, true]) {
    assert.equal((await patch("/api/projects/1", { name: "must not change", archived: true, description: value }, "admin")).status, 400);
    assert.deepEqual((await projects()).body, original);
  }
  assert.equal((await patch("/api/projects/1", { description: "" })).status, 403);
  assert.deepEqual((await projects()).body, original);
});

test("repo edits preserve lifecycle, counters and sibling metadata", async () => {
  const closed = await create({ begin: "2026-01-01T00:00:00Z" });
  const closedPath = `/api/timesheets/${closed.id}`;
  const ended = await patch(closedPath, { end: "2026-01-01T01:00:00Z", end_reason: "auto", tokens_by_agent: {
    alice: { input: 17, output: 3, reasoning: 2, cache_read: 7, cache_write: 1, counter_format: "codex_response_exclusive_v1" },
  } });
  assert.equal(ended.status, 200);
  assert.equal((await patch(closedPath, { end_reason: "auto" })).status, 200);
  const original = (await get(closedPath)).body;
  assert.equal(original.auto_closed, true);
  const running = await create({ resume_of: closed.id });
  const runningPath = `/api/timesheets/${running.id}`;
  const sibling = (await get(runningPath)).body;
  for (const [value, stored] of [[" a ", "a"], [null, null]]) {
    const result = await patch(closedPath, { repo: value });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ...original, repo: stored });
    assert.deepEqual((await get(runningPath)).body, sibling);
  }
  const result = await patch(runningPath, { repo: null });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ...sibling, repo: null });
  assert.deepEqual((await get("/api/timesheets?repo=old")).body, []);
});

test("invalid repos reject combined edits atomically and enforce ownership", async () => {
  const entry = await create();
  const path = `/api/timesheets/${entry.id}`;
  const original = (await get(path)).body;
  for (const repo of ["", "  ", 1, {}, [], true]) {
    assert.equal((await patch(path, { description: "must not change", end_reason: "done", repo })).status, 400);
    assert.deepEqual((await get(path)).body, original);
  }
  assert.equal((await patch(path, { repo: null }, "bob")).status, 403);
  assert.equal((await patch(path, { description: " ", repo: null })).status, 400);
  assert.deepEqual((await get(path)).body, original);
});

test("POST repo and reviewed-purpose field restrictions remain unchanged", async () => {
  for (const repo of [null, "", "  "]) {
    assert.equal((await request("/api/timesheets", { method: "POST", headers: auth("alice"), body: {
      project: "etc", activity: "Assigned Task", description: "required repo fixture", repo,
    } })).status, 400);
  }
  const entry = await create();
  const path = `/api/timesheets/${entry.id}`;
  await patch(path, { end_reason: "paused" });
  const original = (await get(path)).body;
  const { id, project_id, repo, description, begin } = original;
  assert.equal((await patch(path, { purpose: "research", purpose_review: { segments: [{ id, project_id, repo, description, begin }] }, repo: null })).status, 400);
  assert.deepEqual((await get(path)).body, original);
});
