#!/usr/bin/env bash
# bendigo-watch.sh — passive watcher for the "Bendigo Hacker Space" Signal group.
#
# Every run: reads NEW group messages (since a high-water mark) straight from the
# Signal Desktop SQLCipher DB, runs them through HEADLESS Claude Code (Nick's Max
# plan, zero marginal cost) to extract durable intel + action items, then:
#   • appends raw messages to an NDJSON log              (audit)
#   • appends extracted facts to an append-only memory feed node   (auto-update memory)
#   • opens deduped tasks/issues for clear action items  (auto-create tasks)
#   • pushes a Telegram digest — ONLY when something is notable    (transparency)
#
# Design: the LLM is NON-DETERMINISTIC and only ever RETURNS JSON. This wrapper is
# DETERMINISTIC and owns every side effect, with three idempotency ledgers:
#   hwm (never re-read a message) · created-tasks.txt + claude-task-id marker
#   (never double-open an issue) · append-only feed (never corrupt curated memory).
#
# Invoked by launchd (com.claude.bendigo-watch) every 30 min. Always exits 0 so a
# transient failure never wedges the agent. Errors land in $LOG.
set -uo pipefail

GID="8f358b7d-84d5-43b0-814b-a30193040bad"          # Bendigo Hacker Space conversation id
SIGDIR="$HOME/.claude/cli-tools/signal"
STATE="$SIGDIR/.state"
DB="$HOME/Library/Application Support/Signal/sql/db.sqlite"
MEMDIR="$HOME/.claude/projects/-Users-nick-git-orgs-bit-centers/memory"
FEED="$MEMDIR/project_bit_centers_signal_feed.md"
MEMINDEX="$MEMDIR/MEMORY.md"
TG="$HOME/.claude/sleep/telegram.sh"
REPO="nickmeinhold/claude-tasks"
PROJECT_SLUG="bit-centers"

mkdir -p "$STATE"
LOG="$STATE/watch.log"
log(){ printf '%s %s\n' "$(date '+%FT%T%z')" "$*" >> "$LOG"; }

# ── single-flight lock (mkdir is atomic) ─────────────────────────────────────
LOCK="$STATE/lock"
if ! mkdir "$LOCK" 2>/dev/null; then log "another run holds the lock; exiting"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# ── high-water mark (max sent_at ms already processed) ───────────────────────
HWM="$(cat "$STATE/hwm" 2>/dev/null || echo 0)"
case "$HWM" in (''|*[!0-9]*) HWM=0 ;; esac

# ── derive the SQLCipher key via the signal CLI (reads macOS Keychain) ───────
KEY="$(node "$SIGDIR/signal.mjs" key 2>>"$LOG" | tr -d '[:space:]')"
if [ "${#KEY}" -ne 64 ]; then
  log "bad key (len=${#KEY}) — keychain access from launchd may need one-time approval"
  "$TG" "⚠️ Bendigo watcher: could not derive the Signal key (keychain). One-time approval may be needed." --silent 2>>"$LOG" || true
  exit 0
fi

# ── pull NEW messages as JSON (mirrors signal.mjs: cipher_compatibility=4) ───
read -r -d '' SQL <<SQL || true
PRAGMA key="x'$KEY'";
PRAGMA cipher_compatibility=4;
.mode json
SELECT sent_at AS ts,
  CASE
    WHEN type='outgoing' THEN 'Nick'
    WHEN sourceServiceId='e43d1709-7c71-41ba-b161-8dd737d75164' THEN 'Adam'
    WHEN sourceServiceId='13b28223-1fbf-46db-8855-ab9b6842ff80' THEN 'Amanda'
    WHEN sourceServiceId='f29536fe-756b-4c2f-917c-a50f6decb01b' THEN 'Alexar'
    WHEN sourceServiceId='d9db5ede-b3c1-4ae7-a2be-6412dbcf39b9' THEN 'Wade'
    WHEN sourceServiceId='66eda24c-d29e-4cb0-924b-f8b70ef4f695' THEN 'Nick'
    ELSE 'Member'
  END AS who,
  body
FROM messages
WHERE conversationId='$GID' AND body IS NOT NULL AND body<>'' AND sent_at > $HWM
ORDER BY sent_at ASC;
SQL

ROWS="$(printf '%s\n' "$SQL" | sqlcipher "$DB" 2>>"$LOG" | sed '/^ok$/d')"
COUNT="$(printf '%s' "$ROWS" | jq 'length' 2>/dev/null || echo 0)"
case "$COUNT" in (''|*[!0-9]*) COUNT=0 ;; esac
if [ "$COUNT" -eq 0 ]; then log "no new messages (hwm=$HWM)"; exit 0; fi
log "found $COUNT new message(s)"

MAXTS="$(printf '%s' "$ROWS" | jq '[.[].ts] | max')"
TRANSCRIPT="$(printf '%s' "$ROWS" | jq -r '.[] | "\(.who): \(.body)"')"

# ── audit: append raw new messages to the NDJSON log ─────────────────────────
printf '%s' "$ROWS" | jq -c --arg f "$(date '+%FT%T%z')" '.[] | . + {fetched:$f}' >> "$STATE/bendigo-log.ndjson" 2>>"$LOG"

# ── extract via headless Claude Code (returns JSON only) ─────────────────────
PROMPT="You are a watcher for Nick's \"Bendigo Hacker Space\" Signal group. Context: BIT Centers is a vision (owner Alexar, Nick co-driver) for physical tech/maker spaces in regional Australian towns giving young people access to mentors + tools. The group coordinates a possible Bendigo space. Members: Nick, Amanda Robinson, Adam Bradley (Bendigo contact-router), Alexar, Wade.

