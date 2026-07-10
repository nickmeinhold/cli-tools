import { chromium } from "playwright";
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport:{width:1280,height:800} })).newPage();
const errs=[];
p.on("pageerror",e=>errs.push("pageerror: "+e.message));
p.on("console",m=>{ if(m.type()==="error") errs.push("console.error: "+m.text().slice(0,200)); });
await p.goto("https://gateway.imagineering.cc/", { waitUntil:"networkidle", timeout:30000 }).catch(e=>errs.push("goto: "+e.message));
await p.waitForTimeout(3500);
await p.screenshot({ path:"/tmp/gw-home.png" });
// try to find a connect-wallet control
const texts = await p.$$eval("*", els => els.filter(e=>/connect|wallet/i.test(e.textContent||"") && e.children.length===0).map(e=>e.textContent.trim()).slice(0,10));
console.log("connect-ish text nodes: "+JSON.stringify(texts));
console.log("errors:\n"+(errs.length?errs.join("\n"):"none"));
await b.close();
