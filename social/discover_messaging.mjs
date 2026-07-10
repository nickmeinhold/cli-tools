#!/usr/bin/env node
// discover_messaging — find people in your OWN messaging channels who are NOT yet
// in the social graph. The warmest discovery signal there is: these are people YOU
// already talk to, not 2nd-degree strangers. Diffs Signal convos + Discord guild
// members against the community-memory roster (filesystem = source of truth).
//
// Channels: Signal (`signal list`), Discord (guild members via bot API).
// Roster: ~/.claude/projects/-Users-nick-git/memory/*.md (node files + index).
//
// Usage: node discover_messaging.mjs [--json]   (source ~/.claude/.env first for Discord)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";

const JSON_OUT = process.argv.includes("--json");
const DISMISS = process.argv.includes("--dismiss-shown");
const MEM = `${homedir()}/.claude/projects/-Users-nick-git/memory`;

// dismiss-list: contacts Nick has waved off — never resurface them.
const IGNORE_FILE = `${homedir()}/git/tools/cli-tools/social/discover-ignore.txt`;
const ignore = new Set();
if (existsSync(IGNORE_FILE)) {
  for (const l of readFileSync(IGNORE_FILE, "utf8").split("\n")) {
    const t = l.trim(); if (t && !t.startsWith("#")) ignore.add(t.toLowerCase());
  }
}
const isIgnored = (c) => ignore.has((c.id || "").toLowerCase()) || ignore.has((c.name || "").toLowerCase());

// ── build the roster index from the graph files ───────────────────────────────
let blob = "";
for (const f of readdirSync(MEM)) {
  if (f.endsWith(".md")) blob += "\n" + readFileSync(`${MEM}/${f}`, "utf8").toLowerCase();
}
const blobNS = blob.replace(/[^a-z0-9]/g, "");           // joined, for run-together names
const blobWords = new Set(blob.split(/[^a-z0-9]+/).filter(Boolean));
const rosterPhones = new Set((blob.match(/\d[\d\s-]{7,}\d/g) || []).map((p) => p.replace(/\D/g, "").slice(-9)));

// non-people: Nick himself, agents/personas, system, bots
const DENY = new Set([
  "nick", "nickmeinhold", "nickmeinhold", "sentientcogs", "nick meinhold", "me",
  "river", "dreamfinder", "signal", "maxwell", "kelvin", "carnot", "lyra", "claudius", "clio",
  "glaude", "ghatgpt", "chemini", "disrupt", "enspyr scribe",
  "botfather", "gremlin", "umbra", "flux", "claude dreams",   // telegram service/agent bots
].map((s) => s.toLowerCase()));

const known = (name, phone) => {
  const n = (name || "").toLowerCase();
  if (DENY.has(n)) return true;
  const ns = n.replace(/[^a-z0-9]/g, "");
  if (ns.length >= 4 && blobNS.includes(ns)) return true;          // run-together full name
  const toks = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (toks.length && toks.every((t) => blobWords.has(t))) return true; // all name tokens present
  if (phone) { const d = phone.replace(/\D/g, "").slice(-9); if (d && rosterPhones.has(d)) return true; }
  return false;
};

const candidates = [];

// ── Signal: private conversations ─────────────────────────────────────────────
try {
  const out = execFileSync("node", [`${homedir()}/git/tools/cli-tools/signal/signal.mjs`, "list"], { encoding: "utf8" });
  for (const line of out.split("\n")) {
    // "  175  2026-06-25  andyg            [uuid]"  or with "+61... " before the uuid
    const m = line.match(/^\s*\d+\s+\d{4}-\d\d-\d\d\s+(.+?)\s*(\+\d[\d\s]*\d)?\s*\[[0-9a-f-]+\]\s*$/i);
    if (!m) continue;
    const name = m[1].trim(), phone = (m[2] || "").replace(/\s/g, "");
    if (!known(name, phone)) candidates.push({ channel: "signal", name, id: phone || "" });
  }
} catch (e) { process.stderr.write(`signal: ${(e.message || e).split("\n")[0]}\n`); }

