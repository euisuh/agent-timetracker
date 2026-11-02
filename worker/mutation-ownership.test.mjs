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

const mutation = (db, method, body, interleave) => {
  const request = new Request("https://time-api.example.com/api/timesheets/42", {
    method, headers: { "X-AUTH-USER": "alice", "X-AUTH-TOKEN": "test-token", "content-type": "application/json" },
    ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }),
  });
  if (interleave) request.json = async () => { interleave(db.sqlite); return body; };
  return worker.fetch(request, { DB: db });
};

function replaceOwner(sqlite) {
  sqlite.exec(`DELETE FROM timesheet_tokens WHERE timesheet_id = 42; DELETE FROM timesheets WHERE id = 42;
    INSERT INTO users (id, username, role, active, token_hash) VALUES (3, 'bob', 'user', 1, 'unused');
    INSERT INTO timesheets (id, user_id, project_id, activity_id, task_id, description, begin, tokens_input)
    VALUES (42, 3, 1, 1, 42, 'private task', '2026-01-02T00:00:00Z', 17);
    INSERT INTO timesheet_tokens (timesheet_id, user_id, input) VALUES (42, 3, 17);`);
}

function assertReplacementIntact(sqlite) {
  assert.equal(sqlite.prepare("SELECT description FROM timesheets WHERE id = 42").get().description, "private task");
  assert.equal(sqlite.prepare("SELECT tokens_input FROM timesheets WHERE id = 42").get().tokens_input, 17);
  assert.deepEqual(sqlite.prepare("SELECT user_id, input FROM timesheet_tokens WHERE timesheet_id = 42").all().map(row => [row.user_id, row.input]), [[3, 17]]);
}

test("PATCH cannot mutate a source ID reused by another owner", async () => {
  for (const body of [{ description: "wrong" }, { tokens: { input: 99 } }, { tokens_by_agent: { alice: { input: 99 } } }, { purpose: "business" }]) {
    const db = database(() => {});
    try {
      assert.equal((await mutation(db, "PATCH", body, replaceOwner)).status, 409);
      assertReplacementIntact(db.sqlite);
    } finally { db.sqlite.close(); }
  }
});

test("DELETE cannot remove a replaced source or its token rows", async () => {
  const db = database(() => {});
  const batch = db.batch.bind(db);
  db.batch = async statements => { replaceOwner(db.sqlite); return batch(statements); };
  try {
    assert.equal((await mutation(db, "DELETE")).status, 409);
    assertReplacementIntact(db.sqlite);
  } finally { db.sqlite.close(); }
});

test("PATCH and DELETE accept legacy raw begin timestamps without exposing them", async () => {
  const db = database(() => {});
  try {
    db.sqlite.exec("UPDATE timesheets SET begin = '2026-01-01 00:00:00.123456' WHERE id = 42");
    const result = await mutation(db, "PATCH", { description: "corrected" });
    assert.equal(result.status, 200);
    const entry = await result.json();
    assert.equal(entry.description, "corrected");
    assert.ok(!("stored_begin" in entry));
    assert.equal((await mutation(db, "DELETE")).status, 204);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets").get().total, 0);
  } finally { db.sqlite.close(); }
});

test("an unrelated batch failure remains a server error and rolls back mutations", async () => {
  const db = database(() => {});
  const batch = db.batch.bind(db);
  db.batch = statements => batch([...statements, db.prepare("SELECT json(?)").bind("invalid")]);
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await mutation(db, "PATCH", { description: "wrong" })).status, 500);
    assert.equal(db.sqlite.prepare("SELECT description FROM timesheets WHERE id = 42").get().description, "research task");
  } finally { console.error = originalError; db.sqlite.close(); }
});

function recent(db) {
  const begin = new Date(Date.now() - 60000).toISOString();
  db.sqlite.prepare("UPDATE timesheets SET begin = ?, end = ? WHERE id = 42").run(begin, begin);
  return begin;
}

function running(sqlite, owner, begin) {
  sqlite.prepare("INSERT INTO timesheets (id, user_id, project_id, activity_id, task_id, description, begin) VALUES (43, ?, 1, 1, 42, 'running', ?)").run(owner, begin);
}

test("reopen distinguishes owners and legacy null task IDs", async () => {
  const db = database(() => {});
  try {
    const begin = recent(db);
    db.sqlite.exec("INSERT INTO users (id, username, role, active, token_hash) VALUES (3, 'bob', 'user', 1, 'unused')");
    running(db.sqlite, 3, begin);
    assert.equal((await mutation(db, "PATCH", { end: null })).status, 200);
    db.sqlite.prepare("UPDATE timesheets SET end = ?, task_id = NULL WHERE id = 42").run(begin);
    db.sqlite.exec("UPDATE timesheets SET user_id = 2 WHERE id = 43");
    assert.equal((await mutation(db, "PATCH", { end: null })).status, 409);
    assert.equal(db.sqlite.prepare("SELECT end FROM timesheets WHERE id = 42").get().end, begin);
  } finally { db.sqlite.close(); }
});

test("reopen rechecks competing running segments inside its atomic batch", async () => {
  const db = database(() => {});
  const begin = recent(db);
  const batch = db.batch.bind(db);
  db.batch = async statements => { running(db.sqlite, 2, begin); return batch(statements); };
  try {
    assert.equal((await mutation(db, "PATCH", { end: null, description: "wrong" })).status, 409);
    const entry = db.sqlite.prepare("SELECT end, description FROM timesheets WHERE id = 42").get();
    assert.equal(entry.end, begin);
    assert.equal(entry.description, "research task");
  } finally { db.sqlite.close(); }
});

test("PATCH rejects source deletion or same-owner identity replacement", async () => {
  for (const replacement of [
    "DELETE FROM timesheets WHERE id = 42",
    "UPDATE timesheets SET begin = '2026-01-02T00:00:00Z' WHERE id = 42",
    "UPDATE timesheets SET task_id = 99 WHERE id = 42",
  ]) {
    const db = database(() => {});
    try {
      assert.equal((await mutation(db, "PATCH", { description: "wrong" }, sqlite => sqlite.exec(replacement))).status, 409);
      const row = db.sqlite.prepare("SELECT description FROM timesheets WHERE id = 42").get();
      if (row) assert.equal(row.description, "research task");
    } finally { db.sqlite.close(); }
  }
});
