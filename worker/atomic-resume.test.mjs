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

const resume = (DB, username = "alice") => worker.fetch(new Request("https://time-api.example.com/api/timesheets", {
  method: "POST", headers: { "X-AUTH-USER": username, "X-AUTH-TOKEN": "test-token", "content-type": "application/json" },
  body: JSON.stringify({ resume_of: 42 }),
}), { DB });

function attribution(db) {
  db.sqlite.exec("UPDATE timesheets SET tokens_input = 17 WHERE id = 42; INSERT INTO timesheet_tokens(timesheet_id,user_id,input) VALUES(42,2,17)");
}

test("interleaved resumes commit one running segment and return conflict for the loser", async () => {
  const db = database(() => {});
  attribution(db);
  const source = db.sqlite.prepare("SELECT * FROM timesheets WHERE id = 42").get();
  const batch = db.batch.bind(db);
  let arrived = 0, release;
  const bothReady = new Promise(resolve => { release = resolve; });
  db.batch = async statements => {
    arrived += 1;
    if (arrived === 2) release();
    await bothReady;
    return batch(statements);
  };
  try {
    const responses = await Promise.all([resume(db), resume(db)]);
    assert.equal(arrived, 2);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winning = await responses.find(response => response.status === 200).json();
    assert.equal(winning.purpose, "research");
    assert.equal(winning.task_id, 42);
    assert.equal(winning.user_id, 2);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets WHERE user_id=2 AND COALESCE(task_id,id)=42 AND end IS NULL").get().total, 1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets").get().total, 2);
    assert.deepEqual(db.sqlite.prepare("SELECT * FROM timesheets WHERE id = 42").get(), source);
    assert.deepEqual(db.sqlite.prepare("SELECT user_id,input FROM timesheet_tokens WHERE timesheet_id=42").all().map(row => [row.user_id,row.input]), [[2,17]]);
  } finally { db.sqlite.close(); }
});

test("an unrelated owner with the same task key does not prevent resume", async () => {
  const db = database(() => {});
  try {
    db.sqlite.exec(`INSERT INTO users(id,username,role,active,token_hash) VALUES(3,'bob','user',1,'unused');
      INSERT INTO timesheets(id,user_id,project_id,activity_id,task_id,description,begin) VALUES(43,3,1,1,42,'unrelated owner','2099-01-01T00:00:00Z');`);
    assert.equal((await resume(db)).status, 200);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets WHERE user_id=3 AND end IS NULL").get().total, 1);
  } finally { db.sqlite.close(); }
});

test("admin resumes remain caller-owned and cannot duplicate the caller's running task", async () => {
  const db = database(() => {});
  try {
    db.sqlite.exec("INSERT INTO users(id,username,role,active,token_hash) VALUES(1,'admin','admin',1,'4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e')");
    const response = await resume(db, "admin");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user_id, 1);
    assert.equal((await resume(db, "admin")).status, 409);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets WHERE user_id=1 AND COALESCE(task_id,id)=42 AND end IS NULL").get().total, 1);
  } finally { db.sqlite.close(); }
});

test("a source reopened after the precheck blocks insertion atomically", async () => {
  const db = database(() => {});
  const batch = db.batch.bind(db);
  db.batch = async statements => { db.sqlite.exec("UPDATE timesheets SET end=NULL,end_reason=NULL WHERE id=42"); return batch(statements); };
  try {
    assert.equal((await resume(db)).status, 409);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets").get().total, 1);
  } finally { db.sqlite.close(); }
});

test("legacy null task IDs use the same atomic running-entry guard", async () => {
  const db = database(() => {});
  try {
    db.sqlite.exec("UPDATE timesheets SET task_id=NULL WHERE id=42");
    const response = await resume(db);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).task_id, 42);
    assert.equal((await resume(db)).status, 409);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets").get().total, 2);
  } finally { db.sqlite.close(); }
});

test("a source deleted immediately before insertion retains not-found semantics", async () => {
  const db = database(() => {});
  const batch = db.batch.bind(db);
  db.batch = async statements => { db.sqlite.exec("DELETE FROM timesheets WHERE id=42"); return batch(statements); };
  try {
    assert.equal((await resume(db)).status, 404);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS total FROM timesheets").get().total, 0);
  } finally { db.sqlite.close(); }
});
