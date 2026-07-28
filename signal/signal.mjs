#!/usr/bin/env node
/**
 * signal — CLI for reading and sending Signal messages as Nick.
 *
 * Two asymmetric paths, by design:
 *
 *   READ  — passive. Decrypts Signal Desktop's local SQLCipher database
 *           (~/Library/Application Support/Signal/sql/db.sqlite) directly.
 *           Full history, instant, no network. Shells out to the `sqlcipher`
 *           binary; the 256-bit DB key is derived in-process from the macOS
 *           Keychain ("Signal Safe Storage") + config.json's encryptedKey.
 *
 *   WRITE — active. Shells out to `signal-cli`, which links as its OWN Signal
 *           device (like Signal Desktop does) and speaks the real encrypted
 *           protocol. You CANNOT send by writing to the DB above — that DB is
 *           a local cache, not a send queue. Run `signal link` once to pair.
 *
 * Requirements: Homebrew `sqlcipher` (read) and `signal-cli` (write).
 *
 * Subcommands:
 *   list                     List private conversations (name, e164, msg count, last active).
 *   list    --groups         List group conversations (name, member count, last active).
 *   read    --name|--id      Dump a conversation chronologically. [--limit N] [--json]
 *                            [--since <ms>] only messages with sent_at > ms (incremental reads).
 *   read    --group <substr> Dump a GROUP; incoming lines show the resolved sender name.
 *   export                   Export private convos to NDJSON for the love_agent corpus.
 *                            [--name|--id to scope] [--out PATH]
 *   link    [--name LABEL]    One-time: render QR, scan from phone to pair signal-cli.
 *   send    --to <num|name> --text "..."   Send a 1:1 message via signal-cli.
 *   send    --group <id|name> --text "..." Send to a group via signal-cli.
 *   send    --edit-to <sent_at> --text "..." Edit a sent message in place (--edit-timestamp).
 *   receive                  Pull pending inbound messages via signal-cli (prints JSON lines).
 *   key                      (debug) Print the derived SQLCipher key.
 *
 * Privacy: this reads Nick's real private messages. love_agent posture is
 * draft-then-Nick-sends — never wire `send` to fire automatically.
 */

import crypto from "node:crypto";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SIGNAL_DIR = join(homedir(), "Library", "Application Support", "Signal");
const CONFIG_PATH = join(SIGNAL_DIR, "config.json");
const DB_PATH = join(SIGNAL_DIR, "sql", "db.sqlite");

// ── arg parsing (same shape as whatsapp.mjs) ────────────────────────────────
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
  console.log(`signal — read (Desktop DB) + write (signal-cli) for Signal

WHY / WHEN TO USE
  TWO asymmetric paths. READ is passive: decrypts Signal Desktop's local SQLCipher
  DB directly (key derived from the macOS Keychain "Signal Safe Storage" entry +
  config.json). Full history, instant, no network, no pairing. WRITE is active:
  shells out to signal-cli, which links as its OWN Signal device. You CANNOT send by
  writing to the DB — it's a local cache, not a send queue. Pairing (signal link) is
  one-time and interactive (Nick scans a QR — his hands).

Usage: signal <subcommand> [options]

Read path:  decrypts ${DB_PATH}
Write path: signal-cli linked device (run \`signal link\` once)

Subcommands:
  list                       List private conversations (name, e164, count, last active).
  list   --groups            List group conversations (name, member count, count, last active).
  read   --name <substr>     Dump a 1:1 conversation oldest→newest. [--limit N] [--json]
         --group <substr>    Dump a GROUP oldest→newest; incoming lines show the
                             resolved sender name (outgoing = ME). [--limit N] [--json]
         --id <conv-id>      Dump by conversation id (works for 1:1 or group).
         --since <ms>        Only messages with sent_at > ms (millisecond epoch);
                             incremental reads for watchers. Non-numeric = error.
  export                     Export private convos to NDJSON for the corpus.
                             [--name <substr> | --id <id>] [--out PATH]
  link   [--name LABEL]      One-time pairing: render QR, scan with phone
                             (Signal → Settings → Linked Devices → Link New Device).
  send   --to <num|name|aci> --text "..." Send 1:1 via signal-cli (E.164, ACI/UUID, or a DB name
                                        substring; names resolve to an e164 or ACI for phone-less contacts).
  send   --group <id|name> --text "..." Send to a group (base64 group id or a name substring).
  send   ... --attach <file>[,<file>...]  Attach one or more files (comma-separated).
                                          --text becomes optional when --attach is given.
  send   --group ... --mention "@Name[,@Name2]"  Real @mentions in a GROUP message.
                                          Put the @tokens literally in --text; each resolves
                                          to a member (DB name/e164/ACI) and pings them. Group-only.
  send   ... [--reply-to <sent_at> --reply-author <e164>]  Quote-reply (handles from 'read --json').
  send   ... --edit-to <sent_at> --text "..."  Edit a message already sent, in place
                                        (--text is the FULL replacement body; shows an
                                        "edited" marker, not a duplicate).
  receive                    Pull pending inbound messages (JSON lines).
  key                        (debug) Print the derived SQLCipher key.`);
}

