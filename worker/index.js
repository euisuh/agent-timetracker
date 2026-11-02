const TOKEN_KEYS = ["input", "output", "reasoning", "cache_read", "cache_write"];
const COUNTER_FORMAT = "codex_response_exclusive_v1";
const PATCH_FIELDS = new Set(["project", "activity", "description", "repo", "purpose"]);
const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" };
const MAX_TEXT = 1000;
let cachedJwks;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => { throw new HttpError(status, message); };
const response = (value, status = 200) => Response.json(value, { status, headers: JSON_HEADERS });
const empty = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const query = (db, sql, ...values) => db.prepare(sql).bind(...values);
const first = (db, sql, ...values) => query(db, sql, ...values).first();
const all = async (db, sql, ...values) => (await query(db, sql, ...values).all()).results;
const projectResponse = project => ({ ...project, archived: Boolean(project.archived) });
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-object JSON at the request boundary before reading fields.
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate ID-or-name input before testing numeric string syntax.
const isId = value => Number.isInteger(value) || (typeof value === "string" && /^\d+$/.test(value));
const numberId = value => Number(value);

function requireText(payload, field) {
  const value = payload[field];
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject untrusted non-string text before trimming required fields.
  if (typeof value !== "string" || !value.trim()) fail(400, `${field} is required and must not be blank`);
  if (value.trim().length > MAX_TEXT) fail(400, `${field} must be at most ${MAX_TEXT} characters`);
  return value.trim();
}

function projectDescription(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate untrusted JSON before trimming optional project text.
  if (typeof value !== "string") fail(400, "description must be a string");
  if (value.trim().length > MAX_TEXT) fail(400, `description must be at most ${MAX_TEXT} characters`);
  return value.trim();
}

function patchRepo(payload) {
  return payload.repo === null ? null : requireText(payload, "repo");
}

async function body(request) {
  try {
    const value = await request.json();
    if (!isObject(value)) fail(400, "Invalid JSON object");
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(400, "Invalid JSON body");
  }
}

function iso(value, message = "Invalid datetime") {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject untrusted datetime types before parsing string input.
  if (typeof value !== "string") fail(400, message);
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(normalized) ? normalized : `${normalized}Z`;
  const time = Date.parse(withZone);
  if (Number.isNaN(time)) fail(400, message);
  return new Date(time).toISOString();
}

function outputDate(value) {
  return value == null ? null : iso(String(value));
}

async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return bytes;
}

function hex(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));
}

async function tokenMatches(token, expectedHash) {
  const expected = hex(expectedHash);
  return expected !== null && crypto.subtle.timingSafeEqual(await sha256(token), expected);
}

async function issueToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const hash = Array.from(await sha256(token), byte => byte.toString(16).padStart(2, "0")).join("");
  return { token, hash };
}

// DASHBOARD_HOST comes from config; if unset, no request counts as a dashboard request.
function dashboardRequest(request, env) {
  return Boolean(env.DASHBOARD_HOST) && request.headers.get("host")?.split(":")[0] === env.DASHBOARD_HOST;
}

function decodeJwtPart(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding), char => char.charCodeAt(0))));
}

export async function refreshAccessJwks(source, fetcher, cached, now = Date.now(), refresh = false) {
  if (!refresh && cached?.source === source && cached.expires > now) return cached;
  try {
    const value = await (await fetcher(source)).json();
    if (!Array.isArray(value.keys)) throw new Error("Invalid Access JWKS");
    return { source, value, fetched: now, expires: now + 300_000 };
  } catch {
    // Keep the last good keys through a failed refresh; only report "unavailable" when there are none.
    if (cached?.source === source && cached.value) return { ...cached, fetched: now, expires: now + 30_000 };
    return { source, value: null, fetched: now, expires: now + 30_000 };
  }
}

