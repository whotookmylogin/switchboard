#!/usr/bin/env node
/**
 * sb — onboard/offboard agents and inspect the Switchboard.
 *
 *   sb agent add <name> [--grant server[:tool,tool]]...   create agent, print its token once
 *   sb agent grant <name> --grant server[:tools]...        add grants
 *   sb agent revoke <name>                                 disable (token stops working immediately)
 *   sb agent enable <name>                                 re-enable
 *   sb agent rotate <name>                                 issue a new token
 *   sb agent remove <name>                                 delete the agent entirely
 *   sb agent oauth <name> on|off                           allow/stop OAuth sign-in as this agent (off revokes its OAuth tokens)
 *   sb agent list
 *   sb connect list
 *   sb status                                              live connector health
 *   sb log [agent] [--since 1h] [--server x]               audit trail
 *   sb snippet <agent> [connector...]                      MCP config for an agent to paste
 *
 *   sb arp list                                             open ARP requests + pending operator approvals
 *   sb arp audit [--limit N]                                full ARP audit trail (admin view)
 *   sb arp grants [agent]                                   ARP-minted grants (all, or one agent's)
 *   sb arp revoke <grant_id>                                revoke a grant immediately (as operator)
 *   sb arp approve <pending_id>                             approve a pending pair/tool_access/renewal
 *   sb arp deny <pending_id>                                deny it
 *   sb arp profile <agent> [--display x] [--operator x] [--capabilities a,b] [--policy x]
 *
 *   sb oauth list                                           live OAuth sign-ins (agent, app, when)
 *   sb oauth pending                                        sign-ins waiting for operator approval
 *   sb oauth revoke <agent|client_id>                       sign out immediately
 *
 *   sb tasks boards                                       list task boards (sqlite backend)
 *   sb tasks board-add <slug> [--name "..."]              create a task board
 *   sb tasks list [--board x] [--status y] [--assignee x] [--limit n]   list tasks
 *   sb tasks show <id>                                    one task: detail, comments, events
 *
 *   sb memory list [--entity x] [--topic x] [--flagged]     admin view of facts/notes (no clearance limit)
 *   sb memory get <key|id>                                  full row, raw JSON
 *   sb memory set <key> <value> [--label x] [--sensitivity x] [--note x] [--source x] [--why x]   (verified=1)
 *   sb memory note <kind> <title> --body x [--topics x] [--applies-to x] [--sensitivity x]         (verified=1)
 *   sb memory verify <id|key>                               mark operator-verified
 *   sb memory retire <id|key> --why x                        retire a note (facts can't be retired — flag instead)
 *   sb memory unflag <id|key>                                clear a flag
 *   sb memory history <id|key>                               version trail, no redaction
 *   sb memory access [--since 7d] [--agent x]                restricted/secret fact read log
 *   sb memory import <file.json>                             upsert facts by key, notes deduped by title
 *   sb memory export [--file x]                              dump everything (backup / review)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import YAML from "yaml";
import { sha256, OPERATOR } from "../src/registry.js";
import { ArpStore } from "../src/arp.js";
import { OAuth } from "../src/oauth.js";
import { MemoryStore, normalizeTitle } from "../src/memory.js";
import { TaskStore } from "../src/taskstore.js";

const ROOT = resolve(process.env.SB_HOME || new URL("..", import.meta.url).pathname);
const CONFIG_DIR = process.env.SB_CONFIG_DIR || join(ROOT, "config");
const LOG_DIR = process.env.SB_LOG_DIR || join(ROOT, "logs");
const DATA_DIR = process.env.SB_DATA_DIR || join(ROOT, "data");
const AGENTS = join(CONFIG_DIR, "agents.yaml");
const CONNS = join(CONFIG_DIR, "connections.yaml");
const BASE_URL = process.env.SB_URL || "http://127.0.0.1:3930";

/** Open the OAuth store read/write (same SQLite file the service uses; WAL makes this safe). */
function openOAuth() {
  return new OAuth({ dbPath: join(DATA_DIR, "oauth.sqlite"), publicUrl: "http://cli", registry: { agents: doc.agents }, log: () => {}, notify: async () => {} });
}

const readYaml = (p) => (existsSync(p) ? YAML.parse(readFileSync(p, "utf8")) || {} : {});

