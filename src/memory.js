/**
 * Built-in `memory` connector: one shared, private, traceable memory for all agents (claude-code,
 * codex, hermes, cloud-agent, ...). Two kinds of entries in one SQLite file:
 *
 *   facts: key/value organization facts (key is lowercase "entity.field", e.g. "acme.duns").
 *   notes: tips, rules, do/don't, gotchas, how-tos, tagged with topics and an audience (applies_to).
 *
 * Every write to a fact or note is recorded in `history` as a full JSON snapshot of the row BEFORE the
 * change, so nothing is ever hard-deleted (notes are retired, not dropped). Every read of a restricted or
 * secret fact VALUE is recorded in `access`. Both tables are searched through an FTS5 trigram index, kept
 * in sync by delete-then-insert on each write (same approach as src/lookup.js).
 *
 * This module is split in two:
 *   MemoryStore  : plain SQLite CRUD + search + history/access logging. No notion of "who's allowed to
 *                   see what": trusted callers only (the CLI, and MemoryBackend below).
 *   MemoryBackend: the agent-facing MCP tool surface: clearance filtering, write permission checks,
 *                   credential rejection, title dedup, and all the text formatting agents read. Mirrors
 *                   the ArpStore/ArpBackend split in src/arp.js.
 *
 * The CLI (`bin/sb.js` `memory` subcommand) talks to MemoryStore directly, as a trusted admin (operator):
 * no clearance limit, and it's the only path that can set verified=1.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// --- shared constants --------------------------------------------------------

/** Sensitivity ladder, lowest to highest. Anything unrecognized is treated as "internal". */
export const LEVELS = ["public", "internal", "restricted", "secret"];
export const NOTE_KINDS = ["rule", "tip", "gotcha", "howto", "preference"];
const TITLE_MAX = 160;
const BODY_MAX = 4000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
/** Normalized-title trigram overlap above which `remember` treats a new note as a likely duplicate. */
const DEDUP_THRESHOLD = 0.6;

/** @param {string} s @returns {number} position in LEVELS, defaulting unknown values to "internal" */
export const levelIndex = (s) => {
  const i = LEVELS.indexOf(s);
  return i === -1 ? 1 : i;
};

/** True when `entrySensitivity` is at or below `clearance` on the LEVELS ladder. */
export const atOrBelow = (entrySensitivity, clearance) => levelIndex(entrySensitivity) <= levelIndex(clearance);

/** @param {number} n @param {number} def @param {number} max */
const clamp = (n, def, max) => Math.min(Math.max(Number(n) || def, 1), max);

const now = () => new Date().toISOString();

/** Quote a term for an FTS5 MATCH expression (same helper as src/lookup.js). */
const ftsTerm = (w) => `"${w.replace(/"/g, '""')}"`;

/**
 * Normalize a title for duplicate detection: lowercase, punctuation to spaces, collapsed whitespace.
 * @param {string} s
 */
export function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Character trigrams of a (short, already-normalized) string, padded so short words still produce some. */
function trigrams(s) {
  const t = ` ${s} `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  if (!set.size && t.trim()) set.add(t.trim());
  return set;
}

/**
 * Jaccard similarity over character trigrams of two normalized titles, 0..1.
 * @param {string} a
 * @param {string} b
 */
