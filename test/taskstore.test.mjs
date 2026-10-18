// Unit tests for the built-in SQLite task store (src/taskstore.js) — no server needed.
// Run: node --test test/taskstore.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { TaskStore } from "../src/taskstore.js";

const DIR = new URL("tmp-taskstore", import.meta.url).pathname;
let store;
const call = (op, agent, args = {}) => store.call(op, agent, args);
const must = (op, agent, args = {}) => {
  const r = call(op, agent, args);
  assert.equal(r.ok, true, `${op}: ${r.error}`);
  return r.data;
};

before(() => {
  rmSync(DIR, { recursive: true, force: true });
  store = new TaskStore(join(DIR, "tasks.sqlite"));
});

after(() => {
  store.close();
  rmSync(DIR, { recursive: true, force: true });
});

test("seeds a default board; board-add creates more", () => {
  const { boards } = must("boards", "cli");
  assert.ok(boards.some((b) => b.slug === "default"));
  store.addBoard("research", "Research");
  assert.ok(must("boards", "cli").boards.some((b) => b.slug === "research" && b.name === "Research"));
});

test("create -> claim -> complete happy path", () => {
  const { task } = must("create", "alice", { board: "default", title: "write the thing", assignee: "claude", body: "details" });
  assert.match(task.id, /^t_[0-9a-f]{8}$/);
  assert.equal(task.status, "ready");
  assert.equal(task.assignee, "claude");

  const claimed = must("claim", "claude", { id: task.id, board: "default" });
  assert.equal(claimed.task.status, "running");
  assert.equal(claimed.task.claimed_by, "switchboard/claude");
  assert.ok(claimed.task.claim_expires);

  const done = must("complete", "claude", { id: task.id, result: "wrote it in /tmp/x" });
  assert.equal(done.task.status, "done");
  assert.ok(must("show", "alice", { id: task.id }).task.completed_at);
});

test("empty assignee goes to triage", () => {
  const { task } = must("create", "alice", { board: "default", title: "unrouted idea" });
  assert.equal(task.status, "triage");
  assert.equal(task.assignee, null);
});

