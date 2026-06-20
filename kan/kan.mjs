#!/usr/bin/env node
// kan — CLI for kan.bn (port of MCP server at ~/.claude/mcp-servers/kan).
// Why a CLI instead of an MCP server: zero context-window cost until invoked.

import { parseArgs } from "node:util";

const DEFAULT_BASE = "https://kan.bn/api/v1";

// Resolved per invocation by resolveCreds() once the --site flag is known.
let BASE_URL = DEFAULT_BASE;
let API_KEY = undefined;

// Pick credentials for a named site, falling back to the unscoped vars.
//
// Precedence:
//   --site NAME        → KAN_<NAME>_API_KEY / KAN_<NAME>_BASE_URL
//   $KAN_DEFAULT_SITE  → same, using that site name
//   neither            → bare KAN_API_KEY / KAN_BASE_URL (back-compat)
function resolveCreds(site) {
  const effective = site ?? process.env.KAN_DEFAULT_SITE;
  if (effective) {
    const prefix = `KAN_${effective.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`;
    const key = process.env[`${prefix}API_KEY`];
    const url = process.env[`${prefix}BASE_URL`];
    if (!key) {
      throw new Error(`no API key for site '${effective}'. Set ${prefix}API_KEY in ~/.claude/.env (and \`source\` it).`);
    }
    return { apiKey: key, baseUrl: (url ?? DEFAULT_BASE).replace(/\/$/, "") };
  }
  return {
    apiKey: process.env.KAN_API_KEY,
    baseUrl: (process.env.KAN_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, ""),
  };
}

