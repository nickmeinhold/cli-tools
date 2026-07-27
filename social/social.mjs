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

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// ── Luma: internal API (api.luma.com) ────────────────────────────────────────
// Luma's web app is a thin renderer over api.luma.com, and the logged-in session
// can call the same endpoints directly — fetch from the luma.com origin so the
// browser attaches cookies and CORS behaves exactly as for the real app (the
// same "slippery" approach as the LinkedIn Voyager harvest above). Ported off
// DOM form-filling 2026-07-16 after the selector-rot class bit twice in two
// weeks (lu.ma → luma.com, inputs → textareas). Shapes captured live 2026-07-16
// by sniffing the create/edit/cancel flows:
//   POST /event/create                        → {api_id, url}
//   GET  /event/admin/get?event_api_id=       → {event, description_mirror, …}
//   POST /event/admin/update                  (read-modify-write, full field set)
//   POST /event/admin/cancel-event            → {task_id} → GET /task/get-status
//   GET  /event/admin/get-guests?…            → {entries, has_more}
//   GET  /home/get-events?period=future       → {entries:[{event:{…}}], has_more}
//   GET  /calendar/admin/list                 → {infos:[{calendar:{api_id}}]}
//   GET  /event/admin/get-suggested-locations → {locations:[<geo_address_json>]}
async function lumaApi(page, path, body) {
  if (!page.url().startsWith("https://luma.com")) {
    await page.goto("https://luma.com/home", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
  }
  const res = await page.evaluate(async ({ path, body }) => {
    const r = await fetch(`https://api.luma.com${path}`, body === undefined
      ? { credentials: "include" }
      : { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text: text.slice(0, 300) };
  }, { path, body });
  if (!res.ok) throw new Error(`api.luma.com${path.split("?")[0]} → HTTP ${res.status}: ${res.text}`);
  return res.json;
}

const evtIdFrom = (opts) => {
  let id = typeof opts.event === "string" ? opts.event : (typeof opts.id === "string" ? opts.id : "");
  if (!id && typeof opts.url === "string") { const m = opts.url.match(/(evt-[A-Za-z0-9]+)/); if (m) id = m[1]; }
  return /^evt-[A-Za-z0-9]+$/.test(id) ? id : "";
};

// "2026-07-26" | "26 July 2026" | "Sat 5 Jul" (weekday ignored; a yearless date
// means the NEXT occurrence) → {y, mo, d}, or null if unparseable.
function parseLumaDay(s) {
  let m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = String(s).toLowerCase().match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?,?\s*(\d{4})?/);
  if (!m) return null;
  const mo = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m[2])) + 1;
  if (!mo) return null;
  let y = m[3] ? +m[3] : new Date().getFullYear();
  if (!m[3] && new Date(y, mo - 1, +m[1], 23, 59) < new Date()) y += 1;
  return { y, mo, d: +m[1] };
}

// Wall-clock {y,mo,d} + "HH:MM" in an IANA zone → UTC Date. The zone offset is
// found by fixed-point iteration (two passes settle DST edges).
function zonedToUtc(day, hhmm, tz) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const want = Date.UTC(day.y, day.mo - 1, day.d, hh, mm);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  }
  return new Date(t);
}

