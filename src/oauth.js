/**
 * OAuth 2.1 front door for agents that can't send a static API key (e.g. a ChatGPT connector).
 *
 * The MCP authorization flow, with the operator as the consent step:
 *   1. Client hits /mcp without a token -> 401 + WWW-Authenticate pointing at protected-resource metadata.
 *   2. Client discovers /.well-known/oauth-authorization-server, registers (RFC 7591 DCR, or a
 *      Client ID Metadata Document URL), then opens /oauth/authorize in the user's browser (PKCE S256 only).
 *   3. Switchboard notifies the operator (Telegram, webhook, ntfy, or log) with a one-time review link. The browser page waits.
 *   4. The operator taps Approve on the review page -> the waiting browser is redirected back with a code.
 *   5. Client exchanges the code at /oauth/token for a 1h access token + rotating 90d refresh token.
 *
 * An OAuth token acts as one agents.yaml agent, with exactly that agent's grants. Only agents with
 * `oauth: true` can be signed into this way; disabling/removing the agent kills its OAuth tokens too.
 * Only hashes of codes, tokens and secrets are stored.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 90 * 86400;
const REQUEST_TTL_S = 15 * 60;
const CODE_TTL_S = 5 * 60;
const MAX_REGISTRATIONS_PER_HOUR = 30;
/** Each sign-in attempt notifies the operator, so cap them. */
const MAX_SIGNINS_PER_HOUR = 10;

const DISPLAY_NAME = process.env.SB_DISPLAY_NAME || "Switchboard";
/** Timezone for operator-facing timestamps: SB_TZ, else the host's zone. */
const TZ = process.env.SB_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Short zone label ("CDT", "UTC", ...) shown next to those timestamps. */
const TZ_LABEL = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value || TZ;

/**
 * Extra private DNS suffixes (comma-separated SB_PRIVATE_HOST_SUFFIXES).
 * @returns {string[]}
 */
