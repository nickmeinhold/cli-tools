import { chromium } from "playwright";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://127.0.0.1:8088/glow", { waitUntil: "domcontentloaded" });
async function until(fn, ms = 10000){const t0=Date.now();while(Date.now()-t0<ms){if(await page.evaluate(fn))return true;await sleep(150);}return false;}
await until(`window.__nodes && document.querySelector('#graph canvas')`);
await sleep(2000); // let the force layout settle
await page.screenshot({ path: "/tmp/glow-threshold-tuned.png" });
await browser.close();
console.log("shot: /tmp/glow-threshold-tuned.png");
