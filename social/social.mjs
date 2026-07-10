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

const TOKENS = `${homedir()}/git/tools/cli-tools/.tokens/playwright`;
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
    commands: { members: harvestMeetupMembers, list: harvestMeetupList, create: harvestMeetupCreate, edit: harvestMeetupEdit, delete: harvestMeetupDelete },
  },
  luma: {
    storage: "luma",
    authUrl: "https://lu.ma/signin",
    origin: "https://lu.ma/home",
    commands: { guests: harvestLumaGuests, list: harvestLumaEvents, create: harvestLumaCreate, edit: harvestLumaEdit, "change-photo": harvestLumaChangePhoto, delete: harvestLumaDelete },
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

// ── Meetup: group members ────────────────────────────────────────────────────
// Meetup has a GraphQL API at /gql. Members of a group you belong to are queryable
// via groupByUrlname.memberships when logged in (cookies carry auth). AMR urlname:
// `ai-ml-robots`. UNVERIFIED until run against a real `social auth meetup` session:
// the GraphQL schema (field names, memberships input args) is a best-effort guess —
// run with `--raw` on the first authed call to dump the live response and correct it.
async function harvestMeetupMembers(page, opts) {
  if (!opts.group) return { error: "pass --group <urlname> (e.g. ai-ml-robots — the meetup.com/<urlname> slug)" };
  await page.goto(BACKENDS.meetup.origin, { waitUntil: "domcontentloaded" });
  return page.evaluate(async ({ group, limit, raw }) => {
    // Meetup migrated the GraphQL endpoint to /gql2 and reshaped the schema:
    // memberships takes args directly (not input:{}), returns totalCount (not count),
    // and PhotoInfo has no `source` field. Verified live 2026-07-01.
    const query = `query($urlname:String!,$first:Int!,$after:String){
      groupByUrlname(urlname:$urlname){
        id name
        memberships(first:$first, after:$after){
          totalCount
          pageInfo{ hasNextPage endCursor }
          edges{ node{ id name memberUrl } }
        }
      }
    }`;
    const out = []; let after = null, hasNext = true, sample = null, guard = 0;
    while (out.length < limit && hasNext && guard < 200) {
      guard++;
      const r = await fetch("https://www.meetup.com/gql2", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables: { urlname: group, first: 50, after } }),
      });
      if (!r.ok) return { error: `HTTP ${r.status} from meetup /gql2 (endpoint moved? schema differs — run --raw to inspect). body: ${(await r.text()).slice(0, 200)}`, partial: out };
      const j = await r.json();
      if (!sample) sample = j;
      if (j.errors) return { error: `GraphQL error: ${JSON.stringify(j.errors).slice(0, 300)}`, partial: out, rawSample: raw ? j : undefined };
      const ms = j.data && j.data.groupByUrlname && j.data.groupByUrlname.memberships;
      if (!ms) return { error: "no .data.groupByUrlname.memberships in response — schema differs (run --raw to inspect)", partial: out, rawSample: raw ? j : undefined };
      for (const e of ms.edges || []) {
        const n = e.node || {};
        out.push({ name: n.name || "", profileUrl: n.memberUrl || "", email: n.email || "", id: n.id || "" });
      }
      hasNext = !!(ms.pageInfo && ms.pageInfo.hasNextPage);
      after = ms.pageInfo && ms.pageInfo.endCursor;
      if (!hasNext || !(ms.edges || []).length) break;
    }
    return raw ? { records: out.slice(0, limit), rawSample: sample } : { records: out.slice(0, limit) };
  }, { group: opts.group, limit: opts.limit, raw: !!opts.raw });
}

// Pick a date in Meetup's calendar-picker. The day cells expose full descriptive
// aria-labels ("Sunday, July 12th, 2026"), so we navigate by SEMANTIC label, not
// grid geometry: read the current month off a cell, click Next/Previous Month to
// the target month, click the day by label, then confirm with "Select".
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
async function pickMeetupDate(page, dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return { ok: false, err: `--date "${dateStr}" is not a parseable date (use YYYY-MM-DD)` };
  const monthName = MONTHS[d.getMonth()], day = d.getDate(), year = d.getFullYear();
  const targetLabel = `${monthName} ${ordinal(day)}, ${year}`; // "July 12th, 2026"
  const targetIdx = year * 12 + d.getMonth();
  const dateBtn = page.locator("button", { hasText: /^\w{3},\s\w{3}\s\d{1,2}$/ }).first();
  if (!(await dateBtn.isVisible().catch(() => false))) return { ok: false, err: "date button not found on the create form" };
  await dateBtn.click();
  await page.waitForTimeout(1000);
  // Navigate to the target month (bounded).
  for (let i = 0; i < 30; i++) {
    const cur = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button[aria-label]")).find((x) => /\b15th,\s20\d\d/.test(x.getAttribute("aria-label") || ""));
      const m = b && (b.getAttribute("aria-label") || "").match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+15th,\s+(20\d\d)/);
      return m ? { month: m[1], year: +m[2] } : null;
    });
    if (!cur) break;
    const curIdx = cur.year * 12 + MONTHS.indexOf(cur.month);
    if (curIdx === targetIdx) break;
    const nav = curIdx < targetIdx ? "Go to the Next Month" : "Go to the Previous Month";
    await page.getByRole("button", { name: nav }).first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
  const dayBtn = page.locator(`button[aria-label*="${monthName} ${ordinal(day)}, ${year}"]`).first();
  if (!(await dayBtn.isVisible().catch(() => false))) return { ok: false, err: `could not find day cell for ${targetLabel}` };
  // Clicking the day sets the date and leaves the form usable. Do NOT click the
  // calendar's "Select" button — it opens a spurious modal that hides the form.
  await dayBtn.click();
  await page.waitForTimeout(600);
  return { ok: true };
}

