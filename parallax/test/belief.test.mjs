import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// belief.mjs reads PARALLAX_STATE_DIR at import time, so set it before importing.
process.env.PARALLAX_STATE_DIR = mkdtempSync(join(tmpdir(), "parallax-belief-"));
const { loadBelief, saveBelief, updateBelief, freshRepoPrior } = await import("../lib/belief.mjs");

test("belief round-trips Beta/Gamma params through save+load", () => {
  const b = { version: 2, lastRun: "t0", authors: { self: 3, peer: 1, other: 2 },
    repos: { r: { ...freshRepoPrior("t0"), head: "abc", moveAlpha: 4, moveBeta: 7, magShape: 9, magRate: 3 } } };
  saveBelief(b);
  const loaded = loadBelief();
  assert.equal(loaded.repos.r.moveAlpha, 4);
  assert.equal(loaded.repos.r.magShape, 9);
  assert.deepEqual(loaded.authors, { self: 3, peer: 1, other: 2 });
});

test("updateBelief advances Beta on move and Gamma by burst size", () => {
  const prior = { version: 2, authors: { self: 1, peer: 1, other: 1 },
    repos: { r: { ...freshRepoPrior("t0"), head: "old", moveAlpha: 2, moveBeta: 5, magShape: 3, magRate: 2 } } };
  const obs = { ts: "t1", authorFamilies: ["self"],
    repos: { r: { head: "new", headDate: "t1", branch: "main", ahead: 0, behind: 0, upstreamGone: false, commitsSincePrior: 4 } } };
  const next = updateBelief(prior, obs);
  assert.equal(next.repos.r.moveAlpha, 3, "moved → α+1");
  assert.equal(next.repos.r.moveBeta, 5, "moved → β unchanged");
  assert.equal(next.repos.r.magShape, 7, "shape += burst (3+4)");
  assert.equal(next.repos.r.magRate, 3, "rate += 1");
});

test("updateBelief increments β (not α) on a quiet night", () => {
  const prior = { version: 2, authors: {}, repos: { r: { ...freshRepoPrior("t0"), head: "same", moveAlpha: 2, moveBeta: 5, magShape: 3, magRate: 2 } } };
  const obs = { ts: "t1", authorFamilies: [], repos: { r: { head: "same", ahead: 0, behind: 0, upstreamGone: false } } };
  const next = updateBelief(prior, obs);
  assert.equal(next.repos.r.moveAlpha, 2, "no move → α unchanged");
  assert.equal(next.repos.r.moveBeta, 6, "no move → β+1");
});

test("updateBelief retains (tombstones) a repo that vanished from the list", () => {
  const prior = { version: 2, authors: {}, repos: { gone: { ...freshRepoPrior("t0"), head: "h", moveAlpha: 5, moveBeta: 5 } } };
  const obs = { ts: "t1", authorFamilies: [], repos: { gone: { vanished: true, priorHead: "h" } } };
  const next = updateBelief(prior, obs);
  assert.ok(next.repos.gone, "vanished repo retained, not amputated");
  assert.equal(next.repos.gone.moveAlpha, 5, "priors preserved");
  assert.equal(next.repos.gone.vanishedSince, "t1", "tombstoned");
});

test("updateBelief advances the global author Dirichlet", () => {
  const prior = { version: 2, authors: { self: 1, peer: 1, other: 1 }, repos: {} };
  const next = updateBelief(prior, { ts: "t1", authorFamilies: ["peer", "peer", "self"], repos: {} });
  assert.equal(next.authors.peer, 3);
  assert.equal(next.authors.self, 2);
});
