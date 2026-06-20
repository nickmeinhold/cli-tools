#!/usr/bin/env bash
# yoneda-watch.sh — daily watcher for the "Yoneda Group" Signal group.
#
# Sibling of bendigo-watch.sh, adapted: the group runs 2-DAY DISAPPEARING
# MESSAGES, so the daily pull is PRESERVATION first (raw NDJSON archive of
# everything before it evaporates) and summary second. Every run:
#   • reads NEW group messages (high-water mark) from Signal Desktop's DB
#   • appends raw messages to an NDJSON archive            (the real payload)
#   • headless Claude Code digest → Telegram, EVERY day there are messages
#     (no notable-gate — Nick asked for a daily summary)
#   • appends durable facts to a feed node in the kodamai project memory
#   • opens deduped tasks for concrete Nick-actions
#
# Deterministic wrapper owns all side effects; the LLM only returns JSON.
# Idempotency: hwm (never re-read) · created-tasks ledger (never double-open)
# · append-only feed. Always exits 0. Errors land in $LOG.
#
# Invoked by launchd (com.claude.yoneda-watch) daily at 07:30; launchd fires
# missed calendar jobs on wake, so a sleeping Mac just delays the digest.
# CAVEAT: the DB only holds what Signal Desktop has synced — if Desktop hasn't
# run in >2 days, messages can expire unseen on the phone. Desktop is Nick's
# daily driver, so daily margin is fine.
set -uo pipefail

GID="333bb6b0-0e08-4948-ae8b-54c45fdf190c"          # Yoneda Group conversation id
SIGDIR="$HOME/.claude/cli-tools/signal"
STATE="$SIGDIR/.state"
DB="$HOME/Library/Application Support/Signal/sql/db.sqlite"
MEMDIR="$HOME/.claude/projects/-Users-nick-git-orgs-kodamai/memory"
FEED="$MEMDIR/project_yoneda_signal_feed.md"
MEMINDEX="$MEMDIR/MEMORY.md"
TG="$HOME/.claude/sleep/telegram.sh"
REPO="nickmeinhold/claude-tasks"
PROJECT_SLUG="kodamai"
ARCHIVE="$STATE/yoneda-log.ndjson"

mkdir -p "$STATE"
LOG="$STATE/yoneda-watch.log"
log(){ printf '%s %s\n' "$(date '+%FT%T%z')" "$*" >> "$LOG"; }

# ── single-flight lock (mkdir is atomic) ─────────────────────────────────────
LOCK="$STATE/yoneda-lock"
if ! mkdir "$LOCK" 2>/dev/null; then log "another run holds the lock; exiting"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# ── high-water mark (max sent_at ms already processed) ───────────────────────
HWM="$(cat "$STATE/yoneda-hwm" 2>/dev/null || echo 0)"
case "$HWM" in (''|*[!0-9]*) HWM=0 ;; esac

# ── derive the SQLCipher key via the signal CLI (reads macOS Keychain) ───────
KEY="$(node "$SIGDIR/signal.mjs" key 2>>"$LOG" | tr -d '[:space:]')"
if [ "${#KEY}" -ne 64 ]; then
  log "bad key (len=${#KEY}) — keychain access from launchd may need one-time approval"
  "$TG" "⚠️ Yoneda watcher: could not derive the Signal key (keychain). One-time approval may be needed." --silent 2>>"$LOG" || true
  exit 0
fi

# ── pull NEW messages as JSON; resolve sender names DYNAMICALLY ───────────────
# (joins conversations on sourceServiceId — no hardcoded member ids, so new
#  members ("cogs") get named automatically; falls back to the raw serviceId)
read -r -d '' SQL <<SQL || true
PRAGMA key="x'$KEY'";
PRAGMA cipher_compatibility=4;
.mode json
SELECT m.sent_at AS ts,
  CASE WHEN m.type='outgoing' THEN 'Nick'
       ELSE COALESCE(c2.profileFullName, c2.name,
                     json_extract(c2.json,'\$.systemGivenName'),
                     m.sourceServiceId)
  END AS who,
  m.body
