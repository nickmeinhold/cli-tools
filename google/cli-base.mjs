// Shared subcommand-dispatch helpers for gmail/gcal CLIs.

import { parseArgs } from "node:util";

export function dashToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

export async function runDispatcher(toolName, COMMANDS) {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    const longName = { gmail: "Gmail", gcal: "Calendar", gdrive: "Drive" }[toolName] || toolName;
    console.log(`${toolName} — CLI for Google ${longName}\n`);
    console.log(`Usage: ${toolName} <subcommand> [options]\n`);
    console.log(`Auth: OAuth refresh token at ~/.claude/cli-tools/.tokens/google.json.`);
    console.log(`First-time setup: source ~/.claude/.env then run \`${toolName} auth\`\n`);
    console.log("Subcommands:");
    for (const [name, cmd] of Object.entries(COMMANDS)) {
      console.log(`  ${name.padEnd(22)} ${cmd.help}`);
    }
    console.log(`\nRun \`${toolName} <subcommand> --help\` for options.`);
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const subcommand = argv[0];
  const cmd = COMMANDS[subcommand];
  if (!cmd) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error(`Run \`${toolName} --help\` for the list of subcommands.`);
    process.exit(2);
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`${toolName} ${subcommand} — ${cmd.help}\n`);
    if (Object.keys(cmd.opts).length === 0) {
      console.log("(no options)");
    } else {
      console.log("Options:");
      for (const opt of Object.keys(cmd.opts)) {
        const req = (cmd.required || []).includes(opt) ? " (required)" : "";
        console.log(`  --${opt}${req}`);
      }
    }
    process.exit(0);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options: cmd.opts,
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`${toolName} ${subcommand}: ${err.message}`);
    process.exit(2);
  }

  for (const req of cmd.required || []) {
    if (parsed.values[req] === undefined) {
      console.error(`${toolName} ${subcommand}: --${req} is required`);
      process.exit(2);
    }
  }

  const args = {};
  for (const [k, v] of Object.entries(parsed.values)) {
    args[dashToCamel(k)] = v;
  }

  try {
    await cmd.run(args);
  } catch (err) {
    if (isAuthExpiredError(err)) {
      console.error(
        `Your Google OAuth token has expired or been revoked.\n` +
          `Re-consent with: ${toolName} auth`
      );
      process.exit(2);
    }
    // googleapis errors carry a useful .errors array; stringify what we can.
    const detail = err.errors ? JSON.stringify(err.errors) : "";
    console.error(`${err.message}${detail ? "\n" + detail : ""}`);
    process.exit(1);
  }
}

// Detect Google OAuth token-expiry / revocation across the shapes googleapis
// can throw: invalid_grant from token refresh, 401 with REAUTH_REQUIRED, the
// "Not authenticated" thrown by getAuthClient when the token file is missing.
function isAuthExpiredError(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  if (msg.includes("Not authenticated")) return true;
  if (msg.includes("invalid_grant")) return true;
  if (msg.includes("Token has been expired or revoked")) return true;
  const data = err.response?.data;
  if (data?.error === "invalid_grant") return true;
  if (data?.error === "invalid_token") return true;
  if (err.code === 401 || err.response?.status === 401) {
    // 401 from a Google API after the refresh succeeded is rare but treat
    // as auth-expired for the user's sanity.
    return true;
  }
  return false;
}
