// Unit tests for the built-in `memory` connector: clearance filtering, write permissions, credential
// rejection, dedup, history/access logging, and CLI import idempotency. Run: node --test test/memory.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MemoryStore, MemoryBackend, findCredential } from "../src/memory.js";

const dir = mkdtempSync(join(tmpdir(), "sb-memory-"));
const store = new MemoryStore(join(dir, "memory.sqlite"));

// codex: ordinary internal-clearance agent. restricted-agent: restricted-clearance, non-admin. operator-admin: full admin.
// intern-admin: admin but only internal clearance, to test the sensitivity-above-clearance write check.
const CLEARANCE = { codex: "internal", "restricted-agent": "restricted", "operator-admin": "secret", "intern-admin": "internal" };
const ADMIN = new Set(["operator-admin", "intern-admin"]);
const backend = new MemoryBackend(store, { clearanceOf: (a) => CLEARANCE[a] || "internal", isAdmin: (a) => ADMIN.has(a) });

const txt = (r) => r.content[0].text;
const call = (agent, name, args = {}) => backend.request({ method: "tools/call", params: { name, arguments: args } }, agent === undefined ? {} : { agent });

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("tools/list exposes the eight memory tools", async () => {
  const { tools } = await backend.request({ method: "tools/list" });
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["flag", "get_fact", "history", "profile", "recall", "remember", "set_fact", "update"].sort()
  );
});

test("missing opts.agent is refused", async () => {
  const r = await call(undefined, "recall", {});
  assert.equal(r.isError, true);
  assert.match(txt(r), /no caller identity/);
});

test("set_fact: non-admin refused, admin can write, agents can never set verified=1", async () => {
  const denied = await call("codex", "set_fact", { key: "acme.uei", value: "UEIEXAMPLE123", source: "sam.gov", why: "seed" });
  assert.equal(denied.isError, true);
  assert.match(txt(denied), /not a memory admin/);
  assert.equal(store.getFact("acme.uei"), null);

  const added = await call("operator-admin", "set_fact", { key: "acme.uei", value: "UEIEXAMPLE123", label: "SAM UEI", note: "use on gov quotes", source: "sam.gov", why: "seed" });
  assert.match(txt(added), /^Added acme\.uei/);
  assert.equal(store.getFact("acme.uei").verified, 0);

  // a second write updates in place and bumps version
  const updated = await call("operator-admin", "set_fact", { key: "acme.uei", value: "UEIEXAMPLE123", source: "sam.gov", why: "touch" });
  assert.match(txt(updated), /^Updated acme\.uei \(v2\)/);
});

test("set_fact refuses a write above the caller's own clearance", async () => {
  const r = await call("intern-admin", "set_fact", { key: "acme.topsecret", value: "x", sensitivity: "secret", source: "test", why: "test" });
  assert.equal(r.isError, true);
  assert.match(txt(r), /clearance/);
});

test("credential-looking values are rejected in set_fact, remember and update", async () => {
  const fact = await call("operator-admin", "set_fact", { key: "acme.creds", value: "password: hunter2", source: "test", why: "test" });
  assert.equal(fact.isError, true);
  assert.match(txt(fact), /password manager/);

  const note = await call("codex", "remember", { kind: "tip", title: "Shopify token", body: "sk-abcdefghijklmnopqrstuvwxyz0123456789" });
  assert.equal(note.isError, true);
  assert.match(txt(note), /password manager/);

  const saved = await call("codex", "remember", { kind: "tip", title: "Credential edit test", body: "a clean body about nothing secret" });
  const id = txt(saved).match(/n_\w+/)[0];
  const edit = await call("codex", "update", { id, body: "xoxb-1234567890-abcdefghijk", why: "oops" });
  assert.equal(edit.isError, true);
  assert.match(txt(edit), /password manager/);
});

test("remember dedups by title unless force: true", async () => {
  const first = await call("codex", "remember", { kind: "rule", title: "Never send without operator OK", body: "Always get explicit confirmation before sending customer emails.", topics: "email outreach" });
  assert.match(txt(first), /^Saved as n_/);

  const dup = await call("restricted-agent", "remember", { kind: "rule", title: "never send without operator ok!!", body: "different wording, same idea" });
  assert.equal(dup.isError, true);
  assert.match(txt(dup), /similar active note already exists/);

  const forced = await call("restricted-agent", "remember", { kind: "rule", title: "never send without operator ok!!", body: "different wording, same idea", force: true });
  assert.match(txt(forced), /^Saved as n_/);
});

