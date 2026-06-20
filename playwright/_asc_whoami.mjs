import { chromium } from "playwright";
import { join } from "node:path"; import { homedir } from "node:os";
const storage = join(homedir(), ".claude", "cli-tools", ".tokens", "playwright", "asc.json");
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ storageState: storage, viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
await page.goto("https://appstoreconnect.apple.com/access/users", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);
const info = await page.evaluate(() => {
  const txt = document.body.innerText.replace(/\s+/g, " ");
  // top-right account name + any "Integrations" tab presence
  const tabs = [...document.querySelectorAll('a,button,[role="tab"]')].map(e=>(e.innerText||"").trim()).filter(t=>/^(People|Sandbox|Xcode Cloud|Integrations|Keys)$/i.test(t));
  return { hasIntegrations: /Integrations/i.test(txt), tabsSeen: [...new Set(tabs)], snippetTop: txt.slice(0,200) };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "/tmp/asc-whoami.png" });
await b.close();
