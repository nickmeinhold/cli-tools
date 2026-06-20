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
 *   read    --name|--id      Dump a conversation chronologically. [--limit N] [--json]
 *   export                   Export private convos to NDJSON for the love_agent corpus.
 *                            [--name|--id to scope] [--out PATH]
 *   link    [--name LABEL]    One-time: render QR, scan from phone to pair signal-cli.
 *   send    --to <num|name> --text "..."   Send a 1:1 message via signal-cli.
 *   send    --group <id|name> --text "..." Send to a group via signal-cli.
 *   receive                  Pull pending inbound messages via signal-cli (prints JSON lines).
 *   key                      (debug) Print the derived SQLCipher key.
 *
 * Privacy: this reads Nick's real private messages. love_agent posture is
 * draft-then-Nick-sends — never wire `send` to fire automatically.
 */

import crypto from "node:crypto";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
  read   --name <substr>     Dump a conversation oldest→newest. [--limit N] [--json]
         --id <conv-id>
  export                     Export private convos to NDJSON for the corpus.
                             [--name <substr> | --id <id>] [--out PATH]
  link   [--name LABEL]      One-time pairing: render QR, scan with phone
                             (Signal → Settings → Linked Devices → Link New Device).
  send   --to <num|name> --text "..."   Send 1:1 via signal-cli (E.164 or a DB name substring).
  send   --group <id|name> --text "..." Send to a group (base64 group id or a name substring).
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

function cmdList(args = {}) {
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
    const r = query(`SELECT id, name, profileFullName,
        json_extract(json,'$.systemGivenName') AS systemGivenName, e164
        FROM conversations WHERE id = '${args.id.replace(/'/g, "''")}'`);
    if (!r.length) throw new Error(`no conversation with id ${args.id}`);
    return r[0];
  }
  if (args.name) {
    const needle = args.name.replace(/'/g, "''").toLowerCase();
    const r = query(`SELECT id, name, profileFullName,
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
  throw new Error("specify --name <substr> or --id <conv-id>");
}

function fetchMessages(convId, limit) {
  const lim = limit ? `LIMIT ${parseInt(limit, 10)}` : "";
  // type: 'outgoing' = me (Nick), 'incoming' = them.
  return query(`
    SELECT type, body, sent_at, received_at
    FROM messages
    WHERE conversationId = '${convId.replace(/'/g, "''")}'
      AND type IN ('incoming','outgoing')
      AND body IS NOT NULL AND length(body) > 0
    ORDER BY COALESCE(sent_at, received_at) ASC ${lim}`);
}

function cmdRead(args) {
  const conv = resolveConversation(args);
  const msgs = fetchMessages(conv.id, args.limit);
  if (args.json) {
    console.log(JSON.stringify({ conversation: { id: conv.id, name: displayName(conv), e164: conv.e164 }, messages: msgs }, null, 2));
    return;
  }
  console.error(`# ${displayName(conv)}  (${conv.e164 || conv.id}) — ${msgs.length} messages\n`);
  for (const m of msgs) {
    const who = m.type === "outgoing" ? "ME " : "THEM";
    const ts = new Date(m.sent_at || m.received_at).toISOString().slice(0, 16).replace("T", " ");
    console.log(`[${ts}] ${who}: ${m.body.replace(/\n/g, "\n            ")}`);
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
  // resolve a name substring to an e164 via the Desktop DB
  const needle = to.replace(/'/g, "''").toLowerCase();
  const r = query(`SELECT name, profileFullName, e164 FROM conversations
    WHERE type='private' AND e164 IS NOT NULL AND (
      lower(name) LIKE '%${needle}%' OR lower(profileFullName) LIKE '%${needle}%')
    ORDER BY active_at DESC`);
  if (!r.length) throw new Error(`could not resolve "${to}" to a phone number; pass E.164 directly`);
  if (r.length > 1) {
    console.error(`Multiple matches for "${to}":`);
    for (const c of r) console.error(`  - ${displayName(c)} (${c.e164})`);
    throw new Error("ambiguous recipient; pass E.164 directly");
  }
  return r[0].e164;
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

function cmdSend(args) {
  ensureSignalCli();
  if (!args.text) throw new Error("send requires --text \"...\"");
  if (!args.to && !args.group) throw new Error("send requires --to <num|name> or --group <id|name>");
  if (args.to && args.group) throw new Error("send takes either --to or --group, not both");
  const target = args.group
    ? ["-g", resolveGroup(args.group)]
    : [resolveRecipient(args.to)];
  const r = spawnSync("signal-cli", ["send", "-m", args.text, ...target], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`signal-cli send failed: ${r.stderr || r.stdout}`);
  console.error(`Sent to ${args.group ? `group ${target[1]}` : target[0]}.`);
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
