// Send a message to the Ochan Ochan (Benson) e2ee thread via the restored persistent profile.
// Plumbing (persistent context, cookie injection, send technique) lives in ../lib/browser-context.mjs.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { openPersistent, clickTextGate, extractTail, sendMessage, sendProbe, MESSENGER } from "../lib/browser-context.mjs";

const msg = readFileSync("/tmp/benson-rundown.txt", "utf8").replace(/\s+$/, "");
const THREAD = "/e2ee/t/9398311516931356/";

const { page, close } = await openPersistent(chromium, {
  profile: "messenger-web-profile",
  cookiesFrom: "messenger-fb",
  headless: false,
});
await page.goto(MESSENGER + THREAD, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);
await clickTextGate(page, /^Continue as/i);
await page.waitForTimeout(2000);

// Locked again? bail loudly (E2EE history needs the PIN re-entered — run _msgr_restore.mjs).
const locked = await page.evaluate(() => /Enter your PIN to restore|Messages are missing/i.test(document.body.innerText));
if (locked) { console.log("STILL LOCKED — needs PIN again (run _msgr_restore.mjs)"); await close(); process.exit(1); }

await sendMessage(page, msg);

const tail = await extractTail(page, { limit: 8 });
const ok = tail.some((t) => t.includes(sendProbe(msg)));
console.log("SEND VERIFIED:", ok);
console.log("thread tail:", JSON.stringify(tail, null, 2));
await close();
