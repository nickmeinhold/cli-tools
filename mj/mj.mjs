#!/usr/bin/env node
// mj — drive Midjourney's Discord /imagine programmatically, download the
// results, and hand them back to Claude (and optionally repost to Discord).
//
// Generation uses a Discord USER token (self-bot) because only a user account
// can invoke another bot's slash command — a Discord bot structurally cannot.
// This is against Discord ToS (self-bots are bannable); it exists at Nick's
// explicit, risk-aware request. Reposting uses the OFFICIAL bot token, which
// is allowed.
//
// Zero deps, plain fetch (Node 18+). JSON/paths → stdout, status → stderr.
//
//   source ~/.claude/.env    # DISCORD_USER_TOKEN (+ optional DISCORD_BOT_TOKEN)
//   node mj.mjs guilds
//   node mj.mjs channels --guild <id|name>
//   node mj.mjs imagine "a fox in fog --ar 16:9" --channel <id> [--upscale all]
//        [--no-upscale] [--out ./out] [--post-channel <id>] [--timeout 180]

const API = 'https://discord.com/api/v9';
const MJ_APP_ID = '936929561302675456'; // Midjourney Bot (well-known, public)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const USER_TOKEN = process.env.DISCORD_USER_TOKEN;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const log = (...a) => console.error(...a);
const die = (m) => { log(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
// Discord snowflakes are time-sortable big integers — compare as BigInt.
const newer = (a, b) => BigInt(a) > BigInt(b);

// ── low-level HTTP as the user account ──────────────────────────────────────
async function userApi(path, { method = 'GET', body } = {}) {
  if (!USER_TOKEN) die('DISCORD_USER_TOKEN not set — see: node mj.mjs setup');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: USER_TOKEN, // user token: NO "Bot " prefix
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    const wait = (j.retry_after || 2) * 1000;
    log(`  rate-limited, waiting ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
    return userApi(path, { method, body });
  }
  if (res.status === 401) die('401 Unauthorized — user token invalid or expired');
  if (!res.ok && res.status !== 204) {
    const t = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status} ${t.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ── fetch Midjourney's live /imagine command (id + version drift over time) ──
// Uses the guild application-command-index — the channel /application-commands/
// search endpoint returns empty for user accounts, so the index is the reliable
// source. Filters by MJ's application_id (another bot may also expose /imagine).
async function fetchImagineCommand(guildId) {
  const url = `${API}/guilds/${guildId}/application-command-index`;
  const res = await fetch(url, { headers: { Authorization: USER_TOKEN, 'User-Agent': UA } });
  if (!res.ok) throw new Error(`command index → ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const cmd = (data.application_commands || []).find(
    (c) => c.name === 'imagine' && c.application_id === MJ_APP_ID
  );
  if (!cmd) die('Could not find Midjourney /imagine in this guild — is the MJ bot present & are you subscribed?');
  return cmd;
}

// ── fire /imagine ───────────────────────────────────────────────────────────
async function fireImagine({ guildId, channelId, prompt }) {
  const cmd = await fetchImagineCommand(guildId);
  const payload = {
    type: 2, // APPLICATION_COMMAND
    application_id: MJ_APP_ID,
    guild_id: guildId,
    channel_id: channelId,
    session_id: rand(32),
    nonce: `${BigInt(Date.now() - 1420070400000) << 22n}`,
    data: {
      version: cmd.version,
      id: cmd.id,
      name: 'imagine',
      type: 1,
      options: [{ type: 3, name: 'prompt', value: prompt }],
      application_command: cmd,
      attachments: [],
    },
  };
  await userApi('/interactions', { method: 'POST', body: payload });
}

// ── poll helpers ─────────────────────────────────────────────────────────────
async function latestMessageId(channelId) {
  const msgs = await userApi(`/channels/${channelId}/messages?limit=1`);
  return msgs[0]?.id || '0';
}

const upsampleButtons = (msg) =>
  (msg.components || [])
    .flatMap((row) => row.components || [])
    .filter((c) => c.type === 2 && /::upsample::/.test(c.custom_id || ''))
    .map((c) => ({ index: Number((c.custom_id.match(/upsample::(\d)/) || [])[1]), custom_id: c.custom_id }));

// V1–V4 on a grid: each yields a NEW 4-up grid (a branch of the concept).
const variationButtons = (msg) =>
  (msg.components || [])
    .flatMap((row) => row.components || [])
    .filter((c) => c.type === 2 && /::variation::\d/.test(c.custom_id || ''))
    .map((c) => ({ index: Number((c.custom_id.match(/variation::(\d)/) || [])[1]), custom_id: c.custom_id }));

// Click any MJ button (component interaction) on a message.
async function clickButton({ guildId, channelId, messageId, customId }) {
  await userApi('/interactions', {
    method: 'POST',
    body: {
      type: 3, // MESSAGE_COMPONENT
      application_id: MJ_APP_ID,
      guild_id: guildId,
      channel_id: channelId,
      message_id: messageId,
      session_id: rand(32),
      nonce: `${BigInt(Date.now() - 1420070400000) << 22n}`,
      data: { component_type: 2, custom_id: customId },
    },
  });
}

// Fetch a grid message the user token can't GET directly (bot-only) by listing around it.
async function getMessageAround(channelId, msgId) {
  const around = await userApi(`/channels/${channelId}/messages?around=${msgId}&limit=5`);
  const m = around.find((x) => x.id === msgId);
  if (!m) die(`message ${msgId} not found in channel`);
  return m;
}

// Find the finished grid: a NEW message (id > sinceId), authored by MJ, whose
// content references our prompt, that carries an attachment AND upscale buttons.
async function waitForGrid({ channelId, prompt, sinceId, timeoutMs }) {
  const needle = prompt.split('--')[0].trim().slice(0, 60).toLowerCase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await userApi(`/channels/${channelId}/messages?limit=15`);
    const hit = msgs.find(
      (m) =>
        newer(m.id, sinceId) &&
        m.author?.id === MJ_APP_ID &&
        (m.content || '').toLowerCase().includes(needle) &&
        (m.attachments || []).length > 0 &&
        upsampleButtons(m).length > 0
    );
    if (hit) return hit;
    // surface progress if MJ is mid-render
    const prog = msgs.find(
      (m) => newer(m.id, sinceId) && m.author?.id === MJ_APP_ID && (m.content || '').toLowerCase().includes(needle)
    );
    if (prog) {
      const pct = (prog.content.match(/\((\d+%)\)/) || [])[1] || (/waiting/i.test(prog.content) ? 'queued' : '…');
      process.stderr.write(`\r  rendering ${pct}   `);
    }
    await sleep(2500);
  }
  die('timed out waiting for the Midjourney grid');
}

// Click a U1–U4 button (component interaction), then wait for the upscaled image.
async function upscale({ guildId, channelId, gridMsg, index, timeoutMs }) {
  const btn = upsampleButtons(gridMsg).find((b) => b.index === index);
  if (!btn) { log(`  no U${index} button, skipping`); return null; }
  const sinceId = await latestMessageId(channelId);
  await userApi('/interactions', {
    method: 'POST',
    body: {
      type: 3, // MESSAGE_COMPONENT
      application_id: MJ_APP_ID,
      guild_id: guildId,
      channel_id: channelId,
      message_id: gridMsg.id,
      session_id: rand(32),
      nonce: `${BigInt(Date.now() - 1420070400000) << 22n}`,
      data: { component_type: 2, custom_id: btn.custom_id },
    },
  });
  const needle = (gridMsg.content.split('**')[1] || '').slice(0, 40).toLowerCase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await userApi(`/channels/${channelId}/messages?limit=15`);
    const hit = msgs.find(
      (m) =>
        newer(m.id, sinceId) &&
        m.author?.id === MJ_APP_ID &&
        (m.attachments || []).length > 0 &&
        upsampleButtons(m).length === 0 && // upscaled results have no U-buttons
        (needle ? (m.content || '').toLowerCase().includes(needle) : true)
    );
    if (hit) return hit.attachments[0];
    await sleep(2500);
  }
  log(`  U${index} timed out`);
  return null;
}

// ── download + repost ────────────────────────────────────────────────────────
async function download(url, dir, name) {
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const path = `${dir}/${name}`;
  await (await import('node:fs/promises')).writeFile(path, buf);
  return path;
}

async function repostToDiscord(channelId, files, caption) {
  if (!BOT_TOKEN) { log('  DISCORD_BOT_TOKEN not set — skipping repost'); return; }
  const fs = await import('node:fs/promises');
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: caption }));
  for (let i = 0; i < files.length; i++) {
    const data = await fs.readFile(files[i]);
    form.append(`files[${i}]`, new Blob([data], { type: 'image/png' }), files[i].split('/').pop());
  }
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${BOT_TOKEN}` },
    body: form,
  });
  if (!res.ok) log(`  repost failed: ${res.status} ${await res.text().catch(() => '')}`);
  else log(`  reposted ${files.length} image(s) to channel ${channelId}`);
}

// ── commands ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      a[k] = v;
    } else a._.push(argv[i]);
  }
  return a;
}

async function cmdImagine(args) {
  const prompt = args._.join(' ').trim();
  if (!prompt) die('usage: mj imagine "<prompt>" --channel <id>');
  const channelId = args.channel || process.env.MJ_CHANNEL_ID;
  if (!channelId) die('--channel <id> required (or set MJ_CHANNEL_ID)');
  const timeoutMs = (Number(args.timeout) || 240) * 1000;
  const outDir = args.out || './out';

  // resolve the guild for this channel
  const ch = await userApi(`/channels/${channelId}`);
  const guildId = ch.guild_id;
  if (!guildId) die('channel has no guild_id (is it a server text channel?)');

  const sinceId = await latestMessageId(channelId);
  log(`▸ /imagine ${prompt}`);
  await fireImagine({ guildId, channelId, prompt });
  const grid = await waitForGrid({ channelId, prompt, sinceId, timeoutMs });
  process.stderr.write('\r');
  log(`✓ grid ready (msg ${grid.id})`);

  // which upscales?
  let want = [];
  if (args['no-upscale']) want = [];
  else if (!args.upscale || args.upscale === 'all' || args.upscale === true) want = [1, 2, 3, 4];
  else want = String(args.upscale).split(',').map(Number).filter((n) => n >= 1 && n <= 4);

  const stamp = `${grid.id}`;
  const files = [];
  // the grid image itself
  files.push(await download(grid.attachments[0].url, outDir, `mj-${stamp}-grid.png`));
  log(`  ↓ grid → ${files[files.length - 1]}`);

  for (const i of want) {
    log(`  upscaling U${i}…`);
    const att = await upscale({ guildId, channelId, gridMsg: grid, index: i, timeoutMs });
    if (att) {
      const p = await download(att.url, outDir, `mj-${stamp}-u${i}.png`);
      files.push(p);
      log(`  ↓ U${i} → ${p}`);
    }
  }

  if (args['post-channel']) await repostToDiscord(args['post-channel'], files, `\`${prompt}\``);

  // stdout: machine-readable + Claude-readable paths
  console.log(JSON.stringify({ prompt, gridMessageId: grid.id, files }, null, 2));
}