function privateHostSuffixes() {
  return (process.env.SB_PRIVATE_HOST_SUFFIXES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string} h - hostname
 * @returns {boolean}
 */
function isPrivateHostname(h) {
  if (/(^|\.)(localhost|local|internal|lan|home|ts\.net)$/.test(h)) return true;
  return privateHostSuffixes().some((s) => h === s || h.endsWith(`.${s}`));
}

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const rand = (n = 32) => b64url(randomBytes(n));
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Constant-time compare of two hex digests. */
function sameHash(a, b) {
  const x = Buffer.from(a || "", "hex");
  const y = Buffer.from(b || "", "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Redirect URIs must be https, or http on loopback (native/dev clients). */
function validRedirect(u) {
  try {
    const p = new URL(u);
    if (p.hash) return false;
    if (p.protocol === "https:") return true;
    return p.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(p.hostname);
  } catch {
    return false;
  }
}

/** A metadata-document URL must name a public DNS host (no IP literals or internal names). */
function publicHost(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (!h.includes(".") || /^[\d.]+$/.test(h) || h.startsWith("[")) return false;
    return !isPrivateHostname(h);
  } catch {
    return false;
  }
}

/**
 * Does a requested redirect_uri match a registered one? Exact match, except that loopback http URIs
 * may use any port (RFC 8252 §7.3): native apps like Codex register `http://127.0.0.1/callback/x`
 * and listen on whatever port is free.
 * @param {string[]} registered
 * @param {string} requested
 */
function redirectAllowed(registered, requested) {
  if (registered.includes(requested)) return true;
  try {
    const q = new URL(requested);
    if (q.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(q.hostname)) return false;
    return registered.some((r) => {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === q.hostname && u.pathname === q.pathname && u.search === q.search;
    });
  } catch {
    return false;
  }
}

export class OAuth {
  /**
   * @param {object} o
   * @param {string} o.dbPath
   * @param {string} o.publicUrl - external base URL, e.g. https://switchboard.example.com
   * @param {import("./registry.js").Registry} o.registry
   * @param {(kind: string, rec: object) => void} o.log
   * @param {(text: string, url: string) => Promise<void>} o.notify - tells the operator a sign-in is waiting
   */
  constructor({ dbPath, publicUrl, registry, log, notify }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        secret_sha256 TEXT,
        client_name TEXT,
        redirect_uris TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_requests (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        state TEXT,
        scope TEXT,
        resource TEXT,
        code_challenge TEXT NOT NULL,
        browser_sha256 TEXT NOT NULL,
        approve_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        code_sha256 TEXT,
        code_expires_at INTEGER,
        code_used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_sha256 TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        agent TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS tokens_agent ON tokens(agent);
    `);
    this.base = publicUrl.replace(/\/+$/, "");
    this.registry = registry;
    this.log = log;
    this.notify = notify;
  }

  close() {
    this.db.close();
  }

  // -- token checks used by every authenticated endpoint ----------------------

  /**
   * Resolve an OAuth access token to an agent name, or null.
   * @param {string|undefined} token
   */
  authenticate(token) {
    if (!token || !token.startsWith("sbo_")) return null;
    const row = this.db.prepare("SELECT agent, expires_at, revoked_at FROM tokens WHERE token_sha256 = ? AND kind = 'access'").get(sha(token));
    if (!row || row.revoked_at || row.expires_at <= now()) return null;
    return this.agentAllowed(row.agent) ? row.agent : null;
  }

  /** An agent may hold OAuth tokens only while it exists, is enabled and has `oauth: true`. */
  agentAllowed(agent) {
    const a = this.registry.agents?.[agent];
    return !!a && a.enabled !== false && a.oauth === true;
  }

  /** Agents the operator has opened to OAuth sign-in. */
  oauthAgents() {
    return Object.entries(this.registry.agents || {})
      .filter(([n]) => this.agentAllowed(n))
      .map(([n]) => n);
  }

  /** WWW-Authenticate value for a 401 on an MCP path (RFC 9728 §5.1). */
  challenge(pathname) {
    return `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource${pathname.replace(/\/+$/, "")}"`;
  }

  // -- metadata -----------------------------------------------------------------

  protectedResource(suffix) {
    return {
      resource: `${this.base}${suffix || "/mcp"}`,
      authorization_servers: [this.base],
      bearer_methods_supported: ["header"],
      resource_name: DISPLAY_NAME,
    };
  }

  authServer() {
    return {
      issuer: this.base,
      authorization_endpoint: `${this.base}/oauth/authorize`,
      token_endpoint: `${this.base}/oauth/token`,
      registration_endpoint: `${this.base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      client_id_metadata_document_supported: true,
      scopes_supported: ["switchboard"],
    };
  }

  // -- clients ------------------------------------------------------------------

  /**
   * RFC 7591 dynamic client registration.
   * @param {object} body
   */
  register(body) {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirect(u))) {
      return [400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be 1-10 https (or loopback http) URLs" }];
    }
    const recent = this.db.prepare("SELECT COUNT(*) AS n FROM clients WHERE created_at > ?").get(now() - 3600).n;
    if (recent >= MAX_REGISTRATIONS_PER_HOUR) return [429, { error: "temporarily_unavailable", error_description: "too many registrations" }];
    const method = ["client_secret_post", "client_secret_basic"].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : "none";
    const clientId = "sbc_" + rand(16);
    const secret = method === "none" ? null : "sbs_" + rand(32);
    const name = String(body.client_name || "").slice(0, 200) || null;
    this.db
      .prepare("INSERT INTO clients (client_id, secret_sha256, client_name, redirect_uris, auth_method, created_at) VALUES (?,?,?,?,?,?)")
      .run(clientId, secret ? sha(secret) : null, name, JSON.stringify(uris), method, now());
    this.log("events", { event: "oauth_client_registered", client_id: clientId, client_name: name, auth_method: method });
    const out = {
      client_id: clientId,
      client_id_issued_at: now(),
      client_name: name ?? undefined,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    };
    if (secret) Object.assign(out, { client_secret: secret, client_secret_expires_at: 0 });
    return [201, out];
  }

  /**
   * Look up a client; an https client_id is a Client ID Metadata Document, fetched and cached.
   * @param {string} clientId
   */
  async getClient(clientId) {
    if (!clientId) return null;
    const row = this.db.prepare("SELECT * FROM clients WHERE client_id = ?").get(clientId);
    if (row && !(clientId.startsWith("https://") && row.created_at < now() - 3600)) return { ...row, redirect_uris: JSON.parse(row.redirect_uris) };
    if (!clientId.startsWith("https://") || !publicHost(clientId)) return null;
    try {
      const r = await fetch(clientId, { signal: AbortSignal.timeout(5000), redirect: "error", headers: { accept: "application/json" } });
      const text = r.ok ? await r.text() : "";
      if (text.length > 65536) return null;
      const doc = JSON.parse(text);
      const uris = doc.redirect_uris;
      if (doc.client_id !== clientId || !Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && validRedirect(u))) return null;
      const name = String(doc.client_name || new URL(clientId).hostname).slice(0, 200);
      this.db
        .prepare("INSERT OR REPLACE INTO clients (client_id, secret_sha256, client_name, redirect_uris, auth_method, created_at) VALUES (?,?,?,?,?,?)")
        .run(clientId, null, name, JSON.stringify(uris), "none", now());
      return { client_id: clientId, secret_sha256: null, client_name: name, redirect_uris: uris, auth_method: "none" };
    } catch {
      return null;
    }
  }

  // -- authorization (browser side) ---------------------------------------------

  /**
   * GET /oauth/authorize: validate, record the request, notify the operator, show the waiting page.
   * Errors that can't safely redirect (bad client/redirect_uri) render a page instead.
   * @param {URLSearchParams} q
   */
  async authorize(q) {
    const client = await this.getClient(q.get("client_id"));
    if (!client) return page(400, "Unknown app", "This app isn't registered with the Switchboard.");
    const redirectUri = q.get("redirect_uri") || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
    if (!redirectAllowed(client.redirect_uris, redirectUri)) return page(400, "Bad redirect", "The app's return address doesn't match its registration.");
    const back = (error, desc) => redirect(redirectUri, { error, error_description: desc, state: q.get("state") ?? undefined, iss: this.base });
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "only code is supported");
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with S256 is required");

    const agents = this.oauthAgents();
    let agent = q.get("sb_agent");
    if (!agent) {
      if (agents.length === 1) agent = agents[0];
      else if (agents.length > 1) {
        const links = agents.map((a) => {
          const u = new URL(`${this.base}/oauth/authorize`);
          for (const [k, v] of q) u.searchParams.set(k, v);
          u.searchParams.set("sb_agent", a);
          return `<li><a href="${esc(u)}">${esc(a)}</a></li>`;
        });
        return page(200, "Connect as which agent?", `<p>Pick the Switchboard agent this app should act as:</p><ul>${links.join("")}</ul>`, true);
      }
    }
    if (!agent || !agents.includes(agent)) return back("access_denied", "no Switchboard agent is open to OAuth sign-in");

    if (this.db.prepare("SELECT COUNT(*) AS n FROM auth_requests WHERE created_at > ?").get(now() - 3600).n >= MAX_SIGNINS_PER_HOUR) {
      return back("temporarily_unavailable", "too many sign-in attempts; try again later");
    }
    const id = rand(12);
    const browserKey = rand();
    const approveKey = rand();
    this.db
      .prepare(
        "INSERT INTO auth_requests (id, client_id, agent, redirect_uri, state, scope, resource, code_challenge, browser_sha256, approve_sha256, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(id, client.client_id, agent, redirectUri, q.get("state"), q.get("scope"), q.get("resource"), challenge, sha(browserKey), sha(approveKey), "pending", now(), now() + REQUEST_TTL_S);
    const appName = client.client_name || client.client_id;
    this.log("events", { event: "oauth_authorize_requested", request: id, client_id: client.client_id, client_name: client.client_name, agent });
    let notified = true;
    try {
      await this.notify(`🔐 Switchboard sign-in\n"${appName}" wants to connect as agent "${agent}".\nOnly approve if you just started this. Expires in 15 min.`, `${this.base}/oauth/approve?t=${approveKey}`);
    } catch (e) {
      notified = false;
      this.log("events", { event: "oauth_notify_failed", request: id, error: String(e?.message || e).slice(0, 200) });
    }
    const poll = `${this.base}/oauth/authorize/poll?rid=${id}&k=${browserKey}`;
    const finish = `${this.base}/oauth/authorize/finish?rid=${id}&k=${browserKey}`;
    return page(
      200,
      `Waiting for the operator`,
      `<p><b>${esc(appName)}</b> is asking to connect to ${esc(DISPLAY_NAME)} as agent <b>${esc(agent)}</b>.</p>
       <p id="msg">${notified ? "Approval request sent to the operator. Keep this page open — it continues on its own once approved." : `Couldn't send a notification. Ask the operator to run <code>sb oauth pending</code>.`}</p>
       <script>
         const finish = ${JSON.stringify(finish)};
         async function tick() {
           try {
             const r = await (await fetch(${JSON.stringify(poll)}, { cache: "no-store" })).json();
             if (r.status === "approved" || r.status === "denied") { location.href = finish; return; }
             if (r.status === "expired") { document.getElementById("msg").textContent = "This request expired. Start the connection again."; return; }
           } catch {}
           setTimeout(tick, 2000);
         }
         tick();
       </script>`,
      true
    );
  }

  /** Load a live auth request by id + browser key (only the browser that started it may continue). */
  _browserRequest(q) {
    const r = this.db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(q.get("rid") || "");
    if (!r || !sameHash(r.browser_sha256, sha(q.get("k") || ""))) return null;
    if (r.status === "pending" && r.expires_at <= now()) {
      this.db.prepare("UPDATE auth_requests SET status='expired' WHERE id=?").run(r.id);
      r.status = "expired";
    }
    return r;
  }

  /** GET /oauth/authorize/poll */
  poll(q) {
    const r = this._browserRequest(q);
    return [r ? 200 : 404, { status: r ? r.status : "unknown" }];
  }

  /** GET /oauth/authorize/finish: hand the browser back to the app with a code (or the denial). */
  finish(q) {
    const r = this._browserRequest(q);
    if (!r) return page(404, "Not found", "This sign-in link is invalid.");
    if (r.status === "denied") return redirect(r.redirect_uri, { error: "access_denied", error_description: "Operator declined", state: r.state ?? undefined, iss: this.base });
    if (r.status !== "approved") return page(409, "Not approved", `This sign-in is ${esc(r.status)}.`);
    if (r.code_sha256) return page(409, "Already used", "This sign-in has already been completed.");
    const code = "sbac_" + rand();
    this.db.prepare("UPDATE auth_requests SET code_sha256=?, code_expires_at=? WHERE id=? AND code_sha256 IS NULL").run(sha(code), now() + CODE_TTL_S, r.id);
    return redirect(r.redirect_uri, { code, state: r.state ?? undefined, iss: this.base });
  }

  // -- approval (operator) ----------------------------------------------------

  _approveRequest(t) {
    const r = this.db.prepare("SELECT * FROM auth_requests WHERE approve_sha256 = ?").get(sha(t || ""));
    if (r && r.status === "pending" && r.expires_at <= now()) {
      this.db.prepare("UPDATE auth_requests SET status='expired' WHERE id=?").run(r.id);
      r.status = "expired";
    }
    return r;
  }

  /** GET /oauth/approve?t= — a review page. Approval needs a POST, so link previews can't approve. */
  approvePage(q) {
    const t = q.get("t") || "";
    const r = this._approveRequest(t);
    if (!r) return page(404, "Not found", "This approval link is invalid.");
    if (r.status !== "pending") return page(200, "Already handled", `This sign-in is ${esc(r.status)}.`);
    const c = this.db.prepare("SELECT client_name FROM clients WHERE client_id = ?").get(r.client_id);
    const g = this.registry.agents?.[r.agent]?.grants || {};
    return page(
      200,
      "Approve sign-in?",
      `<p><b>${esc(c?.client_name || r.client_id)}</b> wants to connect to your Switchboard as agent <b>${esc(r.agent)}</b>.</p>
       <p>It will get exactly ${esc(r.agent)}'s access: <code>${esc(Object.keys(g).join(", ") || "nothing")}</code>.</p>
       <p class="muted">Requested ${esc(new Date(r.created_at * 1000).toLocaleString("en-US", { timeZone: TZ }))} ${esc(TZ_LABEL)}. Only approve if you just started this.</p>
       <form method="post" action="${this.base}/oauth/approve">
         <input type="hidden" name="t" value="${esc(t)}">
         <button name="decision" value="approve" class="go">Approve</button>
         <button name="decision" value="deny">Deny</button>
       </form>`,
      true
    );
  }

  /** POST /oauth/approve */
  approve(form) {
    const r = this._approveRequest(form.get("t"));
    if (!r) return page(404, "Not found", "This approval link is invalid.");
    if (r.status !== "pending") return page(200, "Already handled", `This sign-in is ${esc(r.status)}.`);
    const ok = form.get("decision") === "approve";
    this.db.prepare("UPDATE auth_requests SET status=?, decided_at=? WHERE id=? AND status='pending'").run(ok ? "approved" : "denied", now(), r.id);
    this.log("events", { event: ok ? "oauth_approved" : "oauth_denied", request: r.id, client_id: r.client_id, agent: r.agent });
    return page(200, ok ? "Approved" : "Denied", ok ? `Signed in as <b>${esc(r.agent)}</b>. The app's window will finish on its own.` : "The app was told no.");
  }

  /** Pending sign-ins, for `sb oauth pending`. */
  pending() {
    return this.db.prepare("SELECT id, client_id, agent, created_at, expires_at FROM auth_requests WHERE status='pending' AND expires_at > ?").all(now());
  }

  // -- token endpoint ------------------------------------------------------------

  /** Authenticate the client at the token endpoint per its registered method. */
  async _tokenClient(params, authHeader) {
    let id = params.get("client_id");
    let secret = params.get("client_secret");
    const m = /^Basic\s+(.+)$/i.exec(authHeader || "");
    if (m) {
      const [u, p] = Buffer.from(m[1], "base64").toString("utf8").split(":");
      id = decodeURIComponent(u || "");
      secret = decodeURIComponent(p || "");
    }
    const client = await this.getClient(id);
    if (!client) return null;
    if (client.secret_sha256 && !sameHash(client.secret_sha256, sha(secret || ""))) return null;
    return client;
  }

  /** Mint an access + refresh token pair for an agent. */
  _issue(agent, clientId, scope) {
    const access = "sbo_" + rand();
    const refresh = "sbr_" + rand();
    const ins = this.db.prepare("INSERT INTO tokens (token_sha256, kind, agent, client_id, scope, created_at, expires_at) VALUES (?,?,?,?,?,?,?)");
    ins.run(sha(access), "access", agent, clientId, scope, now(), now() + ACCESS_TTL_S);
    ins.run(sha(refresh), "refresh", agent, clientId, scope, now(), now() + REFRESH_TTL_S);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scope || "switchboard" };
  }

  /**
   * POST /oauth/token
   * @param {URLSearchParams} params
   * @param {string|undefined} authHeader
   */
  async token(params, authHeader) {
    const client = await this._tokenClient(params, authHeader);
    if (!client) return [401, { error: "invalid_client" }];
    const grant = params.get("grant_type");

    if (grant === "authorization_code") {
      const code = params.get("code") || "";
      const r = this.db.prepare("SELECT * FROM auth_requests WHERE code_sha256 = ?").get(sha(code));
      if (!r || r.code_used || r.code_expires_at <= now() || r.client_id !== client.client_id) return [400, { error: "invalid_grant" }];
      // One shot: burn the code before anything else can go wrong.
      this.db.prepare("UPDATE auth_requests SET code_used=1 WHERE id=?").run(r.id);
      if (params.get("redirect_uri") && params.get("redirect_uri") !== r.redirect_uri) return [400, { error: "invalid_grant", error_description: "redirect_uri mismatch" }];
      const verifier = params.get("code_verifier") || "";
      if (b64url(createHash("sha256").update(verifier).digest()) !== r.code_challenge) return [400, { error: "invalid_grant", error_description: "PKCE check failed" }];
      if (!this.agentAllowed(r.agent)) return [400, { error: "invalid_grant", error_description: "agent no longer open to OAuth" }];
      this.log("events", { event: "oauth_token_issued", agent: r.agent, client_id: client.client_id });
      return [200, this._issue(r.agent, client.client_id, r.scope)];
    }

    if (grant === "refresh_token") {
      const old = this.db.prepare("SELECT * FROM tokens WHERE token_sha256 = ? AND kind='refresh'").get(sha(params.get("refresh_token") || ""));
      if (!old || old.client_id !== client.client_id || old.expires_at <= now()) return [400, { error: "invalid_grant" }];
      if (old.revoked_at) {
        // A rotated-out refresh token came back: assume it leaked and cut off the whole client.
        this.revoke({ client_id: old.client_id });
        this.log("events", { event: "oauth_refresh_reuse", agent: old.agent, client_id: old.client_id });
        return [400, { error: "invalid_grant" }];
      }
      if (!this.agentAllowed(old.agent)) return [400, { error: "invalid_grant", error_description: "agent no longer open to OAuth" }];
      this.db.prepare("UPDATE tokens SET revoked_at=? WHERE token_sha256=?").run(now(), old.token_sha256);
      return [200, this._issue(old.agent, client.client_id, old.scope)];
    }

    return [400, { error: "unsupported_grant_type" }];
  }

  /**
   * Revoke live tokens by agent and/or client. Returns how many were revoked.
   * @param {{agent?: string, client_id?: string}} by
   */
  revoke({ agent, client_id }) {
    const where = [];
    const args = [];
    if (agent) {
      where.push("agent = ?");
      args.push(agent);
    }
    if (client_id) {
      where.push("client_id = ?");
      args.push(client_id);
    }
    if (!where.length) return 0;
    return Number(this.db.prepare(`UPDATE tokens SET revoked_at=? WHERE revoked_at IS NULL AND ${where.join(" AND ")}`).run(now(), ...args).changes);
  }

  /** Live sign-ins (one row per client), for `sb oauth list`. */
  sessions() {
    return this.db
      .prepare(
        `SELECT t.agent, t.client_id, c.client_name, MIN(t.created_at) AS first, MAX(t.created_at) AS last
         FROM tokens t LEFT JOIN clients c ON c.client_id = t.client_id
         WHERE t.kind='refresh' AND t.revoked_at IS NULL AND t.expires_at > ? GROUP BY t.agent, t.client_id`
      )
      .all(now());
  }
}

/** An HTML page response: [status, body, headers]. */
function page(status, title, body, raw = false) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
h1{font-size:1.4rem}code{background:#f2f2f2;padding:.1em .3em;border-radius:4px}.muted{color:#666;font-size:.9rem}
button{font:inherit;padding:.6rem 1.4rem;margin:.5rem .5rem 0 0;border-radius:8px;border:1px solid #bbb;background:#fff}
button.go{background:#0a7d2c;color:#fff;border-color:#0a7d2c}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}code{background:#222}.muted{color:#999}button{background:#222;color:#eee;border-color:#444}}</style>
</head><body><h1>${esc(title)}</h1>${raw ? body : `<p>${body}</p>`}</body></html>`;
  return [status, html, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" }];
}

/** A 302 back to the client with query params: [status, body, headers]. */
function redirect(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return [302, "", { location: u.toString(), "cache-control": "no-store" }];
}

