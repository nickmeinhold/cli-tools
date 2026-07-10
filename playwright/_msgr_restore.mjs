// Persistent HEADED Messenger session: open Ochan Ochan (e2ee), wait for Nick's PIN, read history.
// The persistent profile is what makes E2EE work — the restored keys flush to disk and survive
// for the subsequent _msgr_send.mjs / _msgr_read.mjs runs (storageState can't carry IndexedDB).
import { chromium } from "playwright";
import { openPersistent, clickTextGate, dismissDialogs, extractTail, MESSENGER } from "../lib/browser-context.mjs";

const { page, close } = await openPersistent(chromium, {
  profile: "messenger-web-profile",
  cookiesFrom: "messenger-fb",
  headless: false,
});
await page.goto(MESSENGER + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await clickTextGate(page, /^Continue as/i);
await dismissDialogs(page, ["Not now", "Allow all cookies", "OK"]);
await page.waitForTimeout(3000);

// Find the exact "Ochan Ochan" (NOT "Aba") chat row href and open it.
const href = await page.evaluate(() => {
  for (const a of document.querySelectorAll('a[href*="/t/"]')) {
    const t = (a.innerText || "").replace(/\s+/g, " ").trim();
    if (/^Ochan Ochan(?! Aba)\b/.test(t)) return a.getAttribute("href");
  }
  for (const a of document.querySelectorAll('a[href*="/e2ee/t/"]')) {
    if ((a.innerText || "").split("\n")[0].trim() === "Ochan Ochan") return a.getAttribute("href");
  }
  return null;
});
console.log("Ochan Ochan href:", href);
if (href) { await page.goto(MESSENGER + href, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(4000); }

console.log("\n>>> A browser window is open on the Ochan Ochan thread.");
console.log(">>> Enter your E2EE PIN (or 'Use a one-time code') in that window now.");
console.log(">>> Waiting up to 5 min for restore...");

// Poll until the "Enter your PIN" restore dialog is gone.
let restored = false;
for (let i = 0; i < 100; i++) {
  await page.waitForTimeout(3000);
  const stillLocked = await page.evaluate(() =>
    /Enter your PIN to restore|Some messages are missing|Messages are missing/i.test(document.body.innerText));
  if (!stillLocked) { restored = true; break; }
}
console.log("restored:", restored);
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/msgr-ochan.png" });

const msgs = await extractTail(page, { limit: 25, maxLen: 200 });
console.log("=== recent messages (Ochan Ochan) ===");
console.log(JSON.stringify(msgs, null, 2));
console.log("\n>>> Leaving the browser OPEN (persistent profile) for the send step.");
await page.waitForTimeout(4000); // let the profile/keys flush to disk
await close();