/** Atomically write agents.yaml (0600) and tell the running service to reload. */
function saveAgents(doc) {
  const tmp = AGENTS + ".tmp";
  writeFileSync(tmp, YAML.stringify(doc), { mode: 0o600 });
  renameSync(tmp, AGENTS);
  try {
    // --kill-who=main: HUP must reach only the Switchboard process. A group-wide HUP would also hit
    // every connector child and bounce them all (see docs/lessons.md).
    execSync("systemctl --user kill --kill-who=main -s HUP switchboard.service", { stdio: "ignore" });
    console.log("(reloaded via systemctl: SIGHUP to the service's main process)");
    return;
  } catch {}
  // No systemd (dev box, container, launchd): the service writes its pid to <data dir>/switchboard.pid
  // at startup and removes it on clean exit, so a scoped HUP can still reach the main process only.
  try {
    const pidFile = join(DATA_DIR, "switchboard.pid");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("empty pidfile");
    process.kill(pid, "SIGHUP");
    console.log(`(reloaded via SIGHUP to pid ${pid} from switchboard.pid)`);
    return;
  } catch {}
  console.error("(service not reloaded — is it running?)");
}

/** Parse repeated --grant server[:tool,tool] flags into a grants map. */
function parseGrants(args) {
  const grants = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--grant") continue;
    for (const g of args[++i].split(/\s+/)) {
      const [srv, tools] = g.split(":");
      grants[srv] = tools ? tools.split(",") : "*";
    }
  }
  return grants;
}

function parseSince(s) {
  const m = /^(\d+)([smhd])$/.exec(s || "24h");
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m?.[2] || "h"];
  return Date.now() - Number(m?.[1] || 24) * mult;
}

const [cmd, sub, ...rest] = process.argv.slice(2);
const doc = readYaml(AGENTS);
doc.agents ||= {};

