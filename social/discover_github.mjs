#!/usr/bin/env node
// discover_github — find SURPRISING high-quality people in your GitHub orbit.
//
// Thesis: a stranger that MANY of your known collaborators INDEPENDENTLY follow is
// a high-signal "you should probably know them" candidate. Count of independent
// seed-paths is a cheap graph-distance proxy for the curvature engine (Task #5):
// high affinity (many of your people point at them) × high distance (not yet a node).
//
// Public GitHub API only (via `gh api`) — zero ToS risk, no scraping. Leads, not
// auto-writes: surfaced people are candidates for a consented/warm intro.
//
// Usage: node discover_github.mjs [--pages N] [--min-paths K] [--top T] [--json]

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PAGES = parseInt(flag("--pages", "3"), 10);     // following-list pages per seed (100/page)
const MIN_PATHS = parseInt(flag("--min-paths", "2"), 10); // min independent seeds → candidate
const TOP = parseInt(flag("--top", "30"), 10);
const JSON_OUT = args.includes("--json");

// Curated REAL-HUMAN seed handles from Nick's community graph (no personas/orgs/email-domains).
const SEEDS = [
  "RaggedR", "geekscape", "mbailey", "starship-droid", "sallensallen",
  "ajfisher", "jonoxer", "anjsimmo", "njr30071979", "Adarsha653",
  "edhodapp", "sjpiper145", "paulmvpbuild", "KausthubK", "shuttle1987",
  "jroth1111", "ryumacodes",
];

// Already-in-graph or not-a-person — exclude from candidates.
const KNOWN = new Set([
  ...SEEDS,
  "nickmeinhold", "lyra-claude", "lyraclaude20", "GayleJewson", "clio-vega",
  "kodamai", "enspyrco", "anthropic-ai", "tldraw", "good-display",
].map((s) => s.toLowerCase()));

const gh = (path) => {
  try {
    const out = execFileSync("gh", ["api", path, "--jq", "."], { encoding: "utf8", maxBuffer: 1 << 24 });
    return JSON.parse(out);
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().split("\n")[0];
    process.stderr.write(`  ! ${path}: ${msg}\n`);
    return null;
  }
};

// ── 1. gather: BOTH directions — who seeds follow + who follows seeds ──────────
// following = seed CHOSE them (high signal). followers = they chose seed (weaker,
// noisier). Skip Organization/Bot accounts (drops books like practicalarduino).
// (Deferred next increment: co-contributors on shared repos — heavier API pass.)
const cand = new Map(); // login → {following:Set, followers:Set}
const rec = (login, seed, dir, type) => {
  if (!login || KNOWN.has(login.toLowerCase())) return;
  if (type && type !== "User") return;
  if (!cand.has(login)) cand.set(login, { following: new Set(), followers: new Set() });
  cand.get(login)[dir].add(seed);
};
for (const seed of SEEDS) {
  const tally = {};
  for (const [edge, dir] of [["following", "following"], ["followers", "followers"]]) {
    let n = 0;
    for (let page = 1; page <= PAGES; page++) {
      const list = gh(`users/${seed}/${edge}?per_page=100&page=${page}`);
      if (!Array.isArray(list) || !list.length) break;
      for (const u of list) rec(u.login, seed, dir, u.type);
      n += list.length;
      if (list.length < 100) break;
    }
    tally[edge] = n;
  }
  process.stderr.write(`· ${seed}: follows ${tally.following}, followed-by ${tally.followers}\n`);
}

// ── 2. score: distinct seeds, weighting "following" over "followers" ───────────
const scored = [...cand.entries()].map(([login, d]) => {
  const all = new Set([...d.following, ...d.followers]);
  return {
    login,
    followingPaths: d.following.size,
    paths: all.size,
    via: [...all],
    viaFollowing: [...d.following],
  };
});

// ── 3. enrich + final filter (≥MIN_PATHS, OR AU-tagged with ≥1 following-path) ──
const AU_RE = /(Melbourne|Victoria|\bVIC\b|Australia|Sydney|Bendigo|Brisbane|Geelong|Ballarat|Adelaide|Perth)/i;
// enrich the union of (multi-path) ∪ (any following-path) so we can apply the AU rule post-enrichment
const toEnrich = scored
  .filter((c) => c.paths >= MIN_PATHS || c.followingPaths >= 1)
  .sort((a, b) => b.followingPaths - a.followingPaths || b.paths - a.paths)
  .slice(0, 120); // enrichment cap (API budget)

const enriched = [];
for (const c of toEnrich) {
  const u = gh(`users/${c.login}`) || {};
  const au = AU_RE.test([u.location, u.bio, u.company].join(" "));
  enriched.push({
    login: c.login, name: u.name || "", paths: c.paths, followingPaths: c.followingPaths,
    via: c.via, bio: (u.bio || "").replace(/\s+/g, " ").trim(),
    location: u.location || "", company: u.company || "", followers: u.followers ?? 0,
    blog: u.blog || "", url: u.html_url || `https://github.com/${c.login}`, au,
  });
}

// keep: ≥MIN_PATHS independent seeds, OR AU-tagged with any following-path (the long tail)
const out = enriched
  .filter((c) => c.paths >= MIN_PATHS || (c.au && c.followingPaths >= 1))
  .sort((a, b) => b.paths - a.paths || b.followers - a.followers)
  .slice(0, TOP);

process.stderr.write(`\n${out.length} shown — ${enriched.filter((c) => c.paths >= MIN_PATHS).length} multi-path + AU long-tail (of ${cand.size} reached)\n`);

if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

for (const p of out) {
  const tag = p.au ? " ★AU" : "";
  console.log(`\n${p.paths}× ${p.name || p.login} (@${p.login})${tag}  ${p.followers}⭐`);
  if (p.bio) console.log(`   ${p.bio}`);
  if (p.location || p.company) console.log(`   ${[p.location, p.company].filter(Boolean).join("  ·  ")}`);
  console.log(`   via: ${p.via.join(", ")}`);
  console.log(`   ${p.url}`);
}