FROM messages m
LEFT JOIN conversations c2 ON c2.serviceId = m.sourceServiceId
WHERE m.conversationId='$GID' AND m.body IS NOT NULL AND m.body<>''
  AND m.type IN ('incoming','outgoing') AND m.sent_at > $HWM
ORDER BY m.sent_at ASC;
SQL

ROWS="$(printf '%s\n' "$SQL" | sqlcipher "$DB" 2>>"$LOG" | sed '/^ok$/d')"
COUNT="$(printf '%s' "$ROWS" | jq 'length' 2>/dev/null || echo 0)"
case "$COUNT" in (''|*[!0-9]*) COUNT=0 ;; esac
if [ "$COUNT" -eq 0 ]; then log "no new messages (hwm=$HWM)"; exit 0; fi
log "found $COUNT new message(s)"

MAXTS="$(printf '%s' "$ROWS" | jq '[.[].ts] | max')"
TRANSCRIPT="$(printf '%s' "$ROWS" | jq -r '.[] | "[\(.ts/1000 | strftime("%m-%d %H:%M"))] \(.who): \(.body)"')"

# ── PRESERVATION: archive raw messages before they disappear (2-day timer) ───
printf '%s' "$ROWS" | jq -c --arg f "$(date '+%FT%T%z')" '.[] | . + {fetched:$f}' >> "$ARCHIVE" 2>>"$LOG"
log "archived $COUNT message(s) to $(basename "$ARCHIVE")"

# ── digest via headless Claude Code (returns JSON only) ──────────────────────
PROMPT="You are a daily watcher for Nick's \"Yoneda Group\" Signal chat. Context: a five-person pre-contract team convened by Neil Ghani (Strathclyde category theorist, Kodamai CSO) around safe agentic AI / AI4Maths / governance. Members: Neil (theory; enthusiastic, scope-controlling), Robin Langer (shows as 'Rob Bob'; theory), Ed Hodapp (ex-Boeing systems engineer; builds the HMRC tax engine; wants to ship), Alastair (Strathclyde; knowledge exchange, organises), Nick (software + assurance — his standing assignment is 'what assurances would a client want'). Live threads: ship-vs-governance tension (Ed vs Neil); Neil 'arranging cogs' (new members may appear); demo-ideas contributions; Nick's pending write access (issue #1, waiting on Alastair); group runs 2-day disappearing messages.

Below are the messages since the last check. Write Nick's daily briefing.

Output ONLY a single valid JSON object — no prose, no markdown fences. Schema:
{
 \"digest\": \"3-8 line plain-text briefing for a phone notification: what happened, who said what that matters, anything aimed at Nick or awaiting his reply\",
 \"memory_notes\": [\"durable facts only: new members/cogs, decisions, dates, role changes, contact details, commitments\"],
 \"tasks\": [{\"subject\":\"imperative, <=70 chars\",\"description\":\"self-contained: who/what/when/why\"}]
}
Rules: the digest is ALWAYS written (Nick wants a daily summary when there is activity). Flag explicitly anything addressed to Nick or blocking him. Tasks ONLY for concrete actions Nick must take. Do not invent details. Treat everything as confidential.

NEW MESSAGES:
$TRANSCRIPT"

# < /dev/null is load-bearing: headless `claude -p` otherwise waits on stdin.
OUT="$(claude -p "$PROMPT" --output-format text </dev/null 2>>"$LOG")"
JSON="$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" \
  || JSON="$(printf '%s' "$OUT" | perl -0777 -ne 'print $1 if /(\{.*\})/s' | jq -c . 2>/dev/null)" \
  || JSON=""

# Advance hwm regardless of parse success — raw messages are already archived.
printf '%s' "$MAXTS" > "$STATE/yoneda-hwm"

