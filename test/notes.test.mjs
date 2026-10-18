// Unit tests for the notes connector: frontmatter parsing, redaction, index build/search, and the MCP
// tool surface. Run: node --test test/notes.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNoteFile, redactBody, collectNotes, buildNotesIndex, searchNotes, readNote, notesMeta, NotesBackend } from "../src/notes.js";

const dir = mkdtempSync(join(tmpdir(), "sb-notes-"));
const notesDir = join(dir, "notes");
const dbPath = join(dir, "notes.sqlite");

/** Write one note file under notesDir/<host>/<file>.md. */
function writeNote(host, file, { name, description = "", type = "reference", body }) {
  const hostDir = join(notesDir, host);
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, file), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  type: ${type}\n---\n${body}\n`);
}

before(() => {
  writeNote("dev-host", "deploy_checklist.md", {
    name: "deploy-checklist",
    description: "DNS trk.example.com CNAME verified; confirm new links use trk",
    type: "project",
    body: "Email click tracking uses a custom trk.example.com CNAME for outbound links, verified 2026-10-10. Default UTMs apply automatically.",
  });
  writeNote("dev-host", "prod_change_lock.md", {
    name: "prod-change-lock",
    description: "change-lock wait restart before any prod ERP upgrade/restart",
    type: "project",
    body: "Before ANY module install/upgrade, ERP restart, or long bulk import on prod, run `change-lock status`, then `change-lock wait restart` (exclusive) or `change-lock acquire job` (imports), and `change-lock release <id>` when done. Operator 2026-10-12: no two workers change prod at once.",
  });
  writeNote("dev-host", "vendor_outreach.md", {
    name: "vendor-outreach",
    description: "Vendor outreach drafts unsent",
    type: "feedback",
    body: "Outreach drafts to several vendors are unsent. Spec documented in the ticket thread.",
  });
  // A credential-bearing note: must come back fully redacted.
  writeNote("dev-host", "device_access.md", {
    name: "device-access",
    description: "Lab device access",
    type: "reference",
    body: [
      "Device SSH: alice / master02 (sshpass -p master02 ssh alice@10.0.0.50); sudo password also master02, NOT passwordless.",
      "Web console login user is also alice.",
      "Router admin pw on file is REJECTED.",
    ].join("\n"),
  });
  // Older file shape with extra metadata keys that must be ignored, not break parsing.
  mkdirSync(join(notesDir, "dev-host"), { recursive: true });
  writeFileSync(
    join(notesDir, "dev-host", "ticket_integration.md"),
    "---\nname: ticket-integration\ndescription: Cross-system link for production tickets\nmetadata: \n  node_type: memory\n  type: project\n  originSessionId: c93daba1-8c05-47b4-a705-86a0cd74b536\n---\n\nDetail page shows live open production tickets for a SKU.\n"
  );
  // No `name:` -> skipped (models MEMORY.md, which is also skipped by filename regardless).
  writeFileSync(join(notesDir, "dev-host", "MEMORY.md"), "# Claude Code Memory\n- some index\n");
  writeFileSync(join(notesDir, "dev-host", "no_name.md"), "---\ndescription: missing a name\nmetadata:\n  type: reference\n---\nbody\n");
  // Duplicate name on a second host, older mtime -> the newer one (dev-host, written above) should win.
  mkdirSync(join(notesDir, "other-host"), { recursive: true });
  writeFileSync(join(notesDir, "other-host", "deploy_checklist.md"), "---\nname: deploy-checklist\ndescription: \"stale copy\"\nmetadata:\n  type: project\n---\nstale body\n");
  utimesSync(join(notesDir, "other-host", "deploy_checklist.md"), new Date(0), new Date(0));

  const { entries, withheld, skipped } = collectNotes(notesDir);
  buildNotesIndex(dbPath, entries, { withheld, skipped });
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("parseNoteFile reads frontmatter, defaults unknown type to reference, and tolerates extra metadata keys", () => {
  const p = parseNoteFile("---\nname: foo\ndescription: bar\nmetadata:\n  type: nonsense\n---\nbody text\n");
  assert.equal(p.name, "foo");
  assert.equal(p.description, "bar");
  assert.equal(p.type, "reference");
  assert.equal(p.body, "body text");
});

test("parseNoteFile returns null with no frontmatter or no name", () => {
  assert.equal(parseNoteFile("no frontmatter here"), null);
  assert.equal(parseNoteFile("---\ndescription: x\n---\nbody"), null);
  assert.equal(parseNoteFile('---\nname: ""\nmetadata:\n  type: reference\n---\nbody'), null);
});

test("parseNoteFile tolerates descriptions real YAML would reject: unescaped colons and stray quotes", () => {
  // unquoted plain scalar with an inner ":" — strict YAML sees this as a nested mapping and throws
  const p1 = parseNoteFile("---\nname: deploy-checklist\ndescription: DNS trk.example.com -> dct: added 10/10\nmetadata:\n  type: project\n---\nbody\n");
  assert.equal(p1.description, "DNS trk.example.com -> dct: added 10/10");

  // starts with a quote that never closes — not a real quoted scalar, must be left as raw text
  const p2 = parseNoteFile('---\nname: feedback-host-naming\ndescription: "node-a" = example internal server name\nmetadata:\n  type: feedback\n---\nbody\n');
  assert.equal(p2.description, '"node-a" = example internal server name');

  // a real double-quoted scalar (needed because its value itself contains a ":") is unquoted
  const p3 = parseNoteFile('---\nname: voip-status\ndescription: "VoIP status: online"\nmetadata:\n  type: project\n---\nbody\n');
  assert.equal(p3.description, "VoIP status: online");
});

test("redactBody: withholds credential lines, leaves pointers alone", () => {
  const r1 = redactBody("user: alice, pw: master02");
  assert.equal(r1.withheld, 1);
  assert.equal(r1.body, "[line withheld: credential]");

  const r2 = redactBody("ERP uses svc-readonly login");
  assert.equal(r2.withheld, 0);
  assert.equal(r2.body, "ERP uses svc-readonly login");

  const r3 = redactBody("Account password = master02\nThis line is totally fine.");
  assert.equal(r3.withheld, 1);
  assert.match(r3.body, /\[line withheld: credential\]\nThis line is totally fine\./);

  // substring match catches passwords embedded in compound identifiers
  assert.equal(redactBody("so /etc/kcpassword was rewritten for the new login").withheld, 1);
  // sshpass -p is a literal password on a command line
  assert.equal(redactBody("sshpass -p 'master02' ssh alice@host").withheld, 1);
  // bare "pw" word, no colon
  assert.equal(redactBody("Pi SSH pw also unknown (pi/raspberry)").withheld, 1);
  // "pw" must be word-bounded, not a substring of another word
  assert.equal(redactBody("the update is moving upward nicely").withheld, 0);
  // Slack token pattern
  assert.equal(redactBody("token: xoxp-1234567890-abcdefg").withheld, 1);
  // SSN-shaped number
  assert.equal(redactBody("SSN on file: 123-45-6789").withheld, 1);
  // routing/account number
  assert.equal(redactBody("bank routing number 021000021 for ACH").withheld, 1);
  // a bare long number with no routing/account word nearby is NOT withheld
  assert.equal(redactBody("invoice total was 123456789012 cents").withheld, 0);
  // sshpass without -p still carries a password
  assert.equal(redactBody("source on the old dev Mini (sshpass master02)").withheld, 1);
  // macOS keychain unlock command
  assert.equal(redactBody("security unlock-keychain -p master02 ~/Library/Keychains/login.keychain-db").withheld, 1);
  // sudo -S reads the password from stdin
  assert.equal(redactBody("echo master02 | sudo -S cp foo /opt/bar").withheld, 1);
  // backtick user/password shorthand
  assert.equal(redactBody("log in `alice`/`master02`, set View").withheld, 1);
  // "key + <value> rejected" denial note
  assert.equal(redactBody("MacBook Pro has NO ssh access (key + master02 rejected)").withheld, 1);
  // a normal file path in backticks is not a credential pair
  assert.equal(redactBody("see `src/index.js` for the entry point").withheld, 0);
});

test("collectNotes skips MEMORY.md and no-name files, keeps the newest copy across hosts", () => {
  const { entries, skipped } = collectNotes(notesDir);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("deploy-checklist"));
  assert.ok(names.includes("prod-change-lock"));
  assert.ok(!names.includes(undefined));
  assert.equal(skipped, 1); // no_name.md
  const kt = entries.find((e) => e.name === "deploy-checklist");
  assert.equal(kt.host, "dev-host"); // not the stale other-host copy
  assert.doesNotMatch(kt.body, /stale body/);
});

test("collectNotes redacts the credential note and reports a nonzero withheld count", () => {
  const { entries, withheld } = collectNotes(notesDir);
  const oct = entries.find((e) => e.name === "device-access");
  assert.doesNotMatch(oct.body, /master02/);
  assert.match(oct.body, /\[line withheld: credential\]/);
  assert.ok(withheld >= 1);
});

test("searchNotes: ranked hits with a header line and a snippet", () => {
  const out = searchNotes(dbPath, { q: "deploy checklist tracking" });
  assert.match(out, /^deploy-checklist \(project, updated \d{4}-\d{2}-\d{2}\): DNS trk\.example\.com/);
  assert.match(out, /\n  ….*…$/s);
});

test("searchNotes: type filter, limit, unknown type, no match, user text can't break MATCH", () => {
  assert.match(searchNotes(dbPath, { q: "change lock", type: "project" }), /prod-change-lock/);
  assert.equal(searchNotes(dbPath, { q: "change lock", type: "feedback" }).startsWith("No match"), true);
  assert.match(searchNotes(dbPath, { q: "x", type: "nope" }), /Unknown type/);
  assert.match(searchNotes(dbPath, { q: "xyzxyzxyz nomatch" }), /No match/);
  // quotes / FTS operators in the query must not throw
  assert.doesNotThrow(() => searchNotes(dbPath, { q: '"change AND OR NOT *^' }));
  const limited = searchNotes(dbPath, { q: "vendor", limit: 1 });
  assert.equal(limited.split("\n\n").length <= 1, true);
});

test("readNote: full body, truncation, and closest-name suggestions when missing", () => {
  const full = readNote(dbPath, { name: "vendor-outreach" });
  assert.match(full, /^vendor-outreach \(feedback, host dev-host/);
  assert.match(full, /vendors/);

  const missing = readNote(dbPath, { name: "vendor-outrech" });
  assert.match(missing, /No note named/);
  assert.match(missing, /Closest:/);
  assert.match(missing, /vendor-outreach/);

  assert.match(readNote(dbPath, {}), /Pass name/);
});

test("notesMeta reports counts", () => {
  const meta = notesMeta(dbPath);
  assert.ok(Number(meta.entries) >= 5);
});

test("NotesBackend speaks MCP tools/list and tools/call", async () => {
  const b = new NotesBackend(dbPath);
  const { tools } = await b.request({ method: "tools/list" });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["read_note", "search_notes"]);

  const r1 = await b.request({ method: "tools/call", params: { name: "search_notes", arguments: { q: "change lock" } } });
  assert.match(r1.content[0].text, /prod-change-lock/);

  const r2 = await b.request({ method: "tools/call", params: { name: "read_note", arguments: { name: "prod-change-lock" } } });
  assert.match(r2.content[0].text, /no two workers/);

  const r3 = await b.request({ method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(r3.isError, true);

  assert.equal(searchNotes(join(tmpdir(), "missing-notes.sqlite"), { q: "x" }).startsWith("Notes index not built"), true);
});

test("redaction: whole body of a markdown table with a Password column", () => {
  const { body, withheld } = redactBody("| SSID | Password | VLAN |\n|---|---|---|\n| Floor | `Abc$123?` | 1 |\n| Guest | `Guest2021` | 30 |\n\nAfter the table.");
  assert.equal(withheld, 3); // header row too ("Password" matches the line patterns)
  assert.doesNotMatch(body, /Abc\$123|Guest2021/);
  assert.match(body, /After the table\./);
});

test("redaction: ordinary tables are untouched", () => {
  const { body, withheld } = redactBody("| Host | IP |\n|---|---|\n| node1 | 203.0.113.10 |");
  assert.equal(withheld, 0);
  assert.match(body, /203\.0\.113\.10/);
});
