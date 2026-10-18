/**
 * Loads connections.yaml (what connectors exist) and agents.yaml (who may use them).
 *
 * agents.yaml:
 *   agents:
 *     hermes-gateway:
 *       token_sha256: <hex>          # only the hash is stored; `sb agent add` prints the token once
 *       enabled: true
 *       grants:                      # server name (or "*") -> "*" | list of tool names/globs
 *         "*": "*"
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import YAML from "yaml";

/** CLI/admin actor identity; override with SB_OPERATOR_NAME. */
export const OPERATOR = process.env.SB_OPERATOR_NAME || "operator";

/**
 * Parse a dotenv file (KEY=value, optional quotes, # comments).
 * @param {string} path
 * @returns {Record<string,string>}
 */
export function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * Resolve ${VAR} / ${env:VAR} placeholders; unset vars keep the literal placeholder.
 * @param {any} value
 * @param {Record<string,string>} vars
 */
export function interpolate(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (whole, name) => {
      const key = name.trim().replace(/^env:/, "");
      if (key === "userHome") return process.env.HOME || whole;
      return vars[key] || whole;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  return value;
}

/** @param {string} s */
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Match a name against a glob with `*` wildcards.
 * @param {string} pattern
 * @param {string} name
 */
export function globMatch(pattern, name) {
  if (pattern === "*") return true;
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

export class Registry {
  /**
   * @param {string} connectionsPath
   * @param {string} agentsPath
   */
  constructor(connectionsPath, agentsPath) {
    this.connectionsPath = connectionsPath;
    this.agentsPath = agentsPath;
    /** @type {((agent: string, connector: string, tool: string) => object|null)|null} */
    this._dynamicGrant = null;
    this.load();
  }

  /**
   * Wire in ARP's dynamic-grant lookup (src/arp.js ArpStore#findActiveGrant). Optional — when unset,
   * canCallTool behaves exactly as before (static agents.yaml grants only).
   * @param {(agent: string, connector: string, tool: string) => object|null} fn
   */
  setDynamicGrantLookup(fn) {
    this._dynamicGrant = fn;
  }

  load() {
    const doc = YAML.parse(readFileSync(this.connectionsPath, "utf8")) || {};
    const configDir = dirname(this.connectionsPath);
    // env_files may use ${VAR} placeholders; relative paths resolve against the config dir.
    const envFiles = (doc.env_files || []).map((p) => interpolate(p, process.env)).map((p) => (isAbsolute(p) ? p : resolve(configDir, p)));
    // Secrets referenced as ${VAR} come from env_files, later files winning, then our own env.
    const vars = Object.assign({}, ...envFiles.map(readEnvFile), process.env);
    /** Resolved variables (env_files + process env), also used for notifications. */
    this.vars = vars;
    this.connections = Object.fromEntries(
      Object.entries(doc.connections || {})
        .filter(([, c]) => c.enabled !== false)
        .map(([name, c]) => [name, { name, ...interpolate(c, vars) }])
    );
    this.agents = existsSync(this.agentsPath) ? YAML.parse(readFileSync(this.agentsPath, "utf8"))?.agents || {} : {};
    if (Object.prototype.hasOwnProperty.call(this.agents, OPERATOR)) {
      // The operator identity is reserved for CLI/admin decisions (ARP, audit views); a key under
      // that name would blur who acted, so the entry is dropped rather than trusted.
      delete this.agents[OPERATOR];
      console.error(`switchboard: ignoring agents.yaml entry "${OPERATOR}" (reserved operator identity)`);
    }
  }

  /**
   * Resolve a bearer token to an agent name, or null.
   * @param {string|undefined} token
   * @returns {string|null}
   */
  authenticate(token) {
    if (!token) return null;
    const h = Buffer.from(sha256(token), "hex");
    for (const [name, a] of Object.entries(this.agents)) {
      if (a.enabled === false || !a.token_sha256) continue;
      const want = Buffer.from(a.token_sha256, "hex");
      if (want.length === h.length && timingSafeEqual(want, h)) return name;
    }
    return null;
  }

  /**
   * Tool patterns an agent may use on a server; null means no access to the server at all.
   * @param {string} agent
   * @param {string} server
   * @returns {string[]|null}
   */
  toolGrants(agent, server) {
    const grants = this.agents[agent]?.grants || {};
    const pats = [];
    for (const [srv, tools] of Object.entries(grants)) {
      if (!globMatch(srv, server)) continue;
      pats.push(...(tools === "*" ? ["*"] : [].concat(tools)));
    }
    return pats.length ? pats : null;
  }

  /**
   * True when agents.yaml lists this tool under the agent's `deny` map ({server-glob: tool-glob | [tool-globs]}).
   * A deny always wins over grants, static or dynamic.
   * @param {string} agent
   * @param {string} server
   * @param {string} tool
   * @returns {boolean}
   */
  isDenied(agent, server, tool) {
    const deny = this.agents[agent]?.deny || {};
    return Object.entries(deny).some(([srv, tools]) => globMatch(srv, server) && [].concat(tools).some((p) => globMatch(p, tool)));
  }

  /**
   * True when the agent has any deny entry covering this server (so tools/list must be filtered).
   * @param {string} agent
   * @param {string} server
   * @returns {boolean}
   */
  hasDenies(agent, server) {
    return Object.keys(this.agents[agent]?.deny || {}).some((srv) => globMatch(srv, server));
  }

  /**
   * True when agents.yaml sets `compact: true` for the agent: shorter tool lists, default limits and
   * compact result formatting (see compact.js).
   * @param {string} agent
   * @returns {boolean}
   */
  isCompact(agent) {
    return this.agents[agent]?.compact === true;
  }

  /**
   * Per-agent cap on tool result size (agents.yaml `max_result_kb`), so token-metered agents don't pull
   * 500 KB Slack searches or SQL dumps into their context. Null when the agent has no cap.
   * @param {string} agent
   * @returns {number|null} cap in bytes
   */
  maxResultBytes(agent) {
    const kb = Number(this.agents[agent]?.max_result_kb);
    return kb > 0 ? kb * 1024 : null;
  }

  /**
   * @param {string} agent
   * @param {string} server
   * @param {string} tool
   * @param {object} [args] - tool arguments, checked against a dynamic grant's scope (if any); pass
   *   `undefined` (e.g. when filtering tools/list) to check reachability only, ignoring scope; a static
   *   agents.yaml grant is always scope-unrestricted, same as before this method took an `args` param.
   */
  canCallTool(agent, server, tool, args) {
    if (this.isDenied(agent, server, tool)) return false;
    const pats = this.toolGrants(agent, server);
    if (pats && pats.some((p) => globMatch(p, tool))) return true;
    if (!this._dynamicGrant) return false;
    const grant = this._dynamicGrant(agent, server, tool);
    if (!grant) return false;
    if (!grant.scope || args === undefined) return true;
    return args !== null && Object.entries(grant.scope).every(([k, v]) => args[k] === v);
  }
}
