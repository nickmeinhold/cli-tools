// Read a Discord channel via the in-page web API (clean JSON, includes reply refs).
// Captures the Authorization header from a real request the logged-in client makes,
// then replays a /messages?around= fetch from the same origin. Uses Nick's own session.
import { chromium } from "playwright";
import { openStorage } from "../lib/browser-context.mjs";

const GUILD = "900827411917201418";
const CHANNEL = process.env.DISC_CHANNEL || "1278081837780041749";
const AROUND = process.env.DISC_AROUND || "1517830844406960138";

const { page, close } = await openStorage(chromium, { storage: "discord", headless: true });
let auth = null;
page.on("request", (req) => {
  const h = req.headers();
  if (!auth && h.authorization && req.url().includes("/api/")) auth = h.authorization;
});
await page.goto(`https://discord.com/channels/${GUILD}/${CHANNEL}`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 20 && !auth; i++) await page.waitForTimeout(1000);
if (!auth) { console.log(JSON.stringify({ error: "no auth header captured" })); await close(); process.exit(1); }

const data = await page.evaluate(async ({ auth, CHANNEL, AROUND }) => {
  const r = await fetch(`/api/v10/channels/${CHANNEL}/messages?around=${AROUND}&limit=60`, {
    headers: { authorization: auth },
  });
  if (!r.ok) return { error: r.status, body: (await r.text()).slice(0, 200) };
  const msgs = await r.json();
  return msgs.map((m) => ({
    ts: m.timestamp,
    author: m.author?.global_name || m.author?.username,
    content: m.content,
    reply_to: m.referenced_message
      ? { author: m.referenced_message.author?.global_name || m.referenced_message.author?.username,
          content: (m.referenced_message.content || "").slice(0, 60) }
      : null,
  }));
}, { auth, CHANNEL, AROUND });

console.log(JSON.stringify(data, null, 2));
await close();