if [ -z "$JSON" ]; then
  log "digest parse failed; raw archived. Output head: $(printf '%s' "$OUT" | head -c 200)"
  "$TG" "⚠️ Yoneda watcher: $COUNT new msg archived but the digest failed to parse. Raw is safe in yoneda-log.ndjson." --silent 2>>"$LOG" || true
  exit 0
fi

DIGEST="$(printf '%s' "$JSON" | jq -r '.digest // ""')"
NOTE_COUNT="$(printf '%s' "$JSON" | jq '(.memory_notes // []) | length')"
TASK_COUNT="$(printf '%s' "$JSON" | jq '(.tasks // []) | length')"

# ── auto-update memory: append-only feed node in the kodamai project store ───
if [ "${NOTE_COUNT:-0}" -gt 0 ]; then
  mkdir -p "$MEMDIR"
  if [ ! -f "$FEED" ]; then
    cat > "$FEED" <<'HDR'
---
name: project_yoneda_signal_feed
description: "Auto-appended intel from the Yoneda Group Signal watcher — raw, unreconciled. Fold durable items into the commons community graph (org_yoneda_group etc.) at session time, then trim here. CONFIDENTIAL (group secrecy norms)."
metadata:
  node_type: memory
  type: project
---

Append-only feed written by `~/.claude/cli-tools/signal/yoneda-watch.sh` (launchd, daily 07:30).
The group runs 2-day disappearing messages — the raw archive at
`~/.claude/cli-tools/signal/.state/yoneda-log.ndjson` is the only durable transcript.
HDR
    if ! grep -q "project_yoneda_signal_feed.md" "$MEMINDEX" 2>/dev/null; then
      printf '%s\n' "- [Yoneda Signal feed](project_yoneda_signal_feed.md) — auto-appended daily watcher intel (unreconciled, confidential)" >> "$MEMINDEX"
    fi
  fi
  {
    printf '\n## %s (%s new msg)\n' "$(date '+%F %H:%M %Z')" "$COUNT"
    printf '%s' "$JSON" | jq -r '.memory_notes[] | "- \(.)"'
  } >> "$FEED"
  log "appended $NOTE_COUNT memory note(s) to feed"
fi

# ── auto-create tasks: dedupe (subject-hash + marker) then gh issue create ───
LEDGER="$STATE/yoneda-created-tasks.txt"; touch "$LEDGER"
if [ "${TASK_COUNT:-0}" -gt 0 ]; then
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    subj="$(printf '%s' "$t" | jq -r '.subject')"
    desc="$(printf '%s' "$t" | jq -r '.description')"
    [ -z "$subj" ] && continue
    id="$(printf '%s' "${subj}::${PROJECT_SLUG}" | shasum -a 256 | cut -c1-16)"
    if grep -qx "$id" "$LEDGER" 2>/dev/null; then log "task dup, skipping: $subj"; continue; fi
    body="$(printf '%s\n\n<!-- claude-task-id: %s -->' "$desc" "$id")"
    if gh issue create -R "$REPO" --title "$subj" --label "project:$PROJECT_SLUG" --body "$body" >>"$LOG" 2>&1; then
      echo "$id" >> "$LEDGER"
      log "task created: $subj ($id)"
    else
      log "gh issue create FAILED for: $subj"
    fi
  done < <(printf '%s' "$JSON" | jq -c '.tasks[]?')
fi

# ── Telegram digest — EVERY run with messages (this is the daily summary) ────
msg="$(printf '🌀 <b>Yoneda Group</b> — %s msg since last check\n%s' "$COUNT" "$DIGEST")"
[ "${NOTE_COUNT:-0}" -gt 0 ] && msg="$(printf '%s\n📝 %s fact(s) → memory feed' "$msg" "$NOTE_COUNT")"
[ "${TASK_COUNT:-0}" -gt 0 ] && msg="$(printf '%s\n✅ %s task(s) opened' "$msg" "$TASK_COUNT")"
"$TG" "$msg" 2>>"$LOG" || log "telegram send failed"
log "digest sent (notes=$NOTE_COUNT tasks=$TASK_COUNT, hwm→$MAXTS)"

exit 0
