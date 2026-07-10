import { test } from "node:test";
import assert from "node:assert/strict";
import { lgamma, digamma, klBeta, klGamma } from "../lib/stats.mjs";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("lgamma known values", () => {
  assert.ok(close(lgamma(1), 0));
  assert.ok(close(lgamma(2), 0));
  assert.ok(close(lgamma(5), Math.log(24)));           // Γ(5)=4!=24
  assert.ok(close(lgamma(0.5), Math.log(Math.sqrt(Math.PI))));
});

test("digamma known values", () => {
  const EULER = 0.5772156649015329;
  assert.ok(close(digamma(1), -EULER));                // ψ(1) = −γ
  assert.ok(close(digamma(2), 1 - EULER));             // ψ(2) = 1 − γ
});

test("klBeta ≥ 0 and = 0 at identity", () => {
  assert.ok(close(klBeta(3, 4, 3, 4), 0));             // posterior == prior
  for (const [a2, b2, a1, b1] of [[2,1,1,1],[1,30,1,1],[10,10,2,2],[1,1,5,5]]) {
    assert.ok(klBeta(a2, b2, a1, b1) >= 0, `KL negative for ${a2},${b2},${a1},${b1}`);
  }
});

test("klGamma ≥ 0 and = 0 at identity", () => {
  assert.ok(close(klGamma(4, 2, 4, 2), 0));
  for (const [k2, r2, k1, r1] of [[5,3,4,2],[41,2,1,1],[2,5,2,1]]) {
    assert.ok(klGamma(k2, r2, k1, r1) >= 0, `KL negative for ${k2},${r2},${k1},${r1}`);
  }
});

// Dual-instrument cross-check: analytic klBeta vs numeric quadrature of
// ∫ post(x) · ln(post(x)/prior(x)) dx over (0,1). If these agree, the closed
// form is trustworthy; if they diverge, the analytic derivation is wrong.
test("klBeta matches numeric quadrature", () => {
  const betaLogPdf = (a, b, x) =>
    (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x)
    - (lgamma(a) + lgamma(b) - lgamma(a + b));
  const numericKL = (a2, b2, a1, b1) => {
    const N = 200000; let sum = 0;
    for (let i = 1; i < N; i++) {
      const x = i / N;
      const lp = betaLogPdf(a2, b2, x);
      sum += Math.exp(lp) * (lp - betaLogPdf(a1, b1, x));
    }
    return sum / N;
  };
  for (const [a2, b2, a1, b1] of [[2,1,1,1],[5,2,1,1],[1,20,1,1]]) {
    const analytic = klBeta(a2, b2, a1, b1);
    const numeric = numericKL(a2, b2, a1, b1);
    assert.ok(close(analytic, numeric, 2e-3),
      `klBeta(${a2},${b2}‖${a1},${b1}): analytic ${analytic.toFixed(5)} vs numeric ${numeric.toFixed(5)}`);
  }
});

// The core behavioural guarantee: a SILENT repo moving is more surprising than a
// BUSY repo moving. Silent repo prior Beta(1, 30) (moved ~0/30); busy Beta(30, 1).
test("silent repo moving surprises more than busy repo moving", () => {
  const silentMove = klBeta(2, 30, 1, 30);   // Beta(1,30) observe move -> Beta(2,30)
  const busyMove   = klBeta(31, 1, 30, 1);   // Beta(30,1) observe move -> Beta(31,1)
  assert.ok(silentMove > busyMove,
    `silent ${silentMove.toFixed(5)} should exceed busy ${busyMove.toFixed(5)}`);
});
