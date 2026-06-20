#!/usr/bin/env node
/**
 * commbank — read-only NetBank CLI for Commonwealth Bank.
 *
 * Drives a headed/headless Chromium against NetBank using a Playwright storageState
 * saved by `commbank auth`. READ-ONLY BY DESIGN: this tool only navigates and scrapes.
 * There is no code path that transfers money, pays bills, or mutates anything.
 *
 * NetBank server-sessions are short-lived (~15-20 min idle), so each sitting starts
 * with `commbank auth` (interactive login: client number + password + NetCode 2FA).
 * After that, accounts/transactions/search run freely until the session expires.
 *
 * Subcommands:
 *   auth                                   Interactive login; saves the session.
 *   accounts                               List accounts + balances (JSON).
 *   transactions --account NAME            Transactions for one account (JSON).
 *                [--from dd/mm/yyyy --to dd/mm/yyyy]
 *   search --term TEXT [--amount X.XX]     Sweep all accounts (or one) for matches.
 *          [--account NAME] [--from --to]  The "did I pay X?" command.
 *
 * Global flags: --headed (watch it run), --json (default), --raw (include raw row text).
 */
import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stdin } from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = join(homedir(), ".claude", "cli-tools", ".tokens", "playwright", "commbank.json");
const PLAYWRIGHT_CLI = join(HERE, "..", "playwright", "playwright.mjs");
const HOME = "https://www.my.commbank.com.au/netbank/Portfolio/Home/Home.aspx";
const TODAY = () => {
  // dd/mm/yyyy without Date.now restrictions — read from system via Intl on a fixed call is fine here (CLI, not workflow)
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};

// ---------- arg parsing ----------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else { a[key] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

// ---------- browser plumbing ----------
async function withPage(headed, fn) {
  const browser = await chromium.launch({ headless: !headed });
  const ctx = await browser.newContext({ storageState: TOKEN });
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.waitForTimeout(400).catch(() => {});
    await browser.close();
  }
}

async function gotoHome(page) {
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1600);
  const loggedOut = await page.evaluate(() => {
    const t = document.body ? document.body.innerText : "";
    return !!document.querySelector("input[type=password]") || /log ?on to netbank|client number/i.test(t) && !/log off/i.test(t);
  });
  if (loggedOut) {
    throw new Error("SESSION_EXPIRED");
  }
}

// ---------- scrapers ----------
async function scrapeAccounts(page) {
  return page.evaluate(() => {
    const text = (document.body ? document.body.innerText : "").replace(/ /g, " ");
    // Home account tiles render (newline-separated) as:
    //   <Name>\n(BSB ...|card number ...)\n<compact number>\nBalance\n$X\nAvailable\n$Y\nOptions for <Name>
    const start = text.indexOf("Accounts");
    const end = text.indexOf("Apply for a new product");
    const region = text.slice(start >= 0 ? start : 0, end > start ? end : undefined);
    const re = /\n([^\n]+?)\n(?:BSB |card number )[^\n]*\n([0-9 -]+)\nBalance\n\$([\d,]+\.\d{2})\nAvailable\n\$([\d,]+\.\d{2})/g;
    const out = [];
    let m;
    while ((m = re.exec(region))) {
      out.push({
        name: m[1].trim(),
        account: m[2].replace(/\s+/g, " ").trim(),
        balance: parseFloat(m[3].replace(/,/g, "")),
        available: parseFloat(m[4].replace(/,/g, "")),
      });
    }
    return out;
  });
}

