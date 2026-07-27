#!/usr/bin/env node
/**
 * whatsapp — CLI for sending messages and listing groups via Baileys.
 *
 * IMPORTANT: This uses the unofficial WhatsApp Web protocol (Baileys). It
 * technically violates WhatsApp's Terms of Service. Enforcement against
 * personal-volume use is rare but not zero — your number could be banned in
 * the worst case. Use for personal automation only.
 *
 * Auth: multi-file auth state at ~/git/tools/cli-tools/.tokens/whatsapp/
 * First-time setup: run `whatsapp auth` and scan the QR code with your phone
 * (WhatsApp → Settings → Linked Devices → Link a Device).
 *
 * Subcommands:
 *   auth           Show QR code, scan with phone to link, save session
 *   list-groups    List all groups you're in (jid + name + participant count)
 *   send           Send a text message. --to JID --text TEXT (or --file PATH)
 *   rename-group   Rename a group. --to <group-jid> --name "<new name>"
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  generateMessageID,
  downloadMediaMessage,
} from "baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TOKENS_DIR } from "../lib/paths.mjs";

const AUTH_DIR = join(TOKENS_DIR, "whatsapp");
// Persistent cooldown gate. When WhatsApp starts terminating handshakes (428,
// "Connection Terminated"), it's a server-side rate-limit — and every extra
// reconnect attempt *extends* it. This lockfile makes re-hammering impossible
// across invocations: once we've been rate-limited we refuse to even open a
// socket until the cooldown passes. Removes the window instead of guarding it.
const COOLDOWN_FILE = join(AUTH_DIR, ".rate-limit-cooldown");
const COOLDOWN_MS = 20 * 60 * 1000; // 20 min — WhatsApp soft-blocks clear on this order

// Single-socket IPC. WhatsApp's multi-device protocol enforces exactly ONE live
// socket per device-credential set: a second socket on the same creds triggers
// connectionReplaced (stream error 440) and BOTH sockets stall (the same thing
// that logs WhatsApp Web out of a second tab). So when the `watch` daemon is
// running it OWNS the only socket, and other subcommands must not open their own.
// Instead they submit a job to the watcher over the filesystem and poll for a
// response — the watcher runs it on its one live socket. See submitJob/runJob and
// the jobs-drainer in cmdWatch.
//
// Path note: the watcher's *capture* state (wa-events.ndjson, wa-outbox, wa-media)
// still lives under ~/.whatsapp.messages — that dir is the love-agent project's home and
// its extractor + two launchd plists hardcode those paths; moving them is a
// separate, multi-process migration. The IPC state introduced here is brand-new
// with no external consumers, so it lives under its own ~/.whatsapp home.
const WA_HOME = join(homedir(), ".whatsapp.messages");
const WATCH_PID_PATH = join(WA_HOME, "wa-watch.pid");
const JOBS_DIR = join(WA_HOME, "wa-jobs");

/**
 * Return the PID of a live `watch` daemon, or null if none is running.
 * Reads the pid file the watcher writes on start and confirms the process is
 * actually alive (signal 0 probes existence without delivering a signal). A
 * stale pid file from a crashed watcher resolves to null, so callers fall back
 * to opening their own direct socket — correct, because no socket is held.
 */
async function readWatcherPid() {
  let raw;
  try {
    raw = await readFile(WATCH_PID_PATH, "utf8");
  } catch {
    return null;
  }
  const pid = Number(String(raw).trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    // EPERM = process exists but we can't signal it (still alive). ESRCH = gone.
    return e.code === "EPERM" ? pid : null;
  }
}

// --- Single-socket lock (the thrash guard) --------------------------------
// WhatsApp allows exactly one live Baileys socket per credential. TWO sockets on
// the same creds => connectionReplaced/440, both stall, and WhatsApp 428-blocks
// the account (the thrash bug: a stray `list-groups` opened a second socket while
// the watcher held one, because pid-file detection missed a reconnecting watcher).
// This lock is the single door every openSocket() passes through: whoever opens a
// socket holds an exclusive lockfile for its lifetime; any OTHER openSocket() that
// can't acquire it FAILS CLOSED with a clear message instead of racing. It closes
// the exact gap readWatcherPid() has — the lock is held by the live socket owner
// regardless of whether its pid file is present/stale.
const SOCKET_LOCK_PATH = join(WA_HOME, "socket.lock");

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but unsignalable = alive; ESRCH = gone
  }
}

async function acquireSocketLock() {
  await mkdir(WA_HOME, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // flag "wx" = O_CREAT|O_EXCL: atomic, throws EEXIST if the lock already exists.
      await writeFile(SOCKET_LOCK_PATH, String(process.pid), { flag: "wx", mode: 0o600 });
      return; // acquired
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = null;
      try {
        holder = Number(String(await readFile(SOCKET_LOCK_PATH, "utf8")).trim());
      } catch {
        /* lock vanished between our create-attempt and read — loop and retry */
      }
      if (pidAlive(holder)) {
        throw new Error(
          `Another whatsapp process (pid ${holder}) already holds the WhatsApp socket.\n` +
            `  Only ONE socket per credential is allowed — a second triggers a 428 block.\n` +
            `  send / list-groups / rename-group auto-route through the running watcher (no socket needed);\n` +
            `  direct-socket commands must wait for it to free the socket, or stop the watcher first.`,
        );
      }
      // Stale lock from a crashed holder (or it just vanished) — clear and retry once.
      await unlink(SOCKET_LOCK_PATH).catch(() => {});
    }
  }
  throw new Error("could not acquire the WhatsApp socket lock (stale-lock race) — retry shortly.");
}

async function releaseSocketLock() {
  try {
    const holder = Number(String(await readFile(SOCKET_LOCK_PATH, "utf8")).trim());
    if (holder === process.pid) await unlink(SOCKET_LOCK_PATH);
  } catch {
    /* already released / never held */
  }
}

/**
 * Submit a job to the running watcher and block until it returns a result.
 *
 * Protocol (filesystem RPC under JOBS_DIR):
 *   - Client writes <id>.req.tmp then atomically renames to <id>.req.json so the
 *     drainer never observes a partial request.
 *   - Watcher claims it (rename → .req.inflight), runs it on its live socket,
 *     writes <id>.res.tmp then renames to <id>.res.json.
 *   - Client polls for <id>.res.json, reads + deletes it, returns result.json.
 *
 * The request carries a deadline; if the client gives up first, the drainer
 * skips expired requests so the watcher never does work nobody will read.
 */