test("claim conflict between two agents names the holder", () => {
  const { task } = must("create", "alice", { board: "default", title: "contested work", assignee: "codex" });
  must("claim", "codex", { id: task.id });
  const r = call("claim", "claude", { id: task.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /claimed_by=switchboard\/codex/);
  assert.match(r.error, /until /);
});

test("claiming a non-ready task fails clearly", () => {
  const { task } = must("create", "alice", { board: "default", title: "triage item" });
  const r = call("claim", "claude", { id: task.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be 'ready'/);
});

test("expired claim returns the task to ready (lazy sweep)", () => {
  const { task } = must("create", "alice", { board: "default", title: "expiry candidate", assignee: "claude" });
  must("claim", "claude", { id: task.id, ttl_minutes: 5 });
  store.db.prepare("UPDATE tasks SET claim_expires = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 1, task.id);
  const shown = must("show", "bob", { id: task.id });
  assert.equal(shown.task.status, "ready");
  assert.equal(shown.task.claimed_by, null);
  assert.ok(shown.recent_events.some((e) => e.kind === "claim_expired"));
});

test("only the claim holder may complete, heartbeat, release or block", () => {
  const { task } = must("create", "alice", { board: "default", title: "mine only", assignee: "claude" });
  must("claim", "claude", { id: task.id });
  for (const [op, args] of [
    ["complete", { id: task.id, result: "nope" }],
    ["heartbeat", { id: task.id }],
    ["release", { id: task.id, reason: "nope" }],
    ["block", { id: task.id, reason: "nope" }],
  ]) {
    const r = call(op, "codex", args);
    assert.equal(r.ok, false, op);
    assert.match(r.error, /don't hold its claim/);
  }
});

test("idempotency_key returns the existing task instead of a duplicate", () => {
  const a = must("create", "alice", { board: "default", title: "once only", idempotency_key: "k-1" }).task;
  const b = must("create", "alice", { board: "default", title: "once only (retry)", idempotency_key: "k-1" }).task;
  assert.equal(a.id, b.id);
  const { total } = must("list", "alice", { status: "triage" });
  assert.ok(total >= 1);
});

test("parents gate a task until every parent is done", () => {
  const parent = must("create", "alice", { board: "default", title: "parent", assignee: "claude" }).task;
  const child = must("create", "alice", { board: "default", title: "child", assignee: "claude", parents: [parent.id] }).task;
  assert.equal(child.status, "todo");
  const r = call("claim", "claude", { id: child.id });
  assert.equal(r.ok, false);
  must("claim", "claude", { id: parent.id });
  must("complete", "claude", { id: parent.id, result: "done" });
  assert.equal(must("show", "alice", { id: child.id }).task.status, "ready");
  must("claim", "claude", { id: child.id });
});

test("find searches title/body/result case-insensitively, excluding done", () => {
  must("create", "alice", { board: "default", title: "Zebra-striped labels", assignee: "claude" });
  const { matches } = must("find", "alice", { query: "zebra" });
  assert.ok(matches.some((t) => t.title === "Zebra-striped labels"));
  const doneTask = must("create", "alice", { board: "default", title: "quokka finished work", assignee: "claude" }).task;
  must("claim", "claude", { id: doneTask.id });
  must("complete", "claude", { id: doneTask.id, result: "shipped" });
  assert.ok(!must("find", "alice", { query: "quokka" }).matches.length);
  assert.ok(must("find", "alice", { query: "quokka", include_done: true }).matches.length);
});

test("active reports working_now and waiting", () => {
  const held = must("create", "alice", { board: "default", title: "in flight now", assignee: "codex" }).task;
  must("claim", "codex", { id: held.id });
  const parked = must("create", "alice", { board: "default", title: "stuck thing", assignee: "claude" }).task;
  must("claim", "claude", { id: parked.id });
  must("block", "claude", { id: parked.id, reason: "needs an api key", kind: "needs_input" });
  const a = must("active", "alice");
  assert.ok(a.working_now.some((t) => t.id === held.id));
  assert.equal(a.waiting.by_board["default/blocked"], 1);
  assert.ok(a.waiting.newest.some((t) => t.id === parked.id));
});

test("park/unpark round-trips a task through scheduled", () => {
  const { task } = must("create", "alice", { board: "default", title: "later idea", assignee: "claude" });
  const parked = must("park", "alice", { id: task.id, reason: "not this quarter", until: "2027-01-01" });
  assert.equal(parked.task.status, "scheduled");
  assert.ok(!must("list", "alice", { status: "ready" }).tasks.some((t) => t.id === task.id));
  const back = must("unpark", "alice", { id: task.id, reason: "now is the time" });
  assert.equal(back.task.status, "ready");
});

test("unknown lane is rejected; start creates + claims for the caller", () => {
  const bad = call("create", "alice", { board: "default", title: "nope", assignee: "nobody" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown assignee/);
  const { task } = must("start", "claude", { board: "default", title: "ad-hoc work" });
  assert.equal(task.status, "running");
  assert.equal(task.assignee, "claude");
  assert.equal(task.claimed_by, "switchboard/claude");
});

test("heartbeat extends the claim and notes become comments", () => {
  const { task } = must("create", "alice", { board: "default", title: "long job", assignee: "claude" });
  const before = must("claim", "claude", { id: task.id, ttl_minutes: 5 }).task.claim_expires;
  const after_ = must("heartbeat", "claude", { id: task.id, ttl_minutes: 480, note: "halfway" }).task.claim_expires;
  assert.ok(after_ > before);
  const shown = must("show", "alice", { id: task.id });
  assert.ok(shown.comments.some((c) => c.body.includes("[progress] halfway")));
});

test("complete only from running (held) — a ready task cannot be completed by anyone", () => {
  const { task } = must("create", "alice", { board: "default", title: "premature done", assignee: "claude" });
  assert.equal(task.status, "ready");
  for (const who of ["codex", "claude"]) {
    const r = call("complete", who, { id: task.id, result: "done early" });
    assert.equal(r.ok, false, who);
    assert.match(r.error, /status=ready/);
  }
  must("claim", "claude", { id: task.id });
  const r = call("complete", "codex", { id: task.id, result: "not yours" });
  assert.equal(r.ok, false);
  assert.match(r.error, /don't hold its claim/);
  must("complete", "claude", { id: task.id, result: "legit" });
});

test("a todo child cannot be completed while its parents are open", () => {
  const parent = must("create", "alice", { board: "default", title: "blocker", assignee: "claude" }).task;
  const child = must("create", "alice", { board: "default", title: "gated", assignee: "claude", parents: [parent.id] }).task;
  assert.equal(child.status, "todo");
  const r = call("complete", "claude", { id: child.id, result: "skipped the queue" });
  assert.equal(r.ok, false);
  assert.match(r.error, /status=todo/);
});

test("park/unpark of a gated child comes back todo, then unblocks to ready", () => {
  const parent = must("create", "alice", { board: "default", title: "gate parent", assignee: "claude" }).task;
  const child = must("create", "alice", { board: "default", title: "gate child", assignee: "claude", parents: [parent.id] }).task;
  assert.equal(child.status, "todo");
  must("park", "alice", { id: child.id, reason: "icebox for now" });
  const back = must("unpark", "alice", { id: child.id });
  assert.equal(back.task.status, "todo"); // still gated: parent not done
  must("claim", "claude", { id: parent.id });
  must("complete", "claude", { id: parent.id, result: "unblocked it" });
  assert.equal(must("show", "alice", { id: child.id }).task.status, "ready");
});

test("blank idempotency_key is treated as absent", () => {
  for (const key of ["", "   ", "\t\n"]) {
    const { task } = must("create", "alice", { board: "default", title: `blank key ${JSON.stringify(key)}`, idempotency_key: key });
    assert.ok(task.id);
  }
  const { total } = must("list", "alice", { status: "triage" });
  assert.ok(total >= 3); // three distinct tasks: no dedupe, no UNIQUE collision
});

test("edit assignee routes a triage task to ready, or todo while parents are open", () => {
  const tri = must("create", "alice", { board: "default", title: "route me" }).task;
  assert.equal(tri.status, "triage");
  const bad = call("edit", "alice", { id: tri.id, assignee: "nobody" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown assignee/);
  const routed = must("edit", "alice", { id: tri.id, assignee: "claude" }).task;
  assert.equal(routed.assignee, "claude");
  assert.equal(routed.status, "ready");

  const parent = must("create", "alice", { board: "default", title: "routing gate", assignee: "claude" }).task;
  const gated = must("create", "alice", { board: "default", title: "gated triage", parents: [parent.id] }).task;
  assert.equal(gated.status, "triage");
  const g = must("edit", "alice", { id: gated.id, assignee: "codex" }).task;
  assert.equal(g.assignee, "codex");
  assert.equal(g.status, "todo");
});

test("SB_TASK_LANES replaces the default lane list", () => {
  const prev = process.env.SB_TASK_LANES;
  process.env.SB_TASK_LANES = "zoe, max";
  try {
    const bad = call("create", "alice", { board: "default", title: "old lane", assignee: "claude" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /unknown assignee 'claude'/);
    const { task } = must("create", "alice", { board: "default", title: "new lane", assignee: "zoe" });
    assert.equal(task.assignee, "zoe");
  } finally {
    if (prev === undefined) delete process.env.SB_TASK_LANES;
    else process.env.SB_TASK_LANES = prev;
  }
  must("create", "alice", { board: "default", title: "defaults back", assignee: "claude" });
});

test("ttl_minutes 0 or invalid falls back to the 60-minute default (bridge parity)", () => {
  const before = Math.floor(Date.now() / 1000);
  for (const ttl of [0, "soon", undefined]) {
    const { task } = must("create", "alice", { board: "default", title: `ttl ${JSON.stringify(ttl)}`, assignee: "claude" });
    const expires = Date.parse(must("claim", "claude", { id: task.id, ttl_minutes: ttl }).task.claim_expires) / 1000;
    assert.ok(expires - before >= 3500 && expires - before <= 3700, `ttl=${ttl}: ${expires - before}s`);
    must("release", "claude", { id: task.id, reason: "done checking ttl" });
  }
});
