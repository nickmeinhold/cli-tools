// observe — the sensor half of the Kalman step. Now measures the INNOVATION, not
// just the state: given the prior belief, it computes how far each repo moved
// since parallax last looked (burst magnitude) and who moved it (all authors since
// the prior HEAD, not just the tip). It also reports repos that have dropped out
// of the fleet list entirely, so a disappearance becomes a finding.
//
// Still dumb about judgement — it reports what IS and by how much it changed;
// ranking lives in the axes and score.

import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { HEARTBEATS, SECRETS, classifyAuthor } from "./registry.mjs";
import { loadParallaxignore } from "./ignore.mjs";

const GIT_ROOT = process.env.PARALLAX_GIT_ROOT || join(homedir(), "git");
const REPO_LIST = join(homedir(), ".cache", "git-repos.txt");

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 15000, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

export function listRepos() {
  const ignore = loadParallaxignore(GIT_ROOT);
  let repos;
  try {
    repos = readFileSync(REPO_LIST, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
      .map((rel) => ({ name: rel, path: join(GIT_ROOT, rel) }));
  } catch {
    repos = readdirSync(GIT_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(GIT_ROOT, d.name) }));
  }
  return repos.filter((r) => !ignore(r.name));
}

// One repo's git-observable state PLUS the innovation vs the prior head:
// commitsSincePrior (burst magnitude) and the author emails of every commit since.
async function observeRepo({ name, path }, priorHead) {
  const SEP = "\x1f";
  const headLine = await git(path, ["log", "-1", "--format=%H%x1f%cI%x1f%ae%x1f%an%x1f%s", "HEAD"]);
  if (headLine == null) return { name, missing: true };

  const [head, headDate, authorEmail, authorName, subject] = headLine.split(SEP);
  const branch = (await git(path, ["symbolic-ref", "--short", "-q", "HEAD"])) || "(detached)";

  let ahead = 0, behind = 0, upstreamGone = false;
  const counts = await git(path, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (counts == null) upstreamGone = true;
  else { const [b, a] = counts.split(/\s+/).map(Number); behind = b || 0; ahead = a || 0; }

  // Innovation: commits + authors since the prior head. One `git log` gives both
  // (line count = commit count). If the prior head is unreachable (rebase/force-
  // push), fall back to the tip author and magnitude 1 (moved, size unknown).
  let commitsSincePrior = 0, authorsSincePrior = [];
  const moved = priorHead && priorHead !== head;
  if (moved) {
    const log = await git(path, ["log", `${priorHead}..HEAD`, "--format=%an%x1f%ae"]);
    if (log == null || log === "") { commitsSincePrior = 1; authorsSincePrior = [[authorName, authorEmail]]; }
    else {
      const lines = log.split("\n").filter(Boolean);
      commitsSincePrior = lines.length;
      authorsSincePrior = lines.map((l) => l.split(SEP));
    }
  }

  return {
    name, missing: false, head, headDate, authorEmail, authorName, subject,
    branch, ahead, behind, upstreamGone, commitsSincePrior, authorsSincePrior,
  };
}

async function observeRepos(repos, belief, concurrency) {
  const out = {};
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < repos.length) {
      const repo = repos[i++];
      out[repo.name] = await observeRepo(repo, belief.repos[repo.name]?.head || null);
    }
  });
  await Promise.all(workers);
  return out;
}

function newestMtimeUnder(dir) {
  try {
    const e = readdirSync(dir).map((n) => statSync(join(dir, n)).mtimeMs);
    return e.length ? Math.max(...e) : null;
  } catch { return null; }
}
function probeMtime(probe) {
  if (probe.file) { try { return statSync(probe.file).mtimeMs; } catch { return null; } }
  if (probe.newestUnder) return newestMtimeUnder(probe.newestUnder);
  return null;
}
function observeSystem(nowMs) {
  const heartbeats = HEARTBEATS.map((hb) => {
    const mtime = probeMtime(hb.probe);
    const ageH = mtime == null ? null : (nowMs - mtime) / 3.6e6;
    return { name: hb.name, ageH, expectedMaxAgeH: hb.expectedMaxAgeH, blast: hb.blast,
             stale: ageH == null ? "unknown" : ageH > hb.expectedMaxAgeH };
  });
  const secrets = SECRETS.map((s) => {
    const daysLeft = (Date.parse(s.expires) - nowMs) / 8.64e7;
    return { name: s.name, expires: s.expires, daysLeft: Math.round(daysLeft), blast: s.blast, note: s.note };
  });
  return { heartbeats, secrets };
}

export async function observe({ belief, concurrency = 8, limit = null, nowMs } = {}) {
  let repos = listRepos();
  if (limit) repos = repos.slice(0, limit);
  const repoState = await observeRepos(repos, belief, concurrency);

  // Repos in belief but absent from tonight's list → vanished (unless already a
  // recorded tombstone that we've reported).
  const listed = new Set(repos.map((r) => r.name));
  for (const name of Object.keys(belief.repos)) {
    if (!listed.has(name) && belief.repos[name].head) {
      repoState[name] = { name, vanished: true, priorHead: belief.repos[name].head };
    }
  }

  // Flatten all commit-author families observed tonight for the global Dirichlet.
  const authorFamilies = [];
  for (const r of Object.values(repoState)) {
    for (const [an, ae] of r.authorsSincePrior || []) authorFamilies.push(classifyAuthor(an, ae));
  }

  const sys = observeSystem(nowMs);
  return { ts: new Date(nowMs).toISOString(), repos: repoState, authorFamilies, ...sys, repoCount: repos.length };
}