async function submitJob(kind, payload, { timeoutMs = 30000 } = {}) {
  await mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const reqTmp = join(JOBS_DIR, `${id}.req.tmp`);
  const reqFinal = join(JOBS_DIR, `${id}.req.json`);
  const resPath = join(JOBS_DIR, `${id}.res.json`);
  const deadline = Date.now() + timeoutMs;
  await writeFile(reqTmp, JSON.stringify({ id, kind, payload, deadline_ms: deadline }), { mode: 0o600 });
  await rename(reqTmp, reqFinal);

  while (Date.now() < deadline) {
    let raw;
    try {
      raw = await readFile(resPath, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    await unlink(resPath).catch(() => {});
    const res = JSON.parse(raw);
    if (res.error) throw new Error(`watcher job '${kind}' failed: ${res.error}`);
    return res.result;
  }
  // Timed out — clean our unclaimed request so the drainer doesn't service it.
  await unlink(reqFinal).catch(() => {});
  throw new Error(
    `watcher is running but did not service the '${kind}' job within ${timeoutMs}ms ` +
      `(its socket may be reconnecting). Retry shortly, or stop the watcher to use a direct socket.`,
  );
}

/**
 * Execute one brokered job on the watcher's live socket. Only the stateless
 * request/response commands are brokered here — history-sync collectors
 * (request-history/backfill/download-media) still need their own socket and are
 * guarded to fail fast when a watcher holds the connection.
 */
async function runJob(job, sock) {
  switch (job.kind) {
    case "send": {
      const { to, text, sendOpts } = job.payload;
      const res = await sock.sendMessage(to, { text: String(text) }, sendOpts ?? {});
      return { message_id: res?.key?.id ?? null, timestamp: res?.messageTimestamp ?? null };
    }
    case "list-groups": {
      const groups = await sock.groupFetchAllParticipating();
      return Object.values(groups)
        .map((g) => ({
          jid: g.id,
          name: g.subject,
          participants: g.participants?.length ?? null,
          is_announcement: g.announce ?? false,
        }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }
    case "rename-group": {
      await sock.groupUpdateSubject(job.payload.to, String(job.payload.name));
      return { renamed: job.payload.to, new_name: job.payload.name };
    }
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}

// Subcommands that collide with a running watcher and aren't yet brokered: they
// need their own socket to drive a history-sync collect. Fail fast (not stall).
function failIfWatcherRunningSync(pid, cmd) {
  console.error(
    `\`${cmd}\` needs its own WhatsApp socket, but the \`watch\` daemon (pid ${pid}) holds the only one ` +
      `allowed per device — a second socket would trigger connectionReplaced (440) and stall both.\n` +
      `Options: stop the watcher and re-run, or rely on what the watcher already captures live ` +
      `(new messages + media auto-save to the NDJSON log; use \`fetch-history\` to read it).`,
  );
  process.exit(4);
}

// Silence Baileys' internal noise. The library logs a lot at info-level.
// When WHATSAPP_DEBUG=1, we let it spew so failed handshakes leave a trail.
const silentLogger = pino({ level: process.env.WHATSAPP_DEBUG ? "debug" : "silent" });

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function help() {
  console.log(`whatsapp — Baileys-backed WhatsApp CLI

WHY / WHEN TO USE
  Posts/reads in Nick's personal WhatsApp groups & DMs as Nick, via Baileys
  (unofficial WhatsApp Web protocol) — NOT the Meta Cloud API. Use for the
  "post to an existing personal group as me" case: the Cloud API is business→
  customer 1:1 only and cannot do personal-account group messaging.
  ToS: Baileys technically violates WhatsApp's ToS; enforcement against
  personal-volume use is rare, but keep volume human-paced.

Usage: whatsapp <subcommand> [options]

Auth state: ${AUTH_DIR}/
First-time setup: \`whatsapp auth\` and scan QR with your phone.

Subcommands:
  auth           One-time QR-scan setup. Phone: Settings → Linked Devices → Link a Device.
  list-groups    List groups you're in (jid + name + size). Useful for finding a group jid.
  send           Send a message. --to <JID> --text "..." | --file PATH
                 [--reply-to <msg-id>] quote-reply (id from 'read --json' .id);
                 for GROUP replies also --reply-author <sender-jid> (.author).
  rename-group   Rename a group. --to <group-jid> --name "<new name>"
  fetch-history  Dump chat history. --name <substr> or --jid <jid> [--out PATH] [--max-wait <s>]
                 With neither --name nor --jid: lists all chats (a chat picker).
  request-history  On-demand backfill for one chat. --phone <num> or --jid <jid> [--count N]
                 (Only works if we have a real anchor — first-time use on a quiet chat may fail.)
  watch          Long-running daemon. Captures every incoming/outgoing DM and appends to
                 ~/.whatsapp.messages/wa-events.ndjson. Auto-reconnects on disconnect.
                 Media (images/video/audio/docs/stickers) auto-downloads to
                 ~/.whatsapp.messages/wa-media/<jid>/ and a "media" event logs the path.
  backfill       Pull history older than what's in the NDJSON log for one chat.
                 --jid <jid> or --phone <num> [--batch-size 200] [--max-iterations 20]
                 Reads the oldest captured message as anchor, loops fetchMessageHistory
                 until the phone returns nothing. Writes results into the NDJSON log.
  download-media On-demand media download for one chat (counterpart to watch's auto-download).
                 --jid <jid> or --name <substr> [--out-dir PATH] [--max-wait <s>]
                 Needs its own socket — fails fast if the watcher holds it; stop watch first.

SINGLE-SOCKET / WATCHER ROUTING
  WhatsApp allows exactly ONE live socket per device-credential set (a 2nd triggers
  connectionReplaced/440 and stalls both). So when the \`watch\` daemon is running it
  owns the socket, and these commands auto-route through it — no need to stop it:
    send, list-groups, rename-group   → brokered to the watcher (filesystem RPC, ~/.whatsapp/wa-jobs)
    fetch-history                     → served from the watcher's NDJSON capture log
  These still need their own socket and fail fast (stop the watcher to run them):
    request-history, backfill, download-media
`);
}

/**
 * Open a Baileys WhatsApp socket using the persisted auth state.
 *
 * Handles the standard WhatsApp two-phase handshake:
 *   - First connection (QR path): pair exchange, then server forces
 *     restartRequired (code 515). We tear down and reopen with saved creds.
 *   - Subsequent connection: reaches 'open' and is ready for use.
 *
 * Resolves with the socket once the connection state is 'open'. Rejects on
 * a non-recoverable disconnect (loggedOut, forbidden, etc).
 *
 * If qrCallback is supplied, it's invoked with each fresh QR string during
 * the pair phase. Subsequent reconnects with saved creds emit no QRs.
 */
async function openSocket({ qrCallback } = {}) {
  await mkdir(AUTH_DIR, { recursive: true });

  // Cooldown gate: if a prior run got rate-limited, refuse to connect (which
  // would only reset WhatsApp's timer) until the cooldown expires.
  try {
    const until = Number(await readFile(COOLDOWN_FILE, "utf8"));
    if (Number.isFinite(until) && Date.now() < until) {
      const mins = Math.ceil((until - Date.now()) / 60000);
      throw new Error(
        `WhatsApp rate-limit cooldown active — ${mins} min left.\n` +
          `  WhatsApp is temporarily refusing new web sessions (a 428 soft-block).\n` +
          `  This is NOT a dead session: do NOT clear creds or re-pair.\n` +
          `  Retrying now only extends the block. Wait it out, then try again.\n` +
          `  (Override: rm ${COOLDOWN_FILE})`,
      );
    }
  } catch (e) {
    // A genuine cooldown error above has our message prefix — rethrow it.
    // A missing/garbage cooldown file (ENOENT / NaN) is fine — fall through.
    if (e?.message?.startsWith("WhatsApp rate-limit cooldown")) throw e;
  }

  // Single-socket lock: fail CLOSED if another process already holds a socket on
  // these creds (prevents the two-sockets-one-credential 428 thrash). Held for the
  // returned socket's lifetime; released on close (below) or on any failure (catch).
  await acquireSocketLock();
  try {

  const TERMINAL_REASONS = new Set([
    DisconnectReason.loggedOut,
    DisconnectReason.forbidden,
    DisconnectReason.multideviceMismatch,
    DisconnectReason.badSession,
  ]);

  let lastCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      logger: silentLogger,
      printQRInTerminal: false,
      browser: Browsers.macOS("Desktop"),
      // Ask the server for the full available history window on first sync.
      // Already-paired sessions get incremental RECENT syncs regardless;
      // this only matters during the initial pair (auth).
      syncFullHistory: true,
    });
    sock.ev.on("creds.update", saveCreds);

    const outcome = await new Promise((resolve) => {
      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && qrCallback) qrCallback(qr);
        if (connection === "open") resolve({ kind: "open" });
        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          resolve({ kind: "close", code });
        }
      });
    });

    if (outcome.kind === "open") {
      // Clean connect — clear any stale cooldown so we don't block next time.
      await unlink(COOLDOWN_FILE).catch(() => {});
      // Hold the lock for this socket's lifetime; free it when the socket closes so
      // the watcher's own reconnect (a fresh openSocket) can re-acquire cleanly.
      sock.ev.on("connection.update", (u) => {
        if (u.connection === "close") releaseSocketLock();
      });
      return sock;
    }

    lastCode = outcome.code;

    if (TERMINAL_REASONS.has(outcome.code)) {
      const name = Object.entries(DisconnectReason).find(([, v]) => v === outcome.code)?.[0];
      throw new Error(`Terminal disconnect: ${name ?? outcome.code}`);
    }
    // A 428 close means the server is rate-limiting new sessions: every further
    // dial in this loop deepens the block. One strike and out — fall through to
    // the cooldown-arming path below instead of dialing up to 4 more times.
    if (outcome.code === DisconnectReason.connectionClosed) break;
    // restartRequired (515), connectionLost, etc — back off and retry.
    // Exponential (0.5s, 1s, 2s, 4s) so we don't machine-gun the server.
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }

  // Exhausted retries without connecting. A 428 ("connectionClosed" /
  // "Connection Terminated") means WhatsApp is rate-limiting new sessions —
  // arm the cooldown so nothing hammers it further, and explain the real cause.
  if (lastCode === DisconnectReason.connectionClosed) {
    await writeFile(COOLDOWN_FILE, String(Date.now() + COOLDOWN_MS)).catch(() => {});
    throw new Error(
      `WhatsApp rate-limited the connection (428, "Connection Terminated").\n` +
        `  This is a SERVER-SIDE soft-block on opening new web sessions, usually\n` +
        `  provoked by repeated reconnects. It is NOT a dead session, a stale\n` +
        `  Baileys, or a network fault — so do NOT clear creds or re-pair.\n` +
        `  Armed a ${COOLDOWN_MS / 60000}-min cooldown; the block lifts on its own.\n` +
        `  Best long-term fix: run 'whatsapp watch' to hold one persistent socket\n` +
        `  instead of cold-connecting (and storming) on every command.`,
    );
  }
  throw new Error(
    `Could not reach 'open' connection state after 5 attempts (last close code: ${lastCode}).`,
  );

  } catch (e) {
    // Any failure to establish/keep the socket frees the lock so the next attempt
    // (or the watcher) can acquire it — never leave a stale lock on a throw.
    await releaseSocketLock();
    throw e;
  }
}

async function cmdAuth() {
  console.error("Scan this QR code in WhatsApp on your phone:");
  console.error("  iPhone:  Settings → Linked Devices → Link a Device");
  console.error("  Android: ⋮ menu → Linked devices → Link a device");
  console.error("");

  const sock = await openSocket({
    qrCallback: (qr) => qrcode.generate(qr, { small: true }),
  });

  console.error("");
  console.error("Linked. Saving session.");
  await new Promise((r) => setTimeout(r, 1500));
  sock.end();
  console.log(JSON.stringify({ status: "linked", auth_dir: AUTH_DIR }, null, 2));
}

