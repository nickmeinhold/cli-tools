#!/usr/bin/env node
/**
 * linkedin — CLI for reading and sending LinkedIn DMs as Nick's account.
 *
 * Backed by Playwright driving linkedin.com/messaging (the real web app) — NOT an API client.
 * WHY: LinkedIn's messaging has no supported public API, and its *internal* Voyager REST
 * endpoint (`/voyager/api/messaging/conversations`) now returns HTTP 500 — DMs were migrated to a
 * GraphQL endpoint whose `queryId` hash rotates on every LinkedIn deploy, so hard-coding it is a
 * maintenance treadmill. Reading the rendered messaging SPA's DOM survives that churn for free.
 * This is the same auth-bridge pattern as the instagram/messenger CLIs (Playwright login → reuse
 * the session), and it reuses the EXISTING Playwright LinkedIn session that `social`/`playwright`
 * already banked — no separate login.
 *
 * ToS note: LinkedIn is aggressive about automation. This drives *your own* logged-in session at
 * human-ish pace for personal inbox use — the same account you'd use in a browser. Don't point it
 * at bulk outreach; that's what gets accounts flagged.
 *
 * Session: a Playwright storageState at
 *   ~/.claude/cli-tools/.tokens/playwright/linkedin.json   (label: "linkedin")
 *
 * Subcommands (mirror the instagram/signal/telegram CLIs):
 *   auth                                        Interactive browser login; persist the session.
 *   whoami                                      Print the logged-in name (health check).
 *   list [--limit N] [--json]                   List DM threads, newest first.
 *   read --to <name> [--limit N] [--json]       Recent messages in a thread (name substring).
 *   send --to <name> (--text "..." | --file P)  Send a DM (opens the matching thread).
 *              [--dry-run]                       Open the thread, type nothing, report — never sends.
 */

import { createRequire } from "node:module";
import { readFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { openStorage, dismissDialogs, sendMessage } from "../lib/browser-context.mjs";

const LABEL = "linkedin";
const STORAGE = join(homedir(), ".claude", "cli-tools", ".tokens", "playwright", `${LABEL}.json`);
const BASE = "https://www.linkedin.com";

// ---------- args ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2), n = argv[i + 1];
      if (n === undefined || n.startsWith("--")) out[k] = true;
      else { out[k] = n; i++; }
    } else out._.push(a);
  }
  return out;
}
function die(m, c = 1) { console.error(m); process.exit(c); }
async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function launch({ headed = false } = {}) {
  const hasSession = await exists(STORAGE);
  return openStorage(chromium, {
    storagePath: hasSession ? STORAGE : undefined,
    headless: !headed,
    viewport: { width: 1280, height: 950 },
  });
}
const dismiss = (page) =>
  dismissDialogs(page, ["Accept cookies", "Accept", "Dismiss", "Got it", "Not now", "Skip"]);

// ---------- inbox ----------
async function openInbox(page) {
  await page.goto(`${BASE}/messaging/`, { waitUntil: "domcontentloaded" });
  await dismiss(page);
  // The conversation list hydrates client-side; poll until the first card appears.
  for (let i = 0; i < 25; i++) {
    const n = await page.evaluate(
      () => document.querySelectorAll("li.msg-conversation-listitem").length,
    );
    if (n) return true;
    await page.waitForTimeout(600);
  }
  return false;
}

async function inboxRows(page) {
  return page.evaluate(() => {
    const t = (el, s) => (el.querySelector(s)?.textContent || "").trim().replace(/\s+/g, " ");
    const out = [], seen = new Set();
    for (const li of document.querySelectorAll("li.msg-conversation-listitem")) {
      const name = t(li, ".msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        time: t(li, ".msg-conversation-listitem__time-stamp, time"),
        snippet: t(li, ".msg-conversation-card__message-snippet, .msg-conversation-listitem__message-snippet-body"),
        unread: !!li.querySelector(".notification-badge--show, .msg-conversation-card__unread-count"),
      });
    }
    return out;
  });
}

// The heading of the currently-open thread pane (empty string if none).
async function openThreadName(page) {
  return page.evaluate(() =>
    (document.querySelector(".msg-entity-lockup__entity-title, .msg-thread__link-to-profile")?.textContent || "")
      .replace(/\s+/g, " ").trim());
}

