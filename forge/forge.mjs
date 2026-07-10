#!/usr/bin/env node
// forge — CLI for the forge generator-evaluator state store.
// Self-contained: the store + trajectory modules are vendored in ./lib/.
// State lives in ./.forge/ (per-project) or ~/.forge/ (global fallback).

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

const FORGE_LIB = new URL("./lib/", import.meta.url).href;
const { ForgeStore } = await import(`${FORGE_LIB}store.js`);
const { analyzeTrajectory } = await import(`${FORGE_LIB}trajectory.js`);

const projectPath = process.env.FORGE_PROJECT_PATH || process.cwd();
const store = new ForgeStore(projectPath);

function readJsonArg(jsonOpt) {
  if (jsonOpt === undefined) return undefined;
  const raw = jsonOpt === "-" ? readFileSync(0, "utf8") : jsonOpt;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--json payload is not valid JSON: ${err.message}`);
  }
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

const COMMANDS = {
  "create-sprint": {
    help: "Create a sprint contract. Pass full payload via --json '<obj>' or --json -",
    opts: { json: { type: "string" } },
    required: ["json"],
    async run({ json }) {
      const payload = readJsonArg(json);
      if (!payload || typeof payload !== "object") {
        throw new Error("--json must be an object payload");
      }
      const sprint = await store.createSprint(payload);
      out(sprint);
    },
  },

  "evaluate-sprint": {
    help: "Record an evaluation. --sprint-id ID, payload via --json '<obj>' or --json -",
    opts: {
      "sprint-id": { type: "string" },
      json: { type: "string" },
    },
    required: ["sprint-id", "json"],
    async run({ sprintId, json }) {
      const payload = readJsonArg(json);
      const result = await store.addEvaluation(sprintId, payload);
      if (!result) {
        process.stderr.write(`Sprint ${sprintId} not found.\n`);
        process.exit(1);
      }
      out({
        evaluation: result.evaluation,
        status: result.sprint.status,
        trajectory: result.sprint.trajectory,
      });
    },
  },

  history: {
    help: "Get the full iteration history for a sprint",
    opts: { "sprint-id": { type: "string" } },
    required: ["sprint-id"],
    async run({ sprintId }) {
      const sprint = await store.getSprint(sprintId);
      if (!sprint) {
        process.stderr.write(`Sprint ${sprintId} not found.\n`);
        process.exit(1);
      }
      out({
        id: sprint.id,
        title: sprint.title,
        status: sprint.status,
        iteration_count: sprint.evaluations.length,
        evaluations: sprint.evaluations,
        trajectory: sprint.trajectory,
      });
    },
  },

  suggest: {
    help: "Recommend the next action for a sprint (iterate/pivot/escalate/ship)",
    opts: { "sprint-id": { type: "string" } },
    required: ["sprint-id"],
    async run({ sprintId }) {
      const sprint = await store.getSprint(sprintId);
      if (!sprint) {
        process.stderr.write(`Sprint ${sprintId} not found.\n`);
        process.exit(1);
      }
      const analysis = analyzeTrajectory(sprint.evaluations);
      sprint.trajectory = analysis;
      out({
        sprint_id: sprint.id,
        sprint_title: sprint.title,
        iteration_count: sprint.evaluations.length,
        latest_score:
          sprint.evaluations.length > 0
            ? sprint.evaluations[sprint.evaluations.length - 1].overall_score
            : null,
        ...analysis,
      });
    },
  },

  list: {
    help: "List all sprints with status summary (was forge://sprints resource)",
    opts: {},
    async run() {
      const sprints = await store.listSprints();
      out(
        sprints.map((s) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          iterations: s.evaluations.length,
          latest_score:
            s.evaluations.length > 0
              ? s.evaluations[s.evaluations.length - 1].overall_score
              : null,
          pattern: s.trajectory?.pattern ?? null,
          recommendation: s.trajectory?.recommendation ?? null,
        }))
      );
    },
  },

  sprint: {
    help: "Full sprint detail (was forge://sprints/{id} resource)",
    opts: { "sprint-id": { type: "string" } },
    required: ["sprint-id"],
    async run({ sprintId }) {
      const sprint = await store.getSprint(sprintId);
      if (!sprint) {
        process.stderr.write(`Sprint ${sprintId} not found.\n`);
        process.exit(1);
      }
      out(sprint);
    },
  },

  dashboard: {
    help: "Aggregated dashboard: green/stuck/regressing/active/pending",
    opts: {},
    async run() {
      out(await store.getDashboard());
    },
  },
};

function dashToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function printHelp() {
  console.log("forge — CLI for the forge sprint state store\n");
  console.log("Usage: forge <subcommand> [options]\n");
  console.log("State: ./.forge/ (per-project, preferred) or ~/.forge/ (global)\n");
  console.log("Subcommands:");
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(18)} ${cmd.help}`);
  }
  console.log("\nRun `forge <subcommand> --help` for options.");
}

function printCmdHelp(name, cmd) {
  console.log(`forge ${name} — ${cmd.help}\n`);
  if (Object.keys(cmd.opts).length === 0) {
    console.log("(no options)");
    return;
  }
  console.log("Options:");
  for (const opt of Object.keys(cmd.opts)) {
    const req = (cmd.required || []).includes(opt) ? " (required)" : "";
    console.log(`  --${opt}${req}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const subcommand = argv[0];
  const cmd = COMMANDS[subcommand];
  if (!cmd) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Run `forge --help` for the list of subcommands.");
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
    console.error(`forge ${subcommand}: ${err.message}`);
    process.exit(2);
  }

  for (const req of cmd.required || []) {
    if (parsed.values[req] === undefined) {
      console.error(`forge ${subcommand}: --${req} is required`);
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
    console.error(err.message);
    process.exit(1);
  }
}

main();
