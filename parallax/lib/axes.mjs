// axes — the five drift lenses, now emitting NAT-scale contributions so they
// combine additively (weighted log-sum) instead of as a linear product.
//
// A Finding: { key, axis, family, title, detail, contribution, provenance? }
//   family "novelty"  → contribution is belief-shift (KL) or Shannon info, nats
//   family "absence"  → contribution is an overdue/standing-risk log term, nats
// Findings sharing a `key` are summed by score.mjs, so a repo lit from several
// sides accumulates. The white-snow paradox is enforced structurally: novelty
// contributions ARE the belief update, so a repo moving exactly as predicted
// shifts the posterior ~0 and scores ~0 — no hand-tuned rarity term to game.

import { klBeta, klGamma } from "./stats.mjs";
import { classifyAuthor, SECRETS } from "./registry.mjs";

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function movedRepo(belief, name, obs) {
  const prior = belief.repos[name];
  const now = obs.repos[name];
  if (!now || now.missing || now.vanished || !now.head) return false;
  return prior && prior.head && prior.head !== now.head;
}

// 1. SURPRISE (novelty) — belief-shift that THIS repo moved AND by how much.
// surprise = KL(Beta posterior‖prior)   [did it move — rare movers score high]
//          + KL(Gamma posterior‖prior)  [burst size — a 40-commit night on a
//                                         normally-quiet repo scores far above 1]
export function surpriseAxis(belief, obs) {
  const out = [];
  for (const name of Object.keys(obs.repos)) {
    if (!movedRepo(belief, name, obs)) continue;
    const p = belief.repos[name];
    const o = obs.repos[name];
    const move = klBeta(p.moveAlpha + 1, p.moveBeta, p.moveAlpha, p.moveBeta);
    const c = o.commitsSincePrior || 1;
    const mag = klGamma(p.magShape + c, p.magRate + 1, p.magShape, p.magRate);
    const nats = move + mag;
    const rate = p.moveAlpha / (p.moveAlpha + p.moveBeta);
    out.push({
      key: name, axis: "surprise", family: "novelty",
      title: `${name} moved${c > 1 ? ` (${c} commits)` : ""}`,
      detail: `HEAD ${p.head.slice(0, 7)} → ${o.head.slice(0, 7)}; moves ~${Math.round(rate * 100)}% of nights, `
        + `burst ${c} vs expected ~${(p.magShape / p.magRate).toFixed(1)} (${move.toFixed(2)}+${mag.toFixed(2)} nats)`,
      contribution: nats,
    });
  }
  return out;
}

// 2. PROVENANCE (novelty) — Shannon info of the author family, from the global
// Dirichlet. A peer/other commit when that family is globally rare = −ln(p) large
// nats. Your own hands (self) contribute nothing — that's work, not drift.
export function provenanceAxis(belief, obs) {
  const out = [];
  const A = belief.authors || { self: 1, peer: 1, other: 1 };
  const total = A.self + A.peer + A.other;
  for (const name of Object.keys(obs.repos)) {
    if (!movedRepo(belief, name, obs)) continue;
    const o = obs.repos[name];
    const fams = new Set((o.authorsSincePrior || []).map(([an, ae]) => classifyAuthor(an, ae)));
    let best = null, bestInfo = 0;
    for (const fam of fams) {
      if (fam === "self") continue;
      const info = -Math.log((A[fam] || 1) / total); // nats of Shannon surprise
      if (info > bestInfo) { bestInfo = info; best = fam; }
    }
    if (!best) continue; // only self touched it → not drift
    out.push({
      key: name, axis: "provenance", family: "novelty",
      title: `${name} moved by ${best}`,
      detail: `commit(s) by ${best} (globally ~${Math.round((A[best] / total) * 100)}% of authorship, ${bestInfo.toFixed(2)} nats)`,
      contribution: bestInfo, provenance: best,
    });
  }
  return out;
}

// 3. RECONCILIATION (novelty, STRUCTURAL) — records of one fact that disagree.
// Not distributional surprise; logical contradictions with fixed nat weights,
// labelled structural so the ranking stays honest.
export function reconciliationAxis(belief, obs) {
  const out = [];
  for (const name of Object.keys(obs.repos)) {
    const r = obs.repos[name];
    if (!r) continue;
    if (r.vanished) {
      out.push({ key: name, axis: "reconciliation", family: "novelty",
        title: `${name} vanished from the fleet`,
        detail: `was at ${r.priorHead.slice(0, 7)}; no longer in the repo list — deleted, moved, or lost`,
        contribution: 2.0 });
      continue;
    }
    if (r.missing) continue;
    if (r.ahead > 0 && r.behind > 0) {
      out.push({ key: name, axis: "reconciliation", family: "novelty",
        title: `${name} diverged (${r.ahead}↑ ${r.behind}↓)`,
        detail: `local ${r.branch} and upstream both moved — merge/rebase needed, conflict risk`,
        contribution: 1.5 });
    }
  }
  return out;
}

// 4. SILENT FAILURE (absence) — the highest-value axis. Alarm on the ABSENCE of an
// expected signal, on its OWN overdue log-scale (NOT smuggled into a surprise
// channel). Probes the effect mtime, never the scheduler's exit status.
export function silentFailureAxis(belief, obs) {
  const out = [];
  for (const hb of obs.heartbeats) {
    if (hb.stale === false) continue;
    if (hb.stale === "unknown") {
      out.push({ key: `heartbeat:${hb.name}`, axis: "silent-failure", family: "absence",
        title: `${hb.name}: no signal found`,
        detail: `expected output missing — never ran, or its probe is wrong`,
        contribution: 1.5 * hb.blast });
      continue;
    }
    const overdue = hb.ageH / hb.expectedMaxAgeH; // ≥ 1 when stale
    const nats = Math.log(1 + (overdue - 1)) * (1 + hb.blast);
    out.push({ key: `heartbeat:${hb.name}`, axis: "silent-failure", family: "absence",
      title: `${hb.name} silent for ${Math.round(hb.ageH)}h`,
      detail: `expected within ${hb.expectedMaxAgeH}h; ${overdue.toFixed(1)}× overdue`,
      contribution: nats });
  }
  return out;
}

// 5. DECAY (absence/standing-risk) — unpushed local work (linear risk, grows with
// commits at stake) and secret expiry cliffs (hazard ramps toward the date).
export function decayAxis(belief, obs) {
  const out = [];
  for (const name of Object.keys(obs.repos)) {
    const r = obs.repos[name];
    if (!r || r.missing || r.vanished) continue;
    if (r.ahead > 0 && r.behind === 0) {
      out.push({ key: name, axis: "decay", family: "absence",
        title: `${name}: ${r.ahead} unpushed commit${r.ahead > 1 ? "s" : ""}`,
        detail: `local ${r.branch} is ${r.ahead} ahead of upstream — unbacked work`,
        contribution: Math.log(1 + r.ahead) * 0.8 });
    }
  }
  for (const s of obs.secrets) {
    // Hazard grows as the deadline nears: ln(window/daysLeft). Distant → ~0.
    const nats = Math.log(180 / Math.max(s.daysLeft, 1)) * (1 + s.blast);
    if (nats < 0.2) continue;
    out.push({ key: `secret:${s.name}`, axis: "decay", family: "absence",
      title: `${s.name} expires in ${s.daysLeft}d`,
      detail: `${s.expires} — ${s.note}`,
      contribution: clamp(nats, 0, 10) });
  }
  return out;
}

export const AXES = [
  surpriseAxis, provenanceAxis, reconciliationAxis, silentFailureAxis, decayAxis,
];
