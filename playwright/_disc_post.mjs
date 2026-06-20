// Post a message to a Discord channel as Nick via the saved `discord` storageState.
// Reuses sendMessage (insertText keeps multi-line intact, then one Enter sends).
// Env: DISC_CHANNEL_URL, DISC_MSGFILE.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { openStorage, sendMessage } from "../lib/browser-context.mjs";

const CHANNEL = process.env.DISC_CHANNEL_URL || "https://discord.com/channels/900827411917201418/1278081837780041749"; // NS #discussion
const msg = readFileSync(process.env.DISC_MSGFILE || "./message.txt", "utf8").replace(/\s+$/, "");
const PROBE = "every cohort hits the same wall";

const { page, close } = await openStorage(chromium, { storage: "discord", headless: true });
await page.goto(CHANNEL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
await page.screenshot({ path: "/tmp/disc-post-before.png" });

await sendMessage(page, msg);
await page.waitForTimeout(3500);
await page.screenshot({ path: "/tmp/disc-post-after.png" });

const body = await page.evaluate(() => document.body.innerText || "");
const posted = body.includes(PROBE);
const captcha = /Are you human|confirm you'?re not a robot|hcaptcha/i.test(body);
console.log("POSTED:", posted, "| captcha_present:", captcha);
await close();
process.exit(posted ? 0 : 3);
