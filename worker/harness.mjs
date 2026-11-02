import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";

const exec = promisify(execFile);
const wrangler = "node_modules/.bin/wrangler";
const workerEnv = { ...process.env, MINIFLARE_CACHE_DIR: ".wrangler/cache", WRANGLER_LOG_PATH: ".wrangler/logs", XDG_CONFIG_HOME: ".wrangler/config" };
const runWrangler = (...args) => exec(wrangler, args, { env: workerEnv });
const base64url = value => Buffer.from(value).toString("base64url");

let accessPrivateKey;
let url;
let worker;

export const headers = (username, token) => ({ Host: "time-api.example.com", "X-AUTH-USER": username, "X-AUTH-TOKEN": token });

export async function accessJwt(payload = {}, key = accessPrivateKey) {
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const encodedPayload = base64url(JSON.stringify({
    aud: "test-access-aud",
    email: "owner@example.com",
    exp: Math.floor(Date.now() / 1000) + 60,
    iss: "https://test.cloudflareaccess.com",
    ...payload,
  }));
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, signed);
  return `${encodedHeader}.${encodedPayload}.${Buffer.from(signature).toString("base64url")}`;
}

export async function request(path, { body, headers: extraHeaders, method = "GET" } = {}) {
  const options = { method, headers: { ...extraHeaders } };
  if (body !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${url}${path}`, options);
  return { body: res.status === 204 ? null : res.headers.get("content-type")?.includes("application/json") ? await res.json() : await res.text(), status: res.status };
}

export async function reset() {
  await runWrangler("d1", "migrations", "apply", "timetracker", "--local");
  await runWrangler("d1", "execute", "timetracker", "--local", "--command", `
    DELETE FROM timesheet_tokens; DELETE FROM timesheets; DELETE FROM recommended_tasks;
    DELETE FROM projects; DELETE FROM users; DELETE FROM activities; DELETE FROM customers;
    INSERT INTO customers (id, name) VALUES (1, 'Internal');
    INSERT INTO activities (id, name) VALUES (1, 'Assigned Task');
    INSERT INTO projects (id, name, customer_id) VALUES
      (1, 'etc', 1), (2, 'research', 1), (3, 'work', 1), (4, 'personal', 1);
    INSERT INTO users (id, username, role, token_hash, active) VALUES
      (1, 'admin', 'admin', '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e', 1),
      (2, 'alice', 'user', '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e', 1),
      (3, 'bob', 'user', '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e', 1);
  `);
}

export async function start() {
  await reset();
  const probe = createServer();
  const port = await new Promise(resolve => probe.listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  }));
  url = `http://127.0.0.1:${port}`;
  const keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  accessPrivateKey = keyPair.privateKey;
  const accessJwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] };
  worker = execFile(wrangler, ["dev", "--local", "--local-upstream", "time.example.com", "--test-scheduled", "--port", String(port), "--var", `ACCESS_JWKS:${JSON.stringify(accessJwks)}`, "--var", "ACCESS_TEAM_DOMAIN:test.cloudflareaccess.com", "--var", "ACCESS_AUD:test-access-aud"], { env: workerEnv });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      if ((await fetch(`${url}/health`)).status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  worker.kill();
  throw new Error("Worker did not start");
}

export function stop() {
  worker?.kill();
}
