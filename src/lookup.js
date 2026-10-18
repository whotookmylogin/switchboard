/**
 * Built-in `lookup` connector: one fuzzy search over a small reference directory (people, Slack channels,
 * customers, vendors, stock, products, helpdesk teams, how-to guide) so agents get the one row they need
 * instead of calling list-everything tools (200 KB Slack user lists, list_tables, schema exploration).
 *
 * The directory is a SQLite file rebuilt by tools/directory_refresh.mjs (cron); this module both writes it
 * (buildDirectory, atomic rename) and searches it (LookupBackend). Search uses an FTS5 trigram index, so
 * partial words and IDs match ("alex", "805", "example.com").
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";

export const KINDS = ["person", "channel", "customer", "account", "vendor", "stock", "product", "team", "guide"];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/**
 * @typedef {object} Entry
 * @property {string} kind - one of KINDS
 * @property {string} ref - the entry's own id (Slack id, stocknum, custnum, domain, ...)
 * @property {string} title - display name, searched with the highest weight
 * @property {string} line - the one-line answer returned to the agent
 * @property {string} [keys] - extra searchable ids/aliases (emails, other system ids)
 * @property {number} [weight] - ranking boost, 0..3 (bigger customers, active people)
 * @property {string} [source] - directory.yaml source name that produced this row
 */

/**
 * Write a fresh directory file atomically (build next to it, then rename over it).
 * @param {string} path
 * @param {Entry[]} entries
 * @param {object} [meta] - stored in the meta table (built_at, counts, source errors)
 */
export function buildDirectory(path, entries, meta = {}) {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec(`
    CREATE TABLE entries (id INTEGER PRIMARY KEY, source TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, ref TEXT, title TEXT NOT NULL, line TEXT NOT NULL, weight REAL DEFAULT 0);
    CREATE INDEX entries_kind ON entries(kind);
    CREATE INDEX entries_ref ON entries(lower(ref));
    CREATE INDEX entries_source ON entries(source);
    CREATE VIRTUAL TABLE entries_fts USING fts5(title, keys, line, tokenize='trigram');
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const ins = db.prepare("INSERT INTO entries (id, source, kind, ref, title, line, weight) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const fts = db.prepare("INSERT INTO entries_fts (rowid, title, keys, line) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  entries.forEach((e, i) => {
    const title = String(e.title ?? e.ref ?? "");
    const line = String(e.line ?? title);
    ins.run(i + 1, String(e.source ?? ""), e.kind, String(e.ref ?? ""), title, line, Number(e.weight) || 0);
    fts.run(i + 1, e.title, `${e.ref ?? ""} ${e.keys ?? ""}`, e.line);
  });
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries({ built_at: new Date().toISOString(), entries: entries.length, ...meta })) setMeta.run(k, typeof v === "string" ? v : JSON.stringify(v));
  db.exec("COMMIT");
  db.close();
  renameSync(tmp, path);
}

/** Quote a term for an FTS5 MATCH expression. */
const ftsTerm = (w) => `"${w.replace(/"/g, '""')}"`;

/**
 * Search the directory.
 * @param {string} path - directory file
 * @param {{q?: string, kind?: string, limit?: number}} args
 * @returns {string} compact answer lines
 */