// ── Discord: guild members ────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (TOKEN) {
  try {
    const guilds = JSON.parse(execFileSync("node", [`${homedir()}/git/tools/cli-tools/discord/discord.mjs`, "guilds"], { encoding: "utf8" }));
    for (const g of guilds) {
      const res = await fetch(`https://discord.com/api/v10/guilds/${g.id}/members?limit=200`, { headers: { Authorization: `Bot ${TOKEN}` } });
      const members = await res.json();
      if (!Array.isArray(members)) { process.stderr.write(`discord ${g.name}: ${members.message || "no members"}\n`); continue; }
      for (const mb of members) {
        const u = mb.user || {};
        if (u.bot) continue;
        const display = u.global_name || u.username || "";
        const handle = (u.username || "").toLowerCase();
        if (DENY.has(display.toLowerCase()) || DENY.has(handle)) continue;
        const handleKnown = handle && (blobWords.has(handle) || blobNS.includes(handle));
        if (!known(display) && !handleKnown) {
          candidates.push({ channel: `discord:${g.name}`, name: display, id: "@" + (u.username || "") });
        }
      }
    }
  } catch (e) { process.stderr.write(`discord: ${(e.message || e).split("\n")[0]}\n`); }
} else {
  process.stderr.write("discord: DISCORD_BOT_TOKEN not set (source ~/.claude/.env) — skipping\n");
}

// ── Telegram: 1:1 dialogs (DMs) ───────────────────────────────────────────────
// `telegram list` → "DATE  TYPE  NAME  @handle?  [id]". DM rows = people. Skip
// bots (handle ends -bot) + agents. (Group/channel co-occurrence = a later pass.)
try {
  const out = execFileSync("node", [`${homedir()}/git/tools/cli-tools/telegram/telegram.mjs`, "list"], { encoding: "utf8", timeout: 90000 });
  for (const line of out.split("\n")) {
    const m = line.match(/^\d{4}-\d\d-\d\d\s+(dm|group|channel)\s+(.+?)\s+(@\S+)?\s*\[(-?\d+)\]\s*$/);
    if (!m || m[1] !== "dm") continue;
    const name = m[2].trim(), handle = (m[3] || "").replace(/^@/, "").toLowerCase();
    if (/bot$/i.test(handle) || DENY.has(name.toLowerCase())) continue;     // bots + agents
    const handleKnown = handle && (blobWords.has(handle) || blobNS.includes(handle));
    if (!known(name) && !handleKnown) {                                     // guard: empty handle ≠ "known"
      candidates.push({ channel: "telegram", name, id: handle ? "@" + handle : m[4] });
    }
  }
} catch (e) { process.stderr.write(`telegram: ${(e.message || e).split("\n")[0]}\n`); }

// ── filter dismissed, then output ─────────────────────────────────────────────
const shown = candidates.filter((c) => !isIgnored(c));
const hidden = candidates.length - shown.length;

if (DISMISS) {
  if (!shown.length) { console.log("Nothing to dismiss."); process.exit(0); }
  const stamp = new Date().toISOString().slice(0, 10);
  appendFileSync(IGNORE_FILE, `\n# dismissed ${stamp}\n` + shown.map((c) => c.id || c.name).join("\n") + "\n");
  console.log(`Dismissed ${shown.length} contact(s) — they won't reappear. → ${IGNORE_FILE}`);
  process.exit(0);
}

if (JSON_OUT) { console.log(JSON.stringify(shown, null, 2)); process.exit(0); }
const tail = hidden ? ` (${hidden} dismissed hidden)` : "";
if (!shown.length) { console.log(`No off-graph contacts found — graph is in sync with these channels. ✓${tail}`); process.exit(0); }
console.log(`${shown.length} contact(s) in your channels but NOT in the social graph${tail}:\n`);
for (const c of shown) console.log(`  [${c.channel}]  ${c.name}${c.id ? "  " + c.id : ""}`);
console.log(`\n(wave off the noise with: social discover messaging --dismiss-shown)`);
