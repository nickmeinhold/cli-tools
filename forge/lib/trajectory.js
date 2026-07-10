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
// ── Math helpers ─────────────────────────────────────────────────
function mean(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}
function variance(values) {
    if (values.length < 2)
        return 0;
    const m = mean(values);
    return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
}
/**
 * Ordinary least squares slope for evenly-spaced points.
 * x = 0, 1, 2, ... n-1.
 */
function linearRegressionSlope(values) {
    const n = values.length;
    if (n < 2)
        return 0;
    const xMean = (n - 1) / 2;
    const yMean = mean(values);
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - xMean) * (values[i] - yMean);
        den += (i - xMean) ** 2;
    }
    return den === 0 ? 0 : num / den;
}
// ── Core analysis ────────────────────────────────────────────────
export function analyzeTrajectory(evaluations) {
    const signals = [];
    // No history yet — just start iterating.
    if (evaluations.length === 0) {
        return result("improving", "iterate", 0.5, "No evaluations yet. Start iterating.", signals);
    }
    // Single evaluation — ship if passed, iterate if not.
    if (evaluations.length === 1) {
        const e = evaluations[0];
        if (e.passed && e.overall_score >= 0.95) {
            return result("improving", "ship", 0.9, "First evaluation passed. Ready to ship.", signals);
        }
        return result("improving", "iterate", 0.5, `First evaluation scored ${e.overall_score.toFixed(2)}. Iterate to improve.`, signals);
    }
    const scores = evaluations.map((e) => e.overall_score);
    const n = scores.length;
    const latest = evaluations[n - 1];
    // ── Compute signals ──────────────────────────────────────────
    // 1. Overall slope
    const slope = linearRegressionSlope(scores);
    signals.push({
        name: "slope",
        value: slope,
        interpretation: slope > 0.02
            ? "Upward trend"
            : slope < -0.02
                ? "Downward trend"
                : "Flat",
    });
    // 2. Recent trend (last 2 vs previous 2)
    const recentScores = scores.slice(-2);
    const prevScores = n >= 4 ? scores.slice(-4, -2) : scores.slice(0, -2);
    const recentTrend = mean(recentScores) - mean(prevScores);
    signals.push({
        name: "recent_trend",
        value: recentTrend,
        interpretation: recentTrend > 0.05
            ? "Recent improvement"
            : recentTrend < -0.05
                ? "Recent decline"
                : "Stable recently",
    });
    // 3. Recent variance (last 3 scores)
    const recentWindow = scores.slice(-Math.min(3, n));
    const recentVar = variance(recentWindow);
    signals.push({
        name: "recent_variance",
        value: recentVar,
        interpretation: recentVar < 0.002
            ? "Very stable (possible plateau)"
            : recentVar > 0.02
                ? "Highly variable"
                : "Moderate variance",
    });
    // 4. Oscillation ratio — sign changes in consecutive deltas
    const deltas = scores.slice(1).map((s, i) => s - scores[i]);
    const significantDeltas = deltas.filter((d) => Math.abs(d) > 0.05);
    let signChanges = 0;
    for (let i = 1; i < significantDeltas.length; i++) {
        if (Math.sign(significantDeltas[i]) !== Math.sign(significantDeltas[i - 1])) {
            signChanges++;
        }
    }
    const oscillationRatio = significantDeltas.length > 1
        ? signChanges / (significantDeltas.length - 1)
        : 0;
    signals.push({
        name: "oscillation_ratio",
        value: oscillationRatio,
        interpretation: oscillationRatio > 0.6
            ? "High oscillation — fixing one thing may break another"
            : oscillationRatio > 0.3
                ? "Some oscillation"
                : "Low oscillation",
    });
    // 5. Improvement decay — are gains shrinking?
    const positiveDeltas = deltas.filter((d) => d > 0);
    let improvementDecay = 1.0;
    if (positiveDeltas.length >= 3) {
        const earlyGains = mean(positiveDeltas.slice(0, Math.ceil(positiveDeltas.length / 2)));
        const lateGains = mean(positiveDeltas.slice(Math.ceil(positiveDeltas.length / 2)));
        improvementDecay = earlyGains > 0.001 ? lateGains / earlyGains : 1.0;
    }
    signals.push({
        name: "improvement_decay",
        value: improvementDecay,
        interpretation: improvementDecay < 0.3
            ? "Gains shrinking rapidly — diminishing returns"
            : improvementDecay < 0.6
                ? "Gains slowing"
                : "Gains holding steady",
    });
    // 6. Per-criterion divergence — are criteria fighting each other?
    const criterionDivergence = computeCriterionDivergence(evaluations);
    signals.push({
        name: "criterion_divergence",
        value: criterionDivergence,
        interpretation: criterionDivergence > 0.3
            ? "Criteria are diverging — improving one regresses another"
            : "Criteria moving together",
    });
    // 7. Distance from pass
    const distanceFromPass = 1.0 - latest.overall_score;
    signals.push({
        name: "distance_from_pass",
        value: distanceFromPass,
        interpretation: distanceFromPass < 0.1
            ? "Very close to passing"
            : distanceFromPass < 0.3
                ? "Moderate distance"
                : "Far from passing",
    });
    // ── Pattern classification ───────────────────────────────────
    // Order matters — check most specific patterns first.
    //
    // Key insight: criterion divergence is a STRONGER signal than
    // overall-score oscillation. When criteria fight each other,
    // the overall score can look stable (low variance → plateau)
    // while individual criteria are swinging wildly. Check divergence
    // FIRST.
    // Ship: latest passes
    if (latest.passed && latest.overall_score >= 0.95) {
        return result("improving", "ship", 0.95, "All criteria met. Ready to ship.", signals);
    }
    // Per-criterion divergence — the strongest oscillation signal.
    // Overall score can be flat while criteria are fighting each other.
    // Check this BEFORE variance-based plateau detection.
    if (criterionDivergence > 0.3 && n >= 3) {
        return result("oscillating", "pivot", Math.min(0.9, 0.5 + criterionDivergence), "Criteria are diverging — improving one regresses another. " +
            "The sprint may need to be decomposed.", signals);
    }
    // Oscillation on overall score: high sign-change ratio, enough data
    if (oscillationRatio > 0.6 && n >= 4) {
        return result("oscillating", "pivot", Math.min(0.9, 0.5 + oscillationRatio), "Score is oscillating — fixing one criterion likely breaks another. " +
            "Consider decomposing into smaller sprints or rethinking the approach.", signals);
    }
    // Breakthrough: big jump after stagnation
    if (n >= 4) {
        const prevWindow = scores.slice(-4, -1);
        const prevVar = variance(prevWindow);
        const jump = latest.overall_score - scores[n - 2];
        if (prevVar < 0.005 && jump > 0.12) {
            return result("breakthrough", "iterate", 0.8, `Breakthrough! Score jumped ${jump.toFixed(2)} after stagnation. ` +
                "Keep iterating — momentum is here.", signals);
        }
    }
    // Diminishing returns: improvement rate decaying (check before plateau,
    // because diminishing series often have low recent variance too).
    // But NOT when near the threshold — that's stuck_high, not diminishing.
    if (improvementDecay < 0.3 && improvementDecay > 0 && n >= 4 && slope > 0 && latest.overall_score <= 0.8) {
        return result("diminishing", "escalate", 0.65, "Improvements are shrinking rapidly. " +
            "Approaching the asymptotic limit of the current approach.", signals);
    }
    // Plateau: low recent variance
    if (recentVar < 0.002 && n >= 3) {
        if (latest.overall_score > 0.8) {
            return result("stuck_high", "escalate", 0.75, "Score is plateaued near the threshold. " +
                "A targeted fix or human judgment is needed to cross the line.", signals);
        }
        return result("plateau", "pivot", 0.7, "Score has plateaued well below threshold. " +
            "Current approach may have hit a ceiling.", signals);
    }
    // Regression: negative slope and recent trend
    if (slope < -0.02 && recentTrend < -0.02) {
        return result("regressing", "pivot", Math.min(0.9, 0.5 + Math.abs(slope) * 5), "Score is declining. Iterations are making things worse.", signals);
    }
    // Default: improving
    const confidence = Math.min(0.9, 0.3 + n * 0.1);
    return result("improving", "iterate", confidence, `Score trending upward (slope: ${slope.toFixed(3)}). Continue iterating.`, signals);
}
// ── Helpers ──────────────────────────────────────────────────────
function result(pattern, recommendation, confidence, reasoning, signals) {
    return { pattern, confidence, recommendation, reasoning, signals };
}
/**
 * Measures how much individual criteria trends diverge from each other.
 *
 * If criterion A is improving while B is regressing, the divergence
 * is high — a signal that the sprint's concerns are coupled and
 * should be decomposed.
 *
 * Returns 0 when all criteria move in the same direction,
 * approaches 1 when they move in opposite directions.
 */
function computeCriterionDivergence(evaluations) {
    if (evaluations.length < 2)
        return 0;
    // Collect all criterion IDs that appear in at least 2 evaluations
    const criterionIds = new Set();
    for (const e of evaluations) {
        for (const s of e.scores) {
            criterionIds.add(s.criterion_id);
        }
    }
    if (criterionIds.size < 2)
        return 0;
    // Compute per-criterion slope
    const slopes = [];
    for (const cid of criterionIds) {
        const series = evaluations
            .map((e) => e.scores.find((s) => s.criterion_id === cid)?.score)
            .filter((s) => s !== undefined);
        if (series.length >= 2) {
            slopes.push(linearRegressionSlope(series));
        }
    }
    if (slopes.length < 2)
        return 0;
    // Divergence = how spread out the slopes are, normalized.
    // If all slopes are the same sign + magnitude → 0.
    // If slopes point in opposite directions → high.
    const slopeVar = variance(slopes);
    const maxSlope = Math.max(...slopes.map(Math.abs));
    // Normalize by the maximum slope magnitude to get 0–1 range
    return maxSlope > 0.001 ? Math.min(1, slopeVar / (maxSlope * 0.5)) : 0;
}
