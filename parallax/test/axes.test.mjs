import { test } from "node:test";
import assert from "node:assert/strict";

// Hermetic + PII-free: pin a synthetic self-identity via env before importing,
// so classifyAuthor doesn't depend on the machine's real git config.
process.env.PARALLAX_SELF_EMAILS = "tester@example.test";
const { surpriseAxis, provenanceAxis, reconciliationAxis } = await import("../lib/axes.mjs");

const SELF = ["Tester", "tester@example.test"];
const PEER = ["Claude", "noreply@anthropic.com"];

// A belief with a normally-SILENT repo and a normally-BUSY one.
function belief() {
  return {
    authors: { self: 100, peer: 1, other: 5 },
    repos: {
      silent: { head: "aaaaaaa", moveAlpha: 1, moveBeta: 30, magShape: 1, magRate: 5 },
      busy:   { head: "bbbbbbb", moveAlpha: 30, moveBeta: 1, magShape: 40, magRate: 10 },
    },
  };
}
const moved = (head, c, authors) => ({
  head, commitsSincePrior: c, authorsSincePrior: authors, ahead: 0, behind: 0, upstreamGone: false,
});

test("silent repo moving out-surprises busy repo moving", () => {
  const b = belief();
  const obs = { repos: {
    silent: moved("zzzzzzz", 1, [SELF]),
    busy:   moved("yyyyyyy", 1, [SELF]),
  } };
  const f = surpriseAxis(b, obs);
  const s = f.find((x) => x.key === "silent").contribution;
  const y = f.find((x) => x.key === "busy").contribution;
  assert.ok(s > y, `silent ${s.toFixed(3)} should exceed busy ${y.toFixed(3)}`);
});

test("bigger burst scores higher surprise on the same repo", () => {
  const b = belief();
  const small = surpriseAxis(b, { repos: { silent: moved("z1", 1, [SELF]) } })[0].contribution;
  const big   = surpriseAxis(b, { repos: { silent: moved("z2", 40, [SELF]) } })[0].contribution;
  assert.ok(big > small, `40-commit burst ${big.toFixed(3)} should exceed 1-commit ${small.toFixed(3)}`);
});

test("a repo moving exactly as predicted (busy, small) is low surprise", () => {
  const b = belief();
  const busy = surpriseAxis(b, { repos: { busy: moved("y1", 1, [SELF]) } })[0].contribution;
  assert.ok(busy < 0.5, `busy-as-usual should be near-zero nats, got ${busy.toFixed(3)}`);
});

test("provenance fires for a rare peer author, silent for self-only", () => {
  const b = belief();
  const peer = provenanceAxis(b, { repos: { silent: moved("z", 1, [PEER]) } });
  assert.equal(peer.length, 1);
  assert.ok(peer[0].contribution > 1, `rare peer should be >1 nat, got ${peer[0].contribution}`);
  assert.equal(peer[0].provenance, "peer");
  const self = provenanceAxis(b, { repos: { silent: moved("z", 1, [SELF]) } });
  assert.equal(self.length, 0, "self-authored move is work, not drift");
});

test("reconciliation fires on a vanished repo", () => {
  const b = belief();
  const obs = { repos: { gone: { vanished: true, priorHead: "deadbee" } } };
  const f = reconciliationAxis(b, obs);
  assert.equal(f.length, 1);
  assert.match(f[0].title, /vanished/);
  assert.ok(f[0].contribution > 0);
});
