// Post a true Discord reply (with quote) to a specific message, driving the real UI.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { openStorage } from "../lib/browser-context.mjs";
const GUILD = "900827411917201418", CH = process.env.DISC_CH || "1278081837780041749", MSG = process.env.DISC_MSG || "1517830844406960138";
const text = readFileSync(process.env.DISC_MSGFILE || "/tmp/disc-reply.txt", "utf8").replace(/\s+$/, "");

const { page, close } = await openStorage(chromium, { storage: "discord", headless: true });
await page.goto(`https://discord.com/channels/${GUILD}/${CH}/${MSG}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);

const li = page.locator(`li[id*="${MSG}"]`).first();
if (!(await li.count())) { console.log("target message not found"); await close(); process.exit(2); }
await li.scrollIntoViewIfNeeded();
await li.hover();
await page.waitForTimeout(1200);
const replyBtn = li.locator('[aria-label="Reply"]').first();
if (!(await replyBtn.count())) {
  // fallback: keyboard shortcut 'r' while message hovered/focused
  await li.click({ position: { x: 5, y: 5 } });
}
try { await replyBtn.click({ timeout: 5000 }); } catch {}
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/disc-reply-mode.png" });
const replying = await page.evaluate(() => /Replying to/i.test(document.body.innerText));
if (!replying) { console.log("NOT in reply mode — aborting (nothing sent)"); await close(); process.exit(3); }

const box = page.getByRole("textbox").last();
await box.click();
await page.keyboard.insertText(text);
await page.waitForTimeout(900);
await page.keyboard.press("Enter");
await page.waitForTimeout(4500);
await page.screenshot({ path: "/tmp/disc-reply-sent.png" });
const ok = await page.evaluate((p) => (document.body.innerText || "").includes(p), text.slice(0, 32));
const captcha = await page.evaluate(() => /Are you human/i.test(document.body.innerText));
console.log("REPLY POSTED:", ok, "| captcha:", captcha);
await close();
process.exit(ok ? 0 : 4);
