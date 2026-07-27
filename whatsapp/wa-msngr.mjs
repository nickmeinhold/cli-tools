#!/usr/bin/env node
// wa-msngr — a general WhatsApp group messenger / Q&A bot (answers as Nick, marked 🤖).
//
// GENERAL BY CONFIG: the target group, its display name/description, and the
// knowledge base the bot answers from all come from a JSON config in
// wa-msngr-configs/. Pick one with WA_MSNGR_CONFIG (default "echo"), or point
// WA_MSNGR_CONFIG_FILE at any file. The "Echo" research-group Q&A is just the
// default config — nothing about this group is baked into the code.
//
// Architecture (two cooperating processes):
//   1. `whatsapp watch --include-groups` (launchd: com.nick.whatsapp-watcher)
//      streams every new group message into ~/.whatsapp.messages/wa-events.ndjson.
//   2. THIS daemon tails that NDJSON for the configured group, and on each new
//      message asks headless Claude Code (`claude -p`, zero marginal cost on Max)
//      to JUDGE whether it's clearly a question for the assistant and, if so, ANSWER.
//      Replies go via the OUTBOX (a direct `whatsapp send` would open a second
//      socket and collide with the watcher's), prefixed with 🤖.
//
// Trigger rule: reply when someone is clearly asking the assistant a question, OR
// follows up right after one of the assistant's answers — UNLESS the message is
// directed at a specific other person.
//
// Self-loop guard: never react to a message whose text starts with 🤖 (the bot's
// own posts). Nick's own human messages arrive as from_me WITHOUT the marker.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKENS_DIR } from "../lib/paths.mjs";

// --- Config: which group + knowledge base this instance serves ---------------
// Configs live next to this script so the tool survives repo moves (the old
// hardcoded ~/.claude/cli-tools path crash-looped launchd for days after the
// code migrated to ~/git/tools).
const CONFIGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "wa-msngr-configs");
const CONFIG_NAME = process.env.WA_MSNGR_CONFIG || "echo";
const CONFIG_FILE = process.env.WA_MSNGR_CONFIG_FILE || join(CONFIGS_DIR, `${CONFIG_NAME}.json`);
let CFG;
try {
  CFG = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
} catch (e) {
  console.error(`wa-msngr: could not load config '${CONFIG_FILE}': ${e.message}`);
  console.error(`  Set WA_MSNGR_CONFIG=<name> (a *.json in ${CONFIGS_DIR}) or WA_MSNGR_CONFIG_FILE=<path>.`);
  process.exit(1);
}

const GROUP_JID = process.env.WA_MSNGR_JID || CFG.jid;
const GROUP_NAME = CFG.groupName || CONFIG_NAME;
const GROUP_DESC = CFG.groupDesc || "";
// Knowledge base the bot answers from. Kept factual; the bot is told to say "not
// sure" rather than invent anything beyond this.
const PROJECT_CONTEXT = CFG.context || "";
const NDJSON = join(homedir(), ".whatsapp.messages", "wa-events.ndjson");
const STATE_DIR = join(TOKENS_DIR, "wa-msngr", CONFIG_NAME);
const CURSOR_FILE = join(STATE_DIR, "cursor");
const PID_FILE = join(STATE_DIR, "bot.pid");
const LOG_FILE = join(STATE_DIR, "bot.log");
const MARKER = "🤖";

const POLL_MS = Number(process.env.WA_MSNGR_POLL_MS || CFG.poll_ms || 15000);
const CONTEXT_N = 15;       // messages of context handed to the judge
const MAX_REPLIES = 3;      // safety cap per tick
const MODEL = process.env.WA_MSNGR_MODEL || CFG.model || "sonnet";

if (!GROUP_JID) {
  console.error(`wa-msngr: config '${CONFIG_NAME}' has no 'jid' (target group). Aborting.`);
  process.exit(1);
}

