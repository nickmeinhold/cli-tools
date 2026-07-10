// registry — the hand-curated expectations parallax measures reality against.
//
// Two axes are DECLARATIVE, not observable from git alone: what SHOULD be
// beating (silent-failure) and what has a hard EXPIRY (decay cliffs). This file
// is the seam a human edits. Everything else is inferred from the world.
//
// Freshness is checked against the EFFECT (a log mtime, an output dir), never
// the scheduler's own "LastExitStatus" — a job can exit 0 and still produce
// nothing. Verify the artifact, not the bookkeeping.

import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = homedir();
const h = (...p) => join(HOME, ...p);

// Each heartbeat: a name, a probe that returns the freshest mtime (ms epoch)
// of whatever the job is supposed to PRODUCE, and how stale is too stale.
// probe kinds:
//   { file }         — mtime of a single file
//   { newestUnder }  — mtime of the newest dir/file directly under a directory
// EXAMPLE entries — replace with your own. Each probe points at whatever a
// scheduled job is supposed to PRODUCE (a log file, an output dir); parallax
// alarms when that artifact goes stale past expectedMaxAgeH.
export const HEARTBEATS = [
  {
    name: "nightly-backup",
    probe: { file: h(".local", "state", "backup.log") },
    expectedMaxAgeH: 30, // daily job + slack
    blast: 0.9, // losing backups is catastrophic-but-silent
  },
  {
    name: "nightly-report",
    probe: { newestUnder: h(".local", "state", "reports") },
    expectedMaxAgeH: 48, // a 2-day silence is real drift
    blast: 0.6,
  },
];

// Hard irreversibility cliffs. daysLeft ramps urgency toward the date.
// Dates are ISO; edit as credentials rotate.
export const SECRETS = [
  {
    name: "claude-code-oauth-token",
    // `claude setup-token` mints a ~1yr token. Set the real expiry when known;
    // this is a conservative placeholder so the axis is live, not a stub.
    expires: "2027-01-01",
    blast: 1.0, // every headless CC path + Bearer-OAuth path dies with it
    note: "regenerate via `claude setup-token`",
  },
];

// Known git identities, for the provenance axis (who moved it). Kept OUT of
// tracked source (public-code/private-data seam) so parallax can be mirrored
// publicly without scrubbing: the primary identity is read from `git config
// user.email`, and any additional aliases come from PARALLAX_SELF_EMAILS
// (comma-separated env var). Nothing personal is hardcoded here.
function selfEmails() {
  const set = new Set();
  try {
    const primary = execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim();
    if (primary) set.add(primary);
  } catch { /* no git identity configured — provenance simply trusts nobody as self */ }
  for (const e of (process.env.PARALLAX_SELF_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    set.add(e);
  }
  return set;
}
export const SELF_EMAILS = selfEmails();

// A commit authored by one of these (or co-authored) is a PEER agent instance,
// not entropy and not your own hands — the peer-instance-collision doctrine made
// observable. Matched case-insensitively as a substring of author name/email.
export const PEER_MARKERS = ["claude", "noreply@anthropic.com", "maxwell", "bot"];

// Single source of author-family classification, shared by observe (to advance
// the global Dirichlet) and the provenance axis (to score it). Your own hands are
// work; a peer Claude is the collision-doctrine signal; anyone else is "other".
export function classifyAuthor(nameOrEmail = "", email = "") {
  if (SELF_EMAILS.has(email) || SELF_EMAILS.has(nameOrEmail)) return "self";
  const hay = `${nameOrEmail} ${email}`.toLowerCase();
  if (PEER_MARKERS.some((m) => hay.includes(m))) return "peer";
  return "other";
}

// Axis weights + the per-contribution nat ceiling (the "governor" that stops one
// huge KL term from dominating the whole ranking). Tunable seam.
export const SCORING = {
  weights: { surprise: 1.0, provenance: 1.0, reconciliation: 0.8, "silent-failure": 1.0, decay: 0.9 },
  natCeiling: 5.0, // clamp any single axis contribution to this many nats
};
