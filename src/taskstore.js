// Built-in SQLite task store: the default engine for the `tasks` connector.
//
// One shared task list for every agent, so nobody duplicates work. It mirrors the JSON shapes and
// semantics of tools/kanban_bridge.py (task_view fields, working_now/waiting, claim TTLs, parent
// dependencies, idempotency keys) without any dependency on Hermes.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const OPEN_STATUSES = ["triage", "todo", "ready", "running", "review", "blocked", "scheduled"];
const ALL_STATUSES = [...OPEN_STATUSES, "done", "archived"];
const BLOCK_KINDS = new Set(["needs_input", "dependency", "capability", "transient"]);
const DEFAULT_TTL_MIN = 60;
const MIN_TTL_MIN = 5;
const MAX_TTL_MIN = 480;

/** Error class whose message is safe to hand back to the caller as a tool error. */
export class StoreError extends Error {}

const now = () => Math.floor(Date.now() / 1000);
const iso = (ts) => (ts ? new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
const newTaskId = () => "t_" + randomBytes(4).toString("hex");
const lockFor = (agent) => `switchboard/${agent}`;

/** Lane names a task may be assigned to: SB_TASK_LANES (comma list), or the built-in defaults when unset. */
function lanes() {
  const raw = process.env.SB_TASK_LANES;
  return new Set(
    String(raw == null ? "claude,codex,human" : raw)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Claim length in seconds from args.ttl_minutes (missing, 0 or invalid -> 60; clamped 5..480). */
function ttlSeconds(args) {
  let minutes = parseInt(args?.ttl_minutes, 10);
  if (!Number.isFinite(minutes) || minutes === 0) minutes = DEFAULT_TTL_MIN;
  return Math.max(MIN_TTL_MIN, Math.min(minutes, MAX_TTL_MIN)) * 60;
}

/** Public view of a task row, matching the bridge's task_view. */
function taskView(t, board, { full = false } = {}) {
  const v = {
    id: t.id,
    board,
    title: t.title,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    created_by: t.created_by,
    created_at: iso(t.created_at),
    claimed_by: t.claim_lock,
    claim_expires: iso(t.claim_expires),
  };
  if (t.branch_name) v.branch = t.branch_name;
  if (full) {
    v.body = t.body;
    v.result = t.result;
    v.started_at = iso(t.started_at);
    v.completed_at = iso(t.completed_at);
    v.workspace_path = t.workspace_path;
    v.block_kind = t.block_kind;
  } else if (t.body) {
    v.body_preview = t.body.slice(0, 200);
  }
  return v;
}

export class TaskStore {
  /** @param {string} path - sqlite file */
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        slug TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        board TEXT NOT NULL REFERENCES boards(slug),
        title TEXT NOT NULL,
        body TEXT,
        status TEXT NOT NULL,
        assignee TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        claim_lock TEXT,
        claim_expires INTEGER,
        branch_name TEXT,
        result TEXT,
        summary TEXT,
        metadata TEXT,
        block_kind TEXT,
        block_reason TEXT,
        scheduled_reason TEXT,
        workspace_path TEXT,
        idempotency_key TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_idem ON tasks(board, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_board_status ON tasks(board, status);
      CREATE TABLE IF NOT EXISTS task_parents (
        task_id TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        PRIMARY KEY (task_id, parent_id)
      );
      CREATE INDEX IF NOT EXISTS task_parents_parent ON task_parents(parent_id);
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS comments_task ON comments(task_id);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        agent TEXT,
        ts INTEGER NOT NULL,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
    `);
    this.db.prepare("INSERT OR IGNORE INTO boards (slug, name, created_at) VALUES ('default', 'Default', ?)").run(now());
  }

  close() {
    this.db.close();
  }

  /**
   * Dispatch one tool op, mirroring the bridge's {ok, data|error} contract.
   * The lazy expiry sweep runs at the start of every call.
   * @param {string} op
   * @param {string} agent
   * @param {object} args
   */
  call(op, agent, args = {}) {
    try {
      agent = String(agent || "").trim();
      if (!agent) throw new StoreError("no caller identity");
      const fn = OPS[op];
      if (!fn) throw new StoreError(`unknown op ${op}`);
      // One write tx per call: the expiry sweep plus the op's update + event + child-unblock
      // commit or roll back together, so a failed op never leaves a half-applied mutation.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this._sweepExpired();
        const data = fn(this, agent, args);
        this.db.exec("COMMIT");
        return { ok: true, data };
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    } catch (e) {
      return { ok: false, error: e instanceof StoreError ? e.message : `${e.name}: ${e.message}` };
    }
  }

  /** An expired claim is a released claim: task back to ready, event records claim_expired. */
  _sweepExpired() {
    const rows = this.db.prepare("SELECT id, claim_lock FROM tasks WHERE status = 'running' AND claim_expires IS NOT NULL AND claim_expires <= ?").all(now());
    const release = this.db.prepare("UPDATE tasks SET status = 'ready', claim_lock = NULL, claim_expires = NULL, started_at = NULL WHERE id = ? AND status = 'running'");
    for (const r of rows) {
      release.run(r.id);
      this._event(r.id, "claim_expired", r.claim_lock, null);
    }
  }

  /** Append one events row for a task mutation. */
  _event(taskId, kind, agent, payload) {
    this.db.prepare("INSERT INTO events (task_id, kind, agent, ts, payload) VALUES (?, ?, ?, ?, ?)").run(taskId, kind, agent ?? null, now(), payload ? JSON.stringify(payload) : null);
  }

  _comment(taskId, author, body) {
    this.db.prepare("INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)").run(taskId, author, body, now());
  }

  _boardSlugs() {
    return this.db.prepare("SELECT slug FROM boards WHERE archived = 0").all().map((r) => r.slug);
  }

  _checkBoard(slug) {
    if (!slug || !this._boardSlugs().includes(slug)) throw new StoreError(`unknown board '${slug}'. Call boards for the list.`);
    return slug;
  }

  /** Create a board (CLI only; not an MCP tool). Returns the row. */
  addBoard(slug, name, description) {
    slug = String(slug || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new StoreError(`bad board slug '${slug}' (lowercase letters, digits, - and _)`);
    this.db.prepare("INSERT OR IGNORE INTO boards (slug, name, description, created_at) VALUES (?, ?, ?, ?)").run(slug, name || null, description || null, now());
    return this.db.prepare("SELECT slug, name, description FROM boards WHERE slug = ?").get(slug);
  }

  _get(board, id) {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ? AND board = ?").get(id, board);
  }

  /** Return [board, task] for args.id, searching every board when args.board is omitted. */
  _locate(args) {
    const id = String(args?.id || "").trim();
    if (!id) throw new StoreError("id is required");
    const boards = args.board ? [this._checkBoard(args.board)] : this._boardSlugs();
    for (const slug of boards) {
      const t = this._get(slug, id);
      if (t) return [slug, t];
    }
    throw new StoreError(`no task ${id}` + (args.board ? ` on board ${args.board}` : ""));
  }

  /** All tasks in the given statuses, optionally filtered by boards/assignee. [[board, task], ...] */
  _allTasks(statuses, boards = null, assignee = null) {
    const slugs = boards || this._boardSlugs();
    if (!slugs.length || !statuses.length) return [];
    const marks = statuses.map(() => "?").join(",");
    const out = [];
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE board = ? AND status IN (${marks})` + (assignee ? " AND assignee = ?" : ""));
    for (const slug of slugs) for (const t of stmt.all(slug, ...statuses, ...(assignee ? [assignee] : []))) out.push([slug, t]);
    return out;
  }

  /** Create + insert a task row; returns [board, task]. Honors idempotency_key and parents. */
  _create(agent, args, assignee, { triage = false } = {}) {
    const board = this._checkBoard(args?.board || "");
    const title = String(args?.title || "").trim();
    if (!title) throw new StoreError("title is required");
    const key = args?.idempotency_key != null ? String(args.idempotency_key).trim() || null : null;
    if (key) {
      const existing = this.db.prepare("SELECT * FROM tasks WHERE board = ? AND idempotency_key = ?").get(board, key);
      if (existing) return [board, existing];
    }
    const parents = Array.isArray(args?.parents) ? args.parents : [];
    for (const p of parents) if (!this._get(board, p)) throw new StoreError(`unknown parent task '${p}' on board '${board}'`);
    let status = triage ? "triage" : "ready";
    if (!triage && parents.length) {
      const open = parents.filter((p) => this._get(board, p).status !== "done");
      if (open.length) status = "todo";
    }
    const insTask = this.db.prepare(
      `INSERT INTO tasks (id, board, title, body, status, assignee, priority, created_by, created_at, branch_name, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let id = null;
    for (let attempt = 0; attempt < 3 && !id; attempt++) {
      const candidate = newTaskId();
      try {
        insTask.run(candidate, board, title.slice(0, 300), args?.body != null ? String(args.body).slice(0, 20000) : null, status, assignee, Number.isFinite(+args?.priority) ? Math.trunc(+args.priority) : 0, agent, now(), args?.branch || null, key);
        id = candidate;
      } catch (e) {
        if (!/UNIQUE/i.test(String(e?.message || e))) throw e;
        // A same-key task may have committed between our check and the insert: it wins.
        const existing = key ? this.db.prepare("SELECT * FROM tasks WHERE board = ? AND idempotency_key = ?").get(board, key) : null;
        if (existing) return [board, existing];
        if (attempt === 2) throw e; // t_<8 hex> collision three times running — something is wrong
      }
    }
    const ins = this.db.prepare("INSERT OR IGNORE INTO task_parents (task_id, parent_id) VALUES (?, ?)");
    for (const p of parents) ins.run(id, p);
    this._event(id, "created", agent, { status, assignee, parents: parents.length ? parents : undefined });
    return [board, this._get(board, id)];
  }

  /** Validate a create-time assignee: a configured lane, or null for triage. */
  _resolveAssignee(raw) {
    const name = String(raw || "").trim().toLowerCase();
    if (!name) return null;
    const lanes_ = lanes();
    if (lanes_.has(name)) return name;
    throw new StoreError(`unknown assignee '${raw}'. Configured lanes: ${[...lanes_].sort().join(", ")}. Leave assignee empty to send the task to triage.`);
  }

  /**
   * Atomically claim a ready task for lock `switchboard/<agent>`. Idempotent when we already hold it.
   * @returns {object} the claimed task row
   */
  _claim(agent, board, t, args) {
    const lock = lockFor(agent);
    if (t.status === "running" && t.claim_lock === lock) return t;
    const expires = now() + ttlSeconds(args);
    const r = this.db.prepare("UPDATE tasks SET status = 'running', claim_lock = ?, claim_expires = ?, started_at = ? WHERE id = ? AND status = 'ready'").run(lock, expires, now(), t.id);
    if (!r.changes) {
      const cur = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(t.id);
      throw new StoreError(
        `cannot claim ${t.id}: status=${cur.status}, claimed_by=${cur.claim_lock || "nobody"}` +
          (cur.claim_expires ? ` until ${iso(cur.claim_expires)}` : "") +
          (cur.status !== "running" ? ". It must be 'ready' (todo tasks still have open parents)." : "")
      );
    }
    this._event(t.id, "claimed", agent, { ttl_minutes: Math.round((expires - now()) / 60) });
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(t.id);
  }

  /** Throw unless the task is running and this agent holds its claim. */
  _requireOwner(agent, t, verb) {
    if (t.status !== "running" || t.claim_lock !== lockFor(agent)) {
      throw new StoreError(`cannot ${verb} ${t.id}: you don't hold its claim (status=${t.status}, claimed_by=${t.claim_lock || "nobody"})`);
    }
  }

  /** Count of a task's parents that aren't done yet. */
  _openParents(taskId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM task_parents p JOIN tasks t ON t.id = p.parent_id WHERE p.task_id = ? AND t.status != 'done'").get(taskId).n;
  }

  /** Children of a finished task in `todo` with no other unfinished parents become ready. */
  _unblockChildren(board, id) {
    for (const { task_id } of this.db.prepare("SELECT task_id FROM task_parents WHERE parent_id = ?").all(id)) {
      const child = this._get(board, task_id);
      if (!child || child.status !== "todo") continue;
      if (!this._openParents(task_id)) {
        this.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'todo'").run(task_id);
        this._event(task_id, "unblocked", null, { parent: id });
      }
    }
  }
}

// --- ops (same names and result shapes as tools/kanban_bridge.py) -----------------------------

function op_boards(store) {
  const rows = store.db.prepare("SELECT slug, name, description FROM boards WHERE archived = 0").all();
  return { boards: rows.map((b) => Object.fromEntries(Object.entries(b).filter(([, v]) => v != null))) };
}

function op_active(store) {
  const running = store._allTasks(["running"]).map(([b, t]) => taskView(t, b));
  const waitingRows = store._allTasks(["review", "blocked"]);
  const byBoard = {};
  for (const [b, t] of waitingRows) {
    const key = `${b}/${t.status}`;
    byBoard[key] = (byBoard[key] || 0) + 1;
  }
  waitingRows.sort((a, b) => (b[1].created_at || 0) - (a[1].created_at || 0));
  return {
    working_now: running,
    waiting: { total: waitingRows.length, by_board: byBoard, newest: waitingRows.slice(0, 15).map(([b, t]) => taskView(t, b)) },
    hint: "Before starting work, check working_now and find so you don't duplicate someone.",
  };
}

function op_list(store, agent, args) {
  const status = args.status;
  if (status && !ALL_STATUSES.includes(status)) throw new StoreError(`bad status '${status}'`);
  const assignee = args.mine ? agent : args.assignee ? String(args.assignee) : null;
  const boards = args.board ? [store._checkBoard(args.board)] : null;
  const limit = Math.max(1, Math.min(parseInt(args.limit, 10) || 50, 200));
  const rows = store._allTasks(status ? [status] : OPEN_STATUSES, boards, assignee);
  rows.sort((a, b) => (b[1].priority || 0) - (a[1].priority || 0) || a[1].created_at - b[1].created_at);
  return { tasks: rows.slice(0, limit).map(([b, t]) => taskView(t, b)), total: rows.length };
}

function op_find(store, agent, args) {
  const q = String(args.query || "").trim().toLowerCase();
  if (q.length < 3) throw new StoreError("query must be at least 3 characters");
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const statuses = [...OPEN_STATUSES, ...(args.include_done ? ["done"] : [])];
  const hits = [];
  for (const [b, t] of store._allTasks(statuses)) {
    const hay = `${t.title}\n${t.body || ""}\n${t.result || ""}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w)).length;
    if (hay.includes(q) || (words.length && score >= Math.max(1, (words.length + 1) >> 1))) hits.push([score + (hay.includes(q) ? 5 : 0), b, t]);
  }
  hits.sort((a, b) => b[0] - a[0]);
  return { matches: hits.slice(0, 25).map(([, b, t]) => taskView(t, b)) };
}

function op_show(store, agent, args) {
  const [board, t] = store._locate(args);
  const comments = store.db.prepare("SELECT author, body, created_at FROM comments WHERE task_id = ? ORDER BY id").all(t.id);
  const events = store.db.prepare("SELECT kind, agent, ts, payload FROM events WHERE task_id = ? ORDER BY id").all(t.id);
  return {
    task: taskView(t, board, { full: true }),
    comments: comments.slice(-30).map((c) => ({ author: c.author, body: c.body, at: iso(c.created_at) })),
    // `agent` and `fields` are what tools/lane_runner.py needs to spot untrusted title/body edits.
    recent_events: events.slice(-20).map((e) => ({ kind: e.kind, at: iso(e.ts), agent: e.agent ?? undefined, fields: e.payload ? JSON.parse(e.payload).fields : undefined })),
  };
}

function op_create(store, agent, args) {
  const assignee = store._resolveAssignee(args.assignee);
  const [board, t] = store._create(agent, args, assignee, { triage: assignee === null });
  return { task: taskView(t, board, { full: true }) };
}

function op_start(store, agent, args) {
  // Declare ad-hoc work: create a task assigned to yourself and claim it (call() wraps it in one tx).
  const [board, t] = store._create(agent, args, agent);
  const claimed = store._claim(agent, board, t, args);
  return { task: taskView(claimed, board, { full: true }) };
}

function op_claim(store, agent, args) {
  const [board, t] = store._locate(args);
  const claimed = store._claim(agent, board, t, args);
  return { task: taskView(claimed, board, { full: true }), note: "Claimed. Call heartbeat to extend, complete when done, release if you stop." };
}

function op_heartbeat(store, agent, args) {
  const [board, t] = store._locate(args);
  store._requireOwner(agent, t, "heartbeat");
  const expires = now() + ttlSeconds(args);
  const r = store.db.prepare("UPDATE tasks SET claim_expires = ? WHERE id = ? AND claim_lock = ?").run(expires, t.id, lockFor(agent));
  if (!r.changes) throw new StoreError(`heartbeat failed for ${t.id} (claim lost?)`);
  if (args.note) store._comment(t.id, agent, `[progress] ${String(args.note).slice(0, 2000)}`);
  store._event(t.id, "heartbeat", agent, null);
  return { task: taskView(store._get(board, t.id), board) };
}

function op_comment(store, agent, args) {
  const [board, t] = store._locate(args);
  const body = String(args.body || "").trim();
  if (!body) throw new StoreError("body is required");
  store._comment(t.id, agent, body.slice(0, 8000));
  store._event(t.id, "commented", agent, null);
  return { ok: true, id: t.id };
}

function op_complete(store, agent, args) {
  const [board, t] = store._locate(args);
  const result = String(args.result || "").trim();
  if (!result) throw new StoreError("result is required: say what you did and where (branch, files, links)");
  if (t.status === "running") store._requireOwner(agent, t, "complete");
  else if (t.status !== "review") throw new StoreError(`cannot complete ${t.id}: status=${t.status} (only a running task you hold, or one in review)`);
  else if (t.claim_lock && t.claim_lock !== lockFor(agent)) throw new StoreError(`cannot complete ${t.id}: you don't hold its claim (claimed_by=${t.claim_lock})`);
  const metadata = args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata) ? JSON.stringify(args.metadata) : null;
  store.db
    .prepare("UPDATE tasks SET status = 'done', result = ?, summary = ?, metadata = ?, completed_at = ?, claim_lock = NULL, claim_expires = NULL, block_kind = NULL, block_reason = NULL WHERE id = ?")
    .run(result.slice(0, 8000), args.summary != null ? String(args.summary) : null, metadata, now(), t.id);
  store._event(t.id, "completed", agent, null);
  store._unblockChildren(board, t.id);
  return { task: taskView(store._get(board, t.id), board) };
}

function op_release(store, agent, args) {
  const [board, t] = store._locate(args);
  store._requireOwner(agent, t, "release");
  const reason = String(args.reason || "").trim();
  if (!reason) throw new StoreError("reason is required: say why you are releasing it");
  store.db.prepare("UPDATE tasks SET status = 'ready', claim_lock = NULL, claim_expires = NULL, started_at = NULL WHERE id = ?").run(t.id);
  store._comment(t.id, agent, `[released] ${reason.slice(0, 500)}`);
  store._event(t.id, "released", agent, { reason: reason.slice(0, 500) });
  return { task: taskView(store._get(board, t.id), board) };
}

function op_block(store, agent, args) {
  // Park a claimed task for a human: running -> blocked with a reason (used by the lane runner).
  const [board, t] = store._locate(args);
  store._requireOwner(agent, t, "block");
  const reason = String(args.reason || "").trim();
  if (!reason) throw new StoreError("reason is required: say what is needed to unblock it");
  const kind = args.kind || "needs_input";
  if (!BLOCK_KINDS.has(kind)) throw new StoreError(`kind must be one of ${[...BLOCK_KINDS].sort().join(", ")}`);
  store.db.prepare("UPDATE tasks SET status = 'blocked', block_kind = ?, block_reason = ?, claim_lock = NULL, claim_expires = NULL WHERE id = ?").run(kind, reason.slice(0, 4000), t.id);
  store._comment(t.id, agent, `[blocked] ${reason.slice(0, 4000)}`);
  store._event(t.id, "blocked", agent, { kind });
  return { task: taskView(store._get(board, t.id), board) };
}

function op_edit(store, agent, args) {
  const [board, t] = store._locate(args);
  if (t.status === "done" || t.status === "archived") throw new StoreError(`${t.id} is ${t.status}; only open tasks can be edited`);
  let title = args.title;
  let body = args.body;
  if (args.append_body) body = ((body != null ? body : t.body) || "").replace(/\s+$/, "") + "\n\n" + String(args.append_body).trim();
  const priority = args.priority;
  const hasAssignee = args.assignee !== undefined;
  const assignee = hasAssignee ? store._resolveAssignee(args.assignee) : undefined;
  // Assigning a triage task routes it: ready, or todo while it still has open parents.
  const status = assignee && t.status === "triage" ? (store._openParents(t.id) ? "todo" : "ready") : t.status;
  if (title == null && body == null && priority == null && !hasAssignee) throw new StoreError("nothing to change: pass title, body, append_body, priority or assignee");
  store.db
    .prepare("UPDATE tasks SET title = ?, body = ?, priority = ?, assignee = ?, status = ? WHERE id = ?")
    .run(title != null ? String(title).slice(0, 300) : t.title, body != null ? String(body).slice(0, 20000) : t.body, priority != null && Number.isFinite(+priority) ? Math.trunc(+priority) : t.priority, hasAssignee ? assignee : t.assignee, status, t.id);
  const changed = ["title", "body", "priority", "assignee"].filter((k) => (k === "assignee" ? hasAssignee : args[k] != null || (k === "body" && args.append_body)));
  store._comment(t.id, agent, `[edited] ${changed.join(", ")}`);
  store._event(t.id, "edited", agent, { fields: changed, status: status !== t.status ? status : undefined });
  return { task: taskView(store._get(board, t.id), board) };
}

function op_park(store, agent, args) {
  const [board, t] = store._locate(args);
  if (t.status === "done" || t.status === "archived" || t.status === "running") throw new StoreError(`${t.id} is ${t.status}; release or finish it before parking`);
  const reason = String(args.reason || "").trim();
  if (!reason) throw new StoreError("reason is required: say why it is parked");
  const until = String(args.until || "").trim();
  const text = (until ? `until ${until}: ${reason}` : reason).slice(0, 1000);
  store.db.prepare("UPDATE tasks SET status = 'scheduled', scheduled_reason = ?, block_kind = NULL, block_reason = NULL WHERE id = ?").run(text, t.id);
  store._comment(t.id, agent, `[parked] ${text}`);
  store._event(t.id, "parked", agent, { until: until || undefined });
  return { task: taskView(store._get(board, t.id), board) };
}

function op_unpark(store, agent, args) {
  const [board, t] = store._locate(args);
  if (t.status !== "scheduled" && t.status !== "blocked") throw new StoreError(`${t.id} is ${t.status}; only parked or blocked tasks can be brought back`);
  const status = store._openParents(t.id) ? "todo" : "ready";
  store.db.prepare("UPDATE tasks SET status = ?, scheduled_reason = NULL, block_kind = NULL, block_reason = NULL WHERE id = ?").run(status, t.id);
  store._comment(t.id, agent, `[unparked] ${String(args.reason || "back in play").slice(0, 500)}`);
  store._event(t.id, "unparked", agent, null);
  return { task: taskView(store._get(board, t.id), board) };
}

const OPS = {
  boards: op_boards,
  active: op_active,
  list: op_list,
  find: op_find,
  show: op_show,
  create: op_create,
  start: op_start,
  claim: op_claim,
  heartbeat: op_heartbeat,
  comment: op_comment,
  complete: op_complete,
  release: op_release,
  block: op_block,
  edit: op_edit,
  park: op_park,
  unpark: op_unpark,
};
