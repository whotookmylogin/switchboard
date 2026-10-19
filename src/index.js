/**
 * Switchboard: one shared process per MCP connector, served over Streamable HTTP
 * to any number of agents, each with its own token, grants and audit trail.
 *
 *   POST /mcp/<connector>   Authorization: Bearer <agent token>
 *   POST /mcp               every connector the agent may use, as one server (tools named <connector>__<tool>)
 *   GET  /healthz           connector status (no secrets)
 *   /.well-known/*, /oauth/* OAuth 2.1 sign-in for agents that can't hold a static key (see oauth.js)
 *
 * Requests are handled statelessly (no MCP session ids), so restarting the
 * Switchboard never strands a client with a dead session.
 */
import http from "node:http";
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, CancelledNotificationSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Backend } from "./backend.js";
import { Registry } from "./registry.js";
import { handleRest, grantedTools } from "./rest.js";
import { ArpStore, ArpBackend } from "./arp.js";
import { TasksBackend } from "./tasks.js";
import { OAuth } from "./oauth.js";
import { makeNotifier } from "./notify.js";
import { compactTool, shapeArgs, shapeResult } from "./compact.js";
import { LookupBackend } from "./lookup.js";
import { MemoryStore, MemoryBackend } from "./memory.js";
import { NotesBackend } from "./notes.js";

const ROOT = resolve(process.env.SB_HOME || new URL("..", import.meta.url).pathname);
const CONFIG_DIR = process.env.SB_CONFIG_DIR || join(ROOT, "config");
const LOG_DIR = process.env.SB_LOG_DIR || join(ROOT, "logs");
const DATA_DIR = process.env.SB_DATA_DIR || join(ROOT, "data");
const PUBLIC_URL = process.env.SB_PUBLIC_URL || "http://127.0.0.1:3930";
const LISTEN = (process.env.SB_LISTEN || "127.0.0.1:3930").split(",").map((s) => s.trim()).filter(Boolean);
/** Bearer token that also unlocks /healthz for non-loopback callers (unset = loopback only). */
const HEALTHZ_TOKEN = process.env.SB_HEALTHZ_TOKEN || "";
/** Backend names that are built into this process (never sourced from connections.yaml, never HUP-restarted). */
const BUILTIN_BACKENDS = new Set(["agents", "tasks", "lookup", "memory", "notes"]);
const MAX_BODY = 20 * 1024 * 1024;
// Hermes rejects HTTP MCP responses over 10 MB (stdio has no cap). Results above this are trimmed so a
// huge tool result degrades to a shortened answer instead of an error. Hermes keeps ~30 KB for the model anyway.
const MAX_RESULT_BYTES = 9 * 1024 * 1024;
const TRIMMED_TEXT_CHARS = 1024 * 1024;

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
/** Written so `sb` can HUP the main process for a config reload when there's no systemd; removed on clean exit. */
const PID_FILE = join(DATA_DIR, "switchboard.pid");
writeFileSync(PID_FILE, `${process.pid}\n`);
const registry = new Registry(join(CONFIG_DIR, "connections.yaml"), join(CONFIG_DIR, "agents.yaml"));

/**
 * One-line text for a new ARP pending-approval card, e.g.
 * "ARP: arp-a wants tool_access from arp-b: need mock/echo. Approve: sb arp approve 4".
 * @param {object} pa - pending_approval fields (kind, agent_a, agent_b, summary, detail)
 */
function arpNotifyText(pa) {
  const kind = pa.kind === "notify" ? `${pa.detail?.type || "?"} request` : pa.kind;
  const to = pa.agent_b ? ` from ${pa.agent_b}` : "";
  const subject = pa.detail?.subject || pa.summary || "";
  return `ARP: ${pa.agent_a || "an agent"} wants ${kind}${to}: ${subject}. Approve: sb arp approve ${pa.id}`;
}

const arpStore = new ArpStore(join(DATA_DIR, "arp.sqlite"), {
  notify: (pa) =>
    makeNotifier(registry.vars || {}, { log })(arpNotifyText(pa), PUBLIC_URL).catch((e) =>
      log("events", { event: "arp_notify_failed", error: String(e?.message || e).slice(0, 200) })
    ),
  // An agent may only offer to lend access its own key can call.
  canCallTool: (agent, connector, tool) => registry.canCallTool(agent, connector, tool),
});
registry.setDynamicGrantLookup((agent, connector, tool) => arpStore.findActiveGrant(agent, connector, tool));