async function openAccount(page, name) {
  const link = page.getByRole("link", { name: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
  await link.click({ timeout: 15000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

async function setRange(page, from, to) {
  await page.locator("#date-filter-bubble").click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1100);
  const s = page.locator("#date-picker-start-date-input").first();
  const e = page.locator("#date-picker-end-date-input").first();
  if (await s.count()) await s.fill(from).catch(() => {});
  if (await e.count()) await e.fill(to).catch(() => {});
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /^(apply|done|update|confirm|search)$/i }).first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

async function scrapeTransactions(page, includeRaw) {
  return page.evaluate((raw) => {
    const parseAmt = (s) => {
      if (!s) return null;
      const neg = /-/.test(s);
      const n = parseFloat(s.replace(/[^\d.]/g, ""));
      return isNaN(n) ? null : (neg ? -n : n);
    };
    const rows = [...document.querySelectorAll("[class~='transaction-item']")];
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      const date = (r.querySelector(".transaction-item__date")?.innerText || "").replace(/\s+/g, " ").trim();
      const desc = (r.querySelector(".transaction-item__description")?.innerText || "").replace(/\s+/g, " ").trim();
      const amts = [...r.querySelectorAll(".honeycomb-currency span[aria-hidden='true']")].map(s => s.innerText.trim());
      if (!desc && !amts.length) continue;
      const amount = parseAmt(amts[0]);   // first = transaction amount
      const balance = parseAmt(amts[1]);  // second = running balance (if shown)
      const key = `${date}|${desc}|${amount}|${balance}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = { date, description: desc, amount, balance };
      if (raw) t.raw = (r.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180);
      out.push(t);
    }
    return out;
  }, !!includeRaw);
}

// ---------- subcommands ----------
async function cmdAuth() {
  // Reuse the tested interactive-login flow from the playwright CLI.
  console.error("Opening NetBank login. Log in (client number + password + NetCode), then press Enter in this terminal to save the session.");
  const child = spawn("node", [PLAYWRIGHT_CLI, "auth", "--site", "https://www.commbank.com.au/", "--name", "commbank"], { stdio: "inherit" });
  await new Promise((res) => child.on("exit", res));
}

async function cmdAccounts(args) {
  const accts = await withPage(args.headed, async (page) => {
    await gotoHome(page);
    return scrapeAccounts(page);
  });
  console.log(JSON.stringify(accts, null, 2));
}

async function cmdTransactions(args) {
  if (!args.account) { console.error('transactions: --account "NAME" is required'); process.exit(2); }
  const from = args.from, to = args.to || (from ? TODAY() : null);
  const data = await withPage(args.headed, async (page) => {
    await gotoHome(page);
    await openAccount(page, args.account);
    if (from) await setRange(page, from, to);
    return scrapeTransactions(page, args.raw);
  });
  console.log(JSON.stringify({ account: args.account, from: from || "default", to: to || "default", count: data.length, transactions: data }, null, 2));
}

async function cmdSearch(args) {
  if (!args.term && !args.amount) { console.error('search: --term TEXT and/or --amount X.XX required'); process.exit(2); }
  const from = args.from || "01/07/2025";
  const to = args.to || TODAY();
  const term = args.term ? new RegExp(String(args.term).replace(/\s+/g, " ?"), "i") : null;
  const amount = args.amount ? String(args.amount) : null;
  const out = await withPage(args.headed, async (page) => {
    await gotoHome(page);
    const accounts = (await scrapeAccounts(page)).map(a => a.name);
    const targets = args.account ? accounts.filter(n => new RegExp(args.account, "i").test(n)) : accounts;
    const results = [];
    for (const name of targets) {
      await gotoHome(page);
      await openAccount(page, name);
      await setRange(page, from, to);
      const txns = await scrapeTransactions(page, true);
      const matches = txns.filter(t => {
        const hay = `${t.description} ${t.amount.toFixed(2)} ${t.raw || ""}`;
        return (term ? term.test(hay) : true) && (amount ? hay.includes(amount) : true);
      });
      results.push({ account: name, matchCount: matches.length, matches: matches.map(({ raw, ...m }) => m) });
    }
    return results;
  });
  console.log(JSON.stringify({ term: args.term || null, amount: amount, range: `${from}..${to}`, results: out }, null, 2));
}

// ---------- dispatch ----------
const HELP = `commbank — read-only NetBank CLI

Usage: commbank <subcommand> [options]

  auth                                  Interactive login; saves the session (run first each sitting).
  accounts                              List accounts + balances.
  transactions --account "NAME"         Transactions for one account.
               [--from dd/mm/yyyy] [--to dd/mm/yyyy] [--raw]
  search --term "TEXT" [--amount X.XX]  Sweep all accounts (or --account NAME) for matches.
         [--from dd/mm/yyyy] [--to dd/mm/yyyy] [--account NAME]

Global: --headed (watch the browser), --raw (include raw row text)
Read-only: never transfers money. NetBank sessions expire ~15-20 min; re-run 'auth' when they do.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    switch (cmd) {
      case "auth": return await cmdAuth(args);
      case "accounts": return await cmdAccounts(args);
      case "transactions": case "txns": return await cmdTransactions(args);
      case "search": return await cmdSearch(args);
      default:
        console.log(HELP);
        process.exit(cmd ? 2 : 0);
    }
  } catch (e) {
    if (String(e.message).includes("SESSION_EXPIRED")) {
      console.error("NetBank session expired or not logged in. Run:  commbank auth");
      process.exit(3);
    }
    console.error("Error:", e.message || String(e));
    process.exit(1);
  }
}
main();
