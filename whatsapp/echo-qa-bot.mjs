#!/usr/bin/env node
// echo-qa-bot — answers questions in the "Echo" WhatsApp group as Nick, marked 🤖.
//
// Architecture (two cooperating processes):
//   1. `whatsapp watch --include-groups` (launchd: com.nick.whatsapp-watcher)
//      streams every new group message into ~/.love_agent/wa-events.ndjson.
//   2. THIS daemon tails that NDJSON for the Echo group, and on each new message
//      asks headless Claude Code (`claude -p`, zero marginal cost on the Max plan)
//      to JUDGE whether it's clearly a question for Claude and, if so, ANSWER it.
//      Answers are sent back via `whatsapp send`, prefixed with 🤖.
//
// Trigger rule (Nick, 2026-06-07): reply when someone is clearly asking Claude a
// question, OR replies straight to one of Claude's answers with a follow-up —
// UNLESS the message is directed at a specific other person.
//
// Self-loop guard: never react to a message whose text starts with 🤖 (those are
// the bot's own posts). Nick's own human messages arrive as from_me WITHOUT the
// marker, so he can test by just asking in the group.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const GROUP_JID = process.env.ECHO_QA_JID || "120363410027853082@g.us";
const NDJSON = join(homedir(), ".love_agent", "wa-events.ndjson");
const STATE_DIR = join(homedir(), ".claude", "cli-tools", "whatsapp", "echo-qa");
const CURSOR_FILE = join(STATE_DIR, "cursor");
const PID_FILE = join(STATE_DIR, "bot.pid");
const LOG_FILE = join(STATE_DIR, "bot.log");
const MARKER = "🤖";

// Knowledge base the bot answers from. Keep it factual; the bot is told to say
// "not sure" rather than invent anything beyond this.
const PROJECT_CONTEXT = `ABOUT THE ECHO PROJECT:
Echo is a research project: "self-consistency as a cost-control mechanism for LLM routing." Core idea: instead of a trained router picking cheap-vs-expensive model per request, call the CHEAP model twice with two different persona prompts — if the two answers AGREE, accept the cheap answer; if they DISAGREE, escalate to the expensive model. No classifier, no training data, no calibration. Cheaper than always using the big model while the price-tier gap is ~3x (Haiku-twice < Sonnet-once).
Why it could be a paper: existing routers (RouteLLM, FrugalGPT, Hybrid LLM, AutoMix) all need training data; Echo needs none. It reframes self-consistency (Wang et al. 2022), originally an accuracy trick, as a COST tool.
Arms compared: haiku-only (cheap baseline), sonnet-only (quality baseline), trained router (RouteLLM), Echo (haiku-twice-personas, escalate on disagreement = the contribution), cascade-with-confidence. Primary metric: Pareto frontier of cost-per-task vs accuracy. Success = Echo on/above the trained-router frontier with zero training data. Benchmarks: HumanEval+ (code) and BBH/MMLU-Pro (reasoning).
STATUS / WHAT'S NEXT (June 2026):
- Done: HumanEval+ sweeps with a parser-fix harness; a cross-family local judge (Qwen 7B) which is the current headline result; a blog write-up ("Echo: cheap routing without a router").
- In progress: the BBH reasoning benchmark. A pilot (n=10) came back with LOW and oddly FLAT pass rates (haiku-only 0.14, sonnet-only 0.14, echo 0.12). Sonnet tying Haiku is a red flag — likely a harness / answer-extraction artifact rather than true model performance.
- NEXT, in order: (1) investigate the low BBH pass rates — audit answer parsing/extraction, the judge prompt, and whether n=10 is too small; decide bug-vs-real and fix. (2) Once trustworthy, scale to a FULL BBH sweep for statistically meaningful Pareto numbers. (3) Then the paper draft. (Separately queued: a GitHub-Issue <-> Kan-card sync tool — infra, not core research.)
Honest risks: Haiku may confidently agree with itself when wrong (Echo collapses to "Haiku with extra steps"); persona-pair choice might dominate; Anthropic tier-pricing shifts could break the cost arithmetic.`;
const POLL_MS = Number(process.env.ECHO_QA_POLL_MS || 15000);
const CONTEXT_N = 15;       // messages of context handed to the judge
const MAX_REPLIES = 3;      // safety cap per tick
const MODEL = process.env.ECHO_QA_MODEL || "sonnet";

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

  return `You are "Claude", an AI assistant participating in a small WhatsApp group called "Echo" (Nick's research project). You have project context below — use it to answer questions about Echo and what's next accurately. If asked something the context doesn't cover, say you're not sure rather than inventing.

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
const OUTBOX = join(homedir(), ".love_agent", "wa-outbox.ndjson");
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

log(`echo-qa-bot starting (jid=${GROUP_JID}, poll=${POLL_MS}ms, model=${MODEL}, pid=${process.pid})`);
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