const oauth = new OAuth({
  dbPath: join(DATA_DIR, "oauth.sqlite"),
  publicUrl: PUBLIC_URL,
  registry,
  log: (k, r) => log(k, r),
  notify: (text, url) => makeNotifier(registry.vars || {}, { log })(text, url),
});

/**
 * Resolve a bearer token (static agent key or OAuth access token) to an agent, or null.
 * @param {string|undefined} token
 */
const authenticate = (token) => registry.authenticate(token) || oauth.authenticate(token);

/**
 * Append one JSON line to a dated log file.
 * @param {string} kind - "audit" or "events"
 * @param {object} rec
 */
function log(kind, rec) {
  const ts = new Date();
  const line = JSON.stringify({ ts: ts.toISOString(), ...rec }) + "\n";
  try {
    appendFileSync(join(LOG_DIR, `${kind}-${ts.toISOString().slice(0, 10)}.jsonl`), line);
  } catch {}
  if (kind === "events") process.stdout.write(line);
}

/** @type {Map<string, Backend>} */
const backends = new Map();

/** Start backends for new connectors, restart changed ones, stop removed ones. */
function syncBackends() {
  for (const [name, conn] of Object.entries(registry.connections)) {
    const cur = backends.get(name);
    if (cur && JSON.stringify(cur.conn) === JSON.stringify(conn)) continue;
    if (cur) cur.stop();
    const b = new Backend(conn, LOG_DIR, (e) => log("events", e));
    backends.set(name, b);
    b.start().catch(() => {});
  }
  for (const [name, b] of backends) {
    if (!registry.connections[name] && !BUILTIN_BACKENDS.has(name)) {
      b.stop();
      backends.delete(name);
      log("events", { event: "backend_removed", server: name });
    }
  }
}
backends.set("agents", new ArpBackend(arpStore));
backends.set("tasks", new TasksBackend(DATA_DIR));
backends.set("lookup", new LookupBackend(process.env.SB_DIRECTORY || join(DATA_DIR, "directory.sqlite")));
backends.set(
  "memory",
  new MemoryBackend(new MemoryStore(process.env.SB_MEMORY || join(DATA_DIR, "memory.sqlite")), {
    clearanceOf: (a) => registry.agents[a]?.memory_clearance || "internal",
    isAdmin: (a) => registry.agents[a]?.memory_admin === true,
  })
);
backends.set("notes", new NotesBackend(process.env.SB_NOTES_DB || join(DATA_DIR, "notes.sqlite")));

/**
 * In-flight tool calls keyed by agent|connector|requestId. Stateless HTTP delivers a client's
 * notifications/cancelled in a separate POST, so cancellation is routed through this map.
 * @type {Map<string, AbortController[]>}
 */
const inflight = new Map();

/**
 * Trim a tool result that would exceed the HTTP response cap: keep leading text, drop bulky blobs.
 * @param {object} result
 * @param {number} bytes - serialized size of result
 */
function trimResult(result, bytes) {
  let text = "";
  for (const c of result.content || []) if (c.type === "text") text += c.text;
  return {
    content: [{ type: "text", text: text.slice(0, TRIMMED_TEXT_CHARS) + `\n\n[Switchboard: result was ${(bytes / 1048576).toFixed(1)} MB; trimmed to fit.]` }],
    isError: result.isError,
  };
}

/**
 * Cut a result down to an agent's `max_result_kb` budget: keep leading text up to the last line break
 * that fits, drop images/blobs, and tell the model how to ask for less next time.
 * @param {object} result
 * @param {number} bytes - serialized size of result
 * @param {number} cap - byte budget for the agent
 */
function capResult(result, bytes, cap) {
  let text = "";
  for (const c of result.content || []) if (c.type === "text") text += c.text;
  let cut = text.slice(0, cap);
  const nl = cut.lastIndexOf("\n");
  if (nl > cap / 2) cut = cut.slice(0, nl);
  const note =
    `\n\n[Switchboard: result was ${Math.round(bytes / 1024)} KB; showing the first ${Math.round(cut.length / 1024)} KB. ` +
    "Ask for less instead of paging: SQL with LIMIT and only the columns you need, Slack search/read with a smaller count " +
    "and a specific channel or date range, ticket/email searches with tighter filters.]";
  return { content: [{ type: "text", text: cut + note }], isError: result.isError };
}

