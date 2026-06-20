#!/bin/bash
# Wrapper launched by launchd to run the WhatsApp watcher under nvm-managed node.
#
# Why a wrapper: launchd plists hard-code an absolute node path. nvm installs
# node under a versioned directory (v20.20.0/bin/node), so the path goes stale
# every nvm upgrade. Sourcing nvm.sh and using `nvm use default` keeps us on
# whatever version is the current default.
#
# Logs go to ~/.love_agent/logs/ alongside corpus data.

set -e

# Source nvm. nvm's installer adds these lines to .zshrc; we replicate them
# here so the wrapper works under launchd (which doesn't load login shells).
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use whichever node is the user's default. Falls back to "current" alias if
# default isn't set. Quietly — we don't want chatter in the launchd stdout log.
nvm use --silent default || nvm use --silent current || true

exec node "$HOME/.claude/cli-tools/whatsapp/whatsapp.mjs" watch --include-groups
