/**
 * Built-in `notes` connector: indexes a folder of markdown notes (e.g. Claude Code memory files) so every
 * agent can search them, the same way src/lookup.js exposes the small reference directory.
 *
 * Source files live under `data/notes/<host>/*.md` (SB_NOTES_DIR overrides the base dir). Each file uses
 * YAML frontmatter (`name`, `description`, `metadata.type`, plus sometimes extra keys we ignore) followed by
 * a markdown body. tools/notes_refresh.mjs reads that tree and
 * calls buildNotesIndex (atomic tmp + rename, same pattern as lookup.js's buildDirectory); this module also
 * searches the resulting SQLite file (searchNotes/readNote) and serves the MCP tool surface (NotesBackend).
 *
 * REDACTION happens once, at index time, never at read time: a line that looks like it carries a live
 * credential is dropped before it's ever written to the index, so there is nothing to leak later. See
 * `redactBody` / `CREDENTIAL_LINE_PATTERNS` below. When in doubt a line is withheld, not kept — a few extra
 * withheld lines cost nothing; one leaked password costs a lot.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const TYPES = ["user", "feedback", "project", "reference"];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const READ_BODY_MAX = 6000;
const SNIPPET_MAX = 220;

// --- redaction ----------------------------------------------------------------

/**
 * Line patterns that mark a credential, checked as plain (non-anchored) substrings so a word embedded in
 * a longer identifier (kcpassword, AutoLoginPassword) still trips it — intentionally looser than word
 * boundaries, per "err on the side of withholding".
 */
const CREDENTIAL_LINE_PATTERNS = [
  /password/i,
  /passwd/i,
  /passphrase/i,
  /secret/i,
  /\bpw\b/i, // "pw:", "pw =", or bare "pw" (word-bounded so it doesn't catch "upward")
  /xox[abpe]-/i, // Slack token
  /sk-[A-Za-z0-9]{10,}/, // OpenAI-style key
  /pk_[A-Za-z0-9]{10,}/, // Stripe-style publishable/secret key
  /ghp_|github_pat_/, // GitHub token
  /AKIA[0-9A-Z]{12,}/, // AWS access key
  /-----BEGIN/, // PEM private key block
  /api[_ -]?key\s*[:=]/i,
  /\bssn\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-shaped number
  /\b(fein|ein)\b[^\n]{0,20}\d/i, // FEIN/EIN followed by digits somewhere on the line
  /\b(routing|account|acct)\b[^\n]{0,30}\b\d{9,17}\b/i, // routing/account number
  /\bsshpass\b/i, // sshpass's entire job is passing a password non-interactively, with or without -p
  /unlock-keychain/i, // macOS `security unlock-keychain -p <password>`
  /sudo\s+-s\b/i, // `sudo -S` reads the password from stdin (commonly `echo <pw> | sudo -S ...`)
  /`[^`\n]+`\s*\/\s*`[^`\n]+`/, // shorthand for a credential pair, e.g. `` `user` / `pass` ``
  /\b(ssh|key|login|auth\w*|cred\w*)\b[^\n]{0,30}\brejected\b/i, // "key + <value> rejected" style denial notes
];

/**
 * Redact one markdown body: any line matching a credential pattern is replaced whole.
 * @param {string} body
 * @returns {{body: string, withheld: number}}
 */
export function redactBody(body) {
  let withheld = 0;
  // Markdown tables whose header names a credential column (| SSID | Password |) carry the secret in
  // every data row with nothing on the row itself to match, so the whole table body is withheld.
  let secretTable = false;
  const lines = String(body || "")
    .split("\n")
    .map((line) => {
      const isRow = /^\s*\|/.test(line);
      if (!isRow) secretTable = false;
      else if (!secretTable && SECRET_TABLE_HEADER.test(line)) secretTable = true;
      else if (secretTable && !/^\s*\|[\s:|-]+\|?\s*$/.test(line)) {
        withheld++;
        return "[row withheld: credential table]";
      }
      if (CREDENTIAL_LINE_PATTERNS.some((re) => re.test(line))) {
        withheld++;
        return "[line withheld: credential]";
      }
      return line;
    });
  return { body: lines.join("\n"), withheld };
}

/** A table header cell naming a credential column. */
const SECRET_TABLE_HEADER = /\|\s*(password|passwd|passphrase|pw|pin|secret|token|api key|key|credentials?)\s*\|/i;

// --- file parsing ---------------------------------------------------------------

/**
 * Strip matching surrounding quotes from a frontmatter scalar, the way YAML would, unescaping \" inside a
 * double-quoted value. Left alone (not a real YAML string) when the quotes don't actually match end to
 * end — e.g. a value that merely starts with a quote character, like `"node-a" = example host name`.
 * @param {string} s
 */
function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\(.)/g, "$1") : inner.replace(/''/g, "'");
  }
  return s;
}

