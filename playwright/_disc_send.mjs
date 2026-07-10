// Send a Discord DM as Nick via the saved `discord` storageState (browser auth-bridge).
// Discord bans self-bots + ignores raw DOM injection, so drive the real app with Playwright.
// We can't quick-switch to a never-DM'd user, so we open the target's profile popout by clicking
// their username on a real message in a channel, then type into the popout's "Message @user" box.
// The popout textbox's accessible name contains the username, so we VERIFY before sending.
// Env: DISC_CHANNEL_URL (channel where target has posted), DISC_USERNAME, DISC_MSGFILE.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { openStorage } from "../lib/browser-context.mjs";

const CHANNEL = process.env.DISC_CHANNEL_URL || "https://discord.com/channels/900827411917201418/1278081815139188817"; // NS #logistics
const USER = process.env.DISC_USERNAME || "chance";
const msg = readFileSync(process.env.DISC_MSGFILE || "/tmp/disc-chance.txt", "utf8").replace(/\s+$/, "");

const { page, close } = await openStorage(chromium, { storage: "discord", headless: true });
await page.goto(CHANNEL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);

// Find a clickable username OR @mention of the target (both open the profile popout).
// Scroll the message list up until one loads into the DOM.
const target = page.locator(
  `[class*="username"], [class*="mention"]`,
  { hasText: new RegExp(`^@?${USER}$`, "i") },
).first();
let found = false;
for (let i = 0; i < 16; i++) {
  if (await target.count()) { found = true; break; }
  await page.evaluate(() => {
    let best = null, h = 0;
    for (const el of document.querySelectorAll('[class*="scroller"]')) {
      if (el.scrollHeight > el.clientHeight && el.scrollHeight > h) { best = el; h = el.scrollHeight; }
    }
    if (best) best.scrollTop = 0;
  });
  await page.waitForTimeout(1100);
}
console.log(`target element found after scrolling:`, found);
if (!found) {
  console.log("ABORT: no username/mention of target in this channel — nothing sent.");
  await close();
  process.exit(2);
}
await target.scrollIntoViewIfNeeded();
await target.click();
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/disc-popout.png" });

// The popout message box's accessible name is "Message @<user>" -> verifies identity.
const box = page.getByRole("textbox", { name: new RegExp(`Message @?${USER}`, "i") }).first();
const ok = await box.isVisible({ timeout: 5000 }).catch(() => false);
console.log("popout message box visible:", ok);
if (!ok) {
  console.log("ABORT: popout message box for target not found — nothing sent.");
  await close();
  process.exit(3);
}
await box.click();
await page.waitForTimeout(600);
await page.keyboard.insertText(msg);
await page.waitForTimeout(900);
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
await page.screenshot({ path: "/tmp/disc-sent.png" });

// Verify: open the DM list; the message should now be visible in the chance DM.
await page.goto("https://discord.com/channels/@me", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const sent = await page.evaluate((p) => (document.body.innerText || "").includes(p), msg.slice(0, 30));
await page.screenshot({ path: "/tmp/disc-verify.png" });
console.log("SEND VERIFIED (msg visible in DM list/preview):", sent);
await close();
process.exit(0);