// Upscale a specific tile of an already-generated grid (the "I picked tile N"
// step of the art-director loop). Fetches the grid message for its buttons.
async function cmdUpscale(args) {
  const channelId = args.channel || process.env.MJ_CHANNEL_ID;
  const msgId = args.message || args.msg;
  const index = Number(args.index ?? args._[0]);
  if (!channelId || !msgId || !(index >= 1 && index <= 4))
    die('usage: mj upscale --channel <id> --message <gridId> --index <1-4>');
  const guildId = (await userApi(`/channels/${channelId}`)).guild_id;
  const gridMsg = await getMessageAround(channelId, msgId);
  const timeoutMs = (Number(args.timeout) || 280) * 1000;
  log(`  upscaling U${index} of grid ${msgId}…`);
  const att = await upscale({ guildId, channelId, gridMsg, index, timeoutMs });
  if (!att) die('upscale failed (no result / no button)');
  const p = await download(att.url, args.out || './out', `mj-${msgId}-u${index}.png`);
  log(`  ↓ U${index} → ${p}`);
  if (args['post-channel']) await repostToDiscord(args['post-channel'], [p], `U${index} of \`${msgId}\``);
  console.log(JSON.stringify({ file: p }, null, 2));
}

// Vary a tile → a NEW grid (branch the concept tree). Returns the new grid id
// so it can itself be upscaled or varied further.
async function cmdVary(args) {
  const channelId = args.channel || process.env.MJ_CHANNEL_ID;
  const msgId = args.message || args.msg;
  const index = Number(args.index ?? args._[0]);
  if (!channelId || !msgId || !(index >= 1 && index <= 4))
    die('usage: mj vary --channel <id> --message <gridId> --index <1-4>');
  const guildId = (await userApi(`/channels/${channelId}`)).guild_id;
  const gridMsg = await getMessageAround(channelId, msgId);
  const btn = variationButtons(gridMsg).find((b) => b.index === index);
  if (!btn) die(`no V${index} button on message ${msgId}`);
  const needle = (gridMsg.content.split('**')[1] || '').slice(0, 40).toLowerCase();
  const sinceId = await latestMessageId(channelId);
  log(`  varying V${index} of grid ${msgId}…`);
  await clickButton({ guildId, channelId, messageId: gridMsg.id, customId: btn.custom_id });
  const deadline = Date.now() + (Number(args.timeout) || 280) * 1000;
  while (Date.now() < deadline) {
    const msgs = await userApi(`/channels/${channelId}/messages?limit=15`);
    const hit = msgs.find(
      (m) =>
        newer(m.id, sinceId) &&
        m.author?.id === MJ_APP_ID &&
        (m.attachments || []).length > 0 &&
        upsampleButtons(m).length > 0 && // a fresh grid (has U-buttons)
        (needle ? (m.content || '').toLowerCase().includes(needle) : true)
    );
    if (hit) {
      const p = await download(hit.attachments[0].url, args.out || './out', `mj-${hit.id}-grid.png`);
      log(`  ↓ variation grid → ${p} (new grid ${hit.id})`);
      if (args['post-channel']) await repostToDiscord(args['post-channel'], [p], `V${index} of ${msgId}`);
      console.log(JSON.stringify({ newGridMessageId: hit.id, file: p }, null, 2));
      return;
    }
    await sleep(2500);
  }
  die('vary timed out');
}