// A UTC instant → its wall-clock {y, mo, d, hhmm} in an IANA zone.
function utcToZoned(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, hhmm: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` };
}

// Plain text → Luma's ProseMirror description doc (one paragraph per line,
// blank lines become empty paragraphs — matches what the UI editor produces).
function lumaTextToDoc(text) {
  return { type: "doc", content: String(text).replace(/\r/g, "").split("\n").map((l) =>
    l.trim() ? { type: "paragraph", content: [{ type: "text", text: l }] } : { type: "paragraph" }) };
}

const isoDuration = (startAt, endAt) => {
  const min = Math.round((endAt - startAt) / 60000);
  return `PT${Math.floor(min / 60)}H${min % 60 ? `${min % 60}M` : ""}`;
};

// Resolve --location against the account's suggested locations (Google-place
// JSON, the shape /event/create expects). No fuzzy geocoding here — an
// unmatched location is an ERROR, not a silently-unset field.
async function lumaResolveLocation(page, opts) {
  if (typeof opts["location-json"] === "string" && opts["location-json"]) {
    try { return { geo: JSON.parse(opts["location-json"]) }; } catch { return { error: "--location-json is not valid JSON" }; }
  }
  const q = typeof opts.location === "string" ? opts.location.trim() : "";
  if (!q) return { geo: null };
  const sug = await lumaApi(page, "/event/admin/get-suggested-locations");
  const ql = q.toLowerCase();
  const geo = (sug.locations || []).find((l) =>
    [l.address, l.full_address].some((a) => String(a || "").toLowerCase().includes(ql)));
  if (!geo) return { error: `--location "${q}" matched none of your Luma suggested locations (${(sug.locations || []).map((l) => l.address).join(" | ") || "none yet"}). Pick it once in the UI (it becomes a suggestion), or pass --location-json '<geo_address_json>'.` };
  return { geo };
}

// ── Luma: event guests ───────────────────────────────────────────────────────
// GET /event/admin/get-guests (host session required). Field names inside each
// entry are mapped defensively — probed on a 0-guest event, so the entry shape
// is from Luma's web app usage, not a spec.
async function harvestLumaGuests(page, opts) {
  const id = evtIdFrom(opts) || (typeof opts.event === "string" ? opts.event : "");
  if (!id) return { error: "pass --event <evt-…-api-id> (the event you HOST)" };
  const j = await lumaApi(page, `/event/admin/get-guests?event_api_id=${encodeURIComponent(id)}&pagination_limit=${Math.min(opts.limit, 100)}&query=&sort_column=registered_or_created_at&sort_direction=desc`);
  const out = (j.entries || []).map((e) => {
    const g = e.guest || e.user || e;
    return {
      name: g.name || g.user_name || [g.first_name, g.last_name].filter(Boolean).join(" ") || "",
      email: g.email || g.user_email || "",
      status: g.approval_status || g.status || "",
      registered_at: g.registered_at || g.created_at || "",
    };
  });
  const res = { records: out.slice(0, opts.limit) };
  if (j.has_more) res.note = `guest list truncated at ${out.length} (has_more=true) — raise --limit (max 100/page; pagination cursor not yet implemented)`;
  return res;
}

// ── Luma: list upcoming events ───────────────────────────────────────────────
// GET /home/get-events — the JSON behind the /home feed. Mixes events you HOST
// and events you're going to / invited to; `role` is mapped defensively when the
// entry carries one.
async function harvestLumaEvents(page, opts) {
  const period = (opts.past === true || opts.past === "true") ? "past" : "future";
  const j = await lumaApi(page, `/home/get-events?pagination_limit=${Math.min(Math.max(opts.limit, 1), 50)}&period=${period}`);
  const out = (j.entries || []).map((entry) => {
    const e = entry.event || {};
    return {
      id: e.api_id || entry.api_id || "",
      slug: e.url || "",
      url: e.url ? `https://luma.com/${e.url}` : "",
      title: e.name || "",
      start_at: e.start_at || "",
      end_at: e.end_at || "",
      timezone: e.timezone || "",
      venue: e.geo_address_info?.address || "",
      visibility: e.visibility || "",
      role: entry.role || entry.rsvp_status || "",
    };
  });
  return { records: out.slice(0, opts.limit) };
}

