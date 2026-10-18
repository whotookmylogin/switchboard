/**
 * Token-saving shaping for agents with `compact: true` in agents.yaml (front doors billed per token).
 * Three layers, all applied inside Switchboard so connectors and other agents are untouched:
 *   - tool lists: shorter descriptions, no outputSchema
 *   - arguments: default LIMIT on SQL, clamp oversized count/limit params
 *   - results: JSON rows -> TSV, Slack API payloads -> one line per message/user/channel, other JSON minified
 */

const DESC_CHARS = 300;
const PROP_DESC_CHARS = 120;
const DEFAULT_SQL_LIMIT = 100;
const MAX_PAGE = 50;
const SLACK_TEXT_CHARS = 3000;
/** Search hits are for finding things; read the channel/thread for the full text. */
const SLACK_SEARCH_TEXT_CHARS = 500;
const PAGE_ARGS = new Set(["limit", "count", "max_results", "maxResults", "page_size", "pageSize", "per_page"]);
/** Timezone for rendered timestamps (Slack lines): SB_TZ, else the host's zone. */
const TZ = process.env.SB_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Shorten text to `max` chars, preferring a sentence end.
 * @param {string} s
 * @param {number} max
 */
function shorten(s, max) {
  if (typeof s !== "string" || s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return end > max / 2 ? cut.slice(0, end + 1) : cut.trimEnd() + "...";
}

/**
 * Shorten descriptions throughout a JSON schema (recursively), leaving types/enums/required intact.
 * @param {object} schema
 */
function compactSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(compactSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema" || k === "examples") continue;
    if (k === "description") out[k] = shorten(v, PROP_DESC_CHARS);
    else out[k] = typeof v === "object" ? compactSchema(v) : v;
  }
  return out;
}

/**
 * Compact one tool definition for a tools/list response.
 * @param {{name: string, description?: string, inputSchema?: object}} t
 */
export function compactTool(t) {
  const { outputSchema, annotations, ...rest } = t;
  return { ...rest, description: shorten(t.description || "", DESC_CHARS), inputSchema: compactSchema(t.inputSchema) };
}

/**
 * Apply default limits to a call's arguments.
 * @param {string} connector
 * @param {string} tool
 * @param {object} args
 * @param {{ defaultSqlLimit?: number|boolean }} [opts] - from connections.yaml `default_sql_limit`
 * @returns {{args: object, notes: string[]}}
 */
export function shapeArgs(connector, tool, args, opts = {}) {
  const notes = [];
  if (!args || typeof args !== "object") return { args, notes };
  const a = { ...args };
  for (const k of Object.keys(a)) {
    const n = Number(a[k]);
    if (PAGE_ARGS.has(k) && Number.isFinite(n) && n > MAX_PAGE) {
      a[k] = MAX_PAGE;
      notes.push(`${k} lowered from ${n} to ${MAX_PAGE}`);
    }
  }
  const sqlLimit = opts.defaultSqlLimit;
  if (tool === "query" && typeof a.sql === "string" && sqlLimit) {
    const limit = Number(sqlLimit) > 0 ? Math.round(Number(sqlLimit)) : DEFAULT_SQL_LIMIT;
    const sql = a.sql.trim().replace(/;\s*$/, "");
    if (/^(select|with)\b/i.test(sql) && !/\blimit\s+\d+/i.test(sql) && !/\bfetch\s+first\b/i.test(sql)) {
      a.sql = `${sql}\nLIMIT ${limit}`;
      notes.push(`added LIMIT ${limit}; add your own LIMIT if you really need more rows`);
    }
  }
  return { args: a, notes };
}

/** One-line, tab-free cell text. */
function cell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Date-only values arrive as midnight ISO timestamps; the time part is noise.
  if (/^\d{4}-\d\d-\d\dT00:00:00(\.000)?Z$/.test(s)) return s.slice(0, 10);
  return s.replace(/\t/g, " ").replace(/\r?\n/g, " ⏎ ");
}

/** True for a non-empty array whose items are all plain objects. */
const isRows = (v) => Array.isArray(v) && v.length > 0 && v.every((r) => r && typeof r === "object" && !Array.isArray(r));

/**
 * Rows -> TSV with one header line; columns that are empty in every row are dropped.
 * @param {object[]} rows
 */
export function toTsv(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const used = cols.filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined && r[c] !== ""));
  return [used.join("\t"), ...rows.map((r) => used.map((c) => cell(r[c])).join("\t"))].join("\n");
}

/** Drop null/empty values recursively so minified JSON carries only data. */
function prune(v) {
  if (Array.isArray(v)) return v.map(prune);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined || x === "" || (Array.isArray(x) && !x.length)) continue;
    out[k] = prune(x);
  }
  return out;
}

/**
 * Generic JSON compaction: an array of rows, or an object holding one rows array plus scalar metadata,
 * becomes "key: value" lines + TSV. Anything else is pruned and minified.
 * @param {*} data
 */
export function compactJson(data) {
  if (isRows(data)) return `${data.length} rows\n${toTsv(data)}`;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const rowKeys = Object.keys(data).filter((k) => isRows(data[k]));
    const rest = Object.keys(data).filter((k) => !rowKeys.includes(k));
    if (rowKeys.length === 1 && rest.every((k) => data[k] === null || typeof data[k] !== "object")) {
      const meta = rest.filter((k) => data[k] !== null && data[k] !== "").map((k) => `${k}: ${data[k]}`);
      return [...meta, toTsv(data[rowKeys[0]])].join("\n");
    }
  }
  return JSON.stringify(prune(data));
}

