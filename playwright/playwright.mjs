#!/usr/bin/env node
/**
 * playwright — CLI for headed-browser automation.
 *
 * Auth: per-site storageState files at ~/.claude/cli-tools/.tokens/playwright/<name>.json
 * First-time setup: run `playwright auth --site URL --name LABEL` and log in.
 *
 * Subcommands:
 *   auth         Interactive login. Opens headed Chromium at --site, waits for you to log in,
 *                saves cookies + localStorage to --name. Press Enter in terminal to save.
 *   eval         Run a JS script in a page context. --url, --script (path or '-' for stdin),
 *                optional --storage NAME for authenticated sessions, --headed to watch it run.
 *   meta-token   Navigate Meta's WhatsApp API Setup for an app, click Generate Token,
 *                return the token. Requires `meta` storage (run `auth --site https://developers.facebook.com --name meta` first).
 *   meta-system-token  Opens Business Settings → System Users (already logged in) and watches for
 *                a System-User token to appear after you complete the wizard manually. Returns the
 *                token to stdout. Requires `meta` storage.
 */

import { chromium } from "playwright";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { stdin } from "node:process";
// (unused after readline removal — kept only as a placeholder if needed)

const TOKEN_DIR = join(homedir(), ".claude", "cli-tools", ".tokens", "playwright");

function storagePath(name) {
  return join(TOKEN_DIR, `${name}.json`);
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function help() {
  console.log(`playwright — headed-browser CLI

Usage: playwright <subcommand> [options]

Auth: storageState JSON files at ${TOKEN_DIR}/
First-time setup: \`playwright auth --site URL --name LABEL\`

Subcommands:
  auth         Interactive login. --site URL --name LABEL
  eval         Run JS in page context. --url URL --script PATH [--storage LABEL] [--headed]
  meta-token   Get a new WhatsApp Cloud API access token. --app-id ID
               (requires \`meta\` storage from prior \`auth\`)
  meta-system-token  Open Business Settings → System Users (logged in), watch for a token to
               appear after you complete the wizard manually. Returns it on stdout.
               (requires \`meta\` storage)
`);
}

async function cmdAuth(args) {
  if (!args.site || !args.name) {
    console.error("Usage: auth --site URL --name LABEL");
    process.exit(2);
  }
  await mkdir(TOKEN_DIR, { recursive: true });
  const path = storagePath(args.name);
  const browser = await chromium.launch({ headless: false });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(args.site);
    console.error(`Browser open at ${args.site}.`);
    console.error(`Log in (password + 2FA). When done, close the browser window (red X).`);

    // Wait for whichever close signal fires first:
    //   page.close  — red-X / Cmd-W on the window (the expected path on macOS,
    //                 fires while the context is still readable for storageState)
    //   browser.disconnected — process death (only useful as a fallback)
    await new Promise((resolve) => {
      page.once("close", resolve);
      browser.once("disconnected", resolve);
    });

    // The context may still be live (page-close path) or already gone
    // (disconnected path). Try to read; surface a clear error if we can't.
    try {
      await ctx.storageState({ path });
      console.log(JSON.stringify({ saved: path }, null, 2));
    } catch (e) {
      console.error(
        `Failed to read storage state: ${e.message}. ` +
          `If you killed the browser process, try again and close the window with the red-X instead.`,
      );
      process.exitCode = 4;
    }
  } finally {
    try {
      await browser.close();
    } catch {
      // Already gone — fine.
    }
  }
}

async function cmdEval(args) {
  if (!args.url || !args.script) {
    console.error("Usage: eval --url URL --script PATH [--storage LABEL] [--headed]");
    process.exit(2);
  }
  const script =
    args.script === "-"
      ? await new Promise((res) => {
          let buf = "";
          stdin.on("data", (c) => (buf += c));
          stdin.on("end", () => res(buf));
        })
      : await readFile(args.script, "utf8");

  const contextOpts = {};
  if (args.storage) {
    const p = storagePath(args.storage);
    if (await fileExists(p)) contextOpts.storageState = p;
    else {
      console.error(`No saved storage at ${p}. Run \`auth\` first.`);
      process.exit(3);
    }
  }
  const browser = await chromium.launch({ headless: args.headed ? false : true });
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  await page.goto(args.url, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(`(async () => { ${script} })()`);
  await browser.close();
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

/**
 * Meta WhatsApp Cloud API: generate a new access token for an app.
 * Navigates to the app's WhatsApp API Setup page and clicks "Generate access token".
 * Returns the token from the displayed field.
 */
async function cmdMetaToken(args) {
  if (!args["app-id"]) {
    console.error("Usage: meta-token --app-id <META_APP_ID>");
    process.exit(2);
  }
  const storage = storagePath("meta");
  if (!(await fileExists(storage))) {
    console.error(
      `No 'meta' storage found. First run: playwright auth --site https://developers.facebook.com --name meta`,
    );
    process.exit(3);
  }
  const url = `https://developers.facebook.com/apps/${args["app-id"]}/whatsapp-business/wa-dev-console/`;
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ storageState: storage });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  console.error("Page loaded. Looking for Generate access token control...");
  // Meta UI tends to use a button or anchor with this exact label.
  const genButton = page.getByRole("button", { name: /generate access token/i }).first();
  await genButton.waitFor({ state: "visible", timeout: 20000 });
  await genButton.click();

  console.error("Clicked. Waiting for token to appear...");
  // Token usually appears in a readonly textarea or input near the button.
  // Heuristic: any input whose value matches the EAAxxxx pattern is the token.
  const token = await page.waitForFunction(
    () => {
      const els = [...document.querySelectorAll("input, textarea")];
      for (const el of els) {
        const v = el.value || "";
        if (/^EAA[A-Za-z0-9_-]{40,}/.test(v)) return v;
      }
      return null;
    },
    null,
    { timeout: 20000 },
  );
  const tokenValue = await token.jsonValue();
  await browser.close();
  console.log(tokenValue);
}

