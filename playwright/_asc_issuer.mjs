// Read the App Store Connect issuer id + confirm the AZ4F82S7XD key, using the asc session.
import { chromium } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";
const storage = join(homedir(), ".claude", "cli-tools", ".tokens", "playwright", "asc.json");
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: storage, viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
for (const url of [
  "https://appstoreconnect.apple.com/access/integrations/api",
  "https://appstoreconnect.apple.com/access/api",
]) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000); // ASC is a heavy SPA
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
    const uuids = [...new Set((body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []))];
    const hasKey = /AZ4F82S7XD/.test(body);
    // The issuer id usually appears right after the literal label "Issuer ID".
    const near = (body.match(/Issuer ID[:\s]*([0-9a-f-]{36})/i) || [])[1] || null;
    console.log(`\n=== ${url}`);
    console.log("landed:", page.url());
    console.log("AZ4F82S7XD key visible:", hasKey);
    console.log("Issuer-ID-labelled UUID:", near);
    console.log("all UUIDs on page:", JSON.stringify(uuids));
    if (near || hasKey) { await page.screenshot({ path: "/tmp/asc-keys.png" }); console.log("screenshot -> /tmp/asc-keys.png"); break; }
  } catch (e) { console.log(`\n=== ${url}\n  ERR ${e.message}`); }
}
await browser.close();