/** Slack user id -> name per connector, for compact agents' history/mention lines. @type {Map<string, {at: number, names: Map<string,string>}>} */
const slackNameCache = new Map();
const SLACK_NAMES_TTL_MS = 6 * 3600 * 1000;

/**
 * Cached user directory for a Slack connector (one users.list call per 6 h), so compact agents see names
 * instead of U-ids and don't pull the 200 KB user list themselves. Failures fall back to the last good map.
 * @param {Backend} backend
 */
async function slackNames(backend) {
  const hit = slackNameCache.get(backend.name);
  if (hit && Date.now() - hit.at < SLACK_NAMES_TTL_MS) return hit.names;
  try {
    const r = await backend.request({ method: "tools/call", params: { name: "slack_list_users", arguments: { limit: 500 } } }, {});
    const d = JSON.parse(r.content.find((c) => c.type === "text").text);
    const names = new Map((d.members || []).map((u) => [u.id, u.real_name || u.profile?.real_name || u.name]));
    slackNameCache.set(backend.name, { at: Date.now(), names });
    return names;
  } catch {
    return hit?.names;
  }
}

/** Short summary of tool arguments for the audit log (keys and sizes, never values). */
function argSummary(args) {
  if (!args || typeof args !== "object") return undefined;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v.length : typeof v]));
}

/**
 * Run one tool call for an agent: grant check, audit record, oversize trimming. Shared by MCP and REST.
 * A null `args` records a denial only.
 * @param {string} agent
 * @param {Backend} backend
 * @param {string} tool
 * @param {object|null} args
 * @param {AbortSignal|null} signal
 * @param {object} [extra] - { params, onprogress } passthrough from the MCP path
 */
async function callTool(agent, backend, tool, args, signal, extra = {}) {
  const t0 = Date.now();
  const rec = { agent, server: backend.name, method: "tools/call", tool, via: extra.via || (extra.params ? "mcp" : "rest"), ip: extra.ip };
  if (args === null || !registry.canCallTool(agent, backend.name, tool, args)) {
    log("audit", { ...rec, ok: false, denied: true });
    return { content: [{ type: "text", text: `Switchboard: agent "${agent}" is not granted ${backend.name}/${tool}.` }], isError: true };
  }
  try {
    const compact = registry.isCompact(agent);
    let notes = [];
    if (compact) {
      const lim = registry.connections[backend.name]?.default_sql_limit;
      ({ args, notes } = shapeArgs(backend.name, tool, args, { defaultSqlLimit: lim }));
    }
    const params = compact ? { ...(extra.params || {}), name: tool, arguments: args } : extra.params || { name: tool, arguments: args };
    let result = await backend.request({ method: "tools/call", params }, { signal, onprogress: extra.onprogress, agent });
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (compact) {
      // Slack-shaped results (and user-id -> name lookup) apply to connectors named slack-* or
      // explicitly flagged `slack_shaping: true` in connections.yaml.
      const slackShaped = registry.connections[backend.name]?.slack_shaping === true || backend.name.startsWith("slack-");
      const names = slackShaped && tool !== "slack_list_users" ? await slackNames(backend) : undefined;
      result = shapeResult(backend.name, result, { names, notes, slack: slackShaped });
    }
    const shaped = compact ? Buffer.byteLength(JSON.stringify(result)) : bytes;
    const cap = registry.maxResultBytes(agent);
    const capped = cap !== null && shaped > cap;
    const trimmed = !capped && shaped > MAX_RESULT_BYTES;
    if (capped) result = capResult(result, shaped, cap);
    else if (trimmed) result = trimResult(result, shaped);
    log("audit", { ...rec, ms: Date.now() - t0, ok: !result?.isError, bytes, sent: compact ? shaped : undefined, trimmed: trimmed || undefined, capped: capped || undefined, args: argSummary(args) });
    return result;
  } catch (err) {
    log("audit", { ...rec, ms: Date.now() - t0, ok: false, cancelled: signal?.aborted || undefined, error: String(err?.message || err).slice(0, 300) });
    throw err;
  }
}

/**
 * Build a per-request MCP Server that mirrors the backend and forwards everything to it.
 * @param {Backend} backend
 * @param {string} agent
 */