// ── key derivation: Keychain → unwrap encryptedKey → SQLCipher key ───────────
function deriveKey() {
  // 1. Electron safeStorage password from the macOS Keychain.
  const pw = execFileSync("security",
    ["find-generic-password", "-ws", "Signal Safe Storage"],
    { encoding: "utf8" }).trim();

  // 2. Unwrap config.json's encryptedKey. Layout: "v10" + AES-128-CBC ciphertext,
  //    key = PBKDF2-HMAC-SHA1(pw, "saltysalt", 1003, 16 bytes), IV = 16 spaces.
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (!cfg.encryptedKey) {
    throw new Error("config.json has no encryptedKey — old Signal version stores key plaintext? Check config.json.");
  }
  const enc = Buffer.from(cfg.encryptedKey, "hex");
  const prefix = enc.subarray(0, 3).toString();
  if (prefix !== "v10" && prefix !== "v11") {
    throw new Error(`unexpected safeStorage prefix '${prefix}' (expected v10/v11)`);
  }
  const aesKey = crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, " ");
  const decipher = crypto.createDecipheriv("aes-128-cbc", aesKey, iv);
  const dbKey = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]).toString("utf8");

  // The unwrapped plaintext is the 64-hex-char (256-bit) raw SQLCipher key.
  if (!/^[0-9a-f]{64}$/.test(dbKey)) {
    throw new Error(`derived key is not 64 hex chars (got len ${dbKey.length}) — Signal key format may have changed`);
  }
  return dbKey;
}

// ── SQLCipher query via the sqlcipher binary ─────────────────────────────────
// Returns parsed rows. We emit JSON from sqlite for robust parsing of bodies
// that contain newlines, pipes, quotes, etc.
function query(sql) {
  const key = deriveKey();
  const script = [
    `PRAGMA key = "x'${key}'";`,
    `PRAGMA cipher_compatibility = 4;`,
    `.mode json`,
    sql.trim().endsWith(";") ? sql : sql + ";",
  ].join("\n");
  const res = spawnSync("sqlcipher", [DB_PATH], { input: script, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`sqlcipher failed: ${res.stderr || res.stdout}`);
  }
  // .mode json prints "ok" from the PRAGMA key line first, then the JSON array.
  const out = res.stdout.replace(/^ok\s*/, "").trim();
  if (!out) return [];
  // Multiple statements could each emit an array; we only run one SELECT, so
  // take the last bracketed array in the output.
  const start = out.indexOf("[");
  if (start === -1) return [];
  return JSON.parse(out.slice(start));
}