// ── Meetup: list a group's events ────────────────────────────────────────────
// Ported from events-mcp meetup_list_events; its [id^="event-card"] selector is
// stale. Same robust idiom as luma list: each event is an <a> to /events/<id>;
// walk up to the card and read its text ([Manage, <status>, title, "Sat, Jul 11
// · 3:00 PM AEST", venue]). Probed live 2026-07-04.
//   social meetup list --group <url-name>
async function harvestMeetupList(page, opts) {
  const group = typeof opts.group === "string" ? opts.group : "";
  if (!group) return { error: "pass --group <url-name> (the meetup.com/<url-name> slug)" };
  await page.goto(`https://www.meetup.com/${group}/events/`, { waitUntil: "domcontentloaded" });
  return page.evaluate(async ({ group, limit }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(4500);
    const isStatus = (s) => /^(Manage|Going|Not Going|Attending|Waitlist(ed)?|Host|You're going|·)$/i.test(s);
    const isWhen = (s) => /\b\w{3},\s\w{3}\s\d{1,2}\b/.test(s) || /\d{1,2}:\d{2}\s?(AM|PM)\b/i.test(s);
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll(`a[href*="/${group}/events/"]`)) {
      if (out.length >= limit) break;
      const m = (a.getAttribute("href") || "").match(/\/events\/(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      let card = a;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        if ((card.innerText || "").split("\n").filter((l) => l.trim()).length >= 3) break;
      }
      const lines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      seen.add(id);
      const when = lines.find(isWhen) || "";
      const title = lines.find((l) => !isStatus(l) && l !== when && !isWhen(l) && l.length > 3) || "";
      let venue = "";
      const wi = lines.indexOf(when);
      if (wi >= 0) { for (const l of lines.slice(wi + 1)) { if (l === "·" || isStatus(l)) continue; venue = l; break; } }
      out.push({ id, title, when, venue, url: `https://www.meetup.com/${group}/events/${id}/` });
    }
    return { records: out };
  }, { group, limit: opts.limit });
}

// ── Meetup: create an event ──────────────────────────────────────────────────
// The organizer create form lives at meetup.com/<group>/schedule/ (events-mcp's
// guessed /events/create/ 404s today), reachable by direct nav — no button/menu
// dance. Real hooks probed live 2026-07-04: title=[data-testid=event-name-input],
// time=[aria-label="Edit start time"], description=contenteditable,
// location=input[placeholder="Search or add location..."], submit="Save as
// draft" | "Publish". Defaults to a DRAFT (private) — pass --publish to go live.
// Meetup REQUIRES a date to save even a draft; --date drives the calendar-picker
// (see pickMeetupDate).
//   social meetup create --group <url-name> --title "X" --date 2026-07-12
//     [--description "…" --start-time 18:00 --location "…" --publish]
async function harvestMeetupCreate(page, opts) {
  const group = typeof opts.group === "string" ? opts.group : "";
  const title = typeof opts.title === "string" ? opts.title : "";
  const description = typeof opts.description === "string" ? opts.description : "";
  // Meetup blocks the save unless title, date AND a non-empty description are set.
  if (!group || !title || !opts.date || !description) return { error: 'pass --group <url-name> --title "Event name" --date YYYY-MM-DD --description "…" (Meetup requires all three; optional: --start-time 18:00 --location "…" --publish)' };
  await page.goto(`https://www.meetup.com/${group}/schedule/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // Meetup opens /schedule/ behind a "Start from" modal (Duplicate last event /
  // Start from scratch) whose blur overlay intercepts ALL form input — the
  // silent-failure culprit. Dismiss it before touching the form.
  const scratch = page.getByRole("button", { name: "Start from scratch" }).first();
  if (await scratch.isVisible().catch(() => false)) { await scratch.click(); await page.waitForTimeout(2000); }
  const titleInput = page.locator('[data-testid="event-name-input"]');
  await titleInput.waitFor({ timeout: 15000 });
  await titleInput.fill(title);

  // Description is a ProseMirror rich-text editor — it ignores .fill(), and there
  // are two instances where the FIRST is hidden. Target the visible one and TYPE
  // so the editor's model actually updates (empty description → save blocked).
  const eds = page.locator("div.ProseMirror");
  const nEds = await eds.count();
  for (let i = 0; i < nEds; i++) {
    const ed = eds.nth(i);
    if (await ed.isVisible().catch(() => false)) {
      // insertText dispatches the whole string as ONE input event — fast, and
      // ProseMirror still updates its model (char-by-char typing times out on
      // long descriptions).
      await ed.click();
      await page.keyboard.insertText(description);
      break;
    }
  }
  const st = opts["start-time"] || opts.startTime;
  if (st) {
    const timeInput = page.locator('[aria-label="Edit start time"]').first();
    if (await timeInput.isVisible().catch(() => false)) { await timeInput.fill(String(st)); await page.keyboard.press("Escape").catch(() => {}); }
  }
  if (typeof opts.date === "string" && opts.date) {
    const r = await pickMeetupDate(page, opts.date);
    if (!r.ok) return { error: r.err };
  }
  if (typeof opts.location === "string" && opts.location) {
    const loc = page.locator('input[placeholder="Search or add location..."]').first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(opts.location); await page.waitForTimeout(1500);
      const opt = page.locator('[role="option"]').first();
      if (await opt.isVisible().catch(() => false)) await opt.click();
    }
  }

  const publish = opts.publish === true || opts.publish === "true";
  const btnName = publish ? "Publish" : "Save as draft";
  const submit = page.getByRole("button", { name: btnName }).first();
  await submit.waitFor({ timeout: 5000 });
  await submit.click();
  await page.waitForTimeout(5000);
  const url = page.url();
  const m = url.match(/\/events\/(\d+)/);
  // A successful save navigates AWAY from /schedule/ — to the event page
  // (/events/<id>) when published, or to /events/drafts/ when saved as a draft.
  // Still on /schedule/ = Meetup rejected the form; report the real state instead
  // of a false success (acknowledgement ≠ effect).
  if (/\/schedule\/?($|\?)/.test(url) && !m) {
    return { error: `save blocked — Meetup rejected the form (a required field didn't register). Still on /schedule/. Check title/date/description.` };
  }
  return { records: [{ title, id: m ? m[1] : "", url, published: publish }], note: `Meetup event ${publish ? "published" : "saved as draft"}: ${url}` };
}

// ── Meetup: edit an event ────────────────────────────────────────────────────
// The edit form at /events/<id>/edit/ mirrors the create form (same hooks) but
// has NO "Start from scratch" modal. Only provided fields are touched. Description
// is the visible ProseMirror — select-all + delete before insertText to replace.
// Probed live 2026-07-04. Saves via "Save as draft" (default) or "Publish".
//   social meetup edit --group <url-name> --event <numeric-id> [--title "…"
//     --description "…" --date YYYY-MM-DD --start-time 18:00 --location "…" --publish]
async function harvestMeetupEdit(page, opts) {
  const group = typeof opts.group === "string" ? opts.group : "";
  let id = typeof opts.event === "string" ? opts.event : (typeof opts.id === "string" ? opts.id : "");
  if (!id && typeof opts.url === "string") { const m = opts.url.match(/\/events\/(\d+)/); if (m) id = m[1]; }
  if (!group || !/^\d+$/.test(String(id))) return { error: "pass --group <url-name> --event <numeric-id> and at least one field to change" };
  await page.goto(`https://www.meetup.com/${group}/events/${id}/edit/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const titleInput = page.locator('[data-testid="event-name-input"]');
  if (!(await titleInput.isVisible().catch(() => false))) return { error: `edit form for event ${id} not found — deleted, or not an event you manage?` };

  const updated = [];
  if (typeof opts.title === "string" && opts.title) { await titleInput.fill(opts.title); updated.push("title"); }
  if (typeof opts.description === "string" && opts.description) {
    const eds = page.locator("div.ProseMirror");
    const n = await eds.count();
    for (let i = 0; i < n; i++) {
      const ed = eds.nth(i);
      if (await ed.isVisible().catch(() => false)) {
        await ed.click();
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.press("Backspace");
        await page.keyboard.insertText(opts.description);
        updated.push("description");
        break;
      }
    }
  }
  if (typeof opts.date === "string" && opts.date) { const r = await pickMeetupDate(page, opts.date); if (!r.ok) return { error: r.err }; updated.push("date"); }
  const st = opts["start-time"] || opts.startTime;
  if (st) { const t = page.locator('[aria-label="Edit start time"]').first(); if (await t.isVisible().catch(() => false)) { await t.fill(String(st)); await page.keyboard.press("Escape").catch(() => {}); updated.push("start-time"); } }
  if (typeof opts.location === "string" && opts.location) {
    const loc = page.locator('input[placeholder="Search or add location..."]').first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(opts.location); await page.waitForTimeout(1500);
      const o = page.locator('[role="option"]').first();
      if (await o.isVisible().catch(() => false)) await o.click();
      updated.push("location");
    }
  }
  if (!updated.length) return { error: "no fields changed — pass --title/--description/--date/--start-time/--location" };

  const publish = opts.publish === true || opts.publish === "true";
  const submit = page.getByRole("button", { name: publish ? "Publish" : "Save as draft" }).first();
  await submit.waitFor({ timeout: 5000 });
  await submit.click();
  await page.waitForTimeout(4000);
  if (/\/edit\/?($|\?)/.test(page.url())) return { error: `save blocked — still on the edit page (a required field may be empty).` };
  return { records: [{ id, updated }], note: `Meetup event updated (${updated.join(", ")}): ${id}` };
}

// ── Meetup: delete an event ──────────────────────────────────────────────────
// Delete lives behind the event page's "More" menu → "Delete event" → a confirm
// modal ("Delete this event? … permanently delete …" / Confirm | Cancel). For
// DRAFTS use Delete; published events with attendees use "Cancel event" instead.
// Probed live 2026-07-04. Confirm match is exact to dodge the OneTrust cookie
// banner's "Confirm My Choices".
//   social meetup delete --group <url-name> --event <numeric-id>  (or --url <event url>)
async function harvestMeetupDelete(page, opts) {
  const group = typeof opts.group === "string" ? opts.group : "";
  let id = typeof opts.event === "string" ? opts.event : (typeof opts.id === "string" ? opts.id : "");
  if (!id && typeof opts.url === "string") { const m = opts.url.match(/\/events\/(\d+)/); if (m) id = m[1]; }
  if (!group || !/^\d+$/.test(String(id))) return { error: "pass --group <url-name> --event <numeric-id> (or --url <event url>)" };
  await page.goto(`https://www.meetup.com/${group}/events/${id}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const more = page.getByRole("button", { name: "More" }).first();
  if (!(await more.isVisible().catch(() => false))) return { error: `no "More" menu on event ${id} — not found, or not an event you manage?` };
  await more.click();
  await page.waitForTimeout(1200);
  const del = page.getByRole("menuitem", { name: "Delete event" }).first();
  if (!(await del.isVisible().catch(() => false))) return { error: `no "Delete event" option for event ${id} (published events use "Cancel event", not Delete).` };
  await del.click();
  await page.waitForTimeout(2000);
  const confirm = page.getByRole("button", { name: "Confirm", exact: true }).first();
  await confirm.waitFor({ timeout: 5000 });
  await confirm.click();
  await page.waitForTimeout(3000);
  return { records: [{ id, deleted: true }], note: `Meetup event deleted: ${id}` };
}

// ── Luma: event guests ───────────────────────────────────────────────────────
// Luma migrated lu.ma → luma.com and the old /api/event/get-guests endpoint 404s.
// The reliable path is the event's guest-management page (host session required):
// https://luma.com/event/manage/<evt-…>/guests — scrape the rendered guest table.
// Rows render as sequential text: Name / email / RSVP (Going|Not Going|…) / date.
// Verified live 2026-07-01.
async function harvestLumaGuests(page, opts) {
  if (!opts.event) return { error: "pass --event <evt-…-api-id> (the event you HOST)" };
  await page.goto(`https://luma.com/event/manage/${opts.event}/guests`, { waitUntil: "domcontentloaded" });
  return page.evaluate(async ({ limit }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(5000);
    for (let i = 0; i < 8; i++) { window.scrollTo(0, document.body.scrollHeight); await wait(600); }
    const root = document.querySelector("main") || document.body;
    const lines = root.innerText.replace(/\r/g, "").split("\n").map((s) => s.trim()).filter(Boolean);
    const gi = lines.lastIndexOf("Guest List");
    const area = gi >= 0 ? lines.slice(gi) : lines;
    const isEmail = (s) => /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(s);
    const isRsvp = (s) => /^(Going|Not Going|Waitlist(ed)?|Pending|Invited|Declined|Checked In)$/i.test(s);
    const isDate = (s) => /^\d{1,2}\s\w{3}$|\d{4}/.test(s);
    const out = [];
    for (let i = 0; i < area.length && out.length < limit; i++) {
      if (!isEmail(area[i])) continue;
      const email = area[i];
      const name = area[i - 1] && !isEmail(area[i - 1]) ? area[i - 1] : "";
      let status = "", registered_at = "";
      for (let k = i + 1; k < Math.min(i + 5, area.length); k++) {
        if (isRsvp(area[k])) status = area[k];
        else if (isDate(area[k])) registered_at = area[k];
      }
      out.push({ name, email, status, registered_at });
    }
    return { records: out };
  }, { limit: opts.limit });
}

// ── Luma: list upcoming events (host dashboard) ──────────────────────────────
// Scrape the feed at luma.com/home. Ported from events-mcp's luma_list_events,
// but its core assumption was stale: it looked for /event/manage/<id> anchors,
// which today's Luma renders ONLY inside an event you host — the /home feed
// links each event by a short PUBLIC slug (/x7lh4631). So we select the
// slug-anchors (each wraps a whole event card) and read the card's innerText.
// The feed mixes events you HOST / are Going to / are Invited to, so we capture
// `status` to make host-vs-guest filterable downstream. Robust innerText idiom
// (React SPA class names churn; anchor hrefs + card text are stable).
// Verified live 2026-07-04.
async function harvestLumaEvents(page, opts) {
  await page.goto("https://luma.com/home", { waitUntil: "domcontentloaded" });
  return page.evaluate(async ({ limit }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(6000); // let the SPA render the event cards
    // Nav/utility routes that are NOT events, so we can keep the slug allowlist tight.
    const RESERVED = new Set(["home", "discover", "create", "pricing", "app", "signin", "explore"]);
    const isRsvp = (s) => /^(Going|Not Going|Waitlist(ed)?|Pending|Invited|Declined|Checked In|Going \+|Manage)$/i.test(s);
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href^="/"]')) {
      if (out.length >= limit) break;
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{4,})$/); // short public slug
      if (!m) continue;
      const slug = m[1];
      if (RESERVED.has(slug.toLowerCase()) || slug.startsWith("home")) continue;
      if (seen.has(slug)) continue;
      // The slug anchor is a bare overlay (innerText ≈ 1 char); the card text
      // lives in an ancestor. Walk up to the first ancestor with ≥3 text lines.
      let card = a;
      for (let i = 0; i < 10 && card.parentElement; i++) {
        card = card.parentElement;
        if ((card.innerText || "").replace(/​/g, "").split("\n").filter((l) => l.trim()).length >= 3) break;
      }
      const lines = (card.innerText || "").split("\n").map((l) => l.replace(/​/g, "").trim()).filter(Boolean);
      if (lines.length < 3) continue; // not an event card
      seen.add(slug);
      // Card structure (positional but tolerant): time, title, "By <hosts>", venue, status, +count.
      const timeLine = lines.find((l) => /^\d{1,2}:\d{2}$/.test(l)) || "";
      const hostIdx = lines.findIndex((l) => /^By\s/i.test(l));
      const statusLine = lines.find(isRsvp) || "";
      // Title: first substantial line that isn't time/host/status/count.
      const title = lines.find((l) =>
        l !== timeLine && l !== statusLine && !/^By\s/i.test(l) &&
        !/^\+\d+$/.test(l) && !/^\d{1,2}:\d{2}$/.test(l) && l.length > 3) || lines[0];
      // Venue: the line after the host line that isn't the status/count.
      const venue = hostIdx >= 0
        ? (lines.slice(hostIdx + 1).find((l) => !isRsvp(l) && !/^\+\d+$/.test(l)) || "")
        : "";
      out.push({
        slug,
        url: `https://luma.com/${slug}`,
        title,
        time: timeLine,
        host: hostIdx >= 0 ? lines[hostIdx].replace(/^By\s+/i, "") : "",
        venue,
        status: statusLine,
      });
    }
    return { records: out };
  }, { limit: opts.limit });
}