/** Slack ts -> "YYYY-MM-DD HH:MM" in the configured timezone (SB_TZ, else the host's zone). */
function slackTime(ts) {
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("sv-SE", { timeZone: TZ, hour12: false }).slice(0, 16);
}

/** Collect visible text from a Slack message: text, then attachments/blocks when text is empty (bot reports). */
function slackText(m, names, max = SLACK_TEXT_CHARS) {
  const parts = [];
  if (m.text) parts.push(m.text);
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const k of ["pretext", "title", "text", "fallback", "value"]) if (typeof v[k] === "string" && v[k]) parts.push(v[k]);
    for (const x of Object.values(v)) if (x && typeof x === "object") walk(x);
  };
  if (!m.text) walk([m.attachments, m.blocks]);
  if (m.files?.length) parts.push(`[files: ${m.files.map((f) => f.name || f.title).join(", ")}]`);
  const seen = new Set();
  let s = parts.filter((p) => !seen.has(p) && seen.add(p)).join(" | ");
  s = s.replace(/<@(U[A-Z0-9]+)>/g, (all, id) => (names?.get(id) ? `@${names.get(id)}` : all));
  return shorten(s, max);
}

/**
 * Slack Web API payload -> compact lines. Returns null when the payload isn't a shape we know.
 * @param {object} d - parsed Slack API response
 * @param {Map<string,string>} [names] - user id -> display name, for history and mentions
 */
export function compactSlack(d, names) {
  if (!d || typeof d !== "object") return null;
  if (d.ok === false) return `Slack error: ${d.error}`;
  const who = (m) => names?.get(m.user) || m.username || m.user_profile?.real_name || m.user || m.bot_profile?.name || m.bot_id || "";
  if (d.messages?.matches) {
    const ms = d.messages.matches;
    const lines = ms.map((m) => [slackTime(m.ts), `#${m.channel?.name || m.channel?.id || ""}`, who(m), slackText(m, names, SLACK_SEARCH_TEXT_CHARS), m.permalink || ""].map(cell).join("\t"));
    return [`${d.messages.total ?? ms.length} matches, showing ${ms.length}`, "time\tchannel\tuser\ttext\tlink", ...lines].join("\n");
  }
  if (Array.isArray(d.messages)) {
    const lines = d.messages.map((m) => {
      const thread = m.reply_count ? ` [${m.reply_count} replies]` : "";
      return [slackTime(m.ts), m.ts, who(m), slackText(m, names) + thread].map(cell).join("\t");
    });
    return [`${d.messages.length} messages${d.has_more ? " (more available)" : ""}`, "time\tts\tuser\ttext", ...lines].join("\n");
  }
  if (Array.isArray(d.members)) {
    const live = d.members.filter((u) => !u.deleted);
    const lines = live.map((u) => [u.id, u.name, u.real_name || u.profile?.real_name || "", u.profile?.title || "", u.is_bot ? "bot" : ""].map(cell).join("\t"));
    return [`${live.length} active users (${d.members.length - live.length} deactivated hidden)`, "id\tname\treal_name\ttitle\tbot", ...lines].join("\n");
  }
  if (d.user && typeof d.user === "object") {
    const u = d.user;
    return JSON.stringify(prune({ id: u.id, name: u.name, real_name: u.real_name, title: u.profile?.title, email: u.profile?.email, tz: u.tz, is_bot: u.is_bot || undefined, deleted: u.deleted || undefined }));
  }
  if (Array.isArray(d.channels)) {
    const lines = d.channels.map((c) => [c.id, c.name || (c.is_im ? `dm:${names?.get(c.user) || c.user}` : ""), c.is_private ? "private" : "", c.num_members ?? "", shorten(c.topic?.value || c.purpose?.value || "", 80)].map(cell).join("\t"));
    return [`${d.channels.length} channels`, "id\tname\tprivate\tmembers\ttopic", ...lines].join("\n");
  }
  if (d.channel && d.ts) return `ok: posted ts=${d.ts} channel=${typeof d.channel === "object" ? d.channel.id : d.channel}`;
  return null;
}

/**
 * Compact a tool result's text content. Errors and non-JSON text pass through unchanged.
 * @param {string} connector
 * @param {object} result - MCP CallToolResult
 * @param {{names?: Map<string,string>, notes?: string[], slack?: boolean}} [opts] - `slack` forces the
 *   Slack shaper on (connections.yaml `slack_shaping: true`); `slack-*` connector names already imply it
 */
export function shapeResult(connector, result, opts = {}) {
  if (!result || result.isError || !Array.isArray(result.content)) return result;
  const content = result.content.map((c) => {
    if (c.type !== "text" || typeof c.text !== "string") return c;
    const raw = c.text.trim();
    if (!/^[[{]/.test(raw)) return c;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return c;
    }
    const slackShaped = opts.slack === true || connector.startsWith("slack-");
    const text = (slackShaped && compactSlack(data, opts.names)) || compactJson(data);
    return { type: "text", text };
  });
  if (opts.notes?.length) content.push({ type: "text", text: `[Switchboard: ${opts.notes.join("; ")}]` });
  // structuredContent duplicates the text for the model; outputSchema is stripped from compact tool lists too.
  const { structuredContent, ...rest } = result;
  return { ...rest, content };
}
