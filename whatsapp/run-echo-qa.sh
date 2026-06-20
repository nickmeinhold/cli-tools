#!/bin/bash
# Wrapper launched by launchd to run the Echo-group Q&A bot under nvm-managed node.
#
# Mirrors run-watch.sh: launchd can't load a login shell, so we source nvm here to
# get a stable node, and we put Homebrew on PATH so the bot can shell out to
# `claude` (/opt/homebrew/bin/claude) for the headless judge calls.
#
# Logs go to ~/.love_agent/logs/ alongside the watcher logs.

set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use --silent default || nvm use --silent current || true

# Homebrew bin for `claude`; keep node's nvm dir (already on PATH via nvm use).
export PATH="/opt/homebrew/bin:$PATH"

exec node "$HOME/.claude/cli-tools/whatsapp/echo-qa-bot.mjs"
