// End-to-end OAuth sign-in: discovery, registration, operator approval, PKCE code exchange, refresh rotation.
// Run: node --test test/oauth.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { testServerEnv, cleanupTestConfigDir } from "./helpers.mjs";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// SB_PUBLIC_URL must match the listen address, so pick a free port before spawning
// (probe-bind on 0, release, then have Switchboard take it — a tiny race beats a fixed port).
const PORT = await new Promise((res, rej) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
  s.on("error", rej);
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = new URL("data-oauth", import.meta.url).pathname;
const NOTIFY = new URL("data-oauth/notify.jsonl", import.meta.url).pathname;
const REDIRECT = "https://client.example/callback";
const ENV = testServerEnv({
  SB_LOG_DIR: new URL("logs-oauth", import.meta.url).pathname,
  SB_DATA_DIR: DATA_DIR,
  SB_LISTEN: `127.0.0.1:${PORT}`,
  SB_PUBLIC_URL: BASE,
  SB_OAUTH_NOTIFY_FILE: NOTIFY,
});
let proc;

const health = () => fetch(`${BASE}/healthz`).then((r) => r.json());
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const lastNotice = () => JSON.parse(readFileSync(NOTIFY, "utf8").trim().split("\n").pop());

before(async () => {
  for (const d of [DATA_DIR, new URL("logs-oauth", import.meta.url).pathname]) rmSync(d, { recursive: true, force: true });
  proc = spawn("node", [new URL("../src/index.js", import.meta.url).pathname], { env: ENV, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => proc.stdout.on("data", (d) => String(d).includes("backend_started") && ok()));
  while (!(await health()).connectors["mock-serial"]?.up) await new Promise((r) => setTimeout(r, 100));
});
after(async () => {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
  cleanupTestConfigDir();
});

async function register(extra = {}) {
  const r = await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test App", redirect_uris: [REDIRECT], ...extra }) });
  return [r.status, await r.json()];
}

/** Start a sign-in; returns the browser's poll/finish URLs and the approval link sent to the operator. */
async function startAuth(clientId, challenge, extra = {}) {
  const u = new URL(`${BASE}/oauth/authorize`);
  const q = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st8", resource: `${BASE}/mcp`, ...extra };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const r = await fetch(u, { redirect: "manual" });
  const html = r.status === 200 ? await r.text() : "";
  const finish = /const finish = "([^"]+)"/.exec(html)?.[1];
  return { status: r.status, location: r.headers.get("location"), html, finish, poll: finish?.replace("/finish?", "/poll?"), approve: existsSync(NOTIFY) ? lastNotice().url : null };
}

async function decide(approveUrl, decision) {
  const t = new URL(approveUrl).searchParams.get("t");
  return fetch(`${BASE}/oauth/approve`, form({ t, decision }));
}

