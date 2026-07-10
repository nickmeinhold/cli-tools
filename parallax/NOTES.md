# parallax — backlog

The Bayesian core (cage-match-driven) is implemented and tested. What's closed
and what genuinely remains, named not silent.

## Closed by the Bayesian-core build (2026-07-09)

- ~~Surprise can't lead / hand-tuned rarity~~ → surprise is now `KL(Beta)+KL(Gamma)`
  belief-shift in nats (`lib/stats.mjs`, `axes.mjs`).
- ~~Bernoulli discards magnitude~~ → two-part model: Beta-Bernoulli movement +
  Gamma-Poisson burst size.
- ~~Product scoring / max-then-multiply~~ → weighted log-sum of per-axis
  contributions with a nat-ceiling governor (`score.mjs`, `SCORING`).
- ~~White-snow guard only asserted~~ → enforced by construction (novelty
  contributions ARE the belief update; behaviour tested).
- ~~Absence smuggled into the surprise channel~~ → two families; silent-failure &
  decay compute their own overdue/hazard log-terms.
- ~~Vanished-repo memory leak~~ → `updateBelief` iterates belief ∪ obs; dropped
  repos are tombstoned (`vanishedSince`) and fire reconciliation.
- ~~reconciliation upstream-gone dead branch~~ → removed.
- ~~require() in ESM~~ → removed (was a redundant shadow of the top-level import).
- ~~.parallaxignore for vendored forks~~ → shipped (`.parallaxignore`, `lib/ignore.mjs`).
- ~~KL-direction open question~~ → fixed to `KL(posterior‖prior)` (Itti & Baldi).

## Remaining backlog

1. **Per-repo provenance Dirichlet.** Currently a single GLOBAL Dirichlet over
   {self, peer, other} feeds every repo's provenance. A per-repo Dirichlet would
   catch "a peer touched a repo only *you* ever touch" even if peers are common
   globally. Bigger state; deferred.
2. **Wire a nightly `launchd` agent** (`com.claude.parallax`) piping `parallax scan
   --top 20` to a morning digest (Telegram). Turns parallax from a command into the
   heartbeat other tools — and a future parallax-of-parallax — can check.
3. **Attention-tuning / learned weights.** Log each finding + whether Nick acts /
   dismisses / ignores it, then re-weight `SCORING.weights` and the emit threshold
   toward what he acts on (TEQ/AlertPro pattern). Needs logged findings first —
   `belief.json` should start recording emitted findings so the training signal exists.
4. **Real secret expiry.** The OAuth-token expiry in `registry.mjs` is a
   placeholder (`2027-01-01`). Set the true `claude setup-token` expiry.
5. **Heartbeat probe accuracy.** `meds-reminder` fires "no signal" because the cron
   doesn't write the probed log — confirm each job's real output artifact and point
   the probe at it. A wrong probe is a false alarm that trains you to ignore the axis.
6. **Absence↔novelty commensurability.** The two families now share the nats scale
   by weight calibration, not first principles — an overdue heartbeat's nats and a
   repo-surprise's nats are only *roughly* comparable. Revisit once real rankings
   accrue and #3's feedback exists to calibrate against.