Below are NEW messages since the last check. Extract durable intel and concrete next actions for Nick.

Output ONLY a single valid JSON object — no prose, no markdown fences. Schema:
{
 \"notable\": boolean,
 \"digest\": \"1-4 line plain-text summary for a phone notification\",
 \"memory_notes\": [\"durable facts only: new people, emails/phones, venues, scheduled dates, decisions\"],
 \"tasks\": [{\"subject\":\"imperative, <=70 chars\",\"description\":\"self-contained, includes who/what/when\"}]
}
Rules: include a task ONLY for a concrete next action Nick must take. Do not invent details. Prefer few, high-signal items. Scheduling/logistics chatter with no decision => notable:false, empty arrays. New contact details or a locked date => notable:true.

NEW MESSAGES:
$TRANSCRIPT"

# < /dev/null is load-bearing: headless `claude -p` otherwise waits on stdin
# (and can return empty). Closed stdin = immediate, deterministic completion.
OUT="$(claude -p "$PROMPT" --output-format text </dev/null 2>>"$LOG")"
# Robust parse: try whole output, else carve the first {...} block.
JSON="$(printf '%s' "$OUT" | jq -c . 2>/dev/null)" \
  || JSON="$(printf '%s' "$OUT" | perl -0777 -ne 'print $1 if /(\{.*\})/s' | jq -c . 2>/dev/null)" \
  || JSON=""

# Advance hwm regardless of parse success — raw messages are already saved, so
# nothing is lost, and we never wedge the loop reprocessing a message forever.
printf '%s' "$MAXTS" > "$STATE/hwm"

if [ -z "$JSON" ]; then
  log "extraction parse failed; raw saved. Output head: $(printf '%s' "$OUT" | head -c 200)"
  "$TG" "⚠️ Bendigo watcher: $COUNT new msg but couldn't parse the extraction. Raw saved to bendigo-log.ndjson." --silent 2>>"$LOG" || true
  exit 0
fi

NOTABLE="$(printf '%s' "$JSON" | jq -r '.notable // false')"
DIGEST="$(printf '%s' "$JSON" | jq -r '.digest // ""')"
NOTE_COUNT="$(printf '%s' "$JSON" | jq '(.memory_notes // []) | length')"
TASK_COUNT="$(printf '%s' "$JSON" | jq '(.tasks // []) | length')"

# ── auto-update memory: append to the append-only feed node ──────────────────
if [ "${NOTE_COUNT:-0}" -gt 0 ]; then
  if [ ! -f "$FEED" ]; then
    cat > "$FEED" <<'HDR'
---
name: project-bit-centers-signal-feed
description: "Auto-appended intel from the Bendigo Hacker Space Signal group watcher — raw, unreconciled. Fold into project-bit-centers at session time."
metadata:
  node_type: memory
  type: project
---

Append-only feed written by `~/.claude/cli-tools/signal/bendigo-watch.sh` (launchd, ~30 min).
Each block = facts extracted from new group messages. **Unreconciled** — promote durable items into [[project-bit-centers]] and [[concept-community-graph]], then trim here.
HDR
    # add an index pointer once
    if ! grep -q "project_bit_centers_signal_feed.md" "$MEMINDEX" 2>/dev/null; then
      printf '%s\n' "- [BIT Centers Signal feed](project_bit_centers_signal_feed.md) — auto-appended intel from the Bendigo group watcher (unreconciled)" >> "$MEMINDEX"
    fi
  fi
  {
    printf '\n## %s (%s new msg)\n' "$(date '+%F %H:%M %Z')" "$COUNT"
    printf '%s' "$JSON" | jq -r '.memory_notes[] | "- \(.)"'
  } >> "$FEED"
  log "appended $NOTE_COUNT memory note(s) to feed"
fi

# ── auto-create tasks: dedupe (subject-hash + marker) then gh issue create ───
LEDGER="$STATE/created-tasks.txt"; touch "$LEDGER"
if [ "${TASK_COUNT:-0}" -gt 0 ]; then
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    subj="$(printf '%s' "$t" | jq -r '.subject')"
    desc="$(printf '%s' "$t" | jq -r '.description')"
    [ -z "$subj" ] && continue
    # id = sha256(subject + "::" + project_slug) first 16 hex — matches task-to-gh-issue.sh
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

# ── transparency: Telegram digest, only when something is notable ────────────
if [ "$NOTABLE" = "true" ] || [ "${NOTE_COUNT:-0}" -gt 0 ] || [ "${TASK_COUNT:-0}" -gt 0 ]; then
  msg="$(printf '🛰 <b>Bendigo group</b> — %s new msg\n%s' "$COUNT" "$DIGEST")"
  [ "${NOTE_COUNT:-0}" -gt 0 ] && msg="$(printf '%s\n📝 %s fact(s) → memory feed' "$msg" "$NOTE_COUNT")"
  [ "${TASK_COUNT:-0}" -gt 0 ] && msg="$(printf '%s\n✅ %s task(s) opened' "$msg" "$TASK_COUNT")"
  "$TG" "$msg" 2>>"$LOG" || log "telegram send failed"
  log "notified (notable=$NOTABLE notes=$NOTE_COUNT tasks=$TASK_COUNT)"
else
  log "nothing notable; silent (hwm advanced to $MAXTS)"
fi

exit 0
