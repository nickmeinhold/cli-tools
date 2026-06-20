#!/usr/bin/env node
/**
 * messenger — CLI for reading and sending Facebook Messenger DMs as Nick's PERSONAL account.
 *
 * Built on ws3-fca (the actively-maintained heir to facebook-chat-api) — the Baileys-equivalent
 * for Messenger. It speaks Facebook's MQTT chat protocol over a logged-in cookie session, so it
 * runs HEADLESS (no browser) exactly like the whatsapp (Baileys), telegram (GramJS), and signal
 * (signal-cli) CLIs. Sends as Nick's own account — which the official Graph API cannot do (that's
 * Page→customer only), the same reason the WhatsApp CLI uses Baileys instead of the Cloud API.
 *
 * ToS note: like Baileys, this is an unofficial protocol client — technically against Facebook's
 * ToS. Enforcement against personal-volume use is uncommon, but the account-lock risk is real and
 * was accepted knowingly. Keep volume human-paced.
 *
 * Auth: an `appState` (array of FB cookies) persisted at
 *   ~/.claude/cli-tools/.tokens/messenger/appstate.json
 * This is its OWN isolated session — independent of the fb-marketplace playwright session, so the
 * marketplace scraper and this bot can't knock each other's logins out.
 *
 * First-time login (one of):
 *   messenger auth --appstate <path>           Import a cookies appstate.json (most reliable — no checkpoint)
 *   messenger auth --email X --password Y       Credential login (may hit 2FA/checkpoint)
 *
 * Subcommands (mirror the signal/telegram CLIs):
 *   auth                                Log in and persist the session (see flags above).
 *   list [--limit N] [--json]           List inbox conversations (thread id + name).
 *   read --to <name|id> [--limit N] [--json]    Recent messages in a thread.
 *   send --to <name|id> --text "..."    Send a message. Resolves <name> against your inbox.
 *   whoami                              Print the logged-in account id (session health check).
 */

import { createRequire } from "node:module";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const { login } = require("ws3-fca");

// ws3-fca prints "ws3-fca [LOG] ..." chatter to stdout even at logLevel:"silent".
// This CLI's contract is stdout = data (JSON/text), so route the library's noise to
// stderr — keeps `messenger list --json | jq` etc. clean.
const _stdoutLog = console.log.bind(console);
console.log = (...a) => {
  if (typeof a[0] === "string" && a[0].includes("ws3-fca")) return console.error(...a);
  _stdoutLog(...a);
};

const TOKEN_DIR = join(homedir(), ".claude", "cli-tools", ".tokens", "messenger");
const APPSTATE = join(TOKEN_DIR, "appstate.json");

// ws3-fca login options. Quiet, present-but-not-noisy.
const LOGIN_OPTS = {
  online: false,
  updatePresence: false,
  selfListen: false,
  randomUserAgent: false,
  logLevel: "silent",
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function help() {
  console.log(`messenger — Facebook Messenger CLI (personal account, headless via ws3-fca)

WHY / WHEN TO USE
  Sends & reads Messenger DMs as Nick's OWN account. Reach for this for the
  "message a person 1:1 (or post in a personal group) as me" case — which the
  official Graph API CANNOT do (it's Page→customer only, the same reason the
  whatsapp CLI uses Baileys, not the Cloud API). Built on ws3-fca, an unofficial
  MQTT-protocol client (the "Baileys for Messenger") — runs headless, no browser.
  NOTE: only sees the Facebook inbox of the logged-in account — NOT Instagram DMs,
  NOT a Page's inbox, NOT a second FB account, and CRITICALLY *not* end-to-end-
  encrypted threads. FB has moved most personal 1:1 chats to E2EE, which ws3-fca is
  blind to — so list/read can look empty/Marketplace-only while the real chat is
  alive in messenger.com. For E2EE contacts, drive messenger.com web via Playwright
  (persistent profile + Nick's E2EE PIN). Confirm identity (whoami) AND remember the
  E2EE blind spot before trusting an empty/negative result.

ToS / RISK
  Unofficial protocol client — technically against FB ToS. Enforcement against
  personal-volume use is uncommon but account-lock risk is real and accepted.
  Keep volume human-paced.

AUTH (the Playwright -> appState bridge)
  ws3-fca runs on an appState (FB cookies). Bootstrap interactively (Nick's hands):
    playwright auth --site https://www.facebook.com --name messenger-fb   # real browser login + 2FA
    messenger auth --appstate ~/.claude/cli-tools/.tokens/playwright/messenger-fb.json
  This converts Playwright's storageState cookies into the appState. Session lives at
  ${APPSTATE} (its own isolated session, independent of fb-marketplace).

MAINTENANCE
  ws3-fca is buggy — 3 crash points are fixed via patch-package
  (patches/ws3-fca+3.5.2.patch, auto-applied by postinstall). If you bump the
  ws3-fca version, re-verify and regenerate the patch.

Usage: messenger <subcommand> [options]

Subcommands:
  auth --appstate <path>              Import a cookies appstate.json (most reliable).
  auth --email X --password Y [--2fa CODE]   Credential login (may hit a checkpoint).
  whoami                              Print logged-in account id (health check).
  list [--limit N] [--json]           List inbox conversations (id + name).
  read --to <name|id> [--limit N] [--json]   Recent messages in a thread.
  send --to <name|id> --text "..."    Send a message (resolves <name> against your inbox).
`);
}

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Promisified login. Returns the `api` object or throws a useful error. */
function doLogin(credentials) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      login(credentials, LOGIN_OPTS, (err, api) => {
        if (settled) return;
        settled = true;
        if (err) {
          // ws3-fca surfaces checkpoints/2FA as structured errors.
          const msg =
            (err && (err.error || err.message || err.errorSummary)) || JSON.stringify(err);
          reject(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)));
        } else resolve(api);
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        reject(e);
      }
    }
  });
}