export function searchDirectory(path, { q = "", kind, limit } = {}) {
  if (!existsSync(path)) return "Directory not built yet (tools/directory_refresh.mjs).";
  const n = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const k = kind && KINDS.includes(kind) ? kind : null;
  if (kind && !k) return `Unknown kind "${kind}". Kinds: ${KINDS.join(", ")}.`;
  const query = String(q).trim();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const kindSql = k ? "AND e.kind = ?" : "";
    const kindArg = k ? [k] : [];
    let rows = [];
    if (!query) {
      if (!k) return `Pass q (a name, id, email, stock number...) and optionally kind: ${KINDS.join(", ")}.`;
      rows = db.prepare(`SELECT e.* FROM entries e WHERE 1=1 ${kindSql} ORDER BY weight DESC, title LIMIT ?`).all(...kindArg, n + 1);
    } else {
      const seen = new Set();
      const add = (rs) => rs.forEach((r) => !seen.has(r.id) && seen.add(r.id) && rows.push(r));
      // 1) exact id / ref match ("805", "U01ABC", "example.com")
      add(db.prepare(`SELECT e.* FROM entries e WHERE lower(e.ref) = lower(?) ${kindSql} LIMIT ?`).all(query, ...kindArg, n + 1));
      const words = query.split(/\s+/).filter((w) => w.length >= 3);
      if (words.length) {
        const ranked = (expr) =>
          db
            .prepare(`SELECT e.*, bm25(entries_fts, 10.0, 6.0, 1.0) - e.weight AS score FROM entries_fts f JOIN entries e ON e.id = f.rowid WHERE entries_fts MATCH ? ${kindSql} ORDER BY score LIMIT ?`)
            .all(expr, ...kindArg, n + 1);
        // 2) all words, then 3) any word
        add(ranked(words.map(ftsTerm).join(" AND ")));
        if (rows.length < n && words.length > 1) add(ranked(words.map(ftsTerm).join(" OR ")));
      } else {
        // terms under 3 chars can't use the trigram index: prefix match on title/ref
        add(db.prepare(`SELECT e.* FROM entries e WHERE (e.title LIKE ? OR e.ref LIKE ?) ${kindSql} ORDER BY weight DESC LIMIT ?`).all(`${query}%`, `${query}%`, ...kindArg, n + 1));
      }
    }
    if (!rows.length) return `No match for "${query}"${k ? ` in ${k}` : ""}. Try fewer letters, an id, or another kind.`;
    const more = rows.length > n;
    const out = rows.slice(0, n).map((r) => `${r.kind}: ${r.line}`);
    if (more) out.push(`(more matches; add a word or kind to narrow)`);
    return out.join("\n");
  } finally {
    db.close();
  }
}

/**
 * Directory metadata (build time, counts, source errors) for status checks.
 * @param {string} path
 */
export function directoryMeta(path) {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

const TOOLS = [
  {
    name: "lookup",
    description:
      "Find people, Slack channels, customers, vendors, stock/materials, products, helpdesk teams, or how-to guide entries by name, id, email or stock number. Returns 1-5 one-line answers with ids for other tools. Use this before listing users/channels/tables.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Name, partial name, id, email, domain, stock or product number" },
        kind: { type: "string", enum: KINDS, description: "Optional filter" },
        limit: { type: "number", description: "Max answers (default 5, max 20)" },
      },
    },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export class LookupBackend {
  /** @param {string} path - directory SQLite file */
  constructor(path) {
    this.path = path;
    this.name = "lookup";
    this.conn = { name: "lookup", builtin: true };
    this.client = true;
    this.pid = null;
    this.restarts = 0;
    this.inflight = 0;
    this.startedAt = new Date();
  }

  async start() {}
  async stop() {}

  info() {
    const age = existsSync(this.path) ? Math.round((Date.now() - statSync(this.path).mtimeMs) / 60000) : null;
    return {
      serverInfo: { name: "switchboard-lookup", version: "1" },
      capabilities: { tools: {} },
      instructions: `Shared directory of people, channels, customers, vendors, stock, products and how-to notes${age === null ? " (not built yet)" : `, refreshed ${age} min ago`}. One small answer per lookup.`,
    };
  }

  /**
   * @param {{method: string, params?: object}} req
   */
  async request(req) {
    if (req.method === "tools/list") return { tools: TOOLS };
    if (req.method !== "tools/call") return text(`unsupported method ${req.method}`, true);
    if (req.params?.name !== "lookup") return text(`unknown tool ${req.params?.name}`, true);
    try {
      return text(searchDirectory(this.path, req.params?.arguments ?? {}));
    } catch (e) {
      return text(`lookup failed: ${e.message}`, true);
    }
  }
}
