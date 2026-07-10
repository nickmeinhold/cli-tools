// stats — the math kernel for parallax's Bayesian surprise.
//
// parallax ranks by belief-shift: KL(posterior ‖ prior) over conjugate models
// (Beta-Bernoulli for "did it move", Gamma-Poisson for "how much"). Those need
// lgamma and digamma, which Node doesn't ship — so they live here, with a
// dual-instrument test (KL ≥ 0 always; KL ≈ 0 when posterior == prior) gating
// every consumer. A wrong kernel produces plausible-looking garbage nats, so it
// is verified independently before any axis trusts it.
//
// KL direction is fixed: KL(posterior ‖ prior) — the Itti & Baldi convention,
// "how hard did tonight's datum revise the model". Asymmetric on purpose.

// Lanczos approximation for ln Γ(x), g=7. Accurate to ~1e-13 for x > 0.
const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function lgamma(x) {
  if (x < 0.5) {
    // reflection formula: Γ(x)Γ(1-x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS_C[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Digamma ψ(x) = d/dx ln Γ(x). Recurrence up to x ≥ 6, then asymptotic series.
export function digamma(x) {
  let result = 0;
  while (x < 6) { result -= 1 / x; x += 1; }
  const inv = 1 / x;
  const inv2 = inv * inv;
  // ψ(x) ≈ ln x − 1/(2x) − Σ B_2k/(2k x^2k)
  result += Math.log(x) - 0.5 * inv
    - inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 * (1 / 252)));
  return result;
}

// ln B(a,b) = lnΓ(a) + lnΓ(b) − lnΓ(a+b)
function lbeta(a, b) { return lgamma(a) + lgamma(b) - lgamma(a + b); }

// KL( Beta(a2,b2) ‖ Beta(a1,b1) ) — posterior ‖ prior. Closed form.
export function klBeta(a2, b2, a1, b1) {
  const kl = lbeta(a1, b1) - lbeta(a2, b2)
    + (a2 - a1) * digamma(a2)
    + (b2 - b1) * digamma(b2)
    + (a1 - a2 + b1 - b2) * digamma(a2 + b2);
  return Math.max(0, kl); // clamp tiny negative round-off; KL is ≥ 0 by definition
}

// KL( Gamma(k2,r2) ‖ Gamma(k1,r1) ) with SHAPE k, RATE r — posterior ‖ prior.
export function klGamma(k2, r2, k1, r1) {
  const kl = (k2 - k1) * digamma(k2) - lgamma(k2) + lgamma(k1)
    + k1 * (Math.log(r2) - Math.log(r1))
    + k2 * (r1 - r2) / r2;
  return Math.max(0, kl);
}
