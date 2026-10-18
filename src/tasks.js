// Built-in `tasks` connector: one shared task list for every agent.
//
// Two engines, picked by SB_TASKS_BACKEND:
//   sqlite  (default) — the built-in store in taskstore.js, at SB_TASKS_DB or <data dir>/tasks.sqlite
//   hermes            — shell out to tools/kanban_bridge.py, which talks to hermes_cli.kanban_db
//                       (SB_KANBAN_CMD overrides the command for tests)
// Switchboard supplies the caller identity from the bearer token; claims are recorded as
// "switchboard/<agent>".
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "./taskstore.js";

const HERMES_DIR = process.env.SB_HERMES_DIR || join(homedir(), ".hermes", "hermes-agent");
const BRIDGE = fileURLToPath(new URL("../tools/kanban_bridge.py", import.meta.url));
const CALL_TIMEOUT_MS = 45_000;

/** Command used to run the bridge; SB_KANBAN_CMD (JSON array) overrides it for tests. */
function bridgeCommand() {
  if (process.env.SB_KANBAN_CMD) return JSON.parse(process.env.SB_KANBAN_CMD);
  return [join(HERMES_DIR, "venv", "bin", "python"), BRIDGE];
}

const err = (text) => ({ content: [{ type: "text", text: `Switchboard: ${text}` }], isError: true });
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj });

const id = { type: "string", description: "Task id, e.g. t_1a2b3c4d" };
const board = { type: "string", description: "Board slug (see boards). Optional when id is given." };
const ttl = { type: "number", description: "Claim length in minutes (default 60, max 480)" };

