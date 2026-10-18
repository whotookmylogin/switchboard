#!/usr/bin/env node
/**
 * Rebuild the lookup directory (data/directory.sqlite) from config/directory.yaml sources.
 * A source that fails keeps its entries from the previous build.
 *
 * Run: node tools/directory_refresh.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { Registry, interpolate } from "../src/registry.js";
import { buildDirectory, KINDS } from "../src/lookup.js";

const COMMAND_TIMEOUT_MS = 60000;

const ROOT = resolve(process.env.SB_HOME || join(dirname(fileURLToPath(import.meta.url)), ".."));
const CONFIG_DIR = process.env.SB_CONFIG_DIR || join(ROOT, "config");
const OUT = process.env.SB_DIRECTORY || join(ROOT, "data", "directory.sqlite");
const CONFIG_PATH = process.env.SB_DIRECTORY_CONFIG || join(CONFIG_DIR, "directory.yaml");

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const join_ = (...parts) => parts.filter((p) => p !== undefined && p !== null && p !== "").join(" · ");

/**
 * Call a Slack Web API method, following cursor pagination for list methods.
 * @param {string} token
 * @param {string} method
 * @param {object} params
 * @param {string} [listKey]
 */
async function slack(token, method, params, listKey) {
  const out = [];
  let cursor = "";
  do {
    const body = new URLSearchParams({ ...params, ...(cursor ? { cursor } : {}) });
    const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
    const d = await r.json();
    if (!d.ok) throw new Error(`${method}: ${d.error}`);
    if (!listKey) return d;
    out.push(...(d[listKey] || []));
    cursor = d.response_metadata?.next_cursor || "";
  } while (cursor);
  return out;
}

/**
 * Parse tools/directory_guide.md-style markdown into guide entries.
 * @param {string} md
 * @returns {import("../src/lookup.js").Entry[]}
 */
export function parseGuideMarkdown(md) {
  return md
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const [title, ...rest] = block.trim().split("\n");
      const keysLine = rest.find((l) => l.startsWith("keys:")) || "";
      const body = rest.filter((l) => !l.startsWith("keys:")).join(" ").trim();
      return { kind: "guide", ref: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title, keys: keysLine.slice(5).trim(), line: `${title}: ${body}`, weight: 2 };
    });
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * @param {string} filePath
 * @param {Record<string, string>} [map]
 * @returns {import("../src/lookup.js").Entry[]}
 */
function loadFileEntries(filePath, map = {}) {
  const raw = readFileSync(filePath, "utf8").trim();
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const data = JSON.parse(raw);
    const rows = Array.isArray(data) ? data : data.entries || [];
    return rows.map((e) => ({
      kind: e.kind,
      ref: String(e.ref ?? ""),
      title: e.title,
      keys: e.keys || "",
      line: e.line,
      weight: Number(e.weight) || 0,
    }));
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const field = (row, name, fallback) => {
    const col = map[name] || name;
    const i = headers.indexOf(col);
    return i >= 0 ? row[i] : fallback;
  };
  return lines.slice(1).map((line) => {
    const row = parseCsvLine(line);
    return {
      kind: field(row, "kind", ""),
      ref: field(row, "ref", ""),
      title: field(row, "title", ""),
      keys: field(row, "keys", ""),
      line: field(row, "line", ""),
      weight: Number(field(row, "weight", "0")) || 0,
    };
  });
}

/**
 * Coerce and drop invalid directory rows before build.
 * @param {import("../src/lookup.js").Entry[]} rows
 * @param {string[]} warnings
 * @returns {import("../src/lookup.js").Entry[]}
 */
export function normalizeEntries(rows, warnings) {
  const out = [];
  for (const row of rows) {
    const kind = String(row.kind || "").trim();
    if (!KINDS.includes(kind)) {
      warnings.push(`skipped row: invalid or missing kind "${kind || "(empty)"}"`);
      continue;
    }
    const title = String(row.title ?? row.ref ?? "").trim();
    if (!title) {
      warnings.push("skipped row: missing title and ref");
      continue;
    }
    const line = String(row.line ?? title).trim();
    out.push({
      kind,
      ref: String(row.ref ?? ""),
      title,
      keys: String(row.keys ?? ""),
      line,
      weight: Number(row.weight) || 0,
    });
  }
  return out;
}

/**
 * @param {object} source
 * @param {Record<string, string>} vars
 * @param {string} configDir
 * @returns {Promise<import("../src/lookup.js").Entry[]>}
 */
