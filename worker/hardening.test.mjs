import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { headers, request, reset, start, stop } from "./harness.mjs";

const alice = headers("alice", "test-token");
const bob = headers("bob", "test-token");
const task = { project: "etc", activity: "Assigned Task", description: "task" };

before(start);
beforeEach(reset);
after(stop);

test("concurrent implicit ends keep the first committed end", async () => {
  const { body: created } = await request("/api/timesheets", { method: "POST", headers: alice, body: task });
  const ends = await Promise.all(Array.from({ length: 8 }, (_, i) => request(`/api/timesheets/${created.id}`, {
    method: "PATCH", headers: alice, body: { end_reason: i % 2 ? "done" : "paused" },
  })));
  assert.deepEqual(ends.map(res => res.status), Array(8).fill(200));
  const { body: stored } = await request(`/api/timesheets/${created.id}`, { headers: alice });
  // Every caller sees the same end; a later double-end must not move it.
  assert.deepEqual(new Set(ends.map(res => res.body.end)), new Set([stored.end]));
  const late = await request(`/api/timesheets/${created.id}`, { method: "PATCH", headers: alice, body: {} });
  assert.equal(late.body.end, stored.end);
});

test("concurrent starts from different agents create separate owned entries", async () => {
  const results = await Promise.all([alice, bob, alice, bob].map(auth => request("/api/timesheets", { method: "POST", headers: auth, body: task })));
  assert.deepEqual(results.map(res => res.status), [200, 200, 200, 200]);
  assert.equal(new Set(results.map(res => res.body.id)).size, 4);
  assert.deepEqual(results.map(res => res.body.user_id), [2, 3, 2, 3]);
  assert.deepEqual(results.map(res => res.body.task_id), results.map(res => res.body.id));
});

test("pause then resume pairs the new segment with the paused task", async () => {
  const { body: first } = await request("/api/timesheets", { method: "POST", headers: alice, body: task });
  await request(`/api/timesheets/${first.id}`, { method: "PATCH", headers: alice, body: { end_reason: "paused" } });
  const resumes = await Promise.all([1, 2].map(() => request("/api/timesheets", { method: "POST", headers: alice, body: { resume_of: first.id } })));
  assert.deepEqual(resumes.map(res => res.status).sort(), [200, 409]);
  const resumed = resumes.find(res => res.status === 200).body;
  assert.equal(resumed.task_id, first.id);
  assert.equal(resumed.description, "task");
  assert.equal((await request("/api/timesheets/" + first.id, { headers: alice })).body.end_reason, "paused");
});

test("oversized text fields are rejected at the boundary", async () => {
  const long = "x".repeat(1001);
  for (const body of [{ ...task, description: long }, { ...task, repo: long }]) {
    const res = await request("/api/timesheets", { method: "POST", headers: alice, body });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  }
  assert.equal((await request("/api/projects", { method: "POST", headers: alice, body: { name: long } })).status, 400);
  assert.equal((await request("/api/timesheets", { method: "POST", headers: alice, body: { ...task, description: "x".repeat(1000) } })).status, 200);
});
