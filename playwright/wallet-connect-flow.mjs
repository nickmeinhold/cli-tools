import { chromium } from "playwright";
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport:{width:1280,height:800} })).newPage();
const errs=[], reqs=[];
p.on("pageerror",e=>errs.push("pageerror: "+e.message.slice(0,160)));
p.on("console",m=>{ if(m.type()==="error") errs.push("console.error: "+m.text().slice(0,160)); });
p.on("response",r=>{ const u=r.url(); if(/\/wallet\/api\//.test(u)) reqs.push(r.status()+" "+r.request().method()+" "+u.replace("https://gateway.imagineering.cc","")); });
await p.goto("https://gateway.imagineering.cc/", { waitUntil:"networkidle", timeout:30000 }).catch(e=>errs.push("goto: "+e.message));
await p.waitForTimeout(2500);
// Flutter renders to canvas; click by coordinates on the top-right "Connect" button
// then on the hero "Connect Wallet to Start". Try clicking the hero CTA center.
async function clickText(re){
  // Flutter web is canvas — use the semantics tree if enabled, else coordinate-click.
  const el = await p.$(`text=${re}`).catch(()=>null);
  if(el){ await el.click().catch(()=>{}); return true; }
  return false;
}
// Flutter semantics usually off; click the top-right Connect button by coords (~1180,18 in 1280-wide)
await p.mouse.click(1180, 18);
await p.waitForTimeout(2500);
await p.screenshot({ path:"/tmp/gw-connect-1.png" });
// then attempt clicking the hero CTA in case the top button needs a second tap
await p.mouse.click(640, 167);
await p.waitForTimeout(3000);
await p.screenshot({ path:"/tmp/gw-connect-2.png" });
console.log("wallet API responses seen:\n  "+(reqs.length?reqs.join("\n  "):"(none beyond initial accounts load)"));
console.log("\nerrors: "+(errs.length?("\n  "+errs.join("\n  ")):"none"));
await b.close();
