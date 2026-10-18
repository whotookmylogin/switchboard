// Unit tests for compact-agent shaping. Run: node --test test/compact.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactTool, shapeArgs, shapeResult, compactJson, compactSlack } from "../src/compact.js";

const txt = (r) => r.content.map((c) => c.text).join("\n");

test("compactTool shortens descriptions, drops outputSchema, keeps schema structure", () => {
  const t = compactTool({
    name: "x",
    description: "First sentence. " + "word ".repeat(200),
    inputSchema: { type: "object", $schema: "s", properties: { q: { type: "string", description: "d".repeat(500), enum: ["a"] } }, required: ["q"] },
    outputSchema: { type: "object" },
  });
  assert.ok(t.description.startsWith("First sentence. word") && t.description.length <= 303);
  assert.equal(t.outputSchema, undefined);
  assert.equal(t.inputSchema.$schema, undefined);
  assert.deepEqual(t.inputSchema.required, ["q"]);
  assert.deepEqual(t.inputSchema.properties.q.enum, ["a"]);
  assert.ok(t.inputSchema.properties.q.description.length <= 124);
});

test("shapeArgs adds LIMIT to bare SELECTs only and clamps page sizes", () => {
  assert.match(shapeArgs("db", "query", { sql: "select * from ticket;" }, { defaultSqlLimit: 100 }).args.sql, /select \* from ticket\nLIMIT 100$/);
  assert.equal(shapeArgs("db", "query", { sql: "select 1 limit 5" }, { defaultSqlLimit: 100 }).args.sql, "select 1 limit 5");
  assert.equal(shapeArgs("other", "query", { sql: "select 1" }).args.sql, "select 1");
  const s = shapeArgs("slack-workspace", "slack_search_messages", { query: "x", count: 200 });
  assert.equal(s.args.count, 50);
  assert.equal(s.notes.length, 1);
  assert.equal(shapeArgs("slack-workspace", "slack_search_messages", { count: 10 }).args.count, 10);
});

test("rows become TSV with metadata lines; empty columns dropped; other JSON minified", () => {
  const out = compactJson({ rowCount: 2, truncated: false, rows: [{ a: "1", b: null, c: "x\ty" }, { a: "2", b: "", c: "z\nw" }] });
  assert.equal(out, "rowCount: 2\ntruncated: false\na\tc\n1\tx y\n2\tz ⏎ w");
  assert.equal(compactJson([{ t: 1 }, { t: 2 }]), "2 rows\nt\n1\n2");
  assert.equal(compactJson([{ d: "2026-09-16T00:00:00.000Z", e: "2026-09-16T14:05:00.000Z" }]), "1 rows\nd\te\n2026-09-16\t2026-09-16T14:05:00.000Z");
  assert.equal(compactJson({ a: { b: null, c: [1] }, d: "" }), '{"a":{"c":[1]}}');
});

test("Slack search/history/users/channels collapse to lines with names", () => {
  const names = new Map([["U1", "Alex"], ["U2", "Sam"]]);
  const search = compactSlack({ ok: true, messages: { total: 9, matches: [{ ts: "1791590000.0001", channel: { name: "general" }, user: "U1", text: "hi <@U2>", permalink: "https://l", blocks: [{ big: 1 }] }] } }, names);
  assert.match(search, /^9 matches, showing 1\ntime\tchannel\tuser\ttext\tlink\n2026-\d\d-\d\d \d\d:\d\d\t#general\tAlex\thi @Sam\thttps:\/\/l$/);
  const hist = compactSlack({ ok: true, messages: [{ ts: "1791590000.0001", user: "U2", text: "", attachments: [{ title: "PO report", text: "3 late" }], reply_count: 2 }], has_more: true }, names);
  assert.match(hist, /1 messages \(more available\)\ntime\tts\tuser\ttext\n.*\t1791590000\.0001\tSam\tPO report \| 3 late \[2 replies\]/);
  const users = compactSlack({ ok: true, members: [{ id: "U1", name: "alex", real_name: "Alex", profile: { title: "CS" } }, { id: "U9", deleted: true }] });
  assert.equal(users, "1 active users (1 deactivated hidden)\nid\tname\treal_name\ttitle\tbot\nU1\talex\tAlex\tCS\t");
  assert.equal(compactSlack({ ok: false, error: "channel_not_found" }), "Slack error: channel_not_found");
});

test("shapeResult leaves errors and plain text alone, drops structuredContent, appends notes", () => {
  const err = { content: [{ type: "text", text: '{"a":1}' }], isError: true };
  assert.equal(shapeResult("x", err), err);
  assert.equal(txt(shapeResult("x", { content: [{ type: "text", text: "plain words" }] })), "plain words");
  const r = shapeResult("x", { content: [{ type: "text", text: '{\n  "a": 1\n}' }], structuredContent: { a: 1 } }, { notes: ["added LIMIT 100"] });
  assert.equal(r.structuredContent, undefined);
  assert.equal(txt(r), '{"a":1}\n[Switchboard: added LIMIT 100]');
});
