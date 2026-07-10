# parallax — design

Grounded in deep research (2026-07-08, `wf_e7a92eb5-614`) and a working spike
(`feat/parallax-drift-scanner`). This doc is the target for adversarial review; the
skeleton is the reference implementation it describes and corrects.

## TL;DR

- **Verdict: build, don't buy.** No existing multi-repo tool carries a persisted
  belief to compute *surprise*; they are all stateless status reporters. The
  persisted-belief-vs-fleet ranking is the genuine gap.
- **Adopt two established mechanisms** rather than reinvent them: config-drift
  detection (Terraform's *refresh → plan against a persisted state file*) for the
  observe/diff loop, and the dead-man's-switch/heartbeat model (Healthchecks.io)
  for silent-failure — *probe the effect, not the scheduler*.
- **Reground the scoring in Bayesian surprise.** Rank on `KL(posterior‖prior)`,
  combine axes as a **weighted log-sum** (additive in log-space), not a linear
  product. Score belief-*change*, not raw rarity.

## 1. What's novel vs what's prior art

| Concern | Status | Source of truth |
|---|---|---|
| Persisted belief → surprise ranking of a repo fleet | **Novel — build it** | no tool does this [mgitstatus, gita: 3-0] |
| Observe live → diff vs persisted model → report only divergences | Prior art: **config-drift detection** | Terraform refresh/plan [HashiCorp: 3-0] |
| Alarm on *absence* of an expected signal | Prior art: **dead-man's-switch** | Healthchecks.io [3-0] |
| "Surprise" as a rankable magnitude | Prior art: **Bayesian surprise** | Itti & Baldi [3-0] |
| Model-free divergence fallback | Prior art: **novelty-search sparseness** | Lehman & Stanley [3-0] |
| Learning the alert threshold from operator feedback | Prior art: **TEQ / AlertPro / DeCorus** | [3-0] |

The only thing to *invent* is the composition — a persisted belief over a
developer's own fleet, updated nightly, ranked by principled surprise. Everything
else is assembled from known parts. (Open check: backstage-style catalogs —
Backstage/Roadie/Cortex — are the one place a *partial* persisted model might
already exist; verify before finalizing.)

## 2. Architecture — a Kalman step (unchanged from spike, validated)

```
load belief  →  observe fleet  →  compute divergence per axis  →  rank  →  emit
     ↑                                                                        │
     └──────────────────  fold observation into belief  ←────────────────────┘
```

This is Terraform's two-phase model: **refresh** (re-observe the world into the
persisted store) then **plan** (diff desired/expected vs actual, surface only
divergences). Difference in *intent*: Terraform's state is a reconciliation
target it auto-applies to; parallax's belief is a **predictive novelty prior it
never auto-reconciles** — it exists to be surprised, not to converge.

## 3. The scoring model — IMPLEMENTED (2026-07-09)

> Status: this section describes the shipped code, not a target. The spike's
> linear proxy has been replaced; `lib/stats.mjs` holds the KL kernel and
> `axes.mjs`/`score.mjs` compute the nats below. Verified by `node --test`.

### 3a. Surprise, done properly: Beta-Bernoulli conjugate

The spike scored a repo's motion as `1 − changeCount/obsCount` — a crude proxy.
The principled form, and it's no more code:

- Model each repo's move-probability as `P(move) = Beta(α, β)`, with
  `α = changeCount + 1`, `β = (obsCount − changeCount) + 1` (Laplace prior).
- Tonight's observation (moved / didn't) yields the posterior:
  `Beta(α+1, β)` if it moved, `Beta(α, β+1)` if not.
- **Surprise = `KL(posterior‖prior)`** — closed-form for two Betas.

A repo that moves most nights has a fat α, so a move barely shifts the posterior
→ near-zero surprise. A "shipped and forgotten" repo (α≈1) that moves swings the
posterior hard → high surprise. This is exactly Itti & Baldi's result: *"data
carries no surprise if it leaves the observer's beliefs unaffected"* — the
posterior-equals-prior case scores zero, automatically. [3-0]

**Decision to make:** KL is asymmetric and the literature uses both directions.
Pick `KL(posterior‖prior)` (the Itti & Baldi convention) and document it. Handle
signed "wows" (a belief that *decreased* is a negative per-model wow) by ranking
on the aggregate KL (always ≥ 0), not per-model signed terms.

### 3b. Combining axes: weighted log-sum, not a product

