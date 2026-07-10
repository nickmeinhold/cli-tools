# DESIGN — scout, the opportunity engine (RECAST, post-Temper)

Recast after a 3-way design cage-match (Maxwell + Carnot + Tesla, unanimous
RECAST NEEDED). The first cast was "Parallax cosplay" — it laundered a KL
calculator into a world-model it doesn't have, made an unvalidated LLM judge the
true critical path while dressing it as Bayesian serendipity, and rejected only
alternatives weaker than itself. This recast adopts the adversaries' unanimous
prescription: **a thin offense tool that earns every ounce of complexity from
measured act-rate.** Re-temper waived — this design IS the tempered consensus, not
a new architecture to re-strike.

## What the temper killed (folded, not papered)

- **Surprise-as-decoration → CUT from v1.** Parallax's priors (repo-move Beta,
  burst Gamma) do not transfer to "did a blocker clear / should this be extracted."
  Reusing `stats.mjs` KL is reuse of a calculator, not a belief. Surprise must
  EARN its slot later via a head-to-head, not inherit it.
- **Five axes → 1–2.** Only unblocking (deterministic) and latent-abstraction
  (SourcererCC-evidenced) have real footing. Convergence/adjacency/recombination →
  hypothesis backlog, not build steps.
- **Product `surprise × value` → GONE.** It suppresses unsurprising-but-valuable
  openings (the ones Nick most wants). Rank by value; surprise never gates.
- **Horvitz gate → honestly "a capped digest."** Drop the decision-theory branding.
- **"Runs locally" privacy claim → CORRECTED.** Headless Claude egresses context to
  Anthropic's API. Consent must cover *what leaves the box*, not just *who gets contacted*.

## The recast: tiered, act-rate-gated

Each tier ships and is measured before the next is justified. **The only metric
that can falsify a tier is weekly act-rate / dismiss-rate on digest items** — not
the elegance of any axis.

### v0 — Deterministic unblocking join (days, no LLM, no surprise)
The first shippable unit that matches the evidence. A join, not an engine:
`still-open tasks  ⨝  fleet "named blocker landed" events  →  digest`.
- Source: GH `nickmeinhold/claude-tasks` (open/shelved tasks, their named blockers)
  × recent fleet ship-events (merges/releases/commits that satisfy a blocker).
- No admission LLM, no KL, no product. Optionally one LLM line to *rewrite for
  readability* — never for admission.
- **Gate to v0b:** did Nick act on unblocking items within 48h? If yes, this alone
  may be most of the value.

### v0b — The morning brief (one LLM call, the 80/10 baseline)
A SINGLE headless-Claude pass over structured inputs → ≤5 openings.
- Inputs: yesterday's cross-repo commit/diff summary (top N moved repos) + open/
  shelved task deltas + memory-graph hot nodes.
- Output: ≤5 openings, each with evidence link, why-now, suggested action,
  confidence. **Adversarially prompted: default to "nothing worth surfacing";
  a low-confidence opening is dropped, not padded.**
- This is the baseline the heavier machinery must beat. If v0b wins on act-rate,
  the honest conclusion is "scout is a better morning brief + an unblocking join,"
  and the offense-engine-isomorphic-to-Parallax framing is abandoned.

### v1 — Latent abstraction (offline weekly, not nightly)
Clone/duplication as a WEEKLY offline report (SourcererCC-class or a token-shingle
first pass), with an LLM "should this be extracted?" filter on the TOP clusters
only — the value filter that suppresses the 9% FPs (test boilerplate, thin API
idioms; my fleet probe hit exactly these: `source .env`×10 is legit-dup). Not a
558-repo nightly job.

### v2 — Surprise earns its slot (conditional, only if v0/v0b plateau)
Only if the baseline loses act-rate to a hypothesis: build **opportunity-specific**
belief state (NOT Parallax's repo-move priors — genuinely new observation models
per opportunity class) and run a real **value-only vs value×surprise A/B**.
Surprise ships only if it wins the head-to-head. Same for convergence/adjacency/
recombination: each is a hypothesis that must beat the baseline before it's built.

## Ranking (recast)

`rank by value; hard floor on value AND actionability; surprise (if ever) a
tie-break bonus, never an admission gate.` Value and actionability come from the
LLM judge but are known-correlated — treat as one judged impression with a floor,
not two independent multiplied factors (avoids double-counting one LLM vibe).

## Blast radius & consent (recast — honest)

- **Egress, not local.** Headless Claude sends repo/task/memory excerpts to
  Anthropic's API (Nick's own account; configure zero-retention). Mitigate:
  allowlist/redact what enters the prompt; never paste secrets; the digest itself
  is a surface that can leak — treat it as egress too.
- **Adjacency (backlog) profiles people.** Consent covers ingestion/scoring, not
  just contact: allowed sources, retention, exclusion list, and what may appear in
  a digest. Deferred with the axis.
- **Cost is real.** v0 is a cheap join. v0b is ONE nightly LLM call (bounded).
  Clone mining (v1) is a heavy OFFLINE weekly job, not a cheap nightly generator.
- **Separate state from Parallax** — different belief namespace AND (when v2) genuinely
  different state, not just a different directory.

## The load-bearing experiment (was an "open variable"; now the first test)

**Does anything beat v0b?** Ship v0 + v0b, log act/dismiss for two weeks. If the
one-call brief + deterministic join carries the value, scout is DONE at v0b and the
whole surprise/five-axis apparatus is correctly never built. That is a *win*, not a
shortfall — the crucible forging a small true thing instead of a large hopeful one.

## Rejected alternatives (recast — now includes the one that dissolved v1-cast)

- **Reuse Parallax's belief as the surprise term** — rejected: it's a calculator,
  not a transferable world-model; the priors don't fit opportunity classes.
- **Product of surprise × value** — rejected: suppresses unsurprising-valuable openings.
- **Five nightly generators** — rejected: 4/5 unevidenced; build 1–2, earn the rest.
- **Real-time pings / structure-mapping recombination / hand-tuned value formula** —
  rejected as before (bounded deferral; known-hard; <21.5% proxy correlation).

## Open variables (enumerated)

- v0b's exact prompt + confidence floor (1–2 iterations vs real digests + Nick's react).
- The act-rate threshold that promotes a tier (and the 2-week measurement mechanics).
- v0's "blocker satisfied" matcher (how a task's named blocker maps to a ship event).
- Whether v1 clone mining uses an existing tool (SourcererCC/PMD-CPD) or a cheap
  shingle pass — a small second research/spike question.
