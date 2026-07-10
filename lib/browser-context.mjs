/**
 * browser-context.mjs — shared Playwright plumbing for driving web chat clients as Nick.
 *
 * WHY THIS EXISTS
 *   "Playwright-driving-a-web-client" is now the BASELINE for Meta consumer-chat
 *   automation, not an edge case: the unofficial protocol clients are dead/walled
 *   (ws3-fca is blind to Messenger E2EE threads; instagram-private-api's DM endpoints
 *   return 467 "Unsupported"). So the messenger E2EE scripts (_msgr_*.mjs) and the
 *   instagram CLI all drive the real web app. They used to copy-paste the same brittle
 *   plumbing — when Meta renames a CSS class or changes an IndexedDB schema, N copies
 *   break SILENTLY. This module centralizes that plumbing so it breaks in ONE place.
 *
 * DESIGN
 *   Dependency-free (only node: builtins). Playwright's `chromium` is PASSED IN by the
 *   caller, so this lib resolves from any cli-tools subdir regardless of where
 *   playwright's node_modules live. Page-level helpers operate on a `page` you pass.
 *
 * Two ways to open a session:
 *   - openStorage()    — a regular context from a saved storageState (cookies + localStorage).
 *                        Fine for non-E2EE surfaces (Instagram DMs, normal FB pages).
 *   - openPersistent() — a PERSISTENT context (launchPersistentContext + a userDataDir on disk).
 *                        REQUIRED for Messenger E2EE: the decryption keys live in IndexedDB,
 *                        which storageState does NOT capture — a throwaway context loses them,
 *                        so you'd re-hit the "Enter your PIN" wall every run. The persistent
 *                        profile keeps the restored keys between runs.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

export const TOKENS_DIR = join(homedir(), ".claude", "cli-tools", ".tokens");
const pwStorage = (label) => join(TOKENS_DIR, "playwright", `${label}.json`);

export const MESSENGER = "https://www.messenger.com";
export const INSTAGRAM = "https://www.instagram.com";

/** Normalize a Playwright storageState cookies array into ctx.addCookies() shape. */
export function normalizeCookies(cookies) {
  return (cookies || []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: c.expires && c.expires > 0 ? c.expires : undefined,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || "Lax",
  }));
}

/** Load + normalize cookies from a saved Playwright storageState file by label (e.g. "messenger-fb"). */
export function loadCookies(storageLabel) {
  const raw = JSON.parse(readFileSync(pwStorage(storageLabel), "utf8"));
  return normalizeCookies(raw.cookies);
}

/**
 * Open a PERSISTENT context (keys/state survive on disk between runs — needed for E2EE).
 * @param chromium  the playwright chromium object (passed in by the caller)
 * @param profile   directory name under TOKENS_DIR for the persistent profile
 * @param cookiesFrom  optional storage label to inject auth cookies from (e.g. "messenger-fb")
 * @returns { ctx, page, close }
 */
export async function openPersistent(
  chromium,
  { profile, cookiesFrom, headless = true, viewport = { width: 1200, height: 900 } } = {},
) {
  const userDataDir = join(TOKENS_DIR, profile);
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless, viewport });
  if (cookiesFrom) await ctx.addCookies(loadCookies(cookiesFrom));
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page, close: () => ctx.close() };
}

/**
 * Open a regular context from a saved storageState (no IndexedDB persistence).
 * @returns { browser, ctx, page, close }
 */
export async function openStorage(
  chromium,
  { storage, storagePath, headless = true, viewport = { width: 1280, height: 950 } } = {},
) {
  // `storagePath` (absolute) wins; else resolve a label under playwright/<label>.json.
  // Pass neither to open a fresh, unauthenticated context (e.g. for an interactive login).
  const ssPath = storagePath || (storage ? pwStorage(storage) : undefined);
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext(ssPath ? { storageState: ssPath, viewport } : { viewport });
  const page = await ctx.newPage();
  return { browser, ctx, page, close: () => browser.close() };
}

/** Click-dismiss common "Not Now" / cookie / continue dialogs by button label. */
export async function dismissDialogs(
  page,
  labels = ["Not Now", "Not now", "Allow all cookies", "Decline optional cookies", "OK", "Got it"],
) {
  for (const label of labels) {
    try {
      const b = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
      if (await b.isVisible({ timeout: 1000 })) {
        await b.click();
        await page.waitForTimeout(600);
      }
    } catch {}
  }
}

/** Click a text gate (e.g. messenger.com "Continue as <name>"). Returns true if clicked. */
export async function clickTextGate(page, pattern, { waitAfter = 6000, timeout = 2000 } = {}) {
  try {
    const b = page.getByText(pattern).first();
    if (await b.isVisible({ timeout })) {
      await b.click();
      await page.waitForTimeout(waitAfter);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Extract the most recent message rows from an open thread (de-duped, newest-last).
 * Defaults target the messenger.com message table; pass `selector` for other surfaces.
 */
export async function extractTail(
  page,
  { selector = '[role="row"], [data-scope="messages_table"] div', limit = 16, maxLen = 220 } = {},
) {
  return page.evaluate(
    ({ selector, limit, maxLen }) => {
      const rows = [];
      for (const el of document.querySelectorAll(selector)) {
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (t && t.length > 1 && t.length < maxLen) rows.push(t);
      }
      const seen = new Set();
      return rows.filter((r) => !seen.has(r) && seen.add(r)).slice(-limit);
    },
    { selector, limit, maxLen },
  );
}

/**
 * Send text into a composer: insertText (does NOT fire Enter, so multi-line is safe)
 * then a single Enter to send. Shift+Enter would be a newline; Enter alone sends.
 * @param composer  optional (page) => Locator; defaults to the last role=textbox.
 */
export async function sendMessage(page, text, { composer, settleMs = 900, sendWaitMs = 3500 } = {}) {
  const box = composer ? composer(page) : page.getByRole("textbox").last();
  await box.click({ timeout: 8000 });
  await page.waitForTimeout(600);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(settleMs);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(sendWaitMs);
}

/** Build a verification probe: a distinctive alphabetic run from a sent message. */
export function sendProbe(text) {
  return ((text.match(/[A-Za-z][A-Za-z ]{11,}/) || [text.slice(0, 16)])[0]).trim().slice(0, 16);
}
