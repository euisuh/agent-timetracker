import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { headers, request, reset, start, stop } from "./harness.mjs";

const auth = headers("alice", "test-token");
const format = "codex_response_exclusive_v1";
const counters = { input: 11, output: 7, reasoning: 3, cache_read: 5, cache_write: 0 };
const versioned = { ...counters, counter_format: format };
const create = async () => (await request("/api/timesheets", { method: "POST", headers: auth, body: { project: "etc", activity: 1, description: "task" } })).body;
const patch = (id, body, user = auth) => request(`/api/timesheets/${id}`, { method: "PATCH", headers: user, body });
const get = async id => (await request(`/api/timesheets/${id}`, { headers: auth })).body;

before(start);
beforeEach(reset);
after(stop);

test("token format capability is authenticated and preserves the default capability response", async () => {
  assert.equal((await request("/api/capabilities?feature=token_format")).status, 401);
  assert.deepEqual((await request("/api/capabilities?feature=token_format", { headers: auth })).body, { token_format: [format] });
  assert.deepEqual((await request("/api/capabilities", { headers: auth })).body, { purpose_review: { version: 1, closed_only: true } });
  assert.equal((await request("/api/capabilities?feature=unknown", { headers: auth })).status, 400);
});

test("complete versioned rows replace counters and marker without changing legacy rows or aggregate shape", async () => {
  const entry = await create();
  await patch(entry.id, { tokens_by_agent: { alice: { input: 90, cache_write: 99 }, bob: { output: 13 } } });
  const updated = await patch(entry.id, { tokens_by_agent: { alice: versioned } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.tokens_by_agent, [
    { user_id: 2, ...versioned },
    { user_id: 3, input: 0, output: 13, reasoning: 0, cache_read: 0, cache_write: 0 },
  ]);
  assert.equal(updated.body.tokens_output, 20);
  assert.equal(updated.body.tokens_cache_write, 0);
  assert.ok(!("counter_format" in updated.body));
  assert.deepEqual((await patch(entry.id, { tokens_by_agent: { alice: versioned } })).body, updated.body);
  assert.deepEqual((await request("/api/timesheets", { headers: auth })).body, [updated.body]);
  const zero = Object.fromEntries(Object.keys(counters).map(key => [key, 0]));
  const replaced = await patch(entry.id, { tokens_by_agent: { alice: { ...zero, counter_format: format } } });
  assert.deepEqual(replaced.body.tokens_by_agent[0], { user_id: 2, ...zero, counter_format: format });
});

test("malformed versioned rows reject the entire payload before lifecycle, metadata, purpose or tokens change", async () => {
  const entry = await create();
  const invalid = [null, [], true, 12, "wrong",
    ...[null, "", "future_v2", 1, true, {}, []].map(counter_format => ({ ...counters, counter_format })),
    ...Object.keys(counters).map(key => Object.fromEntries(Object.entries(versioned).filter(([name]) => name !== key))),
    ...Object.keys(counters).flatMap(key => [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, false, {}, []].map(value => ({ ...versioned, [key]: value }))),
  ];
  for (const value of invalid) {
    const rejected = await patch(entry.id, { description: "wrong", purpose: "business", end_reason: "done", tokens_by_agent: { bob: versioned, alice: value } });
    assert.equal(rejected.status, 400, JSON.stringify(value));
    assert.deepEqual(await get(entry.id), entry);
  }
  assert.equal((await patch(entry.id, { tokens_by_agent: { alice: versioned, missing: versioned } })).status, 400);
  assert.deepEqual(await get(entry.id), entry);
});

test("unversioned partial, empty and unknown-only row writes clear only that row's marker", async () => {
  const entry = await create();
  for (const values of [{ input: 99 }, {}, { ignored: 99 }]) {
    await patch(entry.id, { tokens_by_agent: { alice: versioned, bob: versioned } });
    const changed = await patch(entry.id, { tokens_by_agent: { alice: values } });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.tokens_by_agent[0], { user_id: 2, ...counters, ...(values.input === undefined ? {} : { input: 99 }) });
    assert.deepEqual(changed.body.tokens_by_agent[1], { user_id: 3, ...versioned });
    for (const key of Object.keys(counters)) assert.equal(changed.body[`tokens_${key}`], changed.body.tokens_by_agent.reduce((sum, row) => sum + row[key], 0));
  }
});

test("flat override removes versioned attribution while empty flat maps retain it", async () => {
  const entry = await create();
  const stored = (await patch(entry.id, { tokens_by_agent: { alice: versioned } })).body;
  for (const tokens of [{}, { ignored: 1 }, { counter_format: format }]) {
    assert.deepEqual((await patch(entry.id, { tokens })).body, stored);
  }
  const changed = await patch(entry.id, { tokens: { input: 99, counter_format: format } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.tokens_by_agent, []);
  assert.equal(changed.body.tokens_input, 99);
  assert.equal(changed.body.tokens_output, counters.output);
  assert.ok(!("counter_format" in changed.body));
});

test("nonowners cannot replace or clear a versioned row", async () => {
  const entry = await create();
  const stored = (await patch(entry.id, { tokens_by_agent: { alice: versioned } })).body;
  for (const body of [{ tokens_by_agent: { alice: versioned } }, { tokens_by_agent: { alice: {} } }, { tokens: { input: 99 } }]) {
    assert.equal((await patch(entry.id, body, headers("bob", "test-token"))).status, 403);
    assert.deepEqual(await get(entry.id), stored);
  }
});

test("concurrent versioned replacements and legacy updates keep tuples, markers and totals coherent", async () => {
  const entry = await create();
  const tuples = Array.from({ length: 6 }, (_, index) => Object.fromEntries(Object.keys(counters).map(key => [key, index + 1])));
  const updates = await Promise.all([
    ...tuples.map(values => patch(entry.id, { tokens_by_agent: { alice: { ...values, counter_format: format } } })),
    patch(entry.id, { tokens_by_agent: { bob: { input: 19 } } }),
  ]);
  assert.ok(updates.every(update => update.status === 200));
  const stored = await get(entry.id);
  assert.ok(tuples.some(values => JSON.stringify(stored.tokens_by_agent[0]) === JSON.stringify({ user_id: 2, ...values, counter_format: format })));
  for (const key of Object.keys(counters)) assert.equal(stored[`tokens_${key}`], stored.tokens_by_agent.reduce((sum, row) => sum + row[key], 0));
  const raced = await Promise.all([
    patch(entry.id, { tokens_by_agent: { alice: versioned } }),
    patch(entry.id, { tokens_by_agent: { alice: { input: 77 } } }),
  ]);
  assert.ok(raced.every(update => update.status === 200));
  const final = await get(entry.id);
  assert.deepEqual(final.tokens_by_agent[0], final.tokens_by_agent[0].counter_format === format
    ? { user_id: 2, ...versioned } : { user_id: 2, ...counters, input: 77 });
  for (const key of Object.keys(counters)) assert.equal(final[`tokens_${key}`], final.tokens_by_agent.reduce((sum, row) => sum + row[key], 0));
});
