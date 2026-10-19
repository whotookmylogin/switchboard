// End-to-end tests: start Switchboard against the mock connector and exercise it as an MCP client would.
// Run: node --test test/proxy.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { testServerEnv, cleanupTestConfigDir } from "./helpers.mjs";

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
const ENV = testServerEnv({ SB_LOG_DIR: new URL("logs", import.meta.url).pathname, SB_LISTEN: `127.0.0.1:${PORT}` });
let proc;

function startSb() {
  proc = spawn("node", [new URL("../src/index.js", import.meta.url).pathname], { env: ENV, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((ok) => proc.stdout.on("data", (d) => String(d).includes("backend_started") && ok()));
}
async function stopSb() {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
}
async function connect(token, server = "mock") {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${server}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const text = (r) => r.content[0].text;
const health = () => fetch(`${BASE}/healthz`).then((r) => r.json());

before(async () => {
  rmSync(new URL("logs", import.meta.url), { recursive: true, force: true });
  await startSb();
  while (!(await health()).connectors["mock-serial"]?.up) await new Promise((r) => setTimeout(r, 100));
});
after(async () => {
  await stopSb();
  cleanupTestConfigDir();
});

test("mirrors server identity, instructions and tools", async () => {
  const c = await connect("tok-full");
  assert.deepEqual(c.getServerVersion(), { name: "mock", version: "9.9.9" });
  assert.equal(c.getInstructions(), "mock instructions");
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["echo", "slow", "fail", "crash", "env", "pid", "big"]);
  assert.equal(text(await c.callTool({ name: "echo", arguments: { text: "hi" } })), "hi");
  await c.close();
});

test("oversized results are trimmed under the 10 MB HTTP cap, small ones untouched", async () => {
  const c = await connect("tok-full");
  const big = text(await c.callTool({ name: "big", arguments: { ms: 12 } }));
  assert.ok(big.length < 2 * 1024 * 1024 && big.includes("trimmed to fit"));
  const ok = text(await c.callTool({ name: "big", arguments: { ms: 5 } }));
  assert.equal(ok.length, 5 * 1024 * 1024);
});

test("max_result_kb caps an agent's results with a narrow-your-query note; other agents and small results untouched", async () => {
  const c = await connect("tok-capped");
  const r = text(await c.callTool({ name: "big", arguments: { ms: 0.1 } }));
  assert.ok(r.startsWith("x".repeat(32 * 1024)) && !r.startsWith("x".repeat(32 * 1024 + 1)));
  assert.match(r, /result was 102 KB; showing the first 32 KB/);
  assert.equal(text(await c.callTool({ name: "echo", arguments: { text: "small" } })), "small");
  const full = await connect("tok-full");
  assert.equal(text(await full.callTool({ name: "big", arguments: { ms: 0.1 } })).length, 104857);
});

test("compact: true reshapes JSON results end to end; other agents get the raw text", async () => {
  const c = await connect("tok-compact");
  const raw = JSON.stringify({ rows: [{ a: 1, b: null }, { a: 2, b: null }] }, null, 2);
  assert.equal(text(await c.callTool({ name: "echo", arguments: { text: raw } })), "a\n1\n2");
  const full = await connect("tok-full");
  assert.equal(text(await full.callTool({ name: "echo", arguments: { text: raw } })), raw);
});

test("tool errors pass through as isError results", async () => {
  const c = await connect("tok-full");
  const r = await c.callTool({ name: "fail", arguments: {} });
  assert.equal(r.isError, true);
  assert.equal(text(r), "boom");
});

test("child env = safe keys + connector env, cwd = HOME", async () => {
  const c = await connect("tok-full");
  const e = JSON.parse(text(await c.callTool({ name: "env", arguments: {} })));
  assert.equal(e.MOCK_SECRET, "s3cret");
  assert.equal(e.cwd, process.env.HOME);
  const allowed = new Set(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "TEMP", "TMP", "LOGNAME", "MOCK_SECRET"]);
  assert.deepEqual(e.keys.filter((k) => !allowed.has(k) && !k.startsWith("XDG_") && k !== "__CF_USER_TEXT_ENCODING"), []);
});

test("one shared child serves every agent and every request", async () => {
  const [a, b] = [await connect("tok-full"), await connect("tok-full")];
  const pids = await Promise.all([a, b, a, b].map((c) => c.callTool({ name: "pid", arguments: {} }).then(text)));
  assert.equal(new Set(pids).size, 1);
});

test("concurrent calls run in parallel on normal connectors", async () => {
  const c = await connect("tok-full");
  const t0 = Date.now();
  const rs = await Promise.all([1, 2, 3, 4].map((i) => c.callTool({ name: "slow", arguments: { ms: 600, text: i } })));
  assert.deepEqual(rs.map(text), [1, 2, 3, 4].map((i) => `slow done ${i}`));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
});

test("serialize:true connectors run calls one at a time", async () => {
  const c = await connect("tok-full", "mock-serial");
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map(() => c.callTool({ name: "slow", arguments: { ms: 400 } })));
  assert.ok(Date.now() - t0 >= 1150, `took ${Date.now() - t0}ms`);
});