async function cmdListGroups() {
  if (await readWatcherPid()) {
    const summary = await submitJob("list-groups", {});
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const sock = await openSocket();
  const groups = await sock.groupFetchAllParticipating();
  const summary = Object.values(groups).map((g) => ({
    jid: g.id,
    name: g.subject,
    participants: g.participants?.length ?? null,
    is_announcement: g.announce ?? false,
  }));
  summary.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  console.log(JSON.stringify(summary, null, 2));
  sock.end();
}

async function cmdSend(args) {
  if (!args.to) {
    console.error("Usage: send --to <JID> --text \"...\" | --file PATH");
    process.exit(2);
  }
  let text;
  if (args.text) text = String(args.text);
  else if (args.file) text = await readFile(args.file, "utf8");
  else {
    console.error("Provide --text or --file");
    process.exit(2);
  }

  // Group JIDs end in @g.us; personal in @s.whatsapp.net. Bare digits = DM.
  let jid = args.to;
  if (!jid.includes("@")) jid = `${jid.replace(/\D/g, "")}@s.whatsapp.net`;

  // --reply-to <msg-id> quotes a message. Baileys needs a quoted stub, not just
  // an id: key {remoteJid,id,fromMe,participant?} + a message body. The id comes
  // from `whatsapp read --json` (.id); for GROUP replies also pass
  // --reply-author <sender-jid> (.author) so the quote attributes correctly.
  // Built before the socket decision so it travels intact through the broker too.
  const sendOpts = {};
  if (args["reply-to"]) {
    const isGroup = jid.endsWith("@g.us");
    sendOpts.quoted = {
      key: {
        remoteJid: jid,
        fromMe: false,
        id: String(args["reply-to"]),
        ...(isGroup && args["reply-author"] ? { participant: String(args["reply-author"]) } : {}),
      },
      message: { conversation: args["reply-text"] ? String(args["reply-text"]) : "" },
    };
  }

  // If the watch daemon holds the socket, send THROUGH it — opening our own would
  // trigger connectionReplaced (440) and stall both. The broker returns the same
  // {message_id, timestamp} the direct path reports, so output shape is unchanged.
  const watcherPid = await readWatcherPid();
  if (watcherPid) {
    const result = await submitJob("send", { to: jid, text, sendOpts });
    console.log(
      JSON.stringify(
        { sent_to: jid, message_id: result?.message_id ?? null, timestamp: result?.timestamp ?? null, via: "watcher" },
        null,
        2,
      ),
    );
    return;
  }

  const sock = await openSocket();
  const result = await sock.sendMessage(jid, { text }, sendOpts);
  await new Promise((r) => setTimeout(r, 1500));
  sock.end();
  console.log(
    JSON.stringify(
      {
        sent_to: jid,
        message_id: result?.key?.id ?? null,
        timestamp: result?.messageTimestamp ?? null,
      },
      null,
      2,
    ),
  );
}

/**
 * Walk a WAMessage to pull out plain text, if any. WhatsApp messages come in
 * many shapes (conversation, extendedTextMessage, captioned media, ephemeral
 * wrappers, etc). We return null for non-text payloads — the caller can still
 * see the `type` field if it cares.
 */
function extractText(m) {
  const msg = m?.message;
  if (!msg) return null;
  // Ephemeral and view-once wrappers nest the real message one level deeper.
  const inner =
    msg.ephemeralMessage?.message ??
    msg.viewOnceMessage?.message ??
    msg.viewOnceMessageV2?.message ??
    msg;
  return (
    inner.conversation ??
    inner.extendedTextMessage?.text ??
    inner.imageMessage?.caption ??
    inner.videoMessage?.caption ??
    inner.documentMessage?.caption ??
    null
  );
}

function classifyMessage(m) {
  const msg = m?.message;
  if (!msg) return "empty";
  const inner =
    msg.ephemeralMessage?.message ??
    msg.viewOnceMessage?.message ??
    msg.viewOnceMessageV2?.message ??
    msg;
  // Order matters — text-ish first, then media, then everything else.
  if (inner.conversation || inner.extendedTextMessage) return "text";
  if (inner.imageMessage) return "image";
  if (inner.videoMessage) return "video";
  if (inner.audioMessage) return inner.audioMessage.ptt ? "voice" : "audio";
  if (inner.stickerMessage) return "sticker";
  if (inner.documentMessage) return "document";
  if (inner.locationMessage) return "location";
  if (inner.contactMessage || inner.contactsArrayMessage) return "contact";
  if (inner.reactionMessage) return "reaction";
  if (inner.pollCreationMessage) return "poll";
  return Object.keys(inner)[0] ?? "unknown";
}

// The classifyMessage() types that carry a downloadable binary payload.
const MEDIA_TYPES = new Set(["image", "video", "audio", "voice", "sticker", "document"]);

// Unwrap ephemeral/view-once envelopes and return the inner media sub-message
// (imageMessage, videoMessage, …) for a WAMessage, or null if there's none.
function mediaNode(m) {
  const msg = m?.message;
  if (!msg) return null;
  const inner =
    msg.ephemeralMessage?.message ??
    msg.viewOnceMessage?.message ??
    msg.viewOnceMessageV2?.message ??
    msg;
  return (
    inner.imageMessage ??
    inner.videoMessage ??
    inner.audioMessage ??
    inner.stickerMessage ??
    inner.documentMessage ??
    null
  );
}

// Choose a file extension for a media message: prefer its mimetype, fall back to
// a document's own filename, then to a per-kind default.
function extForMessage(m, kind) {
  const media = mediaNode(m) ?? {};
  const mime = String(media.mimetype ?? "").split(";")[0].trim();
  const MIME_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/3gpp": "3gp",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "application/pdf": "pdf",
  };
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  if (kind === "document" && typeof media.fileName === "string" && media.fileName.includes(".")) {
    return media.fileName.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  }
  const KIND_FALLBACK = { image: "jpg", video: "mp4", audio: "ogg", voice: "ogg", sticker: "webp", document: "bin" };
  return KIND_FALLBACK[kind] ?? "bin";
}

/**
 * Download a single media message's bytes to destDir and return the file path,
 * or null if the message carries no downloadable media.
 *
 * WhatsApp expires media blobs on its CDN after a while; `reuploadRequest` lets
 * Baileys ask the phone to re-upload an expired blob so the download can still
 * succeed. Filenames are `<message-id>.<ext>` so repeat downloads are idempotent.
 */
async function downloadMediaToDir(sock, m, destDir, kind) {
  if (!mediaNode(m)) return null;
  const fs = await import("node:fs/promises");
  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  const buffer = await downloadMediaMessage(
    m,
    "buffer",
    {},
    { logger: silentLogger, reuploadRequest: sock.updateMediaMessage },
  );
  const id = String(m?.key?.id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "");
  const ext = extForMessage(m, kind);
  const filePath = join(destDir, `${id}.${ext}`);
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

// Sanitise a JID into a safe directory-name component.
function jidToDir(jid) {
  return String(jid).replace(/[^A-Za-z0-9_.@-]/g, "_");
}

/**
 * Fetch chat history.
 *
 * Strategy: open a Baileys socket, let WhatsApp's history-sync push us
 * everything it's going to push, and stop when either:
 *   - every distinct syncType seen has emitted a 'complete' status, or
 *   - --max-wait seconds have elapsed.
 *
 * Then resolve the user's target chat (by JID, by name substring, or — if
 * neither was given — print a picker of all chats and exit), and emit the
 * collected messages for that chat as a structured JSON dump.
 *
 * Known limitation: WhatsApp's server-side history-sync window is bounded
 * (~6 months on most phones, less if the phone is space-pressured). For
 * older messages, Baileys also exposes `fetchMessageHistory(count, key, ts)`
 * for on-demand backfill — not wired up here; add it if the initial sync
 * comes back short.
 */
/**
 * Serve fetch-history from the watcher's NDJSON capture log rather than a live
 * socket. Used whenever the watch daemon is running (it owns the only socket).
 *
 * Reconstructs the same picker / single-chat dump shapes cmdFetchHistory emits,
 * but built from logged "message"/"chat"/"contact" events instead of a fresh
 * history-sync. Output carries `source: "watcher-log"` so consumers can tell.
 */
async function fetchHistoryFromLog(args) {
  const readline = await import("node:readline");
  const { createReadStream } = await import("node:fs");
  const logPath = join(homedir(), ".whatsapp.messages", "wa-events.ndjson");
  try {
    await stat(logPath);
  } catch {
    console.error(`No watcher capture log at ${logPath} yet — let \`watch\` run and capture some messages first.`);
    process.exit(3);
  }

  const nameByJid = new Map(); // jid -> best display name (chat/contact name)
  const pushByJid = new Map(); // jid -> Set<pushName> (all senders, for display)
  const inboundPushByJid = new Map(); // jid -> Set<pushName> from NOT-from-me msgs
  const msgsByJid = new Map(); // jid -> Map<id|me/them, logged message event>

  const rl = readline.createInterface({ input: createReadStream(logPath, { encoding: "utf8" }) });
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // skip corrupt lines
    }
    if (e.event === "chat") {
      if (e.name) nameByJid.set(e.jid, e.name);
    } else if (e.event === "contact") {
      const n = e.name || e.notify || e.verified_name;
      if (n && !nameByJid.has(e.jid)) nameByJid.set(e.jid, n);
    } else if (e.event === "message" && e.jid) {
      const bucket = msgsByJid.get(e.jid) ?? new Map();
      bucket.set(`${e.id}|${e.from_me ? "me" : "them"}`, e); // last-write-wins on edits
      msgsByJid.set(e.jid, bucket);
      if (e.push_name) {
        const s = pushByJid.get(e.jid) ?? new Set();
        s.add(e.push_name);
        pushByJid.set(e.jid, s);
        if (!e.from_me) {
          const si = inboundPushByJid.get(e.jid) ?? new Set();
          si.add(e.push_name);
          inboundPushByJid.set(e.jid, si);
        }
      }
    }
  }

  // Name priority: explicit chat/contact name → the COUNTERPARTY's pushName (from
  // inbound messages) → any pushName → null. Inbound-first matters for DMs: the
  // bucket holds both my own "Nick" pushName and the other party's, and naming a
  // chat after myself would make it unfindable by the contact's name.
  const nameForJid = (jid) =>
    nameByJid.get(jid) ??
    [...(inboundPushByJid.get(jid) ?? [])][0] ??
    [...(pushByJid.get(jid) ?? [])][0] ??
    null;
  const isChatJid = (jid) =>
    jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid") || jid.endsWith("@g.us");

  // No selector → picker of all captured chats.
  if (!args.name && !args.jid) {
    const rows = [...msgsByJid.keys()]
      .filter(isChatJid)
      .map((jid) => {
        const msgs = [...msgsByJid.get(jid).values()].sort(
          (a, b) => (b.timestamp_ms ?? 0) - (a.timestamp_ms ?? 0),
        );
        const newest = msgs[0];
        const preview = newest ? (newest.text ?? `[${newest.type}]`) : null;
        return {
          jid,
          name: nameForJid(jid),
          push_names: [...(pushByJid.get(jid) ?? [])],
          message_count: msgs.length,
          last_preview: preview ? String(preview).slice(0, 80) : null,
        };
      });
    rows.sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
    console.log(JSON.stringify({ source: "watcher-log", chats: rows }, null, 2));
    return;
  }

  // Resolve target JID (explicit --jid, or unique name-substring match).
  let targetJid = args.jid;
  if (!targetJid) {
    const needle = String(args.name).toLowerCase();
    const candidates = [];
    for (const jid of msgsByJid.keys()) {
      const n = nameForJid(jid);
      if (n && n.toLowerCase().includes(needle)) {
        candidates.push({ jid, name: n, message_count: msgsByJid.get(jid).size });
      }
    }
    if (candidates.length === 0) {
      console.error(`No captured chat matched name "${args.name}". Run without --name/--jid for the picker.`);
      process.exit(3);
    }
    if (candidates.length > 1) {
      candidates.sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
      console.error(`Multiple captured chats matched "${args.name}" (most messages first):`);
      console.error(JSON.stringify(candidates, null, 2));
      console.error("Re-run with --jid <one of the above> to disambiguate.");
      process.exit(3);
    }
    targetJid = candidates[0].jid;
  }

  const bucket = msgsByJid.get(targetJid) ?? new Map();
  const messages = [...bucket.values()]
    .map((e) => ({
      id: e.id ?? null,
      from_me: !!e.from_me,
      author: e.author ?? null,
      timestamp_ms: e.timestamp_ms ?? null,
      push_name: e.push_name ?? null,
      type: e.type ?? null,
      text: e.text ?? null,
    }))
    .sort((a, b) => (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0));

  const dump = {
    jid: targetJid,
    name: nameForJid(targetJid),
    source: "watcher-log",
    message_count: messages.length,
    messages,
  };
  const json = JSON.stringify(dump, null, 2);
  if (args.out) {
    await writeFile(args.out, json, { mode: 0o600 });
    console.error(`Wrote ${messages.length} messages to ${args.out} (source: watcher-log)`);
  } else {
    console.log(json);
  }
}

