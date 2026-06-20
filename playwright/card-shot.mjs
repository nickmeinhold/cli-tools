import { chromium } from "playwright";
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport:{width:760,height:560}, deviceScaleFactor:2 })).newPage();
await p.goto("file:///tmp/card-test.html", { waitUntil:"networkidle" });
await p.waitForTimeout(400);
await p.screenshot({ path:"/tmp/card-iso.png" });
const c = await p.$("#prov"); if(c) await c.screenshot({ path:"/tmp/card-iso-crop.png" });
await b.close(); console.log("done");
