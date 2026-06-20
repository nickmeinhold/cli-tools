/**
 * File-based JSON persistence for forge sprint contracts.
 *
 * State lives in `.forge/sprints/` (project-local, gitignored) or
 * `~/.forge/sprints/` (global fallback). The project-local scope
 * takes precedence so each project's forge state is isolated.
 *
 * Each sprint is a single JSON file named `{id}.json`.
 */
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { analyzeTrajectory } from "./trajectory.js";
/** Generate a short prefixed ID: spr_a1b2c3 */
function generateId() {
    return "spr_" + randomBytes(3).toString("hex");
}
export class ForgeStore {
    projectDir;
    globalDir;
    constructor(projectPath) {
        this.globalDir = join(homedir(), ".forge");
        if (projectPath) {
            const localForge = join(projectPath, ".forge");
            this.projectDir = existsSync(localForge) ? localForge : null;
        }
        else {
            this.projectDir = null;
        }
    }
    /** Initialize project-local .forge/ directory. */
    async initProject(projectPath) {
        this.projectDir = join(projectPath, ".forge");
        await mkdir(join(this.projectDir, "sprints"), { recursive: true });
    }
    sprintsDir() {
        const base = this.projectDir || this.globalDir;
        return join(base, "sprints");
    }
    async ensureDir() {
        await mkdir(this.sprintsDir(), { recursive: true });
    }
    sprintPath(id) {
        return join(this.sprintsDir(), `${id}.json`);
    }
    // ── CRUD ─────────────────────────────────────────────────────
    async createSprint(opts) {
        await this.ensureDir();
        const now = new Date().toISOString();
        const sprint = {
            id: generateId(),
            title: opts.title,
            description: opts.description,
            acceptance_criteria: opts.acceptance_criteria.map((c) => ({
                ...c,
                threshold: c.threshold ?? 0.8,
            })),
            evaluation_method: opts.evaluation_method,
            status: "pending",
            evaluations: [],
            parent_sprint: opts.parent_sprint,
            child_sprints: [],
            tags: opts.tags ?? [],
            created: now,
            updated: now,
        };
        await this.writeSprint(sprint);
        return sprint;
    }
    async getSprint(id) {
        const path = this.sprintPath(id);
        if (!existsSync(path))
            return null;
        const data = await readFile(path, "utf-8");
        return JSON.parse(data);
    }
    async listSprints() {
        await this.ensureDir();
        const dir = this.sprintsDir();
        const files = await readdir(dir);
        const sprints = [];
        for (const f of files) {
            if (!f.endsWith(".json"))
                continue;
            const data = await readFile(join(dir, f), "utf-8");
            sprints.push(JSON.parse(data));
        }
        // Sort by created date, newest first
        sprints.sort((a, b) => b.created.localeCompare(a.created));
        return sprints;
    }
    async deleteSprint(id) {
        const path = this.sprintPath(id);
        if (!existsSync(path))
            return false;
        await rm(path);
        return true;
    }
    // ── Evaluation ───────────────────────────────────────────────
    async addEvaluation(sprintId, opts) {
        const sprint = await this.getSprint(sprintId);
        if (!sprint)
            return null;
        const iteration = sprint.evaluations.length + 1;
        const criteria = sprint.acceptance_criteria;
        // Compute passed per criterion and weighted overall score
        const scores = opts.scores.map((s) => {
            const criterion = criteria.find((c) => c.id === s.criterion_id);
            const threshold = criterion?.threshold ?? 0.8;
            return { ...s, passed: s.score >= threshold };
        });
        const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
        const overall_score = totalWeight > 0
            ? scores.reduce((sum, s) => {
                const criterion = criteria.find((c) => c.id === s.criterion_id);
                return sum + s.score * (criterion?.weight ?? 1);
            }, 0) / totalWeight
            : 0;
        const allPassed = scores.every((s) => s.passed);
        const evaluation = {
            id: `eval_${iteration}`,
            timestamp: new Date().toISOString(),
            iteration,
            scores,
            overall_score,
            passed: allPassed,
            evaluator_notes: opts.evaluator_notes,
            builder_changes: opts.builder_changes,
            duration_seconds: opts.duration_seconds,
            diff_size: opts.diff_size,
        };
        sprint.evaluations.push(evaluation);
        // Update trajectory analysis
        sprint.trajectory = analyzeTrajectory(sprint.evaluations);
        // Update status based on trajectory
        if (allPassed) {
            sprint.status = "passed";
        }
        else if (sprint.trajectory.pattern === "oscillating" || sprint.trajectory.pattern === "plateau") {
            sprint.status = "stuck";
        }
        else {
            sprint.status = "iterating";
        }
        sprint.updated = new Date().toISOString();
        await this.writeSprint(sprint);
        return { evaluation, sprint };
    }
    // ── Dashboard ────────────────────────────────────────────────
    async getDashboard() {
        const sprints = await this.listSprints();
        const toDashboardSprint = (s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            iteration_count: s.evaluations.length,
            latest_score: s.evaluations.length > 0
                ? s.evaluations[s.evaluations.length - 1].overall_score
                : null,
            pattern: s.trajectory?.pattern ?? null,
            recommendation: s.trajectory?.recommendation ?? null,
        });
        return {
            total: sprints.length,
            green: sprints.filter((s) => s.status === "passed" || s.status === "shipped").map(toDashboardSprint),
            stuck: sprints.filter((s) => s.status === "stuck").map(toDashboardSprint),
            regressing: sprints
                .filter((s) => s.trajectory?.pattern === "regressing")
                .map(toDashboardSprint),
            active: sprints
                .filter((s) => s.status === "active" || s.status === "iterating")
                .map(toDashboardSprint),
            pending: sprints.filter((s) => s.status === "pending").map(toDashboardSprint),
        };
    }
    // ── Internal ─────────────────────────────────────────────────
    async writeSprint(sprint) {
        await writeFile(this.sprintPath(sprint.id), JSON.stringify(sprint, null, 2));
    }
}
