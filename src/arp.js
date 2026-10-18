/**
 * Agent Request Protocol (ARP): the built-in "agents" connector.
 *
 * Lets registered Switchboard agents discover each other, send structured
 * requests (info / tool_access / task), respond, and have Switchboard mint
 * narrow, expiring grants for approved tool_access requests. Storage is a
 * single SQLite file via node:sqlite (built into Node 22; experimental but
 * synchronous and dependency-free, so a plain flat file is enough for the
 * request volume this is built for).
 *
 * Trust model:
 *  - The FIRST request between any two agents is held (`awaiting_operator`) until
 *    the operator approves the PAIR once (see the `pairs` table).
 *  - After a pair is approved: `info` requests flow straight to the
 *    recipient's inbox (logged only, no gate). `tool_access` and `task`
 *    requests notify the operator (see `pending_approvals`); for `tool_access`
 *    specifically, no grant is minted until BOTH the target agent has
 *    responded `fulfilled` (supplying the connector/tool/scope it will
 *    grant) AND the operator has approved that fulfillment.
 *  - Grants are least-privilege (one connector + one tool, narrowed further
 *    by an optional `scope` arg-equality constraint), default 7 days, max
 *    30 unless the operator extends, and revocable immediately by the operator or either
 *    agent involved in the original request.
 *  - Grants never auto-renew — see sweep() for the T-2d "renew?" card.
 *  - Raw secrets are rejected out of every request/response body/payload.
 *
 * Operator approval is via `sb arp approve|deny <id>` (bin/sb.js) or your notifier integration.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { OPERATOR } from "./registry.js";

// --- secret rejection --------------------------------------------------

/** Patterns that indicate a raw credential leaked into a request/response body. */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "sk- style API key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token (xox*)"],
  [/\bEAA[A-Za-z0-9]{20,}/, "Meta/Facebook token (EAA...)"],
  [/\bghp_[A-Za-z0-9]{30,}/, "GitHub PAT (ghp_...)"],
  [/\bAKIA[A-Z0-9]{12,}\b/, "AWS access key id (AKIA...)"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/i, "bearer token"],
  [/\b(api[_-]?key|api[_-]?secret|client[_-]?secret|access[_-]?token|private[_-]?key|password|passwd)\s*[:=]\s*['"]?[A-Za-z0-9+/=_.-]{8,}/i, "key/secret/password assignment"],
];

/**
 * Scan one string for a raw-looking credential.
 * @param {any} text
 * @returns {{snippet: string, kind: string}|null}
 */
export function findSecret(text) {
  if (text === null || text === undefined) return null;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  for (const [re, kind] of SECRET_PATTERNS) {
    const m = re.exec(s);
    if (m) return { snippet: m[0].slice(0, 40), kind };
  }
  return null;
}

/**
 * Scan several fields (any type; non-strings are JSON-stringified) for secrets.
 * @param {...any} fields
 * @returns {{snippet: string, kind: string}|null}
 */
export function scanForSecrets(...fields) {
  for (const f of fields) {
    const hit = findSecret(f);
    if (hit) return hit;
  }
  return null;
}

/** Build the standard "reject" MCP tool result for a secret hit. */
function secretError(hit) {
  return { content: [{ type: "text", text: `Switchboard: refused — payload looks like it contains a ${hit.kind} (${hit.snippet}...). Never put raw credentials in an ARP request/response body; share a pointer (vault path, "ask the operator") instead.` }], isError: true };
}

// --- helpers -------------------------------------------------------------

const now = () => new Date().toISOString();
const pairKey = (a, b) => [a, b].sort();
const err = (text) => ({ content: [{ type: "text", text: `Switchboard: ${text}` }], isError: true });
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj });

function clampDays(days, def, max) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.round(n), max);
}

function addDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

// --- store ----------------------------------------------------------------