// ── Luma: create an event ────────────────────────────────────────────────────
// Fills the real luma.com/create form (probed live 2026-07-04): the title is a
// <textarea placeholder="Event Name">, start/end DATES are text inputs in
// "Ddd D Mmm" format, start/end TIMES are <input type=time placeholder="HH:MM">,
// with "Add Event Location" / "Add Description" reveal buttons and a final
// "Create Event" submit. Returns the created event's URL. Luma has no draft
// state — the event is live on submit — so callers testing this should pass an
// obviously-disposable --title and delete immediately (see luma delete).
//   social luma create --title "X" [--start "Sat 5 Jul" --start-time 18:00
//     --end "Sat 5 Jul" --end-time 20:00 --location "…" --description "…"]
async function harvestLumaCreate(page, opts) {
  const title = typeof opts.title === "string" ? opts.title : "";
  if (!title) return { error: 'pass --title "Event Name" (optional: --start "Sat 5 Jul" --start-time 18:00 --end-time 20:00 --location "…" --description "…")' };
  await page.goto("https://luma.com/create", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const titleBox = page.locator('textarea[placeholder="Event Name"]').first();
  await titleBox.waitFor({ timeout: 10000 });
  await titleBox.fill(title);

  const dateInputs = page.locator('input[type="text"]'); // start-date, end-date (Ddd D Mmm)
  const timeInputs = page.locator('input[type="time"]'); // start-time, end-time
  // Setting a date/time opens a floating-ui picker overlay that will intercept
  // the later "Create Event" click if left open — dismiss it with Escape.
  const setDate = async (n, val) => {
    const el = dateInputs.nth(n);
    if (await el.isVisible().catch(() => false)) { await el.click(); await el.fill(String(val)); await page.keyboard.press("Enter").catch(() => {}); await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(400); }
  };
  const setTime = async (n, val) => {
    const el = timeInputs.nth(n);
    if (await el.isVisible().catch(() => false)) { await el.fill(String(val)); await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(200); }
  };
  if (opts.start) await setDate(0, opts.start);
  if (opts["start-time"] || opts.startTime) await setTime(0, opts["start-time"] || opts.startTime);
  if (opts.end) await setDate(1, opts.end);
  if (opts["end-time"] || opts.endTime) await setTime(1, opts["end-time"] || opts.endTime);

  if (typeof opts.location === "string" && opts.location) {
    const locBtn = page.locator('text=Add Event Location').first();
    if (await locBtn.isVisible().catch(() => false)) {
      await locBtn.click(); await page.waitForTimeout(800);
      const locInput = page.locator('input[placeholder*="location" i], input[placeholder*="address" i], input[placeholder*="link" i]').first();
      if (await locInput.isVisible().catch(() => false)) {
        await locInput.fill(opts.location); await page.waitForTimeout(1200);
        const opt = page.locator('[role="option"]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click();
      }
    }
  }
  if (typeof opts.description === "string" && opts.description) {
    const descBtn = page.locator('text=Add Description').first();
    if (await descBtn.isVisible().catch(() => false)) {
      await descBtn.click(); await page.waitForTimeout(800);
      const descBox = page.locator('[contenteditable="true"], textarea').last();
      if (await descBox.isVisible().catch(() => false)) await descBox.fill(opts.description);
    }
  }

  await page.keyboard.press("Escape").catch(() => {}); // clear any lingering picker overlay
  await page.waitForTimeout(300);
  const createBtn = page.getByRole("button", { name: "Create Event" }).first();
  await createBtn.waitFor({ timeout: 5000 });
  await createBtn.click();
  await page.waitForTimeout(6000); // Luma redirects to the new event's manage/overview
  const url = page.url();
  const m = url.match(/\/(?:event\/manage\/)?(evt-[A-Za-z0-9]+|[A-Za-z0-9-]{5,})/);
  const id = m ? m[1] : "";
  return { records: [{ title, id, url }], note: `Event created: ${url}` };
}

// ── Luma: edit an event ──────────────────────────────────────────────────────
// On the manage page, "Edit Event" reveals the same inline form as create; an
// "Update Event" button appears only once a field changes (no autosave — the
// edit is lost without the click). Only provided fields are touched. Probed live
// 2026-07-04. Same date/time formats as create (dates "Ddd D Mmm", times HH:MM).
//   social luma edit --event evt-… [--title "…" --description "…" --start "Sat 5 Jul"
//     --start-time 18:00 --end-time 20:00 --location "…"]
async function harvestLumaEdit(page, opts) {
  let id = typeof opts.event === "string" ? opts.event : (typeof opts.id === "string" ? opts.id : "");
  if (!id && typeof opts.url === "string") { const m = opts.url.match(/(evt-[A-Za-z0-9]+)/); if (m) id = m[1]; }
  if (!/^evt-[A-Za-z0-9]+$/.test(id)) return { error: "pass --event evt-… (or --url <manage url>) and at least one field to change" };
  await page.goto(`https://luma.com/event/manage/${id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const editBtn = page.getByRole("button", { name: "Edit Event" }).first();
  if (!(await editBtn.isVisible().catch(() => false))) return { error: `no "Edit Event" on manage/${id} — not found, or not an event you host?` };
  await editBtn.click();
  await page.waitForTimeout(2500);

  const updated = [];
  if (typeof opts.title === "string" && opts.title) {
    const t = page.locator("textarea").first();
    if (await t.isVisible().catch(() => false)) { await t.fill(opts.title); updated.push("title"); }
  }
  if (typeof opts.description === "string" && opts.description) {
    const d = page.locator('[contenteditable="true"]').first();
    if (await d.isVisible().catch(() => false)) { await d.fill(opts.description); updated.push("description"); }
  }
  const dateInputs = page.locator('input[type="text"]');
  const timeInputs = page.locator('input[type="time"]');
  if (typeof opts.start === "string" && opts.start) {
    const el = dateInputs.nth(0);
    if (await el.isVisible().catch(() => false)) { await el.click(); await el.fill(opts.start); await page.keyboard.press("Enter").catch(() => {}); await page.keyboard.press("Escape").catch(() => {}); updated.push("start"); }
  }
  const st = opts["start-time"] || opts.startTime, et = opts["end-time"] || opts.endTime;
  if (st) { const el = timeInputs.nth(0); if (await el.isVisible().catch(() => false)) { await el.fill(String(st)); await page.keyboard.press("Escape").catch(() => {}); updated.push("start-time"); } }
  if (et) { const el = timeInputs.nth(1); if (await el.isVisible().catch(() => false)) { await el.fill(String(et)); await page.keyboard.press("Escape").catch(() => {}); updated.push("end-time"); } }
  if (typeof opts.location === "string" && opts.location) {
    const loc = page.locator('input[placeholder="What\'s the address?"]').first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(opts.location); await page.waitForTimeout(1200);
      const o = page.locator('[role="option"]').first();
      if (await o.isVisible().catch(() => false)) await o.click();
      updated.push("location");
    }
  }
  if (!updated.length) return { error: "no fields changed — pass --title/--description/--start/--start-time/--end-time/--location" };

  const update = page.getByRole("button", { name: "Update Event" }).first();
  await update.waitFor({ timeout: 5000 });
  await update.click();
  await page.waitForTimeout(3000);
  return { records: [{ id, updated }], note: `Luma event updated (${updated.join(", ")}): ${id}` };
}

// ── Luma: change an event's cover photo ──────────────────────────────────────
// The manage page's "Change Photo" opens a picker: a "Search for more photos"
// box + category tabs (Tech, Featured, …) over a grid of image-result buttons,
// plus a file input for uploads. Category/tab buttons carry text; result images
// are text-less button:has(img) — pick the first text-less one. Probed live
// 2026-07-04.
//   social luma change-photo --event evt-… (--search "tech" | --category Tech | --file /abs/path.jpg)
async function harvestLumaChangePhoto(page, opts) {
  let id = typeof opts.event === "string" ? opts.event : (typeof opts.id === "string" ? opts.id : "");
  if (!id && typeof opts.url === "string") { const m = opts.url.match(/(evt-[A-Za-z0-9]+)/); if (m) id = m[1]; }
  if (!/^evt-[A-Za-z0-9]+$/.test(id)) return { error: "pass --event evt-… (or --url) and one of --search <query> / --category <name> / --file <abs path>" };
  const file = typeof opts.file === "string" ? opts.file : "";
  const search = typeof opts.search === "string" ? opts.search : "";
  const category = typeof opts.category === "string" ? opts.category : "";
  if (!file && !search && !category) return { error: "pass one of --search <query> / --category <name> / --file <abs path>" };
  await page.goto(`https://luma.com/event/manage/${id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const cp = page.getByRole("button", { name: "Change Photo" }).first();
  if (!(await cp.isVisible().catch(() => false))) return { error: `no "Change Photo" on manage/${id} — not found, or not an event you host?` };
  await cp.click();
  await page.waitForTimeout(2500);

  if (file) {
    await page.locator('input[type="file"]').first().setInputFiles(file).catch((e) => { throw new Error(`upload failed: ${String(e).slice(0, 80)}`); });
    await page.waitForTimeout(3000);
    return { records: [{ id, photo: `upload:${file}` }], note: `Luma cover photo uploaded: ${id}` };
  }
  if (search) {
    const s = page.getByPlaceholder("Search for more photos").first();
    await s.waitFor({ timeout: 5000 });
    await s.fill(search); await page.waitForTimeout(2500);
  } else {
    await page.getByRole("button", { name: category }).last().click().catch(() => {});
    await page.waitForTimeout(2500);
  }
  // Pick the first text-less image-result button (category tabs carry text).
  const imgs = page.locator("button:has(img)");
  const n = await imgs.count();
  for (let i = 0; i < n; i++) {
    const btn = imgs.nth(i);
    const txt = (await btn.innerText().catch(() => "x")).trim();
    if (!txt) { await btn.click(); await page.waitForTimeout(2500); return { records: [{ id, photo: search || category }], note: `Luma cover photo set (${search || category}): ${id}` }; }
  }
  return { error: `no image results found for ${search ? `search "${search}"` : `category "${category}"`}` };
}

// ── Luma: delete (cancel) an event ───────────────────────────────────────────
// Luma has no "delete" — it's "Cancel Event", on the manage/<id>/more page,
// behind a two-step confirm (page button opens a modal whose own "Cancel Event"
// button commits; the modal also offers a guest-notification email — moot with
// no guests). Permanent, per Luma's own warning. Probed live 2026-07-04.
//   social luma delete --event evt-…   (or --url <manage/public url>)
async function harvestLumaDelete(page, opts) {
  let id = typeof opts.event === "string" ? opts.event : (typeof opts.id === "string" ? opts.id : "");
  if (!id && typeof opts.url === "string") { const m = opts.url.match(/(evt-[A-Za-z0-9]+)/); if (m) id = m[1]; }
  if (!/^evt-[A-Za-z0-9]+$/.test(id)) return { error: 'pass --event evt-… (or --url <manage url>) of the event to delete' };
  await page.goto(`https://luma.com/event/manage/${id}/more`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const pageCancel = page.getByRole("button", { name: "Cancel Event" }).first();
  if (!(await pageCancel.isVisible().catch(() => false))) return { error: `no "Cancel Event" on manage/${id}/more — already deleted, or not an event you host?` };
  await pageCancel.click();
  await page.waitForTimeout(1500);
  // Confirm inside the modal (scope to the overlay so we don't re-click the page button).
  const modalCancel = page.locator('.lux-overlay.modal, [role="dialog"]').getByRole("button", { name: "Cancel Event" }).last();
  await modalCancel.waitFor({ timeout: 5000 });
  await modalCancel.click();
  await page.waitForTimeout(3000);
  return { records: [{ id, deleted: true }], note: `Event cancelled/deleted: ${id}` };
}

// ── Sync: mirror an event from one platform to the other ─────────────────────
// Scrape the source event via schema.org Event JSON-LD (both Luma and Meetup
// emit it — stabler than their React DOM), then create it on the target with the
// existing create commands. Date/time are read by REGEX off the ISO startDate so
// a timezone offset can't shift the wall-clock time.
//   social sync --from <event-url> --to luma|meetup [--group <url-name>] [--publish]
async function scrapeEventJsonLd(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  return page.evaluate(() => {
    let ev = null;
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        const arr = Array.isArray(j) ? j : (j["@graph"] || [j]);
        for (const o of arr) { if (o && /Event/i.test(String(o["@type"] || ""))) { ev = o; break; } }
      } catch {}
      if (ev) break;
    }
    if (!ev) return { error: "no schema.org Event JSON-LD found on the source page" };
    const loc = ev.location || {};
    const addr = loc.address || {};
    const locName = typeof loc === "string" ? loc
      : [...new Set([loc.name, typeof addr === "string" ? addr : (addr.streetAddress || addr.addressLocality)].filter(Boolean))].join(", ");
    return {
      title: ev.name || "",
      startDate: ev.startDate || "",
      endDate: ev.endDate || "",
      description: String(ev.description || "").replace(/\s+/g, " ").trim().slice(0, 2000),
      location: locName || "",
    };
  });
}

function isoParts(iso) {
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? { y: m[1], mo: m[2], d: m[3], hh: m[4], mm: m[5] } : null;
}
function toLumaStart(p) {
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(+p.y, +p.mo - 1, +p.d)).getUTCDay()];
  return `${wd} ${+p.d} ${MONTHS[+p.mo - 1].slice(0, 3)}`; // "Sat 19 Jul"
}

