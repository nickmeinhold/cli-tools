# RESEARCH — scout opportunity engine (Heat)

Deep-research pass `wf_0ef4d60a-5ad`, 24/25 claims survived 3-vote adversarial
verification. Full report: the workflow output. Central falsifier confronted head-on.

## Verdict

**Belief-shift surprise ALONE is the wrong ranking for opportunities** — necessary,
not sufficient. The field is unanimous and primary-sourced.

## Load-bearing findings

1. **Serendipity = unexpectedness ∩ relevance/value** (Kotkov, KBS 2016:
   `I_ser = I_rel ∩ I_nov ∩ I_unexp`). Raising raw surprise *mechanically lowers*
   relevance (far-from-profile items are disproportionately junk). [3-0]
2. **Conjoin, don't sum.** "A formula that sums the components lets one component
   score exceptionally high, masking a low score in another" (RecSys '25,
   2505.15440). → **product (surprise × value × actionability) or per-factor hard
   floor**, NOT a weighted log-sum. This is the direct inverse of the watchman's
   correct-for-alarms additive rule. [3-0]
3. **Bayesian surprise is a GOOD surprise term** — Hasan & Bunescu (RecSys '23,
   "Topic-Level Bayesian Surprise and Serendipity") show it beats distance-based
   novelty at matching human surprise, coupled with a value/relevance term. The
   existing engine's core is sound; multiply it, don't replace it. [3-0]
4. **The VALUE term has no off-the-shelf estimator for this domain, and every
   hand-crafted proxy correlates <21.5% with real perceived serendipity — LLM
   judges beat them all** (2507.17290). → the value/actionability term should be
   an **LLM judge**, not a hand-tuned formula. [3-0]
5. **Horvitz interruption economics** (CHI '99, UAI '99, BusyBody CSCW '04):
   surface only when `NEVA = EVTA − ECA > 0` (net expected value of a timely alert
   minus interruption cost); act iff `P(goal|E) > p*`, a computable, context-
   dependent threshold. A **nightly batched digest is "bounded deferral"** — low
   interruption cost, so the bar can be relaxed vs a real-time ping, but capped
   per-digest. [3-0]

## Per-axis reality (precision / tractability)

| Axis | Evidence | Verdict |
|---|---|---|
| **Latent abstraction** | SourcererCC **91%** precision (BigCloneBench); residual 9% FPs are exactly "clones that SHOULD stay duplicated" (shared-API idioms, test boilerplate) — syntax can't tell refactor-worthy from legit-dup | REAL; needs a value filter. My fleet probe confirmed: `source .env`×10 is legit-dup noise |
| **Unblocking** | under-evidenced in fan-out, but deterministic graph reachability (mature) | **Cheapest + highest precision → BUILD FIRST** |
| **Convergence** | no surviving claims; co-evolution mining exists, precision unknown | Open; medium |
| **Adjacency** | link prediction is mature but fan-out missed it | Open; consent-gated |
| **Recombination** | computational analogy/bisociation at scale = **known-hard, low-precision** | **DESCOPE or cheapen to an LLM-pair-judge** |

## What this does to the framing

- The five axes are **candidate GENERATORS** (cheap surprise signal), not the
  engine. The engine is: generate candidates → Bayesian surprise term → **LLM
  value/actionability judge** → **conjoined product** → **Horvitz surfacing gate**
  → capped nightly digest.
- Reuse the watchman substrate for the surprise term; **swap sum → product** and
  **add the LLM judge** as the value term.
- Build order follows tractability: unblocking → latent-abstraction → convergence
  → adjacency → recombination (descoped).

## Caveat (carried to Temper)

Every serendipity/interruption claim is primary-sourced but **domain-transferred**
— all from recommender-systems / notification-HCI (books, POIs, email), none
validated on git+task+memory-graph data. The construct transfers in principle; the
value estimator must be *built* and is itself the riskiest component.
