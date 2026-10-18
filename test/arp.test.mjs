// ARP (Agent Request Protocol) tests: the built-in "agents" connector.
// Run: node --test test/arp.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { testServerEnv, cleanupTestConfigDir } from "./helpers.mjs";
import { OPERATOR } from "../src/registry.js";
import { rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ArpStore } from "../src/arp.js";

// The server is restarted mid-test, so it needs a stable port: probe-bind 0 for a free one,
// release it, and have Switchboard take it (a tiny race beats a fixed port).
const PORT = await new Promise((res, rej) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
  s.on("error", rej);
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = new URL("data-arp", import.meta.url).pathname;
const NOTIFY = new URL("data-arp/notify.jsonl", import.meta.url).pathname;
const ENV = testServerEnv({
  SB_LOG_DIR: new URL("logs-arp", import.meta.url).pathname,
  SB_DATA_DIR: DATA_DIR,
  SB_LISTEN: `127.0.0.1:${PORT}`,
  SB_OAUTH_NOTIFY_FILE: NOTIFY,
});
let proc;

function startSb() {
  proc = spawn("node", [new URL("../src/index.js", import.meta.url).pathname], { env: ENV, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((ok) => proc.stdout.on("data", (d) => String(d).includes("backend_started") && ok()));
}
async function stopSb() {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
}
async function connect(token, server = "agents") {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${server}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const struct = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);
async function call(token, name, args) {
  const c = await connect(token);
  try {
    return await c.callTool({ name, arguments: args });
  } finally {
    await c.close();
  }
}
async function rest(token, connector, tool, body) {
  const r = await fetch(`${BASE}/api/call/${connector}/${tool}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const health = () => fetch(`${BASE}/healthz`).then((r) => r.json());

// Test tokens (sha256s live in test/config/agents.yaml): arp-a, arp-b are two fresh identities
// with ONLY the agents connector granted, so any access to "mock" must come from an ARP grant.
const A = "tok-arp-a";
const B = "tok-arp-b";
const ADMIN = OPERATOR; // mirrors `sb arp` CLI admin identity

let adminStore;

before(async () => {
  rmSync(new URL("logs-arp", import.meta.url), { recursive: true, force: true });
  rmSync(new URL("data-arp", import.meta.url), { recursive: true, force: true });
  mkdirSync(new URL("data-arp", import.meta.url), { recursive: true });
  await startSb();
  while (!(await health()).connectors["mock-serial"]?.up) await new Promise((r) => setTimeout(r, 100));
  adminStore = new ArpStore(new URL("data-arp/arp.sqlite", import.meta.url).pathname);
});
after(async () => {
  adminStore.close();
  await stopSb();
  cleanupTestConfigDir();
});

test("first contact between two agents is held for operator pair approval", async () => {
  const r1 = struct(await call(A, "agents.request", { to: "arp-b", type: "info", subject: "hi", body: "just saying hello" }));
  assert.equal(r1.status, "awaiting_operator");
  // b's inbox is empty until the pair is approved
  const inbox = struct(await call(B, "agents.inbox", {}));
  assert.equal(inbox.requests.length, 0);

  const pending = adminStore.listPendingApprovals().find((p) => p.kind === "pair");
  assert.ok(pending, "expected a pair pending_approval");
  const res = adminStore.resolvePendingApproval(pending.id, true, ADMIN);
  assert.equal(res.ok, true);

  const status = struct(await call(A, "agents.request_status", { request_id: r1.request_id }));
  assert.equal(status.status, "pending");
  const inbox2 = struct(await call(B, "agents.inbox", {}));
  assert.equal(inbox2.requests.length, 1);
  assert.equal(inbox2.requests[0].subject, "hi");
});

test("idempotency_key returns the original request on retry (at-least-once)", async () => {
  const first = struct(await call(A, "agents.request", { to: "arp-b", type: "info", subject: "dup", body: "x", idempotency_key: "k1" }));
  const second = struct(await call(A, "agents.request", { to: "arp-b", type: "info", subject: "dup", body: "different body!", idempotency_key: "k1" }));
  assert.equal(first.request_id, second.request_id);
});

test("secret-looking payloads are rejected in requests and responses", async () => {
  const r = await call(A, "agents.request", { to: "arp-b", type: "info", subject: "creds", body: "here is sk-abcdefghijklmnopqrstuvwxyz123456" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /refused/i);

  const ok = struct(await call(A, "agents.request", { to: "arp-b", type: "info", subject: "clean", body: "no secrets here" }));
  const bad = await call(B, "agents.respond", { request_id: ok.request_id, status: "fulfilled", payload: { note: "token: AKIAABCDEFGHIJKLMNOP" } });
  assert.equal(bad.isError, true);
});

test("agents.list reflects update_profile", async () => {
  await call(A, "agents.update_profile", { display_name: "Agent A", operator: "Ops/Test", capabilities: ["testing"], contact_policy: "notify-operator" });
  const dir = struct(await call(A, "agents.list", {}));
  const me = dir.agents.find((a) => a.agent_id === "arp-a");
  assert.equal(me.display_name, "Agent A");
  assert.deepEqual(me.capabilities, ["testing"]);
});

test("declining requires a reason", async () => {
  const req = struct(await call(A, "agents.request", { to: "arp-b", type: "info", subject: "decline me", body: "x" }));
  const noReason = await call(B, "agents.respond", { request_id: req.request_id, status: "declined" });
  assert.equal(noReason.isError, true);
  const withReason = struct(await call(B, "agents.respond", { request_id: req.request_id, status: "declined", reason: "not now" }));
  assert.equal(withReason.status, "declined");
});

test("requests auto-expire", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const req = struct(await call(A, "agents.request", { to: "arp-b", type: "info", subject: "will expire", body: "x", expires_at: past }));
  adminStore.sweep();
  const status = struct(await call(A, "agents.request_status", { request_id: req.request_id }));
  assert.equal(status.status, "expired");
});

test("tool_access: fulfillment + operator approval mints a scoped grant; enforced on the next call", async () => {
  const req = struct(await call(A, "agents.request", { to: "arp-b", type: "tool_access", subject: "need mock/echo", body: "please grant me mock echo, scoped to text=hello-only" }));
  // Before any grant: arp-a cannot call mock/echo at all.
  const before1 = await rest(A, "mock", "echo", { text: "hello-only" });
  assert.equal(before1.status, 403);

  const fulfilled = struct(await call(B, "agents.respond", { request_id: req.request_id, status: "fulfilled", payload: { connector: "mock", tool: "echo", scope: { text: "hello-only" }, expires_days: 1 } }));
  assert.equal(fulfilled.status, "awaiting_operator");

  const pending = adminStore.listPendingApprovals().find((p) => p.kind === "tool_access" && p.ref_id === req.request_id);
  assert.ok(pending);
  const approval = adminStore.resolvePendingApproval(pending.id, true, ADMIN);
  assert.ok(approval.grant_id);

  // In scope: succeeds.
  const inScope = await rest(A, "mock", "echo", { text: "hello-only" });
  assert.equal(inScope.status, 200);
  assert.equal(inScope.body.text, "hello-only");

  // Out of scope: still denied even though a grant exists.
  const outOfScope = await rest(A, "mock", "echo", { text: "something-else" });
  assert.equal(outOfScope.body.ok, false);

  // Revoke takes effect immediately, no restart.
  const revoked = adminStore.revokeGrant(ADMIN, approval.grant_id);
  assert.equal(revoked.content ? JSON.parse(revoked.content[0].text).revoked : revoked.revoked, true);
  const afterRevoke = await rest(A, "mock", "echo", { text: "hello-only" });
  assert.ok(afterRevoke.status === 403 || afterRevoke.body.ok === false, `expected revoked grant to be denied, got ${afterRevoke.status} ${JSON.stringify(afterRevoke.body)}`);
});

test("tool_access: the responder can only lend access its own key can call", async () => {
  // arp-b holds agents:"*" + mock:[echo], so mock/env and mock-serial are off-limits to lend.
  for (const payload of [{ connector: "mock", tool: "env" }, { connector: "mock-serial", tool: "echo" }]) {
    const req = struct(await call(A, "agents.request", { to: "arp-b", type: "tool_access", subject: `need ${payload.connector}/${payload.tool}`, body: "please" }));
    const r = await call(B, "agents.respond", { request_id: req.request_id, status: "fulfilled", payload });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /can't call it/);
    assert.ok(!adminStore.listPendingApprovals().some((p) => p.kind === "tool_access" && p.ref_id === req.request_id), `no approval queued for ${payload.connector}/${payload.tool}`);
  }
});

test("grants never auto-renew but a T-2d renewal card is queued", async () => {
  const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); // 1 day out
  adminStore.db.prepare("INSERT INTO grants (grant_id, agent_id, connector, tool, created_at, expires_at, created_by) VALUES (?,?,?,?,?,?,?)").run("grt_test_renew", "arp-a", "mock", "pid", new Date().toISOString(), soon, ADMIN);
  adminStore.sweep();
  const pending = adminStore.listPendingApprovals().find((p) => p.kind === "renewal" && p.ref_id === "grt_test_renew");
  assert.ok(pending, "expected a renewal pending_approval");
});

test("audit visibility: agents see only their own entries, operator sees everything", async () => {
  const mine = struct(await call(A, "agents.audit_log", { limit: 500 }));
  assert.ok(mine.entries.length > 0);
  assert.ok(mine.entries.every((e) => e.actor === "arp-a" || e.from_agent === "arp-a" || e.to_agent === "arp-a"));

  const all = adminStore.auditLog(ADMIN, { limit: 1000 });
  assert.ok(all.length >= mine.entries.length);
  assert.ok(all.some((e) => e.from_agent === "arp-b" && e.to_agent === "arp-a"));
});

test("agent without an agents-connector grant is refused (static grants unaffected)", async () => {
  const r = await rest("tok-full", "agents", "agents.list", {});
  assert.equal(r.status, 200); // "full" has {"*":"*"} — sanity check the pattern still matches the dotted tool name
  const r2 = await rest("tok-mockonly", "agents", "agents.list", {});
  assert.equal(r2.status, 403);
});

test("a new pending approval notifies the operator (SB_OAUTH_NOTIFY_FILE seam)", async () => {
  const seen = existsSync(NOTIFY) ? readFileSync(NOTIFY, "utf8").split("\n").filter(Boolean).length : 0;
  // "full" has never contacted arp-b: first contact queues a pair approval card, which must notify.
  const r = struct(await call("tok-full", "agents.request", { to: "arp-b", type: "info", subject: "pair me", body: "hi" }));
  assert.equal(r.status, "awaiting_operator");
  const lines = readFileSync(NOTIFY, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(lines.length > seen, "expected a new notification line");
  const arpNotices = lines.slice(seen).filter((n) => typeof n.text === "string" && n.text.startsWith("ARP:"));
  assert.ok(arpNotices.length >= 1, `expected an ARP notice, got ${JSON.stringify(lines.slice(seen))}`);
  assert.match(arpNotices[0].text, /sb arp approve \d+/);
  assert.ok(arpNotices[0].url, "notification should carry the public URL");
});
