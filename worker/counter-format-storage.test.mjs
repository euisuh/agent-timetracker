import { timingSafeEqual } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "./index.js";

crypto.subtle.timingSafeEqual = timingSafeEqual;
const format = "codex_response_exclusive_v1";
const migration = "0007_counter_format.sql";
const counters = { input: 11, output: 7, reasoning: 3, cache_read: 5, cache_write: 0 };

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter(file => file.endsWith(".sql") && file !== migration).sort()) sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  sqlite.exec(`INSERT INTO users (id, username, role, active, token_hash) VALUES (2, 'alice', 'user', 1, '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e');
    INSERT INTO timesheets (id, user_id, project_id, activity_id, task_id, description, purpose, begin, end, end_reason, tokens_input)
    VALUES (42, 2, 1, 1, 42, 'task', 'research', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 'paused', 17);
    INSERT INTO timesheet_tokens (timesheet_id, user_id, input) VALUES (42, 2, 17);`);
  return {
    sqlite,
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);
          return {
            async first() { return statement.get(...values) ?? null; },
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

const applyMigration = db => db.sqlite.exec(readFileSync(`migrations/${migration}`, "utf8"));
const snapshot = db => [db.sqlite.prepare("SELECT * FROM timesheets").all(), db.sqlite.prepare("SELECT * FROM timesheet_tokens").all()];
const request = (db, body) => worker.fetch(new Request("https://time-api.example.com/api/timesheets/42", {
  method: body ? "PATCH" : "GET",
  headers: { "X-AUTH-USER": "alice", "X-AUTH-TOKEN": "test-token", "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
}), { DB: db });

test("counter format migration preserves history and allows only null or the supported enum", () => {
  const db = database();
  try {
    const [entries, tokens] = snapshot(db);
    applyMigration(db);
    assert.deepEqual(snapshot(db)[0], entries);
    assert.deepEqual(snapshot(db)[1], tokens.map(row => Object.assign(Object.create(null), row, { counter_format: null })));
    assert.equal(db.sqlite.prepare("PRAGMA table_info(timesheet_tokens)").all().find(row => row.name === "counter_format").notnull, 0);
    for (const value of ["future_v2", "", 1]) assert.throws(() => db.sqlite.prepare("UPDATE timesheet_tokens SET counter_format = ?").run(value), /CHECK constraint failed/);
    db.sqlite.prepare("UPDATE timesheet_tokens SET counter_format = ?").run(format);
    db.sqlite.exec("UPDATE timesheet_tokens SET counter_format = NULL");
  } finally { db.sqlite.close(); }
});

test("null format preserves the exact legacy response bytes", async () => {
  const db = database();
  try {
    applyMigration(db);
    const legacy = { id: 42, user_id: 2, project_id: 1, activity_id: 1, task_id: 42, repo: null, purpose: "research", description: "task", begin: "2026-01-01T00:00:00.000Z", end: "2026-01-01T01:00:00.000Z", end_reason: "paused", auto_closed: false, tokens_input: 17, tokens_output: null, tokens_reasoning: null, tokens_cache_read: null, tokens_cache_write: null, tokens_by_agent: [{ user_id: 2, input: 17, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }] };
    assert.equal(await (await request(db)).text(), JSON.stringify(legacy));
  } finally { db.sqlite.close(); }
});

test("versioned counters retain the nonnegative safe-integer boundaries", async () => {
  const db = database();
  try {
    applyMigration(db);
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      const values = Object.fromEntries(Object.keys(counters).map(key => [key, value]));
      const result = await request(db, { tokens_by_agent: { alice: { ...values, counter_format: format } } });
      assert.equal(result.status, 200);
      const entry = await result.json();
      assert.deepEqual(entry.tokens_by_agent, [{ user_id: 2, ...values, counter_format: format }]);
      for (const key of Object.keys(counters)) assert.equal(entry[`tokens_${key}`], value);
    }
  } finally { db.sqlite.close(); }
});

test("batch failure rolls back versioned replacement, marker clearing and flat override together", async () => {
  const db = database();
  const originalError = console.error;
  console.error = () => {};
  try {
    applyMigration(db);
    assert.equal((await request(db, { tokens_by_agent: { alice: { ...counters, counter_format: format } } })).status, 200);
    const stored = snapshot(db);
    const batch = db.batch.bind(db);
    db.batch = statements => batch([...statements, db.prepare("SELECT json(?)").bind("invalid")]);
    for (const body of [
      { tokens_by_agent: { alice: { ...counters, input: 99, counter_format: format } } },
      { tokens_by_agent: { alice: { input: 99 } } },
      { tokens_by_agent: { alice: {} } },
      { tokens: { input: 99 } },
    ]) {
      assert.equal((await request(db, { description: "wrong", purpose: "business", ...body })).status, 500);
      assert.deepEqual(snapshot(db), stored);
    }
  } finally { console.error = originalError; db.sqlite.close(); }
});

test("versioned write rechecks ownership before committing counters and marker", async () => {
  const db = database();
  try {
    applyMigration(db);
    db.sqlite.exec("INSERT INTO users (id, username, role, active, token_hash) VALUES (3, 'bob', 'user', 1, 'unused')");
    const batch = db.batch.bind(db);
    db.batch = statements => {
      db.sqlite.exec("UPDATE timesheets SET user_id = 3 WHERE id = 42");
      return batch(statements);
    };
    const tokens = snapshot(db)[1];
    assert.equal((await request(db, { tokens_by_agent: { alice: { ...counters, counter_format: format } } })).status, 409);
    assert.deepEqual(snapshot(db)[1], tokens);
    assert.equal(snapshot(db)[0][0].tokens_input, 17);
  } finally { db.sqlite.close(); }
});
