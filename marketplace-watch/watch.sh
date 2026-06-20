#!/usr/bin/env bash
# Daily Facebook Marketplace watcher (multi-target).
# For each watch target: scrapes a Marketplace search via the authenticated
# playwright session, filters by price + relevance, dedupes against
# previously-seen listings, and emails all new matches in one combined message.
#
# First-time setup (interactive, one-off):
#   playwright auth --site https://www.facebook.com --name fb-marketplace
# Re-run that whenever the session expires (watcher emails you if it suspects this).
#
# To add/adjust a target, edit the `watch_target` calls at the bottom.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────
CITY="melbourne"                    # Marketplace location slug
NOTIFY_TO="your@email.com"  # change if you want alerts elsewhere
STORAGE="fb-marketplace"            # playwright session name

DIR="$HOME/.claude/cli-tools/marketplace-watch"
SEEN="$DIR/seen.json"
LOG="$DIR/watch.log"
PW="node $HOME/.claude/cli-tools/playwright/playwright.mjs"
GMAIL="node $HOME/.claude/cli-tools/google/gmail.mjs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Env (gmail/playwright OAuth + token paths)
set -a; source "$HOME/.claude/.env" 2>/dev/null || true; set +a

[ -f "$SEEN" ] || echo "[]" > "$SEEN"

# Per-run accumulators (cleaned up on exit):
#   NEW_ACC  — JSONL of new matches across all targets (each tagged with .watch)
#   IDS_ACC  — running union of seen IDs (seeded from the persisted store)
NEW_ACC="$(mktemp)"; : > "$NEW_ACC"
IDS_ACC="$(mktemp)"; cp "$SEEN" "$IDS_ACC"
trap 'rm -f "$NEW_ACC" "$IDS_ACC" "$IDS_ACC.tmp"' EXIT
SCRAPE_FAILED=0

# ── watch_target NAME QUERY CAP INCLUDE_RE EXCLUDE_RE ───────────────────────
# Query broad, filter precise: FB's fuzzy search is unreliable, so the query is
# loose and INCLUDE_RE/EXCLUDE_RE (case-insensitive, applied to the title) do
# the real relevance work.
watch_target() {
  local name="$1" query="$2" cap="$3" inc="$4" exc="$5"
  local q_enc="${query// /+}"
  local url="https://www.facebook.com/marketplace/${CITY}/search/?query=${q_enc}&maxPrice=${cap}&sortBy=creation_time_descend"

  log "[$name] scraping: $url"
  local raw
  raw="$($PW eval --url "$url" --script "$DIR/scrape.js" --storage "$STORAGE" 2>>"$LOG" || echo '')"

  if ! echo "$raw" | jq empty >/dev/null 2>&1; then
    log "[$name] ERROR: scrape returned non-JSON (len=${#raw}) — session may be expired"
    SCRAPE_FAILED=1
    return
  fi

  local total null
  total=$(echo "$raw" | jq 'length')
  null=$(echo "$raw" | jq '[.[] | select(.price == null)] | length')
  log "[$name] found $total listings (price-unparsed: $null)"

  # Keep: parsed price <= cap, title matches INCLUDE, not EXCLUDE, not seen.
  local new n
  new="$(jq -n \
    --argjson all "$raw" \
    --slurpfile seen "$SEEN" \
    --argjson cap "$cap" \
    --arg inc "$inc" --arg exc "$exc" --arg name "$name" '
      ($seen[0] // []) as $s
      | $all
      | map(select(
          .price != null and .price <= $cap
          and (.title | test($inc; "i"))
          and (.title | test($exc; "i") | not)
          and (.id as $i | ($s | index($i)) | not)
        ))
      | map(. + {watch: $name})
    ')"
  n="$(echo "$new" | jq 'length')"
  log "[$name] new matches: $n"

  echo "$new" | jq -c '.[]' >> "$NEW_ACC"
  # Union every scraped id (not just matches) so a listing that dips below cap
  # and back up later doesn't re-alert.
  jq -n --argjson all "$raw" --slurpfile acc "$IDS_ACC" \
    '(($acc[0] // []) + ($all | map(.id))) | unique' > "$IDS_ACC.tmp" \
    && mv "$IDS_ACC.tmp" "$IDS_ACC"
}

# ── Targets ─────────────────────────────────────────────────────────────────
# M1/Apple-Silicon Mac mini: exclude accessories + Intel-era models.
watch_target "M1 Mac mini" "mac mini" 500 \
  "mac ?mini" \
  "imac|adapter|stand|hub|power supply|vesa|mount|accessor|case|cover|sticker|skin|charger|cable|sleeve|\\bbox\\b|memory|ram|ssd kit|i3|i5|i7|core 2|intel|late 201[0-8]|\\b201[0-8]\\b"

# ── Notify (one combined email) ───────────────────────────────────────────
NEW_COUNT=$(grep -c . "$NEW_ACC" 2>/dev/null || true)
NEW_COUNT=${NEW_COUNT:-0}
if [ "$NEW_COUNT" -gt 0 ]; then
  BODY="$(jq -rs '
    group_by(.watch)[]
    | "## \(.[0].watch)\n"
      + (map("• A$\(.price)  \(.title)\n  \(.location)\n  \(.url)") | join("\n"))
      + "\n"
  ' "$NEW_ACC")"
  $GMAIL send --to "$NOTIFY_TO" \
    --subject "[marketplace-watch] $NEW_COUNT new listing(s)" \
    --body "New Facebook Marketplace listings:

$BODY
— marketplace-watch" >>"$LOG" 2>&1
  log "emailed $NEW_COUNT new listings to $NOTIFY_TO"
fi

# ── Re-auth notice (if any target failed to scrape) ────────────────────────
if [ "$SCRAPE_FAILED" -eq 1 ]; then
  log "WARN: at least one target failed to scrape — emailing re-auth notice"
  $GMAIL send --to "$NOTIFY_TO" \
    --subject "[marketplace-watch] scrape failed — session may be expired" \
    --body "At least one Marketplace search returned no usable data.

Most likely the saved Facebook session expired. Re-auth with:

  playwright auth --site https://www.facebook.com --name $STORAGE

(log tail: $LOG)" >>"$LOG" 2>&1 || log "WARN: re-auth notice email also failed"
fi

# ── Persist seen ──────────────────────────────────────────────────────────
mv "$IDS_ACC" "$SEEN"
trap 'rm -f "$NEW_ACC"' EXIT   # IDS_ACC now consumed
log "done. seen-store now $(jq 'length' "$SEEN") ids"