async function accessJwks(env, refresh = false) {
  const source = env.ACCESS_JWKS ? `inline:${env.ACCESS_JWKS}` : `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const fetcher = env.ACCESS_JWKS ? async () => ({ json: async () => JSON.parse(env.ACCESS_JWKS) }) : fetch;
  cachedJwks = await refreshAccessJwks(source, fetcher, cachedJwks, Date.now(), refresh);
  if (!cachedJwks.value) throw new Error("Access JWKS unavailable");
  return cachedJwks;
}

async function verifyAccessJwt(token, env) {
  try {
    const [encodedHeader, encodedPayload, encodedSignature, ...extra] = token.split(".");
    if (extra.length || !encodedHeader || !encodedPayload || !encodedSignature) return null;
    const header = decodeJwtPart(encodedHeader);
    const payload = decodeJwtPart(encodedPayload);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the decoded JWT key identifier before using it to select a signing key.
    if (header.alg !== "RS256" || typeof header.kid !== "string" || payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || !(Number(payload.exp) > Date.now() / 1000) || !(payload.aud === env.ACCESS_AUD || Array.isArray(payload.aud) && payload.aud.includes(env.ACCESS_AUD))) return null;
    let jwks = await accessJwks(env);
    let jwk = jwks.value.keys.find(key => key.kid === header.kid && key.kty === "RSA");
    if (!jwk && Date.now() - jwks.fetched >= 30_000) {
      jwks = await accessJwks(env, true);
      jwk = jwks.value.keys.find(key => key.kid === header.kid && key.kty === "RSA");
    }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(encodedSignature.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - encodedSignature.length % 4) % 4)), char => char.charCodeAt(0));
    if (!await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`))) return null;
    return payload;
  } catch {
    return null;
  }
}

// No OWNER_EMAIL means no restriction beyond the Access policy. Email addresses compare
// case-insensitively: an identity provider may report a different case than the one configured.
export const emailMatchesOwner = (email, owner) =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-string JWT email claims before comparing the owner identity.
  !owner || (typeof email === "string" && email.trim().toLowerCase() === String(owner).trim().toLowerCase());

async function currentUser(request, db, env) {
  const username = request.headers.get("x-auth-user");
  const token = request.headers.get("x-auth-token");
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (dashboardRequest(request, env) && (assertion || request.headers.get("cf-access-authenticated-user-email") || !username || !token)) {
    const payload = await verifyAccessJwt(assertion || "", env);
    if (!payload || !emailMatchesOwner(payload.email, env.OWNER_EMAIL)) fail(401, "Invalid Access JWT");
    const admin = await first(db, "SELECT * FROM users WHERE username = 'admin'");
    if (!admin || !admin.active) fail(503, "Dashboard administrator unavailable");
    return admin;
  }
  const user = username ? await first(db, "SELECT * FROM users WHERE username = ?", username) : null;
  if (!token || !user || !user.active || !(await tokenMatches(token, user.token_hash))) fail(401, "Invalid authentication credentials");
  return user;
}

function requireAdmin(user) {
  if (user.role !== "admin") fail(403, "Admin access required");
}

async function findNamed(db, table, value, label) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate untrusted ID-or-name input before string methods and parameterized lookup.
  if (isId(value) ? !Number.isSafeInteger(numberId(value)) || numberId(value) <= 0 : typeof value !== "string" || !value.trim()) fail(400, `Invalid ${label}`);
  const column = isId(value) ? "id" : "name";
  const item = await first(db, `SELECT * FROM ${table} WHERE ${column} = ?`, column === "id" ? numberId(value) : value);
  if (!item) fail(400, `Unknown ${label}`);
  return item;
}

function staleHours(env) {
  const value = Number(env.TIMETRACKER_STALE_HOURS ?? 2);
  return Number.isFinite(value) && value >= 0 ? value : 2;
}

async function sweepStaleEntries(db, env, userId) {
  const hours = staleHours(env);
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  const clause = userId == null ? "" : " AND user_id = ?";
  const rows = await all(db, `SELECT id, begin FROM timesheets WHERE end IS NULL AND begin < ?${clause}`, cutoff, ...(userId == null ? [] : [userId]));
  const updates = rows.map(row => query(db, "UPDATE timesheets SET end = ?, auto_closed = 1, end_reason = 'auto' WHERE id = ? AND end IS NULL", new Date(Date.parse(outputDate(row.begin)) + hours * 3_600_000).toISOString(), row.id));
  let closed = 0;
  for (let offset = 0; offset < updates.length; offset += 1000) {
    const results = await db.batch(updates.slice(offset, offset + 1000));
    closed += results.reduce((total, result) => total + result.meta.changes, 0);
  }
  return closed;
}