/**
 * Meta System User token: opens Business Settings → System Users with saved auth,
 * lets the user complete the wizard manually, then watches the page for a token
 * to appear in any input/textarea and returns it.
 *
 * Wizard steps to follow in the browser:
 *   1. Click on a System User (or "Add" to create one named e.g. "echo-bot")
 *   2. Click "Generate New Token"
 *   3. Pick the app (--app-id is logged below as a reminder)
 *   4. Set token expiration to "Never"
 *   5. Select scopes: whatsapp_business_messaging + whatsapp_business_management
 *   6. Click "Generate Token". The token will appear in a confirmation dialog.
 */
async function cmdMetaSystemToken(args) {
  const storage = storagePath("meta");
  if (!(await fileExists(storage))) {
    console.error(
      `No 'meta' storage found. First run: playwright auth --site https://developers.facebook.com --name meta`,
    );
    process.exit(3);
  }
  const browser = await chromium.launch({ headless: false });
  try {
    const ctx = await browser.newContext({ storageState: storage });
    const page = await ctx.newPage();
    await page.goto("https://business.facebook.com/settings/system-users", {
      waitUntil: "domcontentloaded",
    });

    console.error("");
    console.error("─────────────────────────────────────────────────────");
    console.error("  Business Settings → System Users is now open.");
    console.error("  Complete the wizard manually:");
    console.error("    1. Click a System User (or Add a new one)");
    console.error("    2. Click 'Generate New Token'");
    if (args["app-id"]) console.error(`    3. Pick the app with ID ${args["app-id"]}`);
    else console.error("    3. Pick the app you want the token for");
    console.error("    4. Set expiration: Never");
    console.error("    5. Scopes: whatsapp_business_messaging + whatsapp_business_management");
    console.error("    6. Click Generate Token");
    console.error("");
    console.error("  Watching for the token to appear (or browser close to abort).");
    console.error("─────────────────────────────────────────────────────");
    console.error("");

    // Race three outcomes:
    //   tokenP    — an EAA system-user token appears in any input/textarea (success)
    //   closedP   — user closes the window before getting a token (abort)
    //   timeoutP  — 10 minutes elapsed with neither (safety net)
    const tokenP = page
      .waitForFunction(
        () => {
          const els = [...document.querySelectorAll("input, textarea")];
          for (const el of els) {
            const v = el.value || "";
            if (/^EAA[A-Za-z0-9_-]{60,}/.test(v)) return v;
          }
          return null;
        },
        null,
        { timeout: 10 * 60 * 1000, polling: 1000 },
      )
      .then((h) => h.jsonValue())
      .then((v) => ({ kind: "token", value: v }));

    const closedP = new Promise((resolve) => {
      page.once("close", () => resolve({ kind: "closed" }));
      browser.once("disconnected", () => resolve({ kind: "closed" }));
    });

    const result = await Promise.race([tokenP, closedP]);

    if (result.kind === "closed") {
      console.error("Browser closed before a token appeared. Aborting.");
      process.exitCode = 5;
      return;
    }

    // Persist any session updates (e.g. new business cookies) back to storage.
    try {
      await ctx.storageState({ path: storage });
    } catch {
      // Context already gone — token was captured fine, ignore.
    }

    console.log(result.value);
  } finally {
    try {
      await browser.close();
    } catch {
      // Already gone — fine.
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    help();
    return;
  }
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (sub) {
    case "auth":
      return cmdAuth(args);
    case "eval":
      return cmdEval(args);
    case "meta-token":
      return cmdMetaToken(args);
    case "meta-system-token":
      return cmdMetaSystemToken(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      help();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
