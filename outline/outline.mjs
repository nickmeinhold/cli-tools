#!/usr/bin/env node
// outline — CLI for the Outline (getoutline.com) wiki API.
//
// Outline's API is RPC-over-POST: every endpoint is POST /api/<verb>.<action>
// with a JSON body, returning {data, status, ok} on success or {ok:false,
// error, status, message} on failure. Auth is Bearer token.
//
// Setup:
//   1. Get an API token at Outline → Settings → API tokens.
//   2. Add to ~/.claude/.env:  export OUTLINE_API_KEY=...
//      (and OUTLINE_API_URL if self-hosted; defaults to app.getoutline.com)
//   3. `source ~/.claude/.env && outline auth`
//
// Multiple instances: pass `--site NAME` to use OUTLINE_<NAME>_API_KEY /
// OUTLINE_<NAME>_API_URL instead (e.g. `outline --site imagineering ...`).
// $OUTLINE_DEFAULT_SITE sets the site when --site is omitted.
//
// Output: JSON to stdout for everything (composable with jq). Errors to stderr.

import { parseArgs } from "node:util";
import { readFileSync, readSync } from "node:fs";

const DEFAULT_BASE = "https://app.getoutline.com/api";

// Resolved per invocation by resolveCreds() once the --site flag is known.
let BASE = DEFAULT_BASE;
let TOKEN = undefined;

