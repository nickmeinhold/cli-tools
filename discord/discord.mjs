#!/usr/bin/env node
/**
 * discord — CLI for Discord via an official BOT account (REST v10, no deps).
 *
 * Posture note (why a bot, not "as Nick"): unlike the WhatsApp/Messenger CLIs
 * (unofficial-but-tolerated user clients), Discord aggressively detects and
 * BANS self-bots — automating a user account is the one move their ToS team
 * actually enforces. So this tool is an official bot application instead.
 * Trade-off: the bot only sees servers it's been invited to, and can only DM
 * users who share a server with it. For "message teammates in the Enspyr
 * server" that's exactly enough — and replies (with attachments, e.g. head
 * scans) land in the bot's DM channel where `read`/`fetch-files` can get them.
 *
 * Credentials (one-time, ~3 min, Nick's hands):
 *   1. https://discord.com/developers/applications → New Application.
 *   2. Bot tab → Reset Token → copy. Add to ~/.claude/.env:
 *        export DISCORD_BOT_TOKEN=...
 *   3. Same Bot tab → enable "Server Members Intent" and "Message Content
 *      Intent" (both free toggles; they gate member search + message text).
 *   4. OAuth2 → URL Generator → scope `bot`, permissions: View Channels,
 *      Send Messages, Read Message History → open the URL, add to the server.
 *
 * Subcommands:
 *   whoami                       Bot identity sanity check.
 *   guilds                       Servers the bot is in: id, name.
 *   channels --guild <id|name>   Text channels in a server.
 *   members  --guild <id|name> --search <substr>   Find members (id, username, nick).
 *   send     --guild <g> --user <substr> --text "..."   DM a member (resolved by name).
 *   send     --channel <id> --text "..."                Post in a channel.
 *   read     --guild <g> --user <substr> [--limit N]    DM history, oldest→newest.
 *   read     --channel <id> [--limit N]                 Channel history.
 *   fetch-files --guild <g> --user <substr> [--out DIR] Download DM attachments
 *                                                       (default ~/Downloads).
 *
 * All structured output goes to stdout as JSON; human status to stderr.
 * Send is deliberate: it prints the resolved recipient before posting.
 */

import { writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN;

// ── arg parsing (same shape as telegram.mjs / signal.mjs) ────────────────────
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
  console.log(`discord — official-bot CLI (REST v10), messages teammates in shared servers

WHY / WHEN TO USE
  Sends/reads as an official Discord BOT (not as Nick) — Discord is the one
  platform that actively bans automated user accounts, so the self-bot route
  the WhatsApp/Messenger CLIs take is out. The bot must share a server with
  whoever it DMs; replies (including file attachments like head-scan GLBs)
  arrive in the bot's DM channel, readable via read / fetch-files.

SETUP (one-time, ~3 min): see header of this file —
  discord.com/developers/applications → New Application → Bot → copy token to
  DISCORD_BOT_TOKEN in ~/.claude/.env → enable Server Members + Message Content
  intents → OAuth2 URL Generator (scope bot; View Channels, Send Messages,
  Read Message History) → open URL to invite it to the server.

SUBCOMMANDS
  whoami
  guilds
  channels    --guild <id|name-substr>
  members     --guild <g> --search <substr>
  send        --guild <g> --user <substr> --text "..."     (DM)
  send        --channel <channel-id> --text "..."          (channel post)
  read        --guild <g> --user <substr> [--limit N]      (DM history)
  read        --channel <channel-id> [--limit N]
  fetch-files --guild <g> --user <substr> [--out DIR]      (save DM attachments)

  source ~/.claude/.env first. JSON → stdout; status → stderr.`);
}

/** REST call with bot auth; retries once on a 429 using retry_after. */
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt === 0) {
      const wait = (await res.json()).retry_after ?? 1;
      console.error(`rate-limited; retrying in ${wait}s…`);
      await new Promise((r) => setTimeout(r, wait * 1000 + 100));
      continue;
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }
}

/** Resolve --guild by exact id or case-insensitive name substring. */
async function resolveGuild(q) {
  if (!q) throw new Error("--guild required (id or name substring)");
  const guilds = await api("GET", "/users/@me/guilds");
  if (/^\d{10,}$/.test(q)) {
    const g = guilds.find((g) => g.id === q);
    if (g) return g;
  }
  const matches = guilds.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`no guild matching "${q}" — run: discord guilds`);
  throw new Error(`ambiguous guild "${q}": ${matches.map((g) => g.name).join(", ")}`);
}