export class ArpStore {
  /**
   * @param {string} file - path to the sqlite file
   * @param {{notify?: (pa: object) => void|Promise<void>, canCallTool?: (agent: string, connector: string, tool: string) => boolean}} [opts]
   *   `notify` is called (best-effort) with each new pending_approval card, so the operator hears
   *   about approvals without polling `sb arp list`. `canCallTool` is checked before a fulfilled
   *   tool_access request is queued for approval: an agent may only offer to lend access its own
   *   key can call.
   */
  constructor(file, opts = {}) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this._notify = opts.notify || null;
    this._canCallTool = opts.canCallTool || null;
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        agent_id TEXT PRIMARY KEY,
        display_name TEXT,
        operator TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        contact_policy TEXT NOT NULL DEFAULT 'notify-operator',
        note TEXT,
        last_seen TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairs (
        agent_a TEXT NOT NULL,
        agent_b TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting_operator',
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        PRIMARY KEY (agent_a, agent_b)
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL,
        subject TEXT,
        body TEXT,
        context_refs TEXT NOT NULL DEFAULT '[]',
        needed_by TEXT,
        expires_at TEXT,
        idempotency_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_idem
        ON requests(from_agent, to_agent, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT,
        reason TEXT,
        responded_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grants (
        grant_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        connector TEXT NOT NULL,
        tool TEXT NOT NULL,
        scope TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_by TEXT,
        source_request_id TEXT,
        revoked_at TEXT,
        revoked_by TEXT,
        renew_notified_at TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        agent_a TEXT,
        agent_b TEXT,
        summary TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decision TEXT,
        card_key TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        actor TEXT,
        event TEXT NOT NULL,
        from_agent TEXT,
        to_agent TEXT,
        request_id TEXT,
        grant_id TEXT,
        detail TEXT
      );
    `);
  }

  // -- audit ---------------------------------------------------------------

  /** @param {object} rec */
  _audit(rec) {
    this.db
      .prepare("INSERT INTO audit (ts, actor, event, from_agent, to_agent, request_id, grant_id, detail) VALUES (?,?,?,?,?,?,?,?)")
      .run(now(), rec.actor ?? null, rec.event, rec.from_agent ?? null, rec.to_agent ?? null, rec.request_id ?? null, rec.grant_id ?? null, rec.detail ? JSON.stringify(rec.detail) : null);
  }

  /**
   * @param {string} agent - caller identity; operator (admin) sees everything
   * @param {{limit?: number, since?: string}} [opts]
   */
  auditLog(agent, opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 1000);
    const admin = agent === OPERATOR;
    const rows = admin
      ? this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit)
      : this.db
          .prepare("SELECT * FROM audit WHERE actor = ? OR from_agent = ? OR to_agent = ? ORDER BY id DESC LIMIT ?")
          .all(agent, agent, agent, limit);
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : undefined }));
  }

  // -- profiles / directory -------------------------------------------------

  touchLastSeen(agent) {
    this.db.prepare("UPDATE profiles SET last_seen = ? WHERE agent_id = ?").run(now(), agent);
  }

  /** Ensure a bare profile row exists (e.g. an agent that's never called update_profile yet but is in agents.yaml). */
  ensureProfile(agent) {
    const t = now();
    this.db
      .prepare("INSERT INTO profiles (agent_id, display_name, capabilities, created_at, updated_at, last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(agent_id) DO NOTHING")
      .run(agent, agent, "[]", t, t, t);
  }

  updateProfile(agent, { display_name, operator, capabilities, contact_policy } = {}) {
    this.ensureProfile(agent);
    const t = now();
    const cur = this.db.prepare("SELECT * FROM profiles WHERE agent_id = ?").get(agent);
    const next = {
      display_name: display_name ?? cur.display_name,
      operator: operator ?? cur.operator,
      capabilities: capabilities ? JSON.stringify(capabilities) : cur.capabilities,
      contact_policy: contact_policy ?? cur.contact_policy,
    };
    this.db
      .prepare("UPDATE profiles SET display_name=?, operator=?, capabilities=?, contact_policy=?, updated_at=? WHERE agent_id=?")
      .run(next.display_name, next.operator, next.capabilities, next.contact_policy, t, agent);
    this._audit({ actor: agent, event: "update_profile" });
    return this.getProfile(agent);
  }

  getProfile(agent) {
    const r = this.db.prepare("SELECT * FROM profiles WHERE agent_id = ?").get(agent);
    return r ? { agent_id: r.agent_id, display_name: r.display_name, operator: r.operator, capabilities: JSON.parse(r.capabilities || "[]"), contact_policy: r.contact_policy, last_seen: r.last_seen } : null;
  }

  listAgents() {
    return this.db
      .prepare("SELECT * FROM profiles ORDER BY agent_id")
      .all()
      .map((r) => ({ agent_id: r.agent_id, display_name: r.display_name, operator: r.operator, capabilities: JSON.parse(r.capabilities || "[]"), contact_policy: r.contact_policy, last_seen: r.last_seen }));
  }

  // -- pairs -----------------------------------------------------------------

  getPair(a, b) {
    const [x, y] = pairKey(a, b);
    return this.db.prepare("SELECT * FROM pairs WHERE agent_a=? AND agent_b=?").get(x, y);
  }

  /** Ensure a pair row exists; returns it (creating as awaiting_operator + a pending_approval if new). */
  ensurePair(a, b) {
    const [x, y] = pairKey(a, b);
    let pair = this.getPair(x, y);
    if (pair) return pair;
    const t = now();
    this.db.prepare("INSERT INTO pairs (agent_a, agent_b, status, created_at) VALUES (?,?,?,?)").run(x, y, "awaiting_operator", t);
    this.addPendingApproval({ kind: "pair", ref_id: `${x}|${y}`, agent_a: x, agent_b: y, summary: `First contact between "${x}" and "${y}" — approve this pair once to let them exchange ARP requests.`, detail: { agent_a: x, agent_b: y } });
    this._audit({ actor: "system", event: "pair_created", from_agent: x, to_agent: y });
    return this.getPair(x, y);
  }

  decidePair(a, b, approve, decidedBy) {
    const [x, y] = pairKey(a, b);
    this.db
      .prepare("UPDATE pairs SET status=?, decided_at=?, decided_by=? WHERE agent_a=? AND agent_b=?")
      .run(approve ? "approved" : "declined", now(), decidedBy, x, y);
    this._audit({ actor: decidedBy, event: approve ? "pair_approved" : "pair_declined", from_agent: x, to_agent: y });
  }

  // -- pending_approvals (operator queue) ------------------------------------

  addPendingApproval({ kind, ref_id, agent_a, agent_b, summary, detail }) {
    const t = now();
    const cardKey = `arp-${kind}-${ref_id}`;
    const existing = this.db.prepare("SELECT id FROM pending_approvals WHERE card_key = ? AND decided_at IS NULL").get(cardKey);
    if (existing) return existing.id;
    const r = this.db
      .prepare("INSERT INTO pending_approvals (kind, ref_id, agent_a, agent_b, summary, detail, created_at, card_key) VALUES (?,?,?,?,?,?,?,?)")
      .run(kind, ref_id, agent_a ?? null, agent_b ?? null, summary, JSON.stringify(detail ?? {}), t, cardKey);
    const id = Number(r.lastInsertRowid);
    // Best-effort operator notification (wired by index.js). A broken notifier must never break the
    // call that queued the card.
    try {
      const p = this._notify?.({ id, kind, ref_id, agent_a, agent_b, summary, detail: detail ?? {} });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
    return id;
  }

  listPendingApprovals() {
    return this.db
      .prepare("SELECT * FROM pending_approvals WHERE decided_at IS NULL ORDER BY id")
      .all()
      .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : {} }));
  }

  getPendingApproval(id) {
    const r = this.db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(Number(id));
    return r ? { ...r, detail: r.detail ? JSON.parse(r.detail) : {} } : null;
  }

  /**
   * Resolve a pending approval (approve or deny). Handles the side effect for
   * each kind: pair -> decide the pair; tool_access -> mint the grant;
   * renewal -> extend the grant 30 days. Used by `sb arp approve|deny`.
   * @param {number} id
   * @param {boolean} approve
   * @param {string} decidedBy - operator identity for the normal path
   */
  resolvePendingApproval(id, approve, decidedBy = OPERATOR) {
    const pa = this.getPendingApproval(id);
    if (!pa) return { ok: false, error: `no pending approval #${id}` };
    const t = now();
    let result = { ok: true, kind: pa.kind };
    if (pa.kind === "pair") {
      this.decidePair(pa.agent_a, pa.agent_b, approve, decidedBy);
      // Any requests that were held awaiting this pair can now proceed.
      if (approve) {
        this.db
          .prepare("UPDATE requests SET status='pending', updated_at=? WHERE status='awaiting_operator' AND ((from_agent=? AND to_agent=?) OR (from_agent=? AND to_agent=?)) AND request_id NOT IN (SELECT ref_id FROM pending_approvals WHERE kind='tool_access')")
          .run(t, pa.agent_a, pa.agent_b, pa.agent_b, pa.agent_a);
      } else {
        this.db
          .prepare("UPDATE requests SET status='declined', updated_at=? WHERE status='awaiting_operator' AND ((from_agent=? AND to_agent=?) OR (from_agent=? AND to_agent=?))")
          .run(t, pa.agent_a, pa.agent_b, pa.agent_b, pa.agent_a);
      }
    } else if (pa.kind === "tool_access") {
      const req = this.db.prepare("SELECT * FROM requests WHERE request_id = ?").get(pa.ref_id);
      if (approve && req) {
        const d = pa.detail;
        const grantId = "grt_" + randomUUID().replace(/-/g, "").slice(0, 20);
        const days = clampDays(d.expires_days, 7, 30);
        this.db
          .prepare("INSERT INTO grants (grant_id, agent_id, connector, tool, scope, created_at, expires_at, created_by, source_request_id) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(grantId, req.from_agent, d.connector, d.tool, d.scope ? JSON.stringify(d.scope) : null, t, addDays(days), decidedBy, req.request_id);
        this.db.prepare("UPDATE requests SET status='fulfilled', updated_at=? WHERE request_id=?").run(t, req.request_id);
        this._audit({ actor: decidedBy, event: "grant_minted", from_agent: req.to_agent, to_agent: req.from_agent, request_id: req.request_id, grant_id: grantId, detail: { connector: d.connector, tool: d.tool, scope: d.scope, expires_at: addDays(days) } });
        result.grant_id = grantId;
      } else if (req) {
        this.db.prepare("UPDATE requests SET status='declined', updated_at=? WHERE request_id=?").run(t, req.request_id);
        this._audit({ actor: decidedBy, event: "grant_denied", request_id: req.request_id });
      }
    } else if (pa.kind === "renewal") {
      if (approve) {
        this.db.prepare("UPDATE grants SET expires_at=?, renew_notified_at=NULL WHERE grant_id=?").run(addDays(30), pa.ref_id);
        this._audit({ actor: decidedBy, event: "grant_renewed", grant_id: pa.ref_id, detail: { expires_at: addDays(30) } });
      } else {
        this._audit({ actor: decidedBy, event: "grant_renewal_declined", grant_id: pa.ref_id });
      }
    }
    this.db.prepare("UPDATE pending_approvals SET decided_at=?, decision=? WHERE id=?").run(t, approve ? "approved" : "denied", id);
    return result;
  }

  // -- requests ----------------------------------------------------------------

  /**
   * @param {string} fromAgent
   * @param {object} args
   */
  createRequest(fromAgent, args) {
    const { to, type, subject = "", body = "", context_refs = [], needed_by, expires_at, idempotency_key } = args || {};
    if (!to || typeof to !== "string") return err(`"to" is required`);
    if (!["info", "tool_access", "task"].includes(type)) return err(`"type" must be info, tool_access or task`);
    if (to === fromAgent) return err(`cannot request yourself`);
    const secretHit = scanForSecrets(subject, body, context_refs);
    if (secretHit) return secretError(secretHit);

    if (idempotency_key) {
      const existing = this.db.prepare("SELECT * FROM requests WHERE from_agent=? AND to_agent=? AND idempotency_key=?").get(fromAgent, to, idempotency_key);
      if (existing) return ok({ request_id: existing.request_id, status: existing.status });
    }

    this.ensureProfile(fromAgent);
    this.touchLastSeen(fromAgent);
    const pair = this.ensurePair(fromAgent, to);
    const requestId = "req_" + randomUUID().replace(/-/g, "").slice(0, 20);
    const t = now();
    const status = pair.status === "approved" ? "pending" : "awaiting_operator";
    this.db
      .prepare("INSERT INTO requests (request_id, from_agent, to_agent, type, subject, body, context_refs, needed_by, expires_at, idempotency_key, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(requestId, fromAgent, to, type, subject, body, JSON.stringify(context_refs), needed_by ?? null, expires_at ?? null, idempotency_key ?? null, status, t, t);
    this._audit({ actor: fromAgent, event: "request_created", from_agent: fromAgent, to_agent: to, request_id: requestId, detail: { type, status } });

    if (status === "pending" && (type === "tool_access" || type === "task")) {
      this.addPendingApproval({
        kind: "notify",
        ref_id: requestId,
        agent_a: fromAgent,
        agent_b: to,
        summary: `FYI: "${fromAgent}" sent "${to}" a ${type} request — "${subject}".`,
        detail: { request_id: requestId, type, subject },
      });
    }
    return ok({ request_id: requestId, status });
  }

  getRequest(requestId) {
    return this.db.prepare("SELECT * FROM requests WHERE request_id = ?").get(requestId);
  }

  /**
   * @param {string} agent
   * @param {{status?: string, limit?: number, cursor?: string}} args
   */
  inbox(agent, args = {}) {
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
    const cursorClause = args.cursor ? "AND request_id > ?" : "";
    const params = [agent];
    let sql = `SELECT * FROM requests WHERE to_agent = ? ${cursorClause}`;
    if (args.cursor) params.push(args.cursor);
    if (args.status) {
      sql += " AND status = ?";
      params.push(args.status);
    } else {
      // Requests still held behind a first-contact pair approval aren't "yours" to see yet.
      sql += " AND status != 'awaiting_operator'";
    }
    sql += " ORDER BY request_id LIMIT ?";
    params.push(limit + 1);
    const rows = this.db.prepare(sql).all(...params);
    const page = rows.slice(0, limit);
    this.touchLastSeen(agent);
    return ok({
      requests: page.map((r) => ({ request_id: r.request_id, from: r.from_agent, type: r.type, subject: r.subject, body: r.body, needed_by: r.needed_by, expires_at: r.expires_at, status: r.status, context_refs: JSON.parse(r.context_refs || "[]") })),
      next_cursor: rows.length > limit ? page[page.length - 1].request_id : null,
    });
  }

  /**
   * @param {string} agent - must be the request's to_agent
   * @param {object} args
   */
  respond(agent, args) {
    const { request_id, status, payload, reason } = args || {};
    const req = this.getRequest(request_id);
    if (!req) return err(`no such request ${request_id}`);
    if (req.to_agent !== agent) return err(`only "${req.to_agent}" may respond to ${request_id}`);
    if (!["fulfilled", "declined", "needs_info"].includes(status)) return err(`"status" must be fulfilled, declined or needs_info`);
    if (status === "declined" && !reason) return err(`"reason" is required when declining`);
    const secretHit = scanForSecrets(payload, reason);
    if (secretHit) return secretError(secretHit);
    if (["expired", "declined"].includes(req.status)) return err(`request ${request_id} is already ${req.status}`);

    const t = now();
    this.db
      .prepare("INSERT INTO responses (request_id, status, payload, reason, responded_by, created_at) VALUES (?,?,?,?,?,?)")
      .run(request_id, status, payload ? JSON.stringify(payload) : null, reason ?? null, agent, t);

    let finalStatus = status;
    if (status === "fulfilled" && req.type === "tool_access") {
      if (!payload?.connector || !payload?.tool) return err(`fulfilling a tool_access request requires payload.connector and payload.tool (what you're granting)`);
      // The responder can only lend access its own key actually has; otherwise it could mint
      // approvals for connector/tool pairs it was never granted itself.
      if (this._canCallTool && !this._canCallTool(agent, payload.connector, payload.tool)) {
        return err(`cannot grant ${payload.connector}/${payload.tool}: your own key can't call it`);
      }
      finalStatus = "awaiting_operator";
      this.addPendingApproval({
        kind: "tool_access",
        ref_id: request_id,
        agent_a: req.from_agent,
        agent_b: req.to_agent,
        summary: `"${req.to_agent}" agreed to grant "${req.from_agent}" access to ${payload.connector}/${payload.tool}${payload.scope ? ` (scope: ${JSON.stringify(payload.scope)})` : ""} for ${clampDays(payload.expires_days, 7, 30)}d — approve to mint the grant.`,
        detail: { connector: payload.connector, tool: payload.tool, scope: payload.scope ?? null, expires_days: clampDays(payload.expires_days, 7, 30) },
      });
    }
    this.db.prepare("UPDATE requests SET status=?, updated_at=? WHERE request_id=?").run(finalStatus, t, request_id);
    this.touchLastSeen(agent);
    this._audit({ actor: agent, event: "responded", from_agent: req.from_agent, to_agent: req.to_agent, request_id, detail: { status } });
    return ok({ request_id, status: finalStatus });
  }

  /** @param {string} agent @param {string} requestId */
  requestStatus(agent, requestId) {
    const req = this.getRequest(requestId);
    if (!req) return err(`no such request ${requestId}`);
    if (agent !== OPERATOR && req.from_agent !== agent && req.to_agent !== agent) return err(`not your request`);
    const responses = this.db.prepare("SELECT status, payload, reason, responded_by, created_at FROM responses WHERE request_id = ? ORDER BY id").all(requestId).map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : undefined }));
    return ok({ status: req.status, responses });
  }