/** Log in using the stored appstate. Persists any rotated cookies back. Exits if no session. */
async function session() {
  if (!(await fileExists(APPSTATE))) {
    console.error(`No session at ${APPSTATE}. Run \`messenger auth\` first (see --help).`);
    process.exit(3);
  }
  let appState;
  try {
    appState = JSON.parse(await readFile(APPSTATE, "utf8"));
  } catch (e) {
    console.error(`Session file is corrupt (${e.message}). Re-run \`messenger auth\`.`);
    process.exit(3);
  }
  const api = await doLogin({ appState });
  // FB rotates cookies on use — persist the fresh state so the session stays alive.
  try {
    const fresh = api.getAppState();
    await writeFile(APPSTATE, JSON.stringify(fresh, null, 2));
  } catch {
    /* non-fatal */
  }
  return api;
}

async function persistAppState(api) {
  await mkdir(TOKEN_DIR, { recursive: true });
  const state = api.getAppState();
  await writeFile(APPSTATE, JSON.stringify(state, null, 2));
  return state.length;
}

async function cmdAuth(args) {
  let api;
  if (args.appstate) {
    // Import path: log in with someone else's exported cookies, then persist our own copy.
    let imported;
    try {
      imported = JSON.parse(await readFile(args.appstate, "utf8"));
    } catch (e) {
      console.error(`Couldn't read appstate file ${args.appstate}: ${e.message}`);
      process.exit(2);
    }
    // Accept three shapes: a bare cookie array (c3c-fbstate), or a Playwright
    // storageState ({cookies:[...]}) so `playwright auth` can be the interactive
    // login front-end and we convert its cookies into a ws3-fca appState here.
    const cookies = Array.isArray(imported) ? imported : imported.cookies;
    if (!Array.isArray(cookies)) {
      console.error("appstate file has no cookie array (expected an array or {cookies:[...]}).");
      process.exit(2);
    }
    // c3c-fbstate exports {key,value} pairs; Playwright exports {name,value}. Normalize.
    const normalized = cookies.map((c) => ({
      key: c.key || c.name,
      value: c.value,
      domain: c.domain || ".facebook.com",
      path: c.path || "/",
      hostOnly: c.hostOnly ?? false,
      creation: c.creation,
      lastAccessed: c.lastAccessed,
    }));
    api = await doLogin({ appState: normalized });
  } else if (args.email && args.password) {
    const creds = { email: args.email, password: args.password };
    if (args["2fa"]) creds.twoFactorCode = String(args["2fa"]);
    api = await doLogin(creds);
  } else {
    console.error(
      "Usage: messenger auth --appstate <path>   OR   messenger auth --email X --password Y [--2fa CODE]",
    );
    process.exit(2);
  }
  const n = await persistAppState(api);
  console.log(
    JSON.stringify(
      { ok: true, account: api.getCurrentUserID(), cookies: n, saved: APPSTATE },
      null,
      2,
    ),
  );
  process.exit(0); // ws3-fca keeps an mqtt handle open; exit cleanly.
}

