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

test("closed-only review rejects an existing running segment without edits", async () => {
  const db = setup();
  try {
    const snapshot = { ...await review(db), closed_only: true };
    const before = await entries(db);
    assert.equal((await apply(db, snapshot)).status, 409);
    assert.deepEqual(await entries(db), before);
    assert.equal((await call(db, "PATCH", "/api/timesheets/42", { purpose: "research" })).status, 200);
    assert.equal((await entries(db)).find(entry => entry.id === 43).end, null);
  } finally { db.sqlite.close(); }
});

test("closed-only review applies to a closed task without changing lifecycle or tokens", async () => {
  const db = setup();
  try {
    db.sqlite.exec("UPDATE timesheets SET end='2026-01-02T01:00:00Z',end_reason='paused' WHERE id=43");
    const before = await entries(db);
    assert.equal((await apply(db, { ...await review(db), closed_only: true })).status, 200);
    assert.deepEqual(await entries(db), before.map(entry => ({ ...entry, purpose: "research" })));
  } finally { db.sqlite.close(); }
});

test("closed-only review detects reopening at commit and leaves the competing edit intact", async () => {
  const db = setup();
  try {
    db.sqlite.exec("UPDATE timesheets SET end='2026-01-02T01:00:00Z',end_reason='paused' WHERE id=43");
    const snapshot = { ...await review(db), closed_only: true };
    const source = db.sqlite.prepare("SELECT * FROM timesheets WHERE id=42").get();
    atCommit(db, sqlite => sqlite.exec("UPDATE timesheets SET end=NULL,end_reason=NULL WHERE id=43"));
    assert.equal((await apply(db, snapshot)).status, 409);
    assert.deepEqual(db.sqlite.prepare("SELECT * FROM timesheets WHERE id=42").get(), source);
    const reopened = db.sqlite.prepare("SELECT end,end_reason,purpose FROM timesheets WHERE id=43").get();
    assert.equal(reopened.end, null);
    assert.equal(reopened.end_reason, null);
    assert.equal(reopened.purpose, null);
  } finally { db.sqlite.close(); }
});

test("closed_only accepts only explicit true and omitted mode retains its contract", async () => {
  const db = setup();
  try {
    const snapshot = await review(db);
    const before = await entries(db);
    for (const closed_only of [false, null, 0, 1, "true", {}, []]) {
      assert.equal((await apply(db, { ...snapshot, closed_only })).status, 400);
      assert.deepEqual(await entries(db), before);
    }
    assert.equal((await apply(db, snapshot)).status, 200);
    assert.deepEqual(await entries(db), before.map(entry => ({ ...entry, purpose: "research" })));
  } finally { db.sqlite.close(); }
});

test("closed-only mode also rejects a running requested segment", async () => {
  const db = setup();
  try {
    db.sqlite.exec("UPDATE timesheets SET end='2026-01-02T01:00:00Z',end_reason='paused' WHERE id=43; UPDATE timesheets SET end=NULL,end_reason=NULL WHERE id=42");
    const before = await entries(db);
    assert.equal((await apply(db, { ...await review(db), closed_only: true })).status, 409);
    assert.deepEqual(await entries(db), before);
  } finally { db.sqlite.close(); }
});
