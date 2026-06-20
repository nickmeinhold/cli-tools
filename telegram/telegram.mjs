#!/usr/bin/env node
/**
 * telegram — CLI for reading and sending Telegram messages as Nick.
 *
 * Unlike the Claude Dreams *bot* (Bot API), this logs in as Nick's own
 * Telegram USER account over MTProto via GramJS. That distinction is the whole
 * point: the Bot API can only see chats a bot is a member of, so it can never
 * read your personal DMs or group history. A user-client can — it IS you, the
 * same way the official Telegram Desktop app is.
 *
 * This is the same posture as the WhatsApp CLI (Baileys): an unofficial-but-
 * tolerated full client. Telegram's ToS permits third-party clients built on
 * its public MTProto API + your own api_id/api_hash, so this is on firmer
 * ground than the WhatsApp/WA-Web case — but it's still your real account, so
 * treat send as draft-then-confirm, never fire-and-forget.
 *
 * Credentials (one-time):
 *   1. Get api_id + api_hash from https://my.telegram.org → "API development
 *      tools" (log in with your phone). Put them in ~/.claude/.env:
 *        export TELEGRAM_API_ID=1234567
 *        export TELEGRAM_API_HASH=abcdef0123456789abcdef0123456789
 *   2. `source ~/.claude/.env && telegram auth` — interactive:
 *      enter your phone (E.164), the login code Telegram sends you, and your
 *      2FA password if set. The resulting StringSession is saved to
 *      ~/.claude/cli-tools/.tokens/telegram/session.txt (mode 0600).
 *
 * Subcommands:
 *   auth                       One-time interactive login; saves the session string.
 *   me                         Print the logged-in account (sanity check).
 *   list                       List recent dialogs (DMs + groups): name, type, id, last activity.
 *   read   --name <substr>     Dump a conversation oldest→newest. [--limit N] [--json]
 *          --id <peer-id>      (--id / --username also accepted)
 *   send   --to <name|@user|id> --text "..."   Send a message (or --file PATH for body).
 *   export                     Export dialogs to NDJSON (love_agent corpus shape).
 *                              [--name <substr> to scope] [--out PATH] [--limit N]
 *
 * All structured output goes to stdout as JSON / NDJSON; human status to stderr.
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const TOKEN_DIR = join(homedir(), ".claude", "cli-tools", ".tokens", "telegram");
const SESSION_PATH = join(TOKEN_DIR, "session.txt");

// GramJS prints a version banner at client construction — *before* any
// setLogLevel call can take effect. The only way to silence it is to hand the
// constructor a logger that's already muted. TELEGRAM_DEBUG restores full logs.
const baseLogger = new Logger(process.env.TELEGRAM_DEBUG ? LogLevel.DEBUG : LogLevel.NONE);

// ── arg parsing (same shape as signal.mjs / whatsapp.mjs) ────────────────────
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

function help() {
  console.log(`telegram — MTProto user-client CLI (GramJS), reads/sends as you

WHY / WHEN TO USE
  Reads & sends as Nick's USER account via MTProto (GramJS) — NOT the Bot API.
  That distinction is the point: a bot only sees chats it's a member of, so it can
  never read Nick's personal DMs or group history; a user-client IS Nick, like the
  official Telegram Desktop app. (Telegram's ToS permits third-party clients on your
  own api_id/api_hash — firmer ground than the WhatsApp/Messenger cases.)
  Do NOT use the claude-dreams-telegram bot for reading — it's outbound-only and
  cannot see personal conversations.

Usage: telegram <subcommand> [options]

Credentials: TELEGRAM_API_ID + TELEGRAM_API_HASH in ~/.claude/.env
Session:     ${SESSION_PATH}

Subcommands:
  auth                       One-time interactive login (phone → code → 2FA). Saves the session.
  me                         Print the logged-in account (sanity check).
  list                       List recent dialogs (DMs + groups): name, type, id, last activity.
  read   --name <substr>     Dump a conversation oldest→newest. [--limit N] [--json]
         --id <peer-id> | --username <@handle>
  send   --to <name|@user|id> --text "..."   Send a message (or --file PATH for the body).
  export                     Export dialogs to NDJSON. [--name <substr>] [--out PATH] [--limit N]

Examples:
  source ~/.claude/.env && telegram auth
  telegram list
  telegram read --name "Delia" --limit 200
  telegram send --to "Delia" --text "Got the ABN, thanks!"`);
}

// ── credentials ──────────────────────────────────────────────────────────────
function apiCreds() {
  const id = process.env.TELEGRAM_API_ID;
  const hash = process.env.TELEGRAM_API_HASH;
  if (!id || !hash) {
    throw new Error(
      "TELEGRAM_API_ID / TELEGRAM_API_HASH not set. Get them at https://my.telegram.org " +
      "(API development tools), add them to ~/.claude/.env, then " +
      "`source ~/.claude/.env`.",
    );
  }
  const apiId = parseInt(id, 10);
  if (!Number.isFinite(apiId)) throw new Error(`TELEGRAM_API_ID is not a number: ${id}`);
  return { apiId, apiHash: hash };
}

function loadSession() {
  if (existsSync(SESSION_PATH)) return readFileSync(SESSION_PATH, "utf8").trim();
  return "";
}

// stdin prompt for the interactive auth flow.
function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    if (hidden) {
      // Best-effort masking: mute echo while typing.
      const onData = () => { process.stderr.write("\x1b[2K\r" + question); };
      rl.input.on("data", onData);
      rl._writeToOutput = () => {};
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── client lifecycle ─────────────────────────────────────────────────────────
async function makeClient() {
  const { apiId, apiHash } = apiCreds();
  const client = new TelegramClient(new StringSession(loadSession()), apiId, apiHash, {
    connectionRetries: 5,
    baseLogger,
  });
  return client;
}

// For non-auth commands: connect using the saved session and fail loudly if
// we're not actually authorized (rather than silently launching the login flow).
async function connected() {
  if (!loadSession()) {
    throw new Error(`No saved session at ${SESSION_PATH}. Run \`telegram auth\` first.`);
  }
  const client = await makeClient();
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error("Saved session is no longer authorized. Re-run `telegram auth`.");
  }
  return client;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function dialogType(d) {
  if (d.isUser) return "dm";
  if (d.isChannel) return "channel";
  if (d.isGroup) return "group";
  return "other";
}

// Big integers (ids, dates) come back as BigInt from GramJS; JSON.stringify
// chokes on them, so coerce to Number/String where safe.
function toId(v) {
  if (v == null) return null;
  return typeof v === "bigint" ? Number(v) : (v.value !== undefined ? Number(v.value) : Number(v));
}

async function resolveDialog(client, args) {
  const dialogs = await client.getDialogs({ limit: 500 });
  if (args.username) {
    const handle = String(args.username).replace(/^@/, "").toLowerCase();
    const hit = dialogs.find((d) => (d.entity?.username || "").toLowerCase() === handle);
    if (hit) return hit;
    // fall through to getEntity for handles not in the dialog list
    const ent = await client.getEntity(String(args.username));
    return { entity: ent, name: ent.username || ent.firstName || String(toId(ent.id)) };
  }
  if (args.id !== undefined && args.id !== true) {
    const want = Number(args.id);
    const hit = dialogs.find((d) => toId(d.id) === want || toId(d.entity?.id) === want);
    if (hit) return hit;
    const ent = await client.getEntity(want);
    return { entity: ent, name: ent.title || ent.firstName || String(want) };
  }
  if (args.name) {
    const needle = String(args.name).toLowerCase();
    const matches = dialogs.filter((d) => (d.name || "").toLowerCase().includes(needle));
    if (!matches.length) throw new Error(`no dialog matching "${args.name}"`);
    if (matches.length > 1) {
      console.error(`Multiple matches for "${args.name}":`);
      for (const m of matches) console.error(`  - ${m.name} [${dialogType(m)}, id ${toId(m.id)}]`);
      console.error("Refine --name or use --id.");
    }
    return matches[0];
  }
  throw new Error("specify --name <substr>, --username <@handle>, or --id <peer-id>");
}

async function fetchMessages(client, entity, limit) {
  const msgs = await client.getMessages(entity, { limit: limit ? parseInt(limit, 10) : 100 });
  // GramJS returns newest→oldest; we want oldest→newest like the signal tool.
  return msgs
    .filter((m) => m.message)
    .map((m) => ({
      role: m.out ? "me" : "them",
      text: m.message,
      ts: m.date ? new Date(m.date * 1000).toISOString() : null,
      id: m.id,
    }))
    .reverse();
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdAuth() {
  const { apiId, apiHash } = apiCreds();
  await mkdir(TOKEN_DIR, { recursive: true });
  const client = new TelegramClient(new StringSession(loadSession()), apiId, apiHash, {
    connectionRetries: 5,
    baseLogger,
  });

  console.error("Logging in to Telegram as your user account.");
  console.error("You'll get a login code in your Telegram app (or by SMS).\n");

  await client.start({
    phoneNumber: async () => prompt("Phone number (E.164, e.g. +61400000000): "),
    password: async () => prompt("2FA password (blank if none): ", { hidden: true }),
    phoneCode: async () => prompt("Login code Telegram just sent you: "),
    onError: (err) => console.error("auth error:", err.message || err),
  });

  const session = client.session.save();
  await writeFile(SESSION_PATH, session, { mode: 0o600 });
  const me = await client.getMe();
  await client.disconnect();
  console.error(`\nLinked as ${me.firstName || ""} ${me.lastName || ""} (@${me.username || "—"}).`);
  console.log(JSON.stringify({ status: "linked", session_path: SESSION_PATH, username: me.username || null }, null, 2));
}

async function cmdMe() {
  const client = await connected();
  const me = await client.getMe();
  await client.disconnect();
  console.log(JSON.stringify({
    id: toId(me.id),
    username: me.username || null,
    firstName: me.firstName || null,
    lastName: me.lastName || null,
    phone: me.phone || null,
  }, null, 2));
}

async function cmdList(args) {
  const client = await connected();
  const dialogs = await client.getDialogs({ limit: args.limit ? parseInt(args.limit, 10) : 100 });
  await client.disconnect();
  const rows = dialogs.map((d) => ({
    name: d.name || "(no name)",
    type: dialogType(d),
    id: toId(d.id),
    username: d.entity?.username || null,
    unread: d.unreadCount ?? 0,
    last: d.message?.date ? new Date(d.message.date * 1000).toISOString().slice(0, 10) : null,
  }));
  if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) {
    console.log(`${(r.last || "—").padEnd(10)}  ${r.type.padEnd(7)}  ${String(r.name).slice(0, 30).padEnd(30)}  ${r.username ? "@" + r.username : ""}  [${r.id}]`);
  }
  console.error(`\n${rows.length} dialogs.`);
}

async function cmdRead(args) {
  const client = await connected();
  const dialog = await resolveDialog(client, args);
  const entity = dialog.entity || dialog;
  const msgs = await fetchMessages(client, entity, args.limit);
  await client.disconnect();
  if (args.json) {
    console.log(JSON.stringify({ conversation: { name: dialog.name, id: toId(dialog.id ?? entity.id) }, messages: msgs }, null, 2));
    return;
  }
  console.error(`# ${dialog.name} — ${msgs.length} messages\n`);
  for (const m of msgs) {
    const who = m.role === "me" ? "ME " : "THEM";
    const ts = (m.ts || "").slice(0, 16).replace("T", " ");
    console.log(`[${ts}] ${who}: ${m.text.replace(/\n/g, "\n            ")}`);
  }
}

async function cmdSend(args) {
  if (!args.to) throw new Error('send requires --to <name|@user|id> and --text "..."');
  let text;
  if (args.text && args.text !== true) text = String(args.text);
  else if (args.file) text = await readFile(args.file, "utf8");
  else throw new Error("provide --text or --file");

  const client = await connected();
  // --to may be a name substring, an @handle, or a numeric id.
  let target;
  if (/^@/.test(args.to)) target = await resolveDialog(client, { username: args.to });
  else if (/^-?\d+$/.test(args.to)) target = await resolveDialog(client, { id: args.to });
  else target = await resolveDialog(client, { name: args.to });

  const entity = target.entity || target;
  const res = await client.sendMessage(entity, { message: text });
  await client.disconnect();
  console.error(`Sent to ${target.name}.`);
  console.log(JSON.stringify({ sent_to: target.name, message_id: res.id ?? null }, null, 2));
}

async function cmdExport(args) {
  const client = await connected();
  let dialogs = await client.getDialogs({ limit: 500 });
  if (args.name) {
    const needle = String(args.name).toLowerCase();
    dialogs = dialogs.filter((d) => (d.name || "").toLowerCase().includes(needle));
  }
  const lines = [];
  for (const d of dialogs) {
    const entity = d.entity || d;
    const msgs = await fetchMessages(client, entity, args.limit || 1000);
    if (!msgs.length) continue;
    lines.push(JSON.stringify({
      app: "telegram",
      conversationId: toId(d.id ?? entity.id),
      name: d.name || null,
      type: dialogType(d),
      turns: msgs.map((m) => ({ role: m.role, text: m.text, ts: m.ts })),
    }));
  }
  await client.disconnect();
  const payload = lines.join("\n") + "\n";
  if (args.out) {
    await writeFile(args.out, payload, { mode: 0o600 });
    console.error(`Wrote ${lines.length} conversations → ${args.out}`);
  } else {
    process.stdout.write(payload);
    console.error(`\n${lines.length} conversations exported.`);
  }
}

async function cmdPhoto(args) {
  const who = args.to ?? args.username ?? args.id ?? args.name;
  if (who === undefined || who === true) {
    throw new Error('photo requires --to <name|@user|id> (or --username/--id/--name)');
  }
  const client = await connected();
  let target;
  if (args.username || /^@/.test(String(who))) target = await resolveDialog(client, { username: who });
  else if (args.id || /^-?\d+$/.test(String(who))) target = await resolveDialog(client, { id: who });
  else target = await resolveDialog(client, { name: who });
  const entity = target.entity || target;
  // isBig:true → the full-resolution profile photo, not the tiny thumbnail.
  const buf = await client.downloadProfilePhoto(entity, { isBig: true });
  await client.disconnect();
  if (!buf || !buf.length) {
    console.error(`No profile photo for ${target.name}.`);
    console.log(JSON.stringify({ name: target.name, photo: null }));
    process.exit(3);
  }
  const out = args.out && args.out !== true ? String(args.out) : `${process.cwd()}/tg-photo.jpg`;
  await writeFile(out, buf, { mode: 0o600 });
  console.error(`Saved ${buf.length} bytes → ${out}`);
  console.log(JSON.stringify({ name: target.name, bytes: buf.length, path: out }));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return help();
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (sub) {
    case "auth": return cmdAuth();
    case "me": return cmdMe();
    case "list": return cmdList(args);
    case "read": return cmdRead(args);
    case "send": return cmdSend(args);
    case "photo": return cmdPhoto(args);
    case "export": return cmdExport(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      help();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
