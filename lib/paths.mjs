// Single source of truth for cli-tools runtime credential + session-state paths.
// Every CLI imports TOKENS_DIR from here — never hardcode the location again.
import { join } from "node:path";
import { homedir } from "node:os";

// All logged-in sessions, API tokens, cookie stores, and per-bot runtime state.
export const TOKENS_DIR = join(homedir(), ".claude", ".cli-tokens");
