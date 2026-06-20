#!/usr/bin/env node
/**
 * instagram — CLI for reading and sending Instagram DMs as Nick's account.
 *
 * Backed by Playwright driving instagram.com/direct (the official web client) — NOT the
 * unofficial private API. We started on instagram-private-api (the Baileys/ws3-fca analogue),
 * but Instagram now rejects its DM endpoints with HTTP 467 "Unsupported" (the library is too
 * stale). The web client uses IG's current front end, so it just works. This is the same
 * auth-bridge pattern as the messenger CLI's E2EE path: Playwright login -> reuse the session.
 *
 * Trade-off vs the protocol-client CLIs (whatsapp/telegram/signal): this one needs a real
 * headless Chromium per call (slower, ~heavier), because IG left us no usable protocol option.
 *
 * Session: a Playwright storageState at
 *   ~/.claude/cli-tools/.tokens/instagram/storageState.json
 *
 * First-time login:
 *   instagram auth                      Opens a browser; log in (your hands: password + 2FA),
 *                                       then close the window. Saves the session.
 *
 * Subcommands (mirror the signal/telegram/messenger CLIs):
 *   auth                                       Interactive browser login; persist the session.
 *   whoami                                      Print the logged-in username (health check).
 *   list [--limit N] [--json]                   List DM threads, newest first.
 *   read --to <name> [--limit N] [--json]       Recent messages in a thread (name substring).
 *   send --to <name> (--text "..." | --file P)  Send a DM (opens the matching thread).
 */

import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { openStorage, dismissDialogs, sendMessage } from "../lib/browser-context.mjs";

const TOKEN_DIR = join(homedir(), ".claude", "cli-tools", ".tokens", "instagram");
const STORAGE = join(TOKEN_DIR, "storageState.json");
const BASE = "https://www.instagram.com";

// ---------- args ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2), n = argv[i + 1];
      if (n === undefined || n.startsWith("--")) out[k] = true;
      else { out[k] = n; i++; }
    }
  }
  return out;
}
function die(m, c = 1) { console.error(m); process.exit(c); }
async function exists(p) { try { await access(p); return true; } catch { return false; } }

// ---------- browser ---------- (shared plumbing in ../lib/browser-context.mjs)
async function launch({ headed = false } = {}) {
  // IG DMs aren't E2EE, so a regular storageState context is enough (no persistent profile).
  const hasSession = await exists(STORAGE);
  return openStorage(chromium, {
    storagePath: hasSession ? STORAGE : undefined,
    headless: !headed,
    viewport: { width: 1280, height: 950 },
  });
}
async function dismiss(page) {
  return dismissDialogs(page, ["Not Now", "Not now", "Allow all cookies", "Save Info", "Continue"]);
}

// ---------- thread-list extraction (geometry: rows live in the left ~400px pane) ----------
async function inboxRows(page) {
  return page.evaluate(() => {
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll('div[role="button"], div[role="listitem"], a')) {
      const r = el.getBoundingClientRect();
      if (r.left > 420 || r.width < 150 || r.width > 460 || r.height < 44 || r.height > 110) continue;
      const lines = (el.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
      const name = lines[0];
      if (!name || name.length > 50 || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, preview: lines.slice(1).join(" · ").slice(0, 70) });
    }
    return out;
  });
}

async function openInbox(page) {
  await page.goto(`${BASE}/direct/inbox/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await dismiss(page);
  await page.waitForTimeout(2500);
}

// Click the left-pane row whose first text line contains `name` (case-insensitive). Returns true if opened.
async function openThread(page, name) {
  const lc = name.toLowerCase();
  const box = await page.evaluate((lc) => {
    for (const el of document.querySelectorAll('div[role="button"], div[role="listitem"], a')) {
      const r = el.getBoundingClientRect();
      if (r.left > 420 || r.width < 150 || r.width > 460 || r.height < 44 || r.height > 110) continue;
      const first = (el.innerText || "").split("\n")[0].trim().toLowerCase();
      if (first.includes(lc)) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, lc);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(3500);
  return true;
}

// Extract message bubbles from the open thread (right pane, x > 430).
async function threadMessages(page, limit) {
  const rows = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('div[role="row"], div[dir="auto"], span[dir="auto"]')) {
      const r = el.getBoundingClientRect();
      if (r.left < 430) continue;
      const t = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (t && t.length > 1 && t.length < 400) out.push(t);
    }
    const seen = new Set();
    return out.filter(t => !seen.has(t) && seen.add(t));
  });
  return rows.slice(-limit);
}

// Focus the message composer, type, send.
async function sendInThread(page, text) {
  // Find the IG-specific composer (contenteditable / textarea with a "Message..." placeholder),
  // then delegate the actual insertText+Enter to the shared sendMessage helper.
  let box = null;
  for (const c of [
    () => page.locator('textarea[placeholder*="Message" i]').last(),
    () => page.locator('div[contenteditable="true"][role="textbox"]').last(),
    () => page.getByRole("textbox").last(),
  ]) {
    try { const l = c(); if (await l.isVisible({ timeout: 2500 })) { box = l; break; } } catch {}
  }
  if (!box) throw new Error("composer not found");
  await sendMessage(page, text, { composer: () => box });
}

// ---------- commands ----------
async function cmdAuth() {
  await mkdir(TOKEN_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/accounts/login/`, { waitUntil: "domcontentloaded" });
  console.error("Browser open. Log in to Instagram (password + 2FA). When your feed/inbox loads, come back here.");
  // Wait until logged in: the login form disappears / we can reach the inbox.
  let ok = false;
  for (let i = 0; i < 120; i++) { // up to ~6 min
    await page.waitForTimeout(3000);
    const loggedIn = await page.evaluate(() =>
      !document.querySelector('input[name="password"]') &&
      (!!document.querySelector('a[href="/direct/inbox/"], svg[aria-label="Direct"], a[href*="/direct/"]') ||
       /instagram\.com\/(\?|$|direct)/.test(location.href)));
    if (loggedIn) { ok = true; break; }
  }
  if (!ok) { console.error("Didn't detect a logged-in state. Re-run `instagram auth`."); await browser.close(); process.exit(3); }
  await ctx.storageState({ path: STORAGE });
  console.log(JSON.stringify({ ok: true, saved: STORAGE }, null, 2));
  await browser.close();
  process.exit(0);
}