// ── Luma: create an event ────────────────────────────────────────────────────
// POST /event/create with the payload the web form sends (captured live
// 2026-07-16; a minimal payload 400s, so the full field set is required). The
// command FAILS CLOSED: bad/unparseable inputs error before any API call, an
// unmatched --location is an error (not a silently-unset field), and the created
// event is read back and diffed against what was asked before success is
// reported. Luma has no draft state — the event is public on create — so tests
// should use a disposable --title and `luma delete` immediately.
//   social luma create --title "X" [--start "2026-07-26" --start-time 18:00
//     --end-time 20:00 --location "…" --description "…" --timezone Area/City]
async function harvestLumaCreate(page, opts) {
  const title = typeof opts.title === "string" ? opts.title : "";
  if (!title) return { error: 'pass --title "Event Name" (optional: --start "2026-07-26" --start-time 18:00 --end-time 20:00 --location "…" --description "…" --timezone Australia/Melbourne)' };
  const tz = typeof opts.timezone === "string" && opts.timezone ? opts.timezone : "Australia/Melbourne";

  const day = opts.start ? parseLumaDay(String(opts.start)) : utcToZoned(new Date(), tz);
  if (!day) return { error: `could not parse --start "${opts.start}" (use "2026-07-26", "26 July 2026", or "Sat 26 Jul")` };
  const st = String(opts["start-time"] || opts.startTime || "18:00");
  const et = String(opts["end-time"] || opts.endTime || "");
  if (!/^\d{1,2}:\d{2}$/.test(st) || (et && !/^\d{1,2}:\d{2}$/.test(et))) return { error: "--start-time/--end-time must be HH:MM (24h)" };
  const endDay = opts.end ? parseLumaDay(String(opts.end)) : day;
  if (!endDay) return { error: `could not parse --end "${opts.end}"` };
  const startAt = zonedToUtc(day, st, tz);
  const endAt = et ? zonedToUtc(endDay, et, tz) : new Date(startAt.getTime() + 3600e3);
  if (endAt <= startAt) return { error: `end (${endAt.toISOString()}) is not after start (${startAt.toISOString()})` };

  const loc = await lumaResolveLocation(page, opts);
  if (loc.error) return { error: loc.error };

  const cals = await lumaApi(page, "/calendar/admin/list");
  const calId = cals.infos?.[0]?.calendar?.api_id;
  if (!calId) return { error: "could not resolve your calendar (GET /calendar/admin/list returned none) — stale session? re-run `social auth luma`" };

  const payload = {
    name: title,
    start_at: startAt.toISOString(),
    duration_interval: isoDuration(startAt, endAt),
    zoom_meeting_url: "", zoom_meeting_id: "", zoom_meeting_password: "",
    description_mirror: typeof opts.description === "string" && opts.description ? lumaTextToDoc(opts.description) : null,
    geo_address_visibility: "public",
    cover_url: "https://images.lumacdn.com/gallery-images/de/a12a3146-d8ca-4e7d-865b-772a559a0a14",
    zoom_session_type: null, zoom_creation_method: null,
    location_type: "offline", // online/zoom events not supported here (weren't in the DOM flow either)
    geo_address_json: loc.geo || null,
    coordinate: null,
    timezone: tz,
    calendar_api_id: calId, calendar_to_submit_to_api_id: null,
    grant_manage_access: false, _calendar_requires_manage_access: false,
    supports_members_only: false, max_capacity: null, waitlist_status: "disabled",
    visibility: "public",
    theme_meta: { theme: "legacy" }, tint_color: "#fcedd4", font_title: "roc-grotesk",
    ticket_types: [{ currency: null, type: "free", ethereum_token_requirements: [], cents: null, is_flexible: false, min_cents: null, require_approval: false, is_hidden: false }],
  };
  const created = await lumaApi(page, "/event/create", payload);
  if (!created?.api_id) return { error: `POST /event/create returned no api_id: ${JSON.stringify(created).slice(0, 200)}` };

  // Read back and diff — success is only reported for a verified event.
  const got = await lumaApi(page, `/event/admin/get?event_api_id=${created.api_id}`);
  const ev = got.event || {};
  const rec = {
    id: created.api_id,
    url: `https://luma.com/${created.url}`,
    manage: `https://luma.com/event/manage/${created.api_id}`,
    title: ev.name, start_at: ev.start_at, end_at: ev.end_at, timezone: ev.timezone,
    location: ev.geo_address_json?.address || ev.geo_address_info?.address || "",
    visibility: ev.visibility,
  };
  const mismatch = [];
  if (ev.name !== title) mismatch.push(`name "${ev.name}" ≠ "${title}"`);
  if (ev.start_at !== startAt.toISOString()) mismatch.push(`start_at ${ev.start_at} ≠ ${startAt.toISOString()}`);
  if (ev.end_at !== endAt.toISOString()) mismatch.push(`end_at ${ev.end_at} ≠ ${endAt.toISOString()}`);
  if (loc.geo && rec.location !== loc.geo.address) mismatch.push(`location "${rec.location}" ≠ "${loc.geo.address}"`);
  if (mismatch.length) return { error: `event ${created.api_id} WAS created but readback mismatched: ${mismatch.join("; ")} — inspect ${rec.manage} (or \`luma delete --event ${created.api_id}\`)`, records: [rec] };
  return { records: [rec], note: `Event created (verified): ${rec.url} (manage: ${rec.manage})` };
}