test("update by another agent, or of a verified note, clears verified and records history", async () => {
  const saved = await call("codex", "remember", { kind: "tip", title: "Verified note test", body: "original body" });
  const id = txt(saved).match(/n_\w+/)[0];
  store.verifyNote(id, "operator"); // simulate `sb memory verify` (only the CLI can set verified=1)
  assert.equal(store.getNote(id).verified, 1);

  const edited = await call("restricted-agent", "update", { id, body: "revised by someone else", why: "correcting a detail" });
  assert.match(txt(edited), /^Updated/);
  const after1 = store.getNote(id);
  assert.equal(after1.verified, 0);
  assert.equal(after1.body, "revised by someone else");

  const hist = store.getHistory("note", id);
  assert.ok(hist.some((h) => h.action === "update" && h.why === "correcting a detail" && h.snapshot.verified === 1));
});

test("flag marks a note or fact and shows up in recall", async () => {
  const saved = await call("codex", "remember", { kind: "gotcha", title: "Flaggable note", body: "something that might be wrong", topics: "flagtest" });
  const id = txt(saved).match(/n_\w+/)[0];
  const flagged = await call("codex", "flag", { id_or_key: id, problem: "Operator says this is outdated" });
  assert.match(txt(flagged), /^Flagged/);
  const listed = await call("codex", "recall", { topic: "flagtest" });
  assert.match(txt(listed), /\[flagged: Operator says this is outdated\]/);

  await call("operator-admin", "set_fact", { key: "acme.flaggable", value: "v1", source: "test", why: "test" });
  const factFlagged = await call("codex", "flag", { id_or_key: "acme.flaggable", problem: "value looks stale" });
  assert.match(txt(factFlagged), /^Flagged/);
  assert.equal(store.getFact("acme.flaggable").flag, "value looks stale");
});

test("clearance filtering: a restricted fact's value never appears to an internal agent, count only", async () => {
  await call("operator-admin", "set_fact", { key: "acme.fein", value: "12-3456789", label: "FEIN", sensitivity: "restricted", source: "IRS letter", why: "seed" });

  const asInternal = await call("codex", "recall", { entity: "acme" });
  assert.doesNotMatch(txt(asInternal), /12-3456789/);
  assert.match(txt(asInternal), /more entr(y needs|ies need) higher clearance/);

  // restricted clearance CAN see the entry exists, but recall still never reveals the value
  const asRestricted = await call("restricted-agent", "recall", { entity: "acme" });
  assert.doesNotMatch(txt(asRestricted), /12-3456789/);
  assert.match(txt(asRestricted), /acme\.fein \(restricted: use get_fact with a reason\)/);

  const profileInternal = await call("codex", "profile", { entity: "acme" });
  assert.doesNotMatch(txt(profileInternal), /12-3456789/);
});

test("get_fact: restricted read requires a reason (>=8 chars) and logs access", async () => {
  const noReason = await call("restricted-agent", "get_fact", { key: "acme.fein" });
  assert.equal(noReason.isError, true);
  assert.match(txt(noReason), /requires a "reason"/);

  const shortReason = await call("restricted-agent", "get_fact", { key: "acme.fein", reason: "why" });
  assert.equal(shortReason.isError, true);

  const before1 = store.listAccess({ agent: "restricted-agent" }).length;
  const ok = await call("restricted-agent", "get_fact", { key: "acme.fein", reason: "filling out an SF-33 form" });
  assert.match(txt(ok), /^acme\.fein = 12-3456789/);
  const after1 = store.listAccess({ agent: "restricted-agent" });
  assert.equal(after1.length, before1 + 1);
  assert.equal(after1[0].reason, "filling out an SF-33 form");

  // above the caller's clearance entirely: invisible, not just reason-gated
  await call("operator-admin", "set_fact", { key: "acme.wiretransfer", value: "secret-acct", sensitivity: "secret", source: "bank", why: "seed" });
  const tooLow = await call("codex", "get_fact", { key: "acme.wiretransfer", reason: "a perfectly long enough reason" });
  assert.equal(tooLow.isError, true);
  assert.match(txt(tooLow), /clearance/);
});

test("profile: restricted facts are withheld without a reason, included (and logged) with one", async () => {
  const withheld = await call("restricted-agent", "profile", { entity: "acme" });
  assert.match(txt(withheld), /acme\.fein \(restricted: use get_fact with a reason\)/);
  assert.doesNotMatch(txt(withheld), /12-3456789/);

  const before1 = store.listAccess({ agent: "restricted-agent" }).length;
  const revealed = await call("restricted-agent", "profile", { entity: "acme", reason: "quarterly compliance review" });
  assert.match(txt(revealed), /acme\.fein = 12-3456789/);
  assert.equal(store.listAccess({ agent: "restricted-agent" }).length, before1 + 1);
});

