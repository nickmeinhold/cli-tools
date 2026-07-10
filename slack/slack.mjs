#!/usr/bin/env node
/**
 * slack — CLI for the Slack Web API (no deps, plain fetch).
 *
 * Posture note (token type is the capability boundary):
 *   Slack has two token flavours and the choice decides what you can see:
 *     • User token  (xoxp-…) — acts as you. Sees every channel/DM you're in,
 *       and is the ONLY type that can call search.messages. This is what you
 *       want for "browse a workspace as yourself".
 *     • Bot  token  (xoxb-…) — acts as an app/bot. Only sees channels it has
 *       been explicitly invited to; cannot search. Fine for posting to one
 *       known channel, wrong for browsing a workspace.
 *   Put whichever you use in ~/.claude/.env as SLACK_TOKEN. The CLI does not
 *   care which flavour it is — Slack enforces the scope — but `search` and
 *   broad `read` need a user token.
 *
 * Credentials (one-time — user token, the useful case):
 *   1. https://api.slack.com/apps → Create New App → "From scratch" → pick your
 *      workspace.
 *   2. "OAuth & Permissions" → scroll to **User Token Scopes** (NOT bot) → add:
 *        channels:history  groups:history  im:history  mpim:history
 *        channels:read     groups:read     users:read  search:read
 *   3. Top of that page → "Install to Workspace" → Allow.
 *   4. Copy the **User OAuth Token** (starts xoxp-…). Add to ~/.claude/.env:
 *        export SLACK_TOKEN=xoxp-...
 *   (A bot token works for `send` to an invited channel with the matching
 *    bot scopes: chat:write, channels:read, users:read.)
 *
 * Subcommands (run `slack help`):
 *   whoami                                        auth.test — who this token is.
 *   channels   [--search <substr>] [--all]        List conversations (public by
 *                                                 default; --all adds private/DM).
 *   users      [--search <substr>]                Workspace members: id, name.
 *   read       --channel <id|name-substr> [--limit N] [--from <user-substr>]
 *                                                 History oldest→newest, names
 *                                                 resolved; --from filters author.
 *   read       --dm <user-substr> [--limit N]     DM history with a person.
 *   thread     --channel <c> --ts <msg-ts> [--limit N]   Replies in a thread.
 *   search     --query "..." [--from <user>] [--in <channel>] [--limit N]
 *                                                 search.messages (user token).
 *   send       --channel <id|name> --text "..." [--thread <ts>]   Post a message.
 *   send       --dm <user-substr> --text "..."    DM a person.
 *
 * All structured output → stdout as JSON; human status → stderr.
 * `send` is deliberate: it prints the resolved target before posting, and
 * fails-closed on any unrecognised --flag (never silently fire a real post).
 */

import { execSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const API = "https://slack.com/api";

/**
 * Credential resolution — two paths, in priority order:
 *   1. SLACK_TOKEN env (xoxp- user token or xoxb- bot token) → bearer only.
 *   2. The logged-in Slack DESKTOP session (in-situ, like signal/telegram):
 *      the per-workspace xoxc- token from LevelDB + the encrypted `d` cookie
 *      from the app's Cookies DB (decrypted with the "Slack Safe Storage"
 *      keychain key). xoxc alone is inert — Slack requires the cookie too.
 * Returns { token, cookie, team } — cookie is "" for an env token.
 * `--workspace <substr>` picks among multiple live desktop sessions.
 */
const SUP = join(homedir(), "Library/Application Support/Slack");
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function decryptDesktopCookie() {
  const pw = execSync(`security find-generic-password -s "Slack Safe Storage" -w`).toString().trim();
  const key = pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
  const hex = execSync(
    `sqlite3 ${shq(join(SUP, "Cookies"))} "select hex(encrypted_value) from cookies where name='d' and host_key like '%slack.com' limit 1;"`,
  ).toString().trim();
  if (!hex) throw new Error("no `d` cookie in Slack desktop store");
  const enc = Buffer.from(hex, "hex");
  const dec = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  dec.setAutoPadding(false);
  let out = Buffer.concat([dec.update(enc.subarray(3)), dec.final()]); // strip 'v10'
  out = out.subarray(0, out.length - out[out.length - 1]);            // strip PKCS7 pad
  let c = out.toString("utf8");
  if (!c.startsWith("xoxd-") && out.length > 32) c = out.subarray(32).toString("utf8");
  return c;
}

function desktopTokens() {
  const ldb = join(SUP, "Local Storage/leveldb");
  return execSync(
    `strings ${shq(ldb)}/*.ldb ${shq(ldb)}/*.log 2>/dev/null | grep -oE 'xoxc-[0-9A-Za-z-]{20,}' | sort -u`,
  ).toString().trim().split("\n").filter(Boolean);
}

async function authTest(token, cookie) {
  const res = await fetch(`${API}/auth.test`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: `d=${cookie}` } : {}),
    },
  });
  return res.json();
}

