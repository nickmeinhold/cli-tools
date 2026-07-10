import { chromium } from "playwright";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://127.0.0.1:8088/glow", { waitUntil: "domcontentloaded" });

async function until(fn, ms = 10000) { const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await sleep(150); } return false; }

await until(`window.__nodes && document.querySelector('#graph canvas')`);
await sleep(1200); // let the force layout settle for a nicer frame
// drive the loop to the released state on Ana -> Jo
await page.evaluate(`window.__openPanel(window.__nodes.find(n=>n.id===0))`);
await until(`document.querySelector('#panel .meet .propose')`);
await page.evaluate(`document.querySelector('#panel .meet .propose').click()`);
await until(`document.querySelector('#panel .meet .resprow')`);
await page.evaluate(`document.querySelector('#panel .meet .resprow .yes').click()`);
await until(`document.querySelector('#panel .meet .badge.b-yes')`);
await page.evaluate(`document.querySelector('#panel .meet .resprow .yes').click()`);
await until(`document.querySelector('#panel .meet .state.accepted')`);
await sleep(400);
await page.screenshot({ path: "/tmp/glow-loop-closed.png" });
await browser.close();
console.log("shot: /tmp/glow-loop-closed.png");
