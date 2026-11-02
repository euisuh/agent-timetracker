import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { headers, request, reset, start, stop } from "./harness.mjs";

const auth = headers("alice", "test-token");

async function entry(body = {}) {
  const res = await request("/api/timesheets", {
    method: "POST",
    headers: auth,
    body: { project: "etc", activity: "Assigned Task", description: "task", ...body },
  });
  assert.equal(res.status, 200);
  return res.body;
}

before(start);
beforeEach(reset);
after(stop);

test("second end keeps end", async () => {
  const created = await entry();
  const end = "2030-01-01T01:00:00Z";
  assert.equal((await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: auth, body: { end } })).status, 200);

  const updated = await request(`/api/timesheets/${created.id}`, {
    method: "PATCH",
    headers: auth,
    body: { end_reason: "done", project: "research", description: "late tokens", tokens: { input: 12 } },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.end, "2030-01-01T01:00:00.000Z");
  assert.equal(updated.body.project_id, 2);
  assert.equal(updated.body.description, "late tokens");
  assert.equal(updated.body.tokens_input, 12);
});

test("end before begin is 400", async () => {
  const created = await entry({ begin: "2030-01-01T01:00:00Z" });
  const res = await request(`/api/timesheets/${created.id}`, {
    method: "PATCH",
    headers: auth,
    body: { end: "2030-01-01T00:00:00Z" },
  });
  assert.equal(res.status, 400);
});

test("resume of running task is 409", async () => {
  const created = await entry();
  const res = await request("/api/timesheets", { method: "POST", headers: auth, body: { resume_of: created.id } });
  assert.equal(res.status, 409);
});

test("repo patch does not end", async () => {
  const created = await entry();
  const updated = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: auth, body: { repo: "other-repo" } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.repo, "other-repo");
  assert.equal(updated.body.end, null);
});

test("activity patch validates activity", async () => {
  const created = await entry();
  const updated = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: auth, body: { activity: "missing" } });
  assert.equal(updated.status, 400);
});

test("completing a paused entry preserves duration and tokens and is idempotent", async () => {
  const created = await entry();
  const paused = await request(`/api/timesheets/${created.id}`, {
    method: "PATCH", headers: auth,
    body: { end_reason: "paused", tokens_by_agent: { alice: { input: 12, output: 7, cache_read: 3 } } },
  });
  assert.equal(paused.status, 200);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const completed = await request(`/api/timesheets/${created.id}`, {
      method: "PATCH", headers: auth, body: { end_reason: "done" },
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.end_reason, "done");
    assert.equal(completed.body.begin, paused.body.begin);
    assert.equal(completed.body.end, paused.body.end);
    for (const key of ["tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write", "tokens_by_agent"]) {
      assert.deepEqual(completed.body[key], paused.body[key]);
    }
  }
});

test("closed entry metadata and token edits preserve its lifecycle status", async () => {
  for (const end_reason of ["paused", "done", "auto"]) {
    const created = await entry();
    const closed = await request(`/api/timesheets/${created.id}`, {
      method: "PATCH", headers: auth, body: { end_reason },
    });
    for (const body of [{ description: "corrected" }, { tokens: { output: 8 } }, { tokens_by_agent: { alice: { input: 5 } } }]) {
      const edited = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: auth, body });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.end, closed.body.end);
      assert.equal(edited.body.end_reason, end_reason);
      assert.equal(edited.body.auto_closed, closed.body.auto_closed);
    }
  }
});

test("reopening rejects a second running segment of the same task", async () => {
  const created = await entry();
  await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: auth, body: { end_reason: "paused" } });
  const resumed = await request("/api/timesheets", { method: "POST", headers: auth, body: { resume_of: created.id } });
  assert.equal(resumed.status, 200);
  const rejected = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: auth, body: { end: null } });
  assert.equal(rejected.status, 409);
  const original = await request(`/api/timesheets/${created.id}`, { headers: auth });
  assert.equal(original.body.end_reason, "paused");
  const running = await request(`/api/timesheets/${resumed.body.id}`, { headers: auth });
  assert.equal(running.body.end, null);
  const repeated = await request(`/api/timesheets/${resumed.body.id}`, { method: "PATCH", headers: auth, body: { end: null } });
  assert.equal(repeated.status, 200);
});