async function loadSource(source, vars, configDir) {
  const resolved = interpolate(source, vars);
  const base = resolved.path && !isAbsolute(resolved.path) ? resolve(configDir, resolved.path) : resolved.path;
  if (source.type === "file") {
    if (!base || !existsSync(base)) throw new Error(`file not found: ${base || resolved.path}`);
    return loadFileEntries(base, resolved.map || {});
  }
  if (source.type === "guide") {
    if (!base || !existsSync(base)) throw new Error(`guide not found: ${base || resolved.path}`);
    return parseGuideMarkdown(readFileSync(base, "utf8"));
  }
  if (source.type === "command") {
    const cmd = resolved.command || resolved.cmd;
    if (!cmd) throw new Error("command source needs command:");
    const args = Array.isArray(cmd) ? cmd : [cmd];
    const r = spawnSync(args[0], args.slice(1), {
      encoding: "utf8",
      cwd: resolved.cwd || configDir,
      env: { ...process.env, ...vars },
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (r.error?.code === "ETIMEDOUT") throw new Error(`command timed out after ${COMMAND_TIMEOUT_MS}ms`);
    if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || `exit ${r.status}`).slice(0, 300));
    const rows = JSON.parse(r.stdout);
    if (!Array.isArray(rows)) throw new Error("command stdout must be a JSON array");
    return rows;
  }
  if (source.type === "slack") {
    const token = resolved.token;
    if (!token || token.includes("${")) throw new Error("slack source needs token: ${VAR}");
    const people = [];
    const members = await slack(token, "users.list", { limit: 200 }, "members");
    for (const u of members) {
      if (u.deleted || u.id === "USLACKBOT") continue;
      const name = u.real_name || u.profile?.real_name || u.name;
      const email = u.profile?.email || "";
      people.push({
        kind: "person",
        ref: u.id,
        title: name,
        keys: [email, u.id, `@${u.name}`].filter(Boolean).join(" "),
        line: join_(name, u.is_bot ? "bot" : "", u.profile?.title, email, `${u.id} @${u.name}`),
        weight: u.is_bot ? 0.5 : 2,
      });
    }
    const channels = [];
    const list = await slack(token, "conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: 200 }, "channels");
    for (const c of list) {
      channels.push({
        kind: "channel",
        ref: c.id,
        title: `#${c.name}`,
        keys: c.name,
        line: join_(`#${c.name}`, c.id, c.is_private ? "private" : "", c.num_members !== undefined ? `${c.num_members} members` : "", clip(c.purpose?.value || c.topic?.value, 90)),
        weight: 1 + Math.min((c.num_members || 0) / 100, 0.5),
      });
    }
    return [...people, ...channels];
  }
  throw new Error(`unknown source type: ${source.type}`);
}

/**
 * Rows from the previous build for one source name.
 * @param {string} path
 * @param {string} sourceName
 * @returns {import("../src/lookup.js").Entry[]}
 */
function previousEntries(path, sourceName) {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const cols = db.prepare("PRAGMA table_info(entries)").all().map((c) => c.name);
    if (!cols.includes("source")) return [];
    const rows = db
      .prepare(
        `SELECT e.source, e.kind, e.ref, e.title, e.line, e.weight, f.keys FROM entries e JOIN entries_fts f ON f.rowid = e.id WHERE e.source = ?`
      )
      .all(sourceName);
    return rows.map((r) => ({
      source: r.source,
      kind: r.kind,
      ref: r.ref,
      title: r.title,
      line: r.line,
      weight: r.weight,
      keys: String(r.keys || "").replace(/^\S*\s?/, ""),
    }));
  } finally {
    db.close();
  }
}

/**
 * Resolved env for directory sources (connections env_files + process env).
 * @param {string} configDir
 * @returns {Record<string, string>}
 */
export function directoryVars(configDir = CONFIG_DIR) {
  const conn = join(configDir, "connections.yaml");
  const agents = join(configDir, "agents.yaml");
  if (!existsSync(conn)) return { ...process.env };
  return { ...process.env, ...new Registry(conn, agents).vars };
}

/**
 * Load all directory entries from a directory.yaml file.
 * @param {string} configPath
 * @param {{ vars?: Record<string, string> }} [opts]
 * @returns {Promise<{ entries: import("../src/lookup.js").Entry[], counts: object, errors: object, warnings: string[] }>}
 */
export async function loadDirectoryFromConfig(configPath, opts = {}) {
  const configDir = dirname(resolve(configPath));
  const outPath = opts.outPath || OUT;
  const doc = YAML.parse(readFileSync(configPath, "utf8")) || {};
  const vars = opts.vars || {};
  const sources = doc.sources || [];
  const warnings = [];
  const errors = {};
  const counts = {};
  const entries = [];
  for (const source of sources) {
    const name = source.name || source.type || "source";
    try {
      const raw = await loadSource(source, vars, configDir);
      const got = normalizeEntries(raw, warnings).map((e) => ({ ...e, source: name }));
      entries.push(...got);
      counts[name] = got.length;
    } catch (e) {
      errors[name] = String(e.message || e).slice(0, 300);
      const old = previousEntries(outPath, name);
      entries.push(...old);
      counts[name] = `${old.length} (kept from last build)`;
      warnings.push(`${name}: ${errors[name]}`);
    }
  }
  return { entries, counts, errors, warnings };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const t0 = Date.now();
  const vars = directoryVars(CONFIG_DIR);
  const { entries, counts, errors, warnings } = await loadDirectoryFromConfig(CONFIG_PATH, { vars });
  buildDirectory(OUT, entries, { counts, errors, warnings, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(JSON.stringify({ at: new Date().toISOString(), entries: entries.length, counts, errors, warnings, seconds: Math.round((Date.now() - t0) / 1000) }));
  if (Object.keys(errors).length) process.exitCode = 1;
}