// Pick credentials for a named site, falling back to the unscoped vars.
//
// Precedence:
//   --site NAME            → OUTLINE_<NAME>_API_KEY / OUTLINE_<NAME>_API_URL
//   $OUTLINE_DEFAULT_SITE  → same, using that site name
//   neither                → bare OUTLINE_API_KEY / OUTLINE_API_URL (back-compat)
//
// Site names are normalised to UPPER_SNAKE for the env lookup, so
// `--site imagineering` reads OUTLINE_IMAGINEERING_API_KEY.
function resolveCreds(site) {
  const effective = site ?? process.env.OUTLINE_DEFAULT_SITE;
  if (effective) {
    const prefix = `OUTLINE_${effective.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`;
    const key = process.env[`${prefix}API_KEY`];
    const url = process.env[`${prefix}API_URL`];
    if (!key) {
      die(`no API key for site '${effective}'. Set ${prefix}API_KEY in ~/.claude/.env (and \`source\` it).`, 2);
    }
    return { token: key, base: (url ?? DEFAULT_BASE).replace(/\/$/, "") };
  }
  const key = process.env.OUTLINE_API_KEY;
  const url = process.env.OUTLINE_API_URL;
  return { token: key, base: (url ?? DEFAULT_BASE).replace(/\/$/, "") };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function die(msg, code = 1) {
  process.stderr.write(`outline: ${msg}\n`);
  process.exit(code);
}

async function call(verb, body = {}) {
  if (!TOKEN) {
    die("OUTLINE_API_KEY not set. Add it to ~/.claude/.env (and `source` it).", 2);
  }
  const url = `${BASE}/${verb}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok || json?.ok === false) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`;
    die(`${verb}: ${msg} (status ${json?.status ?? res.status})`, 1);
  }
  return json;
}

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let bytes;
  while ((bytes = readSync(0, buf, 0, buf.length, null)) > 0) {
    chunks.push(Buffer.from(buf.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function resolveText(args, { required = false } = {}) {
  if (args.text != null) return args.text;
  if (args.textFile != null) {
    return args.textFile === "-" ? readStdin() : readFileSync(args.textFile, "utf-8");
  }
  if (required) die("provide --text or --text-file (or --text-file - for stdin)", 2);
  return undefined;
}

function dashToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ─────────────────────────── subcommand definitions ───────────────────────────

const COMMANDS = {
  auth: {
    help: "Verify the API key and print the authenticated user + team",
    opts: {},
    async run() {
      out(await call("auth.info"));
    },
  },

  // ── collections ─────────────────────────────────────────────────────────────
  "collections.list": {
    help: "List collections in the workspace",
    opts: { limit: { type: "string" }, offset: { type: "string" } },
    async run({ limit, offset }) {
      out(await call("collections.list", {
        limit: limit ? Number(limit) : 25,
        offset: offset ? Number(offset) : 0,
      }));
    },
  },
  "collections.info": {
    help: "Get a single collection by id",
    opts: { id: { type: "string" } },
    required: ["id"],
    async run({ id }) {
      out(await call("collections.info", { id }));
    },
  },
  "collections.create": {
    help: "Create a collection (--name; optional --description, --color hex, --permission read|read_write, --private)",
    opts: {
      name: { type: "string" },
      description: { type: "string" },
      color: { type: "string" },
      permission: { type: "string" }, // read | read_write | omit for no default member access
      private: { type: "boolean" },
    },
    required: ["name"],
    async run(args) {
      const body = { name: args.name };
      if (args.description != null) body.description = args.description;
      if (args.color) body.color = args.color;
      if (args.permission) body.permission = args.permission;
      if (args.private) body.private = true;
      out(await call("collections.create", body));
    },
  },
  "collections.update": {
    help: "Update a collection (--id; any of --name/--description/--color/--permission)",
    opts: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      color: { type: "string" },
      permission: { type: "string" },
    },
    required: ["id"],
    async run(args) {
      const body = { id: args.id };
      if (args.name != null) body.name = args.name;
      if (args.description != null) body.description = args.description;
      if (args.color) body.color = args.color;
      if (args.permission) body.permission = args.permission;
      if (Object.keys(body).length === 1) die("nothing to update; pass --name/--description/--color/--permission", 2);
      out(await call("collections.update", body));
    },
  },
  "collections.delete": {
    help: "Delete a collection by id (permanently removes it and its documents)",
    opts: { id: { type: "string" } },
    required: ["id"],
    async run({ id }) {
      out(await call("collections.delete", { id }));
    },
  },

  // ── documents ───────────────────────────────────────────────────────────────
  "documents.list": {
    help: "List documents (optionally scoped to a collection or parent doc)",
    opts: {
      "collection-id": { type: "string" },
      "parent-document-id": { type: "string" },
      "user-id": { type: "string" },
      template: { type: "boolean" },
      backlink: { type: "boolean" },
      sort: { type: "string" }, // e.g. updatedAt, createdAt, title
      direction: { type: "string" }, // ASC | DESC
      limit: { type: "string" },
      offset: { type: "string" },
    },
    async run(args) {
      const body = {};
      if (args.collectionId) body.collectionId = args.collectionId;
      if (args.parentDocumentId) body.parentDocumentId = args.parentDocumentId;
      if (args.userId) body.userId = args.userId;
      if (args.template != null) body.template = args.template;
      if (args.backlink != null) body.backlink = args.backlink;
      if (args.sort) body.sort = args.sort;
      if (args.direction) body.direction = args.direction;
      body.limit = args.limit ? Number(args.limit) : 25;
      body.offset = args.offset ? Number(args.offset) : 0;
      out(await call("documents.list", body));
    },
  },
  "documents.info": {
    help: "Get a single document by id (or shareId)",
    opts: { id: { type: "string" }, "share-id": { type: "string" } },
    async run({ id, shareId }) {
      if (!id && !shareId) die("--id or --share-id required", 2);
      out(await call("documents.info", id ? { id } : { shareId }));
    },
  },
  "documents.search": {
    help: "Full-text search across documents",
    opts: {
      query: { type: "string" },
      "collection-id": { type: "string" },
      "user-id": { type: "string" },
      "date-filter": { type: "string" }, // day|week|month|year
      "status-filter": { type: "string" }, // draft|archived|published
      limit: { type: "string" },
      offset: { type: "string" },
    },
    required: ["query"],
    async run(args) {
      const body = { query: args.query };
      if (args.collectionId) body.collectionId = args.collectionId;
      if (args.userId) body.userId = args.userId;
      if (args.dateFilter) body.dateFilter = args.dateFilter;
      if (args.statusFilter) body.statusFilter = args.statusFilter;
      body.limit = args.limit ? Number(args.limit) : 25;
      body.offset = args.offset ? Number(args.offset) : 0;
      out(await call("documents.search", body));
    },
  },
  "documents.create": {
    help: "Create a document (body from --text, --text-file, or --text-file - for stdin)",
    opts: {
      title: { type: "string" },
      "collection-id": { type: "string" },
      "parent-document-id": { type: "string" },
      text: { type: "string" },
      "text-file": { type: "string" },
      publish: { type: "boolean" },
      template: { type: "boolean" },
      "template-id": { type: "string" },
    },
    required: ["title", "collection-id"],
    async run(args) {
      const text = resolveText(args, { required: true });
      const body = {
        title: args.title,
        text,
        collectionId: args.collectionId,
      };
      if (args.parentDocumentId) body.parentDocumentId = args.parentDocumentId;
      if (args.publish) body.publish = true;
      if (args.template) body.template = true;
      if (args.templateId) body.templateId = args.templateId;
      out(await call("documents.create", body));
    },
  },
  "documents.update": {
    help: "Update a document (any of --title / --text / --text-file). --append appends to body.",
    opts: {
      id: { type: "string" },
      title: { type: "string" },
      text: { type: "string" },
      "text-file": { type: "string" },
      append: { type: "boolean" },
      publish: { type: "boolean" },
      done: { type: "boolean" }, // mark editing session done (Outline collab feature)
    },
    required: ["id"],
    async run(args) {
      const body = { id: args.id };
      if (args.title != null) body.title = args.title;
      const text = resolveText(args);
      if (text != null) body.text = text;
      if (args.append) body.append = true;
      if (args.publish) body.publish = true;
      if (args.done) body.done = true;
      if (Object.keys(body).length === 1) die("nothing to update; pass --title/--text/--text-file/--publish", 2);
      out(await call("documents.update", body));
    },
  },
  "documents.move": {
    help: "Move a document to another collection or under a different parent",
    opts: {
      id: { type: "string" },
      "collection-id": { type: "string" },
      "parent-document-id": { type: "string" },
    },
    required: ["id", "collection-id"],
    async run(args) {
      const body = { id: args.id, collectionId: args.collectionId };
      if (args.parentDocumentId) body.parentDocumentId = args.parentDocumentId;
      out(await call("documents.move", body));
    },
  },
  "documents.archive": {
    help: "Archive a document",
    opts: { id: { type: "string" } },
    required: ["id"],
    async run({ id }) {
      out(await call("documents.archive", { id }));
    },
  },
  "documents.unarchive": {
    help: "Restore an archived document",
    opts: { id: { type: "string" } },
    required: ["id"],
    async run({ id }) {
      out(await call("documents.unarchive", { id }));
    },
  },
  "documents.delete": {
    help: "Delete a document (--permanent to bypass trash)",
    opts: { id: { type: "string" }, permanent: { type: "boolean" } },
    required: ["id"],
    async run({ id, permanent }) {
      const body = { id };
      if (permanent) body.permanent = true;
      out(await call("documents.delete", body));
    },
  },
  "documents.drafts": {
    help: "List your draft documents",
    opts: { limit: { type: "string" }, offset: { type: "string" } },
    async run({ limit, offset }) {
      out(await call("documents.drafts", {
        limit: limit ? Number(limit) : 25,
        offset: offset ? Number(offset) : 0,
      }));
    },
  },
  "documents.export": {
    help: "Export a document — prints the markdown body to stdout (not JSON)",
    opts: { id: { type: "string" } },
    required: ["id"],
    async run({ id }) {
      const res = await call("documents.export", { id });
      // documents.export returns { data: "markdown text..." }
      process.stdout.write((res.data ?? "") + "\n");
    },
  },

  // ── users / onboarding ───────────────────────────────────────────────────────
  "users.list": {
    help: "List workspace users (optional --query name filter)",
    opts: { query: { type: "string" }, limit: { type: "string" }, offset: { type: "string" } },
    async run({ query, limit, offset }) {
      const body = {};
      if (query) body.query = query;
      if (limit) body.limit = Number(limit);
      if (offset) body.offset = Number(offset);
      out(await call("users.list", body));
    },
  },
  "users.invite": {
    help: "Invite a person to the workspace by email (--email --name [--role member|viewer|admin]). Sends them a sign-in email; they join as a member who can edit any read_write collection.",
    opts: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" } },
    required: ["email", "name"],
    async run({ email, name, role }) {
      out(await call("users.invite", {
        invites: [{ email, name, role: role || "member" }],
      }));
    },
  },

  // ── raw escape hatch ────────────────────────────────────────────────────────
  raw: {
    help: "Call any Outline API verb with a JSON body (--verb foo.bar --body '{...}')",
    opts: { verb: { type: "string" }, body: { type: "string" } },
    required: ["verb"],
    async run({ verb, body }) {
      let parsed = {};
      if (body) {
        try { parsed = JSON.parse(body); } catch (e) { die(`--body is not valid JSON: ${e.message}`, 2); }
      }
      out(await call(verb, parsed));
    },
  },
};

// ─────────────────────────── dispatcher ───────────────────────────

function usage() {
  console.log("outline — CLI for the Outline API\n");
  console.log("Usage: outline [--site NAME] <subcommand> [options]\n");
  console.log("Multi-instance: --site NAME reads OUTLINE_<NAME>_API_KEY / OUTLINE_<NAME>_API_URL");
  console.log("  (e.g. --site imagineering → OUTLINE_IMAGINEERING_API_KEY). $OUTLINE_DEFAULT_SITE");
  console.log("  sets the site used when --site is omitted; otherwise falls back to bare");
  console.log("  $OUTLINE_API_KEY / $OUTLINE_API_URL.");
  console.log("Setup: add the keys to ~/.claude/.env and `source` it.\n");
  console.log("Subcommands:");
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(24)} ${cmd.help}`);
  }
  console.log("\nRun `outline <subcommand> --help` for options.");
}

async function main() {
  const raw = process.argv.slice(2);

  // Pull out the global --site flag (may appear anywhere) before the
  // subcommand's strict arg parser sees it.
  let site;
  const argv = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--site") { site = raw[++i]; continue; }
    if (a.startsWith("--site=")) { site = a.slice("--site=".length); continue; }
    argv.push(a);
  }

  const creds = resolveCreds(site);
  BASE = creds.base;
  TOKEN = creds.token;

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const subcommand = argv[0];
  const cmd = COMMANDS[subcommand];
  if (!cmd) {
    die(`unknown subcommand: ${subcommand}\nRun \`outline --help\` for the list.`, 2);
  }

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`outline ${subcommand} — ${cmd.help}\n`);
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
    parsed = parseArgs({ args: argv.slice(1), options: cmd.opts, strict: true, allowPositionals: false });
  } catch (err) {
    die(`${subcommand}: ${err.message}`, 2);
  }

  for (const req of cmd.required || []) {
    if (parsed.values[req] === undefined) {
      die(`${subcommand}: --${req} is required`, 2);
    }
  }

  const args = {};
  for (const [k, v] of Object.entries(parsed.values)) args[dashToCamel(k)] = v;

  await cmd.run(args);
}

main().catch((err) => die(err?.message ?? String(err)));