/** Resolve --user within a guild via member search (needs Server Members intent). */
async function resolveMember(guildId, q) {
  if (!q) throw new Error("--user required (name substring)");
  const found = await api(
    "GET",
    `/guilds/${guildId}/members/search?query=${encodeURIComponent(q)}&limit=10`,
  );
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`no member matching "${q}" in that server`);
  // Prefer an exact username/nick hit before declaring ambiguity.
  const exact = found.find(
    (m) =>
      m.user.username.toLowerCase() === q.toLowerCase() ||
      (m.nick ?? "").toLowerCase() === q.toLowerCase() ||
      (m.user.global_name ?? "").toLowerCase() === q.toLowerCase(),
  );
  if (exact) return exact;
  throw new Error(
    `ambiguous "${q}": ${found.map((m) => m.user.username).join(", ")} — be more specific`,
  );
}

const memberLabel = (m) =>
  m.nick || m.user.global_name || m.user.username;

/** Get (or create — idempotent) the bot↔user DM channel. */
const dmChannel = (userId) =>
  api("POST", "/users/@me/channels", { recipient_id: userId });

/** Fetch messages oldest→newest with author/content/attachments. */
async function readMessages(channelId, limit) {
  const msgs = await api("GET", `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`);
  return msgs.reverse().map((m) => ({
    at: m.timestamp,
    from: m.author.global_name || m.author.username,
    bot: !!m.author.bot,
    text: m.content,
    attachments: m.attachments.map((a) => ({ name: a.filename, size: a.size, url: a.url })),
  }));
}

// ── main ─────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (!cmd || cmd === "help" || args.help) {
  help();
  process.exit(0);
}
if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN not set — source ~/.claude/.env (setup steps: discord help)");
  process.exit(1);
}

try {
  if (cmd === "whoami") {
    const me = await api("GET", "/users/@me");
    console.log(JSON.stringify({ id: me.id, username: me.username, bot: me.bot }, null, 2));
  } else if (cmd === "guilds") {
    const guilds = await api("GET", "/users/@me/guilds");
    console.log(JSON.stringify(guilds.map((g) => ({ id: g.id, name: g.name })), null, 2));
  } else if (cmd === "channels") {
    const guild = await resolveGuild(args.guild);
    const chans = await api("GET", `/guilds/${guild.id}/channels`);
    const TYPE = { 0: "text", 2: "voice", 4: "category", 5: "announcements", 15: "forum" };
    console.log(JSON.stringify(
      chans
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ id: c.id, type: TYPE[c.type] ?? c.type, name: c.name })),
      null, 2,
    ));
  } else if (cmd === "members") {
    const guild = await resolveGuild(args.guild);
    const found = await api(
      "GET",
      `/guilds/${guild.id}/members/search?query=${encodeURIComponent(args.search ?? "")}&limit=25`,
    );
    console.log(JSON.stringify(
      found.map((m) => ({
        id: m.user.id,
        username: m.user.username,
        display: memberLabel(m),
      })),
      null, 2,
    ));
  } else if (cmd === "send") {
    if (!args.text) throw new Error('--text "..." required');
    let channelId = args.channel;
    let target = `channel ${channelId}`;
    if (!channelId) {
      const guild = await resolveGuild(args.guild);
      const member = await resolveMember(guild.id, args.user);
      target = `DM → ${memberLabel(member)} (@${member.user.username}) in "${guild.name}"`;
      channelId = (await dmChannel(member.user.id)).id;
    }
    console.error(`sending: ${target}`);
    const msg = await api("POST", `/channels/${channelId}/messages`, { content: args.text });
    console.log(JSON.stringify({ sent: true, id: msg.id, channel: channelId, to: target }));
  } else if (cmd === "read") {
    let channelId = args.channel;
    if (!channelId) {
      const guild = await resolveGuild(args.guild);
      const member = await resolveMember(guild.id, args.user);
      channelId = (await dmChannel(member.user.id)).id;
    }
    console.log(JSON.stringify(await readMessages(channelId, Number(args.limit ?? 30)), null, 2));
  } else if (cmd === "fetch-files") {
    const guild = await resolveGuild(args.guild);
    const member = await resolveMember(guild.id, args.user);
    const channelId = (await dmChannel(member.user.id)).id;
    const msgs = await readMessages(channelId, 100);
    const outDir = args.out ?? join(homedir(), "Downloads");
    const saved = [];
    for (const m of msgs) {
      for (const a of m.attachments) {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`download ${a.name} → ${res.status}`);
        const path = join(outDir, basename(a.name));
        await writeFile(path, Buffer.from(await res.arrayBuffer()));
        console.error(`saved ${path} (${(a.size / 1e6).toFixed(1)}MB, from ${m.from})`);
        saved.push(path);
      }
    }
    console.log(JSON.stringify({ saved }));
  } else {
    console.error(`unknown subcommand "${cmd}"`);
    help();
    process.exit(1);
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
