// Screenshot the Discord app at a given message URL (to SEE what the DOM scrape misses).
import { chromium } from "playwright";
import { openStorage } from "../lib/browser-context.mjs";
const URL = process.env.DISC_URL || "https://discord.com/channels/900827411917201418/1278081837780041749/1517830844406960138";
const { page, close } = await openStorage(chromium, { storage: "discord", headless: true, viewport: { width: 1280, height: 1400 } });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
await page.screenshot({ path: "/tmp/disc-msg-shot.png", fullPage: false });
console.log("shot saved");
await close();