export function titleSimilarity(a, b) {
  if (a === b) return 1;
  const sa = trigrams(a);
  const sb = trigrams(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// --- credential rejection ----------------------------------------------------

/** Patterns that indicate a raw password/key/token, so it doesn't end up living in shared memory. */
const CRED_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key (sk-...)"],
  [/\bxox[bpae]-[A-Za-z0-9-]{10,}/, "a Slack token (xox*)"],
  [/\bAKIA[0-9A-Z]{16}/, "an AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, "a private key"],
];
/** "password: X" style assignments; the value is checked separately so pointers ("token: password manager item X") pass. */
const ASSIGNMENT_RE = /(password|passwd|pwd|api[_-]?key|secret[_-]?key|client[_-]?secret|token)\s*[:=]\s*["']?([^\s"',;]+)/gi;
/** Words that mark an assignment's value as a pointer to where the secret lives, not the secret itself. */
const POINTER_RE = /^(vault|passwordmanager|password-manager|see|in|stored|lives|item|n\/a|none|redacted|<.*>|\*+)$/i;
export const CREDENTIAL_MESSAGE = "Passwords and keys don't go in memory; they live in your password manager. Store a pointer instead (e.g. 'API token: password manager item X').";

/**
 * True when a token looks like a machine secret: 32+ chars of key alphabet, mixing upper, lower and digits,
 * and not a path (no slashes) or a plain long word/slug.
 * @param {string} t
 */
function looksLikeKey(t) {
  return t.length >= 32 && !t.includes("/") && /[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t);
}

/**
 * Scan one or more fields for anything that looks like a raw credential.
 * @param {...(string|undefined)} fields
 * @returns {string|null} a human description of what matched, or null
 */
export function findCredential(...fields) {
  const s = fields.filter(Boolean).join("\n");
  for (const [re, kind] of CRED_PATTERNS) if (re.test(s)) return kind;
  for (const m of s.matchAll(ASSIGNMENT_RE)) {
    const v = m[2];
    if (!POINTER_RE.test(v) && v.length >= 6 && /[0-9!@#$%^&*]/.test(v)) return `a ${m[1].toLowerCase()} value`;
  }
  for (const m of s.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
    // Labeled Google Drive/Sheets/Docs ids ("id 1zlM...", "sheet: 1YGj...") look like keys but aren't secrets.
    if (/\b(id|ids|folder|file|sheet|doc|drive)\b[\s:=#]*$/i.test(s.slice(Math.max(0, m.index - 16), m.index))) continue;
    if (looksLikeKey(m[0])) return "a long key-looking string";
  }
  return null;
}

// --- store --------------------------------------------------------------------

export class MemoryStore {
  /** @param {string} path - sqlite file */
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        key TEXT PRIMARY KEY,
        entity TEXT NOT NULL,
        label TEXT,
        value TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        note TEXT,
        source TEXT,
        verified INTEGER NOT NULL DEFAULT 0,
        flag TEXT,
        flagged_by TEXT,
        updated_by TEXT,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS facts_entity ON facts(entity);
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(key UNINDEXED, label, note, entity, value, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        norm_title TEXT NOT NULL,
        body TEXT NOT NULL,
        topics TEXT NOT NULL DEFAULT '',
        applies_to TEXT NOT NULL DEFAULT 'all',
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        status TEXT NOT NULL DEFAULT 'active',
        verified INTEGER NOT NULL DEFAULT 0,
        flag TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS notes_norm_title ON notes(norm_title);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, body, topics, tokenize='trigram');

      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        ref_type TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        action TEXT NOT NULL,
        by TEXT,
        why TEXT,
        snapshot TEXT
      );
      CREATE INDEX IF NOT EXISTS history_ref ON history(ref_type, ref_id);

      CREATE TABLE IF NOT EXISTS access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        agent TEXT NOT NULL,
        key TEXT NOT NULL,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS access_key ON access(key);
    `);
  }

  // -- facts ---------------------------------------------------------------

  /** @param {string} key */
  getFact(key) {
    return this.db.prepare("SELECT * FROM facts WHERE key = ?").get(String(key).toLowerCase()) || null;
  }

  /** @param {string} entity @param {number} [limit] */
  listFactsByEntity(entity, limit = 200) {
    return this.db.prepare("SELECT * FROM facts WHERE entity = ? ORDER BY key LIMIT ?").all(String(entity).toLowerCase(), limit);
  }

  /** @param {string} query @param {{limit?: number}} [opts] */
  searchFacts(query, { limit = MAX_LIMIT } = {}) {
    const q = String(query).trim();
    if (!q) return [];
    const words = q.split(/\s+/).filter((w) => w.length >= 3);
    if (!words.length) {
      const like = `${q.toLowerCase()}%`;
      return this.db.prepare("SELECT * FROM facts WHERE lower(key) LIKE ? OR lower(label) LIKE ? ORDER BY verified DESC, key LIMIT ?").all(like, like, limit);
    }
    const expr = words.map(ftsTerm).join(" OR ");
    return this.db
      .prepare(`SELECT f.*, bm25(facts_fts) AS score FROM facts_fts ff JOIN facts f ON f.key = ff.key WHERE facts_fts MATCH ? ORDER BY score LIMIT ?`)
      .all(expr, limit)
      .concat(this.db.prepare("SELECT *, -100 AS score FROM facts WHERE lower(key) = lower(?)").all(q))
      .filter((f, i, all) => all.findIndex((g) => g.key === f.key) === i);
  }

  /**
   * Insert or update a fact row (trusted caller: no permission checks here). Bumps `version`, re-indexes
   * FTS, and records a history snapshot of the row as it was before this write.
   * @param {{key: string, entity?: string, label?: string, value: string, sensitivity?: string, note?: string, source?: string}} fields
   * @param {{by: string, why?: string, verified?: boolean}} meta
   */
  upsertFact({ key, entity, label, value, sensitivity = "internal", note, source }, { by, why, verified = false }) {
    const k = String(key).toLowerCase();
    const ent = (entity || k.split(".")[0] || k).toLowerCase();
    const prev = this.getFact(k);
    const t = now();
    const version = (prev?.version || 0) + 1;
    this.db
      .prepare(
        `INSERT INTO facts (key, entity, label, value, sensitivity, note, source, verified, updated_by, updated_at, version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET entity=excluded.entity, label=excluded.label, value=excluded.value, sensitivity=excluded.sensitivity,
           note=excluded.note, source=excluded.source, verified=excluded.verified, updated_by=excluded.updated_by, updated_at=excluded.updated_at,
           version=excluded.version, flag=NULL, flagged_by=NULL`
      )
      .run(k, ent, label ?? null, String(value), sensitivity, note ?? null, source ?? null, verified ? 1 : 0, by ?? null, t, version);
    this._indexFact(this.getFact(k));
    this._history("fact", k, prev ? "update" : "insert", by, why, prev);
    return { key: k, inserted: !prev, version };
  }

  /** @param {string} key @param {string} problem @param {string} by */
  flagFact(key, problem, by) {
    const k = String(key).toLowerCase();
    const prev = this.getFact(k);
    if (!prev) return null;
    this.db.prepare("UPDATE facts SET flag=?, flagged_by=?, updated_at=?, version=version+1 WHERE key=?").run(problem, by, now(), k);
    this._history("fact", k, "flag", by, problem, prev);
    return this.getFact(k);
  }

  /** @param {string} key @param {string} by */
  unflagFact(key, by) {
    const k = String(key).toLowerCase();
    const prev = this.getFact(k);
    if (!prev) return null;
    this.db.prepare("UPDATE facts SET flag=NULL, flagged_by=NULL, updated_at=?, version=version+1 WHERE key=?").run(now(), k);
    this._history("fact", k, "unflag", by, null, prev);
    return this.getFact(k);
  }

  /** Mark a fact operator-verified. Only the CLI calls this: agents can never set verified=1. */
  verifyFact(key, by) {
    const k = String(key).toLowerCase();
    const prev = this.getFact(k);
    if (!prev) return null;
    this.db.prepare("UPDATE facts SET verified=1, updated_by=?, updated_at=?, version=version+1 WHERE key=?").run(by, now(), k);
    this._history("fact", k, "verify", by, null, prev);
    return this.getFact(k);
  }

  _indexFact(f) {
    this.db.prepare("DELETE FROM facts_fts WHERE key = ?").run(f.key);
    // Values are searchable only for public/internal facts, so nobody can confirm a restricted value by searching for it.
    const value = atOrBelow(f.sensitivity, "internal") ? f.value : "";
    this.db.prepare("INSERT INTO facts_fts (key, label, note, entity, value) VALUES (?,?,?,?,?)").run(f.key, f.label || "", f.note || "", f.entity || "", value);
  }

  // -- notes -----------------------------------------------------------------

  /** @param {string} id */
  getNote(id) {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) || null;
  }

  /** Exact-normalized-title match among active (non-retired) notes, for dedup's fast path. */
  findActiveByNormalizedTitle(normTitle) {
    return this.db.prepare("SELECT * FROM notes WHERE norm_title = ? AND status != 'retired' ORDER BY created_at LIMIT 1").get(normTitle) || null;
  }

  /** All active notes' id/title/norm_title, for the dedup trigram-overlap check (dataset is small; see memory.js header). */
  listActiveNoteTitles() {
    return this.db.prepare("SELECT id, title, norm_title FROM notes WHERE status != 'retired'").all();
  }

  /**
   * Find an active note whose title is an exact normalized match, or clearly overlaps (trigram Jaccard
   * >= DEDUP_THRESHOLD), the given title. Used by `remember` before inserting (unless force: true).
   * @param {string} title
   */
  findSimilarActiveNote(title) {
    const norm = normalizeTitle(title);
    const exact = this.findActiveByNormalizedTitle(norm);
    if (exact) return exact;
    let best = null;
    let bestScore = 0;
    for (const row of this.listActiveNoteTitles()) {
      const score = titleSimilarity(norm, row.norm_title);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
    return bestScore >= DEDUP_THRESHOLD ? this.getNote(best.id) : null;
  }

  /**
   * @param {{kind: string, title: string, body: string, topics?: string, applies_to?: string, sensitivity?: string}} fields
   * @param {{by: string, verified?: boolean}} meta
   * @returns {string} the new note's id
   */
  insertNote({ kind, title, body, topics = "", applies_to = "all", sensitivity = "internal" }, { by, verified = false }) {
    let id;
    do {
      id = "n_" + randomBytes(3).toString("hex");
    } while (this.getNote(id));
    const t = now();
    this.db
      .prepare(
        `INSERT INTO notes (id, kind, title, norm_title, body, topics, applies_to, sensitivity, status, verified, created_by, created_at, updated_by, updated_at, version)
         VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?,1)`
      )
      .run(id, kind, title, normalizeTitle(title), body, topics, applies_to, sensitivity, verified ? 1 : 0, by, t, by, t);
    this._indexNote(this.getNote(id));
    this._history("note", id, "insert", by, "created", null);
    return id;
  }

  /**
   * Revise a note's title/body/topics. Always clears `verified` (an edit, by anyone, means it needs
   * re-checking: see memory.js header for why this needs no special-casing by author).
   * @param {string} id
   * @param {{title?: string, body?: string, topics?: string}} fields
   * @param {{by: string, why: string}} meta
   */
  updateNote(id, { title, body, topics }, { by, why }) {
    const prev = this.getNote(id);
    if (!prev) return null;
    const next = { title: title ?? prev.title, body: body ?? prev.body, topics: topics ?? prev.topics };
    const t = now();
    this.db
      .prepare("UPDATE notes SET title=?, norm_title=?, body=?, topics=?, verified=0, updated_by=?, updated_at=?, version=version+1 WHERE id=?")
      .run(next.title, normalizeTitle(next.title), next.body, next.topics, by, t, id);
    this._indexNote(this.getNote(id));
    this._history("note", id, "update", by, why, prev);
    return this.getNote(id);
  }

  /** @param {string} id @param {string} problem @param {string} by */
  flagNote(id, problem, by) {
    const prev = this.getNote(id);
    if (!prev) return null;
    this.db.prepare("UPDATE notes SET status='flagged', flag=?, updated_by=?, updated_at=?, version=version+1 WHERE id=?").run(problem, by, now(), id);
    this._history("note", id, "flag", by, problem, prev);
    return this.getNote(id);
  }

  /** @param {string} id @param {string} by */
  unflagNote(id, by) {
    const prev = this.getNote(id);
    if (!prev) return null;
    this.db.prepare("UPDATE notes SET status='active', flag=NULL, updated_by=?, updated_at=?, version=version+1 WHERE id=?").run(by, now(), id);
    this._history("note", id, "unflag", by, null, prev);
    return this.getNote(id);
  }

  /** @param {string} id @param {string} why @param {string} by */
  retireNote(id, why, by) {
    const prev = this.getNote(id);
    if (!prev) return null;
    this.db.prepare("UPDATE notes SET status='retired', updated_by=?, updated_at=?, version=version+1 WHERE id=?").run(by, now(), id);
    this._history("note", id, "retire", by, why, prev);
    return this.getNote(id);
  }

  /** Mark a note operator-verified. Only the CLI calls this: agents can never set verified=1. */
  verifyNote(id, by) {
    const prev = this.getNote(id);
    if (!prev) return null;
    this.db.prepare("UPDATE notes SET verified=1, updated_by=?, updated_at=?, version=version+1 WHERE id=?").run(by, now(), id);
    this._history("note", id, "verify", by, null, prev);
    return this.getNote(id);
  }

  /** @param {string} query @param {{limit?: number}} [opts] */
  searchNotes(query, { limit = MAX_LIMIT } = {}) {
    const words = String(query).trim().split(/\s+/).filter((w) => w.length >= 3);
    if (!words.length) return [];
    const expr = words.map(ftsTerm).join(" OR ");
    return this.db
      .prepare(`SELECT n.*, bm25(notes_fts) AS score FROM notes_fts nf JOIN notes n ON n.id = nf.id WHERE notes_fts MATCH ? AND n.status != 'retired' ORDER BY score LIMIT ?`)
      .all(expr, limit);
  }

  /** @param {string} topic @param {number} [limit] */
  listNotesByTopic(topic, limit = 200) {
    const like = `%${String(topic).toLowerCase()}%`;
    return this.db.prepare("SELECT * FROM notes WHERE status != 'retired' AND lower(topics) LIKE ? ORDER BY verified DESC, created_at DESC LIMIT ?").all(like, limit);
  }

  _indexNote(n) {
    this.db.prepare("DELETE FROM notes_fts WHERE id = ?").run(n.id);
    this.db.prepare("INSERT INTO notes_fts (id, title, body, topics) VALUES (?,?,?,?)").run(n.id, n.title, n.body, n.topics);
  }

  // -- history / access ---------------------------------------------------------

  /** @param {"fact"|"note"} refType @param {string} refId @param {string} action @param {string} [by] @param {string} [why] @param {object|null} prevRow */
  _history(refType, refId, action, by, why, prevRow) {
    this.db
      .prepare("INSERT INTO history (ts, ref_type, ref_id, action, by, why, snapshot) VALUES (?,?,?,?,?,?,?)")
      .run(now(), refType, refId, action, by ?? null, why ?? null, prevRow ? JSON.stringify(prevRow) : null);
  }

  /** @param {"fact"|"note"} refType @param {string} refId @param {number} [limit] */
  getHistory(refType, refId, limit = 50) {
    return this.db
      .prepare("SELECT * FROM history WHERE ref_type = ? AND ref_id = ? ORDER BY id DESC LIMIT ?")
      .all(refType, refId, limit)
      .map((r) => ({ ...r, snapshot: r.snapshot ? JSON.parse(r.snapshot) : null }));
  }

  /** Record one read of a restricted/secret fact value. @param {string} agent @param {string} key @param {string} reason */
  logAccess(agent, key, reason) {
    this.db.prepare("INSERT INTO access (ts, agent, key, reason) VALUES (?,?,?,?)").run(now(), agent, key, reason ?? null);
  }

  /** @param {{since?: string, agent?: string}} [opts] - `since` is an ISO timestamp */
  listAccess({ since, agent } = {}) {
    const clauses = [];
    const params = [];
    if (since) {
      clauses.push("ts >= ?");
      params.push(since);
    }
    if (agent) {
      clauses.push("agent = ?");
      params.push(agent);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM access ${where} ORDER BY id DESC LIMIT 1000`).all(...params);
  }

  // -- orientation ---------------------------------------------------------------

  /** Counts and top topics for `recall` with no arguments at all. */
  stats() {
    const byKind = Object.fromEntries(this.db.prepare("SELECT kind, COUNT(*) c FROM notes WHERE status != 'retired' GROUP BY kind").all().map((r) => [r.kind, r.c]));
    const entities = this.db.prepare("SELECT DISTINCT entity FROM facts ORDER BY entity").all().map((r) => r.entity);
    const factCount = this.db.prepare("SELECT COUNT(*) c FROM facts").get().c;
    const topicCounts = new Map();
    for (const r of this.db.prepare("SELECT topics FROM notes WHERE status != 'retired'").all()) {
      for (const topic of String(r.topics || "").split(/[\s,]+/).filter(Boolean)) topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
    const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);
    return { byKind, entities, factCount, topTopics };
  }

  close() {
    this.db.close();
  }
}

// --- agent-facing tool surface ------------------------------------------------

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
const err = (t) => text(t, true);

const SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string", description: "Search text" },
    topic: { type: "string" },
    kind: { type: "string", enum: NOTE_KINDS },
    entity: { type: "string" },
    limit: { type: "number", description: "Max results (default 8, max 25)" },
  },
};

export const TOOLS = [
  {
    name: "recall",
    description:
      "Search shared memory (facts + notes visible to you). Call this before drafting anything customer-facing, government, or vendor-facing. With no q: entity lists that entity's facts, topic lists notes with that topic, otherwise you get a short orientation.",
    inputSchema: SCHEMA,
  },
  {
    name: "get_fact",
    description: "Look up one fact by its exact key (or entity + field). Restricted/secret facts require a non-empty reason (8+ chars); the read is logged.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, entity: { type: "string" }, field: { type: "string" }, reason: { type: "string" } } },
  },
  {
    name: "profile",
    description: "All facts for one entity (a company card) at your clearance. Restricted/secret values are included only if you pass a reason (logged); otherwise they're listed as withheld.",
    inputSchema: { type: "object", required: ["entity"], properties: { entity: { type: "string" }, reason: { type: "string" } } },
  },
  {
    name: "remember",
    description:
      "Add a note (kind: rule/tip/gotcha/howto/preference): use when the operator corrects you or you learn a durable lesson. Never store passwords or keys; point at your password manager instead. Deduped by title unless force: true.",
    inputSchema: {
      type: "object",
      required: ["kind", "title", "body"],
      properties: {
        kind: { type: "string", enum: NOTE_KINDS },
        title: { type: "string", description: "Max 160 chars" },
        body: { type: "string", description: "Max 4000 chars" },
        topics: { type: "string", description: "Space or comma separated tags" },
        applies_to: { type: "string", description: "Agent names or 'all' (default all)" },
        sensitivity: { type: "string", enum: LEVELS, description: "Default internal" },
        force: { type: "boolean", description: "Add even if a similar title already exists" },
      },
    },
  },
  {
    name: "update",
    description: "Revise an existing note. `why` is required and is kept in history. Editing another agent's note, or a verified one, clears its verified mark.",
    inputSchema: { type: "object", required: ["id", "why"], properties: { id: { type: "string" }, title: { type: "string" }, body: { type: "string" }, topics: { type: "string" }, why: { type: "string" } } },
  },
  {
    name: "flag",
    description: "Mark a note or fact as possibly wrong, for the operator to resolve. Shows up in recall until resolved.",
    inputSchema: { type: "object", required: ["id_or_key", "problem"], properties: { id_or_key: { type: "string" }, problem: { type: "string" } } },
  },
  {
    name: "set_fact",
    description: "Write a company fact (key = entity.field). Admin agents only: everyone else gets an error telling them to use remember (kind tip) to propose a correction, or flag.",
    inputSchema: {
      type: "object",
      required: ["key", "value", "source", "why"],
      properties: { key: { type: "string" }, value: { type: "string" }, label: { type: "string" }, sensitivity: { type: "string", enum: LEVELS }, note: { type: "string" }, source: { type: "string" }, why: { type: "string" } },
    },
  },
  {
    name: "history",
    description: "Version trail for a note id or fact key: who changed it, when, why. Values are redacted if the entry is above your clearance.",
    inputSchema: { type: "object", required: ["id_or_key"], properties: { id_or_key: { type: "string" }, limit: { type: "number" } } },
  },
];

/** True when a note is reachable by this agent: not retired, and applies_to includes them or "all". */
function noteReachable(note, agent) {
  if (note.status === "retired") return false;
  const applies = String(note.applies_to || "all").split(/[\s,]+/).filter(Boolean);
  return applies.includes("all") || applies.includes(agent);
}

/** `recall`/entity-listing line for a fact: restricted/secret VALUES never appear here, only a pointer to get_fact. */
function factLine(f) {
  const flagged = f.flag ? `[flagged: ${f.flag}] ` : "";
  if (f.sensitivity === "restricted" || f.sensitivity === "secret") return `${flagged}fact ${f.key} (${f.sensitivity}: use get_fact with a reason)${f.verified ? " ✓" : ""}`;
  let s = `${flagged}fact ${f.key} = ${f.value}`;
  if (f.label) s += ` · ${f.label}`;
  if (f.verified) s += " ✓";
  return s;
}

/** `recall`/topic-listing line for a note, with a [flagged: ...] prefix when status is flagged. */
function noteLine(n) {
  let s = `${n.kind} ${n.id}`;
  if (n.verified) s += " ✓";
  s += ` ${n.title}: ${n.body.slice(0, 300)}`;
  return n.status === "flagged" ? `[flagged: ${n.flag || "unspecified"}] ${s}` : s;
}

/** Ranking for a merged recall result: verified first, rules before tips, then bm25 (lower = better). */
function rankScore(type, row) {
  const verifiedRank = row.verified ? 0 : 1;
  const kindRank = type === "note" ? (row.kind === "rule" ? 0 : 1) : 0.5;
  const bm25 = typeof row.score === "number" ? row.score : 0;
  return verifiedRank * 1000 + kindRank * 100 + bm25;
}

export class MemoryBackend {
  /**
   * @param {MemoryStore} store
   * @param {{clearanceOf: (agent: string) => string, isAdmin: (agent: string) => boolean}} opts
   */
  constructor(store, { clearanceOf, isAdmin }) {
    this.store = store;
    this.clearanceOf = clearanceOf;
    this.isAdmin = isAdmin;
    this.name = "memory";
    this.conn = { name: "memory", builtin: true };
    this.client = true; // no child process to crash
    this.pid = null;
    this.restarts = 0;
    this.inflight = 0;
    this.startedAt = new Date();
  }

  async start() {}
  async stop() {}

  info() {
    return {
      serverInfo: { name: "switchboard-memory", version: "1" },
      capabilities: { tools: {} },
      instructions:
        "Shared memory of the organization's facts (legal names, registration ids, addresses, phones) and house rules/tips. Call recall before drafting anything customer-facing, government, or vendor forms. Use remember when the operator corrects you or you learn a durable lesson. Never store passwords/keys. Restricted reads need a reason and are logged.",
    };
  }

  /**
   * @param {{method: string, params?: object}} req
   * @param {{agent?: string}} [opts] - opts.agent is the caller identity (set by Switchboard, never client-supplied)
   */
  async request(req, opts = {}) {
    if (req.method === "tools/list") return { tools: TOOLS };
    if (req.method !== "tools/call") return err(`unsupported method ${req.method}`);
    const agent = opts.agent;
    if (!agent) return err("internal error: no caller identity for memory connector");
    const args = req.params?.arguments ?? {};
    try {
      switch (req.params?.name) {
        case "recall":
          return this._recall(agent, args);
        case "get_fact":
          return this._getFact(agent, args);
        case "profile":
          return this._profile(agent, args);
        case "remember":
          return this._remember(agent, args);
        case "update":
          return this._update(agent, args);
        case "flag":
          return this._flag(agent, args);
        case "set_fact":
          return this._setFact(agent, args);
        case "history":
          return this._history(agent, args);
        default:
          return err(`unknown tool ${req.params?.name}`);
      }
    } catch (e) {
      return err(`memory failed: ${e.message}`);
    }
  }

  // -- recall and its three no-q modes --------------------------------------

  _recall(agent, args) {
    const clearance = this.clearanceOf(agent);
    const limit = clamp(args.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const q = String(args.q || "").trim();
    if (!q) {
      if (args.entity) return this._entityFacts(agent, args.entity, clearance, limit);
      if (args.topic) return this._topicNotes(agent, args.topic, clearance, limit, args.kind);
      return this._orientation();
    }

    const factRows = args.kind ? [] : this.store.searchFacts(q, { limit: limit * 3 }).filter((f) => !args.entity || f.entity === String(args.entity).toLowerCase());
    let notes = this.store.searchNotes(q, { limit: limit * 3 });
    if (args.kind) notes = notes.filter((n) => n.kind === args.kind);

    let hidden = 0;
    const visible = [];
    for (const f of factRows) (atOrBelow(f.sensitivity, clearance) ? visible.push({ type: "fact", row: f }) : hidden++);
    for (const n of notes) {
      if (!noteReachable(n, agent)) continue;
      (atOrBelow(n.sensitivity, clearance) ? visible.push({ type: "note", row: n }) : hidden++);
    }
    if (!visible.length && !hidden) return text(`No match for "${q}".`);

    visible.sort((a, b) => rankScore(a.type, a.row) - rankScore(b.type, b.row));
    const lines = visible.slice(0, limit).map((e) => (e.type === "fact" ? factLine(e.row) : noteLine(e.row)));
    const extra = [];
    if (visible.length > limit) extra.push(`${visible.length - limit} more match`);
    if (hidden) extra.push(`${hidden} more entr${hidden === 1 ? "y needs" : "ies need"} higher clearance`);
    if (extra.length) lines.push(`(${extra.join("; ")})`);
    return text(lines.join("\n"));
  }

  _entityFacts(agent, entity, clearance, limit) {
    const rows = this.store.listFactsByEntity(entity);
    let hidden = 0;
    const visible = [];
    for (const f of rows) (atOrBelow(f.sensitivity, clearance) ? visible.push(f) : hidden++);
    if (!visible.length && !hidden) return text(`No facts recorded for entity "${entity}".`);
    const lines = visible.slice(0, limit).map(factLine);
    if (visible.length > limit) lines.push(`(${visible.length - limit} more; narrow with q)`);
    if (hidden) lines.push(`(${hidden} more entr${hidden === 1 ? "y needs" : "ies need"} higher clearance)`);
    return text(lines.join("\n"));
  }

  _topicNotes(agent, topic, clearance, limit, kindFilter) {
    let rows = this.store.listNotesByTopic(topic);
    if (kindFilter) rows = rows.filter((n) => n.kind === kindFilter);
    let hidden = 0;
    const visible = [];
    for (const n of rows) {
      if (!noteReachable(n, agent)) continue;
      (atOrBelow(n.sensitivity, clearance) ? visible.push(n) : hidden++);
    }
    if (!visible.length && !hidden) return text(`No notes tagged "${topic}".`);
    visible.sort((a, b) => rankScore("note", a) - rankScore("note", b));
    const lines = visible.slice(0, limit).map(noteLine);
    if (visible.length > limit) lines.push(`(${visible.length - limit} more; narrow with kind or q)`);
    if (hidden) lines.push(`(${hidden} more entr${hidden === 1 ? "y needs" : "ies need"} higher clearance)`);
    return text(lines.join("\n"));
  }

  _orientation() {
    const s = this.store.stats();
    const kinds = Object.entries(s.byKind).map(([k, c]) => `${k}:${c}`).join(" ") || "(none yet)";
    const entities = s.entities.length ? s.entities.join(", ") : "(none yet)";
    const topics = s.topTopics.length ? s.topTopics.join(", ") : "(none yet)";
    return text(
      `Shared memory: ${s.factCount} fact(s); notes by kind: ${kinds}.\n` +
        `Entities: ${entities}\n` +
        `Top topics: ${topics}\n` +
        `Pass q to search, entity to list a company's facts, or topic to list tagged notes. remember adds a note; get_fact/profile read facts.`
    );
  }

  // -- single-fact / entity-profile reads, with reason-gated reveal -----------

  _getFact(agent, args) {
    const clearance = this.clearanceOf(agent);
    const key = args.key ? String(args.key).toLowerCase() : args.entity && args.field ? `${args.entity}.${args.field}`.toLowerCase() : null;
    if (!key) return err(`pass "key", or both "entity" and "field"`);
    const f = this.store.getFact(key);
    if (!f) return err(`no fact "${key}"`);
    if (!atOrBelow(f.sensitivity, clearance)) return err(`"${key}" is ${f.sensitivity}; your clearance is ${clearance}`);
    if (f.sensitivity === "restricted" || f.sensitivity === "secret") {
      const reason = String(args.reason || "").trim();
      if (reason.length < 8) return err(`reading "${key}" (${f.sensitivity}) requires a "reason" of at least 8 characters; the read is logged`);
      this.store.logAccess(agent, key, reason);
    }
    const parts = [`${f.key} = ${f.value}`];
    if (f.label) parts.push(f.label);
    if (f.note) parts.push(f.note);
    if (f.source) parts.push(`source: ${f.source}`);
    parts.push(`verified: ${f.verified ? "yes" : "no"}; updated ${f.updated_at.slice(0, 10)}${f.updated_by ? ` by ${f.updated_by}` : ""}`);
    if (f.flag) parts.push(`flagged: ${f.flag}`);
    return text(parts.join(" · "));
  }

  _profile(agent, args) {
    const entity = String(args.entity || "").trim().toLowerCase();
    if (!entity) return err(`"entity" is required`);
    const clearance = this.clearanceOf(agent);
    const reason = String(args.reason || "").trim();
    const rows = this.store.listFactsByEntity(entity);
    if (!rows.length) return text(`No facts recorded for entity "${entity}".`);
    const lines = [`${entity}:`];
    let invisible = 0;
    let withheld = 0;
    for (const f of rows) {
      if (!atOrBelow(f.sensitivity, clearance)) {
        invisible++;
        continue;
      }
      const gated = f.sensitivity === "restricted" || f.sensitivity === "secret";
      if (gated && reason.length < 8) {
        withheld++;
        lines.push(`  ${f.key} (${f.sensitivity}: use get_fact with a reason)`);
        continue;
      }
      if (gated) this.store.logAccess(agent, f.key, reason);
      lines.push(`  ${f.key} = ${f.value}${f.label ? ` · ${f.label}` : ""}${f.verified ? " ✓" : ""}`);
    }
    if (withheld) lines.push(`(${withheld} withheld: call profile again with a reason, or use get_fact)`);
    if (invisible) lines.push(`(${invisible} more entr${invisible === 1 ? "y needs" : "ies need"} higher clearance)`);
    return text(lines.join("\n"));
  }

  // -- writes ----------------------------------------------------------------

  _remember(agent, args) {
    if (!NOTE_KINDS.includes(args.kind)) return err(`"kind" must be one of ${NOTE_KINDS.join(", ")}`);
    const title = String(args.title || "").trim();
    const body = String(args.body || "").trim();
    if (!title) return err(`"title" is required`);
    if (!body) return err(`"body" is required`);
    if (title.length > TITLE_MAX) return err(`"title" is too long (max ${TITLE_MAX} chars)`);
    if (body.length > BODY_MAX) return err(`"body" is too long (max ${BODY_MAX} chars)`);
    const sensitivity = args.sensitivity || "internal";
    if (!LEVELS.includes(sensitivity)) return err(`"sensitivity" must be one of ${LEVELS.join(", ")}`);
    const clearance = this.clearanceOf(agent);
    if (levelIndex(sensitivity) > levelIndex(clearance)) return err(`you can't write at sensitivity "${sensitivity}" (your clearance is "${clearance}")`);
    const cred = findCredential(title, body);
    if (cred) return err(`Refused: this looks like ${cred}. ${CREDENTIAL_MESSAGE}`);

    if (!args.force) {
      const dup = this.store.findSimilarActiveNote(title);
      // Report a duplicate only when the caller could read it anyway; otherwise the reply would leak
      // the note's title and body across clearance and applies_to boundaries.
      if (dup && atOrBelow(dup.sensitivity, clearance) && noteReachable(dup, agent)) {
        return text(`A similar active note already exists: ${dup.id} "${dup.title}": ${dup.body.slice(0, 300)}\nUse update with id ${dup.id}, or pass force: true to add this as a new one anyway.`, true);
      }
    }
    const id = this.store.insertNote(
      { kind: args.kind, title, body, topics: args.topics ? String(args.topics) : "", applies_to: args.applies_to ? String(args.applies_to) : "all", sensitivity },
      { by: agent }
    );
    // Titles worded differently slip past dedup, so show the closest existing notes and let the agent merge.
    const related = this.store
      .searchNotes(title, { limit: 4 })
      .filter((n) => n.id !== id && noteReachable(n, agent) && atOrBelow(n.sensitivity, clearance))
      .slice(0, 2);
    const hint = related.length ? `\nRelated notes (if one already covers this, update it and retire nothing; the operator will merge): ${related.map((n) => `${n.id} "${n.title}"`).join("; ")}` : "";
    return text(`Saved as ${id}.${hint}`);
  }

  _update(agent, args) {
    const id = args.id;
    const why = String(args.why || "").trim();
    if (!id) return err(`"id" is required`);
    if (!why) return err(`"why" is required`);
    const note = this.store.getNote(id);
    if (!note) return err(`no note ${id}`);
    if (note.status === "retired") return err(`${id} is retired; it can't be updated`);
    const title = args.title !== undefined ? String(args.title).trim() : undefined;
    const body = args.body !== undefined ? String(args.body).trim() : undefined;
    if (title !== undefined && title.length > TITLE_MAX) return err(`"title" is too long (max ${TITLE_MAX} chars)`);
    if (body !== undefined && body.length > BODY_MAX) return err(`"body" is too long (max ${BODY_MAX} chars)`);
    const cred = findCredential(title, body);
    if (cred) return err(`Refused: this looks like ${cred}. ${CREDENTIAL_MESSAGE}`);
    const clearance = this.clearanceOf(agent);
    if (levelIndex(note.sensitivity) > levelIndex(clearance)) return err(`you don't have clearance to edit ${id} (${note.sensitivity})`);
    this.store.updateNote(id, { title, body, topics: args.topics !== undefined ? String(args.topics) : undefined }, { by: agent, why });
    return text(`Updated ${id}.`);
  }

  _flag(agent, args) {
    const ref = args.id_or_key;
    const problem = String(args.problem || "").trim();
    if (!ref) return err(`"id_or_key" is required`);
    if (!problem) return err(`"problem" is required`);
    const isNote = String(ref).startsWith("n_");
    const cur = isNote ? this.store.getNote(ref) : this.store.getFact(ref);
    if (!cur || !atOrBelow(cur.sensitivity, this.clearanceOf(agent))) return err(`no such note or fact "${ref}"`);
    if (isNote) this.store.flagNote(ref, problem, agent);
    else this.store.flagFact(ref, problem, agent);
    return text(`Flagged ${ref}.`);
  }

  _setFact(agent, args) {
    if (!this.isAdmin(agent)) return err(`"${agent}" is not a memory admin. Use remember with kind "tip" to propose a correction, or flag the existing fact.`);
    const key = String(args.key || "").trim().toLowerCase();
    if (!/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/.test(key)) return err(`"key" must look like entity.field, lowercase (e.g. acme.legal_name)`);
    const value = args.value === undefined || args.value === null ? "" : String(args.value).trim();
    if (!value) return err(`"value" is required`);
    const source = String(args.source || "").trim();
    if (!source) return err(`"source" is required`);
    const why = String(args.why || "").trim();
    if (!why) return err(`"why" is required`);
    const sensitivity = args.sensitivity || "internal";
    if (!LEVELS.includes(sensitivity)) return err(`"sensitivity" must be one of ${LEVELS.join(", ")}`);
    const clearance = this.clearanceOf(agent);
    if (levelIndex(sensitivity) > levelIndex(clearance)) return err(`you can't write at sensitivity "${sensitivity}" (your clearance is "${clearance}")`);
    const cred = findCredential(args.label, value, args.note);
    if (cred) return err(`Refused: this looks like ${cred}. ${CREDENTIAL_MESSAGE}`);
    const { key: k, inserted, version } = this.store.upsertFact({ key, label: args.label, value, sensitivity, note: args.note, source }, { by: agent, why, verified: false });
    return text(`${inserted ? "Added" : "Updated"} ${k} (v${version}).`);
  }

  // -- history (redacted above caller clearance) -------------------------------

  _history(agent, args) {
    const ref = args.id_or_key;
    if (!ref) return err(`"id_or_key" is required`);
    const refType = String(ref).startsWith("n_") ? "note" : "fact";
    const key = refType === "fact" ? String(ref).toLowerCase() : ref;
    const rows = this.store.getHistory(refType, key, clamp(args.limit, 20, 100));
    if (!rows.length) return text(`No history for ${ref}.`);
    const clearance = this.clearanceOf(agent);
    const lines = rows.map((r) => {
      const snap = r.snapshot;
      const redacted = snap?.sensitivity && !atOrBelow(snap.sensitivity, clearance);
      // Restricted/secret values are only ever revealed through get_fact/profile (reason + access log), never history.
      const gated = refType === "fact" && snap?.sensitivity && !atOrBelow(snap.sensitivity, "internal");
      let detail;
      if (redacted) detail = refType === "fact" ? "value: [redacted: needs higher clearance]" : "body: [redacted: needs higher clearance]";
      else if (gated) detail = "value: [not shown; use get_fact with a reason]";
      else if (snap) detail = refType === "fact" ? `value was: ${snap.value}` : `title was: ${snap.title}`;
      return `${r.ts.slice(0, 19)} ${r.action} by ${r.by || "?"}${r.why ? `: ${r.why}` : ""}${detail ? ` · ${detail}` : ""}`;
    });
    return text(lines.join("\n"));
  }
}