test("progress notifications reach the caller", async () => {
  const c = await connect("tok-full");
  const seen = [];
  await c.callTool({ name: "slow", arguments: { ms: 300 } }, undefined, { onprogress: (p) => seen.push(p.progress) });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test("cancelling a call cancels it on the connector", async () => {
  const c = await connect("tok-full");
  const ac = new AbortController();
  const p = c.callTool({ name: "slow", arguments: { ms: 5000 } }, undefined, { signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  await assert.rejects(p);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await health()).connectors.mock.inflight, 0);
});

test("auth: bad, missing and revoked tokens are refused", async () => {
  for (const tok of ["nope", "", "tok-revoked"]) {
    await assert.rejects(connect(tok), /401|invalid/i);
  }
});

test("grants: limited agent sees and calls only granted tools and servers", async () => {
  const c = await connect("tok-limited");
  assert.deepEqual((await c.listTools()).tools.map((t) => t.name), ["echo", "slow"]);
  assert.equal(text(await c.callTool({ name: "echo", arguments: { text: "x" } })), "x");
  const denied = await c.callTool({ name: "env", arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /not granted/);
  await assert.rejects(connect("tok-limited", "mock-serial"), /403|access/i);
});

test("a crashed connector restarts itself and the next call works", async () => {
  const c = await connect("tok-full");
  const pid1 = text(await c.callTool({ name: "pid", arguments: {} }));
  await c.callTool({ name: "crash", arguments: {} }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const pid2 = text(await c.callTool({ name: "pid", arguments: {} }));
  assert.notEqual(pid1, pid2);
});

test("an existing client keeps working across a Switchboard restart", async () => {
  const c = await connect("tok-full");
  assert.equal(text(await c.callTool({ name: "echo", arguments: { text: "before" } })), "before");
  await stopSb();
  await startSb();
  assert.equal(text(await c.callTool({ name: "echo", arguments: { text: "after" } })), "after");
});

test("combined /mcp: one URL, <connector>__<tool> names, same grants", async () => {
  const full = new Client({ name: "test", version: "1" });
  await full.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: "Bearer tok-full" } } }));
  const names = (await full.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("mock__echo") && names.includes("mock-serial__echo"));
  assert.equal(text(await full.callTool({ name: "mock__echo", arguments: { text: "combo" } })), "combo");
  assert.equal((await full.callTool({ name: "nope__echo", arguments: {} })).isError, true);
  const lim = new Client({ name: "test", version: "1" });
  await lim.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: "Bearer tok-limited" } } }));
  assert.deepEqual((await lim.listTools()).tools.map((t) => t.name), ["mock__echo", "mock__slow"]);
  const denied = await lim.callTool({ name: "mock__env", arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /not granted/);
  assert.equal((await lim.callTool({ name: "mock-serial__echo", arguments: { text: "x" } })).isError, true);
  const bad = new Client({ name: "test", version: "1" });
  await assert.rejects(bad.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: "Bearer nope" } } })), /401|invalid/i);
  await full.close(); await lim.close();
});

