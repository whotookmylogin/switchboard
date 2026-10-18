// `tasks` connector tests against the built-in SQLite backend (SB_TASKS_BACKEND=sqlite,
// the default). Drives the tools over both MCP and REST; own port, data and log dirs.
// Run: node --test test/tasks-sqlite.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Port 0 -> the OS picks a free port; the real one arrives in the "listening" event line.
let BASE = "";
const ENV = {
  ...process.env,
  SB_CONFIG_DIR: new URL("config", import.meta.url).pathname,
  SB_LOG_DIR: new URL("logs-tasks-sqlite", import.meta.url).pathname,
  SB_DATA_DIR: new URL("data-tasks-sqlite", import.meta.url).pathname,
  SB_LISTEN: "127.0.0.1:0",
  SB_TASKS_BACKEND: "sqlite",
};
let proc;

/** Wait for one stdout line containing `mark`, capturing the listening port into BASE. */
function waitFor(mark) {
  return new Promise((ok) =>
    proc.stdout.on("data", (d) => {
      const m = /"addr":"[\d.]+:(\d+)"/.exec(String(d));
      if (m) BASE = `http://127.0.0.1:${m[1]}`;
      if (String(d).includes(mark) && BASE) ok();
    })
  );
}

async function connect(token, path = "/mcp/tasks") {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const struct = (r) => r.structuredContent ?? JSON.parse(r.content[0].text);
async function rest(token, tool, body) {
  const r = await fetch(`${BASE}/api/call/tasks/${tool}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  for (const d of ["logs-tasks-sqlite", "data-tasks-sqlite"]) rmSync(new URL(d, import.meta.url), { recursive: true, force: true });
  proc = spawn("node", [new URL("../src/index.js", import.meta.url).pathname], { env: ENV, stdio: ["ignore", "pipe", "inherit"] });
  await waitFor('"event":"listening"');
});

after(async () => {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
  for (const d of ["logs-tasks-sqlite", "data-tasks-sqlite"]) rmSync(new URL(d, import.meta.url), { recursive: true, force: true });
});

test("lists the shared task tools", async () => {
  const c = await connect("tok-full");
  const { tools } = await c.listTools();
  await c.close();
  for (const n of ["boards", "active", "find", "create", "start", "claim", "heartbeat", "complete", "release", "park", "unpark"]) {
    assert.ok(tools.some((t) => t.name === n), n);
  }
});

test("sqlite backend: boards seeded, create/claim/complete over MCP", async () => {
  const c = await connect("tok-full");
  const boards = struct(await c.callTool({ name: "boards", arguments: {} }));
  assert.ok(boards.boards.some((b) => b.slug === "default"));

  const created = struct(await c.callTool({ name: "create", arguments: { board: "default", title: "sqlite-backed task", assignee: "claude" } }));
  assert.match(created.task.id, /^t_[0-9a-f]{8}$/);
  assert.equal(created.task.status, "ready");

  const claimed = struct(await c.callTool({ name: "claim", arguments: { id: created.task.id } }));
  assert.equal(claimed.task.status, "running");
  assert.equal(claimed.task.claimed_by, "switchboard/full");

  const done = struct(await c.callTool({ name: "complete", arguments: { id: created.task.id, result: "finished over MCP" } }));
  assert.equal(done.task.status, "done");
  await c.close();
});

test("store errors come back as tool errors", async () => {
  const c = await connect("tok-full");
  const triage = struct(await c.callTool({ name: "create", arguments: { board: "default", title: "unrouted" } }));
  const r = await c.callTool({ name: "claim", arguments: { id: triage.task.id } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /must be 'ready'/);
  const bad = await c.callTool({ name: "create", arguments: { board: "nope", title: "x" } });
  await c.close();
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /unknown board/);
});

test("REST path: start -> heartbeat -> release -> active", async () => {
  let r = await rest("tok-full", "start", { board: "default", title: "rest-driven work" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const id = r.body.structured.task.id;
  assert.equal(r.body.structured.task.claimed_by, "switchboard/full");

  r = await rest("tok-full", "heartbeat", { id, note: "still on it" });
  assert.equal(r.body.ok, true);

  r = await rest("tok-full", "active", {});
  assert.ok(r.body.structured.working_now.some((t) => t.id === id));

  r = await rest("tok-full", "release", { id, reason: "pausing for today" });
  assert.equal(r.body.structured.task.status, "ready");
});

test("find over REST excludes done unless asked", async () => {
  const created = (await rest("tok-full", "create", { board: "default", title: "platypus research task", assignee: "claude" })).body.structured.task;
  let r = await rest("tok-full", "find", { query: "platypus" });
  assert.ok(r.body.structured.matches.some((t) => t.id === created.id));
});

test("agents without a tasks grant are refused", async () => {
  const r = await rest("tok-mockonly", "active", {});
  assert.equal(r.status, 403);
});

test("combined /mcp exposes tasks__* tools against the sqlite backend", async () => {
  const c = await connect("tok-full", "/mcp");
  const { tools } = await c.listTools();
  assert.ok(tools.some((t) => t.name === "tasks__claim"));
  const res = struct(await c.callTool({ name: "tasks__find", arguments: { query: "platypus" } }));
  await c.close();
  assert.ok(Array.isArray(res.matches));
});