async function kanFetch(path, { method = "GET", body } = {}) {
  if (!API_KEY) {
    throw new Error("KAN API key not set. Add KAN_<SITE>_API_KEY (with --site or KAN_DEFAULT_SITE) or bare KAN_API_KEY to ~/.claude/.env.");
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`kan.bn API error ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : { success: true };
}

// Each command is { opts, run }. opts = parseArgs option config, where every
// key uses dash-case on the CLI and maps to camelCase in the run handler.
const COMMANDS = {
  "list-workspaces": {
    help: "List all workspaces accessible to the authenticated user",
    opts: {},
    run: () => kanFetch("/workspaces"),
  },

  "get-workspace": {
    help: "Get a workspace by public ID, including its boards",
    opts: { "workspace-id": { type: "string" } },
    required: ["workspace-id"],
    run: ({ workspaceId }) => kanFetch(`/workspaces/${workspaceId}`),
  },

  search: {
    help: "Search boards and cards by title within a workspace",
    opts: {
      "workspace-id": { type: "string" },
      query: { type: "string" },
      limit: { type: "string" },
    },
    required: ["workspace-id", "query"],
    run: ({ workspaceId, query, limit }) => {
      const params = new URLSearchParams({ query });
      if (limit) params.set("limit", limit);
      return kanFetch(`/workspaces/${workspaceId}/search?${params}`);
    },
  },

  // --- Workspace members ---
  // These wrap the public /api/v1 member endpoints (exposed by Kan since Dec
  // 2024; trpc-to-openapi generates them from the member router's openapi meta).
  // All are API-key authenticated like every other command here.

  "list-members": {
    help: "List the members of a workspace (with their member public IDs)",
    opts: { "workspace-id": { type: "string" } },
    required: ["workspace-id"],
    run: async ({ workspaceId }) => {
      const ws = await kanFetch(`/workspaces/${workspaceId}`);
      return ws.members ?? ws;
    },
  },

  "invite-member": {
    help: "Invite a member to a workspace by email (sends a magic-link invite)",
    opts: {
      "workspace-id": { type: "string" },
      email: { type: "string" },
    },
    required: ["workspace-id", "email"],
    run: ({ workspaceId, email }) =>
      kanFetch(`/workspaces/${workspaceId}/members/invite`, {
        method: "POST",
        body: { email, workspacePublicId: workspaceId },
      }),
  },

  "remove-member": {
    help: "Remove a member from a workspace by member public ID",
    opts: {
      "workspace-id": { type: "string" },
      "member-id": { type: "string" },
    },
    required: ["workspace-id", "member-id"],
    run: ({ workspaceId, memberId }) =>
      kanFetch(`/workspaces/${workspaceId}/members/${memberId}`, {
        method: "DELETE",
      }),
  },

  "update-member-role": {
    help: "Change a member's role in a workspace (admin|member|guest)",
    opts: {
      "workspace-id": { type: "string" },
      "member-id": { type: "string" },
      role: { type: "string" }, // admin|member|guest
    },
    required: ["workspace-id", "member-id", "role"],
    run: ({ workspaceId, memberId, role }) =>
      kanFetch(`/workspaces/${workspaceId}/members/${memberId}/role`, {
        method: "PUT",
        body: { role },
      }),
  },

  "get-invite-link": {
    help: "Get the active invite link for a workspace (if any)",
    opts: { "workspace-id": { type: "string" } },
    required: ["workspace-id"],
    run: ({ workspaceId }) => kanFetch(`/workspaces/${workspaceId}/invite`),
  },

  "create-invite-link": {
    help: "Create (or rotate) the shareable invite link for a workspace",
    opts: { "workspace-id": { type: "string" } },
    required: ["workspace-id"],
    run: ({ workspaceId }) =>
      kanFetch(`/workspaces/${workspaceId}/invites`, {
        method: "POST",
        body: { workspacePublicId: workspaceId },
      }),
  },

  "deactivate-invite-link": {
    help: "Deactivate the active invite link for a workspace",
    opts: { "workspace-id": { type: "string" } },
    required: ["workspace-id"],
    run: ({ workspaceId }) =>
      kanFetch(`/workspaces/${workspaceId}/invites`, { method: "DELETE" }),
  },

  "get-invite": {
    help: "Look up invite information by invite code",
    opts: { "invite-code": { type: "string" } },
    required: ["invite-code"],
    run: ({ inviteCode }) => kanFetch(`/invites/${inviteCode}`),
  },

  "accept-invite": {
    help: "Accept a workspace invite by code (as the authenticated user)",
    opts: { "invite-code": { type: "string" } },
    required: ["invite-code"],
    run: ({ inviteCode }) =>
      kanFetch(`/invites/accept`, {
        method: "POST",
        body: { inviteCode },
      }),
  },

  "list-boards": {
    help: "List all boards in a workspace",
    opts: {
      "workspace-id": { type: "string" },
      type: { type: "string" }, // regular|template
    },
    required: ["workspace-id"],
    run: ({ workspaceId, type }) => {
      const q = type ? `?type=${type}` : "";
      return kanFetch(`/workspaces/${workspaceId}/boards${q}`);
    },
  },

  "get-board": {
    help: "Get a board by public ID, including lists, labels, cards",
    opts: { "board-id": { type: "string" } },
    required: ["board-id"],
    run: ({ boardId }) => kanFetch(`/boards/${boardId}`),
  },

  "create-board": {
    help: "Create a new board in a workspace",
    opts: {
      "workspace-id": { type: "string" },
      name: { type: "string" },
      list: { type: "string", multiple: true },
      label: { type: "string", multiple: true },
    },
    required: ["workspace-id", "name"],
    run: ({ workspaceId, name, list, label }) =>
      kanFetch(`/workspaces/${workspaceId}/boards`, {
        method: "POST",
        body: {
          name,
          workspacePublicId: workspaceId,
          lists: list?.length ? list : ["To Do", "In Progress", "Done"],
          labels: label?.length ? label : ["Bug", "Feature", "Enhancement"],
        },
      }),
  },

  "update-board": {
    help: "Update a board's name or visibility",
    opts: {
      "board-id": { type: "string" },
      name: { type: "string" },
      visibility: { type: "string" }, // public|private
    },
    required: ["board-id"],
    run: ({ boardId, name, visibility }) => {
      const body = { boardPublicId: boardId };
      if (name) body.name = name;
      if (visibility) body.visibility = visibility;
      return kanFetch(`/boards/${boardId}`, { method: "PUT", body });
    },
  },

  "delete-board": {
    help: "Delete a board by public ID",
    opts: { "board-id": { type: "string" } },
    required: ["board-id"],
    run: ({ boardId }) =>
      kanFetch(`/boards/${boardId}`, { method: "DELETE" }),
  },

  "create-list": {
    help: "Create a new list on a board",
    opts: {
      "board-id": { type: "string" },
      name: { type: "string" },
    },
    required: ["board-id", "name"],
    run: ({ boardId, name }) =>
      kanFetch("/lists", {
        method: "POST",
        body: { name, boardPublicId: boardId },
      }),
  },

  "update-list": {
    help: "Update a list's name or position",
    opts: {
      "list-id": { type: "string" },
      name: { type: "string" },
      index: { type: "string" },
    },
    required: ["list-id"],
    run: ({ listId, name, index }) => {
      const body = {};
      if (name) body.name = name;
      if (index !== undefined) body.index = Number(index);
      return kanFetch(`/lists/${listId}`, { method: "PUT", body });
    },
  },

  "delete-list": {
    help: "Delete a list by public ID",
    opts: { "list-id": { type: "string" } },
    required: ["list-id"],
    run: ({ listId }) =>
      kanFetch(`/lists/${listId}`, { method: "DELETE" }),
  },

  "create-card": {
    help: "Create a new card in a list",
    opts: {
      "list-id": { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      position: { type: "string" }, // start|end
      "due-date": { type: "string" },
      "label-id": { type: "string", multiple: true },
      "member-id": { type: "string", multiple: true },
    },
    required: ["list-id", "title"],
    run: ({ listId, title, description, position, dueDate, labelId, memberId }) => {
      const body = {
        title,
        listPublicId: listId,
        description: description || "",
        position: position || "end",
        labelPublicIds: labelId || [],
        memberPublicIds: memberId || [],
      };
      if (dueDate !== undefined) body.dueDate = dueDate === "null" ? null : dueDate;
      return kanFetch("/cards", { method: "POST", body });
    },
  },

  "get-card": {
    help: "Get a card by public ID, including checklists, labels, members",
    opts: { "card-id": { type: "string" } },
    required: ["card-id"],
    run: ({ cardId }) => kanFetch(`/cards/${cardId}`),
  },

  "update-card": {
    help: "Update a card's title, description, position, list, or due date",
    opts: {
      "card-id": { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      "list-id": { type: "string" },
      index: { type: "string" },
      "due-date": { type: "string" },
    },
    required: ["card-id"],
    run: ({ cardId, title, description, listId, index, dueDate }) => {
      const body = {};
      if (title) body.title = title;
      if (description !== undefined) body.description = description;
      if (listId) {
        body.listPublicId = listId;
        body.index = index !== undefined ? Number(index) : 0;
      } else if (index !== undefined) {
        body.index = Number(index);
      }
      if (dueDate !== undefined) body.dueDate = dueDate === "null" ? null : dueDate;
      return kanFetch(`/cards/${cardId}`, { method: "PUT", body });
    },
  },

  "delete-card": {
    help: "Delete a card by public ID",
    opts: { "card-id": { type: "string" } },
    required: ["card-id"],
    run: ({ cardId }) =>
      kanFetch(`/cards/${cardId}`, { method: "DELETE" }),
  },

  "toggle-card-label": {
    help: "Add or remove a label from a card (toggles)",
    opts: {
      "card-id": { type: "string" },
      "label-id": { type: "string" },
    },
    required: ["card-id", "label-id"],
    run: ({ cardId, labelId }) =>
      kanFetch(`/cards/${cardId}/labels/${labelId}`, { method: "PUT" }),
  },

  "toggle-card-member": {
    help: "Add or remove a member from a card (toggles)",
    opts: {
      "card-id": { type: "string" },
      "member-id": { type: "string" },
    },
    required: ["card-id", "member-id"],
    run: ({ cardId, memberId }) =>
      kanFetch(`/cards/${cardId}/members/${memberId}`, { method: "PUT" }),
  },

  "add-comment": {
    help: "Add a comment to a card",
    opts: {
      "card-id": { type: "string" },
      comment: { type: "string" },
    },
    required: ["card-id", "comment"],
    run: ({ cardId, comment }) =>
      kanFetch(`/cards/${cardId}/comments`, {
        method: "POST",
        body: { comment },
      }),
  },

  "create-label": {
    help: "Create a new label on a board",
    opts: {
      "board-id": { type: "string" },
      name: { type: "string" },
      "colour-code": { type: "string" },
    },
    required: ["board-id", "name", "colour-code"],
    run: ({ boardId, name, colourCode }) =>
      kanFetch("/labels", {
        method: "POST",
        body: { name, boardPublicId: boardId, colourCode },
      }),
  },

  "update-label": {
    help: "Update a label's name or colour",
    opts: {
      "label-id": { type: "string" },
      name: { type: "string" },
      "colour-code": { type: "string" },
    },
    required: ["label-id"],
    run: ({ labelId, name, colourCode }) => {
      const body = {};
      if (name) body.name = name;
      if (colourCode) body.colourCode = colourCode;
      return kanFetch(`/labels/${labelId}`, { method: "PUT", body });
    },
  },

  "delete-label": {
    help: "Delete a label by public ID",
    opts: { "label-id": { type: "string" } },
    required: ["label-id"],
    run: ({ labelId }) =>
      kanFetch(`/labels/${labelId}`, { method: "DELETE" }),
  },

  "create-checklist": {
    help: "Create a new checklist on a card",
    opts: {
      "card-id": { type: "string" },
      name: { type: "string" },
    },
    required: ["card-id", "name"],
    run: ({ cardId, name }) =>
      kanFetch(`/cards/${cardId}/checklists`, {
        method: "POST",
        body: { name },
      }),
  },

  "add-checklist-item": {
    help: "Add an item to a checklist",
    opts: {
      "checklist-id": { type: "string" },
      title: { type: "string" },
    },
    required: ["checklist-id", "title"],
    run: ({ checklistId, title }) =>
      kanFetch(`/checklists/${checklistId}/items`, {
        method: "POST",
        body: { title },
      }),
  },

  "update-checklist-item": {
    help: "Update a checklist item's title, completion, or position",
    opts: {
      "item-id": { type: "string" },
      title: { type: "string" },
      completed: { type: "string" }, // "true"|"false"
      index: { type: "string" },
    },
    required: ["item-id"],
    run: ({ itemId, title, completed, index }) => {
      const body = {};
      if (title) body.title = title;
      if (completed !== undefined) body.completed = completed === "true";
      if (index !== undefined) body.index = Number(index);
      return kanFetch(`/checklists/items/${itemId}`, {
        method: "PATCH",
        body,
      });
    },
  },

  "delete-checklist": {
    help: "Delete a checklist by public ID",
    opts: { "checklist-id": { type: "string" } },
    required: ["checklist-id"],
    run: ({ checklistId }) =>
      kanFetch(`/checklists/${checklistId}`, { method: "DELETE" }),
  },
};

function dashToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function printHelp() {
  console.log("kan — CLI for kan.bn\n\nUsage: kan [--site NAME] <subcommand> [options]\n");
  console.log("Multi-instance: --site NAME reads KAN_<NAME>_API_KEY / KAN_<NAME>_BASE_URL");
  console.log("  (e.g. --site xdeca → KAN_XDECA_API_KEY). $KAN_DEFAULT_SITE sets the site used");
  console.log("  when --site is omitted; otherwise falls back to bare $KAN_API_KEY / $KAN_BASE_URL.\n");
  console.log("Subcommands:");
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(24)} ${cmd.help}`);
  }
  console.log("\nRun `kan <subcommand> --help` for options.");
}

function printCmdHelp(name, cmd) {
  console.log(`kan ${name} — ${cmd.help}\n`);
  if (Object.keys(cmd.opts).length === 0) {
    console.log("(no options)");
    return;
  }
  console.log("Options:");
  for (const [opt, cfg] of Object.entries(cmd.opts)) {
    const req = (cmd.required || []).includes(opt) ? " (required)" : "";
    const multi = cfg.multiple ? " (repeatable)" : "";
    console.log(`  --${opt}${multi}${req}`);
  }
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

  try {
    const creds = resolveCreds(site);
    BASE_URL = creds.baseUrl;
    API_KEY = creds.apiKey;
  } catch (err) {
    console.error(`kan: ${err.message}`);
    process.exit(2);
  }

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const subcommand = argv[0];
  const cmd = COMMANDS[subcommand];
  if (!cmd) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Run `kan --help` for the list of subcommands.");
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
    console.error(`kan ${subcommand}: ${err.message}`);
    process.exit(2);
  }

  for (const req of cmd.required || []) {
    if (parsed.values[req] === undefined) {
      console.error(`kan ${subcommand}: --${req} is required`);
      process.exit(2);
    }
  }

  // Convert dash-case keys to camelCase for the run handler.
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
