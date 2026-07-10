// score — collapse the axes' findings into one ranked list by weighted log-sum.
//
// Each finding carries a `contribution` in nats. Findings sharing a `key` (same
// repo/subject) are summed — additive in log-space, so a subject lit by several
// axes accumulates rather than one axis annihilating another (the failure of the
// old linear product) or a max-per-dimension manufacturing a composite vector no
// axis ever observed. Each contribution is weighted by its axis and clamped at a
// nat ceiling (the governor) so one huge KL term can't dominate the whole board.

import { SCORING } from "./registry.mjs";

export function merge(findings) {
  const { weights, natCeiling } = SCORING;
  const byKey = new Map();
  for (const f of findings) {
    const w = weights[f.axis] ?? 1.0;
    const contribution = Math.min(f.contribution, natCeiling) * w;
    const cur = byKey.get(f.key);
    if (!cur) {
      byKey.set(f.key, {
        key: f.key, title: f.title, family: f.family,
        axes: [f.axis], reasons: [f.detail],
        score: contribution, provenance: f.provenance ?? null,
        topContribution: contribution, topTitle: f.title,
      });
    } else {
      cur.axes.push(f.axis);
      cur.reasons.push(f.detail);
      cur.score += contribution;
      // Title comes from the single largest contributor — the sharpest reason.
      if (contribution > cur.topContribution) { cur.topContribution = contribution; cur.title = f.title; }
      cur.provenance = cur.provenance ?? f.provenance ?? null;
    }
  }
  return [...byKey.values()]
    .map((f) => ({ ...f, axes: [...new Set(f.axes)] }))
    .sort((a, b) => b.score - a.score);
}
