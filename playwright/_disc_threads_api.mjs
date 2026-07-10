import { chromium } from "playwright";
import { openStorage } from "../lib/browser-context.mjs";
const GUILD = "900827411917201418";
const { page, close } = await openStorage(chromium, { storage: "discord", headless: true });
let auth = null;
page.on("request", (req) => { const h = req.headers(); if (!auth && h.authorization && req.url().includes("/api/")) auth = h.authorization; });
await page.goto(`https://discord.com/channels/${GUILD}/1278081837780041749`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 20 && !auth; i++) await page.waitForTimeout(1000);
if (!auth) { console.log(JSON.stringify({ error: "no auth" })); await close(); process.exit(1); }

const result = await page.evaluate(async ({ auth, GUILD }) => {
  const tr = await fetch(`/api/v10/guilds/${GUILD}/threads/active`, { headers: { authorization: auth } });
  if (!tr.ok) return { error: "threads " + tr.status };
  const { threads } = await tr.json();
  const out = [];
  for (const t of threads) {
    const mr = await fetch(`/api/v10/channels/${t.id}/messages?limit=8`, { headers: { authorization: auth } });
    const msgs = mr.ok ? await mr.json() : [];
    out.push({
      thread: t.name, id: t.id, parent: t.parent_id,
      msgs: msgs.map((m) => ({ ts: m.timestamp?.slice(0,16), author: m.author?.username, content: (m.content||"").slice(0,160) })),
    });
  }
  return { count: threads.length, threads: out };
}, { auth, GUILD });
console.log(JSON.stringify(result, null, 2));
await close();
