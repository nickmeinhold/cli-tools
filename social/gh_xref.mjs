// gh_xref — cross-reference Melbourne-tagged FB friends against GitHub to add a
// real tech signal (FB exposes location but not occupation; GitHub location=Melbourne
// is self-selecting builder signal). Public API, no ToS risk. Checkpointed + paced.
//
// Usage: node gh_xref.mjs <enriched.ndjson> <out.ndjson>
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

const [, , IN, OUT] = process.argv;
if (!IN || !OUT) { console.error("usage: node gh_xref.mjs <enriched.ndjson> <out.ndjson>"); process.exit(2); }

const TOKEN = execSync("gh auth token", { encoding: "utf8" }).trim();
const H = { "Authorization": `Bearer ${TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "social-xref" };

// noise to skip: family, agent personas, already-in-graph
const SKIP = [
  /meinhold/i,                                   // family
  /gayle jewson|lyra|clio vega|claudius/i,       // agent personas (is_agent LAW)
  /amanda robinson|sai mankit|lowell connell/i,  // already in graph
];

const friends = readFileSync(IN, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((f) => f.melbourne)
  .filter((f) => !SKIP.some((re) => re.test(f.name)));

const done = new Set();
if (existsSync(OUT)) for (const l of readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean)) { try { done.add(JSON.parse(l).name); } catch {} }
const queue = friends.filter((f) => !done.has(f.name));
console.error(`gh_xref: ${friends.length} Melbourne candidates, ${done.size} done, ${queue.length} to go`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ghSearch(q) {
  const r = await fetch(`https://api.github.com/search/users?q=${encodeURIComponent(q)}&per_page=5`, { headers: H });
  if (r.status === 403) { console.error("  rate-limited, backing off 60s"); await sleep(60000); return ghSearch(q); }
  if (!r.ok) return { items: [] };
  return r.json();
}
async function ghUser(login) {
  const r = await fetch(`https://api.github.com/users/${login}`, { headers: H });
  return r.ok ? r.json() : null;
}

let i = 0, hits = 0;
for (const f of queue) {
  i++;
  // search by name, prefer Melbourne, then Victoria/Australia
  let res = await ghSearch(`${f.name} location:Melbourne`);
  let scope = "melbourne";
  if (!res.items?.length) { res = await ghSearch(`${f.name} location:Victoria`); scope = "victoria"; await sleep(2200); }
  const top = res.items?.[0];
  let rec = { name: f.name, profileUrl: f.profileUrl, lives: f.lives, gh: null };
  if (top) {
    const u = await ghUser(top.login);
    rec.gh = {
      login: top.login, scope,
      url: `https://github.com/${top.login}`,
      ghName: u?.name || "", bio: u?.bio || "", location: u?.location || "",
      repos: u?.public_repos ?? null, followers: u?.followers ?? null,
      candidates: res.items.slice(0, 3).map((x) => x.login),
    };
    hits++;
    console.error(`  [${i}/${queue.length}] ✓ ${f.name} → @${top.login}${u?.bio ? " — " + u.bio.slice(0, 50) : ""}`);
  } else if (i % 15 === 0) {
    console.error(`  [${i}/${queue.length}] (no gh) ${f.name}`);
  }
  appendFileSync(OUT, JSON.stringify(rec) + "\n");
  await sleep(2300); // ~26 req/min, under the 30/min search cap
}
console.error(`gh_xref done: ${queue.length} processed, ${hits} GitHub matches this run`);