async function cmdFetchHistory(args) {
  // With a watcher running, the once-per-pair history-sync flood can't be
  // re-triggered on its long-lived socket — but it doesn't need to be: the
  // watcher has been appending every message to the NDJSON log since it started.
  // Serve the answer from that log (instant, no socket) instead of stalling on a
  // colliding second socket. Older-than-capture history is what backfill is for.
  if (await readWatcherPid()) {
    return fetchHistoryFromLog(args);
  }

  const maxWaitSec = Number(args["max-wait"] ?? 90);
  if (!Number.isFinite(maxWaitSec) || maxWaitSec <= 0) {
    console.error("--max-wait must be a positive number of seconds");
    process.exit(2);
  }

  const sock = await openSocket();

  // Map<jid, WAMessage[]>, deduped by message id+fromMe.
  const messagesByJid = new Map();
  // Map<jid, {name, pushName, jid}>
  const chatsByJid = new Map();
  // Map<jid, contact-record>
  const contactsByJid = new Map();
  // syncTypes we've seen at least one batch for, and whether each has completed.
  const syncSeen = new Set();
  const syncDone = new Set();

  function recordMessage(m) {
    const jid = m?.key?.remoteJid;
    if (!jid) return;
    const id = m.key.id ?? "";
    const fromMe = !!m.key.fromMe;
    const dedupeKey = `${id}|${fromMe ? "me" : "them"}`;
    const bucket = messagesByJid.get(jid) ?? new Map();
    if (!bucket.has(dedupeKey)) bucket.set(dedupeKey, m);
    messagesByJid.set(jid, bucket);
  }

  sock.ev.on("messaging-history.set", (evt) => {
    if (evt.syncType != null) syncSeen.add(evt.syncType);
    for (const c of evt.chats ?? []) {
      const prev = chatsByJid.get(c.id) ?? {};
      chatsByJid.set(c.id, { ...prev, jid: c.id, name: c.name ?? prev.name ?? null });
    }
    for (const c of evt.contacts ?? []) {
      contactsByJid.set(c.id, c);
    }
    for (const m of evt.messages ?? []) recordMessage(m);
    if (process.env.WHATSAPP_DEBUG) {
      console.error(
        `[history.set] syncType=${evt.syncType} chats=${evt.chats?.length ?? 0} ` +
          `contacts=${evt.contacts?.length ?? 0} messages=${evt.messages?.length ?? 0} ` +
          `progress=${evt.progress} isLatest=${evt.isLatest}`,
      );
    }
  });

  // Also catch messages that arrive via the normal upsert channel during the
  // sync window — sometimes the tail of the history shows up here, not via
  // messaging-history.set.
  sock.ev.on("messages.upsert", (evt) => {
    for (const m of evt.messages ?? []) recordMessage(m);
  });

  // Wait for completion: every syncType we've heard about has hit 'complete',
  // and we've heard about at least one. With a hard deadline as backstop.
  const done = new Promise((resolve) => {
    let resolved = false;
    const finish = (reason) => {
      if (resolved) return;
      resolved = true;
      resolve(reason);
    };
    sock.ev.on("messaging-history.status", (evt) => {
      if (process.env.WHATSAPP_DEBUG) {
        console.error(
          `[history.status] syncType=${evt.syncType} status=${evt.status} explicit=${evt.explicit}`,
        );
      }
      if (evt.status === "complete") syncDone.add(evt.syncType);
      // All seen sync types reported complete → we're done.
      if (syncSeen.size > 0 && [...syncSeen].every((t) => syncDone.has(t))) {
        finish("sync-complete");
      }
    });
    setTimeout(() => finish("timeout"), maxWaitSec * 1000);
  });

  const finishReason = await done;
  await new Promise((r) => setTimeout(r, 500)); // drain trailing events
  sock.end();

  // Persist the entire sync to a cache file. WhatsApp's history-sync only
  // fires once per pair; if the user's name filter doesn't match, we don't
  // want to throw away the sync — re-pairing costs a QR scan. Future
  // fetch-history runs can hydrate from this cache instead of re-syncing.
  const fs = await import("node:fs/promises");
  const cacheDir = join(TOKENS_DIR, "whatsapp-cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, `sync-${Date.now()}.json`);
  const cacheBody = {
    captured_at_ms: Date.now(),
    sync_finish: finishReason,
    sync_types_complete: [...syncDone],
    chats: [...chatsByJid.values()],
    contacts: [...contactsByJid.values()],
    messages_by_jid: Object.fromEntries(
      [...messagesByJid.entries()].map(([jid, bucket]) => [jid, [...bucket.values()]]),
    ),
  };
  await fs.writeFile(cachePath, JSON.stringify(cacheBody), { mode: 0o600 });
  console.error(
    `[cache] wrote raw sync to ${cachePath} ` +
      `(${chatsByJid.size} chats, ${messagesByJid.size} message-buckets)`,
  );

  // Build display-name resolver: prefer chat.name → contact.name/notify/verifiedName → pushName from any message → jid.
  const nameForJid = (jid) => {
    const fromChat = chatsByJid.get(jid)?.name;
    if (fromChat) return fromChat;
    const c = contactsByJid.get(jid);
    if (c?.name) return c.name;
    if (c?.notify) return c.notify;
    if (c?.verifiedName) return c.verifiedName;
    const bucket = messagesByJid.get(jid);
    if (bucket) {
      for (const m of bucket.values()) {
        if (m.pushName) return m.pushName;
      }
    }
    return null;
  };

  // No selector → chat picker mode.
  if (!args.name && !args.jid) {
    const allJids = new Set([
      ...chatsByJid.keys(),
      ...messagesByJid.keys(),
      ...contactsByJid.keys(),
    ]);
    const rows = [...allJids].map((jid) => {
      const bucket = messagesByJid.get(jid);
      const msgs = bucket ? [...bucket.values()] : [];
      // Newest message's text preview for human identification — many of these
      // chats have no saved name and only a phone-number JID.
      msgs.sort((a, b) => {
        const ta = typeof a.messageTimestamp === "number" ? a.messageTimestamp : a.messageTimestamp?.toNumber?.() ?? 0;
        const tb = typeof b.messageTimestamp === "number" ? b.messageTimestamp : b.messageTimestamp?.toNumber?.() ?? 0;
        return tb - ta;
      });
      const newest = msgs[0];
      const preview = newest ? (extractText(newest) ?? `[${classifyMessage(newest)}]`) : null;
      const pushNames = [...new Set(msgs.map((m) => m.pushName).filter(Boolean))];
      return {
        jid,
        name: nameForJid(jid),
        push_names: pushNames,
        message_count: bucket?.size ?? 0,
        last_preview: preview ? preview.slice(0, 80) : null,
      };
    });
    // DMs end @s.whatsapp.net, groups @g.us, newsletters @newsletter. Keep DMs+groups, drop the rest by default.
    const filtered = rows.filter(
      (r) => r.jid.endsWith("@s.whatsapp.net") || r.jid.endsWith("@g.us"),
    );
    filtered.sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
    console.log(
      JSON.stringify(
        { sync_finish: finishReason, sync_types_complete: [...syncDone], chats: filtered },
        null,
        2,
      ),
    );
    return;
  }

  // Resolve target JID.
  let targetJid = args.jid;
  if (!targetJid) {
    const needle = String(args.name).toLowerCase();
    const allJids = new Set([
      ...chatsByJid.keys(),
      ...messagesByJid.keys(),
      ...contactsByJid.keys(),
    ]);
    const candidates = [];
    for (const jid of allJids) {
      const n = nameForJid(jid);
      if (n && n.toLowerCase().includes(needle)) {
        candidates.push({ jid, name: n, message_count: messagesByJid.get(jid)?.size ?? 0 });
      }
    }
    if (candidates.length === 0) {
      console.error(
        `No chat matched name "${args.name}". Run without --name/--jid to see the picker.`,
      );
      console.error(
        `Sync finish reason: ${finishReason}. Total chats seen: ${chatsByJid.size}, with messages: ${messagesByJid.size}.`,
      );
      process.exit(3);
    }
    if (candidates.length > 1) {
      console.error(`Multiple chats matched "${args.name}":`);
      console.error(JSON.stringify(candidates, null, 2));
      console.error("Re-run with --jid <one of the above> to disambiguate.");
      process.exit(3);
    }
    targetJid = candidates[0].jid;
  }

  const bucket = messagesByJid.get(targetJid) ?? new Map();
  const messages = [...bucket.values()]
    .map((m) => ({
      id: m.key?.id ?? null,
      from_me: !!m.key?.fromMe,
      author: m.key?.participant ?? null,
      timestamp_ms:
        typeof m.messageTimestamp === "number"
          ? m.messageTimestamp * 1000
          : m.messageTimestamp?.toNumber
            ? m.messageTimestamp.toNumber() * 1000
            : null,
      push_name: m.pushName ?? null,
      type: classifyMessage(m),
      text: extractText(m),
    }))
    .sort((a, b) => (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0));

  const dump = {
    jid: targetJid,
    name: nameForJid(targetJid),
    sync_finish: finishReason,
    sync_types_complete: [...syncDone],
    message_count: messages.length,
    messages,
  };
  const json = JSON.stringify(dump, null, 2);
  if (args.out) {
    await import("node:fs/promises").then((fs) => fs.writeFile(args.out, json, { mode: 0o600 }));
    console.error(`Wrote ${messages.length} messages to ${args.out}`);
  } else {
    console.log(json);
  }
}

/**
 * Request an on-demand history backfill for a specific chat.
 *
 * Mechanism: Baileys' `fetchMessageHistory` sends a `historySyncOnDemandRequest`
 * peer-data-operation to the user's phone. The phone is the source of truth
 * for chat history — when it receives the request, it pushes the requested
 * window back via a `messaging-history.set` event with `syncType=ON_DEMAND`.
 *
 * This is how WhatsApp Web populates chats you scroll into on a freshly
 * linked device. The protocol expects an anchor (chatJid + an "oldest known"
 * message key + timestamp), and returns N messages strictly older than that.
 *
 * For first-time pulls where we have no real anchor, we pass:
 *   - oldestMsgTimestampMs: now()    "anything older than right now"
 *   - oldestMsgId:          synthetic via generateMessageID()
 *   - oldestMsgFromMe:      false    (defaults; doesn't matter when no real anchor exists)
 *
 * Empirical: the phone seems to ignore the synthetic id and use the
 * timestamp as the upper-bound cursor. If this changes in a future WhatsApp
 * server update, this command may need to fall back to a real anchor.
 *
 *   --jid <jid>      Required if --phone not given. e.g. 61423934713@s.whatsapp.net
 *   --phone <num>    Resolve a phone number to JID via onWhatsApp() first.
 *   --count <n>      Messages to request (default 200; WhatsApp caps somewhere).
 *   --max-wait <s>   How long to listen for the ON_DEMAND response (default 60s).
 *   --out PATH       Write JSON dump to file (mode 0600) instead of stdout.
 */
async function cmdRequestHistory(args) {
  if (!args.jid && !args.phone) {
    console.error("Usage: request-history --jid <jid> | --phone <number> [--count N] [--max-wait S] [--out PATH]");
    process.exit(2);
  }
  const count = Number(args.count ?? 200);
  const maxWaitSec = Number(args["max-wait"] ?? 60);

  const watcherPid = await readWatcherPid();
  if (watcherPid) failIfWatcherRunningSync(watcherPid, "request-history");

  const sock = await openSocket();

  let targetJid = args.jid;
  if (!targetJid) {
    const phone = String(args.phone).replace(/\D/g, "");
    const results = await sock.onWhatsApp(phone);
    if (!results || results.length === 0 || !results[0]?.exists) {
      console.error(`Phone ${phone} is not on WhatsApp (or onWhatsApp lookup failed).`);
      sock.end();
      process.exit(3);
    }
    targetJid = results[0].jid;
    console.error(`Resolved ${phone} → ${targetJid}`);
  }

  // Collect messages that arrive via either on-demand history sync, or live
  // messages.upsert during the wait window (the phone sometimes mixes both).
  const messagesById = new Map();
  const recordMessage = (m) => {
    if (m?.key?.remoteJid !== targetJid) return;
    const k = `${m.key.id}|${m.key.fromMe ? "me" : "them"}`;
    if (!messagesById.has(k)) messagesById.set(k, m);
  };

  let onDemandSeen = false;
  sock.ev.on("messaging-history.set", (evt) => {
    if (process.env.WHATSAPP_DEBUG) {
      console.error(
        `[history.set] syncType=${evt.syncType} messages=${evt.messages?.length ?? 0} progress=${evt.progress}`,
      );
    }
    // syncType 6 = ON_DEMAND per proto enum. We accept any syncType though —
    // if the phone delivers the messages via a different bucket, still take them.
    if (evt.syncType === 6) onDemandSeen = true;
    for (const m of evt.messages ?? []) recordMessage(m);
  });
  sock.ev.on("messages.upsert", (evt) => {
    for (const m of evt.messages ?? []) recordMessage(m);
  });

  const anchorKey = {
    remoteJid: targetJid,
    fromMe: false,
    id: generateMessageID(),
  };
  console.error(
    `Sending historySyncOnDemandRequest: jid=${targetJid} count=${count} anchorTs=now anchorId=${anchorKey.id}`,
  );
  const requestId = await sock.fetchMessageHistory(count, anchorKey, Date.now());
  console.error(`Request sent. peer_data_operation_request_id=${requestId}`);
  console.error(`Listening up to ${maxWaitSec}s for response…`);

  // Wait either for ON_DEMAND completion signal, or timeout.
  const finishReason = await new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    sock.ev.on("messaging-history.status", (evt) => {
      if (process.env.WHATSAPP_DEBUG) {
        console.error(`[history.status] syncType=${evt.syncType} status=${evt.status}`);
      }
      if (evt.syncType === 6 && evt.status === "complete") finish("on-demand-complete");
    });
    setTimeout(() => finish("timeout"), maxWaitSec * 1000);
  });

  // Brief drain for trailing events after status fires.
  await new Promise((r) => setTimeout(r, 1000));
  sock.end();

  const messages = [...messagesById.values()]
    .map((m) => ({
      id: m.key?.id ?? null,
      from_me: !!m.key?.fromMe,
      author: m.key?.participant ?? null,
      timestamp_ms:
        typeof m.messageTimestamp === "number"
          ? m.messageTimestamp * 1000
          : m.messageTimestamp?.toNumber
            ? m.messageTimestamp.toNumber() * 1000
            : null,
      push_name: m.pushName ?? null,
      type: classifyMessage(m),
      text: extractText(m),
    }))
    .sort((a, b) => (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0));

  const dump = {
    jid: targetJid,
    finish_reason: finishReason,
    on_demand_response_seen: onDemandSeen,
    request_id: requestId,
    message_count: messages.length,
    messages,
  };
  const json = JSON.stringify(dump, null, 2);
  if (args.out) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(args.out, json, { mode: 0o600 });
    console.error(
      `Wrote ${messages.length} messages to ${args.out} (finish=${finishReason}, on_demand_seen=${onDemandSeen})`,
    );
  } else {
    console.log(json);
  }
}

