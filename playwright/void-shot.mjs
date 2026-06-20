import { chromium } from "playwright";

const URL = "https://gateway.imagineering.cc/void/";
const OUT = "/tmp/void-buy.png";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

await page.goto(URL, { waitUntil: "domcontentloaded" });
// let Three.js + module script initialise
await page.waitForTimeout(2500);

// Force the provenance card into its LISTED-piece CONTEMPLATE state to inspect the
// new "acquire license" pill rendering (real CSS, real layout) without 3D navigation.
await page.evaluate(() => {
  const $ = (id) => document.getElementById(id);
  $("p-name").textContent = "Aurora Drift #7";
  $("p-artist").textContent = "0x3C44…93BC";
  $("p-minted").textContent = "Jun 8, 2026";
  $("p-license").textContent = "transfer";
  $("p-market").textContent = "1.42 ETH · commercial +1";
  const mark = $("p-mark");
  mark.classList.remove("decoding");
  mark.innerHTML = "◈ <b>0x3C44…93BC:7</b> · verified";
  const buy = $("p-buy");
  buy.href = "/#/token/7";
  buy.classList.add("show");
  document.getElementById("prov").classList.add("show");
});
// allow the 0.9s fade-in transition to settle
await page.waitForTimeout(1200);

await page.screenshot({ path: OUT });
// also a tight crop of just the card for legibility inspection
const card = await page.$("#prov");
if (card) await card.screenshot({ path: "/tmp/void-buy-card.png" });

await browser.close();
console.log("shot: " + OUT);
console.log("errors: " + (errors.length ? "\n  " + errors.join("\n  ") : "none"));
