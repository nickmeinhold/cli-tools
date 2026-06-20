import { chromium } from "playwright";
const b=await chromium.launch({headless:true});
const p=await(await b.newContext({viewport:{width:760,height:380},deviceScaleFactor:2})).newPage();
await p.goto("file:///tmp/logo/preview.html",{waitUntil:"networkidle"});
await p.waitForTimeout(400);
await p.screenshot({path:"/tmp/logo/preview.png"});
await b.close();console.log("rendered");
