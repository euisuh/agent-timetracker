import { timingSafeEqual } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "./index.js";

// Workers exposes this comparison on SubtleCrypto; Node exposes it separately.
crypto.subtle.timingSafeEqual = timingSafeEqual;

function database(interleave) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter(file => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  sqlite.exec(`INSERT INTO users (id, username, role, active, token_hash) VALUES (2, 'alice', 'user', 1, '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e');
    INSERT INTO timesheets (id, user_id, project_id, activity_id, task_id, description, purpose, begin, end, end_reason)
    VALUES (42, 2, 1, 1, 42, 'research task', 'research', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 'paused');`);
  return {
    sqlite,
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);
          return {
            async first() {
              if (sql.startsWith("SELECT archived FROM projects")) interleave(sqlite);
              return statement.get(...values) ?? null;
            },
            async all() { return { results: statement.all(...values) }; },
            run() {
              const result = statement.run(...values);
              return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
            },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(statement => statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function setup() {
  const db = database(() => {});
  db.sqlite.exec(`UPDATE timesheets SET purpose = NULL, repo = 'research', tokens_input = 17 WHERE id = 42;
    INSERT INTO timesheet_tokens (timesheet_id, user_id, input) VALUES (42, 2, 17);
    INSERT INTO timesheets (id, user_id, project_id, activity_id, task_id, description, repo, begin)
    VALUES (43, 2, 1, 1, 42, 'resumed research', 'research', '2026-01-02T00:00:00Z');`);
  return db;
}

const call = (DB, method, path = "/api/timesheets", body, username = "alice") => worker.fetch(new Request(`https://time-api.example.com${path}`, {
  method, headers: { "X-AUTH-USER": username, "X-AUTH-TOKEN": "test-token", "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), { DB });
const entries = async db => (await call(db, "GET")).json();
const review = async db => ({ segments: (await entries(db)).map(({ id, project_id, repo, description, begin }) => ({ id, project_id, repo, description, begin })) });
const apply = (db, purpose_review, purpose = "research", extra = {}) => call(db, "PATCH", "/api/timesheets/42", { purpose, purpose_review, ...extra });

function atCommit(db, operation) {
  const batch = db.batch.bind(db);
  db.batch = async statements => { operation(db.sqlite); return batch(statements); };
}

test("reviewed application changes only purpose across every task segment", async () => {
  const db = setup();
  try {
    const before = await entries(db);
    assert.equal((await apply(db, await review(db))).status, 200);
    assert.deepEqual(await entries(db), before.map(entry => ({ ...entry, purpose: "research" })));
    assert.equal((await apply(db, await review(db), "business")).status, 409);
    assert.equal((await call(db, "PATCH", "/api/timesheets/42", { purpose: "business" })).status, 200);
    assert.ok((await entries(db)).every(entry => entry.purpose === "business"));
  } finally { db.sqlite.close(); }
});

test("review payload validation rejects unsafe combinations without any writes", async () => {
  const db = setup();
  try {
    const before = await entries(db);
    const snapshot = await review(db);
    const first = snapshot.segments[0];
    for (const body of [
      { purpose_review: snapshot }, { purpose: null, purpose_review: snapshot },
      ...["end", "end_reason", "description", "tokens", "tokens_by_agent", "project", "repo", "extra"].map(key => ({ purpose: "research", purpose_review: snapshot, [key]: null })),
      ...[null, {}, { segments: [] }, { segments: snapshot.segments, extra: true }, { segments: Array(201).fill(first) },
        { segments: [first, first] }, { segments: [snapshot.segments[1]] }, { segments: [{ ...first, id: true }] },
        { segments: [{ ...first, begin: "invalid" }] }, { segments: [{ ...first, repo: 1 }] },
        { segments: [{ ...first, description: null }] }, { segments: [{ ...first, project_id: 0 }] },
        { segments: [{ ...first, extra: true }] }].map(purpose_review => ({ purpose: "research", purpose_review })),
    ]) {
      assert.equal((await call(db, "PATCH", "/api/timesheets/42", body)).status, 400, JSON.stringify(body));
      assert.deepEqual(await entries(db), before);
    }
    const malformed = new Request("https://time-api.example.com/api/timesheets/42", {
      method: "PATCH", headers: { "X-AUTH-USER": "alice", "X-AUTH-TOKEN": "test-token", "content-type": "application/json" }, body: "{",
    });
    assert.equal((await worker.fetch(malformed, { DB: db })).status, 400);
    assert.deepEqual(await entries(db), before);
  } finally { db.sqlite.close(); }
});

const changes = [
  "UPDATE timesheets SET begin = '2026-01-03T00:00:00Z' WHERE id = 42",
  "UPDATE timesheets SET description = 'changed primary evidence' WHERE id = 42",
  "UPDATE timesheets SET purpose = 'career' WHERE id = 43",
  "UPDATE timesheets SET description = 'changed evidence' WHERE id = 43",
  "UPDATE timesheets SET repo = 'different' WHERE id = 43",
  "UPDATE timesheets SET project_id = 2 WHERE id = 43",
  "UPDATE timesheets SET begin = '2026-01-03T00:00:00Z' WHERE id = 43",
  "DELETE FROM timesheets WHERE id = 43",
  "INSERT INTO timesheets (id,user_id,project_id,activity_id,task_id,description,begin) VALUES(44,2,1,1,42,'new resumed segment','2026-01-03T00:00:00Z')",
];

test("stale reviewed evidence or membership is rejected before application", async () => {
  for (const change of changes) {
    const db = setup();
    try {
      const snapshot = await review(db);
      db.sqlite.exec(change);
      const before = await entries(db);
      assert.equal((await apply(db, snapshot)).status, 409, change);
      assert.deepEqual(await entries(db), before);
    } finally { db.sqlite.close(); }
  }
});

test("the atomic review guard rejects changes after snapshot validation", async () => {
  for (const change of changes) {
    const db = setup();
    try {
      const snapshot = await review(db);
      atCommit(db, sqlite => sqlite.exec(change));
      assert.equal((await apply(db, snapshot)).status, 409, change);
      assert.equal(db.sqlite.prepare("SELECT purpose FROM timesheets WHERE id = 42").get().purpose, null);
      assert.equal(db.sqlite.prepare("SELECT tokens_input FROM timesheets WHERE id = 42").get().tokens_input, 17);
    } finally { db.sqlite.close(); }
  }
});

test("raw legacy begin precision survives reviewed application", async () => {
  const db = setup();
  try {
    db.sqlite.exec("UPDATE timesheets SET begin = '2026-01-01 00:00:00.123456' WHERE id = 42");
    const snapshot = await review(db);
    assert.equal(snapshot.segments[0].begin, "2026-01-01T00:00:00.123Z");
    assert.equal((await apply(db, snapshot)).status, 200);
    assert.equal(db.sqlite.prepare("SELECT begin FROM timesheets WHERE id = 42").get().begin, "2026-01-01 00:00:00.123456");
    assert.ok(!("stored_begin" in (await entries(db))[0]));
  } finally { db.sqlite.close(); }
});

test("review application preserves owner authorization and unrelated batch failures", async () => {
  const db = setup();
  try {
    db.sqlite.exec("INSERT INTO users (id,username,role,active,token_hash) VALUES(3,'bob','user',1,'4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e')");
    const snapshot = await review(db);
    const before = await entries(db);
    assert.equal((await call(db, "PATCH", "/api/timesheets/42", { purpose: "research", purpose_review: snapshot }, "bob")).status, 403);
    assert.deepEqual(await entries(db), before);
    const batch = db.batch.bind(db);
    db.batch = statements => batch([...statements, db.prepare("SELECT json(?)").bind("invalid")]);
    const originalError = console.error;
    console.error = () => {};
    try { assert.equal((await apply(db, snapshot)).status, 500); }
    finally { console.error = originalError; }
    assert.deepEqual(await entries(db), before);
  } finally { db.sqlite.close(); }
});

test("actual resumes invalidate an older review and inherit a later accepted purpose", async () => {
  const db = setup();
  try {
    const oldReview = await review(db);
    await call(db, "PATCH", "/api/timesheets/43", { end_reason: "paused" });
    const resumed = await call(db, "POST", "/api/timesheets", { resume_of: 42 });
    assert.equal(resumed.status, 200);
    const segment = await resumed.json();
    assert.equal(segment.purpose, null);
    assert.equal((await apply(db, oldReview)).status, 409);
    assert.equal((await apply(db, await review(db))).status, 200);
    await call(db, "PATCH", `/api/timesheets/${segment.id}`, { end_reason: "paused" });
    const next = await call(db, "POST", "/api/timesheets", { resume_of: segment.id });
    assert.equal(next.status, 200);
    assert.equal((await next.json()).purpose, "research");
  } finally { db.sqlite.close(); }
});

test("reviewed application uses the legacy null task fallback", async () => {
  const db = setup();
  try {
    db.sqlite.exec("UPDATE timesheets SET task_id = NULL WHERE id = 42");
    assert.equal((await apply(db, await review(db))).status, 200);
    assert.ok((await entries(db)).every(entry => entry.purpose === "research"));
  } finally { db.sqlite.close(); }
});