async function cmdSync(flags) {
  const from = typeof flags.from === "string" ? flags.from : "";
  const to = typeof flags.to === "string" ? flags.to : "";
  if (!from || !to) die("usage: social sync --from <event-url> --to luma|meetup [--group <url-name>] [--publish]");
  if (!["luma", "meetup"].includes(to)) die("--to must be 'luma' or 'meetup'");
  const source = /meetup\.com/.test(from) ? "meetup" : (/lu\.ma|luma\.com/.test(from) ? "luma" : null);
  if (!source) die("can't determine source platform from --from (need a meetup.com or luma.com URL)");
  if (source === to) die("source and target are the same platform — nothing to sync");
  if (to === "meetup" && !flags.group) die("--group <url-name> is required when syncing TO meetup");

  // 1) Scrape the source (source platform's session).
  const srcBe = BACKENDS[source], srcSp = storagePath(srcBe.storage);
  if (!existsSync(srcSp)) die(`no ${source} session — run: social auth ${source}`);
  let data;
  let browser = await chromium.launch({ headless: !flags.headed });
  try {
    const ctx = await browser.newContext({ storageState: srcSp });
    data = await scrapeEventJsonLd(await ctx.newPage(), from);
  } finally { await browser.close(); }
  if (data.error) die(`scrape failed: ${data.error}`);
  const parts = isoParts(data.startDate);
  console.error(`scraped ${source}: "${data.title}" @ ${data.startDate || "?"} · ${data.location || "no location"}`);

  // 2) Build target opts and create on the target (target platform's session).
  const tgtBe = BACKENDS[to], tgtSp = storagePath(tgtBe.storage);
  if (!existsSync(tgtSp)) die(`no ${to} session — run: social auth ${to}`);
  const opts = { title: data.title, description: data.description, location: data.location, publish: !!flags.publish, limit: 1 };
  if (parts) opts["start-time"] = `${parts.hh}:${parts.mm}`;
  if (to === "luma") { if (parts) opts.start = toLumaStart(parts); }
  else { opts.group = flags.group; if (parts) opts.date = `${parts.y}-${parts.mo}-${parts.d}`; }
  const createFn = to === "luma" ? harvestLumaCreate : harvestMeetupCreate;
  let result;
  browser = await chromium.launch({ headless: !flags.headed });
  try {
    const ctx = await browser.newContext({ storageState: tgtSp });
    result = await createFn(await ctx.newPage(), opts);
  } finally { await browser.close(); }
  if (result.error) die(`create on ${to} failed: ${result.error}`);
  console.error(result.note || `synced to ${to}`);
  console.log(JSON.stringify({ source, target: to, scraped: data, created: result.records && result.records[0] }, null, 2));
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
harvest (roster/attendees):
  linkedin connections   facebook friends   meetup members --group X   luma guests --event Y
  social auth <network>   social networks
events (create/manage across luma + meetup — folded in from events-mcp):
  luma list                                  list your upcoming Luma events
  luma create --title X --start "Sat 5 Jul" --start-time 18:00 [--end-time --location --description]
  luma edit --event evt-… [--title --description --start --start-time --end-time --location]
  luma change-photo --event evt-… (--search tech | --category Tech | --file /abs.jpg)
  luma delete --event evt-…
  meetup list --group X                       list a group's events
  meetup create --group X --title X --date 2026-07-19 --description "…" [--start-time --location --publish]
  meetup edit --group X --event <id> [--title --description --date --start-time --location --publish]
  meetup delete --group X --event <id>
  sync --from <event-url> --to luma|meetup [--group X] [--publish]   mirror an event across platforms
discover (find people NOT yet in the social graph):
  social discover github      2nd-degree builder-graph crawl (who your people follow)
  social discover messaging   1st-degree Signal + Discord + Telegram DM diff
  social discover groups       group co-occurrence (who shares your Telegram groups)`);
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
  if (network === "sync") return cmdSync(flags);

  // ── discover: people-DISCOVERY subcommands (find off-graph people) ────────────
  // Routes to the standalone discover_*.mjs modules, passing through extra args.
  if (network === "discover") {
    const SOURCES = { github: "discover_github.mjs", messaging: "discover_messaging.mjs", groups: "discover_groups.mjs" };
    const script = SOURCES[command];
    if (!script) die(`unknown discover source '${command || ""}'. one of: ${Object.keys(SOURCES).join(", ")}`);
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("node", [`${homedir()}/git/tools/cli-tools/social/${script}`, ...process.argv.slice(4)], { stdio: "inherit" });
    process.exit(r.status || 0);
  }

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
    // Spread all flags so action commands (luma create/edit …) receive their
    // own args (title/start/location/…); the explicit keys below preserve the
    // parsed defaults the harvest commands rely on.
    result = await harvest(page, { ...flags, limit, group: flags.group, event: flags.event, in: flags.in, out: flags.out, min: flags.min, max: flags.max, raw: flags.raw });
  } finally {
    await browser.close();
  }

  if (result.error) { console.error(`social ${network} ${command}: ${result.error}`); if (result.todo) console.error("  " + result.todo); }
  // --raw: dump the live API envelope so an unverified backend's real shape can be
  // read off the first authed run and the extraction corrected in one pass.
  if (flags.raw && result.rawSample !== undefined) {
    console.error("── raw API sample (─-raw) ──");
    console.error(JSON.stringify(result.rawSample, null, 2).slice(0, 4000));
    console.error("────────────────────────────");
  }
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
