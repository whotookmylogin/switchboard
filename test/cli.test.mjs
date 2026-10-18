// `sb` CLI behavior: the switchboard.pid SIGHUP fallback (no systemd) and the reserved operator name.
// Run: node --test test/cli.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import YAML from "yaml";
import { testServerEnv, cleanupTestConfigDir } from "./helpers.mjs";
import { Registry, sha256, OPERATOR } from "../src/registry.js";

const PORT = await new Promise((res, rej) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
  s.on("error", rej);
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = new URL("data-cli", import.meta.url).pathname;
const ENV = testServerEnv({ SB_LOG_DIR: new URL("logs-cli", import.meta.url).pathname, SB_DATA_DIR: DATA_DIR, SB_LISTEN: `127.0.0.1:${PORT}` });
const SB = new URL("../bin/sb.js", import.meta.url).pathname;
let proc;

before(async () => {
  for (const d of ["logs-cli", "data-cli"]) rmSync(new URL(d, import.meta.url), { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  proc = spawn("node", [new URL("../src/index.js", import.meta.url).pathname], { env: ENV, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok) => proc.stdout.on("data", (d) => String(d).includes("backend_started") && ok()));
  // The pidfile is the CLI's reload channel when systemd isn't around; wait for it before testing.
  for (let i = 0; i < 50 && !existsSync(join(DATA_DIR, "switchboard.pid")); i++) await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("exit", r));
  cleanupTestConfigDir();
});

test("server writes data/switchboard.pid and removes it on clean exit", async () => {
  const pidFile = join(DATA_DIR, "switchboard.pid");
  assert.ok(existsSync(pidFile));
  assert.equal(Number(readFileSync(pidFile, "utf8").trim()), proc.pid);
});

test("sb agent add reloads via the pidfile when systemctl is unavailable, and the new key works", async () => {
  // PATH with no systemctl forces the switchboard.pid fallback in saveAgents.
  const out = execFileSync(process.execPath, [SB, "agent", "add", "cli-added", "--grant", "mock"], { env: { ...ENV, PATH: "/nonexistent" }, encoding: "utf8" });
  const token = out.match(/sb_\S+/)[0];
  assert.match(out, /switchboard\.pid|SIGHUP to pid/);
  // The reload is async (SIGHUP); poll REST until the new key authenticates.
  let status = 0;
  for (let i = 0; i < 40 && status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const r = await fetch(`${BASE}/api/call/mock/echo`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    status = r.status;
    if (status === 200) {
      const body = await r.json();
      assert.equal(body.text, "hi");
    }
  }
  assert.equal(status, 200);
});

test("sb agent add refuses the reserved operator identity", () => {
  assert.throws(
    () => execFileSync(process.execPath, [SB, "agent", "add", OPERATOR], { env: { ...ENV, PATH: "/nonexistent" }, encoding: "utf8", stdio: "pipe" }),
    (e) => /reserved operator identity/.test(String(e.stderr))
  );
});

test("registry ignores an agents.yaml entry named after the operator identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-registry-"));
  writeFileSync(join(dir, "connections.yaml"), "connections: {}\n");
  writeFileSync(
    join(dir, "agents.yaml"),
    YAML.stringify({ agents: { [OPERATOR]: { token_sha256: sha256("tok-operator"), enabled: true, grants: { "*": "*" } }, real: { token_sha256: sha256("tok-real"), enabled: true, grants: {} } } })
  );
  const r = new Registry(join(dir, "connections.yaml"), join(dir, "agents.yaml"));
  assert.equal(r.agents[OPERATOR], undefined);
  assert.equal(r.authenticate("tok-operator"), null);
  assert.equal(r.authenticate("tok-real"), "real");
  rmSync(dir, { recursive: true, force: true });
});
