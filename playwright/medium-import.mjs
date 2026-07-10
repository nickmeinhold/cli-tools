#!/usr/bin/env node
/**
 * medium-import — syndicate a published post to Medium as a DRAFT.
 *
 * WHY a Playwright recipe and not an API call: Medium retired its write API
 * (Integration Tokens) — the only supported way to get a post onto Medium is the
 * "Import a story" feature in the web UI, which pulls a public URL and converts
 * it to a Medium draft. So this drives a logged-in browser using the saved
 * `medium` storage session (from `playwright auth --site https://medium.com
 * --name medium`). It deliberately runs LOCALLY, never in CI: a headless browser
 * shipping the session cookie from a datacenter IP is exactly the fingerprint
 * Medium's bot-detection blocks. Dev.to + LinkedIn auto-post from CI; Medium is
 * the human-in-the-loop leg.
 *
 * Import always produces a DRAFT — Medium's importer reflows formatting and you
 * review/publish by hand. That's a feature: it's the review gate.
 *
 * Usage:
 *   node medium-import.mjs --url https://enspyr.co/blog/<slug> [--storage medium]
 *        [--headed] [--shot-dir /tmp]
 *
 * Output: the Medium draft edit URL on stdout (and screenshots in --shot-dir for
 * debugging when a selector drifts).
 *
 * NOTE: Medium's DOM changes without notice. This recipe tries several selectors
 * and screenshots each step; if it can't find the import field, it bails with the
 * page title + a shot so you can adjust. First run should be watched (--headed).
 */

import { chromium } from "playwright";

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const url = arg("--url");
const storageLabel = arg("--storage", "medium");
const headed = args.includes("--headed");
const shotDir = arg("--shot-dir", "/tmp");

if (!url) {
  console.error("Usage: node medium-import.mjs --url <canonical-url> [--storage medium] [--headed]");
  process.exit(2);
}

const storagePath = `${process.env.HOME}/git/tools/cli-tools/.tokens/playwright/${storageLabel}.json`;

const browser = await chromium.launch({ headless: !headed });
let ctx;
try {
  ctx = await browser.newContext({
    storageState: storagePath,
    viewport: { width: 1280, height: 900 },
  });
} catch (e) {
  console.error(
    `Could not load Medium session from ${storagePath}: ${e.message}\n` +
      `Re-auth with: playwright auth --site https://medium.com --name ${storageLabel}`,
  );
  await browser.close();
  process.exit(1);
}
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: `${shotDir}/medium-import-${n}.png` }).catch(() => {});

try {
  await page.goto("https://medium.com/p/import", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  await shot("1-landing");

  // Logged-out detection: the import page bounces to a sign-in wall.
  if (/\/m\/signin|\/signin|\/m\/callback/.test(page.url())) {
    console.error(
      `Medium session is not logged in (landed on ${page.url()}).\n` +
        `Re-auth with: playwright auth --site https://medium.com --name ${storageLabel}`,
    );
    await browser.close();
    process.exit(1);
  }

  // The import field is a URL/text input. Medium has shuffled this between a
  // bare <input> and a placeholder-labelled one — try the likely candidates.
  const inputSelectors = [
    'input[type="url"]',
    'input[placeholder*="url" i]',
    'input[placeholder*="link" i]',
    'input[name="url"]',
    'form input[type="text"]',
  ];
  let filled = false;
  for (const sel of inputSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.fill(url).catch(() => {});
      filled = true;
      console.log(`Filled import URL via selector: ${sel}`);
      break;
    }
  }
  if (!filled) {
    console.error(
      `Could not find the Medium import URL field. Page title: "${await page.title()}". ` +
        `See ${shotDir}/medium-import-1-landing.png and adjust selectors.`,
    );
    await browser.close();
    process.exit(1);
  }
  await shot("2-filled");

  // Click the Import button (text varies: "Import", "Import story").
  const importBtn =
    (await page.$('button:has-text("Import")').catch(() => null)) ||
    (await page.$('button:has-text("import")').catch(() => null)) ||
    (await page.$('[role="button"]:has-text("Import")').catch(() => null));
  if (!importBtn) {
    console.error(
      `Filled the URL but found no Import button. See ${shotDir}/medium-import-2-filled.png.`,
    );
    await browser.close();
    process.exit(1);
  }
  await importBtn.click().catch(() => {});

  // Import + reflow → Medium navigates to the draft editor (/p/<id>/edit or
  // a story URL). Wait for that transition.
  await page
    .waitForURL(/medium\.com\/(p\/[\w-]+\/edit|@[\w.-]+\/[\w-]+|[\w-]+-[0-9a-f]+)/, { timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(3000);
  await shot("3-draft");

  const draftUrl = page.url();
  if (/\/p\/import/.test(draftUrl)) {
    console.error(
      `Import did not transition to a draft (still on ${draftUrl}). ` +
        `It may have errored or needs manual confirmation. See ${shotDir}/medium-import-3-draft.png.`,
    );
    await browser.close();
    process.exit(1);
  }

  console.log(`\nMedium draft created (review + publish manually):`);
  console.log(`  ${draftUrl}`);
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error(`medium-import failed: ${err.message}`);
  await shot("error");
  await browser.close();
  process.exit(1);
}
