#!/usr/bin/env node
// parallax — a nightly cross-repo SURPRISE engine, not a status poller.
//
// A poller re-describes the whole world every night and you learn to ignore it.
// parallax carries a persisted belief and speaks only where reality has DIVERGED
// from what it last understood — innovation = observe − predict. Each run is one
// Kalman step: carry belief → observe the fleet → compute surprise across five
// drift axes → emit ranked → fold the observation back into belief.
//
// Five axes: surprise (rarity of change) · provenance (who moved it) · decay
// (unpushed work, expiring secrets) · silent-failure (a beat you expected and
// didn't get) · reconciliation (records of one fact that disagree).
//
//   parallax scan [--limit N] [--top N] [--concurrency N] [--json] [--no-update]
//   parallax belief [--json]      # inspect the persisted world-model
//   parallax reset                # forget everything (next scan reads as first-ever)
//
// State: ~/.parallax/belief.json (override with PARALLAX_STATE_DIR).

import { parseArgs } from "node:util";
import { rmSync } from "node:fs";
import { loadBelief, saveBelief, updateBelief, paths } from "./lib/belief.mjs";
import { observe } from "./lib/observe.mjs";
import { AXES } from "./lib/axes.mjs";
import { merge } from "./lib/score.mjs";

const AXIS_ICON = {
  "surprise": "✴️", "provenance": "👤", "decay": "⏳",
  "silent-failure": "🔇", "reconciliation": "⚖️",
};

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }

function bar(score) {
  // score is a weighted log-sum in nats (0 → ~10+). Map to a short bar; ~5 nats
  // fills it, which is a strong single-axis surprise or several axes stacking.
  const n = Math.round(Math.min(score / 5, 1) * 10);
  return "█".repeat(Math.max(0, n)).padEnd(10, "·");
}

function render(findings, obs, opts) {
  const lines = [];
  lines.push(`parallax · ${obs.ts} · ${obs.repoCount} repos observed`);
  const shown = opts.top ? findings.slice(0, opts.top) : findings;
  if (!shown.length) {
    lines.push("");
    lines.push("  nothing surprising. the world matches what parallax last understood.");
    return lines.join("\n");
  }
  lines.push(`${findings.length} finding${findings.length > 1 ? "s" : ""}, ranked by belief-shift (nats), weighted log-sum:\n`);
  for (const f of shown) {
    const icons = [...new Set(f.axes)].map((a) => AXIS_ICON[a] || "•").join("");
    lines.push(`${bar(f.score)} ${f.score.toFixed(2)}  ${icons}  ${f.title}`);
    for (const r of f.reasons) lines.push(`             └ ${r}`);
  }
  return lines.join("\n");
}

async function cmdScan(opts) {
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const belief = loadBelief();
  const obs = await observe({ belief, concurrency: opts.concurrency, limit: opts.limit, nowMs });

  const findings = merge(AXES.flatMap((axis) => axis(belief, obs)));

  if (opts.json) {
    out({ ts: obs.ts, repoCount: obs.repoCount, findings });
  } else {
    process.stdout.write(render(findings, obs, opts) + "\n");
  }

  if (!opts.noUpdate) {
    const next = updateBelief(belief, obs);
    saveBelief(next);
  }
}

function cmdBelief(opts) {
  const belief = loadBelief();
  if (opts.json) return out(belief);
  const repos = Object.entries(belief.repos);
  process.stdout.write(
    `belief @ ${paths.BELIEF_PATH}\n` +
    `last run: ${belief.lastRun || "(never)"}\n` +
    `${repos.length} repos tracked\n`);
}

function cmdReset() {
  try { rmSync(paths.BELIEF_PATH); process.stdout.write(`forgot ${paths.BELIEF_PATH}\n`); }
  catch { process.stdout.write("nothing to forget\n"); }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string" },
    top: { type: "string" },
    concurrency: { type: "string" },
    now: { type: "string" },
    json: { type: "boolean", default: false },
    "no-update": { type: "boolean", default: false },
  },
});

const opts = {
  limit: values.limit ? Number(values.limit) : null,
  top: values.top ? Number(values.top) : null,
  concurrency: values.concurrency ? Number(values.concurrency) : 8,
  now: values.now || null,
  json: values.json,
  noUpdate: values["no-update"],
};

const cmd = positionals[0] || "scan";
try {
  if (cmd === "scan") await cmdScan(opts);
  else if (cmd === "belief") cmdBelief(opts);
  else if (cmd === "reset") cmdReset();
  else { process.stderr.write(`unknown command: ${cmd}\nusage: parallax [scan|belief|reset]\n`); process.exit(2); }
} catch (err) {
  process.stderr.write(`parallax: ${err.stack || err.message}\n`);
  process.exit(1);
}