async function resolveCreds(workspace) {
  const env = process.env.SLACK_TOKEN;
  if (env) return { token: env, cookie: "", team: null };
  if (!existsSync(SUP)) {
    throw new Error("no SLACK_TOKEN and no Slack desktop app found — see: slack help");
  }
  const cookie = decryptDesktopCookie();
  const live = [];
  for (const tok of desktopTokens()) {
    const b = await authTest(tok, cookie);
    if (b.ok) live.push({ token: tok, cookie, team: b.team, domain: b.url });
  }
  if (live.length === 0) throw new Error("Slack desktop has no live session — open Slack and sign in");
  if (workspace) {
    const m = live.filter((l) => (l.team + l.domain).toLowerCase().includes(String(workspace).toLowerCase()));
    if (m.length === 1) return m[0];
    if (m.length === 0) throw new Error(`no live workspace matching "${workspace}" — have: ${live.map((l) => l.team).join(", ")}`);
    throw new Error(`ambiguous "${workspace}": ${m.map((l) => l.team).join(", ")}`);
  }
  if (live.length === 1) return live[0];
  throw new Error(`multiple live workspaces (${live.map((l) => l.team).join(", ")}) — pick one with --workspace <substr>`);
}

// Populated in main once creds resolve; used by api().
let TOKEN, COOKIE;

// Flags every subcommand may legitimately carry. `send` (irreversible) checks
// its argv against this allowlist and aborts on anything unknown — a typo'd
// --dry-run must not fall through to a real post.
const KNOWN_FLAGS = new Set([
  "search", "all", "channel", "limit", "from", "dm", "ts",
  "thread", "query", "in", "text", "help", "workspace",
]);

// ── arg parsing (same shape as discord.mjs / telegram.mjs) ───────────────────
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
  console.log(`slack — Slack Web API CLI (no deps), read/search/post in a workspace

AUTH — two paths, tried in order (NO setup needed for path 2):
  1. SLACK_TOKEN env — xoxp- (user, full read + search) or xoxb- (bot, invited
     channels only, no search). Explicit override.
  2. The logged-in Slack DESKTOP app (default, zero-setup — like signal/telegram):
     reuses the live per-workspace session (xoxc- token + decrypted d cookie).
     Multiple live workspaces → pick with --workspace <substr>, e.g.
     --workspace <name>. This is the normal path on your machine.

WHY / WHEN TO USE
  Reads/searches/posts as you in a Slack workspace. Path 2 needs nothing set
  up — if the desktop app is signed in, the CLI just works.

SETUP for path 1 only (optional, ~3 min): see header of this file —
  api.slack.com/apps → Create App → OAuth & Permissions → User Token Scopes
  (channels:history groups:history im:history channels:read users:read
  search:read) → Install → export SLACK_TOKEN=xoxp-... in ~/.claude/.env

SUBCOMMANDS
  whoami
  channels   [--search <substr>] [--all]
  users      [--search <substr>]
  read       --channel <id|name-substr> [--limit N] [--from <user-substr>]
  read       --dm <user-substr> [--limit N]
  thread     --channel <c> --ts <msg-ts> [--limit N]
  search     --query "..." [--from <user>] [--in <channel>] [--limit N]
  send       --channel <id|name> --text "..." [--thread <ts>]
  send       --dm <user-substr> --text "..."

EXAMPLES
  slack channels --search general
  slack read --channel general --from alice --limit 50
  slack search --query "presentation" --from alice --limit 20

  source ~/.claude/.env first. JSON → stdout; status → stderr.`);
}

/**
 * One Slack Web API call. Slack ALWAYS returns HTTP 200 and puts the real
 * status in the JSON body ({ok:false, error}), so we check body.ok — the
 * single biggest difference from a Discord-style client. GET methods take
 * query params; write methods (chat.postMessage) go as POST JSON.
 * Retries once on a 429, honouring Retry-After.
 */
