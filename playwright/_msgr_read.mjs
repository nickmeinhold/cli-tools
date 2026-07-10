// Read recent messages from the Ochan Ochan (Benson) e2ee thread via the restored persistent profile.
import { chromium } from "playwright";
import { openPersistent, extractTail, MESSENGER } from "../lib/browser-context.mjs";

const THREAD = "/e2ee/t/9398311516931356/";

const { page, close } = await openPersistent(chromium, {
  profile: "messenger-web-profile",
  cookiesFrom: "messenger-fb",
  headless: true,
});
await page.goto(MESSENGER + THREAD, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);

const tail = await extractTail(page, { limit: 16 });
console.log(JSON.stringify(tail, null, 2));
const emails = tail.join(" ").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
console.log("EMAILS FOUND:", JSON.stringify([...new Set(emails)]));
await close();