test("REST: list, call, deny, bad key, openapi, x-api-key, empty body", async () => {
  const H = (tok) => ({ Authorization: `Bearer ${tok}`, "content-type": "application/json" });
  const tools = await fetch(`${BASE}/api/tools`, { headers: H("tok-limited") }).then((r) => r.json());
  assert.deepEqual(tools.tools.map((t) => `${t.connector}/${t.name}`), ["mock/echo", "mock/slow"]);
  const r = await fetch(`${BASE}/api/call/mock/echo`, { method: "POST", headers: H("tok-limited"), body: JSON.stringify({ text: "rest-hi" }) }).then((r) => r.json());
  assert.deepEqual([r.ok, r.text], [true, "rest-hi"]);
  const viaKey = await fetch(`${BASE}/api/call/mock/echo`, { method: "POST", headers: { "x-api-key": "tok-limited" }, body: JSON.stringify({ text: "k" }) }).then((r) => r.json());
  assert.equal(viaKey.text, "k");
  const empty = await fetch(`${BASE}/api/call/mock/slow`, { method: "POST", headers: H("tok-limited") });
  assert.equal(empty.status, 200);
  assert.equal((await fetch(`${BASE}/api/call/mock/env`, { method: "POST", headers: H("tok-limited"), body: "{}" })).status, 403);
  assert.equal((await fetch(`${BASE}/api/call/mock-serial/echo`, { method: "POST", headers: H("tok-limited"), body: "{}" })).status, 403);
  assert.equal((await fetch(`${BASE}/api/tools`, { headers: H("nope") })).status, 401);
  const err = await fetch(`${BASE}/api/call/mock/fail`, { method: "POST", headers: H("tok-full"), body: "{}" }).then((r) => r.json());
  assert.deepEqual([err.ok, err.text], [false, "boom"]);
  const spec = await fetch(`${BASE}/api/openapi.json`, { headers: H("tok-limited") }).then((r) => r.json());
  assert.deepEqual(Object.keys(spec.paths), ["/api/call/mock/echo", "/api/call/mock/slow"]);
  assert.equal((await fetch(`${BASE}/healthz`, { headers: { "cf-connecting-ip": "1.2.3.4" } })).status, 404);
});

test("non-tool MCP methods need an unrestricted grant; logging/setLevel is never forwarded", async () => {
  const lim = await connect("tok-limited");
  assert.deepEqual((await lim.request({ method: "resources/list", params: {} }, ResultSchema)).resources, []);
  assert.deepEqual((await lim.request({ method: "prompts/list", params: {} }, ResultSchema)).prompts, []);
  for (const method of ["resources/read", "prompts/get", "completion/complete"]) {
    await assert.rejects(lim.request({ method, params: {} }, ResultSchema), /unrestricted grant/, method);
  }
  const full = await connect("tok-full");
  // Forwarded for an unrestricted agent: the mock has no handler, so the connector says "Method not found".
  await assert.rejects(full.request({ method: "resources/list", params: {} }, ResultSchema), /method not found/i);
  await full.request({ method: "logging/setLevel", params: { level: "debug" } }, ResultSchema); // swallowed, not forwarded
  await lim.close();
  await full.close();
});

test("audit log records calls with arg sizes, not values", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("logs/", import.meta.url);
  const f = readdirSync(dir).find((x) => x.startsWith("audit-"));
  const lines = readFileSync(new URL(f, dir), "utf8").trim().split("\n").map(JSON.parse);
  const echo = lines.find((l) => l.tool === "echo" && l.agent === "full");
  assert.deepEqual(echo.args, { text: 2 });
  assert.ok(lines.some((l) => l.denied && l.agent === "limited"));
  assert.ok(!JSON.stringify(lines).includes("before"));
});