function makeProxy(backend, agent, httpRes) {
  const { serverInfo, capabilities, instructions } = backend.info();
  const server = new Server(serverInfo, { capabilities, instructions });
  const unrestricted = (registry.toolGrants(agent, backend.name) || []).includes("*") && !registry.hasDenies(agent, backend.name);

  server.setNotificationHandler(CancelledNotificationSchema, (n) => {
    const list = inflight.get(`${agent}|${backend.name}|${n.params.requestId}`) || [];
    // Only cancel when the id is unambiguous; otherwise let the call finish rather than risk stopping the wrong one.
    if (list.length === 1) list[0].abort(n.params.reason);
  });

  server.fallbackRequestHandler = async (req, extra) => {
    const t0 = Date.now();
    const tool = req.method === "tools/call" ? req.params?.name : undefined;
    const rec = { agent, server: backend.name, method: req.method, tool };
    const progressToken = req.params?._meta?.progressToken;
    // Progress is forwarded in order and flushed before the result, so the caller never sees it arrive late.
    let progressChain = Promise.resolve();
    const onprogress =
      progressToken === undefined
        ? undefined
        : (p) => (progressChain = progressChain.then(() => extra.sendNotification({ method: "notifications/progress", params: { ...p, progressToken } })).catch(() => {}));
    const key = `${agent}|${backend.name}|${extra.requestId}`;
    const ac = new AbortController();
    extra.signal.addEventListener("abort", () => ac.abort(), { once: true });
    // Caller hung up before the answer: stop the work on the connector too.
    httpRes.on("close", () => !httpRes.writableFinished && ac.abort());
    inflight.set(key, [...(inflight.get(key) || []), ac]);
    try {
      if (tool !== undefined) {
        const result = await callTool(agent, backend, tool, req.params?.arguments ?? {}, ac.signal, { params: req.params, onprogress });
        await progressChain;
        return result;
      }
      // The non-tool MCP surface (resources, prompts, completion) is only for agents with an unrestricted
      // grant on this connector: a filtered tool list must not open the rest of the server. Restricted agents
      // get empty lists (so client start-up still works) and a refusal for reads. logging/setLevel is never
      // forwarded: it would change verbosity for every agent sharing the connector.
      if (req.method === "logging/setLevel") return {};
      if (!unrestricted && /^(resources|prompts|completion)\//.test(req.method)) {
        const empty = { "resources/list": { resources: [] }, "resources/templates/list": { resourceTemplates: [] }, "prompts/list": { prompts: [] } }[req.method];
        if (empty) return empty;
        log("audit", { ...rec, ms: Date.now() - t0, ok: false, denied: true });
        throw new Error(`Switchboard: agent "${agent}" may not call ${req.method} on ${backend.name} without an unrestricted grant.`);
      }
      let result = await backend.request(req, { signal: ac.signal, onprogress });
      await progressChain;
      if (req.method === "tools/list" && !unrestricted && Array.isArray(result.tools)) {
        result = { ...result, tools: result.tools.filter((t) => registry.canCallTool(agent, backend.name, t.name)) };
      }
      if (req.method === "tools/list" && registry.isCompact(agent) && Array.isArray(result.tools)) {
        result = { ...result, tools: result.tools.map(compactTool) };
      }
      if (req.method !== "tools/list") log("audit", { ...rec, ms: Date.now() - t0, ok: true });
      return result;
    } catch (err) {
      if (tool === undefined) log("audit", { ...rec, ms: Date.now() - t0, ok: false, error: String(err?.message || err).slice(0, 300) });
      throw err;
    } finally {
      const rest = (inflight.get(key) || []).filter((x) => x !== ac);
      rest.length ? inflight.set(key, rest) : inflight.delete(key);
    }
  };
  return server;
}

/** Separator between connector and tool in combined-endpoint tool names. Connector names never contain it. */
const SEP = "__";

/**
 * Build a per-request MCP Server that exposes every tool the agent is granted, across all connectors,
 * as `<connector>__<tool>`. For front-door agents billed per token that take one MCP URL, not many.
 * @param {string} agent
 * @param {http.ServerResponse} httpRes
 * @param {string} [ip] - client IP from Cloudflare, recorded on each call
 */
