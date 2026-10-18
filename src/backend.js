/**
 * One shared connection to a single stdio MCP server.
 *
 * Every agent that uses a connector talks to the same child process through this
 * Backend. The MCP SDK Client multiplexes concurrent requests by JSON-RPC id, so
 * parallel calls from different agents are safe unless the connector is marked
 * `serialize: true` (browser-driven servers that share one page).
 */
import { createWriteStream, statSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";

/** Env keys Hermes passes through to stdio children (tools/mcp_tool_config.py _build_safe_env). */
const SAFE_KEYS = new Set(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR"]);
const SAFE_KEYS_CI = new Set(["TEMP", "TMP", "LOGNAME", "SYSTEMROOT", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "WINDIR"]);

/** Longest a proxied request may run before we give up (the calling agent enforces its own, shorter, limit). */
const MAX_REQUEST_MS = 30 * 60 * 1000;
const STDERR_LOG_MAX = 5 * 1024 * 1024;
/** The SDK's stdio reader drops the connection above 10 MB; Hermes' own stdio client has no cap, so match that. */
const STDIO_MAX_MESSAGE = 512 * 1024 * 1024;

/**
 * Build the child environment the same way Hermes does: safe keys from our own env plus the connector's env.
 * @param {Record<string,string>|undefined} connEnv - per-connector env from connections.yaml
 * @returns {Record<string,string>}
 */
export function buildChildEnv(connEnv) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || v.startsWith("()")) continue;
    if (SAFE_KEYS.has(k) || SAFE_KEYS_CI.has(k.toUpperCase()) || k.startsWith("XDG_")) env[k] = v;
  }
  for (const [k, v] of Object.entries(connEnv || {})) env[k] = String(v ?? "");
  return env;
}

export class Backend {
  /**
   * @param {object} conn - connection definition (name, command, args, env, cwd, serialize)
   * @param {string} logDir - directory for stderr logs
   * @param {(evt: object) => void} onEvent - lifecycle event sink (for the service log)
   */
  constructor(conn, logDir, onEvent) {
    this.conn = conn;
    this.name = conn.name;
    this.logDir = logDir;
    this.onEvent = onEvent;
    /** @type {Client|null} */
    this.client = null;
    this.ready = null; // Promise resolving when connected
    this.restarts = 0; // lifetime count, for status
    this.failures = 0; // consecutive, drives backoff; reset after a minute of healthy uptime
    this.startedAt = null;
    this.stopping = false;
    this.queue = Promise.resolve(); // serialization chain for serialize:true connectors
    this.inflight = 0;
    /** Our own progress tokens -> callbacks. Handled synchronously at the transport so a final progress tick
     * that arrives in the same chunk as the result is never dropped (the SDK dispatches it a microtask late). */
    this.progressHandlers = new Map();
    this.progressSeq = 0;
  }

  /** PID of the running child, if any. */
  get pid() {
    return this.client?.transport?.pid ?? null;
  }

  /**
   * Start (or return the pending start of) the child process and MCP handshake.
   * @returns {Promise<void>}
   */
  start() {
    if (this.ready) return this.ready;
    this.ready = this._connect().catch((err) => {
      this.ready = null;
      this.onEvent({ event: "start_failed", server: this.name, error: String(err?.message || err) });
      this._scheduleRestart();
      throw err;
    });
    return this.ready;
  }

  async _connect() {
    const c = this.conn;
    const transport = new StdioClientTransport({
      command: c.command,
      args: c.args || [],
      env: buildChildEnv(c.env),
      cwd: c.cwd || process.env.HOME,
      stderr: "pipe",
      maxBufferSize: STDIO_MAX_MESSAGE,
    });
    this._pipeStderr(transport);
    const client = new Client({ name: "switchboard", version: "0.1.0" }, { capabilities: {} });
    client.onclose = () => {
      if (this.client !== client) return;
      this.client = null;
      this.ready = null;
      if (!this.stopping) {
        this.onEvent({ event: "backend_exited", server: this.name });
        this._scheduleRestart();
      }
    };
    client.onerror = (err) => this.onEvent({ event: "backend_error", server: this.name, error: String(err?.message || err) });
    // Log any notification the backend emits; agents only receive progress for their own requests.
    client.fallbackNotificationHandler = async (n) => this.onEvent({ event: "backend_notification", server: this.name, method: n.method });
    const connectTimeout = (c.connect_timeout || 60) * 1000;
    await client.connect(transport, { timeout: connectTimeout });
    const sdkOnMessage = transport.onmessage;
    transport.onmessage = (msg, extra) => {
      const handler = msg?.method === "notifications/progress" && this.progressHandlers.get(msg.params?.progressToken);
      if (handler) {
        const { progressToken, ...p } = msg.params;
        return handler(p);
      }
      return sdkOnMessage?.(msg, extra);
    };
    this.client = client;
    this.startedAt = new Date();
    clearTimeout(this._healthyTimer);
    this._healthyTimer = setTimeout(() => this.client === client && (this.failures = 0), 60000);
    this._healthyTimer.unref?.();
    this.onEvent({ event: "backend_started", server: this.name, pid: transport.pid });
  }

  _pipeStderr(transport) {
    mkdirSync(this.logDir, { recursive: true });
    const path = join(this.logDir, `${this.name}.stderr.log`);
    try {
      if (statSync(path).size > STDERR_LOG_MAX) renameSync(path, `${path}.1`);
    } catch {}
    const out = createWriteStream(path, { flags: "a" });
    transport.stderr?.pipe(out);
  }

  _scheduleRestart() {
    if (this.stopping || this._restartTimer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5));
    this.failures++;
    this.restarts++;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.start().catch(() => {});
    }, delay);
  }

  /**
   * Forward one JSON-RPC request to the backend and return its raw result.
   * @param {{method: string, params?: object}} req
   * @param {{signal?: AbortSignal, onprogress?: (p: object) => void}} opts
   * @returns {Promise<object>}
   */
  async request(req, opts = {}) {
    const run = async () => {
      await this.start();
      this.inflight++;
      try {
        const params = { ...(req.params || {}) };
        const { progressToken: _callerToken, ...meta } = params._meta || {};
        let token;
        if (opts.onprogress) {
          token = `sb-${this.name}-${++this.progressSeq}`;
          this.progressHandlers.set(token, opts.onprogress);
          params._meta = { ...meta, progressToken: token };
        } else if (params._meta) {
          if (Object.keys(meta).length) params._meta = meta;
          else delete params._meta;
        }
        try {
          return await this.client.request({ method: req.method, params }, ResultSchema, {
            signal: opts.signal,
            timeout: MAX_REQUEST_MS,
            maxTotalTimeout: MAX_REQUEST_MS,
          });
        } finally {
          if (token) this.progressHandlers.delete(token);
        }
      } finally {
        this.inflight--;
      }
    };
    if (!this.conn.serialize) return run();
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Server identity and capabilities captured at handshake, mirrored to agents. */
  info() {
    return {
      serverInfo: this.client?.getServerVersion() || { name: this.name, version: "0" },
      capabilities: this.client?.getServerCapabilities() || { tools: {} },
      instructions: this.client?.getInstructions(),
    };
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this._restartTimer);
    clearTimeout(this._healthyTimer);
    try {
      await this.client?.close();
    } catch {}
  }
}
