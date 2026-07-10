#!/usr/bin/env node
// humanitix — CLI for the Humanitix public API (https://api.humanitix.com/v1).
// Mirrors the `kan` CLI conventions: x-api-key auth, parseArgs subcommands, JSON out.
//
// Auth: set HUMANITIX_API_KEY in ~/.claude/.env (then `source` it).
//   Get the key from the Humanitix Console → Account → Advanced → Public API key.
//
// READ endpoints (events / orders / tickets / tags / check-in) work with any key.
// WRITE endpoints — create-event (POST /events) and update-event (PATCH /events/{id})
//   — require a SPECIAL permission that Humanitix must activate on your account.
//   Without it these return 403. Email Humanitix support to enable API event creation.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

const DEFAULT_BASE = "https://api.humanitix.com/v1";
let BASE_URL = DEFAULT_BASE;
let API_KEY = undefined;

function resolveCreds() {
  return {
    apiKey: process.env.HUMANITIX_API_KEY,
    baseUrl: (process.env.HUMANITIX_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, ""),
  };
}

// Build a querystring from a flat object, dropping undefined values.
function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function hx(path, { method = "GET", body, query } = {}) {
  if (!API_KEY) {
    throw new Error(
      "HUMANITIX_API_KEY not set. Add it to ~/.claude/.env (and `source` it). " +
        "Get it from the Humanitix Console → Account → Advanced → Public API key."
    );
  }
  const res = await fetch(`${BASE_URL}${path}${qs(query)}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface the permission-gate case with a clear hint.
    const hint =
      res.status === 403 && (method === "POST" || method === "PATCH")
        ? " — write access is permission-gated; ask Humanitix to enable API event creation on your account."
        : "";
    throw new Error(`Humanitix API error ${res.status}: ${text}${hint}`);
  }
  return text ? JSON.parse(text) : { success: true };
}

function parseJson(json) {
  return JSON.parse(json === "-" ? readFileSync(0, "utf8") : json);
}

// Assemble a base-event body from convenience flags. --json is authoritative and
// wins over flags; see the OpenAPI spec at
// https://api.humanitix.com/v1/documentation for the full event schema.
function eventBodyFromFlags(a) {
  if (a.json) return parseJson(a.json);
  const body = {};
  if (a.name) body.name = a.name;
  if (a.description) body.description = a.description;
  if (a.timezone) body.timezone = a.timezone;
  if (a.start || a.end) {
    body.dates = [{ startDate: a.start, endDate: a.end }];
    if (a.start) body.startDate = a.start;
    if (a.end) body.endDate = a.end;
  }
  if (a.venue) body.eventLocation = { venueName: a.venue, address: a.address };
  return body;
}

const COMMANDS = {
  "list-events": {
    help: "List your events. [--page N --page-size N --in-future true]",
    opts: {
      page: { type: "string" },
      "page-size": { type: "string" },
      "in-future": { type: "string" },
    },
    run: (a) =>
      hx("/events", {
        // Humanitix requires `page` (1-based). Default it so the common call just works.
        query: { page: a.page ?? "1", pageSize: a.pageSize, inFuture: a.inFuture },
      }),
  },

  "get-event": {
    help: "Get a single event by ID. --event-id ID",
    opts: { "event-id": { type: "string" } },
    required: ["event-id"],
    run: (a) => hx(`/events/${a.eventId}`),
  },

  "create-event": {
    help:
      "Create a base event (POST /events). --json '{...}' | -, OR " +
      "--name --description --start ISO --end ISO --timezone --venue --address. " +
      "REQUIRES Humanitix-activated write permission (else 403).",
    opts: {
      json: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      timezone: { type: "string" },
      venue: { type: "string" },
      address: { type: "string" },
    },
    run: (a) => hx("/events", { method: "POST", body: eventBodyFromFlags(a) }),
  },

  "update-event": {
    help: "Patch-update an event. --event-id ID --json '{...}' | - (permission-gated)",
    opts: { "event-id": { type: "string" }, json: { type: "string" } },
    required: ["event-id", "json"],
    run: (a) => hx(`/events/${a.eventId}`, { method: "PATCH", body: parseJson(a.json) }),
  },

  orders: {
    help: "List orders for an event. --event-id ID [--page N --page-size N]",
    opts: {
      "event-id": { type: "string" },
      page: { type: "string" },
      "page-size": { type: "string" },
    },
    required: ["event-id"],
    run: (a) =>
      hx(`/events/${a.eventId}/orders`, { query: { page: a.page ?? "1", pageSize: a.pageSize } }),
  },

  tickets: {
    help: "List tickets for an event. --event-id ID [--page N --page-size N]",
    opts: {
      "event-id": { type: "string" },
      page: { type: "string" },
      "page-size": { type: "string" },
    },
    required: ["event-id"],
    run: (a) =>
      hx(`/events/${a.eventId}/tickets`, { query: { page: a.page ?? "1", pageSize: a.pageSize } }),
  },

  "check-in-count": {
    help: "Get the check-in count for an event. --event-id ID",
    opts: { "event-id": { type: "string" } },
    required: ["event-id"],
    run: (a) => hx(`/events/${a.eventId}/check-in-count`),
  },

  "check-in": {
    help: "Check a ticket in. --event-id ID --ticket-id ID",
    opts: { "event-id": { type: "string" }, "ticket-id": { type: "string" } },
    required: ["event-id", "ticket-id"],
    run: (a) =>
      hx(`/events/${a.eventId}/tickets/${a.ticketId}/check-in`, { method: "POST" }),
  },

  tags: {
    help: "List tags.",
    opts: {},
    run: () => hx("/tags"),
  },
};

function dashToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function printHelp() {
  console.log("humanitix — CLI for the Humanitix public API\n");
  console.log("Usage: humanitix <subcommand> [options]\n");
  console.log(
    "Auth: HUMANITIX_API_KEY in ~/.claude/.env (Console → Account → Advanced → Public API key).\n" +
      "Reads work with any key; create/update need Humanitix-activated write permission.\n"
  );
  console.log("Subcommands:");
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(16)} ${cmd.help}`);
  }
  console.log("\nRun `humanitix <subcommand> --help` for options.");
}

function printCmdHelp(name, cmd) {
  console.log(`humanitix ${name} — ${cmd.help}\n`);
  const opts = Object.keys(cmd.opts || {});
  if (opts.length) {
    console.log("Options:");
    for (const o of opts) {
      const req = (cmd.required || []).includes(o) ? " (required)" : "";
      console.log(`  --${o}${req}`);
    }
  } else {
    console.log("(no options)");
  }
}

async function main() {
  const argv = process.argv.slice(2);

  const creds = resolveCreds();
  BASE_URL = creds.baseUrl;
  API_KEY = creds.apiKey;

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const subcommand = argv[0];
  const cmd = COMMANDS[subcommand];
  if (!cmd) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Run `humanitix --help` for the list of subcommands.");
    process.exit(2);
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    printCmdHelp(subcommand, cmd);
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
    console.error(`humanitix ${subcommand}: ${err.message}`);
    process.exit(2);
  }

  for (const req of cmd.required || []) {
    if (parsed.values[req] === undefined) {
      console.error(`humanitix ${subcommand}: --${req} is required`);
      process.exit(2);
    }
  }

  const args = {};
  for (const [k, v] of Object.entries(parsed.values)) {
    args[dashToCamel(k)] = v;
  }

  try {
    const result = await cmd.run(args);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
