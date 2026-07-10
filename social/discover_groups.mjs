#!/usr/bin/env node
// discover_groups — GROUP co-occurrence: people who share your Telegram GROUPS
// but aren't in the social graph. Someone in MORE of your groups = higher signal
// (a graph-distance proxy: many shared rooms, not yet a node).
//
// Uses the telegram CLI's `participants` command (real membership, not inferred
// from message senders). Auto-skips big public channels (> --max-size members).
// Honors the same roster diff + dismiss-list as discover_messaging.
//
// Usage: node discover_groups.mjs [--max-size N] [--include-channels] [--json]
//        (source ~/.claude/.env first)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MAX_SIZE = parseInt(flag("--max-size", "60"), 10);   // skip rooms bigger than this (public channels)
const INCLUDE_CHANNELS = argv.includes("--include-channels");
const JSON_OUT = argv.includes("--json");
const DISMISS = argv.includes("--dismiss-shown");
const TG = `${homedir()}/git/tools/cli-tools/telegram/telegram.mjs`;

// ── roster index + dismiss-list (same as discover_messaging) ──────────────────
const MEM = `${homedir()}/.claude/projects/-Users-nick-git/memory`;
let blob = "";
for (const f of readdirSync(MEM)) if (f.endsWith(".md")) blob += "\n" + readFileSync(`${MEM}/${f}`, "utf8").toLowerCase();
const blobNS = blob.replace(/[^a-z0-9]/g, "");
const blobWords = new Set(blob.split(/[^a-z0-9]+/).filter(Boolean));

const IGNORE_FILE = `${homedir()}/git/tools/cli-tools/social/discover-ignore.txt`;
const ignore = new Set();
if (existsSync(IGNORE_FILE)) for (const l of readFileSync(IGNORE_FILE, "utf8").split("\n")) { const t = l.trim(); if (t && !t.startsWith("#")) ignore.add(t.toLowerCase()); }

const DENY = new Set(["nick", "nick meinhold", "nickmeinhold", "sentientcogs", "me", "river", "dreamfinder"].map((s) => s.toLowerCase()));

const known = (name) => {
  const n = (name || "").toLowerCase();
  if (DENY.has(n)) return true;
  const ns = n.replace(/[^a-z0-9]/g, "");
  if (ns.length >= 4 && blobNS.includes(ns)) return true;
  const toks = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (toks.length && toks.every((t) => blobWords.has(t))) return true;
  return false;
};
const ignored = (name, handle, id) =>
  ignore.has(String(id).toLowerCase()) || (handle && ignore.has(("@" + handle).toLowerCase())) || ignore.has((name || "").toLowerCase());

// ── enumerate groups from `telegram list` ─────────────────────────────────────
const tg = (args) => execFileSync("node", [TG, ...args], { encoding: "utf8", timeout: 120000 });
const rooms = [];
for (const line of tg(["list"]).split("\n")) {
  const m = line.match(/^\d{4}-\d\d-\d\d\s+(group|channel)\s+(.+?)\s+(@\S+)?\s*\[(-?\d+)\]\s*$/);
  if (!m) continue;
  if (m[1] === "channel" && !INCLUDE_CHANNELS) continue;
  rooms.push({ type: m[1], name: m[2].trim(), id: m[4] });
}
process.stderr.write(`${rooms.length} group(s) to scan (max-size ${MAX_SIZE}${INCLUDE_CHANNELS ? ", +channels" : ""})\n`);

// ── pull participants, tally co-occurrence ────────────────────────────────────
const people = new Map(); // key(id) → {name, handle, id, groups:Set}
for (const room of rooms) {
  let data;
  try { data = JSON.parse(tg(["participants", "--id", room.id, "--json", "--limit", String(MAX_SIZE + 1)])); }
  catch (e) { process.stderr.write(`  ! ${room.name}: ${(e.message || e).split("\n")[0].slice(0, 80)}\n`); continue; }
  if (data.count > MAX_SIZE) { process.stderr.write(`  · skip ${room.name} (${data.count} members > ${MAX_SIZE})\n`); continue; }
  for (const p of data.participants || []) {
    if (p.bot) continue;
    const handle = (p.username || "").toLowerCase();
    if (known(p.name) || (handle && (blobWords.has(handle) || blobNS.includes(handle)))) continue;
    if (ignored(p.name, handle, p.id)) continue;
    const key = String(p.id);
    if (!people.has(key)) people.set(key, { name: p.name, handle, id: p.id, groups: new Set() });
    people.get(key).groups.add(room.name);
  }
  process.stderr.write(`  · ${room.name}: ${data.count} members\n`);
}

// ── rank by # shared groups, then output ──────────────────────────────────────
const out = [...people.values()]
  .map((p) => ({ name: p.name, handle: p.handle ? "@" + p.handle : "", id: p.id, shared: p.groups.size, groups: [...p.groups] }))
  .sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name));

if (DISMISS) {
  if (!out.length) { console.log("Nothing to dismiss."); process.exit(0); }
  const stamp = new Date().toISOString().slice(0, 10);
  appendFileSync(IGNORE_FILE, `\n# dismissed ${stamp} (groups)\n` + out.map((p) => String(p.id)).join("\n") + "\n");
  console.log(`Dismissed ${out.length} group contact(s) — they won't reappear. → ${IGNORE_FILE}`);
  process.exit(0);
}

if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
if (!out.length) { console.log("No off-graph people found in your groups. ✓"); process.exit(0); }
console.log(`${out.length} person/people in your groups but NOT in the social graph:\n`);
for (const p of out) console.log(`  ${p.shared}× ${p.name}${p.handle ? "  " + p.handle : "  [" + p.id + "]"}  ·  ${p.groups.join(", ")}`);