/**
 * Long-running watcher: appends every captured DM event to an NDJSON log.
 *
 * Why NDJSON (one JSON object per line, append-only):
 *   - Survives crashes mid-write — each line is atomic at the OS level for
 *     reasonable line lengths (<PIPE_BUF, ~4KB on macOS).
 *   - Easy for any consumer to tail and parse incrementally.
 *   - Append-only avoids race conditions with the love_agent extractor that
 *     materializes per-chat corpus JSONs from this stream.
 *
 * What we capture (DMs only — see scope flag):
 *   - messages.upsert (new messages, both inbound and outbound)
 *   - messages.update (edits, reactions, deletions, status changes)
 *   - chats.upsert / contacts.upsert (display-name resolution)
 *
 * Reconnection strategy: on close, log the reason, then exponential backoff
 * (1s, 2s, 4s, 8s, capped at 60s) and reopen via the existing openSocket()
 * loop. Auth state persists in ~/git/tools/cli-tools/.tokens/whatsapp/.
 *
 * Lifecycle: SIGINT/SIGTERM → graceful shutdown (flush, end socket, exit 0).
 *
 *   --log PATH      Override the NDJSON log path (default ~/.whatsapp.messages/wa-events.ndjson).
 *   --include-groups   Also capture group chats (@g.us). Default: DMs only.
 */