  // -- grants ------------------------------------------------------------------

  /** Grant used by Registry.canCallTool — the ONLY dynamic-grant read path outside admin/CLI. */
  findActiveGrant(agent, connector, tool) {
    const t = now();
    const r = this.db
      .prepare("SELECT * FROM grants WHERE agent_id=? AND connector=? AND tool=? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
      .get(agent, connector, tool, t);
    return r ? { ...r, scope: r.scope ? JSON.parse(r.scope) : null } : null;
  }

  listGrants(agent) {
    const rows = agent ? this.db.prepare("SELECT * FROM grants WHERE agent_id = ? ORDER BY created_at DESC").all(agent) : this.db.prepare("SELECT * FROM grants ORDER BY created_at DESC").all();
    const t = now();
    return rows.map((r) => ({ ...r, scope: r.scope ? JSON.parse(r.scope) : null, active: !r.revoked_at && r.expires_at > t }));
  }

  /**
   * @param {string} agent - caller (CLI passes OPERATOR)
   * @param {string} grantId
   */
  revokeGrant(agent, grantId) {
    const g = this.db.prepare("SELECT * FROM grants WHERE grant_id = ?").get(grantId);
    if (!g) return err(`no such grant ${grantId}`);
    if (agent !== OPERATOR) {
      const req = g.source_request_id ? this.getRequest(g.source_request_id) : null;
      const involved = new Set([g.agent_id, req?.from_agent, req?.to_agent].filter(Boolean));
      if (!involved.has(agent)) return err(`"${agent}" is not involved in grant ${grantId}`);
    }
    this.db.prepare("UPDATE grants SET revoked_at=?, revoked_by=? WHERE grant_id=?").run(now(), agent, grantId);
    this._audit({ actor: agent, event: "grant_revoked", grant_id: grantId, detail: { connector: g.connector, tool: g.tool, agent_id: g.agent_id } });
    return ok({ revoked: true });
  }

  // -- periodic sweep ------------------------------------------------------------

  /** Expire stale requests; queue T-2d renewal cards for grants about to lapse. Call every few minutes. */
  sweep() {
    const t = now();
    this.db.prepare("UPDATE requests SET status='expired', updated_at=? WHERE expires_at IS NOT NULL AND expires_at < ? AND status IN ('pending','awaiting_operator','needs_info')").run(t, t);
    const soon = new Date(Date.now() + 2 * 86400000).toISOString();
    const dueGrants = this.db.prepare("SELECT * FROM grants WHERE revoked_at IS NULL AND renew_notified_at IS NULL AND expires_at < ? AND expires_at > ?").all(soon, t);
    for (const g of dueGrants) {
      this.addPendingApproval({ kind: "renewal", ref_id: g.grant_id, agent_a: g.agent_id, summary: `Grant ${g.grant_id} (${g.agent_id} → ${g.connector}/${g.tool}) expires ${g.expires_at.slice(0, 10)}. Renew 30 days?`, detail: { grant_id: g.grant_id, agent_id: g.agent_id, connector: g.connector, tool: g.tool, current_expiry: g.expires_at } });
      this.db.prepare("UPDATE grants SET renew_notified_at=? WHERE grant_id=?").run(t, g.grant_id);
    }
  }

  close() {
    this.db.close();
  }
}

// --- MCP tool surface -------------------------------------------------------

export const TOOLS = [
  { name: "agents.list", description: "Directory of agents registered on this Switchboard: display name, operator, self-declared capabilities, contact policy, last seen.", inputSchema: { type: "object", properties: {} } },
  {
    name: "agents.request",
    description: "Send another agent a structured request (info, tool_access, or task). First contact between two agents is held for the operator's one-time pair approval. Never put raw secrets in subject/body.",
    inputSchema: {
      type: "object",
      required: ["to", "type", "subject"],
      properties: {
        to: { type: "string" },
        type: { type: "string", enum: ["info", "tool_access", "task"] },
        subject: { type: "string" },
        body: { type: "string", description: "Markdown body" },
        context_refs: { type: "array", items: { type: "string" } },
        needed_by: { type: "string" },
        expires_at: { type: "string" },
        idempotency_key: { type: "string" },
      },
    },
  },
  { name: "agents.inbox", description: "List requests addressed to you.", inputSchema: { type: "object", properties: { status: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } } } },
  {
    name: "agents.respond",
    description: "Respond to a request addressed to you. Fulfilling a tool_access request requires payload.connector + payload.tool (what you're granting) and mints a grant only after the operator also approves. Never put raw secrets in payload/reason.",
    inputSchema: {
      type: "object",
      required: ["request_id", "status"],
      properties: { request_id: { type: "string" }, status: { type: "string", enum: ["fulfilled", "declined", "needs_info"] }, payload: { type: "object" }, reason: { type: "string" } },
    },
  },
  { name: "agents.request_status", description: "Check the status of a request you sent or received.", inputSchema: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } } },
  { name: "agents.revoke_grant", description: "Revoke a grant. Callable by the operator or either agent involved in the original request.", inputSchema: { type: "object", required: ["grant_id"], properties: { grant_id: { type: "string" } } } },
  { name: "agents.audit_log", description: "Audit trail. You see only entries involving you; the operator sees everything.", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "agents.update_profile", description: "Register or refresh your own directory entry.", inputSchema: { type: "object", properties: { display_name: { type: "string" }, operator: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, contact_policy: { type: "string", enum: ["info-auto", "notify-operator", "approval-required"] } } } },
];