// Open the conversation whose participant names contain `name`, and DON'T return until the
// thread header confirms the switch — LinkedIn auto-opens the top thread, so a click that
// silently no-ops would otherwise leave us reading the wrong person's messages.
async function openThread(page, name) {
  const lc = name.toLowerCase();
  const headerMatches = async () => (await openThreadName(page)).toLowerCase().includes(lc);

  for (let attempt = 0; attempt < 6; attempt++) {
    const li = page.locator("li.msg-conversation-listitem", { hasText: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
    if (await li.count()) {
      // Click the card's own link/content, not a nested profile-image anchor.
      const target = li.locator("a.msg-conversation-listitem__link, .msg-conversation-card__content--selectable, a").first();
      const clickable = (await target.count()) ? target : li;
      try { await clickable.click({ timeout: 5000 }); } catch { try { await li.click({ timeout: 5000 }); } catch {} }
      // Gate: poll the thread header until it names the person we asked for.
      for (let i = 0; i < 12; i++) {
        if (await headerMatches()) return true;
        await page.waitForTimeout(500);
      }
    }
    // Not found / not matched yet — scroll the list to load more and retry.
    await page.mouse.move(220, 500);
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(800);
  }
  return headerMatches();
}

// Extract message bubbles from the open thread, sender-attributed, newest-last.
async function threadMessages(page, limit) {
  // Give the thread pane a moment to render.
  await page.waitForTimeout(1200);
  const rows = await page.evaluate(() => {
    // Sender names are group-level headers (.msg-s-message-group__name), NOT nested in each
    // message row (.msg-s-event-listitem__body). Walk both in DOM order and carry the last
    // sender forward so each body is attributed to whoever's group it falls under.
    const nodes = document.querySelectorAll(".msg-s-message-group__name, .msg-s-event-listitem__body");
    const out = [];
    let lastSender = "";
    for (const n of nodes) {
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (n.classList.contains("msg-s-message-group__name")) lastSender = t;
      else out.push({ from: lastSender, text: t });
    }
    return out;
  });
  return rows.slice(-limit);
}

// Type into LinkedIn's composer and send. Enter sends (Shift+Enter = newline).
async function sendInThread(page, text) {
  let box = null;
  for (const c of [
    () => page.locator("div.msg-form__contenteditable[contenteditable='true']").last(),
    () => page.locator("div[contenteditable='true'][role='textbox']").last(),
    () => page.getByRole("textbox").last(),
  ]) {
    try { const l = c(); if (await l.isVisible({ timeout: 2500 })) { box = l; break; } } catch {}
  }
  if (!box) throw new Error("composer not found");
  await sendMessage(page, text, { composer: () => box });
}

// ---------- commands ----------
async function cmdAuth() {
  await mkdir(join(homedir(), ".claude", "cli-tools", ".tokens", "playwright"), { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  console.error("Browser open. Log in to LinkedIn (password + 2FA). When your feed loads, come back here.");
  let ok = false;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(3000);
    const loggedIn = await page.evaluate(() =>
      !document.querySelector('input[name="session_password"]') &&
      /linkedin\.com\/(feed|messaging|in\/|\?|$)/.test(location.href));
    if (loggedIn) { ok = true; break; }
  }
  if (!ok) { console.error("Didn't detect a logged-in state. Re-run `linkedin auth`."); await browser.close(); process.exit(3); }
  await ctx.storageState({ path: STORAGE });
  console.log(JSON.stringify({ ok: true, saved: STORAGE }, null, 2));
  await browser.close();
  process.exit(0);
}

async function cmdWhoami() {
  if (!(await exists(STORAGE))) die("No session. Run: linkedin auth");
  const { browser, page } = await launch();
  // Must be on a linkedin.com origin before reading document.cookie / hitting Voyager.
  await page.goto(`${BASE}/feed/`, { waitUntil: "domcontentloaded" });
  const me = await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.match(/JSESSIONID=([^;]+)/) || [])[1] || "").replace(/"/g, "");
    try {
      const r = await fetch("https://www.linkedin.com/voyager/api/me", {
        headers: { "csrf-token": csrf, "x-restli-protocol-version": "2.0.0", accept: "application/json" },
        credentials: "include",
      });
      if (!r.ok) return null;
      const j = await r.json();
      const p = j?.miniProfile || {};
      return { name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), headline: p.occupation || "" };
    } catch { return null; }
  });
  await browser.close();
  if (!me) die("Session appears stale. Run: linkedin auth", 3);
  console.log(JSON.stringify({ ...me, session: STORAGE }, null, 2));
  process.exit(0);
}