async function api(method, params = {}, { post = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let url = `${API}/${method}`;
    const opts = {
      method: post ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(COOKIE ? { Cookie: `d=${COOKIE}` } : {}),
      },
    };
    if (post) {
      opts.headers["Content-Type"] = "application/json; charset=utf-8";
      opts.body = JSON.stringify(params);
    } else {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
      ).toString();
      if (qs) url += `?${qs}`;
    }
    const res = await fetch(url, opts);
    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get("retry-after")) || 1;
      console.error(`rate-limited; retrying in ${wait}s…`);
      await new Promise((r) => setTimeout(r, wait * 1000 + 100));
      continue;
    }
    const body = await res.json();
    if (!body.ok) {
      throw new Error(`${method} → ${body.error}${body.needed ? ` (needs scope: ${body.needed})` : ""}`);
    }
    return body;
  }
}

/** Page through a cursor-paginated list method, flattening `key`. */
async function paginate(method, params, key) {
  let cursor;
  const out = [];
  do {
    const body = await api(method, { ...params, limit: 200, cursor });
    out.push(...(body[key] ?? []));
    cursor = body.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

// ── name resolution ──────────────────────────────────────────────────────────
let _userCache;
/** id → display label, loaded once. */
async function userMap() {
  if (_userCache) return _userCache;
  const users = await paginate("users.list", {}, "members");
  _userCache = new Map(
    users.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name]),
  );
  return _userCache;
}

/** Resolve --channel by exact id or case-insensitive name substring. */
async function resolveChannel(q, { all = true } = {}) {
  if (!q) throw new Error("--channel required (id or name substring)");
  if (/^[CGD][A-Z0-9]{6,}$/.test(q)) return { id: q, name: q };
  const types = all
    ? "public_channel,private_channel,mpim,im"
    : "public_channel";
  const chans = await paginate("conversations.list", { types, exclude_archived: true }, "channels");
  const named = chans.filter((c) => c.name);
  const matches = named.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`no channel matching "${q}" — run: slack channels --all`);
  const exact = matches.find((c) => c.name.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  throw new Error(`ambiguous channel "${q}": ${matches.map((c) => c.name).join(", ")}`);
}

/** Resolve --user / --from to {id, label} by name substring. */
async function resolveUser(q) {
  if (!q) throw new Error("user substring required");
  const map = await userMap();
  const hits = [...map.entries()].filter(([, label]) =>
    label.toLowerCase().includes(q.toLowerCase()),
  );
  if (hits.length === 1) return { id: hits[0][0], label: hits[0][1] };
  if (hits.length === 0) throw new Error(`no user matching "${q}" — run: slack users`);
  const exact = hits.find(([, label]) => label.toLowerCase() === q.toLowerCase());
  if (exact) return { id: exact[0], label: exact[1] };
  throw new Error(`ambiguous "${q}": ${hits.map(([, l]) => l).join(", ")} — be more specific`);
}

/** Open (idempotent) the DM channel id with a user. */
async function dmChannel(userId) {
  const body = await api("conversations.open", { users: userId }, { post: true });
  return body.channel.id;
}

/** Shape a message list oldest→newest with author labels resolved. */
async function shapeMessages(messages, map) {
  return messages
    .slice()
    .reverse()
    .map((m) => ({
      ts: m.ts,
      at: new Date(Number(m.ts) * 1000).toISOString(),
      from: map.get(m.user) || m.username || m.bot_id || m.user || "unknown",
      user: m.user,
      text: m.text,
      thread: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
      replies: m.reply_count || undefined,
      files: (m.files || []).map((f) => ({ name: f.name, type: f.mimetype, url: f.url_private })),
    }));
}

// ── main ─────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (!cmd || cmd === "help" || args.help) {
  help();
  process.exit(0);
}
try {
  const creds = await resolveCreds(args.workspace);
  TOKEN = creds.token;
  COOKIE = creds.cookie;
  if (creds.team) console.error(`auth: ${creds.team} (desktop session, ${TOKEN.slice(0, 10)}…)`);
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}

