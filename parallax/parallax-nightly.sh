#!/usr/bin/env bash
# parallax-nightly.sh — the nightly agent. Runs a full-fleet parallax scan (advancing
# belief), and Telegrams you a ranked digest ONLY when something crosses the
# attention threshold. A surprise engine stays silent on a quiet morning — a
# nightly "all clear" would just train the ignore reflex (alert-fatigue research).
#
# launchd/cron give a stripped env: source creds + fix PATH (incl. nvm node).
# Fails CLOSED — a parallax error logs and sends nothing rather than a garbage digest.
set -uo pipefail

source "$HOME/.claude/.env" 2>/dev/null
export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

PARALLAX_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$PARALLAX_DIR/.state/nightly.log"
JSON="$PARALLAX_DIR/.state/last-scan.json"
TG_TO="${PARALLAX_TG_TO:?set PARALLAX_TG_TO to your Telegram account id (self-DM)}"
                        # Numeric: `telegram send` returns RC 0 even on a name-miss,
                        # so never use a name here — use the numeric account id.
THRESHOLD="${PARALLAX_THRESHOLD:-0.5}"   # min top-finding nats to bother you
mkdir -p "$PARALLAX_DIR/.state"

stamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }

# Run the scan (updates belief). --json to a file; capture rc.
if ! node "$PARALLAX_DIR/parallax.mjs" scan --json > "$JSON" 2>>"$LOG"; then
  echo "$(stamp) ERROR parallax scan failed (rc=$?), sending nothing" >> "$LOG"
  exit 0   # fail closed
fi

# Format a digest IF the top finding clears the threshold; else print nothing.
DIGEST=$(node -e '
const fs=require("fs");
const {findings=[],repoCount=0,ts=""}=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const thr=parseFloat(process.argv[2]);
if(!findings.length||findings[0].score<thr)process.exit(0);
const bar=s=>"█".repeat(Math.round(Math.min(s/5,1)*10)).padEnd(10,"·");
const top=findings.slice(0,12);
let out=`🔭 parallax · ${repoCount} repos · ${findings.length} findings\n\n`;
for(const f of top){out+=`${f.score.toFixed(2)}  ${f.title}\n`;}
if(findings.length>top.length)out+=`\n…and ${findings.length-top.length} more.`;
process.stdout.write(out);
' "$JSON" "$THRESHOLD" 2>>"$LOG")

TOP=$(node -e 'const{findings=[]}=require(process.argv[1]);console.log(findings[0]?findings[0].score.toFixed(2):"0")' "$JSON" 2>/dev/null)

if [ -n "$DIGEST" ]; then
  printf '%s' "$DIGEST" > "$PARALLAX_DIR/.state/last-digest.txt"
  if telegram send --to "$TG_TO" --file "$PARALLAX_DIR/.state/last-digest.txt" >/dev/null 2>>"$LOG"; then
    echo "$(stamp) sent digest (top=$TOP)" >> "$LOG"
  else
    echo "$(stamp) ERROR telegram send failed (top=$TOP)" >> "$LOG"
  fi
else
  echo "$(stamp) quiet (top=$TOP < $THRESHOLD), no message" >> "$LOG"
fi
