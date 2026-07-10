# parallax

A nightly cross-repo **surprise engine** — not a status poller.

> A poller re-describes the whole world every night, so you learn to ignore it.
> parallax carries a persisted belief and speaks only where reality has **diverged**
> from what it last understood: `innovation = observe − predict`.

## TL;DR

```bash
node parallax.mjs scan            # observe the fleet, print ranked surprises, fold belief forward
node parallax.mjs scan --top 15   # show only the 15 highest-ranked
node parallax.mjs scan --no-update # dry run — don't advance the belief (repeatable)
node parallax.mjs belief          # inspect the persisted world-model
node parallax.mjs reset           # forget everything (next scan reads as first-ever)
```

Each run is one Kalman step: **carry belief → observe → compute surprise → emit ranked → update belief.** The first run has an empty prior, so it can only report *standing* state (unpushed work, silent jobs, expiring secrets); change-surprise appears from the second night on, once a baseline exists.

## Why it's a surprise engine

The persisted belief (`~/.parallax/belief.json`) is the whole point. Per repo it holds two **conjugate priors**: a `Beta(α, β)` over *will it move tonight?* and a `Gamma(shape, rate)` over *how big is a typical burst?* — plus a global `Dirichlet` over commit-author families. Surprise is the **belief shift** those priors undergo when tonight's observation arrives: `KL(posterior ‖ prior)`, in nats.

A repo that moves most nights has a fat `α`, so a move barely shifts its posterior → near-zero surprise. A "shipped and forgotten" repo (`α≈1`) that moves — or a normally-quiet repo that takes 40 commits overnight — swings the posterior hard and **screams**. This is Itti & Baldi's Bayesian surprise: data that leaves your beliefs unchanged carries no surprise, no matter how rare in Shannon terms. You can't compute it from a stateless snapshot; it requires memory of what was normal.

## The five drift axes

Each is a pure lens `(belief, observation) → Finding[]`. Findings that share a subject (`key`) are **merged**, so one repo can be lit from several sides at once.

Each is a pure lens emitting a **nat-scale contribution**, split into two families:

| | axis | family | contribution |
|---|---|---|---|
| ✴️ | **surprise** | novelty | `KL(Beta)` movement + `KL(Gamma)` burst size |
| 👤 | **provenance** | novelty | Shannon info `−ln p(family)` of the rarest non-self author |
| ⚖️ | **reconciliation** | novelty (structural) | fixed nat weight for diverged / vanished |
| 🔇 | **silent-failure** | absence | overdue log-term × blast (its own scale) |
| ⏳ | **decay** | absence | `ln(1+ahead)` unpushed · expiry hazard for secrets |

The **novelty** family scores belief-shift (a repo behaving as predicted contributes ~0 — the white-snow guard enforced by the math). The **absence** family scores a missing/overdue signal on its own log-scale, *not* smuggled into a surprise channel. The silent-failure axis checks the **effect** (a log's mtime), never the scheduler's exit status — a job can exit 0 and produce nothing. Verify the artifact, not the bookkeeping.

## Scoring

`score(subject) = Σ wᵢ · min(contributionᵢ, natCeiling)`

Findings sharing a subject are summed — **additive in log-space**, because surprise *lives* in log-space (KL is a sum of log-ratios). A subject lit by several axes accumulates; no axis annihilates another (the failure of a raw product) and no max-per-dimension manufactures a composite no axis observed. Each contribution is weighted (`SCORING.weights`) and clamped at a nat ceiling — the governor that stops one huge KL term dominating the board.

## Configuration

`lib/registry.mjs` is the human-edited seam — the two axes that can't be inferred from git alone:

- **`HEARTBEATS`** — what should be beating, and how stale is too stale. Each has a freshness *probe* (a file or a directory's newest entry).
- **`SECRETS`** — hard expiry cliffs (e.g. the `claude setup-token` OAuth token). Urgency ramps over the final ~6 months.
- **`SELF_EMAILS` / `PEER_MARKERS` / `classifyAuthor`** — the identities that separate *your work* from *a peer Claude* from *entropy* (read from `git config` + `PARALLAX_SELF_EMAILS`, no PII in tracked source).
- **`SCORING`** — per-axis weights + the nat ceiling (the governor).
- **`.parallaxignore`** (in the parallax dir, and/or `<gitRoot>/.parallaxignore`) — globs of repos to exclude entirely, so vendored mirrors don't bias the priors.

Environment overrides: `PARALLAX_STATE_DIR` (belief location), `PARALLAX_GIT_ROOT` (fleet root, default `~/git`), `PARALLAX_SELF_EMAILS` (extra self identities).

## Nightly agent

`parallax-nightly.sh` + `com.claude.parallax.plist` run a full-fleet scan daily at 07:00
and Telegram Nick a ranked digest **only when the top finding clears a threshold**
(`PARALLAX_THRESHOLD`, default 0.5 nats) — silence on a quiet morning is the point.
The plist is versioned here and deployed to `~/Library/LaunchAgents`:

```bash
cp com.claude.parallax.plist ~/Library/LaunchAgents/ && launchctl load -w ~/Library/LaunchAgents/com.claude.parallax.plist
```

The wrapper sources `~/.claude/.env` and pins the nvm node path (launchd runs a
stripped env); runtime state (log, last scan, last digest) lives in `.state/`.

## Status

Bayesian core implemented and tested (`node --test`, 16 checks incl. a numeric-quadrature cross-check of the KL kernel). Verified end-to-end over the full ~560-repo fleet (~6s): surprise fires in nats with the movement + burst split visible, a bigger burst scores higher, cold-start is silent, vanished repos fire. Math kernel is `lib/stats.mjs` (lgamma/digamma + closed-form Beta/Gamma KL). See `NOTES.md` for the remaining backlog (per-repo provenance Dirichlet, nightly `launchd` agent + digest, attention-tuning from feedback).