/**
 * Parse one Claude Code memory-note file: "---\n<frontmatter>\n---\n<body>". The frontmatter is read
 * line by line rather than with a real YAML parser, because a meaningful fraction of these ~300 files
 * have an unescaped ":" or a stray quote in their free-text `description` (written by a model, not
 * validated as YAML) that a strict parser refuses outright. We only ever need three scalar fields (name,
 * description, metadata.type), so a line scanner is both more forgiving and good enough.
 *
 * Returns null when the file has no frontmatter or no `name` (e.g. MEMORY.md, the index itself, or a
 * file saved with `name: ""`, both intentionally skipped).
 * @param {string} raw - file contents
 */
export function parseNoteFile(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  let name = "";
  let description = "";
  let type = null;
  let inMetadata = false;
  for (const line of m[1].split(/\r?\n/)) {
    const nameM = /^name:\s*(.*)$/.exec(line);
    const descM = /^description:\s*(.*)$/.exec(line);
    if (nameM) {
      name = unquote(nameM[1].trim());
      inMetadata = false;
    } else if (descM) {
      description = unquote(descM[1].trim());
      inMetadata = false;
    } else if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
    } else if (inMetadata) {
      if (!/^\s/.test(line)) {
        inMetadata = false; // back to top-level (unindented) frontmatter
      } else {
        const typeM = /^\s+type:\s*(.+)$/.exec(line);
        if (typeM) type = unquote(typeM[1].trim());
      }
    }
  }
  if (!name) return null;
  return { name, description, type: TYPES.includes(type) ? type : "reference", body: m[2].trim() };
}

/**
 * Read every `*.md` file under `baseDir/<host>/`, parse, redact, and keep the newest mtime when the same
 * note `name` appears under more than one host.
 * @param {string} baseDir
 * @returns {{entries: Array<object>, withheld: number, skipped: number}}
 */
export function collectNotes(baseDir) {
  const byName = new Map();
  let withheld = 0;
  let skipped = 0;
  const hosts = existsSync(baseDir) ? readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  for (const h of hosts) {
    const hostDir = join(baseDir, h.name);
    for (const f of readdirSync(hostDir)) {
      if (!f.endsWith(".md") || f === "MEMORY.md") continue;
      const path = join(hostDir, f);
      let parsed;
      try {
        parsed = parseNoteFile(readFileSync(path, "utf8"));
      } catch {
        parsed = null;
      }
      if (!parsed) {
        skipped++;
        continue;
      }
      const mtime = statSync(path).mtimeMs;
      const prev = byName.get(parsed.name);
      if (prev && prev.mtime >= mtime) continue; // keep the newer copy across hosts
      const { body, withheld: w } = redactBody(parsed.body);
      withheld += w;
      byName.set(parsed.name, { name: parsed.name, host: h.name, type: parsed.type, description: parsed.description, body, mtime, updated: new Date(mtime).toISOString().slice(0, 10) });
    }
  }
  return { entries: [...byName.values()], withheld, skipped };
}

/**
 * Write a fresh notes index atomically (build next to it, then rename over it).
 * @param {string} path - sqlite file
 * @param {Array<{name:string, host:string, type:string, description:string, body:string, mtime:number, updated:string}>} entries
 * @param {object} [meta]
 */
export function buildNotesIndex(path, entries, meta = {}) {
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec(`
    CREATE TABLE notes (name TEXT PRIMARY KEY, host TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, mtime INTEGER NOT NULL, updated TEXT NOT NULL);
    CREATE INDEX notes_type ON notes(type);
    CREATE VIRTUAL TABLE notes_fts USING fts5(name, description, body, tokenize='porter unicode61');
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const ins = db.prepare("INSERT INTO notes (rowid, name, host, type, description, body, mtime, updated) VALUES (?,?,?,?,?,?,?,?)");
  const fts = db.prepare("INSERT INTO notes_fts (rowid, name, description, body) VALUES (?,?,?,?)");
  db.exec("BEGIN");
  entries.forEach((e, i) => {
    ins.run(i + 1, e.name, e.host, e.type, e.description, e.body, Math.round(e.mtime), e.updated);
    fts.run(i + 1, e.name, e.description, e.body);
  });
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries({ built_at: new Date().toISOString(), entries: entries.length, ...meta })) setMeta.run(k, typeof v === "string" ? v : JSON.stringify(v));
  db.exec("COMMIT");
  db.close();
  renameSync(tmp, path);
}

/** Quote a term for an FTS5 MATCH expression (same helper as src/lookup.js — neutralizes FTS syntax chars). */
const ftsTerm = (w) => `"${w.replace(/"/g, '""')}"`;

/**
 * Cut a snippet to at most `max` chars without splitting mid-word, appending an ellipsis when trimmed.
 * @param {string} s
 * @param {number} max
 */