function serializeTimesheets(rows) {
  const entries = new Map();
  for (const row of rows) {
    let entry = entries.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        user_id: row.user_id,
        project_id: row.project_id,
        activity_id: row.activity_id,
        task_id: row.task_id,
        repo: row.repo,
        purpose: row.purpose,
        description: row.description,
        begin: outputDate(row.begin),
        end: outputDate(row.end),
        end_reason: row.end_reason,
        auto_closed: Boolean(row.auto_closed),
        tokens_input: row.tokens_input,
        tokens_output: row.tokens_output,
        tokens_reasoning: row.tokens_reasoning,
        tokens_cache_read: row.tokens_cache_read,
        tokens_cache_write: row.tokens_cache_write,
        tokens_by_agent: [],
      };
      entries.set(row.id, entry);
    }
    if (row.token_user_id != null) entry.tokens_by_agent.push({
      user_id: row.token_user_id,
      input: row.token_input,
      output: row.token_output,
      reasoning: row.token_reasoning,
      cache_read: row.token_cache_read,
      cache_write: row.token_cache_write,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve the legacy response shape when stored counter provenance is absent.
      ...(row.counter_format == null ? {} : { counter_format: row.counter_format }),
    });
  }
  return [...entries.values()];
}

async function timesheetRows(db, where = "", values = []) {
  return all(db, `SELECT t.*, tt.user_id AS token_user_id, tt.input AS token_input, tt.output AS token_output,
    tt.reasoning AS token_reasoning, tt.cache_read AS token_cache_read, tt.cache_write AS token_cache_write, tt.counter_format
    FROM timesheets t LEFT JOIN timesheet_tokens tt ON tt.timesheet_id = t.id
    ${where ? `WHERE ${where}` : ""} ORDER BY t.id, tt.user_id`, ...values);
}

async function ownedEntry(db, entryId, user, includeStoredBegin = false) {
  const rows = await timesheetRows(db, "t.id = ?", [entryId]);
  const entries = serializeTimesheets(rows);
  const entry = entries[0];
  if (!entry) fail(404, "Timesheet not found");
  if (user.role !== "admin" && entry.user_id !== user.id) fail(403, "Not allowed to access this timesheet");
  if (includeStoredBegin) entry.stored_begin = rows[0].begin;
  return entry;
}

async function listedTimesheets(url, db, env, user) {
  const requestedUser = url.searchParams.get("user");
  const conditions = [];
  const values = [];
  if (user.role !== "admin") {
    conditions.push("t.user_id = ?");
    values.push(user.id);
  } else if (requestedUser) {
    const target = await first(db, "SELECT id FROM users WHERE username = ?", requestedUser);
    if (!target) fail(400, "Unknown user");
    conditions.push("t.user_id = ?");
    values.push(target.id);
  }
  const project = url.searchParams.get("project");
  if (project != null) {
    const item = await findNamed(db, "projects", project, "project");
    conditions.push("t.project_id = ?");
    values.push(item.id);
  }
  const repo = url.searchParams.get("repo");
  if (repo != null) {
    conditions.push("t.repo = ?");
    values.push(repo);
  }
  const purpose = url.searchParams.get("purpose");
  if (purpose != null) {
    if (purpose === "unclassified") conditions.push("t.purpose IS NULL");
    else {
      conditions.push("t.purpose = ?");
      values.push(validPurpose(purpose));
    }
  }
  for (const [name, operator] of [["begin", ">="], ["end", "<="]]) {
    const value = url.searchParams.get(name);
    if (value != null) {
      conditions.push(`t.begin ${operator} ?`);
      values.push(iso(value));
    }
  }
  return serializeTimesheets(await timesheetRows(db, conditions.join(" AND "), values));
}

async function createProject(request, db) {
  const name = requireText(await body(request), "name");
  if (await first(db, "SELECT id FROM projects WHERE name = ?", name)) fail(409, "A project with this name already exists");
  let customer = await first(db, "SELECT * FROM customers WHERE name = 'Internal'");
  if (!customer) {
    const result = await query(db, "INSERT INTO customers (name) VALUES ('Internal')").run();
    customer = { id: result.meta.last_row_id };
  }
  const result = await query(db, "INSERT INTO projects (name, customer_id) VALUES (?, ?)", name, customer.id).run();
  return projectResponse(await first(db, "SELECT * FROM projects WHERE id = ?", result.meta.last_row_id));
}