function displayName(c) {
  return (c.name && c.name.trim())
    || (c.profileFullName && c.profileFullName.trim())
    || (c.systemGivenName && c.systemGivenName.trim())
    || c.e164
    || c.id;
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdKey() {
  console.log(deriveKey());
}

// Count space-separated ACIs in a group's `members` text column.
function memberCount(members) {
  return members && members.trim() ? members.trim().split(/\s+/).length : 0;
}

function cmdListGroups(args = {}) {
  const rows = query(`
    SELECT c.id, c.name, c.members, c.active_at,
           (SELECT count(*) FROM messages m
             WHERE m.conversationId = c.id AND m.body IS NOT NULL AND length(m.body) > 0) AS msgCount
    FROM conversations c
    WHERE c.type = 'group' AND c.active_at IS NOT NULL
    ORDER BY c.active_at DESC`);
  if (args.json) {
    const out = rows.map((c) => ({
      id: c.id,
      name: (c.name && c.name.trim()) || "(unnamed group)",
      members: memberCount(c.members),
      msgCount: c.msgCount,
      lastActive: c.active_at ? new Date(c.active_at).toISOString() : null,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  for (const c of rows) {
    const when = c.active_at ? new Date(c.active_at).toISOString().slice(0, 10) : "—";
    const name = ((c.name && c.name.trim()) || "(unnamed group)").padEnd(28);
    console.log(`${String(c.msgCount).padStart(5)}  ${when}  ${name}  ${String(memberCount(c.members)).padStart(3)} mem  [${c.id}]`);
  }
  console.error(`\n${rows.length} groups.`);
}

function cmdList(args = {}) {
  if (args.groups) return cmdListGroups(args);
  const rows = query(`
    SELECT c.id, c.name, c.profileFullName,
           json_extract(c.json,'$.systemGivenName') AS systemGivenName,
           c.e164, c.active_at,
           (SELECT count(*) FROM messages m
             WHERE m.conversationId = c.id AND m.body IS NOT NULL AND length(m.body) > 0) AS msgCount
    FROM conversations c
    WHERE c.type = 'private' AND c.active_at IS NOT NULL
    ORDER BY c.active_at DESC`);
  if (args.json) {
    const out = rows.map((c) => ({
      id: c.id,
      name: displayName(c),
      e164: c.e164 || null,
      msgCount: c.msgCount,
      lastActive: c.active_at ? new Date(c.active_at).toISOString() : null,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  for (const c of rows) {
    const when = c.active_at ? new Date(c.active_at).toISOString().slice(0, 10) : "—";
    console.log(`${String(c.msgCount).padStart(5)}  ${when}  ${displayName(c).padEnd(28)}  ${c.e164 || ""}  [${c.id}]`);
  }
  console.error(`\n${rows.length} private conversations.`);
}

function resolveConversation(args) {
  if (args.id) {
    const r = query(`SELECT id, type, name, profileFullName,
        json_extract(json,'$.systemGivenName') AS systemGivenName, e164, members
        FROM conversations WHERE id = '${args.id.replace(/'/g, "''")}'`);
    if (!r.length) throw new Error(`no conversation with id ${args.id}`);
    return r[0];
  }
  if (args.group) {
    if (args.group === true) throw new Error('--group needs a name substring, e.g. read --group "MakeLab"');
    const needle = String(args.group).replace(/'/g, "''").toLowerCase();
    const r = query(`SELECT id, type, name, members, active_at
        FROM conversations
        WHERE type='group' AND lower(name) LIKE '%${needle}%'
        ORDER BY active_at DESC`);
    if (!r.length) throw new Error(`no group matching "${args.group}"`);
    if (r.length > 1) {
      console.error(`Multiple groups matching "${args.group}":`);
      for (const c of r) console.error(`  - ${(c.name || "(unnamed group)")} [${c.id}]`);
      console.error(`Refine --group or use --id.`);
    }
    return r[0];
  }
  if (args.name) {
    const needle = args.name.replace(/'/g, "''").toLowerCase();
    const r = query(`SELECT id, type, name, profileFullName,
        json_extract(json,'$.systemGivenName') AS systemGivenName, e164, active_at
        FROM conversations
        WHERE type='private' AND (
          lower(name) LIKE '%${needle}%' OR
          lower(profileFullName) LIKE '%${needle}%' OR
          e164 LIKE '%${needle}%')
        ORDER BY active_at DESC`);
    if (!r.length) throw new Error(`no private conversation matching "${args.name}"`);
    if (r.length > 1) {
      console.error(`Multiple matches for "${args.name}":`);
      for (const c of r) console.error(`  - ${displayName(c)} (${c.e164 || c.id})`);
      console.error(`Refine --name or use --id.`);
    }
    return r[0];
  }
  throw new Error("specify --name <substr>, --group <substr>, or --id <conv-id>");
}

// Resolve a group message's sender ACI (messages.sourceServiceId) to a display
// name via the contact's own conversations row (matched on serviceId). Written
// as a CORRELATED SUBQUERY, not a JOIN: a LEFT JOIN would duplicate the message
// row if two conversation rows ever shared a serviceId (a merged/duplicate
// contact) — the subquery is one-in-one-out by construction. Precedence mirrors
// displayName(): name → profileFullName → systemGivenName → e164 → raw ACI.
const SENDER_SUBQUERY = `(
  SELECT COALESCE(
    NULLIF(TRIM(s.name), ''), NULLIF(TRIM(s.profileFullName), ''),
    json_extract(s.json, '$.systemGivenName'), s.e164, m.sourceServiceId)
  FROM conversations s WHERE s.serviceId = m.sourceServiceId LIMIT 1)`;

function fetchMessages(convId, limit, since) {
  const lim = limit ? `LIMIT ${parseInt(limit, 10)}` : "";
  // --since <ms>: incremental read — only messages NEWER than a caller-held
  // high-water-mark (the watchers pass max(sent_at) of what they've already
  // processed). Filter on m.sent_at specifically (not the COALESCE ordering key)
  // so it matches the watchers' hwm exactly, avoiding an off-by-one against
  // received_at. FAIL CLOSED on a bad value: a silently-ignored --since would
  // re-feed a watcher's entire message history to its LLM every tick.
  let sinceClause = "";
  if (since !== undefined) {
    if (!/^\d{10,}$/.test(String(since)))
      throw new Error(
        `--since expects a millisecond epoch timestamp (10+ digits); got "${since}". ` +
        `Refusing to run — a silently-ignored --since would re-read the full history.`);
    sinceClause = `AND m.sent_at > ${parseInt(since, 10)}`;
  }
  // type: 'outgoing' = me (Nick), 'incoming' = them. `sender` resolves the
  // individual author for GROUP reads; it's ignored on 1:1 output (which uses
  // ME/THEM) but harmless to carry.
  return query(`
    SELECT m.type, m.body, m.sent_at, m.received_at,
           ${SENDER_SUBQUERY} AS sender
    FROM messages m
    WHERE m.conversationId = '${convId.replace(/'/g, "''")}'
      AND m.type IN ('incoming','outgoing')
      AND m.body IS NOT NULL AND length(m.body) > 0
      ${sinceClause}
    ORDER BY COALESCE(m.sent_at, m.received_at) ASC ${lim}`);
}

function cmdRead(args) {
  const conv = resolveConversation(args);
  const msgs = fetchMessages(conv.id, args.limit, args.since);
  if (args.json) {
    console.log(JSON.stringify({ conversation: { id: conv.id, name: displayName(conv), e164: conv.e164 }, messages: msgs }, null, 2));
    return;
  }
  const isGroup = conv.type === "group";
  const header = isGroup
    ? `# ${displayName(conv)}  (group, ${memberCount(conv.members)} members) — ${msgs.length} messages`
    : `# ${displayName(conv)}  (${conv.e164 || conv.id}) — ${msgs.length} messages`;
  console.error(header + "\n");
  // In a GROUP, an incoming message can be from any member, so label it with the
  // resolved sender name (from fetchMessages' SENDER_SUBQUERY); outgoing is still
  // "ME". In a 1:1 the counterparty is fixed, so keep the terse ME/THEM.
  for (const m of msgs) {
    const who = m.type === "outgoing" ? "ME" : (isGroup ? (m.sender || "?") : "THEM");
    const ts = new Date(m.sent_at || m.received_at).toISOString().slice(0, 16).replace("T", " ");
    // Pad the speaker column so bodies line up; group names vary in width.
    const label = isGroup ? who.padEnd(16).slice(0, 16) : who.padEnd(4);
    const indent = " ".repeat(ts.length + 3 + (isGroup ? 16 : 4) + 2);
    console.log(`[${ts}] ${label}: ${m.body.replace(/\n/g, "\n" + indent)}`);
  }
}

function cmdExport(args) {
  let convs;
  if (args.name || args.id) convs = [resolveConversation(args)];
  else convs = query(`SELECT id, name, profileFullName,
      json_extract(json,'$.systemGivenName') AS systemGivenName, e164
      FROM conversations WHERE type='private' AND active_at IS NOT NULL ORDER BY active_at DESC`);

  const lines = [];
  for (const conv of convs) {
    const msgs = fetchMessages(conv.id, null);
    if (!msgs.length) continue;
    lines.push(JSON.stringify({
      app: "signal",
      conversationId: conv.id,
      name: displayName(conv),
      e164: conv.e164 || null,
      turns: msgs.map((m) => ({
        role: m.type === "outgoing" ? "me" : "them",
        text: m.body,
        ts: m.sent_at || m.received_at,
      })),
    }));
  }
  const payload = lines.join("\n") + "\n";
  if (args.out) {
    writeFileSync(args.out, payload, { mode: 0o600 });
    console.error(`Wrote ${lines.length} conversations → ${args.out}`);
  } else {
    process.stdout.write(payload);
    console.error(`\n${lines.length} conversations exported.`);
  }
}

// ── write path: signal-cli ───────────────────────────────────────────────────
function ensureSignalCli() {
  const r = spawnSync("signal-cli", ["--version"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("signal-cli not found. Install: brew install signal-cli");
  return r.stdout.trim();
}

function cmdLink(args) {
  ensureSignalCli();
  const label = args.name || "love_agent";
  console.error(`Linking signal-cli as device "${label}".`);
  console.error(`On your phone: Signal → Settings → Linked Devices → Link New Device, then scan:\n`);
  // signal-cli prints a `sgnl://linkdevice?...` URI on stdout, THEN blocks
  // waiting for the phone to scan. We must stream stdout and render the QR the
  // moment that line arrives — a buffered spawnSync would never show it in time.
  return new Promise(async (resolve, reject) => {
    const { default: qrcode } = await import("qrcode-terminal");
    const child = spawn("signal-cli", ["link", "-n", label]);
    let rendered = false, buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\n").find((l) => l.startsWith("sgnl://"));
      if (line && !rendered) {
        rendered = true;
        qrcode.generate(line.trim(), { small: true });
        console.error("\nWaiting for scan… (Ctrl-C to abort)");
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => {
      if (code === 0) { console.error("\nLinked. signal-cli can now send as you."); resolve(); }
      else reject(new Error(`signal-cli link exited ${code}`));
    });
  });
}

function resolveRecipient(to) {
  if (/^\+\d{6,15}$/.test(to)) return to; // already E.164
  // A bare ACI/UUID is a valid signal-cli recipient for phone-number-less
  // contacts (Signal is phasing out phone numbers), so pass it straight through.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(to)) return to;
  // Resolve a name substring via the Desktop DB. Prefer an e164, but fall back to
  // the serviceId (ACI) so ACI-only contacts are reachable too.
  const needle = to.replace(/'/g, "''").toLowerCase();
  const r = query(`SELECT name, profileFullName, e164, serviceId FROM conversations
    WHERE type='private' AND (e164 IS NOT NULL OR serviceId IS NOT NULL) AND (
      lower(name) LIKE '%${needle}%' OR lower(profileFullName) LIKE '%${needle}%')
    ORDER BY active_at DESC`);
  if (!r.length) throw new Error(`could not resolve "${to}"; pass an E.164 number or ACI directly`);
  if (r.length > 1) {
    console.error(`Multiple matches for "${to}":`);
    for (const c of r) console.error(`  - ${displayName(c)} (${c.e164 || c.serviceId})`);
    throw new Error("ambiguous recipient; pass an E.164 number or ACI directly");
  }
  const id = r[0].e164 || r[0].serviceId;
  if (!id) throw new Error(`"${to}" has no phone number or ACI on record`);
  return id;
}

// Resolve a group to its base64 group id. Accepts an id directly (contains
// base64 chars like / or +, or ends in =) or a case-insensitive name substring
// matched against `signal-cli listGroups`. Throws on no/ambiguous match.
function resolveGroup(g) {
  if (/[/+]/.test(g) || g.endsWith("=")) return g; // already a base64 group id
  const r = spawnSync("signal-cli", ["listGroups"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`signal-cli listGroups failed: ${r.stderr || r.stdout}`);
  const needle = g.toLowerCase();
  const matches = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^Id:\s+(\S+)\s+Name:\s+(.*?)\s+Active:/);
    if (m && m[2].toLowerCase().includes(needle)) matches.push({ id: m[1], name: m[2] });
  }
  if (!matches.length) throw new Error(`could not resolve group "${g}"; pass the base64 group id`);
  if (matches.length > 1) {
    console.error(`Multiple group matches for "${g}":`);
    for (const c of matches) console.error(`  - ${c.name} (${c.id})`);
    throw new Error("ambiguous group; pass the base64 group id");
  }
  return matches[0].id;
}

// --mention "@Name[,@Name2,...]" — turn each @token in --text into a signal-cli
// mention spec "start:length:recipient". Ranges are UTF-16 code units, which JS
// string indices/lengths already are. The @token must appear literally in --text;
// its WHOLE span (including the @) is covered so Signal renders one @DisplayName
// pill (covering only "Name" would double the @). A raw "start:length:recipient"
// value passes through unchanged. Group-only (Signal has no 1:1 mentions).
function buildMentionSpecs(raw, text) {
  const specs = [];
  for (const item of String(raw).split(",").map((s) => s.trim()).filter(Boolean)) {
    if (/^\d+:\d+:.+$/.test(item)) { specs.push(item); continue; } // raw passthrough
    const token = item.startsWith("@") ? item : "@" + item;
    const name = item.replace(/^@/, "");
    const start = text.indexOf(token);
    if (start < 0)
      throw new Error(`--mention ${item}: token "${token}" not found in --text (the @token must appear literally in the message)`);
    if (text.indexOf(token, start + 1) >= 0)
      console.error(`[mention] "${token}" appears more than once in --text; mentioning the first occurrence.`);
    specs.push(`${start}:${token.length}:${resolveRecipient(name)}`);
  }
  if (!specs.length) throw new Error("--mention was given but no usable tokens were parsed");
  return specs;
}

function cmdSend(args) {
  // Fail CLOSED on unrecognized flags: a send is irreversible, so an unknown
  // flag (e.g. a typo'd safety flag like --dryrun, or --no-send) must NEVER
  // fall through and send anyway. Reject before doing anything. This is the
  // guard that turns a silent mis-send into a loud refusal.
  const KNOWN_SEND_FLAGS = new Set([
    "text", "to", "group", "attach", "mention", "reply-to", "reply-author", "reply-text", "edit-to", "dry-run",
  ]);
  const unknown = Object.keys(args).filter((k) => k !== "_" && !KNOWN_SEND_FLAGS.has(k));
  if (unknown.length) {
    throw new Error(
      `unknown send flag(s): ${unknown.map((u) => "--" + u).join(", ")}. ` +
      `Refusing to send (a stray flag must not silently fire a real message). ` +
      `Known: --text --to --group --attach --mention --reply-to --reply-author --reply-text --edit-to --dry-run`);
  }
  ensureSignalCli();
  // --attach FILE[,FILE...] — outbound file attachments (comma-separated for
  // multiple). Validate every path exists up front so a typo fails LOUD here
  // rather than half-way through signal-cli's send.
  const attachments = args.attach
    ? String(args.attach).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  for (const f of attachments) {
    if (!existsSync(f)) throw new Error(`attachment not found: ${f}`);
  }
  if (!args.text && !attachments.length)
    throw new Error("send requires --text \"...\" or --attach <file>");
  if (!args.to && !args.group) throw new Error("send requires --to <num|name> or --group <id|name>");
  if (args.to && args.group) throw new Error("send takes either --to or --group, not both");
  // --mention "@Name,@Name2": group-only, needs --text carrying the @tokens.
  if (args.mention !== undefined) {
    if (args.mention === true) throw new Error('--mention needs a value, e.g. --mention "@Andy,@Wade"');
    if (!args.group) throw new Error("--mention only works with --group (Signal has no 1:1 mentions)");
    if (!args.text) throw new Error("--mention requires --text containing the @tokens to mention");
  }
  const mentionSpecs = args.mention !== undefined ? buildMentionSpecs(args.mention, String(args.text)) : [];
  const mentionArg = mentionSpecs.length ? ["--mention", ...mentionSpecs] : [];
  // --edit-to <sent_at>: replace a message already sent, in place. Maps to
  // signal-cli's --edit-timestamp. Signal edits swap the WHOLE body, so --text
  // is the full replacement (not a diff); the recipient sees one message with an
  // "edited" marker, not a duplicate. Timestamp is the original's sent_at (the
  // number `send` printed, or a `read --json` .sent_at).
  const isEdit = args["edit-to"] !== undefined;
  if (isEdit) {
    if (!/^\d{10,}$/.test(String(args["edit-to"])))
      throw new Error(`--edit-to expects the original message's sent_at timestamp (digits); got "${args["edit-to"]}"`);
    if (!args.text)
      throw new Error("--edit-to requires --text with the full replacement message (an edit replaces the whole body)");
  }
  const target = args.group
    ? ["-g", resolveGroup(args.group)]
    : [resolveRecipient(args.to)];
  // --dry-run: resolve the target and show EXACTLY what would be sent, then stop
  // WITHOUT calling signal-cli. The flag now does the safe thing its name promises.
  if (args["dry-run"]) {
    const dest = args.group ? `group ${target[1]}` : target[0];
    const editNote = isEdit ? ` (EDIT of message ${args["edit-to"]})` : "";
    console.error(`[dry-run] would send to ${dest}${editNote} — NOT sent.`);
    if (args.text) console.error(`[dry-run] text: ${args.text}`);
    if (attachments.length) console.error(`[dry-run] attachments: ${attachments.join(", ")}`);
    if (mentionSpecs.length) console.error(`[dry-run] mentions: ${mentionSpecs.join(" ")}`);
    return;
  }
  // signal-cli quotes by TIMESTAMP + AUTHOR (it has no message-id concept).
  // --reply-to <sent_at> is the quoted message's timestamp (from `read --json`
  // .sent_at); --reply-author <e164> is its sender (the other party's number for
  // an incoming 1:1; your own for one you sent). --reply-text fills the preview.
  const quote = [];
  if (args["reply-to"]) {
    quote.push("--quote-timestamp", String(args["reply-to"]));
    if (args["reply-author"]) quote.push("--quote-author", String(args["reply-author"]));
    if (args["reply-text"]) quote.push("--quote-message", String(args["reply-text"]));
  }
  const msgArg = args.text ? ["-m", args.text] : [];
  const attachArg = attachments.length ? ["-a", ...attachments] : [];
  const editArg = isEdit ? ["--edit-timestamp", String(args["edit-to"])] : [];
  const r = spawnSync("signal-cli", ["send", ...msgArg, ...attachArg, ...mentionArg, ...quote, ...editArg, ...target], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`signal-cli send failed: ${r.stderr || r.stdout}`);
  const note = attachments.length ? ` with ${attachments.length} attachment(s)` : "";
  const editNote = isEdit ? ` (edited message ${args["edit-to"]})` : "";
  console.error(`Sent to ${args.group ? `group ${target[1]}` : target[0]}${note}${editNote}.`);
  if (r.stdout.trim()) console.log(r.stdout.trim());
}

function cmdReceive() {
  ensureSignalCli();
  // -o json is a GLOBAL flag (before the subcommand), not a `receive` flag.
  const r = spawnSync("signal-cli", ["-o", "json", "receive"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`signal-cli receive failed: ${r.stderr || r.stdout}`);
  process.stdout.write(r.stdout);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return help();
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (sub) {
    case "key": return cmdKey();
    case "list": return cmdList(args);
    case "read": return cmdRead(args);
    case "export": return cmdExport(args);
    case "link": return cmdLink(args);
    case "send": return cmdSend(args);
    case "receive": return cmdReceive();
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