test("unauthenticated /mcp advertises OAuth; metadata points at our endpoints", async () => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("www-authenticate"), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(prm.authorization_servers, [BASE]);
  assert.equal(prm.resource, `${BASE}/mcp`);
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.token_endpoint, `${BASE}/oauth/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("registration rejects non-https redirect URIs", async () => {
  const [s] = await register({ redirect_uris: ["http://evil.example/cb"] });
  assert.equal(s, 400);
});

test("full sign-in: approve, exchange, use, refresh, reuse detection", async () => {
  const [s, client] = await register();
  assert.equal(s, 201);
  const { verifier, challenge } = pkce();
  const a = await startAuth(client.client_id, challenge);
  assert.equal(a.status, 200);
  assert.match(lastNotice().text, /"Test App" wants to connect as agent "oauth-ok"/);

  // Not approved yet: browser can't finish, and a stranger without the browser key can't poll.
  assert.equal((await fetch(a.finish, { redirect: "manual" })).status, 409);
  assert.equal((await fetch(a.poll.replace(/k=[^&]+/, "k=nope"))).status, 404);

  // Review page needs a POST to approve (link previews only GET).
  const review = await fetch(a.approve);
  assert.match(await review.text(), /Approve sign-in\?/);
  assert.equal((await (await fetch(a.poll)).json()).status, "pending");
  assert.equal((await decide(a.approve, "approve")).status, 200);
  assert.equal((await (await fetch(a.poll)).json()).status, "approved");

  const fin = await fetch(a.finish, { redirect: "manual" });
  assert.equal(fin.status, 302);
  const back = new URL(fin.headers.get("location"));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st8");
  const code = back.searchParams.get("code");
  assert.equal((await fetch(a.finish, { redirect: "manual" })).status, 409, "finish is one-shot");

  const tok = await (await fetch(`${BASE}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: client.client_id }))).json();
  assert.ok(tok.access_token?.startsWith("sbo_"), JSON.stringify(tok));
  assert.equal(tok.token_type, "Bearer");
  const again = await fetch(`${BASE}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }));
  assert.equal((await again.json()).error, "invalid_grant", "code is single-use");

  // The token acts as agent oauth-ok: combined MCP shows only its grant, and the call works.
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }));
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["mock__echo"]);
  assert.equal((await c.callTool({ name: "mock__echo", arguments: { text: "hi" } })).content[0].text, "hi");
  await c.close();

  // Refresh rotates; replaying the old refresh token kills every token for the client.
  const r2 = await (await fetch(`${BASE}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id }))).json();
  assert.ok(r2.access_token && r2.access_token !== tok.access_token);
  const ok2 = await fetch(`${BASE}/api/tools`, { headers: { Authorization: `Bearer ${r2.access_token}` } });
  assert.equal(ok2.status, 200);
  const replay = await (await fetch(`${BASE}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id }))).json();
  assert.equal(replay.error, "invalid_grant");
  assert.equal((await fetch(`${BASE}/api/tools`, { headers: { Authorization: `Bearer ${r2.access_token}` } })).status, 401);
});

test("wrong PKCE verifier is rejected", async () => {
  const [, client] = await register();
  const { challenge } = pkce();
  const a = await startAuth(client.client_id, challenge);
  await decide(a.approve, "approve");
  const code = new URL((await fetch(a.finish, { redirect: "manual" })).headers.get("location")).searchParams.get("code");
  const r = await (await fetch(`${BASE}/oauth/token`, form({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: client.client_id }))).json();
  assert.equal(r.error, "invalid_grant");
});

test("operator denies -> app gets access_denied", async () => {
  const [, client] = await register();
  const a = await startAuth(client.client_id, pkce().challenge);
  await decide(a.approve, "deny");
  const back = new URL((await fetch(a.finish, { redirect: "manual" })).headers.get("location"));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal((await decide(a.approve, "approve")).status, 200, "late approve is a no-op page");
  assert.equal((await (await fetch(a.poll)).json()).status, "denied");
});

test("agents without oauth: true can't be chosen; bad redirect never bounces", async () => {
  const [, client] = await register();
  const a = await startAuth(client.client_id, pkce().challenge, { sb_agent: "full" });
  assert.equal(a.status, 302);
  assert.equal(new URL(a.location).searchParams.get("error"), "access_denied");
  const b = await startAuth(client.client_id, pkce().challenge, { redirect_uri: "https://evil.example/cb" });
  assert.equal(b.status, 400);
  const c = await startAuth(client.client_id, "", {});
  assert.equal(new URL(c.location).searchParams.get("error"), "invalid_request");
});

test("confidential clients must present their secret", async () => {
  const [, client] = await register({ token_endpoint_auth_method: "client_secret_post" });
  assert.ok(client.client_secret);
  const r = await fetch(`${BASE}/oauth/token`, form({ grant_type: "refresh_token", refresh_token: "sbr_x", client_id: client.client_id, client_secret: "wrong" }));
  assert.equal(r.status, 401);
});

test("loopback redirect URIs may use any port (native apps like Codex)", async () => {
  const [, client] = await register({ redirect_uris: ["http://127.0.0.1/callback/x"] });
  const ok = await startAuth(client.client_id, pkce().challenge, { redirect_uri: "http://127.0.0.1:54321/callback/x" });
  assert.equal(ok.status, 200);
  const badPath = await startAuth(client.client_id, pkce().challenge, { redirect_uri: "http://127.0.0.1:54321/other" });
  assert.equal(badPath.status, 400);
  const badHost = await startAuth(client.client_id, pkce().challenge, { redirect_uri: "http://evil.example:54321/callback/x" });
  assert.equal(badHost.status, 400);
});

