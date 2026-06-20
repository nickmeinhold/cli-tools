import { chromium } from "playwright";
import { openStorage } from "../lib/browser-context.mjs";
const GUILD = "900827411917201418";
const CHANNEL = "1278081837780041749";
const LINKID = "1517830844406960138";

const { page, close } = await openStorage(chromium, { storage: "discord", headless: true });
let auth = null;
page.on("request", (req) => {
  const h = req.headers();
  if (!auth && h.authorization && req.url().includes("/api/")) auth = h.authorization;
});
await page.goto(`https://discord.com/channels/${GUILD}/${CHANNEL}`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 20 && !auth; i++) await page.waitForTimeout(1000);
if (!auth) { console.log(JSON.stringify({ error: "no auth" })); await close(); process.exit(1); }

const result = await page.evaluate(async ({ auth, CHANNEL, LINKID }) => {
  const get = async (q) => {
    const r = await fetch(`/api/v10/channels/${CHANNEL}/messages?${q}`, { headers: { authorization: auth } });
    if (!r.ok) return { error: r.status };
    return (await r.json()).map((m) => ({
      id: m.id, ts: m.timestamp,
      author: m.author?.username,
      is_link_target: m.id === LINKID,
      content: m.content,
      reply_to_id: m.referenced_message?.id || null,
      reply_to_author: m.referenced_message?.author?.username || null,
    }));
  };
  return { latest: await get("limit=50"), around: await get(`around=${LINKID}&limit=30`) };
}, { auth, CHANNEL, LINKID });

console.log(JSON.stringify(result));
await close();