async function createRecommendedTask(request, db) {
  const payload = await body(request);
  const description = requireText(payload, "description");
  if (!("project" in payload)) fail(400, "project is required");
  const project = await findNamed(db, "projects", payload.project, "project");
  const result = await query(db, "INSERT INTO recommended_tasks (project_id, description, created_at) VALUES (?, ?, ?)", project.id, description, new Date().toISOString()).run();
  const task = await first(db, "SELECT * FROM recommended_tasks WHERE id = ?", result.meta.last_row_id);
  return { ...task, created_at: outputDate(task.created_at) };
}

function validPurpose(value) {
  if (value !== null && !["research", "career", "business", "support"].includes(value)) fail(400, "Invalid purpose");
  return value;
}

async function createTimesheet(request, db, env, user) {
  const payload = await body(request);
  if ("resume_of" in payload && "purpose" in payload) fail(400, "Purpose cannot be supplied when resuming");
  const purpose = "purpose" in payload ? validPurpose(payload.purpose) : null;
  await sweepStaleEntries(db, env, user.id);
  let source;
  if ("resume_of" in payload) {
    if (!isId(payload.resume_of)) fail(400, "Invalid resume_of");
    source = await ownedEntry(db, numberId(payload.resume_of), user, true);
    if (await first(db, "SELECT 1 FROM timesheets WHERE user_id = ? AND COALESCE(task_id, id) = ? AND end IS NULL", source.user_id, source.task_id ?? source.id)) fail(409, "Task already has a running entry");
  }
  const description = source ? source.description : requireText(payload, "description");
  const repo = source ? source.repo : "repo" in payload ? requireText(payload, "repo") : null;
  if (!source && (!("project" in payload) || !("activity" in payload))) fail(400, "project and activity are required");
  const [project, activity] = source ? [
    { id: source.project_id },
    { id: source.activity_id },
  ] : await Promise.all([
    findNamed(db, "projects", payload.project, "project"),
    findNamed(db, "activities", payload.activity, "activity"),
  ]);
  if ((await first(db, "SELECT archived FROM projects WHERE id = ?", project.id)).archived) fail(400, "Project is archived");
  const begin = payload.begin == null ? new Date().toISOString() : iso(payload.begin, "Invalid begin datetime");
  const insert = source
    ? query(db, "INSERT INTO timesheets (user_id, project_id, activity_id, task_id, description, repo, purpose, begin) SELECT ?, ?, ?, ?, ?, ?, purpose, ? FROM timesheets WHERE id = ? AND user_id = ? AND COALESCE(task_id, id) = ? AND begin = ? AND NOT EXISTS (SELECT 1 FROM timesheets WHERE user_id IN (?, ?) AND COALESCE(task_id, id) = ? AND end IS NULL)", user.id, project.id, activity.id, source.task_id ?? source.id, description, repo, begin, source.id, source.user_id, source.task_id ?? source.id, source.stored_begin, source.user_id, user.id, source.task_id ?? source.id)
    : query(db, "INSERT INTO timesheets (user_id, project_id, activity_id, task_id, description, repo, purpose, begin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", user.id, project.id, activity.id, null, description, repo, purpose, begin);
  const statements = [insert];
  if (!source) statements.push(query(db, "UPDATE timesheets SET task_id = id WHERE id = last_insert_rowid()"));
  const [result] = await db.batch(statements);
  if (!result.meta.changes) {
    if (source && await first(db, "SELECT 1 FROM timesheets WHERE id = ? AND user_id = ? AND COALESCE(task_id, id) = ? AND begin = ?", source.id, source.user_id, source.task_id ?? source.id, source.stored_begin)) fail(409, "Task already has a running entry");
    fail(404, "Timesheet not found");
  }
  return ownedEntry(db, result.meta.last_row_id, user);
}

