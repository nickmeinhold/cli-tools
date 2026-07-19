#!/usr/bin/env node
// wa-db — read WhatsApp history from the DESKTOP APP's local database.
//
// WHY: the native WhatsApp.app maintains the one Meta-blessed persistent
// session and mirrors every chat into an unencrypted Core Data sqlite at
//   ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
// Reading that file is pure local I/O — no Baileys socket, no reconnects,
// nothing WhatsApp's anti-abuse can see or 428-block. This replaces the
// `whatsapp watch` capture pipeline for READING. (Sending still needs a
// socket or UI automation — not this tool's job.)
//
// SAFETY: we NEVER open the live DB. Every command snapshots the sqlite (+WAL)
// to a private tmp dir first and queries the copy, so we cannot corrupt or
// lock the app's store. The snapshot also gives point-in-time consistency.
//
// PRIVACY: ChatStorage.sqlite contains ALL chats. `sync` only ever exports
// the JIDs you explicitly configure in ~/.whatsapp.messages/wa-db-sync.json.
//
// Subcommands:
//   list-chats                 chats with names, jids, message counts
//   read   --jid <jid> | --name <substr>  [--limit N] [--since YYYY-MM-DD] [--json]
//   sync                       append NEW messages for configured jids to
//                              ~/.whatsapp.messages/wa-events.ndjson in the
//                              watcher's event format (dedup by stanza id).
//                              Config: {"jids": ["...@g.us", ...]}
//
// Requires: sqlite3 CLI (macOS ships it). No npm deps.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, existsSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const LIVE_DB = join(
  homedir(),
  "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
);
const MSG_DIR = join(homedir(), ".whatsapp.messages");
const EVENTS_LOG = join(MSG_DIR, "wa-events.ndjson");
const SYNC_CONFIG = join(MSG_DIR, "wa-db-sync.json");
// Core Data stores dates as seconds since 2001-01-01 UTC.
const CORE_DATA_EPOCH = 978307200;

