// Unit tests for the lookup directory. Run: node --test test/lookup.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDirectory, searchDirectory, directoryMeta, LookupBackend } from "../src/lookup.js";
import { loadDirectoryFromConfig } from "../tools/directory_refresh.mjs";

const path = join(mkdtempSync(join(tmpdir(), "sb-lookup-")), "directory.sqlite");

before(() => {
  buildDirectory(
    path,
    [
      { kind: "person", ref: "U100", title: "Alex Example", keys: "alex@example.com", line: "Alex Example · alex@example.com · engineering", weight: 2 },
      { kind: "person", ref: "U200", title: "Dana Smith", keys: "dana@example.org", line: "Dana Smith · dana@example.org", weight: 2 },
      { kind: "channel", ref: "C900", title: "#engineering", keys: "slack-main", line: "#engineering C900 (slack-main)", weight: 1.5 },
      { kind: "stock", ref: "805", title: "Widget A", keys: "supplier-a", line: "805 Widget A · supplier-a", weight: 1 },
      { kind: "stock", ref: "810", title: "Widget B", keys: "", line: "810 Widget B · spare", weight: 1 },
      { kind: "account", ref: "example.com", title: "Example Corp", keys: "example.com", line: "example.com Example Corp · $50K lifetime", weight: 3 },
      { kind: "guide", ref: "sql-dates", title: "SQL dates are stored as text", keys: "cast timestamp numeric", line: "Every date column is text: cast with col::timestamp", weight: 2 },
    ],
    { errors: [] }
  );
});

test("exact ref match wins", () => {
  assert.match(searchDirectory(path, { q: "805" }).split("\n")[0], /^stock: 805 Widget/);
});

test("partial names, emails and multi-word queries match via trigrams", () => {
  assert.match(searchDirectory(path, { q: "alex" }), /^person: Alex Example/);
  assert.match(searchDirectory(path, { q: "dana@example" }), /^person: Dana Smith/);
  assert.match(searchDirectory(path, { q: "widget spare" }).split("\n")[0], /810/);
  assert.match(searchDirectory(path, { q: "example corp" }), /^account: example\.com/);
});

test("kind filter, limit and the more-matches hint", () => {
  assert.equal(searchDirectory(path, { q: "widget", kind: "person" }).startsWith("No match"), true);
  const one = searchDirectory(path, { q: "widget", limit: 1 });
  assert.equal(one.split("\n").length, 2);
  assert.match(one, /more matches/);
  assert.match(searchDirectory(path, { kind: "guide" }), /^guide: Every date column is text/);
  assert.match(searchDirectory(path, { kind: "nope", q: "x" }), /Unknown kind/);
});

test("short queries fall back to prefix match; meta is recorded", () => {
  assert.match(searchDirectory(path, { q: "#e" }), /#engineering/);
  assert.equal(directoryMeta(path).entries, "7");
});

test("backend speaks MCP tools/list and tools/call", async () => {
  const b = new LookupBackend(path);
  assert.deepEqual((await b.request({ method: "tools/list" })).tools.map((t) => t.name), ["lookup"]);
  const r = await b.request({ method: "tools/call", params: { name: "lookup", arguments: { q: "engineering" } } });
  assert.match(r.content[0].text, /C900/);
  assert.equal(searchDirectory(join(tmpdir(), "missing.sqlite"), { q: "x" }).startsWith("Directory not built"), true);
});

test("directory.yaml loader: file, guide, and command sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-dirload-"));
  const team = join(dir, "team.json");
  writeFileSync(team, JSON.stringify([{ kind: "person", ref: "U1", title: "From JSON", keys: "json", line: "From JSON", weight: 1 }]));
  const guide = join(dir, "guide.md");
  writeFileSync(guide, "## Help topic\nkeys: help support\nBody text for agents.\n");
  const cmd = join(dir, "emit.mjs");
  writeFileSync(
    cmd,
    `console.log(JSON.stringify([{ kind: "guide", ref: "cmd", title: "From command", keys: "cmd", line: "From command: stdout", weight: 1 }]));`
  );
  const config = join(dir, "directory.yaml");
  writeFileSync(
    config,
    `sources:
  - name: team
    type: file
    path: ${team}
  - name: howto
    type: guide
    path: ${guide}
  - name: cmd
    type: command
    command: [node, ${cmd}]
`
  );
  const out = join(dir, "out.sqlite");
  const { entries, errors } = await loadDirectoryFromConfig(config, { outPath: out });
  assert.equal(Object.keys(errors).length, 0);
  assert.equal(entries.length, 3);
  buildDirectory(out, entries, {});
  assert.match(searchDirectory(out, { q: "From JSON" }), /person: From JSON/);
  assert.match(searchDirectory(out, { q: "Help topic" }), /guide:/);
  assert.match(searchDirectory(out, { q: "stdout" }), /From command/);
  rmSync(dir, { recursive: true, force: true });
});
