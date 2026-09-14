// Offline canary/authority acceptance harness.
// It consumes host-observed facts only; it never changes runtime mode or calls
// Telegram. A real canary uses the same report shape with real observations.

export type CanaryCohort = "frozen_baseline" | "experiment";

export interface CanaryObservation {
  sampleId: string;
  cohort: CanaryCohort;
  verifiedSuccess: boolean;
  falseSuccess?: boolean;
  humanIntervention?: boolean;
  scopeViolations?: number;
  unauthorizedSideEffects?: number;
  duplicateActions?: number;
  rollbackSignals?: string[];
  latencyMs?: number;
  toolCalls?: number;
  tokenCost?: number;
  failureCode?: string;
}

export interface CanaryThresholds {
  maxFalseSuccessRate: number;
  maxHumanInterventionRate: number;
  maxLatencyRegression: number;
  maxCostRegression: number;
}

export interface CanaryWindowReport {
  kind: "agency_canary_acceptance_window";
  codeVersion: string;
  configSnapshot: Record<string, string | number | boolean>;
  window: { from: string; to: string };
  cohorts: Record<
    CanaryCohort,
    {
      samples: number;
      verified: number;
      successRate: number;
      ci95: { low: number; high: number } | null;
      falseSuccessRate: number;
      interventionRate: number;
      meanLatencyMs: number | null;
      meanTokenCost: number | null;
    }
  >;
  rollback: { required: boolean; reasons: string[]; conditions: string[] };
  failureSamples: Array<{
    sampleId: string;
    cohort: CanaryCohort;
    code?: string;
  }>;
}

export const DEFAULT_CANARY_THRESHOLDS: CanaryThresholds = {
  maxFalseSuccessRate: 0.02,
  maxHumanInterventionRate: 0.25,
  maxLatencyRegression: 0.5,
  maxCostRegression: 0.5,
};

function wilson(
  successes: number,
  samples: number,
): { low: number; high: number } | null {
  if (samples <= 0) return null;
  const p = successes / samples;
  const z = 1.96;
  const denominator = 1 + (z * z) / samples;
  const centre = p + (z * z) / (2 * samples);
  const spread =
    z * Math.sqrt((p * (1 - p) + (z * z) / (4 * samples)) / samples);
  return {
    low: Math.max(0, Number(((centre - spread) / denominator).toFixed(4))),
    high: Math.min(1, Number(((centre + spread) / denominator).toFixed(4))),
  };
}

function cohortStats(
  rows: CanaryObservation[],
): CanaryWindowReport["cohorts"][CanaryCohort] {
  const samples = rows.length;
  const verified = rows.filter((row) => row.verifiedSuccess).length;
  const falseSuccess = rows.filter((row) => row.falseSuccess === true).length;
  const interventions = rows.filter(
    (row) => row.humanIntervention === true,
  ).length;
  const mean = (values: number[]): number | null =>
    values.length
      ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2))
      : null;
  return {
    samples,
    verified,
    successRate: samples ? Number((verified / samples).toFixed(4)) : 0,
    ci95: wilson(verified, samples),
    falseSuccessRate: samples ? Number((falseSuccess / samples).toFixed(4)) : 0,
    interventionRate: samples
      ? Number((interventions / samples).toFixed(4))
      : 0,
    meanLatencyMs: mean(
      rows
        .map((row) => row.latencyMs)
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value),
        ),
    ),
    meanTokenCost: mean(
      rows
        .map((row) => row.tokenCost)
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value),
        ),
    ),
  };
}

/** Evaluate a frozen baseline + experiment window and expose exact rollback facts. */
export function evaluateCanaryWindow(input: {
  codeVersion: string;
  configSnapshot: Record<string, string | number | boolean>;
  from: string;
  to: string;
  observations: readonly CanaryObservation[];
  thresholds?: Partial<CanaryThresholds>;
}): CanaryWindowReport {
  const thresholds = {
    ...DEFAULT_CANARY_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };
  const baseline = input.observations.filter(
    (row) => row.cohort === "frozen_baseline",
  );
  const experiment = input.observations.filter(
    (row) => row.cohort === "experiment",
  );
  const baselineStats = cohortStats(baseline);
  const experimentStats = cohortStats(experiment);
  const reasons: string[] = [];
  if (experiment.some((row) => (row.scopeViolations ?? 0) > 0))
    reasons.push("scope_violation");
  if (experiment.some((row) => (row.unauthorizedSideEffects ?? 0) > 0))
    reasons.push("unauthorized_side_effect");
  if (experiment.some((row) => (row.duplicateActions ?? 0) > 0))
    reasons.push("unresolved_duplicate_action");
  if (experimentStats.falseSuccessRate > thresholds.maxFalseSuccessRate)
    reasons.push("false_success_rate");
  if (experimentStats.interventionRate > thresholds.maxHumanInterventionRate)
    reasons.push("human_intervention_rate");
  if (
    baselineStats.meanLatencyMs !== null &&
    experimentStats.meanLatencyMs !== null &&
    experimentStats.meanLatencyMs >
      baselineStats.meanLatencyMs * (1 + thresholds.maxLatencyRegression)
  )
    reasons.push("latency_regression");
  if (
    baselineStats.meanTokenCost !== null &&
    experimentStats.meanTokenCost !== null &&
    experimentStats.meanTokenCost >
      baselineStats.meanTokenCost * (1 + thresholds.maxCostRegression)
  )
    reasons.push("cost_regression");
  return {
    kind: "agency_canary_acceptance_window",
    codeVersion: input.codeVersion,
    configSnapshot: input.configSnapshot,
    window: { from: input.from, to: input.to },
    cohorts: { frozen_baseline: baselineStats, experiment: experimentStats },
    rollback: {
      required: reasons.length > 0,
      reasons,
      conditions: [
        "any scope violation, unauthorized side effect, or unresolved duplicate action",
        `false success rate > ${thresholds.maxFalseSuccessRate}`,
        `human intervention rate > ${thresholds.maxHumanInterventionRate}`,
        `latency/cost regression > configured threshold`,
      ],
    },
    failureSamples: input.observations
      .filter(
        (row) =>
          !row.verifiedSuccess ||
          row.falseSuccess === true ||
          (row.failureCode ?? "") !== "",
      )
      .map((row) => ({
        sampleId: row.sampleId,
        cohort: row.cohort,
        ...(row.failureCode ? { code: row.failureCode } : {}),
      }))
      .slice(0, 100),
  };
}
