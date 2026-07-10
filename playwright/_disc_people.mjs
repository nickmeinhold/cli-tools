// Resolve Discord *people Nick knows* by name, via the in-page web API (clean JSON).
// Used by rolo's discord graph resolver. Lists Nick's DM + group-DM channels and returns
// the recipients whose username/global_name matches the query arg.
//
//   node _disc_people.mjs "<name substring>"     # JSON array of {id, username, global_name, dm}
//
// Same auth trick as _disc_api.mjs: open a logged-in Discord page, capture the Authorization
// header from a real request, then replay an in-page fetch from the same origin (Nick's session).
// Read-only. Prints [] (not an error) only when there are genuinely no matches; exits nonzero
// with a JSON {error} if the session/auth can't be obtained — so the caller marks Discord BLIND.
import { chromium } from "playwright";
import { openStorage } from "../lib/browser-context.mjs";

const query = (process.argv[2] || "").toLowerCase();

const { page, close } = await openStorage(chromium, { storage: "discord", headless: true });
let auth = null;
page.on("request", (req) => {
  const h = req.headers();
  if (!auth && h.authorization && req.url().includes("/api/")) auth = h.authorization;
});
await page.goto("https://discord.com/channels/@me", { waitUntil: "domcontentloaded" });
for (let i = 0; i < 20 && !auth; i++) await page.waitForTimeout(1000);
if (!auth) {
  console.log(JSON.stringify({ error: "no auth header captured (session expired? re-auth discord)" }));
  await close();
  process.exit(1);
}

const result = await page.evaluate(async ({ auth, query }) => {
  const r = await fetch("/api/v10/users/@me/channels", { headers: { authorization: auth } });
  if (!r.ok) return { error: `channels fetch ${r.status}` };
  const channels = await r.json();
  const people = new Map(); // id -> record (dedupe across multiple shared DM channels)
  for (const ch of channels) {
    const isDm = ch.type === 1; // 1 = 1:1 DM, 3 = group DM
    for (const u of ch.recipients || []) {
      const name = u.global_name || u.username || "";
      if (query && !name.toLowerCase().includes(query) && !(u.username || "").toLowerCase().includes(query)) continue;
      const prev = people.get(u.id);
      people.set(u.id, {
        id: u.id,
        username: u.username || null,
        global_name: u.global_name || null,
        dm: prev?.dm || isDm, // true if we have a direct 1:1 with them
      });
    }
  }
  return { people: [...people.values()] };
}, { auth, query });

await close();
if (result.error) {
  console.log(JSON.stringify({ error: result.error }));
  process.exit(1);
}
console.log(JSON.stringify(result.people));
