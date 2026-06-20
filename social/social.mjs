#!/usr/bin/env node
// social — harvest your social graph into structured records for the community graph.
//
// Design: the "slippery" approach. Rather than scrape rendered DOM (fragile, and
// FB/LinkedIn killed their plain-HTML views), we drive a logged-in Playwright
// session to the site's own ORIGIN, then call the site's INTERNAL JSON API with
// an in-page fetch() — same-origin, cookies sent automatically, clean JSON back.
// Pagination happens in-page. No DOM parsing where an API exists.
//
// Each network is a pluggable BACKEND sharing one harness (auth storage + page +
// harvest()). Auth is a one-time interactive Playwright login per network (saved
// storageState), reusing the existing `playwright` cli-tool's tokens dir.
//
// Usage:
//   social <network> <command> [--limit N] [--out FILE] [--json] [--storage LABEL] [--headed]
//   social auth <network>                 # one-time interactive login (his hands: pw + 2FA)
//   social networks                       # list backends + readiness
//
// Examples:
//   social linkedin connections --limit 500 --out ~/Downloads/li.ndjson
//   social facebook friends --json
//   social meetup members --group ai-ml-robots
//   social luma guests --event <slug>

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";

const TOKENS = `${homedir()}/.claude/cli-tools/.tokens/playwright`;
const storagePath = (label) => `${TOKENS}/${label}.json`;

// ── Backend registry ─────────────────────────────────────────────────────────
const BACKENDS = {
  linkedin: {
    storage: "linkedin",
    authUrl: "https://www.linkedin.com/login",
    origin: "https://www.linkedin.com/feed/",
    commands: { connections: harvestLinkedInConnections },
  },
  facebook: {
    storage: "messenger-fb", // reuse the existing FB session
    authUrl: "https://www.facebook.com/",
    origin: "https://www.facebook.com/",
    commands: { friends: harvestFacebookFriends, enrich: enrichFacebookProfiles },
  },
  meetup: {
    storage: "meetup",
    authUrl: "https://www.meetup.com/login/",
    origin: "https://www.meetup.com/",
    commands: { members: harvestMeetupMembers },
  },
  luma: {
    storage: "luma",
    authUrl: "https://lu.ma/signin",
    origin: "https://lu.ma/home",
    commands: { guests: harvestLumaGuests },
  },
};

// ── LinkedIn: Voyager internal API ───────────────────────────────────────────
// /voyager/api/relationships/...connections returns normalized JSON. Auth header
// `csrf-token` = the JSESSIONID cookie value (LinkedIn's own convention).
async function harvestLinkedInConnections(page, opts) {
  await page.goto(BACKENDS.linkedin.origin, { waitUntil: "domcontentloaded" });
  return page.evaluate(async (limit) => {
    const m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    if (!m) return { error: "no JSESSIONID cookie — session invalid? re-run `social auth linkedin`" };
    const headers = {
      "csrf-token": m[1],
      accept: "application/vnd.linkedin.normalized+json+2.1",
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
    };
    // Try modern dash endpoint first, fall back to legacy connectionsV2.
    const endpoints = [
      (start, count) =>
        `https://www.linkedin.com/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=${count}&q=search&sortType=RECENTLY_ADDED&start=${start}`,
      (start, count) =>
        `https://www.linkedin.com/voyager/api/relationships/connectionsV2?count=${count}&start=${start}`,
    ];
    let tmpl = null;
    for (const e of endpoints) {
      const r = await fetch(e(0, 1), { headers, credentials: "include" });
      if (r.ok) { tmpl = e; break; }
    }
    if (!tmpl) return { error: "all Voyager endpoints rejected (decorationId may have rotated) — needs a fresh decorationId" };

    const out = [];
    let start = 0; const count = 40;
    while (out.length < limit) {
      const res = await fetch(tmpl(start, count), { headers, credentials: "include" });
      if (!res.ok) return { partial: out, error: `HTTP ${res.status} at start=${start}` };
      const json = await res.json();
      const profiles = (json.included || []).filter((x) =>
        String(x.$type || "").includes("identity.profile.Profile") && (x.firstName || x.lastName));
      if (!profiles.length) break;
      for (const p of profiles) {
        out.push({
          name: [p.firstName, p.lastName].filter(Boolean).join(" "),
          headline: p.headline || "",
          publicIdentifier: p.publicIdentifier || "",
          profileUrl: p.publicIdentifier ? `https://www.linkedin.com/in/${p.publicIdentifier}/` : "",
        });
      }
      start += count;
      if (profiles.length < count) break;
      await new Promise((r) => setTimeout(r, 600)); // human-paced
    }
    return { records: out.slice(0, limit) };
  }, opts.limit);
}