try {
  if (cmd === "whoami") {
    const me = await api("auth.test");
    console.log(JSON.stringify(
      { user: me.user, user_id: me.user_id, team: me.team, team_id: me.team_id, url: me.url },
      null, 2,
    ));

  } else if (cmd === "channels") {
    const types = args.all
      ? "public_channel,private_channel,mpim,im"
      : "public_channel";
    const chans = await paginate("conversations.list", { types, exclude_archived: true }, "channels");
    const q = args.search ? String(args.search).toLowerCase() : null;
    console.log(JSON.stringify(
      chans
        .filter((c) => c.name && (!q || c.name.toLowerCase().includes(q)))
        .sort((a, b) => (b.num_members || 0) - (a.num_members || 0))
        .map((c) => ({
          id: c.id,
          name: c.name,
          private: !!c.is_private,
          members: c.num_members,
        })),
      null, 2,
    ));

  } else if (cmd === "users") {
    const map = await userMap();
    const q = args.search ? String(args.search).toLowerCase() : null;
    console.log(JSON.stringify(
      [...map.entries()]
        .filter(([, label]) => !q || label.toLowerCase().includes(q))
        .map(([id, label]) => ({ id, label })),
      null, 2,
    ));

  } else if (cmd === "read") {
    const map = await userMap();
    let channelId, where;
    if (args.dm) {
      const u = await resolveUser(args.dm);
      channelId = await dmChannel(u.id);
      where = `DM with ${u.label}`;
    } else {
      const c = await resolveChannel(args.channel);
      channelId = c.id;
      where = `#${c.name}`;
    }
    // When filtering --from, over-fetch so the filter still yields ~limit.
    const from = args.from ? await resolveUser(args.from) : null;
    const want = Number(args.limit ?? 30);
    const fetchN = from ? Math.min(1000, want * 20) : want;
    const body = await api("conversations.history", { channel: channelId, limit: fetchN });
    console.error(`${where}${from ? ` — messages from ${from.label}` : ""}`);
    let msgs = await shapeMessages(body.messages, map);
    if (from) msgs = msgs.filter((m) => m.user === from.id).slice(-want);
    console.log(JSON.stringify(msgs, null, 2));

  } else if (cmd === "thread") {
    const map = await userMap();
    const c = await resolveChannel(args.channel);
    if (!args.ts) throw new Error("--ts <msg-ts> required (the parent message ts, from `read`)");
    const body = await api("conversations.replies", {
      channel: c.id, ts: args.ts, limit: Number(args.limit ?? 100),
    });
    console.log(JSON.stringify(await shapeMessages(body.messages, map), null, 2));

  } else if (cmd === "search") {
    if (!args.query && !args.from) throw new Error('--query "..." (and/or --from) required');
    // Slack search grammar: "text from:@id in:#name". We compose it from flags.
    let query = args.query ? String(args.query) : "";
    if (args.from) {
      const u = await resolveUser(args.from);
      query += ` from:<@${u.id}>`;
    }
    if (args.in) query += ` in:#${args.in}`;
    const body = await api("search.messages", {
      query: query.trim(),
      count: Number(args.limit ?? 20),
      sort: "timestamp",
      sort_dir: "desc",
    });
    const map = await userMap();
    const matches = (body.messages?.matches ?? []).map((m) => ({
      ts: m.ts,
      at: new Date(Number(m.ts) * 1000).toISOString(),
      from: map.get(m.user) || m.username || "unknown",
      channel: m.channel?.name,
      text: m.text,
      permalink: m.permalink,
    }));
    console.log(JSON.stringify(matches, null, 2));

  } else if (cmd === "send") {
    // Irreversible op → fail closed on any unknown flag (a typo'd --dry-run
    // must abort, not silently post). See feedback_fail_closed_on_unknown_send_flags.
    const unknown = Object.keys(args).filter((k) => k !== "_" && !KNOWN_FLAGS.has(k));
    if (unknown.length) throw new Error(`unknown flag(s) for send: ${unknown.map((f) => "--" + f).join(", ")} — aborting (nothing sent)`);
    if (!args.text) throw new Error('--text "..." required');
    let channelId, target;
    if (args.dm) {
      const u = await resolveUser(args.dm);
      channelId = await dmChannel(u.id);
      target = `DM → ${u.label}`;
    } else {
      const c = await resolveChannel(args.channel);
      channelId = c.id;
      target = `#${c.name}`;
    }
    console.error(`sending: ${target}`);
    const payload = { channel: channelId, text: String(args.text) };
    if (args.thread) payload.thread_ts = String(args.thread);
    const body = await api("chat.postMessage", payload, { post: true });
    console.log(JSON.stringify({ sent: true, ts: body.ts, channel: channelId, to: target }));

  } else {
    console.error(`unknown subcommand "${cmd}"`);
    help();
    process.exit(1);
  }
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