/**
 * Built-in "connector" wrapper so the agents/ARP tools flow through the exact same
 * callTool/canCallTool/audit/REST/MCP machinery as any stdio connector, with one
 * difference: it needs the caller's identity, which index.js passes as opts.agent
 * (stdio Backends ignore that extra option, so this is fully backward compatible).
 */
export class ArpBackend {
  /** @param {ArpStore} store */
  constructor(store) {
    this.store = store;
    this.name = "agents";
    this.conn = { name: "agents", builtin: true };
    this.client = true; // always "up" — no child process to crash
    this.pid = null;
    this.restarts = 0;
    this.inflight = 0;
    this.startedAt = new Date();
  }

  async start() {}
  async stop() {}

  info() {
    return { serverInfo: { name: "switchboard-agents", version: "1" }, capabilities: { tools: {} }, instructions: "Agent Request Protocol: discover agents, send/answer requests, manage grants. See agents.list / agents.request / agents.inbox / agents.respond." };
  }

  /**
   * @param {{method: string, params?: object}} req
   * @param {{agent?: string}} [opts] - opts.agent is the caller identity (set by Switchboard, never client-supplied)
   */
  async request(req, opts = {}) {
    if (req.method === "tools/list") return { tools: TOOLS };
    if (req.method === "tools/call") {
      const agent = opts.agent;
      if (!agent) return err("internal error: no caller identity for agents connector");
      return callArpTool(this.store, agent, req.params?.name, req.params?.arguments ?? {});
    }
    return err(`unsupported method ${req.method}`);
  }
}

/**
 * Dispatch one ARP tool call.
 * @param {ArpStore} store
 * @param {string} agent - caller identity (set by Switchboard from the bearer token, never client-supplied)
 * @param {string} tool
 * @param {object} args
 */
export function callArpTool(store, agent, tool, args = {}) {
  store.ensureProfile(agent);
  switch (tool) {
    case "agents.list":
      return ok({ agents: store.listAgents() });
    case "agents.request":
      return store.createRequest(agent, args);
    case "agents.inbox":
      return store.inbox(agent, args);
    case "agents.respond":
      return store.respond(agent, args);
    case "agents.request_status":
      return store.requestStatus(agent, args.request_id);
    case "agents.revoke_grant":
      return store.revokeGrant(agent, args.grant_id);
    case "agents.audit_log":
      return ok({ entries: store.auditLog(agent, args) });
    case "agents.update_profile":
      return ok({ profile: store.updateProfile(agent, args) });
    default:
      return err(`unknown tool ${tool}`);
  }
}
