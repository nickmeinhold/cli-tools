import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
await page.goto("file:///Users/nick/git/design-docs/index.html", { waitUntil: "networkidle" });
await page.screenshot({ path: "/tmp/design-hub.png", fullPage: true });
await browser.close();
console.log("shot: /tmp/design-hub.png");