test("history redacts values above the caller's clearance", async () => {
  // the insert has no "previous row" to show; touch it once so there's a snapshot with a real value to redact
  await call("operator-admin", "set_fact", { key: "acme.fein", value: "12-3456789", label: "FEIN", sensitivity: "restricted", source: "IRS letter", why: "touch" });

  const asInternal = await call("codex", "history", { id_or_key: "acme.fein" });
  assert.match(txt(asInternal), /\[redacted/);
  assert.doesNotMatch(txt(asInternal), /12-3456789/);

  // even a cleared agent never sees a restricted value through history (only get_fact/profile with a logged reason)
  const asAdmin = await call("operator-admin", "history", { id_or_key: "acme.fein" });
  assert.match(txt(asAdmin), /not shown; use get_fact/);
  assert.doesNotMatch(txt(asAdmin), /12-3456789/);
});

test("CLI import: facts upsert by key, notes dedup by title, second run is fully idempotent", () => {
  const importDir = mkdtempSync(join(tmpdir(), "sb-memory-import-"));
  const env = { ...process.env, SB_DATA_DIR: importDir, SB_CONFIG_DIR: importDir, SB_LOG_DIR: importDir };
  writeFileSync(join(importDir, "agents.yaml"), "agents: {}\n");
  const payload = {
    facts: [{ key: "acme.cage", label: "CAGE code", value: "CAGE0", source: "sam.gov" }],
    notes: [{ kind: "howto", title: "How to file an SF-33", body: "Use the capability statement template in Drive.", topics: "gov contracting" }],
  };
  const file = join(importDir, "seed.json");
  writeFileSync(file, JSON.stringify(payload));

  const run = () => JSON.parse(execFileSync("node", [new URL("../bin/sb.js", import.meta.url).pathname, "memory", "import", file], { env }).toString());
  const first = run();
  assert.deepEqual(first, { facts_added: 1, facts_updated: 0, facts_unchanged: 0, notes_added: 1, notes_updated: 0, notes_unchanged: 0 });
  const second = run();
  assert.deepEqual(second, { facts_added: 0, facts_updated: 0, facts_unchanged: 1, notes_added: 0, notes_updated: 0, notes_unchanged: 1 });

  rmSync(importDir, { recursive: true, force: true });
});

test("credential filter: pointers and paths pass, real secrets fail", () => {
  assert.equal(findCredential("API token: vault item Example"), null);
  assert.equal(findCredential("Config lives at /etc/switchboard/config/agents.yaml and /var/lib/agent/profiles/example/config.yaml"), null);
  assert.equal(findCredential("CAGE CAGE0, UEI UEIEXAMPLE123, NAICS 541511"), null);
  assert.ok(findCredential("password: Hunter2024!"));
  assert.ok(findCredential("api_key=9f8e7d6c5b4a"));
  assert.ok(findCredential("use sk-ant-api03-abcdefghijklmnopqrstuv"));
  assert.ok(findCredential("key aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"));
  assert.equal(findCredential("Drive library id 1zlMlEY5Lk5Zu9l9E5yPsuwoVsMd-gbd8; AR sheet 1YGj1VNcG0OBe-dsUHcQOEfCaLmaR7wzl9sDQBLsRJfE"), null);
});

test("remember dedup only reports notes the caller could read; secret and off-audience notes stay silent", async () => {
  // A secret note an internal agent must never learn about, even via the "already exists" reply.
  store.insertNote({ kind: "rule", title: "Vault door rotation", body: "the schedule is quarterly at 03:00", sensitivity: "secret" }, { by: "operator", verified: true });
  const r = await call("codex", "remember", { kind: "tip", title: "Vault door rotation", body: "an unrelated tip about doors" });
  assert.match(txt(r), /^Saved as n_/);
  assert.doesNotMatch(txt(r), /similar active note|quarterly at 03:00/);

  // Same for a note that isn't applies_to the caller.
  store.insertNote({ kind: "tip", title: "Offboard checklist", body: "steps for the leaver runbook", sensitivity: "internal", applies_to: "restricted-agent" }, { by: "restricted-agent" });
  const r2 = await call("codex", "remember", { kind: "tip", title: "Offboard checklist", body: "codex's own take" });
  assert.match(txt(r2), /^Saved as n_/);

  // And a visible duplicate still reports as before.
  const visible = await call("codex", "remember", { kind: "rule", title: "never send without operator ok", body: "reworded" });
  assert.match(txt(visible), /similar active note already exists/);
});

test("public fact values are searchable; restricted values are not", async () => {
  await call("operator-admin", "set_fact", { key: "acme.cage", value: "9ZZ99", label: "CAGE code", sensitivity: "public", source: "sam", why: "t" });
  assert.match(txt(await call("codex", "recall", { q: "9ZZ99" })), /acme\.cage = 9ZZ99/);
  assert.doesNotMatch(txt(await call("codex", "recall", { q: "12-3456789" })), /fein/);
});
