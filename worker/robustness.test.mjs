import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { emailMatchesOwner, refreshAccessJwks } from "./index.js";
import { headers, request, reset, start, stop } from "./harness.mjs";

before(start);
beforeEach(reset);
after(stop);

test("unknown user is 400", async () => {
  const res = await request("/api/timesheets?user=unknown", { headers: headers("admin", "test-token") });
  assert.equal(res.status, 400);
});

test("project with favorite is 409", async () => {
  const project = await request("/api/projects", { method: "POST", headers: headers("admin", "test-token"), body: { name: "favorite-only" } });
  await request("/api/recommended-tasks", { method: "POST", headers: headers("admin", "test-token"), body: { project: project.body.id, description: "keep" } });
  assert.equal((await request(`/api/projects/${project.body.id}`, { method: "DELETE", headers: headers("admin", "test-token") })).status, 409);
});

test("jwks kid miss refetches after 30 seconds", async () => {
  const first = { keys: [{ kid: "old", kty: "RSA" }] };
  const second = { keys: [{ kid: "new", kty: "RSA" }] };
  let calls = 0;
  const fetcher = async () => ({ json: async () => ++calls === 1 ? first : second });
  const cached = await refreshAccessJwks("test", fetcher, null, 0);
  const refreshed = await refreshAccessJwks("test", fetcher, cached, 30_000, true);
  assert.equal(refreshed.value.keys[0].kid, "new");
  assert.equal(calls, 2);
});

test("a failed jwks refresh keeps the last good keys", async () => {
  const good = { keys: [{ kid: "known", kty: "RSA" }] };
  let fail = false;
  const fetcher = async () => { if (fail) throw new Error("certs endpoint down"); return { json: async () => good }; };
  const cached = await refreshAccessJwks("test", fetcher, null, 0);
  fail = true;
  const refreshed = await refreshAccessJwks("test", fetcher, cached, 60_000, true);
  assert.equal(refreshed.value.keys[0].kid, "known");
  assert.equal(refreshed.fetched, 60_000);
  assert.equal(refreshed.expires, 90_000);
  // with nothing cached, a failure is reported as unavailable
  assert.equal((await refreshAccessJwks("test", fetcher, null, 0)).value, null);
});

test("archived target is rejected", async () => {
  const created = await request("/api/timesheets", {
    method: "POST",
    headers: headers("alice", "test-token"),
    body: { project: "etc", activity: 1, description: "refile" },
  });
  await request("/api/projects/2", { method: "PATCH", headers: headers("admin", "test-token"), body: { archived: true } });
  assert.equal((await request(`/api/timesheets/${created.body.id}`, {
    method: "PATCH",
    headers: headers("alice", "test-token"),
    body: { project: "research" },
  })).status, 400);
});

test("token breakdown preserves zero totals", async () => {
  const created = await request("/api/timesheets", {
    method: "POST",
    headers: headers("alice", "test-token"),
    body: { project: "etc", activity: 1, description: "zero" },
  });
  const updated = await request(`/api/timesheets/${created.body.id}`, {
    method: "PATCH",
    headers: headers("alice", "test-token"),
    body: { tokens_by_agent: { alice: { input: 0 } } },
  });
  assert.equal(updated.body.tokens_input, 0);
});

test("owner email check is case-insensitive and open when unset", () => {
  assert.equal(emailMatchesOwner("Owner@Example.com", "owner@example.com"), true);
  assert.equal(emailMatchesOwner(" owner@example.com ", "OWNER@example.com"), true);
  assert.equal(emailMatchesOwner("other@example.com", "owner@example.com"), false);
  assert.equal(emailMatchesOwner(undefined, "owner@example.com"), false);
  assert.equal(emailMatchesOwner(undefined, undefined), true);
  assert.equal(emailMatchesOwner("anyone@example.com", ""), true);
});
