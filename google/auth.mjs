// Shared Google auth for the gmail/gcal CLIs.
// OAuth loopback flow against a user-owned Desktop OAuth client (Testing mode).
// Refresh tokens are persisted at ~/.claude/cli-tools/.tokens/google.json.
// In Testing mode Google expires refresh tokens after 7 days — re-run `gmail auth`.

import { google } from "googleapis";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";

const TOKEN_DIR = join(homedir(), ".claude/cli-tools/.tokens");
const TOKEN_FILE = join(TOKEN_DIR, "google.json");

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

const SCOPES = [
  // Full mailbox scope: required for IMAP access over XOAUTH2 (the Vahide
  // reactive responder daemon uses IMAP IDLE). gmail.modify alone is enough
  // for the REST API but Google gates raw IMAP behind https://mail.google.com/.
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
];

function loadTokens() {
  if (!existsSync(TOKEN_FILE)) return null;
  return JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
}

function saveTokens(tokens) {
  if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function makeOAuthClient(redirectUri) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set " +
        "(see ~/.claude/.env)"
    );
  }
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);
}

export async function getAuthClient() {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error(
      "Not authenticated. Run `gmail auth` to complete the consent flow."
    );
  }
  const client = makeOAuthClient();
  client.setCredentials(tokens);
  // googleapis auto-refreshes when access_token expires using the refresh_token.
  return client;
}

// Loopback OAuth flow: spin up an ephemeral http server on 127.0.0.1, open
// the consent URL, capture the redirect, exchange the code for tokens.
export async function runConsentFlow() {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400).end(`Auth error: ${error}`);
          server.close();
          reject(new Error(`Consent denied: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400).end("Missing code parameter");
          return;
        }
        const port = server.address().port;
        const client = makeOAuthClient(`http://127.0.0.1:${port}/oauth/callback`);
        const { tokens } = await client.getToken(code);
        saveTokens(tokens);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style='font-family:sans-serif;padding:2em'>" +
            "<h2>Authenticated.</h2>" +
            "<p>You can close this tab and return to your terminal.</p>" +
            "</body></html>"
        );
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500).end(`Server error: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const client = makeOAuthClient(`http://127.0.0.1:${port}/oauth/callback`);
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
      });
      console.error(`Opening browser for consent…`);
      console.error(`If it doesn't open automatically, visit:\n${authUrl}\n`);
      exec(`open "${authUrl}"`);
    });
  });
}