function usage(code = 0) {
  console.error(`wa-db — read WhatsApp history from the desktop app's local DB (no socket, un-blockable)

Usage:
  wa-db list-chats
  wa-db read (--jid <jid> | --name <substr>) [--limit N] [--since YYYY-MM-DD] [--json]
  wa-db sync                # export configured jids to wa-events.ndjson

sync config (${SYNC_CONFIG}):  {"jids": ["120363...@g.us"]}
The desktop WhatsApp app must be installed and signed in; it does the syncing.`);
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

/** Snapshot the live DB (+WAL/SHM) and return the copy's path + a cleanup fn. */
function snapshotDb() {
  if (!existsSync(LIVE_DB)) {
    console.error(
      `Error: WhatsApp desktop database not found at\n  ${LIVE_DB}\n` +
        `Is the native WhatsApp.app installed and signed in?`,
    );
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "wa-db-"));
  const copy = join(dir, "ChatStorage.sqlite");
  copyFileSync(LIVE_DB, copy);
  for (const ext of ["-wal", "-shm"]) {
    if (existsSync(LIVE_DB + ext)) copyFileSync(LIVE_DB + ext, copy + ext);
  }
  return { copy, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run a query against the snapshot, rows as JSON objects. */
function q(db, sql) {
  const out = execFileSync("sqlite3", ["-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : [];
}

const esc = (s) => String(s).replace(/'/g, "''");

function resolveJid(db, jidOpt, nameOpt) {
  if (jidOpt) return jidOpt;
  const rows = q(
    db,
    `SELECT ZCONTACTJID AS jid, ZPARTNERNAME AS name FROM ZWACHATSESSION
     WHERE ZPARTNERNAME LIKE '%${esc(nameOpt)}%' ORDER BY ZMESSAGECOUNTER DESC`,
  );
  if (!rows.length) {
    console.error(`No chat matching name "${nameOpt}". Try: wa-db list-chats`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`Ambiguous name "${nameOpt}" — matches:`);
    for (const r of rows) console.error(`  ${r.jid}  ${r.name}`);
    process.exit(1);
  }
  return rows[0].jid;
}

const MESSAGES_SQL = (jid, { sinceEpoch = null, limit = null } = {}) => `
  SELECT
    m.ZSTANZAID                                   AS stanza_id,
    CAST((m.ZMESSAGEDATE + ${CORE_DATA_EPOCH}) * 1000 AS INTEGER) AS timestamp_ms,
    m.ZISFROMME                                   AS from_me,
    COALESCE(NULLIF(gm.ZCONTACTNAME, ''),
             (SELECT NULLIF(p.ZPUSHNAME, '') FROM ZWAPROFILEPUSHNAME p
              WHERE p.ZJID = COALESCE(gm.ZMEMBERJID, m.ZFROMJID)),
             NULLIF(gm.ZFIRSTNAME, ''),
             -- m.ZPUSHNAME is protobuf junk for @lid senders; use it last and
             -- only when it doesn't look like base64 (no trailing '=').
             CASE WHEN m.ZPUSHNAME NOT LIKE '%=' THEN NULLIF(m.ZPUSHNAME, '') END,
             m.ZFROMJID) AS sender,
    COALESCE(gm.ZMEMBERJID, m.ZFROMJID)           AS sender_jid,
    m.ZMESSAGETYPE                                AS message_type,
    m.ZTEXT                                       AS text
  FROM ZWAMESSAGE m
  LEFT JOIN ZWAGROUPMEMBER gm ON m.ZGROUPMEMBER = gm.Z_PK
  WHERE m.ZCHATSESSION = (SELECT Z_PK FROM ZWACHATSESSION WHERE ZCONTACTJID = '${esc(jid)}')
    AND m.ZMESSAGETYPE NOT IN (6)  -- 6 = group system events (joins, renames)
    ${sinceEpoch != null ? `AND m.ZMESSAGEDATE >= ${sinceEpoch}` : ""}
  ORDER BY m.ZMESSAGEDATE ${limit ? "DESC LIMIT " + Number(limit) : "ASC"}`;

function cmdListChats(db) {
  const rows = q(
    db,
    `SELECT ZCONTACTJID AS jid, ZPARTNERNAME AS name, ZMESSAGECOUNTER AS messages,
            datetime(ZLASTMESSAGEDATE + ${CORE_DATA_EPOCH}, 'unixepoch', 'localtime') AS last_activity
     FROM ZWACHATSESSION WHERE ZMESSAGECOUNTER > 0 ORDER BY ZLASTMESSAGEDATE DESC`,
  );
  for (const r of rows)
    console.log(
      `${r.jid.padEnd(38)} ${String(r.messages).padStart(6)} msgs  last ${r.last_activity ?? "?"}  ${r.name ?? ""}`,
    );
}

function cmdRead(db) {
  const jid = resolveJid(db, arg("--jid"), arg("--name"));
  if (!arg("--jid") && !arg("--name")) usage(1);
  let sinceEpoch = null;
  if (arg("--since")) {
    const t = Date.parse(arg("--since"));
    if (Number.isNaN(t)) usage(1);
    sinceEpoch = t / 1000 - CORE_DATA_EPOCH;
  }
  let rows = q(db, MESSAGES_SQL(jid, { sinceEpoch, limit: arg("--limit") }));
  if (arg("--limit")) rows = rows.reverse(); // DESC LIMIT grabs newest; show oldest-first
  if (has("--json")) {
    for (const r of rows) console.log(JSON.stringify(r));
    return;
  }
  for (const r of rows) {
    const ts = new Date(r.timestamp_ms).toLocaleString("sv-SE").slice(0, 16);
    const who = r.from_me ? "me" : (r.sender ?? "?");
    const text = (r.text ?? "(media/no-text)").replace(/\n/g, " / ");
    console.log(`[${ts}] ${who}: ${text}`);
  }
}

function cmdSync(db) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(SYNC_CONFIG, "utf8"));
  } catch (e) {
    console.error(`sync: cannot read config ${SYNC_CONFIG}: ${e.message}\n  Expected: {"jids": ["...@g.us"]}`);
    process.exit(1);
  }
  if (!Array.isArray(cfg.jids) || !cfg.jids.length) {
    console.error(`sync: config has no jids — nothing to do.`);
    process.exit(1);
  }
  // Dedup against everything already in the events log, keyed on (jid, id).
  // Reliable WITHIN a source: re-running sync never double-writes. NOT
  // reliable ACROSS sources — the desktop DB's stanza id differs from the id
  // Baileys captured for the same message (verified empirically), so a few
  // messages present in old watcher captures may appear twice. Acceptable:
  // the watcher is retired; if it's ever revived, add a (timestamp,text)
  // fallback key here.
  const seen = new Set();
  if (existsSync(EVENTS_LOG)) {
    for (const line of readFileSync(EVENTS_LOG, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.event === "message" && e.id) seen.add(`${e.jid} ${e.id}`);
      } catch {}
    }
  }
  let appended = 0;
  for (const jid of cfg.jids) {
    const rows = q(db, MESSAGES_SQL(jid));
    for (const r of rows) {
      if (!r.stanza_id || seen.has(`${jid} ${r.stanza_id}`)) continue;
      appendFileSync(
        EVENTS_LOG,
        JSON.stringify({
          t: Date.now(),
          event: "message",
          source: "wa-db", // distinguishes desktop-DB sync from Baileys capture
          upsert_type: "notify",
          jid,
          id: r.stanza_id,
          from_me: !!r.from_me,
          timestamp_ms: r.timestamp_ms,
          push_name: r.from_me ? null : r.sender,
          sender_jid: r.sender_jid ?? null,
          type: r.text != null ? "text" : "media",
          text: r.text ?? null,
        }) + "\n",
      );
      seen.add(`${jid} ${r.stanza_id}`);
      appended++;
    }
  }
  const age = Math.round((Date.now() - statSync(LIVE_DB).mtimeMs) / 60000);
  console.log(`sync: appended ${appended} new message(s) for ${cfg.jids.length} chat(s). DB last written ${age} min ago.`);
}

const sub = process.argv[2];
if (!sub || has("--help") || has("-h")) usage(sub ? 0 : 1);
const { copy, cleanup } = snapshotDb();
try {
  if (sub === "list-chats") cmdListChats(copy);
  else if (sub === "read") cmdRead(copy);
  else if (sub === "sync") cmdSync(copy);
  else usage(1);
} finally {
  cleanup();
}
