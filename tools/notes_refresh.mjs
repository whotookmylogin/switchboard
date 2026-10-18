#!/usr/bin/env node
/**
 * Rebuild the notes index (data/notes.sqlite) from markdown files under data/notes/<host>/*.md (Claude
 * Code's memory notes). Credential-looking lines are redacted at this build step — see src/notes.js
 * redactBody — so nothing sensitive ever reaches the index.
 *
 * Run: node tools/notes_refresh.mjs   (cron: hourly alongside tools/directory_refresh.mjs)
 */
import { join, resolve } from "node:path";
import { collectNotes, buildNotesIndex } from "../src/notes.js";

const ROOT = resolve(process.env.SB_HOME || new URL("..", import.meta.url).pathname);
const NOTES_DIR = process.env.SB_NOTES_DIR || join(ROOT, "data", "notes");
const OUT = process.env.SB_NOTES_DB || join(ROOT, "data", "notes.sqlite");

const t0 = Date.now();
const { entries, withheld, skipped } = collectNotes(NOTES_DIR);
buildNotesIndex(OUT, entries, { withheld, skipped, seconds: Math.round((Date.now() - t0) / 1000) });
console.log(JSON.stringify({ at: new Date().toISOString(), entries: entries.length, withheld_lines: withheld, skipped_files: skipped, seconds: Math.round((Date.now() - t0) / 1000) }));
