// Open WA signup headed, fill what Nick has confirmed in his memory,
// then leave the browser open. Nick fills password + industry checkboxes + clicks.
// Browser stays open until Nick closes the window.
import { chromium } from "playwright";

const FIELDS = {
  "#txtFirstName":    "Nicholas",
  "#txtLastName":     "Meinhold",
  "#txtEmailAddress": "nick@sawasdee.com.au",
  "#txtCompany":      "ENSPYR PTY LTD",
  "#txtMobile":       "+61 400 000 000",
  "#txtPostcode":     "3775",
  "#txtAbn":          "92 167 142 421",
};

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on("close", async () => {
  console.log("page closed by user — exiting");
  await browser.close().catch(() => {});
  process.exit(0);
});

console.log("→ navigating to signup page...");
await page.goto("https://www.wineaustralia.com/signup", { waitUntil: "domcontentloaded" });

// The form is mostly server-rendered, but give any JS a moment.
await page.waitForSelector("#txtFirstName", { timeout: 15000 });

for (const [sel, val] of Object.entries(FIELDS)) {
  try {
    await page.fill(sel, val, { timeout: 5000 });
    console.log(`  filled ${sel} = ${val}`);
  } catch (e) {
    console.log(`  SKIP ${sel}: ${String(e).slice(0, 80)}`);
  }
}

// Dropdowns — Country=Australia (value 284), Job role (Employment) = Exporter (value 5)
try {
  await page.selectOption("#drpCountries", { value: "284" });
  console.log("  selected Country = Australia");
} catch (e) { console.log("  SKIP country:", String(e).slice(0, 80)); }

try {
  await page.selectOption("#drpEmploymentType", { value: "5" });
  console.log("  selected Job role = Exporter");
} catch (e) { console.log("  SKIP employment:", String(e).slice(0, 80)); }

// Best-effort State = Victoria — value depends on the Country-triggered AJAX
try {
  await page.waitForTimeout(800); // let state options populate after country change
  await page.selectOption("#drpState", { label: "Victoria" });
  console.log("  selected State = Victoria");
} catch (e) { console.log("  SKIP state (pick manually):", String(e).slice(0, 80)); }

// Accept terms consent checkbox
try {
  await page.check("#chkConsentAccount");
  console.log("  checked consent");
} catch (e) { console.log("  SKIP consent:", String(e).slice(0, 80)); }

console.log("");
console.log("=== DONE — your turn ===");
console.log("Still TODO in the browser:");
console.log("  - Password + Confirm password (your value)");
console.log("  - Industry section + Trade type checkboxes (pick what fits)");
console.log("  - Verify State = Victoria (I may have failed if AJAX was slow)");
console.log("  - Click Create Account");
console.log("Close the browser window when finished.");

await new Promise(() => {}); // block forever; page 'close' handler exits
