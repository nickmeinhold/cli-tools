#!/usr/bin/env node
/**
 * imessage — CLI for reading and sending iMessage / SMS as Nick.
 *
 * Two asymmetric paths, by design (mirrors the `signal` tool):
 *
 *   READ  — passive. Queries the Messages app's local SQLite database
 *           (~/Library/Messages/chat.db) directly. Full history, instant,
 *           no network. NOT encrypted at rest (unlike Signal's SQLCipher DB),
 *           but the file is TCC-protected: the node/terminal binary running
 *           this needs macOS **Full Disk Access** (System Settings → Privacy
 *           & Security → Full Disk Access). Without it, the open() fails with
 *           EPERM — that's the one-time grant, not a bug.
 *
 *   WRITE — active. Shells out to `osascript`, driving Messages.app via
 *           AppleScript. macOS exposes no send API, so — exactly like
 *           whatsapp(Baileys)/messenger(ws3-fca)/signal(signal-cli) automate
 *           their real clients — we automate Messages.app. The FIRST send
 *           pops a one-time **Automation** permission prompt (allow Terminal/
 *           node to control Messages) — Nick's hands, once.
 *
 * Handle = a phone number (E.164 preferred, e.g. +61400000000) or an Apple ID
 * email. `send` passes the handle + text to osascript as ARGV (never string-
 * interpolated into the script) so message content can't break out of / inject
 * into the AppleScript.
 *
 * Subcommands:
 *   list                       List recent conversations (handle, count, last active).
 *   read   --to <handle|substr>  Dump a conversation oldest→newest. [--limit N] [--json]
 *   send   --to <handle> --text "..."   Send an iMessage (1:1). [--sms] [--dry-run]
 *   whoami                     Print the signed-in iMessage accounts.
 *
 * Draft-then-Nick-sends posture: never wire `send` to fire automatically as Nick.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), "Library", "Messages", "chat.db");

// ── arg parsing (same shape as signal.mjs / whatsapp.mjs) ───────────────────
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

// Apple epoch: nanoseconds since 2001-01-01 UTC. Convert to JS Date.
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
function appleToDate(ns) {
  if (!ns) return null;
  // Modern chat.db stores nanoseconds; older stored seconds. Detect by magnitude.
  const ms = ns > 1e12 ? ns / 1e6 : ns * 1000;
  return new Date(APPLE_EPOCH_MS + ms);
}

// Normalise a bare AU mobile (04xxxxxxxx) to E.164; pass anything else through.
function normalizeHandle(h) {
  const t = String(h).replace(/\s+/g, "");
  if (/^0[45]\d{8}$/.test(t)) return "+61" + t.slice(1);
  return t;
}

function sqlite(query) {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Messages DB not found at ${DB_PATH}`);
  }
  try {
    // -readonly so we never mutate the live Messages DB; JSON mode for parsing.
    return execFileSync("sqlite3", ["-readonly", "-json", DB_PATH, query], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const msg = e.stderr?.toString() || e.message;
    if (/authorization denied|unable to open|EPERM/i.test(msg)) {
      throw new Error(
        "Cannot open chat.db — grant Full Disk Access to your terminal/node " +
        "(System Settings → Privacy & Security → Full Disk Access), then retry."
      );
    }
    throw new Error(msg);
  }
}

function cmdList(args) {
  const limit = Number(args.limit) || 40;
  // newer macOS puts body text in attributedBody when text is NULL; we only
  // need counts/handles here, so the join stays cheap.
  const rows = JSON.parse(sqlite(`
    SELECT h.id AS handle,
           COUNT(m.ROWID) AS msgs,
           MAX(m.date) AS last
    FROM handle h
    JOIN message m ON m.handle_id = h.ROWID
    GROUP BY h.id
    ORDER BY last DESC
    LIMIT ${limit};
  `) || "[]");
  if (args.json) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) {
    const when = appleToDate(r.last)?.toISOString().slice(0, 16).replace("T", " ") ?? "?";
    console.log(`${when}  ${String(r.msgs).padStart(5)}  ${r.handle}`);
  }
}

function cmdRead(args) {
  const to = args.to;
  if (!to || to === true) throw new Error("read needs --to <handle|substr>");
  const limit = Number(args.limit) || 50;
  const needle = normalizeHandle(to);
  const rows = JSON.parse(sqlite(`
    SELECT m.is_from_me AS me,
           m.date AS date,
           COALESCE(m.text, '') AS text,
           hex(m.attributedBody) AS body_hex,
           h.id AS handle
    FROM message m
    JOIN handle h ON m.handle_id = h.ROWID
    WHERE h.id LIKE '%${needle.replace(/'/g, "''")}%'
       OR h.id LIKE '%${String(to).replace(/'/g, "''")}%'
    ORDER BY m.date DESC
    LIMIT ${limit};
  `) || "[]").reverse();
  for (const r of rows) r.text = r.text || decodeAttributedBody(r.body_hex);
  if (args.json) return console.log(JSON.stringify(rows.map(({ body_hex, ...r }) => r), null, 2));
  for (const r of rows) {
    const when = appleToDate(r.date)?.toISOString().slice(0, 16).replace("T", " ") ?? "?";
    const who = r.me ? "Nick" : r.handle;
    console.log(`[${when}] ${who}: ${r.text || "(no text / attachment)"}`);
  }
}

function cmdWhoami() {
  // Query services (what `send` targets), not accounts — `account` errors
  // (-1728) on current macOS. A plural `get ... of every service` returns a
  // list without an AppleScript loop.
  const script = `tell application "Messages" to get description of every service whose enabled is true`;
  const out = execFileSync("osascript", ["-e", script], { encoding: "utf8" });
  console.log(out.trim() || "(no enabled services)");
}

// Newer macOS stores the body in `attributedBody` (an NSArchiver blob) with
// `text` NULL. Best-effort extraction of the UTF-8 run that follows the
// "NSString" marker: skip the class-version bytes, read the length prefix
// (1 byte, or 0x81 + 2-byte LE for longer strings), slice that many bytes.
function decodeAttributedBody(hex) {
  if (!hex) return "";
  const buf = Buffer.from(hex, "hex");
  const marker = buf.indexOf("NSString");
  if (marker === -1) return "";
  let i = marker + 8;
  const plus = buf.indexOf(0x2b, i); // '+' precedes the length in the common encoding
  if (plus !== -1 && plus < i + 10) i = plus + 1;
  let len = buf[i];
  if (len === 0x81) { len = buf[i + 1] | (buf[i + 2] << 8); i += 3; }
  else i += 1;
  const text = buf.slice(i, i + len).toString("utf8");
  // Reject garbage (control chars beyond tab/newline => wrong offset).
  return /^[\t\n\r\x20-\x7e -￿]*$/.test(text) ? text : "";
}

function cmdSend(args) {
  // Fail closed: a send verb aborts on any unrecognised flag (a typo'd
  // --dry-run must never silently fire the real message).
  const allowed = new Set(["to", "text", "sms", "dry-run", "_"]);
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new Error(`send: unknown flag(s): ${unknown.join(", ")} — refusing to send.`);
  }
  const to = args.to;
  const text = args.text;
  if (!to || to === true) throw new Error("send needs --to <handle>");
  if (!text || text === true) throw new Error("send needs --text \"...\"");
  const handle = normalizeHandle(to);
  const service = args.sms ? "SMS" : "iMessage";

  if (args["dry-run"]) {
    console.log(`[dry-run] would send via ${service} to ${handle}:`);
    console.log(text);
    return;
  }

  // Handle + text are passed as ARGV to `on run argv`, never interpolated into
  // the script body — so message content cannot inject AppleScript.
  const script = `
    on run argv
      set targetHandle to item 1 of argv
      set targetText to item 2 of argv
      tell application "Messages"
        set targetService to 1st service whose service type = ${service}
        set targetBuddy to buddy targetHandle of targetService
        send targetText to targetBuddy
      end tell
    end run
  `;
  try {
    execFileSync("osascript", ["-e", script, handle, text], { encoding: "utf8" });
    console.log(`sent via ${service} to ${handle}`);
  } catch (e) {
    const msg = e.stderr?.toString() || e.message;
    if (/not authori[sz]ed|assistive|Automation/i.test(msg)) {
      throw new Error(
        "Messages automation not permitted — approve the one-time Automation " +
        "prompt (allow controlling Messages), or System Settings → Privacy & " +
        "Security → Automation."
      );
    }
    throw new Error(msg);
  }
}

function help() {
  console.log(`imessage — read (chat.db) + send (Messages.app) for iMessage/SMS as Nick

WHY / WHEN TO USE
  TWO asymmetric paths (mirrors \`signal\`). READ is passive: queries the local
  ~/Library/Messages/chat.db directly (needs Full Disk Access for the terminal,
  one-time). WRITE is active: drives Messages.app via osascript — macOS has no
  send API, so we automate the real client, same as whatsapp/messenger/signal.
  First send pops a one-time Automation prompt (Nick's hands).

Usage: imessage <subcommand> [options]

Subcommands:
  list                          Recent conversations (last active, count, handle). [--limit N] [--json]
  read   --to <handle|substr>   Conversation oldest→newest. [--limit N] [--json]
  send   --to <handle> --text "..."   Send iMessage (1:1). [--sms to force SMS] [--dry-run]
  whoami                        Signed-in iMessage accounts.

Handle = phone (E.164, e.g. +61400000000 — bare 04xx AU mobiles auto-normalise)
or Apple ID email. send fails closed on unknown flags; --dry-run prints, sends nothing.`);
}

function main() {
  const [, , sub, ...rest] = process.argv;
  const args = parseArgs(rest);
  try {
    switch (sub) {
      case "list": return cmdList(args);
      case "read": return cmdRead(args);
      case "send": return cmdSend(args);
      case "whoami": return cmdWhoami();
      case "help": case "--help": case "-h": case undefined: return help();
      default:
        console.error(`unknown subcommand: ${sub}\n`);
        return help();
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

main();