async function cmdWatch(args) {
  const includeGroups = !!args["include-groups"];
  const logPath =
    args.log ?? join(homedir(), ".whatsapp.messages", "wa-events.ndjson");

  const fs = await import("node:fs/promises");
  const { createWriteStream } = await import("node:fs");
  await fs.mkdir(join(homedir(), ".whatsapp.messages"), { recursive: true, mode: 0o700 });
  // Touch + chmod to 600 so the perms are set even if the file already exists.
  await fs.writeFile(logPath, "", { flag: "a", mode: 0o600 });
  await fs.chmod(logPath, 0o600);

  // Publish our PID so other subcommands detect that we hold the single socket and
  // route through the broker instead of opening a colliding one. Written early,
  // before the socket opens, so there's no window where we're live but undetected.
  // Removed on every exit path via removePidFile().
  await fs.mkdir(WA_HOME, { recursive: true, mode: 0o700 });
  await fs.mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(WATCH_PID_PATH, String(process.pid), { mode: 0o600 });
  const removePidFile = () => {
    try {
      unlinkSync(WATCH_PID_PATH);
    } catch {
      // already gone — fine
    }
  };

  // Open in append mode; we re-create the stream after each reconnect just to
  // be safe against unflushed buffers on socket errors.
  let logStream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  const writeEvent = (obj) => {
    logStream.write(JSON.stringify(obj) + "\n");
  };

  const isCapturedJid = (jid) => {
    if (!jid) return false;
    // DMs come in two flavours since WhatsApp's LID rollout:
    //   <phone>@s.whatsapp.net  — legacy phone-number JIDs
    //   <lid>@lid               — handle-based identity (newer; replaces s.whatsapp.net
    //                             for users who've enabled LID privacy or whose
    //                             account is shaped that way server-side).
    // Both represent 1:1 DMs. Newsletters use @newsletter and broadcast lists
    // @broadcast — we drop those.
    if (jid.endsWith("@s.whatsapp.net")) return true;
    if (jid.endsWith("@lid")) return true;
    if (includeGroups && jid.endsWith("@g.us")) return true;
    return false;
  };

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[watch] received ${sig}, shutting down…`);
    removePidFile();
    logStream.end(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // An uncaught error inside a Baileys event handler will otherwise stall the
  // event loop silently. Crash hard so launchd (or the foreground caller)
  // can restart us with fresh state.
  process.on("uncaughtException", (err) => {
    writeEvent({ t: Date.now(), event: "uncaught_exception", message: String(err?.stack ?? err) });
    console.error(`[watch] uncaughtException: ${err?.stack ?? err}`);
    removePidFile();
    logStream.end(() => process.exit(3));
  });
  process.on("unhandledRejection", (reason) => {
    writeEvent({ t: Date.now(), event: "unhandled_rejection", message: String(reason) });
    console.error(`[watch] unhandledRejection: ${reason}`);
    removePidFile();
    logStream.end(() => process.exit(3));
  });

  // Heartbeat to log so we can see the watcher is alive in tail -f.
  // NOT unref'd — we want it to keep the event loop alive even if the socket
  // FD enters a half-closed state where Node thinks there's nothing else to do.
  // The heartbeat ALSO touches the watchdog: a healthy-but-idle socket (e.g.
  // overnight, when no DMs arrive) must not be torn down. Without this touch
  // the 10-min watchdog kills a perfectly good connection during quiet periods,
  // and the resulting reconnect storm gets us throttled by WhatsApp (408/428).
  setInterval(() => {
    // `connected` distinguishes a live socket from an alive-but-wedged process
    // (openSocket never reaching 'open' leaves watchdogSock null). The external
    // watch-the-watcher probe keys off the newest heartbeat where connected=true;
    // without this flag a wedged watcher still emits heartbeats and looks healthy.
    writeEvent({ t: Date.now(), event: "heartbeat", connected: !!watchdogSock });
    touch();
  }, 5 * 60 * 1000);

  // Watchdog: track the last event of any kind. If nothing arrives for
  // WATCHDOG_TIMEOUT_MS, the socket is presumed dead (silent TCP half-close,
  // NAT timeout, etc) and we tear it down so the outer reconnect loop runs.
  // Heartbeats keep `lastEventAt` fresh during quiet periods.
  const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000;
  let lastEventAt = Date.now();
  const touch = () => {
    lastEventAt = Date.now();
  };
  let watchdogSock = null;
  setInterval(() => {
    if (Date.now() - lastEventAt > WATCHDOG_TIMEOUT_MS && watchdogSock) {
      writeEvent({ t: Date.now(), event: "watchdog_kick", silent_for_ms: Date.now() - lastEventAt });
      console.error("[watch] watchdog kick — no events received, forcing reconnect");
      try {
        watchdogSock.end();
      } catch {
        // best effort
      }
      watchdogSock = null;
      lastEventAt = Date.now(); // give the reconnect a window
    }
  }, 60 * 1000);

  // Outbox drainer. A second process (e.g. wa-msngr) CANNOT open its own
  // socket to send: a second socket on the same device creds triggers WhatsApp's
  // connectionReplaced (code 440) and BOTH sockets stall. So instead, senders
  // append newline-delimited {to,text} JSON jobs to wa-outbox.ndjson and we drain
  // them here over the ONE live socket the watcher already owns. Atomic rename to
  // .inflight captures a batch without racing the appender; failed sends are
  // re-queued for the next tick.
  const outboxPath = join(homedir(), ".whatsapp.messages", "wa-outbox.ndjson");
  let draining = false;
  setInterval(async () => {
    if (draining || !watchdogSock) return; // no batch work without a live socket
    draining = true;
    const inflight = outboxPath + ".inflight";
    try {
      try {
        await fs.rename(outboxPath, inflight);
      } catch (e) {
        if (e.code === "ENOENT") return; // nothing queued
        throw e;
      }
      const raw = await fs.readFile(inflight, "utf8");
      const failed = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let job;
        try { job = JSON.parse(line); } catch { continue; }
        if (!job.to || !job.text) continue;
        try {
          const res = await watchdogSock.sendMessage(job.to, { text: String(job.text) });
          touch();
          writeEvent({ t: Date.now(), event: "outbox_sent", jid: job.to, id: res?.key?.id ?? null });
        } catch (err) {
          writeEvent({ t: Date.now(), event: "outbox_error", jid: job.to, message: String(err?.message ?? err) });
          failed.push(line);
        }
      }
      await fs.unlink(inflight).catch(() => {});
      if (failed.length) await fs.appendFile(outboxPath, failed.join("\n") + "\n", { mode: 0o600 });
    } catch (err) {
      writeEvent({ t: Date.now(), event: "outbox_drain_error", message: String(err?.message ?? err) });
    } finally {
      draining = false;
    }
  }, 2000);

  // Jobs drainer — the request/response sibling of the outbox. CLI subcommands
  // that need a result (send, list-groups, rename-group) drop <id>.req.json into
  // JOBS_DIR; we claim each (rename → .req.inflight so a partial write or a second
  // drainer can't double-run it), execute it on the ONE live socket via runJob,
  // and write <id>.res.json for the client to collect. Requests whose client
  // deadline has passed are dropped unrun. Orphan responses (client gave up after
  // we'd answered) are reaped after 5 minutes.
  let jobsDraining = false;
  setInterval(async () => {
    if (jobsDraining || !watchdogSock) return; // need a live socket to run jobs
    jobsDraining = true;
    try {
      let entries;
      try {
        entries = await fs.readdir(JOBS_DIR);
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      const now = Date.now();
      for (const f of entries.sort()) {
        // Reap stale responses the client never collected.
        if (f.endsWith(".res.json")) {
          const p = join(JOBS_DIR, f);
          try {
            const st = await fs.stat(p);
            if (now - st.mtimeMs > 5 * 60 * 1000) await fs.unlink(p).catch(() => {});
          } catch {
            // gone — fine
          }
          continue;
        }
        if (!f.endsWith(".req.json")) continue;
        if (!watchdogSock) break; // socket dropped mid-batch; resume next tick
        const reqPath = join(JOBS_DIR, f);
        const inflight = reqPath + ".inflight";
        try {
          await fs.rename(reqPath, inflight); // atomic claim
        } catch {
          continue; // someone else claimed it / it vanished
        }
        let job;
        try {
          job = JSON.parse(await fs.readFile(inflight, "utf8"));
        } catch {
          await fs.unlink(inflight).catch(() => {});
          continue;
        }
        // Client already timed out → don't bother running it.
        if (job.deadline_ms && Date.now() > job.deadline_ms) {
          await fs.unlink(inflight).catch(() => {});
          writeEvent({ t: Date.now(), event: "job_expired", kind: job.kind });
          continue;
        }
        let result = null;
        let error = null;
        try {
          result = await runJob(job, watchdogSock);
          touch();
        } catch (err) {
          error = String(err?.message ?? err);
        }
        const resTmp = join(JOBS_DIR, `${job.id}.res.tmp`);
        const resFinal = join(JOBS_DIR, `${job.id}.res.json`);
        try {
          await fs.writeFile(resTmp, JSON.stringify({ id: job.id, result, error }), { mode: 0o600 });
          await fs.rename(resTmp, resFinal);
        } catch (err) {
          writeEvent({ t: Date.now(), event: "job_response_error", kind: job.kind, message: String(err?.message ?? err) });
        }
        await fs.unlink(inflight).catch(() => {});
        writeEvent({ t: Date.now(), event: "job_done", kind: job.kind, error: error ?? undefined });
      }
    } catch (err) {
      writeEvent({ t: Date.now(), event: "jobs_drain_error", message: String(err?.message ?? err) });
    } finally {
      jobsDraining = false;
    }
  }, 500);

  let attempt = 0;
  let rateLimitStrikes = 0;
  while (!shuttingDown) {
    // Creds-gate: a watcher with no pairable credentials can NEVER connect, so
    // every dial would be pure server-poking (this exact loop, credential-less,
    // is what earned the July 428 block). Fail closed and wait for a human
    // QR re-pair (`whatsapp auth`) — pairing is auth's job, never the watcher's.
    // Missing file and registered:false are the two known-doomed states; an
    // unrecognised creds shape falls through to a normal dial.
    let gateCreds = null;
    try {
      gateCreds = JSON.parse(await readFile(join(AUTH_DIR, "creds.json"), "utf8"));
    } catch {}
    if (!gateCreds || gateCreds.registered === false) {
      writeEvent({ t: Date.now(), event: "pairing_required" });
      console.error(
        "[watch] no registered credentials — QR re-pair needed (`whatsapp auth`). " +
          "Exiting without dialing; retrying cannot succeed.",
      );
      removePidFile();
      logStream.end(() => process.exit(3));
      return;
    }
    try {
      console.error(`[watch] opening socket (attempt ${attempt + 1})…`);
      const sock = await openSocket();
      // Do NOT reset `attempt` here. A socket that reaches 'open' and then drops
      // within seconds (WhatsApp 408/428) would otherwise reset the backoff every
      // cycle, pinning us to the 1000ms floor and hammering the server — which is
      // itself what triggers the throttling. We only reset once the socket has
      // proven stable (held open ≥ STABLE_RESET_MS); see the close handler below.
      const openedAt = Date.now();
      watchdogSock = sock;
      touch();
      writeEvent({ t: Date.now(), event: "connected" });
      rateLimitStrikes = 0;

      sock.ev.on("messages.upsert", (evt) => {
        touch();
        for (const m of evt.messages ?? []) {
          const jid = m?.key?.remoteJid;
          if (!isCapturedJid(jid)) continue;
          const type = classifyMessage(m);
          const id = m.key?.id ?? null;
          const fromMe = !!m.key?.fromMe;
          writeEvent({
            t: Date.now(),
            event: "message",
            upsert_type: evt.type, // 'notify' = new, 'append' = backfill/history
            jid,
            id,
            from_me: fromMe,
            timestamp_ms:
              typeof m.messageTimestamp === "number"
                ? m.messageTimestamp * 1000
                : m.messageTimestamp?.toNumber
                  ? m.messageTimestamp.toNumber() * 1000
                  : null,
            push_name: m.pushName ?? null,
            type,
            text: extractText(m),
            // Signal that bytes are coming via a follow-up "media" event so the
            // love_agent extractor can join on id without blocking on download.
            media_pending: MEDIA_TYPES.has(type) || undefined,
          });
          // Media arrives as encrypted keys, not bytes. Download asynchronously so
          // a slow CDN fetch never stalls the event handler, then emit a "media"
          // event carrying the on-disk path (or "media_error" on failure).
          if (MEDIA_TYPES.has(type)) {
            const mediaDir = join(homedir(), ".whatsapp.messages", "wa-media", jidToDir(jid));
            downloadMediaToDir(sock, m, mediaDir, type)
              .then((mediaPath) => {
                if (mediaPath) {
                  writeEvent({ t: Date.now(), event: "media", jid, id, from_me: fromMe, type, media_path: mediaPath });
                  console.error(`[watch] media saved: ${mediaPath}`);
                }
              })
              .catch((err) => {
                writeEvent({ t: Date.now(), event: "media_error", jid, id, type, message: String(err?.message ?? err) });
                console.error(`[watch] media download failed (${type} ${id}): ${err?.message ?? err}`);
              });
          }
        }
      });

      sock.ev.on("messages.update", (updates) => {
        touch();
        for (const u of updates ?? []) {
          if (!isCapturedJid(u.key?.remoteJid)) continue;
          writeEvent({
            t: Date.now(),
            event: "message_update",
            jid: u.key.remoteJid,
            id: u.key.id,
            from_me: !!u.key.fromMe,
            update: u.update ?? null,
          });
        }
      });

      sock.ev.on("contacts.upsert", (contacts) => {
        touch();
        for (const c of contacts ?? []) {
          if (!isCapturedJid(c.id)) continue;
          writeEvent({
            t: Date.now(),
            event: "contact",
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            verified_name: c.verifiedName ?? null,
          });
        }
      });

      sock.ev.on("chats.upsert", (chats) => {
        touch();
        for (const c of chats ?? []) {
          if (!isCapturedJid(c.id)) continue;
          writeEvent({
            t: Date.now(),
            event: "chat",
            jid: c.id,
            name: c.name ?? null,
          });
        }
      });

      // Block until the socket closes; openSocket() resolves on 'open', so we
      // wait here on a fresh promise that observes the next close event.
      // Any update event also touches the watchdog so a quiet-but-healthy
      // socket doesn't get kicked unnecessarily.
      const closeReason = await new Promise((resolve) => {
        sock.ev.on("connection.update", (update) => {
          touch();
          if (update.connection === "close") {
            resolve(update.lastDisconnect?.error?.output?.statusCode ?? "unknown");
          }
        });
      });
      watchdogSock = null;
      // A socket that stayed open long enough to be considered healthy resets the
      // backoff so the NEXT genuine disconnect reconnects promptly. A flapping
      // socket (dropped almost immediately) does NOT reset, so `attempt` keeps
      // climbing and the backoff escalates toward the 60s cap instead of hammering.
      const STABLE_RESET_MS = 60 * 1000;
      if (Date.now() - openedAt >= STABLE_RESET_MS) attempt = 0;
      writeEvent({ t: Date.now(), event: "disconnected", code: closeReason });
      console.error(`[watch] disconnected: code=${closeReason}`);
    } catch (err) {
      writeEvent({ t: Date.now(), event: "error", message: String(err?.message ?? err) });
      console.error(`[watch] error: ${err?.message ?? err}`);
      const errMsg = String(err?.message ?? "");
      if (errMsg.includes("Terminal disconnect")) {
        console.error("[watch] terminal failure (logged out?). Exiting — re-auth required.");
        removePidFile();
        logStream.end(() => process.exit(2));
        return;
      }
      // Rate-limit circuit breaker. Retrying into a 428 (or its local cooldown)
      // on the generic 60s backoff is what turns a soft-block into a standing
      // one — each attempt resets WhatsApp's timer. Instead: sleep out the full
      // cooldown (+jitter), and after 3 consecutive strikes stop entirely and
      // hand off to the watchdog/human.
      if (errMsg.startsWith("WhatsApp rate-limit")) {
        rateLimitStrikes++;
        if (rateLimitStrikes >= 3) {
          writeEvent({ t: Date.now(), event: "rate_limit_giveup", strikes: rateLimitStrikes });
          console.error(
            "[watch] rate-limited 3 times in a row — exiting rather than extending the block. " +
              "Wait for quiet time, then restart the watcher.",
          );
          removePidFile();
          logStream.end(() => process.exit(2));
          return;
        }
        let until = Date.now() + COOLDOWN_MS;
        try {
          const v = Number(await readFile(COOLDOWN_FILE, "utf8"));
          if (Number.isFinite(v)) until = Math.max(until, v);
        } catch {}
        const wait = Math.max(60_000, until - Date.now()) + Math.round(Math.random() * 120_000);
        console.error(
          `[watch] rate-limited (strike ${rateLimitStrikes}/3) — sleeping ${Math.round(wait / 60000)} min for the cooldown to clear`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
    }
    // Exponential backoff, capped, with full jitter. Jitter de-synchronises the
    // reconnect cadence so we don't present WhatsApp with a metronomic 1s/2s/4s
    // pattern (which reads as abusive and earns 428s); each delay is a random
    // point in [base/2, base].
    const base = Math.min(60000, 1000 * 2 ** attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    attempt++;
    console.error(`[watch] reconnecting in ${delay}ms…`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

/**
 * Walk the NDJSON event log to find the oldest captured message for a JID.
 * Returns null if no message events exist for that jid.
 */
async function findOldestMessageForJid(jid) {
  const fs = await import("node:fs/promises");
  const readline = await import("node:readline");
  const { createReadStream } = await import("node:fs");
  const logPath = join(homedir(), ".whatsapp.messages", "wa-events.ndjson");
  try {
    await fs.stat(logPath);
  } catch {
    return null;
  }
  const rl = readline.createInterface({ input: createReadStream(logPath, { encoding: "utf8" }) });
  let oldest = null;
  for await (const line of rl) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.event !== "message" || e.jid !== jid || !e.id || e.timestamp_ms == null) continue;
      if (!oldest || e.timestamp_ms < oldest.timestamp_ms) oldest = e;
    } catch {
      // ignore corrupt lines
    }
  }
  return oldest;
}

/**
 * Backfill: pull WhatsApp history older than the NDJSON log's earliest message
 * for one chat, looping until the phone runs out.
 *
 * Mechanism (different from request-history's first try): instead of passing a
 * synthetic anchor key (which the phone validates and silently rejects), we
 * read the oldest message we ALREADY captured live and use its real key as
 * the anchor. The phone honors the request, returns ≤batch-size messages
 * strictly older than the anchor via `messaging-history.set syncType=ON_DEMAND`,
 * we record the new oldest, and loop.
 *
 * We append the recovered messages back to the same NDJSON log the watcher
 * writes to, with `upsert_type: "backfill"`. The love_agent extractor's
 * dedupe-by-(id, from_me) will merge them with live capture cleanly.
 *
 *   --jid <jid>            Target chat JID (e.g. 263303154667751@lid).
 *   --phone <num>          Alternative: resolve via onWhatsApp() first.
 *   --batch-size <n>       Messages per request (default 200; phone caps at ~50-200).
 *   --max-iterations <n>   Safety stop. Default 50 (= up to 10k messages).
 *   --max-wait <s>         Per-iteration timeout. Default 30s.
 */
async function cmdBackfill(args) {
  if (!args.jid && !args.phone) {
    console.error("Usage: backfill --jid <jid> | --phone <number> [--batch-size N] [--max-iterations N]");
    process.exit(2);
  }
  const batchSize = Number(args["batch-size"] ?? 200);
  const maxIterations = Number(args["max-iterations"] ?? 50);
  const maxWaitSec = Number(args["max-wait"] ?? 30);

  const watcherPid = await readWatcherPid();
  if (watcherPid) failIfWatcherRunningSync(watcherPid, "backfill");

  const sock = await openSocket();

  let targetJid = args.jid;
  if (!targetJid) {
    const phone = String(args.phone).replace(/\D/g, "");
    const results = await sock.onWhatsApp(phone);
    if (!results || results.length === 0 || !results[0]?.exists) {
      console.error(`Phone ${phone} is not on WhatsApp.`);
      sock.end();
      process.exit(3);
    }
    targetJid = results[0].jid;
    console.error(`Resolved ${phone} → ${targetJid}`);
  }

  // Append helper writes directly to the watcher's log file. Open in 'a' mode
  // so we don't race with a concurrent watcher (we instruct the user to stop
  // the watcher first, but defense in depth).
  const fs = await import("node:fs/promises");
  const logPath = join(homedir(), ".whatsapp.messages", "wa-events.ndjson");
  await fs.mkdir(join(homedir(), ".whatsapp.messages"), { recursive: true, mode: 0o700 });
  const { createWriteStream } = await import("node:fs");
  const out = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  const append = (obj) => out.write(JSON.stringify(obj) + "\n");

  // Find the starting anchor from the existing log.
  let anchor = await findOldestMessageForJid(targetJid);
  if (!anchor) {
    console.error(`No captured messages for ${targetJid} in the log yet. Run \`watch\` long enough to capture at least one live message before backfilling.`);
    sock.end();
    process.exit(3);
  }
  console.error(
    `Starting anchor: id=${anchor.id} ts=${new Date(anchor.timestamp_ms).toISOString()} from_me=${anchor.from_me}`,
  );

  // Each iteration: send a fetchMessageHistory PDO, collect any messages that
  // arrive within max-wait seconds, pick the new oldest, log, loop.
  let totalRecovered = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    const received = [];
    const recordIfTargetChat = (m) => {
      if (m?.key?.remoteJid !== targetJid) return;
      received.push(m);
    };

    const offSet = sock.ev.on("messaging-history.set", (evt) => {
      for (const m of evt.messages ?? []) recordIfTargetChat(m);
    });
    const offUpsert = sock.ev.on("messages.upsert", (evt) => {
      // ON_DEMAND backfill sometimes arrives via the upsert channel with
      // type='append'. Accept both.
      for (const m of evt.messages ?? []) recordIfTargetChat(m);
    });

    const anchorKey = {
      remoteJid: targetJid,
      fromMe: !!anchor.from_me,
      id: anchor.id,
    };
    const anchorTs = anchor.timestamp_ms;
    try {
      const reqId = await sock.fetchMessageHistory(batchSize, anchorKey, anchorTs);
      console.error(`[iter ${iter + 1}] sent request, peer_op_id=${reqId}`);
    } catch (err) {
      console.error(`[iter ${iter + 1}] fetchMessageHistory failed: ${err?.message ?? err}`);
      break;
    }

    // Wait for the on-demand response. Resolves when status=complete arrives
    // for syncType=6, OR max-wait elapses.
    const finishReason = await new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      const offStatus = sock.ev.on("messaging-history.status", (evt) => {
        if (evt.syncType === 6 && evt.status === "complete") finish("complete");
      });
      setTimeout(() => finish("timeout"), maxWaitSec * 1000);
    });

    // Brief drain so trailing chunks in the same batch arrive.
    await new Promise((r) => setTimeout(r, 500));
    // Unregister listeners — Baileys' .on returns the socket, not an off-handle,
    // so we use removeListener through the EventEmitter API.
    // (No leak in practice — sock is torn down at the end.)

    // Dedupe received messages by id+fromMe (some come via both channels).
    const seen = new Set();
    const fresh = [];
    for (const m of received) {
      const k = `${m.key?.id}|${m.key?.fromMe ? "me" : "them"}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // Drop the anchor itself if the phone returns it.
      if (m.key?.id === anchor.id && !!m.key?.fromMe === !!anchor.from_me) continue;
      fresh.push(m);
    }

    if (fresh.length === 0) {
      console.error(`[iter ${iter + 1}] no new messages returned (finish=${finishReason}). Stopping.`);
      break;
    }

    // Write each as a normal "message" event with upsert_type "backfill" so
    // it's distinguishable in the log but the extractor treats it identically.
    let newOldest = anchor;
    for (const m of fresh) {
      const tsMs =
        typeof m.messageTimestamp === "number"
          ? m.messageTimestamp * 1000
          : m.messageTimestamp?.toNumber
            ? m.messageTimestamp.toNumber() * 1000
            : null;
      const evt = {
        t: Date.now(),
        event: "message",
        upsert_type: "backfill",
        jid: targetJid,
        id: m.key?.id ?? null,
        from_me: !!m.key?.fromMe,
        author: m.key?.participant ?? null,
        timestamp_ms: tsMs,
        push_name: m.pushName ?? null,
        type: classifyMessage(m),
        text: extractText(m),
      };
      append(evt);
      if (tsMs != null && tsMs < (newOldest.timestamp_ms ?? Infinity)) {
        newOldest = { id: evt.id, from_me: evt.from_me, timestamp_ms: tsMs };
      }
    }
    totalRecovered += fresh.length;
    console.error(
      `[iter ${iter + 1}] recovered ${fresh.length} messages; new oldest=${new Date(newOldest.timestamp_ms).toISOString()}`,
    );
    if (newOldest.timestamp_ms >= (anchor.timestamp_ms ?? 0)) {
      console.error("Anchor didn't move backward — phone returned only same-or-newer. Stopping.");
      break;
    }
    anchor = newOldest;
  }

  out.end();
  sock.end();
  console.error(`Done. Total recovered: ${totalRecovered} messages.`);
}

/**
 * Download media (images, video, audio, documents, stickers) for one chat.
 *
 * On-demand counterpart to the auto-download wired into `watch`. Opens a socket,
 * lets WhatsApp's history-sync push recent messages, then downloads every media
 * message for the target chat to --out-dir (default ~/.whatsapp.messages/wa-media/<jid>).
 *
 * IMPORTANT: a second socket on the same creds triggers WhatsApp's
 * connectionReplaced (440) and stalls BOTH — so STOP the `watch` daemon before
 * running this (same caveat as fetch-history/request-history/backfill). For
 * messages that arrive while `watch` is running, media auto-downloads already.
 */
async function cmdDownloadMedia(args) {
  const maxWaitSec = Number(args["max-wait"] ?? 60);
  const targetJid = args.jid ?? null;
  const nameFilter = args.name ? String(args.name).toLowerCase() : null;
  if (!targetJid && !nameFilter) {
    console.error('Usage: download-media --jid <jid> | --name <substr> [--out-dir PATH] [--max-wait <s>]');
    process.exit(2);
  }

  const watcherPid = await readWatcherPid();
  if (watcherPid) failIfWatcherRunningSync(watcherPid, "download-media");

  const sock = await openSocket();
  const fs = await import("node:fs/promises");

  // Collect messages + chat names during the sync window.
  const messagesByJid = new Map(); // jid -> Map<dedupeKey, WAMessage>
  const nameByJid = new Map();
  const record = (m) => {
    const jid = m?.key?.remoteJid;
    if (!jid) return;
    const bucket = messagesByJid.get(jid) ?? new Map();
    bucket.set(`${m.key?.id}|${m.key?.fromMe ? "me" : "them"}`, m);
    messagesByJid.set(jid, bucket);
  };
  sock.ev.on("messaging-history.set", (evt) => {
    for (const c of evt.chats ?? []) if (c.name) nameByJid.set(c.id, c.name);
    for (const m of evt.messages ?? []) record(m);
  });
  sock.ev.on("messages.upsert", (evt) => {
    for (const m of evt.messages ?? []) record(m);
  });

  await new Promise((r) => setTimeout(r, maxWaitSec * 1000));
  await new Promise((r) => setTimeout(r, 500));

  // Resolve the target chat.
  let jid = targetJid;
  if (!jid && nameFilter) {
    const hit = [...nameByJid.entries()].find(([, n]) => n.toLowerCase().includes(nameFilter));
    jid = hit?.[0] ?? null;
  }
  if (!jid) {
    sock.end();
    console.error(
      nameFilter
        ? `No chat matched name "${args.name}". Chats seen: ${[...nameByJid.values()].join(", ") || "(none)"}`
        : "No target chat resolved.",
    );
    process.exit(3);
  }

  const outDir = args["out-dir"] ?? join(homedir(), ".whatsapp.messages", "wa-media", jidToDir(jid));
  const bucket = messagesByJid.get(jid) ?? new Map();
  const mediaMsgs = [...bucket.values()].filter((m) => MEDIA_TYPES.has(classifyMessage(m)));

  const results = [];
  for (const m of mediaMsgs) {
    const kind = classifyMessage(m);
    try {
      const p = await downloadMediaToDir(sock, m, outDir, kind);
      if (p) {
        results.push({ id: m.key?.id ?? null, type: kind, path: p });
        console.error(`saved ${kind}: ${p}`);
      }
    } catch (err) {
      results.push({ id: m.key?.id ?? null, type: kind, error: String(err?.message ?? err) });
      console.error(`FAILED ${kind} ${m.key?.id}: ${err?.message ?? err}`);
    }
  }

  sock.end();
  console.log(
    JSON.stringify(
      { jid, out_dir: outDir, media_found: mediaMsgs.length, downloaded: results.filter((r) => r.path).length, results },
      null,
      2,
    ),
  );
}

async function cmdRenameGroup(args) {
  if (!args.to || !args.name) {
    console.error('Usage: rename-group --to <group-jid> --name "<new name>"');
    process.exit(2);
  }
  if (!args.to.endsWith("@g.us")) {
    console.error("--to must be a group JID (ends with @g.us)");
    process.exit(2);
  }
  if (await readWatcherPid()) {
    const result = await submitJob("rename-group", { to: args.to, name: String(args.name) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const sock = await openSocket();
  await sock.groupUpdateSubject(args.to, String(args.name));
  await new Promise((r) => setTimeout(r, 1500));
  sock.end();
  console.log(JSON.stringify({ renamed: args.to, new_name: args.name }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    help();
    return;
  }
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (sub) {
    case "auth":
      return cmdAuth();
    case "list-groups":
      return cmdListGroups();
    case "send":
      return cmdSend(args);
    case "rename-group":
      return cmdRenameGroup(args);
    case "fetch-history":
      return cmdFetchHistory(args);
    case "request-history":
      return cmdRequestHistory(args);
    case "watch":
      return cmdWatch(args);
    case "backfill":
      return cmdBackfill(args);
    case "download-media":
      return cmdDownloadMedia(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      help();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