function makeCombined(agent, httpRes, ip) {
  const server = new Server(
    { name: "switchboard", version: "1" },
    { capabilities: { tools: {} }, instructions: `Switchboard. Tool names are <connector>${SEP}<tool>, e.g. google-calendar${SEP}calendar_get_today.` }
  );
  const ctx = { backends, registry };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await grantedTools(ctx, agent)).map((t) => {
      const tool = { name: `${t.connector}${SEP}${t.name}`, description: `[${t.connector}] ${t.description}`, inputSchema: t.input_schema };
      return registry.isCompact(agent) ? compactTool(tool) : tool;
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const i = name.indexOf(SEP);
    const backend = i > 0 ? backends.get(name.slice(0, i)) : undefined;
    if (!backend) return { content: [{ type: "text", text: `Switchboard: unknown tool ${name}.` }], isError: true };
    const ac = new AbortController();
    extra.signal.addEventListener("abort", () => ac.abort(), { once: true });
    httpRes.on("close", () => !httpRes.writableFinished && ac.abort());
    return callTool(agent, backend, name.slice(i + SEP.length), req.params.arguments ?? {}, ac.signal, { via: "mcp-combined", ip });
  });
  return server;
}

/**
 * Read and JSON-parse a request body.
 * @param {http.IncomingMessage} req
 */
function readJson(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        ok(raw.trim() ? JSON.parse(raw) : undefined);
      } catch (e) {
        fail(e);
      }
    });
    req.on("error", fail);
  });
}

/**
 * Read a small request body as text (OAuth forms and registrations).
 * @param {http.IncomingMessage} req
 */
