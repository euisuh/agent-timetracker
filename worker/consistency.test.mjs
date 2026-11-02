import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { headers, request, reset, start, stop } from "./harness.mjs";

const auth = headers("alice", "test-token");
const create = async (body = {}) => (await request("/api/timesheets", { method: "POST", headers: auth, body: { project: "etc", activity: 1, description: "task", ...body } })).body;
const patch = (id, body) => request(`/api/timesheets/${id}`, { method: "PATCH", headers: auth, body });

before(start);
beforeEach(reset);
after(stop);

test("flat token overrides clear old attribution and preserve unspecified fields", async () => {
  const entry = await create();
  await patch(entry.id, { tokens_by_agent: { alice: { input: 10, output: 4 }, bob: { input: 20, cache_read: 8 } } });
  const updated = await patch(entry.id, { tokens: { input: 7 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.tokens_input, 7);
  assert.equal(updated.body.tokens_output, 4);
  assert.equal(updated.body.tokens_cache_read, 8);
  assert.deepEqual(updated.body.tokens_by_agent, []);
  const repeated = await patch(entry.id, { tokens: { input: 7 } });
  assert.deepEqual(repeated.body, updated.body);
});

test("empty flat maps preserve attribution and nonowners cannot override", async () => {
  const entry = await create();
  const attributed = (await patch(entry.id, { tokens_by_agent: { alice: { input: 5 } } })).body;
  for (const tokens of [{}, { unrecognized: 3 }]) {
    assert.deepEqual((await patch(entry.id, { tokens })).body, attributed);
  }
  const denied = await request(`/api/timesheets/${entry.id}`, { method: "PATCH", headers: headers("bob", "test-token"), body: { tokens: { input: 1 } } });
  assert.equal(denied.status, 403);
  assert.deepEqual((await request(`/api/timesheets/${entry.id}`, { headers: auth })).body, attributed);
});

test("ambiguous token payload is rejected without metadata or token mutation", async () => {
  const entry = await create();
  const rejected = await patch(entry.id, { description: "wrong", tokens: { input: 5 }, tokens_by_agent: { bob: { input: 6 } } });
  assert.equal(rejected.status, 400);
  const stored = await request(`/api/timesheets/${entry.id}`, { headers: auth });
  assert.deepEqual(stored.body, entry);
});

test("concurrent partial breakdown updates retain fields and coherent totals", async () => {
  const entry = await create();
  await patch(entry.id, { tokens_by_agent: { alice: { output: 3 } } });
  const updates = await Promise.all([
    patch(entry.id, { tokens_by_agent: { alice: { input: 11 } } }),
    patch(entry.id, { tokens_by_agent: { bob: { input: 13, reasoning: 2 } } }),
  ]);
  assert.deepEqual(updates.map(update => update.status), [200, 200]);
  const stored = (await request(`/api/timesheets/${entry.id}`, { headers: auth })).body;
  assert.equal(stored.tokens_input, 24);
  assert.equal(stored.tokens_output, 3);
  assert.equal(stored.tokens_reasoning, 2);
  for (const key of ["input", "output", "reasoning", "cache_read", "cache_write"]) {
    assert.equal(stored[`tokens_${key}`], stored.tokens_by_agent.reduce((sum, row) => sum + row[key], 0));
  }
  const repeated = await patch(entry.id, { tokens_by_agent: { alice: { input: 11 } } });
  assert.equal(repeated.body.tokens_input, 24);
  assert.equal(repeated.body.tokens_output, 3);
});

test("concurrent creation of one agent breakdown never duplicates or fails", async () => {
  const entry = await create();
  const updates = await Promise.all(Array.from({ length: 8 }, (_, index) => patch(entry.id, { tokens_by_agent: { alice: { input: index + 1 } } })));
  assert.ok(updates.every(update => update.status === 200));
  const stored = (await request(`/api/timesheets/${entry.id}`, { headers: auth })).body;
  assert.equal(stored.tokens_by_agent.length, 1);
  assert.equal(stored.tokens_input, stored.tokens_by_agent[0].input);
  const invalid = await patch(entry.id, { tokens_by_agent: { alice: { input: 99 }, unknown: { input: 1 } } });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await request(`/api/timesheets/${entry.id}`, { headers: auth })).body, stored);
});

test("invalid selector types return 400 for create and patch", async () => {
  const entry = await create();
  for (const value of [null, [], {}, true, false]) {
    for (const field of ["project", "activity"]) {
      const created = await request("/api/timesheets", { method: "POST", headers: auth, body: { project: "etc", activity: 1, description: "invalid", [field]: value } });
      assert.equal(created.status, 400, `${field}: ${JSON.stringify(value)}`);
      assert.equal((await patch(entry.id, { [field]: value })).status, 400);
    }
  }
  assert.deepEqual((await request(`/api/timesheets/${entry.id}`, { headers: auth })).body, entry);
});

test("implicit end before future begin rejects without applying other fields", async () => {
  const entry = await create({ begin: new Date(Date.now() + 86400000).toISOString() });
  for (const body of [{}, { description: "changed", end_reason: "done", tokens: { input: 9 } }, { tokens_by_agent: { alice: { input: 9 } } }]) {
    assert.equal((await patch(entry.id, body)).status, 400);
    assert.deepEqual((await request(`/api/timesheets/${entry.id}`, { headers: auth })).body, entry);
  }
  assert.equal((await patch(entry.id, { description: "future task" })).status, 200);
});

test("unsafe token integers are rejected without applying edits", async () => {
  const entry = await create();
  for (const body of [{ tokens: { input: 1e300 } }, { tokens_by_agent: { alice: { output: Number.MAX_SAFE_INTEGER + 1 } } }]) {
    assert.equal((await patch(entry.id, { description: "wrong", ...body })).status, 400);
    assert.deepEqual((await request(`/api/timesheets/${entry.id}`, { headers: auth })).body, entry);
  }
});
