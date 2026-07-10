/**
 * Trajectory analysis — the control system for forge iteration loops.
 *
 * Unlike a simple pass/fail retry, this watches the *shape* of
 * evaluation scores over time and detects when trying harder won't
 * help. It recommends structural changes (pivot, decompose, escalate)
 * rather than just "try again."
 *
 * Pure functions, no I/O. Fast to test.
 */
import type { Evaluation, TrajectoryAnalysis } from "./types.js";
export declare function analyzeTrajectory(evaluations: Evaluation[]): TrajectoryAnalysis;
