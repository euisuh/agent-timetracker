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

const resume = DB => worker.fetch(new Request("https://time-api.example.com/api/timesheets", {
  method: "POST", headers: { "X-AUTH-USER": "alice", "X-AUTH-TOKEN": "test-token", "content-type": "application/json" },
  body: JSON.stringify({ resume_of: 42 }),
}), { DB });

test("resume reads corrected purpose at insertion after its source snapshot was read", async () => {
  const db = database(sqlite => sqlite.exec("UPDATE timesheets SET purpose = 'career' WHERE id = 42"));
  try {
    const result = await resume(db);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).purpose, "career");
    assert.deepEqual(db.sqlite.prepare("SELECT purpose FROM timesheets WHERE task_id = 42").all().map(row => row.purpose), ["career", "career"]);
  } finally { db.sqlite.close(); }
});

test("resume returns not found if its source disappears before insertion", async () => {
  const db = database(sqlite => sqlite.exec("DELETE FROM timesheets WHERE id = 42"));
  try {
    assert.equal((await resume(db)).status, 404);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets").get().total, 0);
  } finally { db.sqlite.close(); }
});

test("resume rejects a deleted source ID reused by another owner", async () => {
  const db = database(sqlite => sqlite.exec(`DELETE FROM timesheets WHERE id = 42;
    INSERT INTO users (id, username, role, active, token_hash) VALUES (3, 'bob', 'user', 1, 'unused');
    INSERT INTO timesheets (id, user_id, project_id, activity_id, task_id, description, purpose, begin, end)
    VALUES (42, 3, 1, 1, 42, 'private task', 'business', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z');`));
  try {
    assert.equal((await resume(db)).status, 404);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets WHERE user_id = 2").get().total, 0);
    assert.equal(db.sqlite.prepare("SELECT purpose FROM timesheets WHERE id = 42").get().purpose, "business");
  } finally { db.sqlite.close(); }
});

test("resume rejects a source replaced by a different logical task", async () => {
  const db = database(sqlite => sqlite.exec("UPDATE timesheets SET task_id = 99, purpose = 'business' WHERE id = 42"));
  try {
    assert.equal((await resume(db)).status, 404);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets").get().total, 1);
  } finally { db.sqlite.close(); }
});

test("resume rejects a source ID reused by its owner with a new begin", async () => {
  const db = database(sqlite => sqlite.exec(`DELETE FROM timesheets WHERE id = 42;
    INSERT INTO timesheets (id, user_id, project_id, activity_id, task_id, description, purpose, begin, end)
    VALUES (42, 2, 1, 1, 42, 'replacement task', 'business', '2026-01-02T00:00:00Z', '2026-01-02T01:00:00Z');`));
  try {
    assert.equal((await resume(db)).status, 404);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets").get().total, 1);
  } finally { db.sqlite.close(); }
});

test("resume matches the raw legacy begin and keeps it private", async () => {
  const db = database(sqlite => sqlite.exec("UPDATE timesheets SET purpose = 'career' WHERE id = 42"));
  try {
    db.sqlite.exec("UPDATE timesheets SET begin = '2026-01-01 00:00:00.123456' WHERE id = 42");
    const result = await resume(db);
    assert.equal(result.status, 200);
    const entry = await result.json();
    assert.equal(entry.purpose, "career");
    assert.ok(!("stored_begin" in entry));
    assert.ok(!("raw_begin" in entry));
    const source = await worker.fetch(new Request("https://time-api.example.com/api/timesheets/42", {
      headers: { "X-AUTH-USER": "alice", "X-AUTH-TOKEN": "test-token" },
    }), { DB: db });
    const publicSource = await source.json();
    assert.equal(publicSource.begin, "2026-01-01T00:00:00.123Z");
    assert.ok(!("stored_begin" in publicSource));
    assert.ok(!("raw_begin" in publicSource));
  } finally { db.sqlite.close(); }
});