if (cmd === "agent" && sub === "add") {
  const name = rest[0];
  if (!name || doc.agents[name]) throw new Error(`agent name missing or already exists: ${name}`);
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(name)) throw new Error(`invalid agent name: ${name}`);
  if (name === OPERATOR) throw new Error(`"${OPERATOR}" is the reserved operator identity; pick another agent name`);
  const token = "sb_" + randomBytes(24).toString("base64url");
  doc.agents[name] = { token_sha256: sha256(token), enabled: true, created: new Date().toISOString(), grants: parseGrants(rest) };
  saveAgents(doc);
  console.log(`Agent ${name} added. Token (shown once):\n${token}`);
} else if (cmd === "agent" && sub === "grant") {
  const a = doc.agents[rest[0]];
  if (!a) throw new Error(`no agent ${rest[0]}`);
  a.grants = { ...(a.grants || {}), ...parseGrants(rest) };
  saveAgents(doc);
  console.log(`Grants for ${rest[0]}:`, a.grants);
} else if (cmd === "agent" && (sub === "revoke" || sub === "enable")) {
  const a = doc.agents[rest[0]];
  if (!a) throw new Error(`no agent ${rest[0]}`);
  a.enabled = sub === "enable";
  a[sub === "revoke" ? "revoked" : "enabled_at"] = new Date().toISOString();
  saveAgents(doc);
  console.log(`${rest[0]} ${sub === "revoke" ? "revoked" : "enabled"}.`);
} else if (cmd === "agent" && sub === "remove") {
  if (!doc.agents[rest[0]]) throw new Error(`no agent ${rest[0]}`);
  delete doc.agents[rest[0]];
  saveAgents(doc);
  console.log(`${rest[0]} removed.`);
} else if (cmd === "agent" && sub === "oauth") {
  const [name, mode] = rest;
  const a = doc.agents[name];
  if (!a || !["on", "off"].includes(mode)) throw new Error("usage: sb agent oauth <name> on|off");
  if (mode === "on") a.oauth = true;
  else delete a.oauth;
  saveAgents(doc);
  if (mode === "off") {
    const o = openOAuth();
    console.log(`${o.revoke({ agent: name })} OAuth token(s) revoked.`);
    o.close();
  }
  console.log(`${name}: OAuth sign-in ${mode}.`);
} else if (cmd === "agent" && sub === "rotate") {
  const a = doc.agents[rest[0]];
  if (!a) throw new Error(`no agent ${rest[0]}`);
  const token = "sb_" + randomBytes(24).toString("base64url");
  a.token_sha256 = sha256(token);
  saveAgents(doc);
  console.log(`New token for ${rest[0]} (old one stops working now):\n${token}`);
} else if (cmd === "agent" && sub === "list") {
  for (const [n, a] of Object.entries(doc.agents)) {
    console.log(`${a.enabled === false ? "✗" : "✓"} ${n.padEnd(22)} ${Object.entries(a.grants || {}).map(([s, t]) => (t === "*" ? s : `${s}:${[].concat(t).join(",")}`)).join(" ")}`);
  }
} else if (cmd === "connect" && sub === "list") {
  for (const [n, c] of Object.entries(readYaml(CONNS).connections || {})) {
    console.log(`${c.enabled === false ? "✗" : "✓"} ${n.padEnd(22)} ${c.command} ${(c.args || []).join(" ")}${c.serialize ? "  [serialized]" : ""}`);
  }
} else if (cmd === "status") {
  const r = await fetch(`${BASE_URL}/healthz`).then((r) => r.json());
  for (const [n, s] of Object.entries(r.connectors)) {
    console.log(`${s.up ? "●" : "○"} ${n.padEnd(22)} pid=${s.pid ?? "-"} restarts=${s.restarts} inflight=${s.inflight}`);
  }
} else if (cmd === "log") {
  const agent = sub && !sub.startsWith("--") ? sub : undefined;
  const args = agent ? rest : [sub, ...rest];
  const since = parseSince(args[args.indexOf("--since") + 1] && args.includes("--since") ? args[args.indexOf("--since") + 1] : undefined);
  const server = args.includes("--server") ? args[args.indexOf("--server") + 1] : undefined;
  const files = readdirSync(LOG_DIR).filter((f) => f.startsWith("audit-")).sort();
  for (const f of files) {
    for (const line of readFileSync(join(LOG_DIR, f), "utf8").split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line);
      if (Date.parse(r.ts) < since || (agent && r.agent !== agent) || (server && r.server !== server)) continue;
      console.log(`${r.ts.slice(0, 19)} ${r.ok ? "ok " : r.denied ? "DENY" : "ERR"} ${r.agent.padEnd(16)} ${r.server}/${r.tool || r.method}${r.ms !== undefined ? ` ${r.ms}ms` : ""}${r.error ? ` — ${r.error}` : ""}`);
    }
  }
} else if (cmd === "arp") {
  const store = new ArpStore(join(DATA_DIR, "arp.sqlite"));
  const parseFlags = (args) => {
    const f = {};
    for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) f[args[i].slice(2)] = args[i + 1];
    return f;
  };
  if (sub === "list") {
    const pending = store.listPendingApprovals();
    console.log(`-- pending operator approvals (${pending.length}) --`);
    for (const p of pending) console.log(`#${p.id} [${p.kind}] ${p.summary}`);
    const reqs = store.db.prepare("SELECT * FROM requests WHERE status IN ('pending','awaiting_operator','needs_info') ORDER BY created_at DESC LIMIT 50").all();
    console.log(`\n-- open requests (${reqs.length}) --`);
    for (const r of reqs) console.log(`${r.request_id}  ${r.from_agent} -> ${r.to_agent}  ${r.type}  ${r.status}  "${r.subject}"`);
  } else if (sub === "audit") {
    const f = parseFlags(rest);
    for (const e of store.auditLog(OPERATOR, { limit: f.limit })) console.log(`${e.ts}  ${(e.actor || "-").padEnd(14)} ${e.event.padEnd(20)} ${e.from_agent || ""}${e.to_agent ? " -> " + e.to_agent : ""} ${e.request_id || ""} ${e.grant_id || ""}`);
  } else if (sub === "grants") {
    for (const g of store.listGrants(rest[0])) console.log(`${g.active ? "●" : "○"} ${g.grant_id}  ${g.agent_id} -> ${g.connector}/${g.tool}${g.scope ? " scope=" + JSON.stringify(g.scope) : ""}  expires=${g.expires_at.slice(0, 10)}${g.revoked_at ? "  REVOKED" : ""}`);
  } else if (sub === "revoke") {
    console.log(JSON.stringify(store.revokeGrant(OPERATOR, rest[0])));
  } else if (sub === "approve" || sub === "deny") {
    const id = Number(rest[0]);
    if (!id) throw new Error("usage: sb arp approve|deny <pending_id>");
    console.log(JSON.stringify(store.resolvePendingApproval(id, sub === "approve", OPERATOR)));
  } else if (sub === "profile") {
    const f = parseFlags(rest);
    const agent = rest[0];
    if (!agent) throw new Error("usage: sb arp profile <agent> [--display x] [--operator x] [--capabilities a,b] [--policy x]");
    console.log(JSON.stringify(store.updateProfile(agent, { display_name: f.display, operator: f.operator, capabilities: f.capabilities ? f.capabilities.split(",") : undefined, contact_policy: f.policy })));
  } else {
    console.log("usage: sb arp list|audit|grants|revoke|approve|deny|profile ...");
  }
  store.close();
} else if (cmd === "oauth") {
  const o = openOAuth();
  const when = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  if (sub === "list") {
    const rows = o.sessions();
    if (!rows.length) console.log("(no live OAuth sign-ins)");
    for (const r of rows) console.log(`${r.agent.padEnd(14)} ${String(r.client_name || "?").padEnd(24)} ${r.client_id}  since ${when(r.first)}  last refresh ${when(r.last)}`);
  } else if (sub === "pending") {
    const rows = o.pending();
    if (!rows.length) console.log("(nothing waiting)");
    for (const r of rows) console.log(`${r.id}  ${r.agent}  ${r.client_id}  requested ${when(r.created_at)}  expires ${when(r.expires_at)}`);
  } else if (sub === "revoke" && rest[0]) {
    const n = doc.agents[rest[0]] ? o.revoke({ agent: rest[0] }) : o.revoke({ client_id: rest[0] });
    console.log(`${n} token(s) revoked.`);
  } else {
    console.log("usage: sb oauth list|pending|revoke <agent|client_id>");
  }
  o.close();
} else if (cmd === "memory") {
  const store = new MemoryStore(process.env.SB_MEMORY || join(DATA_DIR, "memory.sqlite"));
  // Unlike parseGrants/the arp parseFlags above, a bare trailing --flag (no value) is a boolean here,
  // since `sb memory list --flagged` has no value to consume.
  const parseFlags = (args) => {
    const f = {};
    for (let i = 0; i < args.length; i++) {
      if (!args[i].startsWith("--")) continue;
      const next = args[i + 1];
      f[args[i].slice(2)] = next === undefined || next.startsWith("--") ? true : args[++i];
    }
    return f;
  };
  /** Import facts (upsert by key) and notes (deduped by normalized title) from a JSON file, as OPERATOR, verified. */
  function importFile(file) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const why = `import ${basename(file)}`;
    const counts = { facts_added: 0, facts_updated: 0, facts_unchanged: 0, notes_added: 0, notes_updated: 0, notes_unchanged: 0 };
    for (const f of data.facts || []) {
      const key = String(f.key).toLowerCase();
      const existing = store.getFact(key);
      const same = existing && existing.value === String(f.value) && (existing.label || null) === (f.label ?? null) && (existing.sensitivity || "internal") === (f.sensitivity || "internal") && (existing.note || null) === (f.note ?? null) && (existing.source || null) === (f.source ?? null);
      if (same) {
        counts.facts_unchanged++;
        continue;
      }
      store.upsertFact({ key, label: f.label, value: f.value, sensitivity: f.sensitivity || "internal", note: f.note, source: f.source }, { by: OPERATOR, why, verified: true });
      counts[existing ? "facts_updated" : "facts_added"]++;
    }
    for (const n of data.notes || []) {
      const existing = store.findActiveByNormalizedTitle(normalizeTitle(n.title));
      if (!existing) {
        store.insertNote({ kind: n.kind, title: n.title, body: n.body, topics: n.topics || "", applies_to: n.applies_to || "all", sensitivity: n.sensitivity || "internal" }, { by: OPERATOR, verified: true });
        counts.notes_added++;
      } else if (existing.body !== n.body) {
        store.updateNote(existing.id, { title: n.title, body: n.body, topics: n.topics }, { by: OPERATOR, why });
        store.verifyNote(existing.id, OPERATOR); // import is a trusted bulk admin write, unlike an agent's `update`
        counts.notes_updated++;
      } else {
        counts.notes_unchanged++;
      }
    }
    return counts;
  }

  if (sub === "list") {
    const f = parseFlags(rest);
    if (f.entity) {
      for (const r of store.listFactsByEntity(f.entity, 1000)) console.log(`${r.flag ? "⚑" : r.verified ? "✓" : " "} ${r.key} = ${r.value}${r.label ? " · " + r.label : ""} [${r.sensitivity}]`);
    } else if (f.topic) {
      for (const r of store.listNotesByTopic(f.topic, 1000)) console.log(`${r.status === "flagged" ? "⚑" : r.verified ? "✓" : " "} ${r.id} ${r.kind} "${r.title}" [${r.sensitivity}/${r.status}]`);
    } else if (f.flagged) {
      for (const r of store.db.prepare("SELECT * FROM facts WHERE flag IS NOT NULL ORDER BY key").all()) console.log(`fact  ${r.key}: ${r.flag}`);
      for (const r of store.db.prepare("SELECT * FROM notes WHERE status='flagged' ORDER BY updated_at DESC").all()) console.log(`note  ${r.id} "${r.title}": ${r.flag}`);
    } else {
      for (const r of store.db.prepare("SELECT key, value, label, sensitivity, verified FROM facts ORDER BY key").all()) console.log(`fact  ${r.verified ? "✓" : " "} ${r.key} = ${r.value}${r.label ? " · " + r.label : ""} [${r.sensitivity}]`);
      for (const r of store.db.prepare("SELECT id, kind, title, sensitivity, status, verified FROM notes ORDER BY created_at DESC").all()) console.log(`note  ${r.verified ? "✓" : " "} ${r.id} ${r.kind} "${r.title}" [${r.sensitivity}/${r.status}]`);
    }
  } else if (sub === "get") {
    const ref = rest[0];
    if (!ref) throw new Error("usage: sb memory get <key|id>");
    const row = ref.startsWith("n_") ? store.getNote(ref) : store.getFact(ref.toLowerCase());
    if (!row) throw new Error(`not found: ${ref}`);
    console.log(JSON.stringify(row, null, 2));
  } else if (sub === "set") {
    const [key, value] = rest;
    const f = parseFlags(rest.slice(2));
    if (!key || value === undefined) throw new Error("usage: sb memory set <key> <value> [--label x] [--sensitivity x] [--note x] [--source x] [--why x]");
    const r = store.upsertFact({ key, label: f.label, value, sensitivity: f.sensitivity || "internal", note: f.note, source: f.source }, { by: OPERATOR, why: f.why || "sb memory set", verified: true });
    console.log(`${r.inserted ? "Added" : "Updated"} ${r.key} (v${r.version}).`);
  } else if (sub === "note") {
    const [kind, title] = rest;
    const f = parseFlags(rest.slice(2));
    if (!kind || !title || !f.body) throw new Error("usage: sb memory note <kind> <title> --body x [--topics x] [--applies-to x] [--sensitivity x]");
    const id = store.insertNote({ kind, title, body: f.body, topics: f.topics || "", applies_to: f["applies-to"] || "all", sensitivity: f.sensitivity || "internal" }, { by: OPERATOR, verified: true });
    console.log(`Saved as ${id}.`);
  } else if (sub === "verify") {
    const ref = rest[0];
    if (!ref) throw new Error("usage: sb memory verify <id|key>");
    const row = ref.startsWith("n_") ? store.verifyNote(ref, OPERATOR) : store.verifyFact(ref.toLowerCase(), OPERATOR);
    if (!row) throw new Error(`not found: ${ref}`);
    console.log(`Verified ${ref}.`);
  } else if (sub === "retire") {
    const ref = rest[0];
    const f = parseFlags(rest.slice(1));
    if (!ref || !f.why) throw new Error("usage: sb memory retire <id> --why x");
    if (!ref.startsWith("n_")) throw new Error("only notes can be retired; flag a fact instead (facts have no retired state)");
    const row = store.retireNote(ref, f.why, OPERATOR);
    if (!row) throw new Error(`not found: ${ref}`);
    console.log(`Retired ${ref}.`);
  } else if (sub === "unflag") {
    const ref = rest[0];
    if (!ref) throw new Error("usage: sb memory unflag <id|key>");
    const row = ref.startsWith("n_") ? store.unflagNote(ref, OPERATOR) : store.unflagFact(ref.toLowerCase(), OPERATOR);
    if (!row) throw new Error(`not found: ${ref}`);
    console.log(`Unflagged ${ref}.`);
  } else if (sub === "history") {
    const ref = rest[0];
    if (!ref) throw new Error("usage: sb memory history <id|key>");
    const refType = ref.startsWith("n_") ? "note" : "fact";
    for (const r of store.getHistory(refType, refType === "fact" ? ref.toLowerCase() : ref, 200)) console.log(`${r.ts}  ${r.action.padEnd(8)} by ${(r.by || "?").padEnd(12)} ${r.why || ""}`);
  } else if (sub === "access") {
    const f = parseFlags(rest);
    const since = f.since ? new Date(parseSince(f.since)).toISOString() : undefined;
    for (const r of store.listAccess({ since, agent: f.agent })) console.log(`${r.ts}  ${r.agent.padEnd(14)} ${r.key}  ${r.reason || ""}`);
  } else if (sub === "import") {
    const file = rest[0];
    if (!file) throw new Error("usage: sb memory import <file.json>");
    console.log(JSON.stringify(importFile(file)));
  } else if (sub === "export") {
    const f = parseFlags(rest);
    const dump = { facts: store.db.prepare("SELECT * FROM facts ORDER BY key").all(), notes: store.db.prepare("SELECT * FROM notes ORDER BY created_at").all() };
    const json = JSON.stringify(dump, null, 2);
    if (f.file) {
      writeFileSync(f.file, json);
      console.log(`Exported to ${f.file}.`);
    } else console.log(json);
  } else {
    console.log("usage: sb memory list|get|set|note|verify|retire|unflag|history|access|import|export ...");
  }
  store.close();
} else if (cmd === "tasks") {
  // Direct access to the built-in sqlite task store (the default tasks backend).
  if (process.env.SB_TASKS_BACKEND && process.env.SB_TASKS_BACKEND !== "sqlite") {
    console.error(`SB_TASKS_BACKEND=${process.env.SB_TASKS_BACKEND}: sb tasks only works with the sqlite backend.`);
    process.exit(1);
  }
  const store = new TaskStore(process.env.SB_TASKS_DB || join(DATA_DIR, "tasks.sqlite"));
  const parseFlags = (args) => {
    const f = {};
    for (let i = 0; i < args.length; i++) {
      if (!args[i].startsWith("--")) continue;
      const next = args[i + 1];
      f[args[i].slice(2)] = next === undefined || next.startsWith("--") ? true : args[++i];
    }
    return f;
  };
  const result = (op, args) => {
    const r = store.call(op, "cli", args);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  if (sub === "boards") {
    for (const b of result("boards", {}).boards) console.log(`${b.slug.padEnd(20)} ${b.name || ""}`);
  } else if (sub === "board-add") {
    const slug = rest[0];
    const f = parseFlags(rest.slice(1));
    if (!slug) throw new Error("usage: sb tasks board-add <slug> [--name \"...\"]");
    const b = store.addBoard(slug, f.name);
    console.log(`Board ${b.slug} ready.`);
  } else if (sub === "list") {
    const f = parseFlags(rest);
    for (const t of result("list", { board: f.board, status: f.status, assignee: f.assignee, limit: f.limit ? Number(f.limit) : undefined }).tasks) {
      console.log(`${t.id}  ${t.board.padEnd(14)} ${t.status.padEnd(9)} ${String(t.assignee || "-").padEnd(10)} ${t.title}`);
    }
  } else if (sub === "show") {
    if (!rest[0]) throw new Error("usage: sb tasks show <id>");
    console.log(JSON.stringify(result("show", { id: rest[0] }), null, 2));
  } else {
    console.log("usage: sb tasks boards|board-add|list|show ...");
  }
  store.close();
} else if (cmd === "snippet") {
  const a = doc.agents[sub];
  if (!a) throw new Error(`no agent ${sub}`);
  const all = Object.keys(readYaml(CONNS).connections || {});
  const granted = all.filter((c) => Object.keys(a.grants || {}).some((g) => g === "*" || g === c));
  const conns = rest.length ? rest : granted;
  console.log(JSON.stringify({ mcpServers: Object.fromEntries(conns.map((c) => [c, { type: "http", url: `${BASE_URL}/mcp/${c}`, headers: { Authorization: "Bearer <token>" } }])) }, null, 2));
} else {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 16).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
}