async function cmdWhoami() {
  const api = await session();
  console.log(api.getCurrentUserID());
  process.exit(0);
}

/** Pull the inbox thread list, normalized to {id, name, isGroup, participants}. */
async function fetchThreads(api, limit) {
  const raw = await api.getThreadList(limit, null, ["INBOX"]);
  return (raw || []).map((t) => {
    const parts = (t.participants || t.userInfo || []).map((p) => p.name).filter(Boolean);
    // 1:1 threads often have a null threadName — fall back to the other participant.
    const name =
      t.threadName ||
      t.name ||
      (!t.isGroup && parts.length ? parts.find(Boolean) : null) ||
      "(unnamed)";
    return { id: String(t.threadID), name, isGroup: !!t.isGroup, participants: parts };
  });
}

async function cmdList(args) {
  const limit = Number(args.limit) || 25;
  const api = await session();
  const threads = await fetchThreads(api, limit);
  if (args.json) console.log(JSON.stringify(threads, null, 2));
  else if (!threads.length) console.error("No conversations found.");
  else for (const t of threads) console.log(`${t.id}\t${t.isGroup ? "[group] " : ""}${t.name}`);
  process.exit(0);
}

/**
 * Resolve a --to value to a threadID. Numeric → used directly. Otherwise matched (case-insensitive
 * substring) against thread names AND participant names in the inbox. Throws with candidates on
 * ambiguity / no match.
 */
async function resolveTo(api, to) {
  if (/^\d+$/.test(to)) {
    // Look the id up in the inbox to learn isGroup (so send picks the right shape).
    // If it's not in the recent list, assume a 1:1 user id (the usual case for a raw id).
    const threads = await fetchThreads(api, 100).catch(() => []);
    const known = threads.find((t) => t.id === to);
    return known || { id: to, name: to, isGroup: false };
  }
  const threads = await fetchThreads(api, 100);
  const needle = to.toLowerCase();
  const matches = threads.filter(
    (t) =>
      t.name.toLowerCase().includes(needle) ||
      t.participants.some((p) => p.toLowerCase().includes(needle)),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0)
    throw new Error(
      `No conversation matching "${to}". Visible threads:\n` +
        threads.map((t) => `  ${t.id}\t${t.name}`).join("\n"),
    );
  throw new Error(
    `"${to}" matched ${matches.length} threads — be more specific or use the id:\n` +
      matches.map((t) => `  ${t.id}\t${t.name}`).join("\n"),
  );
}

async function cmdRead(args) {
  if (!args.to) {
    console.error("Usage: read --to <name|id> [--limit N] [--json]");
    process.exit(2);
  }
  const limit = Number(args.limit) || 20;
  const api = await session();
  const target = await resolveTo(api, args.to);
  const history = await api.getThreadHistory(target.id, limit, undefined);
  const msgs = (history || []).map((m) => ({
    from: m.senderName || m.senderID,
    body: m.body || (m.attachments?.length ? `[${m.attachments.length} attachment(s)]` : ""),
    time: m.timestamp,
  }));
  if (args.json) console.log(JSON.stringify({ to: target.name, threadId: target.id, messages: msgs }, null, 2));
  else console.log(msgs.map((m) => `${m.from}: ${m.body}`).join("\n"));
  process.exit(0);
}

async function cmdSend(args) {
  // Body comes from --text "..." or --file PATH (cleaner for multi-line messages).
  let body;
  if (args.file) body = await readFile(args.file, "utf8");
  else if (args.text !== undefined && args.text !== true) body = String(args.text);
  if (!args.to || body === undefined) {
    console.error('Usage: send --to <name|id> (--text "..." | --file PATH)');
    process.exit(2);
  }
  const api = await session();
  const target = await resolveTo(api, args.to);
  // 1:1 threads need isSingleUser=true (other_user_fbid); groups use thread_fbid.
  const isSingleUser = !target.isGroup;
  const info = await api.sendMessage(body, target.id, null, isSingleUser);
  console.log(
    JSON.stringify(
      {
        sent: !!(info && (info.messageID || info.messageId)),
        to: target.name,
        threadId: target.id,
        messageId: info?.messageID || info?.messageId || null,
        text: body,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return help();
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (sub) {
    case "auth":
      return cmdAuth(args);
    case "whoami":
      return cmdWhoami();
    case "list":
      return cmdList(args);
    case "read":
      return cmdRead(args);
    case "send":
      return cmdSend(args);
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