export const TOOLS = [
  { name: "boards", description: "List task boards (one per business/project).", inputSchema: { type: "object", properties: {} } },
  { name: "active", description: "What every agent is working on right now (claimed tasks), plus tasks waiting in review/blocked, across all boards. Check this before starting work.", inputSchema: { type: "object", properties: {} } },
  {
    name: "list",
    description: "List tasks. Defaults to open tasks on all boards. mine=true lists tasks assigned to you.",
    inputSchema: { type: "object", properties: { board, status: { type: "string", enum: ["triage", "todo", "ready", "running", "review", "blocked", "scheduled", "done", "archived"] }, assignee: { type: "string" }, mine: { type: "boolean" }, limit: { type: "number" } } },
  },
  { name: "find", description: "Search open tasks (title, body, result) across all boards. Use before creating or starting work to avoid duplicates.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, include_done: { type: "boolean" } } } },
  { name: "show", description: "One task with its comments and recent events.", inputSchema: { type: "object", required: ["id"], properties: { id, board } } },
  {
    name: "create",
    description: "Create a task. assignee = one of the configured lanes — agents that pull their own work (default claude, codex, human; SB_TASK_LANES replaces that list). Leave assignee empty to send the task to triage for a human or dispatcher to route. Unknown names are rejected. Use idempotency_key to make retries safe.",
    inputSchema: { type: "object", required: ["board", "title"], properties: { board, title: { type: "string" }, body: { type: "string", description: "Markdown: goal, context, definition of done" }, assignee: { type: "string" }, priority: { type: "number" }, parents: { type: "array", items: { type: "string" } }, branch: { type: "string" }, idempotency_key: { type: "string" } } },
  },
  { name: "start", description: "Declare work you are starting now that isn't on the board yet: creates a task assigned to you and claims it in one step.", inputSchema: { type: "object", required: ["board", "title"], properties: { board, title: { type: "string" }, body: { type: "string" }, branch: { type: "string" }, idempotency_key: { type: "string" }, ttl_minutes: ttl } } },
  { name: "claim", description: "Atomically claim a ready task so nobody else works on it. Fails if someone else holds it.", inputSchema: { type: "object", required: ["id"], properties: { id, board, ttl_minutes: ttl } } },
  { name: "heartbeat", description: "Extend your claim; optional progress note is added as a comment.", inputSchema: { type: "object", required: ["id"], properties: { id, board, ttl_minutes: ttl, note: { type: "string" } } } },
  { name: "comment", description: "Add a comment to a task (questions, findings, handoff notes).", inputSchema: { type: "object", required: ["id", "body"], properties: { id, board, body: { type: "string" } } } },
  { name: "complete", description: "Mark your task done. result must say what you did and where (branch, PR, files, links) so others can build on it.", inputSchema: { type: "object", required: ["id", "result"], properties: { id, board, result: { type: "string" }, summary: { type: "string" }, metadata: { type: "object" } } } },
  { name: "release", description: "Give up your claim (task goes back to ready for someone else). Say why.", inputSchema: { type: "object", required: ["id", "reason"], properties: { id, board, reason: { type: "string" } } } },
  { name: "block", description: "Park a task you hold as blocked for a human when you cannot finish it: say exactly what is needed to unblock it.", inputSchema: { type: "object", required: ["id", "reason"], properties: { id, board, reason: { type: "string" }, kind: { type: "string", enum: ["needs_input", "dependency", "capability", "transient"] } } } },
  { name: "edit", description: "Edit an open task's title, body, priority or assignee. append_body adds a paragraph (e.g. a status note or a marker) without rewriting the body. Setting assignee routes the task to that lane (validated like create's assignee); on a triage task this moves it to ready, or todo while its parents are still open.", inputSchema: { type: "object", required: ["id"], properties: { id, board, title: { type: "string" }, body: { type: "string" }, append_body: { type: "string" }, priority: { type: "number" }, assignee: { type: "string" } } } },
  { name: "park", description: "Park a task in the icebox (status scheduled): nobody, including dispatchers and lane runners, picks it up until unpark. Say why; optional until date (YYYY-MM-DD) for when to look again.", inputSchema: { type: "object", required: ["id", "reason"], properties: { id, board, reason: { type: "string" }, until: { type: "string" } } } },
  { name: "unpark", description: "Bring a parked (or blocked) task back into play.", inputSchema: { type: "object", required: ["id"], properties: { id, board, reason: { type: "string" } } } },
];
const OPS = new Set(TOOLS.map((t) => t.name));

/**
 * Run one bridge op.
 * @param {string} op
 * @param {string} agent
 * @param {object} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
export function runBridge(op, agent, args, signal) {
  const [cmd, ...cmdArgs] = bridgeCommand();
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: HERMES_DIR,
      env: { ...process.env, PYTHONPATH: HERMES_DIR },
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let out = "";
    let errText = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CALL_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errText = (errText + d).slice(-2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `bridge failed to start: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ ok: false, error: `bridge exited ${code}: ${errText.trim().split("\n").pop() || "no output"}` });
      }
    });
    child.stdin.end(JSON.stringify({ op, agent, args }));
  });
}

export class TasksBackend {
  /** @param {string} [dataDir] - directory for the default sqlite store (SB_TASKS_DB overrides) */
  constructor(dataDir) {
    this.name = "tasks";
    this.conn = { name: "tasks", builtin: true };
    this.client = true; // no long-lived child to crash; the sqlite store is in-process, the bridge is per-call
    this.pid = null;
    this.restarts = 0;
    this.inflight = 0;
    this.startedAt = new Date();
    this.engine = process.env.SB_TASKS_BACKEND || "sqlite";
    if (this.engine === "sqlite") {
      this.store = new TaskStore(process.env.SB_TASKS_DB || join(dataDir || ".", "tasks.sqlite"));
    } else if (this.engine !== "hermes") {
      throw new Error(`unknown SB_TASKS_BACKEND '${this.engine}' (expected "sqlite" or "hermes")`);
    }
  }

  async start() {}
  async stop() {
    this.store?.close();
  }

  info() {
    return {
      serverInfo: { name: "switchboard-tasks", version: "1" },
      capabilities: { tools: {} },
      instructions:
        "Shared task list for every agent on this Switchboard. Protocol: before starting work call active and find so you don't duplicate someone; " +
          "claim (or start) a task before working on it; heartbeat on long jobs; complete with what you did and where (branch, PR, files, links); " +
          "release if you stop before finishing. Tasks assigned to your agent name are yours to pull; a task assigned to human is for the operator to decide. " +
          "Use park for ideas that are not for now, and block when you cannot finish and need a person to unblock you.",
    };
  }

  /**
   * @param {{method: string, params?: object}} req
   * @param {{agent?: string, signal?: AbortSignal}} [opts] - opts.agent is set by Switchboard from the token
   */
  async request(req, opts = {}) {
    if (req.method === "tools/list") return { tools: TOOLS };
    if (req.method !== "tools/call") return err(`unsupported method ${req.method}`);
    const agent = opts.agent;
    if (!agent) return err("internal error: no caller identity for tasks connector");
    const op = String(req.params?.name || "");
    if (!OPS.has(op)) return err(`unknown tool ${op}`);
    this.inflight++;
    try {
      const r = this.engine === "sqlite" ? this.store.call(op, agent, req.params?.arguments ?? {}) : await runBridge(op, agent, req.params?.arguments ?? {}, opts.signal);
      return r.ok ? ok(r.data) : err(r.error || "unknown error");
    } finally {
      this.inflight--;
    }
  }
}