async function cmdGuilds() {
  const gs = await userApi('/users/@me/guilds');
  console.log(JSON.stringify(gs.map((g) => ({ id: g.id, name: g.name })), null, 2));
}

async function cmdChannels(args) {
  let gid = args.guild;
  if (!gid) die('--guild <id|name-substr> required');
  if (!/^\d+$/.test(gid)) {
    const gs = await userApi('/users/@me/guilds');
    const m = gs.find((g) => g.name.toLowerCase().includes(String(gid).toLowerCase()));
    if (!m) die(`no guild matching "${gid}"`);
    gid = m.id;
  }
  const chs = await userApi(`/guilds/${gid}/channels`);
  console.log(JSON.stringify(
    chs.filter((c) => c.type === 0).map((c) => ({ id: c.id, name: c.name })),
    null, 2
  ));
}

// List every application command visible in a channel + which app owns it.
// Handy for disambiguating name collisions (e.g. disrupt's /imagine vs MJ's).
async function cmdCommands(args) {
  let guildId = args.guild;
  if (!guildId) {
    const channelId = args.channel || process.env.MJ_CHANNEL_ID;
    if (!channelId) die('--guild <id> or --channel <id> required');
    guildId = (await userApi(`/channels/${channelId}`)).guild_id;
    if (!guildId) die('channel has no guild_id');
  }
  const q = args._.join(' ').trim().toLowerCase();
  const res = await fetch(`${API}/guilds/${guildId}/application-command-index`, {
    headers: { Authorization: USER_TOKEN, 'User-Agent': UA },
  });
  if (!res.ok) die(`command index → ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const appName = Object.fromEntries((data.applications || []).map((a) => [a.id, a.name]));
  const rows = (data.application_commands || [])
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .map((c) => ({
      name: c.name,
      app: appName[c.application_id] || c.application_id,
      application_id: c.application_id,
      isMidjourney: c.application_id === MJ_APP_ID,
    }));
  console.log(JSON.stringify(rows, null, 2));
}

function cmdSetup() {
  log(`
mj — fire Midjourney's /imagine in your Discord server, download the PNGs, and
hand the pixels back to Claude via Read. Not an official bot: MJ has no API and
a Discord bot can't invoke another bot's slash command, so this uses a USER
token (self-bot, against ToS — Nick's explicit risk-aware call).
Loop: imagine "<prompt>" --channel <id> → grid → upscale/vary --message <gridId> --index N.
⚠ BLAST-RADIUS: every imagine/upscale/vary spends an MJ credit — cap autonomous loops.

mj setup — one-time
  1. DISCORD_USER_TOKEN (self-bot; your Midjourney account):
     Discord in a browser → DevTools (Cmd+Opt+I) → Network tab → filter "science"
     or click any request → Headers → copy the "authorization" value.
     Add to ~/.claude/.env:   DISCORD_USER_TOKEN=<paste>
  2. (optional) DISCORD_BOT_TOKEN — your official bot, for --post-channel reposts.
  3. Find your Midjourney channel:
       source ~/.claude/.env
       node mj.mjs guilds
       node mj.mjs channels --guild "<server name>"
     then use --channel <id> (or set MJ_CHANNEL_ID in ~/.claude/.env).
  ⚠ The user token is a self-bot credential. Keep it in ~/.claude/.env, never commit it.
`);
}

// ── main ──────────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);
const run = {
  imagine: () => cmdImagine(args),
  guilds: () => cmdGuilds(),
  channels: () => cmdChannels(args),
  commands: () => cmdCommands(args),
  upscale: () => cmdUpscale(args),
  vary: () => cmdVary(args),
  setup: () => cmdSetup(),
  help: () => cmdSetup(),
}[cmd];
if (!run) { log('commands: imagine | guilds | channels | setup'); process.exit(1); }
run().catch((e) => die(e.message));