function validateTokenMap(value, label) {
  if (!isObject(value)) fail(400, label);
  for (const key of TOKEN_KEYS) {
    if (!(key in value)) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail(400, label);
  }
}

async function mutateTimesheet(db, entry, statements, reopen = false) {
  let condition = "id = ? AND user_id = ? AND begin = ? AND COALESCE(task_id, id) = ?";
  const values = [entry.id, entry.user_id, entry.stored_begin, entry.task_id ?? entry.id];
  if (reopen) {
    condition += " AND NOT EXISTS (SELECT 1 FROM timesheets WHERE user_id = ? AND COALESCE(task_id, id) = ? AND end IS NULL AND id != ?)";
    values.push(entry.user_id, entry.task_id ?? entry.id, entry.id);
  }
  const identity = `SELECT 1 FROM timesheets WHERE ${condition}`;
  // An invalid JSON sentinel aborts the whole D1 batch before any mutation.
  const guard = query(db, `SELECT json(CASE WHEN EXISTS (${identity}) THEN '1' ELSE 'stale' END)`, ...values);
  try {
    await db.batch([guard, ...statements]);
  } catch (error) {
    if (!await first(db, identity, ...values)) fail(409, "Timesheet changed before mutation");
    throw error;
  }
}

async function applyReviewedPurpose(db, entry, payload) {
  if (Object.keys(payload).length !== 2 || !("purpose" in payload) || payload.purpose === null) fail(400, "Reviewed purpose requires only purpose and purpose_review");
  const purpose = validPurpose(payload.purpose);
  const review = payload.purpose_review;
  if (!isObject(review) || Object.keys(review).some(key => !["segments", "closed_only"].includes(key)) || ("closed_only" in review && review.closed_only !== true) || !Array.isArray(review.segments) || review.segments.length < 1 || review.segments.length > 200) fail(400, "Invalid purpose_review");
  const expected = new Map();
  const fields = ["id", "project_id", "repo", "description", "begin"];
  for (const segment of review.segments) {
    if (!isObject(segment) || Object.keys(segment).length !== fields.length || !fields.every(key => key in segment)
      || !Number.isSafeInteger(segment.id) || segment.id <= 0 || expected.has(segment.id)
      || !Number.isSafeInteger(segment.project_id) || segment.project_id <= 0
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate untrusted review snapshot strings before comparing stored evidence.
      || !(segment.repo === null || typeof segment.repo === "string") || typeof segment.description !== "string") fail(400, "Invalid reviewed segment");
    expected.set(segment.id, { ...segment, begin: iso(segment.begin, "Invalid reviewed begin") });
  }
  if (!expected.has(entry.id)) fail(400, "Review must include the requested entry");
  const taskId = entry.task_id ?? entry.id;
  const rows = await all(db, "SELECT id, project_id, repo, description, begin, end, purpose FROM timesheets WHERE user_id = ? AND COALESCE(task_id, id) = ? ORDER BY id", entry.user_id, taskId);
  if (rows.length !== expected.size || rows.some(row => {
    const previous = expected.get(row.id);
    return !previous || row.purpose !== null || (review.closed_only && row.end === null) || row.project_id !== previous.project_id || row.repo !== previous.repo
      || row.description !== previous.description || outputDate(row.begin) !== previous.begin;
  })) fail(409, "Reviewed task changed or already has a purpose");
  const snapshot = JSON.stringify(rows);
  const predicate = `SELECT 1 WHERE
    (SELECT COUNT(*) FROM timesheets WHERE user_id = ? AND COALESCE(task_id, id) = ?) = json_array_length(?)
    AND NOT EXISTS (SELECT 1 FROM json_each(?) AS segment WHERE NOT EXISTS (
      SELECT 1 FROM timesheets AS t WHERE t.id = json_extract(segment.value, '$.id') AND t.user_id = ? AND COALESCE(t.task_id, t.id) = ?
        AND t.begin = json_extract(segment.value, '$.begin') AND t.project_id = json_extract(segment.value, '$.project_id')
        AND t.repo IS json_extract(segment.value, '$.repo') AND t.description IS json_extract(segment.value, '$.description') AND t.purpose IS NULL${review.closed_only ? " AND t.end IS NOT NULL" : ""}))`;
  const values = [entry.user_id, taskId, snapshot, snapshot, entry.user_id, taskId];
  const guard = query(db, `SELECT json(CASE WHEN EXISTS (${predicate}) THEN '1' ELSE 'stale' END)`, ...values);
  try {
    await mutateTimesheet(db, entry, [guard, query(db, "UPDATE timesheets SET purpose = ? WHERE user_id = ? AND COALESCE(task_id, id) = ?", purpose, entry.user_id, taskId)]);
  } catch (error) {
    if (!await first(db, predicate, ...values)) fail(409, "Reviewed task changed or already has a purpose");
    throw error;
  }
}

