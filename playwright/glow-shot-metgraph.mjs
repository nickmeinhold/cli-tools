import { chromium } from "playwright";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://127.0.0.1:8088/glow", { waitUntil: "domcontentloaded" });
async function until(fn, ms = 12000){const t0=Date.now();while(Date.now()-t0<ms){if(await page.evaluate(fn))return true;await sleep(150);}return false;}
await until(`window.__nodes && document.querySelector('#graph canvas')`);
await sleep(2200); // settle layout
await page.evaluate(`window.__openPanel(window.__nodes.find(n=>n.title==="Cara"))`);
await until(`document.querySelector('#panel.on .meet')`);
await sleep(500);
await page.screenshot({ path: "/tmp/glow-metgraph.png" });
await browser.close();
console.log("shot: /tmp/glow-metgraph.png");
