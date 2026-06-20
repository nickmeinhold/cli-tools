import { chromium } from "playwright";

const SHARE_URL = "https://share.google/aimode/Zq1ofhnWlYcukceDi";

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.goto(SHARE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

// Poll: wait until we're off the CAPTCHA/sorry page and substantial text exists.
const deadline = Date.now() + 120000; // 2 min for Nick to clear CAPTCHA + render
let best = "";
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  let url = "", text = "";
  try {
    url = page.url();
    text = await page.evaluate(() => document.body.innerText);
  } catch {
    continue; // mid-navigation; retry
  }
  const onSorry = url.includes("/sorry/") || /unusual traffic/i.test(text);
  if (text.length > best.length) best = text;
  // Good enough: not on captcha, and we have a real chunk of answer text.
  if (!onSorry && text.length > 400) {
    console.log(JSON.stringify({ url, len: text.length, text }, null, 2));
    await browser.close();
    process.exit(0);
  }
}
console.log(JSON.stringify({ note: "timed out", bestLen: best.length, text: best }, null, 2));
await browser.close();
