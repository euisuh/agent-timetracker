import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, beforeEach, test } from "node:test";
import { headers, request, reset, start, stop } from "./harness.mjs";

const auth = headers("alice", "test-token");
const create = (body = {}, identity = auth) => request("/api/timesheets", { method: "POST", headers: identity, body: { project: "etc", activity: 1, description: "task", ...body } });
const patch = (id, body, identity = auth) => request(`/api/timesheets/${id}`, { method: "PATCH", headers: identity, body });
const get = async id => (await request(`/api/timesheets/${id}`, { headers: auth })).body;
const sql = command => promisify(execFile)("node_modules/.bin/wrangler", ["d1", "execute", "timetracker", "--local", "--command", command]);

before(start);
beforeEach(reset);
after(stop);

test("purpose is nullable, validated, serialized and independently filtered", async () => {
  const unknown = (await create()).body;
  assert.equal(unknown.purpose, null);
  assert.equal((await create({ purpose: null })).body.purpose, null);
  for (const purpose of ["research", "career", "business", "support"]) {
    const result = await create({ purpose });
    assert.equal(result.status, 200);
    assert.equal(result.body.purpose, purpose);
    const filtered = await request(`/api/timesheets?purpose=${purpose}&project=etc`, { headers: auth });
    assert.deepEqual(filtered.body.map(row => row.id), [result.body.id]);
  }
  const filtered = await request("/api/timesheets?purpose=unclassified", { headers: auth });
  assert.equal(filtered.body.length, 2);
  assert.ok(filtered.body.every(row => row.purpose === null));
  for (const purpose of ["Research", "", "unclassified", {}, [], true, 1]) {
    assert.equal((await create({ purpose })).status, 400);
    assert.equal((await patch(unknown.id, { purpose })).status, 400);
  }
  assert.equal((await request("/api/timesheets?purpose=Research", { headers: auth })).status, 400);
  assert.equal((await request("/api/timesheets?purpose=", { headers: auth })).status, 400);
  await assert.rejects(sql(`UPDATE timesheets SET purpose = 'invalid' WHERE id = ${unknown.id}`));
  assert.deepEqual(await get(unknown.id), unknown);
});

test("resume inherits purpose and rejects every explicit override", async () => {
  const original = (await create({ purpose: "research" })).body;
  await patch(original.id, { end_reason: "paused" });
  for (const purpose of ["research", "career", null]) {
    const denied = await request("/api/timesheets", { method: "POST", headers: auth, body: { resume_of: original.id, purpose } });
    assert.equal(denied.status, 400);
  }
  const resumed = await request("/api/timesheets", { method: "POST", headers: auth, body: { resume_of: original.id } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.purpose, "research");
  assert.equal(resumed.body.task_id, original.task_id);
});

test("task-wide corrections preserve running and closed lifecycle, tokens and context", async () => {
  const first = (await create({ purpose: "research", repo: "study" })).body;
  const paused = (await patch(first.id, { end_reason: "paused", tokens_by_agent: { alice: { input: 7 }, bob: { output: 3 } } })).body;
  const running = (await request("/api/timesheets", { method: "POST", headers: auth, body: { resume_of: first.id } })).body;
  assert.equal((await patch(first.id, { purpose: "career" })).status, 200);
  assert.deepEqual(await get(first.id), { ...paused, purpose: "career" });
  assert.deepEqual(await get(running.id), { ...running, purpose: "career" });
  assert.equal((await patch(running.id, { purpose: null })).status, 200);
  assert.deepEqual(await get(first.id), { ...paused, purpose: null });
  assert.deepEqual(await get(running.id), { ...running, purpose: null });
});

test("purpose correction authorizes first and isolates owners even for colliding task IDs", async () => {
  const alice = (await create({ purpose: "research" })).body;
  const bob = (await create({ purpose: "business" }, headers("bob", "test-token"))).body;
  await sql(`UPDATE timesheets SET task_id = ${alice.task_id} WHERE id = ${bob.id}`);
  assert.equal((await patch(alice.id, { purpose: "support" }, headers("bob", "test-token"))).status, 403);
  assert.deepEqual(await get(alice.id), alice);
  assert.equal((await patch(alice.id, { purpose: "career" }, headers("admin", "test-token"))).status, 200);
  assert.equal((await request(`/api/timesheets/${bob.id}`, { headers: headers("admin", "test-token") })).body.purpose, "business");
  assert.deepEqual((await request("/api/timesheets?purpose=business&user=bob", { headers: auth })).body, []);
});

test("legacy null task IDs are isolated and resumed into their original logical task", async () => {
  const a = (await create()).body;
  const b = (await create()).body;
  await sql(`UPDATE timesheets SET task_id = NULL WHERE id IN (${a.id}, ${b.id})`);
  assert.equal((await patch(a.id, { purpose: "support" })).status, 200);
  assert.equal((await get(b.id)).purpose, null);
  assert.equal((await request("/api/timesheets", { method: "POST", headers: auth, body: { resume_of: a.id } })).status, 409);
  await patch(a.id, { end_reason: "paused" });
  const resumed = (await request("/api/timesheets", { method: "POST", headers: auth, body: { resume_of: a.id } })).body;
  assert.equal(resumed.task_id, a.id);
  assert.equal(resumed.purpose, "support");
  await patch(a.id, { purpose: "research" });
  assert.equal((await get(resumed.id)).purpose, "research");
  assert.equal((await get(b.id)).purpose, null);
});

test("combined corrections validate before writing and commit with explicit lifecycle edits", async () => {
  const entry = (await create({ purpose: "research" })).body;
  for (const body of [
    { purpose: "Research", description: "bad", end_reason: "paused" },
    { purpose: "career", description: "bad", tokens_by_agent: { alice: { input: 9 }, missing: { input: 1 } } },
    { purpose: "support", end: "2020-01-01T00:00:00Z" },
  ]) {
    assert.equal((await patch(entry.id, body)).status, 400);
    assert.deepEqual(await get(entry.id), entry);
  }
  const corrected = await patch(entry.id, { purpose: "business", description: "corrected", end_reason: "paused", tokens: { input: 4 } });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.purpose, "business");
  assert.equal(corrected.body.description, "corrected");
  assert.equal(corrected.body.end_reason, "paused");
  assert.equal(corrected.body.tokens_input, 4);
  assert.ok(corrected.body.end);
});

test("invalid purpose creation does not sweep existing stale entries", async () => {
  const stale = (await create({ begin: "2020-01-01T00:00:00Z" })).body;
  assert.equal((await create({ purpose: "Research" })).status, 400);
  assert.equal((await request("/api/timesheets", { method: "POST", headers: auth, body: { resume_of: stale.id, purpose: null } })).status, 400);
  assert.deepEqual(await get(stale.id), stale);
});
