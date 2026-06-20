import { chromium } from "playwright";
const b=await chromium.launch({headless:true});
const p=await(await b.newContext({viewport:{width:680,height:560},deviceScaleFactor:2})).newPage();
await p.goto("file:///tmp/logo/compare.html",{waitUntil:"networkidle"});await p.waitForTimeout(400);
await p.screenshot({path:"/tmp/logo/compare.png"});await b.close();console.log("ok");