async function cmdList(args) {
  if (!(await exists(STORAGE))) die("No session. Run: linkedin auth");
  const limit = args.limit ? parseInt(args.limit) : 20;
  const { browser, page } = await launch();
  if (!(await openInbox(page))) { await browser.close(); die("Inbox didn't load (session may be stale). Run: linkedin whoami"); }
  let rows = await inboxRows(page);
  for (let i = 0; i < 6 && rows.length < limit; i++) {
    await page.mouse.move(220, 500); await page.mouse.wheel(0, 1600); await page.waitForTimeout(900);
    const more = await inboxRows(page); const seen = new Set(rows.map(r => r.name));
    for (const m of more) if (!seen.has(m.name)) rows.push(m);
  }
  rows = rows.slice(0, limit);
  await browser.close();
  if (args.json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  for (const r of rows) {
    const flag = r.unread ? "●" : " ";
    console.log(`${flag} ${r.name.slice(0, 26).padEnd(26)} | ${(r.time || "").padEnd(8)} | ${r.snippet.slice(0, 60)}`);
  }
  process.exit(0);
}

async function cmdRead(args) {
  if (!args.to || args.to === true) die("Usage: linkedin read --to <name> [--limit N] [--json]", 2);
  if (!(await exists(STORAGE))) die("No session. Run: linkedin auth");
  const limit = args.limit ? parseInt(args.limit) : 20;
  const { browser, page } = await launch();
  if (!(await openInbox(page))) { await browser.close(); die("Inbox didn't load. Run: linkedin whoami"); }
  if (!(await openThread(page, args.to))) { await browser.close(); die(`No thread matching "${args.to}". Try: linkedin list`); }
  const msgs = await threadMessages(page, limit);
  await browser.close();
  if (args.json) { console.log(JSON.stringify({ to: args.to, messages: msgs }, null, 2)); process.exit(0); }
  for (const m of msgs) console.log(`${(m.from || "?").slice(0, 18).padEnd(18)} | ${m.text}`);
  process.exit(0);
}

// Allowlist of known flags for the mutating `send` verb. Per the fail-closed rule, an
// UNRECOGNISED flag ABORTS — a typo'd --dry-run must never silently fire a real send.
const SEND_FLAGS = new Set(["to", "text", "file", "dry-run"]);

async function cmdSend(args) {
  const unknown = Object.keys(args).filter((k) => k !== "_" && !SEND_FLAGS.has(k));
  if (unknown.length) die(`Refusing to send: unknown flag(s) --${unknown.join(", --")}. Known: --${[...SEND_FLAGS].join(", --")}`, 2);
  if (!args.to || args.to === true) die('Usage: linkedin send --to <name> (--text "..." | --file PATH) [--dry-run]', 2);
  let text = args.text && args.text !== true ? args.text : null;
  if (!text && args.file && args.file !== true) text = (await readFile(args.file, "utf8")).replace(/\s+$/, "");
  if (!text) die('Provide --text "..." or --file PATH', 2);
  if (!(await exists(STORAGE))) die("No session. Run: linkedin auth");

  const { browser, page } = await launch();
  if (!(await openInbox(page))) { await browser.close(); die("Inbox didn't load. Run: linkedin whoami"); }
  if (!(await openThread(page, args.to))) { await browser.close(); die(`No thread matching "${args.to}". Open a chat with them once in the app, then retry.`); }

  if (args["dry-run"]) {
    const tail = await threadMessages(page, 4);
    await browser.close();
    console.log(JSON.stringify({ dryRun: true, sent: false, to: args.to, wouldSend: text, threadTail: tail }, null, 2));
    process.exit(0);
  }

  try { await sendInThread(page, text); }
  catch (e) { await browser.close(); die(`Send failed: ${e.message}`); }
  const tail = await threadMessages(page, 6);
  const snippet = text.split("\n")[0].slice(0, 24);
  const ok = tail.some((m) => m.text.includes(snippet));
  await browser.close();
  console.log(JSON.stringify({ sent: ok, to: args.to, verified: ok, text }, null, 2));
  process.exit(ok ? 0 : 1);
}

function help() {
  console.log(`linkedin — LinkedIn DM CLI (Nick's account, via Playwright + linkedin.com web)

Usage: linkedin <subcommand> [options]

  auth                                        Interactive browser login; persist the session.
  whoami                                      Print the logged-in name (health check).
  list [--limit N] [--json]                   List DM threads, newest first (● = unread).
  read --to <name> [--limit N] [--json]       Recent messages in a thread (name substring).
  send --to <name> (--text "..." | --file P)  Send a DM (opens the matching thread).
             [--dry-run]                       Open the thread but DON'T send; report what it would.

WHY BROWSER-BACKED (not a protocol/API client):
  LinkedIn has no supported messaging API, and its internal Voyager REST endpoint now 500s
  (DMs moved to a GraphQL endpoint with a rotating queryId). Reading the rendered SPA's DOM is
  the durable path. Reuses the existing Playwright "linkedin" session — no separate login.
  Session: ${STORAGE}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") return help();
  const sub = argv[0], args = parseArgs(argv.slice(1));
  switch (sub) {
    case "auth": return cmdAuth();
    case "whoami": return cmdWhoami();
    case "list": return cmdList(args);
    case "read": return cmdRead(args);
    case "send": return cmdSend(args);
    default: console.error(`Unknown subcommand: ${sub}`); help(); process.exit(2);
  }
}
main().catch((e) => { console.error(e?.stack || e?.message || e); process.exit(1); });
