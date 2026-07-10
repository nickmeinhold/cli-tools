// belief — parallax's persisted world-model, now a set of conjugate priors.
//
// Why parallax is a surprise engine and not a status poller: it carries what it last
// understood, so tonight's observation diffs against it (innovation = observe −
// predict). Each repo holds two conjugate priors:
//   • movement:  p(move) ~ Beta(α, β)          (Beta-Bernoulli)
//   • magnitude: burst λ ~ Gamma(shape, rate)  (Gamma-Poisson)
// and a single global Dirichlet over author families feeds the provenance axis.
//
// Ordering contract: axes read this belief as the PRIOR and compute
// KL(posterior ‖ prior); updateBelief then advances the prior AFTER scoring, so
// the diff always compares against last night, never against itself.
//
// Stored at ~/.parallax/belief.json (override with PARALLAX_STATE_DIR). A missing belief
// is not an error — the first run has flat priors, so everything reads as
// cold-start until baselines form.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const STATE_DIR = process.env.PARALLAX_STATE_DIR || join(homedir(), ".parallax");
const BELIEF_PATH = join(STATE_DIR, "belief.json");

const EMPTY = {
  version: 2,
  lastRun: null,
  repos: {},
  // Global Dirichlet over commit-author families. Laplace start (all ones).
  authors: { self: 1, peer: 1, other: 1 },
};

export function loadBelief() {
  try {
    const b = JSON.parse(readFileSync(BELIEF_PATH, "utf8"));
    if (!b.authors) b.authors = { self: 1, peer: 1, other: 1 };
    return b;
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveBelief(belief) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(BELIEF_PATH, JSON.stringify(belief, null, 2) + "\n");
  return BELIEF_PATH;
}

// Fresh conjugate priors for a never-before-seen repo. Beta(1,1) = uniform on
// move-probability; Gamma(1,1) = weak mean-1-commit rate.
export function freshRepoPrior(ts) {
  return {
    head: null, headDate: null, branch: null,
    ahead: 0, behind: 0, upstreamGone: false,
    moveAlpha: 1, moveBeta: 1,     // Beta prior for p(move)
    magShape: 1, magRate: 1,       // Gamma prior for burst rate λ
    obsCount: 0, firstSeen: ts, lastChange: null,
    vanishedSince: null,
  };
}

// Fold tonight's observation into the belief AFTER findings are computed.
// Iterates belief ∪ observation so a repo dropped from the fleet list is RETAINED
// and tombstoned (vanishedSince) rather than amputated — the reconciliation axis
// needs that memory to report the disappearance.
export function updateBelief(belief, obs) {
  const next = {
    version: 2, lastRun: obs.ts, repos: {},
    authors: { ...(belief.authors || { self: 1, peer: 1, other: 1 }) },
  };

  // Advance the global author Dirichlet from tonight's observed commit authors.
  for (const fam of obs.authorFamilies || []) {
    next.authors[fam] = (next.authors[fam] || 1) + 1;
  }

  const names = new Set([...Object.keys(belief.repos), ...Object.keys(obs.repos)]);
  for (const name of names) {
    const prior = belief.repos[name] || freshRepoPrior(obs.ts);
    const o = obs.repos[name];

    // Repo in belief but absent from tonight's observation (dropped from list):
    // retain it, stamp vanishedSince the first time, don't otherwise mutate.
    if (!o || o.vanished) {
      next.repos[name] = { ...prior, vanishedSince: prior.vanishedSince || obs.ts };
      continue;
    }
    // Repo in the list but git failed (transient): keep priors, don't count it.
    if (o.missing) { next.repos[name] = { ...prior, vanishedSince: null }; continue; }

    const moved = prior.head != null && o.head != null && prior.head !== o.head;
    const c = moved ? (o.commitsSincePrior || 1) : 0;

    next.repos[name] = {
      head: o.head, headDate: o.headDate, branch: o.branch,
      ahead: o.ahead, behind: o.behind, upstreamGone: o.upstreamGone,
      // Beta-Bernoulli movement update.
      moveAlpha: prior.moveAlpha + (moved ? 1 : 0),
      moveBeta: prior.moveBeta + (moved ? 0 : 1),
      // Gamma-Poisson magnitude update (only when it moved).
      magShape: prior.magShape + c,
      magRate: prior.magRate + (moved ? 1 : 0),
      obsCount: prior.obsCount + 1,
      firstSeen: prior.firstSeen,
      lastChange: moved ? obs.ts : prior.lastChange,
      vanishedSince: null,
    };
  }
  return next;
}

export const paths = { STATE_DIR, BELIEF_PATH };
