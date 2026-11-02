// Local demo: wrangler dev --local on a throwaway D1 seeded with synthetic data,
// plus a small proxy that plays the part of Cloudflare Access.
// Production auth code is untouched: the Worker verifies a real RS256 JWT, signed
// here with a key generated per run and passed to the Worker as ACCESS_JWKS.
//
//   node scripts/demo/serve.mjs [--seed path/to/seed.sql] [--port 8788]
//
// Never contacts Cloudflare. State lives in .wrangler/demo-state (gitignored).
import { execFile, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const seed = resolve(arg("--seed", "scripts/demo/seed.sql"));
const publicPort = Number(arg("--port", 8788));
const workerPort = publicPort + 1;
const state = resolve(".wrangler/demo-state");
const wrangler = "node_modules/.bin/wrangler";
const env = { ...process.env, MINIFLARE_CACHE_DIR: ".wrangler/cache", WRANGLER_LOG_PATH: ".wrangler/logs", XDG_CONFIG_HOME: ".wrangler/config" };
const run = (...args) => execFileSync(wrangler, [...args, "--persist-to", state], { env, stdio: "inherit" });

rmSync(state, { recursive: true, force: true });
run("d1", "migrations", "apply", "timetracker", "--local");
// Migrations seed a few default rows; the seed file replaces them.
run("d1", "execute", "timetracker", "--local", "--command", "DELETE FROM recommended_tasks; DELETE FROM projects; DELETE FROM activities; DELETE FROM customers; DELETE FROM users;");
run("d1", "execute", "timetracker", "--local", "--file", seed);

const b64 = value => Buffer.from(value).toString("base64url");
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "demo", alg: "RS256", use: "sig" }] };
const head = b64(JSON.stringify({ alg: "RS256", kid: "demo", typ: "JWT" }));
async function jwt() {
  const body = b64(JSON.stringify({ aud: "demo-aud", email: "demo@example.com", exp: Math.floor(Date.now() / 1000) + 300, iss: "https://demo.cloudflareaccess.com" }));
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}

const worker = execFile(wrangler, ["dev", "--local", "--local-upstream", "time.example.com", "--persist-to", state, "--port", String(workerPort),
  "--var", `ACCESS_JWKS:${JSON.stringify(jwks)}`, "--var", "ACCESS_TEAM_DOMAIN:demo.cloudflareaccess.com", "--var", "ACCESS_AUD:demo-aud"], { env });
worker.stdout.pipe(process.stdout); worker.stderr.pipe(process.stderr);

// The Worker treats requests whose Host is the dashboard hostname as browser traffic.
createServer(async (req, res) => {
  const headers = { ...req.headers, host: "time.example.com", "cf-access-jwt-assertion": await jwt() };
  // The Worker rejects mutations from other origins. Drop only this demo's own origin; others still reach that check.
  if (req.headers.origin === `http://127.0.0.1:${publicPort}`) delete headers.origin;
  const up = httpRequest({ host: "127.0.0.1", port: workerPort, path: req.url, method: req.method, headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(publicPort, "127.0.0.1", () => console.log(`demo dashboard: http://127.0.0.1:${publicPort}`));

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { worker.kill(); process.exit(0); });