The spike's `(0.5+s)(0.5+u)(0.5+b)` avoided the annihilation bug by intuition.
The research says *why* it should be a sum: surprise lives in log-space (the
"wow" is `−log₂ P(M)/P(M|D)`), and KL itself is a sum of per-model log-ratios. So:

```
score = Σ wᵢ · contributionᵢ            (each contribution in log/nat units)
```

- No axis annihilates another (additive, not multiplicative).
- Weights `wᵢ` are the tuning surface (§3d).
- Two production precedents for the non-multiplicative shape: **DeCorus** (Weighted
  Power Mean with operator weights), **G2SF** (direction-aware bounded scaling
  around a baseline of 1). Either is a valid concrete form; start with weighted
  log-sum for interpretability.

### 3c. Two axis *families*, not five peers

The five axes aren't homogeneous — they split into two instruments:

- **Novelty / surprise** (something changed unexpectedly): surprise, provenance,
  reconciliation. These rank on belief-change (KL).
- **Absence** (an expected signal is missing): silent-failure, and the decay
  cliffs. These are dead-man's-switches — a different instrument, ranked on
  overdue-ness × blast, not on belief-change.

**Guard against the white-snow paradox** [3-0]: a naive rarity term fires on
non-discriminating outliers (a change improbable under *every* model carries
near-zero *surprise* yet maxes a rarity detector → false positive). Each
novelty-family axis must ask "does this actually shift my belief about the
repo?", not "is this rare?".

### 3d. Attention tuning (the self-improving axis)

Real alerting systems *learn* the threshold toward operator feedback rather than
fixing a statistical cutoff [TEQ/Meta, AlertPro-RL: 3-0]. The base-rate prior is
independently validated — alert fatigue is driven by the base-rate fallacy, so a
base-rate belief is the right foundation [3-0]. Design:

- Log every finding + whether Nick acted / dismissed / ignored it.
- Re-weight `wᵢ` (and the emit threshold) toward what he acts on. Start with a
  hand-set weight vector; graduate to learned weights once feedback accrues.
- This is deferred but the belief store should record findings from day one so
  the training signal exists later.

## 4. Fallback: novelty-search sparseness (when no probabilistic belief)

For axes where maintaining `P(M)` is impractical, rank by **sparseness**:
`ρ(x) = (1/k) Σ dist(x, kNN)` over previously-seen state vectors [Lehman &
Stanley: 3-0]. Needs only a store of prior observations + a distance metric — no
distribution. Open question: the concrete featurization (which repo-state
features form the vector?) and the fleet size at which full Bayesian surprise
stops being worth it.

## 5. Open questions

- **RESOLVED — KL direction:** `KL(posterior‖prior)` (Itti & Baldi convention),
  fixed in `stats.mjs`. Ranking is on the aggregate KL (always ≥ 0), so signed
  per-model wows don't arise.
- **RESOLVED — absence-family scoring:** implemented as its own log-space term
  (overdue log-ratio × blast), sharing the nats scale via weight calibration, not
  smuggled into a surprise channel. Commensurability is by weight, not first
  principles — revisit under §6/NOTES once feedback accrues.
- **Open — Backstage catalogs:** do Backstage/Roadie/Cortex persist any cross-run
  baseline? The one unverified build-vs-buy gap (low priority; we built).
- **Open — novelty-search fallback featurization** (§4) — deferred; the Bayesian
  path is live and sufficient at this fleet size.
- **Open — per-axis weights** calibration to Nick's attention → NOTES #3.

## 6. What shipped vs the spike

Implemented in the Bayesian-core build (2026-07-09): conjugate priors
(`belief.mjs`), the KL kernel (`stats.mjs`), two-family nat contributions
(`axes.mjs`), weighted log-sum + governor (`score.mjs`), innovation-measuring
observe (burst size + all authors), vanished-repo retention, `.parallaxignore`.

Carried over unchanged (validated by research + cage-match): the
observe/belief/axes/score/registry split; silent-failure probing the *effect*
mtime; `belief.json` as the durable prior; the public/private identity seam;
merge-by-key composition (only the *combine* function changed, max-product → log-sum).

## Citations

Full verified report: `wf_e7a92eb5-614` (24/25 claims survived 3-vote adversarial
verification). Key sources: Itti & Baldi *Bayesian Surprise Attracts Human
Attention* (NeurIPS 2005 / Vision Research 2009); HashiCorp drift-detection docs;
Healthchecks.io; Lehman & Stanley *Abandoning Objectives* (ECJ 2011); DeCorus /
TEQ / AlertPro / G2SF for multi-signal fusion + attention tuning.
