#!/bin/bash
# Wrapper launched by launchd to run the love_agent WhatsApp importer.
#
# This is the NDJSON *consumer*: it tails ~/.love_agent/wa-events.ndjson
# (written by the whatsapp-watcher job), re-materializes per-chat corpus files,
# and regenerates the voice fingerprint when the corpus settles.
#
# Must run from the love_agent project dir so:
#   - dotenv picks up .env (ANTHROPIC_API_KEY for fingerprint regen)
#   - node_modules / tsx resolve
#
# Same nvm-sourcing rationale as run-watch.sh — launchd doesn't load a login
# shell, so node won't be on PATH without this.

set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use --silent default || nvm use --silent current || true

# The fingerprint regen shells out to `claude` (Homebrew cask, /opt/homebrew/bin),
# which launchd's bare PATH doesn't include — without this the regen dies with
# `spawn claude ENOENT` and the fingerprint silently goes stale.
export PATH="/opt/homebrew/bin:$PATH"

PROJECT_DIR="$HOME/git/individuals/nickmeinhold/love_agent"
cd "$PROJECT_DIR"

exec npx tsx src/extractors/whatsapp.ts --watch