function readText(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** Parse a form-encoded or JSON body into URLSearchParams. */
function formParams(req, raw) {
  if (/json/i.test(req.headers["content-type"] || "")) {
    const j = raw.trim() ? JSON.parse(raw) : {};
    return new URLSearchParams(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  return new URLSearchParams(raw);
}

/**
 * OAuth discovery, registration, sign-in and token endpoints. Returns true when it handled the request.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 */
async function handleOAuth(req, res, url) {
  const p = url.pathname;
  const send = ([status, body, headers]) => {
    if (typeof body === "string") res.writeHead(status, headers).end(body);
    else sendJson(res, status, body, { "cache-control": "no-store", ...headers });
  };
  if (p.startsWith("/.well-known/oauth-protected-resource")) {
    sendJson(res, 200, oauth.protectedResource(p.slice("/.well-known/oauth-protected-resource".length)));
  } else if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) {
    sendJson(res, 200, oauth.authServer());
  } else if (p === "/oauth/register" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send([400, { error: "invalid_client_metadata" }]), true;
    }
    send(oauth.register(body));
  } else if (p === "/oauth/authorize" && req.method === "GET") {
    send(await oauth.authorize(url.searchParams));
  } else if (p === "/oauth/authorize/poll") {
    send(oauth.poll(url.searchParams));
  } else if (p === "/oauth/authorize/finish") {
    send(oauth.finish(url.searchParams));
  } else if (p === "/oauth/approve" && req.method === "GET") {
    send(oauth.approvePage(url.searchParams));
  } else if (p === "/oauth/approve" && req.method === "POST") {
    send(oauth.approve(formParams(req, await readText(req))));
  } else if (p === "/oauth/token" && req.method === "POST") {
    let params;
    try {
      params = formParams(req, await readText(req));
    } catch {
      return send([400, { error: "invalid_request" }]), true;
    }
    send(await oauth.token(params, req.headers.authorization));
  } else return false;
  return true;
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

/** Combined endpoint: authenticate, then serve every granted connector as one stateless MCP server. */
async function handleCombined(req, res) {
  const ip = req.headers["cf-connecting-ip"];
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || undefined;
  const agent = authenticate(token);
  if (!agent) {
    log("audit", { agent: "?", server: "-", method: `${req.method} /mcp`, ok: false, denied: true, error: token ? "bad token" : "missing token", ip });
    return sendJson(res, 401, { error: "invalid or missing token" }, { "www-authenticate": oauth.challenge("/mcp") });
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  let body;
  try {
    body = await readJson(req);
    if (body === undefined) throw new Error("empty body");
  } catch {
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  if (body?.method === "tools/list") log("audit", { agent, server: "-", method: "tools/list", via: "mcp-combined", ok: true, ip });
  const server = makeCombined(agent, res, ip);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/** HTTP entry point. */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  // Requests arriving through the Cloudflare tunnel carry cf-connecting-ip; status is local-only.
  const external = !!req.headers["cf-connecting-ip"];
  if (url.pathname === "/healthz") {
    const remote = req.socket.remoteAddress || "";
    const loopback = /^127\.|^::1$|^::ffff:127\./.test(remote);
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (external || (!loopback && !(HEALTHZ_TOKEN && bearer === HEALTHZ_TOKEN))) return sendJson(res, 404, { error: "not found" });
    const out = {};
    for (const [n, b] of backends) out[n] = { up: !!b.client, pid: b.pid, restarts: b.restarts, inflight: b.inflight, since: b.startedAt };
    return sendJson(res, 200, { ok: true, connectors: out });
  }
  if ((url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/oauth/")) && (await handleOAuth(req, res, url))) return;
  if (url.pathname.startsWith("/api/")) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-api-key"] || undefined;
    const agent = authenticate(token);
    if (!agent) {
      log("audit", { agent: "?", server: "-", method: `${req.method} ${url.pathname}`, ok: false, denied: true, error: token ? "bad API key" : "missing API key", ip: req.headers["cf-connecting-ip"] });
      return sendJson(res, 401, { error: "invalid or missing API key" });
    }
    return handleRest(req, res, url, agent, { backends, registry, callTool, readJson, sendJson, log });
  }
  if (url.pathname === "/mcp" || url.pathname === "/mcp/") return handleCombined(req, res);
  const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9_.-]+)\/?$/);
  if (!m) return sendJson(res, 404, { error: "not found" });
  const backend = backends.get(m[1]);
  if (!backend) return sendJson(res, 404, { error: `unknown connector ${m[1]}` });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || undefined;
  const agent = authenticate(token);
  if (!agent) return sendJson(res, 401, { error: "invalid or missing token" }, { "www-authenticate": oauth.challenge(url.pathname) });
  if (!registry.toolGrants(agent, backend.name)) {
    log("audit", { agent, server: backend.name, ok: false, denied: true });
    return sendJson(res, 403, { error: `agent ${agent} has no access to ${backend.name}` });
  }

  // Stateless mode has no standalone SSE stream or sessions to delete.
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  let body;
  try {
    body = await readJson(req);
    if (body === undefined) throw new Error("empty body");
  } catch (e) {
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  try {
    await backend.start();
  } catch (e) {
    return sendJson(res, 503, { jsonrpc: "2.0", error: { code: -32603, message: `connector ${backend.name} unavailable: ${e.message}` }, id: body?.id ?? null });
  }
  const server = makeProxy(backend, agent, res);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const servers = LISTEN.map((addr) => {
  const i = addr.lastIndexOf(":");
  const host = addr.slice(0, i);
  const port = Number(addr.slice(i + 1));
  const s = http.createServer((req, res) =>
    handle(req, res).catch((e) => {
      log("events", { event: "http_error", error: String(e?.stack || e) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    })
  );
  s.keepAliveTimeout = 65000;
  s.requestTimeout = 0; // long tool calls stream progress; don't cut them off
  s.listen(port, host, () => log("events", { event: "listening", addr: `${host}:${s.address()?.port ?? port}` }));
  return s;
});

syncBackends();

// ARP housekeeping: expire stale requests, queue T-2d grant-renewal cards. Cheap sync SQLite scan.
const arpSweepTimer = setInterval(() => {
  try {
    arpStore.sweep();
  } catch (e) {
    log("events", { event: "arp_sweep_failed", error: String(e?.message || e) });
  }
}, 5 * 60 * 1000);
arpSweepTimer.unref?.();

process.on("SIGHUP", () => {
  try {
    registry.load();
    syncBackends();
    log("events", { event: "reloaded", connectors: Object.keys(registry.connections).length, agents: Object.keys(registry.agents).length });
  } catch (e) {
    log("events", { event: "reload_failed", error: String(e?.message || e) });
  }
});

async function shutdown(sig) {
  log("events", { event: "shutdown", signal: sig });
  servers.forEach((s) => s.close());
  try {
    rmSync(PID_FILE, { force: true });
  } catch {}
  clearInterval(arpSweepTimer);
  await Promise.allSettled([...backends.values()].map((b) => b.stop()));
  try {
    arpStore.close();
    oauth.close();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
