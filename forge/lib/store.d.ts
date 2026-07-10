/**
 * File-based JSON persistence for forge sprint contracts.
 *
 * State lives in `.forge/sprints/` (project-local, gitignored) or
 * `~/.forge/sprints/` (global fallback). The project-local scope
 * takes precedence so each project's forge state is isolated.
 *
 * Each sprint is a single JSON file named `{id}.json`.
 */
import type { SprintContract, AcceptanceCriterion, EvaluationMethod, Evaluation, CriterionScore, Dashboard } from "./types.js";
export declare class ForgeStore {
    private projectDir;
    private globalDir;
    constructor(projectPath?: string);
    /** Initialize project-local .forge/ directory. */
    initProject(projectPath: string): Promise<void>;
    private sprintsDir;
    private ensureDir;
    private sprintPath;
    createSprint(opts: {
        title: string;
        description: string;
        acceptance_criteria: Omit<AcceptanceCriterion, "threshold">[];
        evaluation_method: EvaluationMethod;
        parent_sprint?: string;
        tags?: string[];
    }): Promise<SprintContract>;
    getSprint(id: string): Promise<SprintContract | null>;
    listSprints(): Promise<SprintContract[]>;
    deleteSprint(id: string): Promise<boolean>;
    addEvaluation(sprintId: string, opts: {
        scores: Omit<CriterionScore, "passed">[];
        evaluator_notes: string;
        builder_changes?: string;
        duration_seconds?: number;
        diff_size?: number;
    }): Promise<{
        evaluation: Evaluation;
        sprint: SprintContract;
    } | null>;
    getDashboard(): Promise<Dashboard>;
    private writeSprint;
}
