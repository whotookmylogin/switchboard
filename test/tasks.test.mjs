// Built-in `tasks` connector tests. The Hermes bridge is replaced by test/mock-kanban-bridge.mjs
// (SB_KANBAN_CMD), so these cover Switchboard's part: identity, grants, routing, error mapping.
// Run: node --test test/tasks.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Port 0 -> the OS picks a free port; the real one arrives in the "listening" event line.
let BASE = "";
const MOCK = new URL("mock-kanban-bridge.mjs", import.meta.url).pathname;
const ENV = {
  ...process.env,
  SB_CONFIG_DIR: new URL("config", import.meta.url).pathname,
  SB_LOG_DIR: new URL("logs-tasks", import.meta.url).pathname,
  SB_DATA_DIR: new URL("data-tasks", import.meta.url).pathname,
  SB_LISTEN: "127.0.0.1:0",
  SB_TASKS_BACKEND: "hermes",
  SB_KANBAN_CMD: JSON.stringify(["node", MOCK]),
};
let proc;

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
  for (const d of ["logs-tasks", "data-tasks"]) rmSync(new URL(d, import.meta.url), { recursive: true, force: true });
  proc = spawn("node", [new URL("../src/index.js", import.meta.url).pathname], { env: ENV, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) =>
    proc.stdout.on("data", (d) => {
      const m = /"addr":"[\d.]+:(\d+)"/.exec(String(d));
      if (m) BASE = `http://127.0.0.1:${m[1]}`;
      if (String(d).includes('"event":"listening"') && BASE) ok();
    })
  );
});

after(async () => {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
  for (const d of ["logs-tasks", "data-tasks"]) rmSync(new URL(d, import.meta.url), { recursive: true, force: true });
});

test("lists the shared task tools", async () => {
  const c = await connect("tok-full");
  const { tools } = await c.listTools();
  await c.close();
  for (const n of ["active", "find", "start", "claim", "heartbeat", "complete", "release"]) assert.ok(tools.some((t) => t.name === n), n);
});

test("caller identity comes from the token, not the arguments", async () => {
  const c = await connect("tok-full");
  const r = struct(await c.callTool({ name: "start", arguments: { board: "demo", title: "x", agent: "someone-else" } }));
  await c.close();
  assert.equal(r.agent, "full");
  assert.equal(r.op, "start");
});

test("bridge errors come back as tool errors", async () => {
  const c = await connect("tok-full");
  const r = await c.callTool({ name: "claim", arguments: { id: "t_taken" } });
  await c.close();
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /claimed_by=switchboard\/codex/);
});

test("unknown tool is refused", async () => {
  const c = await connect("tok-full");
  const r = await c.callTool({ name: "drop_table", arguments: {} });
  await c.close();
  assert.equal(r.isError, true);
});

test("agents without a tasks grant are refused", async () => {
  const r = await rest("tok-mockonly", "active", {});
  assert.equal(r.status, 403);
});

test("REST and combined /mcp reach the same connector", async () => {
  const r = await rest("tok-full", "active", {});
  assert.equal(r.status, 200);
  const c = await connect("tok-full", "/mcp");
  const { tools } = await c.listTools();
  const res = struct(await c.callTool({ name: "tasks__find", arguments: { query: "label" } }));
  await c.close();
  assert.ok(tools.some((t) => t.name === "tasks__claim"));
  assert.equal(res.op, "find");
  assert.equal(res.agent, "full");
});