// ── Facebook: friends ────────────────────────────────────────────────────────
// FB killed mbasic/m HTML views (they redirect to React www). No clean public
// friends API. v1: drive the React friends page, auto-scroll, extract profile
// anchors. Best-effort + dedupe; refine selectors against real output.
async function harvestFacebookFriends(page, opts) {
  // resolve own id from the session cookie
  const id = "729089306"; // c_user; could be read from context cookies if needed
  await page.goto(`https://www.facebook.com/${id}/friends`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // auto-scroll until the anchor count stabilises (all friends loaded)
  let prev = -1, stable = 0;
  for (let i = 0; i < 80 && stable < 4; i++) {
    const n = await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      return document.querySelectorAll("a[href]").length;
    });
    await page.waitForTimeout(1100);
    if (n === prev) stable++; else { stable = 0; prev = n; }
    if (opts.limit && opts.limit < 9999 && prev > opts.limit * 3) break;
  }
  const records = await page.evaluate((selfId) => {
    const RESERVED = new Set("notifications afad friends photos about posts reels groups watch gaming marketplace events bookmarks me login settings pages help policies business ads stories messages profile.php story.php nick.meinhold".split(" "));
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="facebook.com/"]')) {
      const name = (a.textContent || "").trim();
      if (!name || name.length < 2 || name.length > 50) continue;
      if (/login|approved|unread|notification/i.test(name)) continue;
      const href = a.href;
      let key, profileUrl;
      const pm = href.match(/profile\.php\?id=(\d+)/);
      if (pm) {
        if (pm[1] === selfId) continue;
        key = "id:" + pm[1]; profileUrl = "https://www.facebook.com/profile.php?id=" + pm[1];
      } else {
        const vm = href.match(/facebook\.com\/([a-zA-Z0-9.]{3,})(?:[/?#]|$)/);
        if (!vm) continue;
        const slug = vm[1].toLowerCase();
        if (RESERVED.has(slug) || slug.endsWith(".php")) continue;
        key = "slug:" + slug; profileUrl = "https://www.facebook.com/" + vm[1];
      }
      if (!seen.has(key)) seen.set(key, { name, profileUrl });
    }
    return [...seen.values()];
  }, id);
  return { records: opts.limit ? records.slice(0, opts.limit) : records, note: "FB v1 DOM-extract — verify against profile count (324 expected); refine selectors if noisy" };
}

// ── Facebook: profile enrichment (gated deeper crawl) ────────────────────────
// Reads a harvested friends NDJSON (--in) and visits each profile to extract the
// public "Intro" fields (Lives in / From / Works at / Studied). This is the
// FILTER step: enrich → tag Melbourne/tech signal → Nick approves per node.
// SAFEGUARDS: human-paced (jittered delay per profile), CHECKPOINTED/RESUMABLE
// (each record is appended to --out as it completes; a re-run skips done keys),
// and 1st-degree ONLY (your own friends — does NOT recurse into their networks).
// Extraction anchors on stable user-visible LABEL TEXT, not FB's churning CSS.
const MELB_RE = /(Melbourne|Victoria|VIC\b|Bendigo|Geelong|Ballarat|Richmond|Fitzroy|Brunswick|Footscray)/i;
// NB: short acronyms get \b on BOTH sides — "viCTOria" contains "cto", "AustrAlIa" etc.
const TECH_RE = /(Engineer|Developer|Software|Founder|\bCTO\b|\bCEO\b|\bData\b|\bAI\b|Machine Learning|Robot|Maker|Startup|\bTech\b|Programmer|Designer|Hacker|Scientist|University|RMIT|Monash|Deakin|Swinburne)/i;
const INTRO_RE = /^(Lives in|Lived in|From |Works at|Worked at|Studied|Studies at|Went to|Founder|Co-founder|CEO|CTO)/i;