function clipSnippet(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

/**
 * Search the notes index. One compact entry per hit: a header line (name, type, updated date,
 * description) and an excerpt line centered on the best match.
 * @param {string} path
 * @param {{q?: string, limit?: number, type?: string}} args
 * @returns {string}
 */
export function searchNotes(path, { q = "", limit, type } = {}) {
  if (!existsSync(path)) return "Notes index not built yet (tools/notes_refresh.mjs).";
  const query = String(q).trim();
  if (!query) return "Pass q (words to search for) and optionally type: " + TYPES.join(", ") + ".";
  const n = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const t = type && TYPES.includes(type) ? type : null;
  if (type && !t) return `Unknown type "${type}". Types: ${TYPES.join(", ")}.`;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const typeSql = t ? "AND n.type = ?" : "";
    const typeArg = t ? [t] : [];
    const words = query
      .split(/\s+/)
      .map((w) => w.replace(/["*^]/g, ""))
      .filter(Boolean);
    if (!words.length) return `Pass q (words to search for) and optionally type: ${TYPES.join(", ")}.`;
    const run = (expr) =>
      db
        .prepare(
          `SELECT n.*, bm25(notes_fts, 8.0, 5.0, 1.0) AS score, snippet(notes_fts, -1, '', '', '…', 24) AS snip
             FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
            WHERE notes_fts MATCH ? ${typeSql} ORDER BY score LIMIT ?`
        )
        .all(expr, ...typeArg, n);
    let rows = run(words.map(ftsTerm).join(" AND "));
    if (!rows.length && words.length > 1) rows = run(words.map(ftsTerm).join(" OR "));
    if (!rows.length) return `No match for "${query}"${t ? ` in ${t}` : ""}.`;
    return rows
      .map((r) => `${r.name} (${r.type}, updated ${r.updated}): ${r.description}\n  …${clipSnippet(r.snip, SNIPPET_MAX)}…`)
      .join("\n");
  } finally {
    db.close();
  }
}

/**
 * Levenshtein-ish cheap distance for "did you mean" suggestions (character set overlap, not edit distance —
 * the dataset is small so this only needs to be good enough to rank 3 candidates, not exact).
 * @param {string} a @param {string} b
 */
function nameOverlap(a, b) {
  const sa = new Set(a.toLowerCase());
  const sb = new Set(b.toLowerCase());
  let hit = 0;
  for (const c of sa) if (sb.has(c)) hit++;
  return hit / Math.max(sa.size, sb.size, 1);
}

/**
 * Full redacted body of one note by exact name. If not found, suggests the 3 closest names.
 * @param {string} path
 * @param {{name?: string}} args
 * @returns {string}
 */
export function readNote(path, { name } = {}) {
  if (!existsSync(path)) return "Notes index not built yet (tools/notes_refresh.mjs).";
  const key = String(name || "").trim();
  if (!key) return "Pass name (from a search_notes result).";
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM notes WHERE name = ?").get(key);
    if (!row) {
      const all = db.prepare("SELECT name FROM notes").all().map((r) => r.name);
      const near = all
        .map((n) => ({ n, score: nameOverlap(key, n) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((r) => r.n);
      return `No note named "${key}".${near.length ? ` Closest: ${near.join(", ")}` : ""}`;
    }
    const truncated = row.body.length > READ_BODY_MAX;
    const body = truncated ? row.body.slice(0, READ_BODY_MAX) : row.body;
    const header = `${row.name} (${row.type}, host ${row.host}, updated ${row.updated}): ${row.description}\n\n`;
    return header + body + (truncated ? `\n\n[truncated at ${READ_BODY_MAX} chars; note is longer]` : "");
  } finally {
    db.close();
  }
}

/**
 * Notes index metadata (build time, counts) for status checks.
 * @param {string} path
 */
export function notesMeta(path) {
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
    name: "search_notes",
    description: "Search indexed markdown notes (decisions, gotchas, runbooks). Returns up to 5 short hits with name + excerpt. Call read_note on the one you need for the full body.",
    inputSchema: {
      type: "object",
      required: ["q"],
      properties: {
        q: { type: "string", description: "Words to search for" },
        limit: { type: "number", description: "Max hits (default 5, max 10)" },
        type: { type: "string", enum: TYPES, description: "Optional filter" },
      },
    },
  },
  {
    name: "read_note",
    description: "Full redacted body of one note by its exact name (from a search_notes hit).",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export class NotesBackend {
  /** @param {string} path - notes SQLite file */
  constructor(path) {
    this.path = path;
    this.name = "notes";
    this.conn = { name: "notes", builtin: true };
    this.client = true;
    this.pid = null;
    this.restarts = 0;
    this.inflight = 0;
    this.startedAt = new Date();
  }

  async start() {}
  async stop() {}

  info() {
    return {
      serverInfo: { name: "switchboard-notes", version: "1" },
      capabilities: { tools: {} },
      instructions: "Indexed markdown notes synced from your notes folder; search_notes first, read_note only for the one you need.",
    };
  }

  /** @param {{method: string, params?: object}} req */
  async request(req) {
    if (req.method === "tools/list") return { tools: TOOLS };
    if (req.method !== "tools/call") return text(`unsupported method ${req.method}`, true);
    const name = req.params?.name;
    const args = req.params?.arguments ?? {};
    try {
      if (name === "search_notes") return text(searchNotes(this.path, args));
      if (name === "read_note") return text(readNote(this.path, args));
      return text(`unknown tool ${name}`, true);
    } catch (e) {
      return text(`notes failed: ${e.message}`, true);
    }
  }
}
