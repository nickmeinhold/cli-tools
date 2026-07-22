#!/usr/bin/env bash
# Run this yourself (never paste your NetBank password into a Claude chat —
# that's a worse exposure than a locally sops-encrypted file). Prompts for
# client number + password, writes secrets.yaml, encrypts it in place.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ -f secrets.yaml ]; then
  echo "secrets.yaml already exists. Delete it first if you want to replace the stored credentials."
  exit 1
fi

read -rp "NetBank client number: " CLIENT_NUMBER
read -rsp "NetBank password: " PASSWORD
echo

# Write via Node's JSON.stringify (valid YAML too) instead of shell string
# interpolation — a bash heredoc previously mangled a password containing
# certain characters (parameter expansion / escaping edge case). Passing the
# values as argv and letting JSON.stringify escape them sidesteps that whole
# class of bug rather than patching one character at a time.
node -e '
const fs = require("fs");
fs.writeFileSync("secrets.yaml", JSON.stringify({
  client_number: process.argv[1],
  password: process.argv[2],
}, null, 2) + "\n");
' "$CLIENT_NUMBER" "$PASSWORD"

sops --encrypt --in-place secrets.yaml
unset CLIENT_NUMBER PASSWORD

echo "Saved and encrypted: secrets.yaml"
echo "Run 'commbank auth' now — it will auto-fill client number + password, you just handle NetCode."