async function enrichFacebookProfiles(page, opts) {
  const inFile = (opts.in || "").replace(/^~/, homedir());
  if (!inFile || !existsSync(inFile)) return { error: "pass --in <harvested-friends.ndjson>" };
  const outFile = (opts.out || "").replace(/^~/, homedir());
  if (!outFile) return { error: "pass --out <enriched.ndjson> (also the resumable checkpoint)" };

  const friends = readFileSync(inFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // resume: load already-enriched profileUrls from the checkpoint
  const done = new Set();
  if (existsSync(outFile)) {
    for (const l of readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean)) {
      try { done.add(JSON.parse(l).profileUrl); } catch {}
    }
  }
  const queue = friends.filter((f) => !done.has(f.profileUrl)).slice(0, opts.limit || 99999);
  const minMs = parseInt(opts.min || 3000, 10), maxMs = parseInt(opts.max || 6500, 10);
  console.error(`enrich: ${friends.length} friends, ${done.size} already done, ${queue.length} to go (delay ${minMs}-${maxMs}ms)`);

  let i = 0;
  for (const f of queue) {
    i++;
    let rec = { ...f, intro: [], lives: "", melbourne: false, tech: false, enrichedAt: opts.now || "" };
    try {
      await page.goto(f.profileUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(3200);
      const intro = await page.evaluate(() => {
        const RE = /^(Lives in|Lived in|From |Works at|Worked at|Studied|Studies at|Went to|Founder|Co-founder|CEO|CTO)/i;
        const hits = new Set();
        for (const el of document.querySelectorAll("span, div")) {
          if (el.children.length) continue; // leaf nodes only
          const t = (el.textContent || "").trim();
          if (t.length > 3 && t.length < 90 && RE.test(t)) hits.add(t);
        }
        return [...hits].slice(0, 10);
      });
      rec.intro = intro;
      const livesLine = intro.find((s) => /^Lives in/i.test(s)) || intro.find((s) => /^From /i.test(s)) || "";
      rec.lives = livesLine.replace(/^(Lives in|From )/i, "").trim();
      const blob = intro.join(" | ");
      rec.melbourne = MELB_RE.test(blob);
      rec.tech = TECH_RE.test(blob);
    } catch (e) {
      rec.error = (e.message || String(e)).split("\n")[0].slice(0, 120);
    }
    appendFileSync(outFile, JSON.stringify(rec) + "\n");
    if (i % 10 === 0 || rec.melbourne) console.error(`  [${i}/${queue.length}] ${f.name}${rec.lives ? " — " + rec.lives : ""}${rec.melbourne ? " ★MELB" : ""}`);
    await page.waitForTimeout(minMs + Math.floor((maxMs - minMs) * 0.5)); // base
    await page.waitForTimeout(Math.floor((maxMs - minMs) * 0.5 * (i % 7) / 7)); // deterministic jitter (Math.random banned in some envs)
  }
  // final pass: read the full checkpoint back as the result set
  const records = readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const melb = records.filter((r) => r.melbourne).length;
  return { records, note: `enriched ${records.length} profiles; ${melb} tagged Melbourne. Checkpoint = ${outFile}`, alreadyWritten: true };
}

// ── Meetup: group members (scaffold) ─────────────────────────────────────────
// Meetup has a GraphQL API at /gql. Group members for groups you belong to are
// queryable when logged in. AMR group urlname: `ai-ml-robots`.
async function harvestMeetupMembers(page, opts) {
  if (!opts.group) return { error: "pass --group <urlname> (e.g. ai-ml-robots)" };
  return {
    error: "meetup backend scaffolded, not yet implemented",
    todo: `Auth: social auth meetup. Then POST https://www.meetup.com/gql with the members(groupUrlname:\"${opts.group}\") query + the page's csrf. Same in-page fetch pattern as linkedin.`,
  };
}

// ── Luma: event guests (scaffold) ────────────────────────────────────────────
// lu.ma exposes /api/... JSON to event HOSTS. Guest list for an event you host:
// GET https://lu.ma/api/event/get-guests?event_api_id=... (host session required).
async function harvestLumaGuests(page, opts) {
  if (!opts.event) return { error: "pass --event <slug-or-api-id>" };
  return {
    error: "luma backend scaffolded, not yet implemented",
    todo: `Auth: social auth luma. Then in-page fetch https://lu.ma/api/event/get-guests?event_api_id=${opts.event}. Host-only data; same pattern.`,
  };
}

// ── Auth helper ──────────────────────────────────────────────────────────────
async function cmdAuth(network) {
  const be = BACKENDS[network];
  if (!be) die(`unknown network '${network}'. one of: ${Object.keys(BACKENDS).join(", ")}`);
  console.error(`Opening a headed browser at ${be.authUrl}. Log in (password + 2FA), then close the window with the red X to save the session to ${storagePath(be.storage)}.`);
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(be.authUrl);
  // wait for the user to finish + close
  await page.waitForEvent("close", { timeout: 0 }).catch(() => {});
  await ctx.storageState({ path: storagePath(be.storage) });
  await browser.close();
  console.error(`Saved ${network} session → ${storagePath(be.storage)}`);
}

// ── Harness ──────────────────────────────────────────────────────────────────
function die(msg) { console.error(`social: ${msg}`); process.exit(2); }

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      flags[k] = v;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [network, command] = pos;

  if (!network || network === "help") {
    console.error(`social <network> <command> [--limit N] [--out FILE] [--json] [--headed]
networks: ${Object.keys(BACKENDS).join(", ")}
  linkedin connections   facebook friends   meetup members --group X   luma guests --event Y
  social auth <network>   social networks`);
    process.exit(0);
  }
  if (network === "networks") {
    for (const [n, be] of Object.entries(BACKENDS)) {
      const ready = existsSync(storagePath(be.storage));
      console.log(`${ready ? "✓" : "✗"} ${n.padEnd(9)} storage=${be.storage.padEnd(13)} cmds=[${Object.keys(be.commands).join(",")}]${ready ? "" : "  → run: social auth " + n}`);
    }
    return;
  }
  if (network === "auth") return cmdAuth(command);

  const be = BACKENDS[network];
  if (!be) die(`unknown network '${network}'. one of: ${Object.keys(BACKENDS).join(", ")}`);
  const harvest = be.commands[command];
  if (!harvest) die(`unknown command '${command}' for ${network}. one of: ${Object.keys(be.commands).join(", ")}`);

  const sp = storagePath(be.storage);
  if (!existsSync(sp)) die(`no ${network} session at ${sp}. run: social auth ${network}`);

  const limit = flags.limit ? parseInt(flags.limit, 10) : 99999;
  const browser = await chromium.launch({ headless: !flags.headed });
  let result;
  try {
    const ctx = await browser.newContext({ storageState: sp });
    const page = await ctx.newPage();
    result = await harvest(page, { limit, group: flags.group, event: flags.event, in: flags.in, out: flags.out, min: flags.min, max: flags.max });
  } finally {
    await browser.close();
  }

  if (result.error) { console.error(`social ${network} ${command}: ${result.error}`); if (result.todo) console.error("  " + result.todo); }
  const records = result.records || result.partial || [];
  if (result.note) console.error(`note: ${result.note}`);
  console.error(`${records.length} record(s) from ${network} ${command}`);

  if (flags.out && !result.alreadyWritten) {
    const body = flags.json ? JSON.stringify(records, null, 2) : records.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(flags.out.replace(/^~/, homedir()), body + "\n");
    console.error(`wrote → ${flags.out}`);
  } else if (flags.out && result.alreadyWritten) {
    console.error(`checkpoint → ${flags.out.replace(/^~/, homedir())}`);
  } else if (records.length) {
    console.log(flags.json ? JSON.stringify(records, null, 2) : records.map((r) => JSON.stringify(r)).join("\n"));
  }
  if (result.error) process.exit(1);
}

main().catch((e) => { console.error("social: " + (e?.stack || e?.message || e)); process.exit(1); });