mkdirSync(STATE_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

// Single-instance guard.
if (existsSync(PID_FILE)) {
  const old = Number(readFileSync(PID_FILE, "utf8").trim());
  if (old && old !== process.pid) {
    try { process.kill(old, 0); log(`another instance running (pid ${old}); exiting`); process.exit(0); }
    catch { /* stale pid, take over */ }
  }
}
writeFileSync(PID_FILE, String(process.pid));

// Read all Echo-group text messages from the NDJSON, chronological.
function readGroupMessages() {
  if (!existsSync(NDJSON)) return [];
  const out = [];
  for (const line of readFileSync(NDJSON, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event !== "message" || e.jid !== GROUP_JID) continue;
    if (!e.text || !e.text.trim()) continue;
    if (e.timestamp_ms == null) continue;
    out.push(e);
  }
  out.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return out;
}

function readCursor() {
  try { return Number(readFileSync(CURSOR_FILE, "utf8").trim()) || 0; } catch { return 0; }
}
function writeCursor(ts) { writeFileSync(CURSOR_FILE, String(ts)); }

// On first ever run, don't answer synced backlog — start from the latest message.
(function initCursor() {
  if (existsSync(CURSOR_FILE)) return;
  const msgs = readGroupMessages();
  const latest = msgs.length ? msgs[msgs.length - 1].timestamp_ms : Date.now();
  writeCursor(latest);
  log(`initialised cursor at ${latest} (${msgs.length} backlog msgs ignored)`);
})();

function isBotMsg(m) { return (m.text || "").trimStart().startsWith(MARKER); }
function speaker(m) { return isBotMsg(m) ? "Claude" : (m.push_name || (m.from_me ? "Nick" : "Unknown")); }
function cleanText(m) { return isBotMsg(m) ? m.text.replace(MARKER, "").trim() : m.text.trim(); }

function buildJudgePrompt(context, newMsgs) {
  const transcript = context.map((m) => {
    const tag = newMsgs.includes(m) ? " <-- NEW" : "";
    return `[${speaker(m)}] ${cleanText(m)}${tag}`;
  }).join("\n");

  return `You are "Claude", an AI assistant participating in a small WhatsApp group called "${GROUP_NAME}"${GROUP_DESC ? ` (${GROUP_DESC})` : ""}. You have context below — use it to answer questions about ${GROUP_NAME} and what's next accurately. If asked something the context doesn't cover, say you're not sure rather than inventing.

${PROJECT_CONTEXT}

Below is the recent conversation. Lines marked "<-- NEW" just arrived and are the only ones you may react to. "[Claude]" lines are your own previous messages.

Decide whether to reply, following this rule EXACTLY:
- Reply when a NEW message is CLEARLY asking Claude/the AI a question (addressed to the assistant, or a general question to the group plainly meant for the AI to answer).
- Reply when a NEW message is a follow-up question coming right after one of Claude's own answers.
- Do NOT reply if the NEW message is directed at a specific OTHER person, is chit-chat, a statement, an emoji/ack, or not actually a question.
- Never reply to Claude's own messages.
- When unsure, stay silent.

If you reply: be concise (1-4 sentences), friendly, and accurate. If you don't know a fact for certain, say so rather than inventing. Do NOT add a 🤖 prefix yourself; it is added automatically.

Conversation:
${transcript}

Output STRICT JSON only, no prose, no code fences:
{"replies": ["..."]}
Use an empty array to stay silent. Include one string per message you choose to answer (usually 0 or 1).`;
}

function askJudge(prompt) {
  let raw;
  try {
    raw = execFileSync("claude", ["-p", prompt, "--output-format", "text", "--model", MODEL],
      { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    log(`claude -p failed: ${err.message}`);
    return [];
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) { log(`no JSON in judge output: ${raw.slice(0, 200)}`); return []; }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    const replies = Array.isArray(parsed.replies) ? parsed.replies : [];
    return replies.filter((r) => typeof r === "string" && r.trim()).slice(0, MAX_REPLIES);
  } catch (e) {
    log(`bad JSON from judge: ${raw.slice(0, 200)}`);
    return [];
  }
}

// We do NOT open our own WhatsApp socket — that would collide with the watcher's
// socket (same device creds → connectionReplaced/440, both stall; that's the bug
// that made v1 sends time out). Instead we append a job to the outbox and the
// watcher drains it over its already-open socket.
const OUTBOX = join(homedir(), ".whatsapp.messages", "wa-outbox.ndjson");
function sendReply(text) {
  const body = `${MARKER} ${text.trim()}`;
  appendFileSync(OUTBOX, JSON.stringify({ to: GROUP_JID, text: body }) + "\n", { mode: 0o600 });
  log(`queued: ${body.slice(0, 120)}`);
}

function tick() {
  const msgs = readGroupMessages();
  if (!msgs.length) return;
  const cursor = readCursor();
  const newMsgs = msgs.filter((m) => m.timestamp_ms > cursor && !isBotMsg(m));
  const maxTs = Math.max(...msgs.map((m) => m.timestamp_ms));

  if (!newMsgs.length) { if (maxTs > cursor) writeCursor(maxTs); return; }

  log(`${newMsgs.length} new message(s): ${newMsgs.map((m) => `${speaker(m)}: ${cleanText(m).slice(0, 40)}`).join(" | ")}`);
  const context = msgs.slice(-CONTEXT_N);
  // ensure all NEW msgs are in context window
  for (const m of newMsgs) if (!context.includes(m)) context.unshift(m);

  const replies = askJudge(buildJudgePrompt(context, newMsgs));
  if (!replies.length) log("judge: stay silent");
  for (const r of replies) {
    try { sendReply(r); } catch (e) { log(`send failed: ${e.message}`); }
  }
  // advance cursor past everything we considered, so we never re-answer.
  writeCursor(maxTs);
}

log(`wa-msngr[${CONFIG_NAME}] starting (group="${GROUP_NAME}", jid=${GROUP_JID}, poll=${POLL_MS}ms, model=${MODEL}, pid=${process.pid})`);
process.on("SIGTERM", () => { log("SIGTERM, exiting"); process.exit(0); });
process.on("SIGINT", () => { log("SIGINT, exiting"); process.exit(0); });

// run forever
async function main() {
  for (;;) {
    try { tick(); } catch (e) { log(`tick error: ${e.message}`); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
main();