async function patchTimesheet(request, db, env, user, entryId) {
  const entry = await ownedEntry(db, entryId, user, true);
  const payload = await body(request);
  if ("purpose_review" in payload) {
    await applyReviewedPurpose(db, entry, payload);
    return ownedEntry(db, entryId, user);
  }
  if ("tokens" in payload && "tokens_by_agent" in payload) fail(400, "Supply either tokens or tokens_by_agent");
  if (payload.end === null && Date.parse(entry.begin) < Date.now() - staleHours(env) * 3_600_000) fail(409, "Cannot reopen a stale timesheet");
  if (payload.end === null && await first(db, "SELECT 1 FROM timesheets WHERE user_id = ? AND COALESCE(task_id, id) = ? AND end IS NULL AND id != ?", entry.user_id, entry.task_id ?? entry.id, entryId)) fail(409, "Task already has a running entry");
  const statements = [];
  if ("project" in payload) {
    const project = await findNamed(db, "projects", payload.project, "project");
    if (project.archived) fail(400, "Project is archived");
    statements.push(query(db, "UPDATE timesheets SET project_id = ? WHERE id = ?", project.id, entryId));
  }
  if ("activity" in payload) {
    const activity = await findNamed(db, "activities", payload.activity, "activity");
    statements.push(query(db, "UPDATE timesheets SET activity_id = ? WHERE id = ?", activity.id, entryId));
  }
  if ("description" in payload) statements.push(query(db, "UPDATE timesheets SET description = ? WHERE id = ?", requireText(payload, "description"), entryId));
  if ("repo" in payload) statements.push(query(db, "UPDATE timesheets SET repo = ? WHERE id = ?", patchRepo(payload), entryId));
  if ("purpose" in payload) statements.push(query(db, "UPDATE timesheets SET purpose = ? WHERE user_id = ? AND COALESCE(task_id, id) = ?", validPurpose(payload.purpose), entry.user_id, entry.task_id ?? entry.id));
  if ("end_reason" in payload && !["done", "paused", "auto"].includes(payload.end_reason)) fail(400, "Invalid end_reason");
  if ("tokens" in payload) {
    validateTokenMap(payload.tokens, "Invalid tokens");
    if (TOKEN_KEYS.some(key => key in payload.tokens)) statements.push(query(db, "DELETE FROM timesheet_tokens WHERE timesheet_id = ?", entryId));
    for (const key of TOKEN_KEYS) if (key in payload.tokens) statements.push(query(db, `UPDATE timesheets SET tokens_${key} = ? WHERE id = ?`, payload.tokens[key], entryId));
  }
  if ("tokens_by_agent" in payload) {
    const breakdown = payload.tokens_by_agent;
    if (!isObject(breakdown) || Object.keys(breakdown).length === 0) fail(400, "Invalid tokens_by_agent");
    for (const [username, values] of Object.entries(breakdown)) {
      validateTokenMap(values, "Invalid tokens_by_agent");
      if ("counter_format" in values && (values.counter_format !== COUNTER_FORMAT || !TOKEN_KEYS.every(key => key in values))) fail(400, "Invalid counter_format or incomplete counters");
      const agent = await first(db, "SELECT id FROM users WHERE username = ?", username);
      if (!agent) fail(400, `Unknown user '${username}'`);
      const keys = TOKEN_KEYS.filter(key => key in values);
      const columns = ["timesheet_id", "user_id", ...keys, "counter_format"];
      const conflict = `DO UPDATE SET ${[...keys, "counter_format"].map(key => `${key} = excluded.${key}`).join(", ")}`;
      statements.push(query(db, `INSERT INTO timesheet_tokens (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(timesheet_id, user_id) ${conflict}`, entryId, agent.id, ...keys.map(key => values[key]), values.counter_format ?? null));
    }
  }
  if ("end" in payload) {
    const end = payload.end === null ? null : iso(payload.end, "Invalid end datetime");
    if (end !== null && Date.parse(end) < Date.parse(entry.begin)) fail(400, "end must not precede begin");
    statements.push(query(db, "UPDATE timesheets SET end = ?, end_reason = ?, auto_closed = 0 WHERE id = ?", end, end === null ? null : payload.end_reason ?? "done", entryId));
  } else if (entry.end === null && ("end_reason" in payload || ![...PATCH_FIELDS].some(key => key in payload))) {
    const end = new Date().toISOString();
    if (Date.parse(end) < Date.parse(entry.begin)) fail(400, "end must not precede begin");
    // A concurrent end may have committed since the read; keep the first end.
    statements.push(query(db, "UPDATE timesheets SET end = ?, end_reason = ? WHERE id = ? AND end IS NULL", end, payload.end_reason ?? "done", entryId));
  } else if ("end_reason" in payload) {
    statements.push(query(db, "UPDATE timesheets SET end_reason = ?, auto_closed = ? WHERE id = ?", payload.end_reason, Number(payload.end_reason === "auto"), entryId));
  }
  if ("tokens_by_agent" in payload) {
    statements.push(query(db, `UPDATE timesheets SET ${TOKEN_KEYS.map(key => `tokens_${key} = (SELECT COALESCE(SUM(${key}), 0) FROM timesheet_tokens WHERE timesheet_id = timesheets.id)`).join(", ")} WHERE id = ?`, entryId));
  }
  if (statements.length) await mutateTimesheet(db, entry, statements, payload.end === null);
  return ownedEntry(db, entryId, user);
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const db = env.DB;
  if (pathname === "/health") {
    await first(db, "SELECT 1 AS ok");
    return response({ status: "ok", database: "D1" });
  }
  if (!pathname.startsWith("/api/")) return response({ detail: "Not found" }, 404);
  if (dashboardRequest(request, env) && !["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.get("origin") && request.headers.get("origin") !== `https://${env.DASHBOARD_HOST}`) fail(403, "Cross-origin dashboard mutation denied");
  const user = await currentUser(request, db, env);

  if (pathname === "/api/capabilities" && request.method === "GET") {
    const feature = new URL(request.url).searchParams.get("feature");
    if (feature === "token_format") return response({ token_format: [COUNTER_FORMAT] });
    if (feature !== null) fail(400, "Unknown capability feature");
    return response({ purpose_review: { version: 1, closed_only: true } });
  }
  if (pathname === "/api/projects") {
    if (request.method === "GET") return response((await all(db, "SELECT * FROM projects ORDER BY id")).map(projectResponse));
    if (request.method === "POST") return response(await createProject(request, db));
  }
  const projectPath = /^\/api\/projects\/(\d+)$/.exec(pathname);
  if (projectPath) {
    requireAdmin(user);
    const projectId = Number(projectPath[1]);
    if (request.method === "PATCH") {
      const project = await first(db, "SELECT * FROM projects WHERE id = ?", projectId);
      if (!project) fail(404, "Project not found");
      const payload = await body(request);
      const statements = [];
      if ("name" in payload) {
        const name = requireText(payload, "name");
        const existing = await first(db, "SELECT id FROM projects WHERE name = ?", name);
        if (existing && existing.id !== projectId) fail(409, "A project with this name already exists");
        statements.push(query(db, "UPDATE projects SET name = ? WHERE id = ?", name, projectId));
      }
      if ("description" in payload) statements.push(query(db, "UPDATE projects SET description = ? WHERE id = ?", projectDescription(payload.description), projectId));
      if ("archived" in payload) {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject non-boolean JSON before persisting archive status.
        if (typeof payload.archived !== "boolean") fail(400, "archived must be a boolean");
        statements.push(query(db, "UPDATE projects SET archived = ? WHERE id = ?", Number(payload.archived), projectId));
      }
      if (!statements.length) fail(400, "No project fields supplied");
      await db.batch(statements);
      return response(projectResponse(await first(db, "SELECT * FROM projects WHERE id = ?", projectId)));
    }
    if (request.method === "DELETE") {
      if (!await first(db, "SELECT id FROM projects WHERE id = ?", projectId)) fail(404, "Project not found");
      if (await first(db, "SELECT 1 FROM timesheets WHERE project_id = ?", projectId)) fail(409, "Project has timesheet entries");
      if (await first(db, "SELECT 1 FROM recommended_tasks WHERE project_id = ?", projectId)) fail(409, "Project has recommended tasks");
      await query(db, "DELETE FROM projects WHERE id = ?", projectId).run();
      return empty();
    }
  }

  if (pathname === "/api/recommended-tasks") {
    if (request.method === "GET") {
      const project = new URL(request.url).searchParams.get("project");
      const taskRows = project == null ? await all(db, "SELECT * FROM recommended_tasks ORDER BY id") : await all(db, "SELECT * FROM recommended_tasks WHERE project_id = ? ORDER BY id", (await findNamed(db, "projects", project, "project")).id);
      return response(taskRows.map(task => ({ ...task, created_at: outputDate(task.created_at) })));
    }
    if (request.method === "POST") {
      requireAdmin(user);
      return response(await createRecommendedTask(request, db));
    }
  }
  const taskPath = /^\/api\/recommended-tasks\/(\d+)$/.exec(pathname);
  if (taskPath && request.method === "DELETE") {
    requireAdmin(user);
    const taskId = Number(taskPath[1]);
    if (!await first(db, "SELECT id FROM recommended_tasks WHERE id = ?", taskId)) fail(404, "Recommended task not found");
    await query(db, "DELETE FROM recommended_tasks WHERE id = ?", taskId).run();
    return empty();
  }

  if (pathname === "/api/activities" && request.method === "GET") return response(await all(db, "SELECT * FROM activities ORDER BY id"));
  if (pathname === "/api/users" && request.method === "GET") {
    requireAdmin(user);
    return response(await all(db, "SELECT id, username, role, active FROM users ORDER BY id").then(rows => rows.map(row => ({ ...row, active: Boolean(row.active) }))));
  }
  const rotatePath = /^\/api\/users\/(\d+)\/rotate-token$/.exec(pathname);
  if (rotatePath && request.method === "POST") {
    requireAdmin(user);
    const target = await first(db, "SELECT id, username FROM users WHERE id = ?", Number(rotatePath[1]));
    if (!target) fail(404, "User not found");
    const rotated = await issueToken();
    await query(db, "UPDATE users SET token_hash = ? WHERE id = ?", rotated.hash, target.id).run();
    return response({ ...target, token: rotated.token });
  }

  if (pathname === "/api/timesheets") {
    if (request.method === "GET") return response(await listedTimesheets(new URL(request.url), db, env, user));
    if (request.method === "POST") return response(await createTimesheet(request, db, env, user));
  }
  const timesheetPath = /^\/api\/timesheets\/(\d+)$/.exec(pathname);
  if (timesheetPath) {
    const entryId = Number(timesheetPath[1]);
    if (request.method === "GET") return response(await ownedEntry(db, entryId, user));
    if (request.method === "DELETE") {
      const entry = await ownedEntry(db, entryId, user, true);
      await mutateTimesheet(db, entry, [
        query(db, "DELETE FROM timesheet_tokens WHERE timesheet_id = ?", entryId),
        query(db, "DELETE FROM timesheets WHERE id = ?", entryId),
      ]);
      return empty();
    }
    if (request.method === "PATCH") return response(await patchTimesheet(request, db, env, user, entryId));
  }
  return response({ detail: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return response({ detail: error.message }, error.status);
      console.error(JSON.stringify({ message: "timetracker request failed", path: new URL(request.url).pathname, error: error instanceof Error ? error.message : String(error) }));
      return response({ detail: "Internal server error" }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sweepStaleEntries(env.DB, env).then((closed) => {
      console.log(JSON.stringify({ message: "timetracker scheduled sweep complete", closed }));
    }).catch((error) => {
      console.error(JSON.stringify({ message: "timetracker scheduled sweep failed", error: error instanceof Error ? error.message : String(error) }));
    }));
  },
};