// ── Luma: edit an event ──────────────────────────────────────────────────────
// Read-modify-write: GET /event/admin/get, overlay the provided fields, POST
// /event/admin/update with the full field set the web form sends (captured live
// 2026-07-16). Only provided flags change; everything else round-trips from the
// read. Fails closed: the update response is diffed against the request.
//   social luma edit --event evt-… [--title "…" --description "…" --start "2026-07-26"
//     --start-time 18:00 --end-time 20:00 --location "…"]
async function harvestLumaEdit(page, opts) {
  const id = evtIdFrom(opts);
  if (!id) return { error: "pass --event evt-… (or --url <manage url>) and at least one field to change" };
  const changed = ["title", "description", "start", "start-time", "end-time", "location", "location-json"]
    .filter((k) => typeof opts[k] === "string" && opts[k]);
  if (!changed.length) return { error: "no fields changed — pass --title/--description/--start/--start-time/--end-time/--location" };

  const got = await lumaApi(page, `/event/admin/get?event_api_id=${encodeURIComponent(id)}`);
  const ev = got.event;
  if (!ev?.api_id) return { error: `event ${id} not found (or not an event you host)` };
  const tz = ev.timezone || "Australia/Melbourne";

  let startAt = new Date(ev.start_at), endAt = new Date(ev.end_at);
  const day = opts.start ? parseLumaDay(String(opts.start)) : null;
  if (opts.start && !day) return { error: `could not parse --start "${opts.start}"` };
  const st = opts["start-time"] || opts.startTime, et = opts["end-time"] || opts.endTime;
  if ((st && !/^\d{1,2}:\d{2}$/.test(String(st))) || (et && !/^\d{1,2}:\d{2}$/.test(String(et)))) return { error: "--start-time/--end-time must be HH:MM (24h)" };
  if (day || st) startAt = zonedToUtc(day || utcToZoned(startAt, tz), String(st || utcToZoned(startAt, tz).hhmm), tz);
  if (day || et) endAt = zonedToUtc(day || utcToZoned(endAt, tz), String(et || utcToZoned(endAt, tz).hhmm), tz);
  if (endAt <= startAt) return { error: `end (${endAt.toISOString()}) is not after start (${startAt.toISOString()})` };

  const loc = await lumaResolveLocation(page, opts);
  if (loc.error) return { error: loc.error };

  const payload = {
    event_api_id: id,
    coordinate: ev.coordinate ?? null,
    description_mirror: typeof opts.description === "string" && opts.description
      ? lumaTextToDoc(opts.description)
      : (got.description_mirror ?? ev.description_mirror ?? null),
    duration_interval: isoDuration(startAt, endAt),
    font_title: ev.font_title ?? "roc-grotesk",
    geo_address_json: loc.geo ?? ev.geo_address_json ?? null,
    geo_address_visibility: ev.geo_address_visibility ?? "public",
    location_type: ev.location_type ?? "offline",
    name: typeof opts.title === "string" && opts.title ? opts.title : ev.name,
    start_at: startAt.toISOString(),
    theme_meta: ev.theme_meta ?? { theme: "legacy" },
    timezone: tz,
    tint_color: ev.tint_color ?? "#fcedd4",
    zoom_meeting_id: null, zoom_meeting_password: null, zoom_meeting_url: null,
  };
  const res = await lumaApi(page, "/event/admin/update", payload);
  const after = res.event || {};
  const mismatch = [];
  if (after.name !== payload.name) mismatch.push(`name "${after.name}" ≠ "${payload.name}"`);
  if (after.start_at !== payload.start_at) mismatch.push(`start_at ${after.start_at} ≠ ${payload.start_at}`);
  if (after.end_at !== endAt.toISOString()) mismatch.push(`end_at ${after.end_at} ≠ ${endAt.toISOString()}`);
  if (mismatch.length) return { error: `update of ${id} did not stick: ${mismatch.join("; ")} — inspect https://luma.com/event/manage/${id}` };
  return { records: [{ id, updated: changed, start_at: after.start_at, end_at: after.end_at }], note: `Luma event updated (${changed.join(", ")}, verified): ${id}` };
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
// Luma has no "delete" — POST /event/admin/cancel-event (permanent, per Luma's
// own UI warning; guests are notified unless custom_email is set). The call
// returns a task id; poll /task/get-status until it settles and only report
// success on the task's own "success".
//   social luma delete --event evt-…   (or --url <manage/public url>)
async function harvestLumaDelete(page, opts) {
  const id = evtIdFrom(opts);
  if (!id) return { error: "pass --event evt-… (or --url <manage url>) of the event to delete" };
  const r = await lumaApi(page, "/event/admin/cancel-event", { event_api_id: id, custom_email: null, should_refund: false });
  if (!r?.task_id) return { error: `cancel-event returned no task_id: ${JSON.stringify(r).slice(0, 200)}` };
  let status = null;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    status = await lumaApi(page, `/task/get-status?task_id=${encodeURIComponent(r.task_id)}`).catch(() => null);
    if (status?.status && status.status !== "pending") break;
  }
  if (status?.status !== "success") return { error: `cancel task for ${id} did not report success (status: ${status?.status ?? "unknown"}) — check https://luma.com/event/manage/${id}` };
  return { records: [{ id, deleted: true }], note: `Event cancelled (task verified): ${id}` };
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