async function cmdWhoami() {
  if (!(await exists(STORAGE))) die("No session. Run: instagram auth");
  const { browser, page } = await launch();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const username = await page.evaluate(() => {
    // The "Profile" nav link points at /<username>/
    const a = document.querySelector('a[href^="/"][role="link"][tabindex] img')?.closest("a")
           || [...document.querySelectorAll('a[href^="/"]')].find(x => /\/[a-z0-9._]+\/$/i.test(x.getAttribute("href") || "") && /profile/i.test(x.getAttribute("aria-label") || ""));
    const href = a?.getAttribute("href") || "";
    const m = href.match(/^\/([a-z0-9._]+)\/?$/i);
    return m ? m[1] : null;
  });
  console.log(JSON.stringify({ username: username || "(session active; username not parsed)", session: STORAGE }, null, 2));
  await browser.close();
  process.exit(0);
}

async function cmdList(args) {
  if (!(await exists(STORAGE))) die("No session. Run: instagram auth");
  const limit = args.limit ? parseInt(args.limit) : 20;
  const { browser, page } = await launch();
  await openInbox(page);
  // scroll the list to load more
  let rows = await inboxRows(page);
  for (let i = 0; i < 6 && rows.length < limit; i++) {
    await page.mouse.move(200, 500); await page.mouse.wheel(0, 1600); await page.waitForTimeout(900);
    const more = await inboxRows(page); const names = new Set(rows.map(r => r.name));
    for (const m of more) if (!names.has(m.name)) rows.push(m);
  }
  rows = rows.slice(0, limit);
  await browser.close();
  if (args.json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  for (const r of rows) console.log(`${r.name.slice(0, 28).padEnd(28)} | ${r.preview}`);
  process.exit(0);
}

async function cmdRead(args) {
  if (!args.to) die("Usage: instagram read --to <name> [--limit N] [--json]", 2);
  if (!(await exists(STORAGE))) die("No session. Run: instagram auth");
  const limit = args.limit ? parseInt(args.limit) : 20;
  const { browser, page } = await launch();
  await openInbox(page);
  const opened = await openThread(page, args.to);
  if (!opened) { await browser.close(); die(`No thread matching "${args.to}". Try: instagram list`); }
  const msgs = await threadMessages(page, limit);
  await browser.close();
  if (args.json) { console.log(JSON.stringify({ to: args.to, messages: msgs }, null, 2)); process.exit(0); }
  for (const m of msgs) console.log(m);
  process.exit(0);
}

async function cmdSend(args) {
  if (!args.to) die("Usage: instagram send --to <name> (--text \"...\" | --file PATH)", 2);
  let text = args.text && args.text !== true ? args.text : null;
  if (!text && args.file && args.file !== true) text = (await readFile(args.file, "utf8")).replace(/\s+$/, "");
  if (!text) die("Provide --text \"...\" or --file PATH", 2);
  if (!(await exists(STORAGE))) die("No session. Run: instagram auth");
  const { browser, page } = await launch();
  await openInbox(page);
  const opened = await openThread(page, args.to);
  if (!opened) { await browser.close(); die(`No thread matching "${args.to}". Open a chat with them once in the app, then retry.`); }
  try { await sendInThread(page, text); }
  catch (e) { await browser.close(); die(`Send failed: ${e.message}`); }
  const tail = await threadMessages(page, 6);
  const snippet = text.split("\n")[0].slice(0, 24);
  const ok = tail.some(t => t.includes(snippet));
  await browser.close();
  console.log(JSON.stringify({ sent: ok, to: args.to, verified: ok, text }, null, 2));
  process.exit(ok ? 0 : 1);
}

function help() {
  console.log(`instagram — Instagram DM CLI (Nick's account, via Playwright + instagram.com web)

Usage: instagram <subcommand> [options]

  auth                                       Interactive browser login; persist the session.
  whoami                                      Print the logged-in username.
  list [--limit N] [--json]                   List DM threads, newest first.
  read --to <name> [--limit N] [--json]       Recent messages in a thread (name substring).
  send --to <name> (--text "..." | --file P)  Send a DM (opens the matching thread).

WHY THIS IS BROWSER-BACKED (not a protocol client like whatsapp/telegram):
  Instagram rejects the unofficial private API's DM endpoints with 467 "Unsupported",
  so this drives the real web client headlessly. Slower/heavier than the protocol CLIs,
  but it's the only path IG leaves open. Session: ${STORAGE}`);
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
