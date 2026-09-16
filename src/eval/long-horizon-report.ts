// Deterministic aggregation for real long-horizon execution windows.
// Reports are deliberately conservative: a larger artifact rate never turns
// into a verified success unless the case has caller and external acceptance.

export interface LongHorizonReportLike {
  kind: string;
  window: string;
  experimentGroup: string;
  generatedAt: string;
  startedAt: string;
  finishedAt: string;
  codeVersion: { revision: string; dirty: boolean };
  providerModel: string;
  taskCount: number;
  passed: number;
  failed: number;
  unverified: number;
  passRate: number;
  artifactAcceptanceRate: number;
  externalAcceptanceRate: number;
  horizonRequirementRate: number;
  confidenceIntervals: Record<string, { low: number; high: number }>;
  cases: Array<{
    id: string;
    domain: string;
    status: string;
    artifactStatus: string;
    externalAcceptanceStatus: string;
    turns: number;
    llmCalls: number;
    llmFailures: number;
    inputTokens: number;
    outputTokens: number;
    toolCallsStarted: number;
    toolCallsFinished: number;
    toolFailures: number;
    durableEventCount: number;
    repairAttempts: number;
    durationMs: number;
    failureCodes: string[];
    crashRestartInjected: boolean;
    interruptInjected: boolean;
    goalChanged: boolean;
    recoveryTimeMs: number | null;
    checkpointCount: number;
  }>;
  failureCases: unknown[];
  configurationSnapshot: Record<string, unknown>;
}

export interface LongHorizonComparisonReport {
  kind: "real_long_horizon_window_comparison";
  generatedAt: string;
  baseline: {
    window: string;
    codeVersion: LongHorizonReportLike["codeVersion"];
    sampleCount: number;
    timeRange: { startedAt: string; finishedAt: string };
    passRate: number;
    artifactAcceptanceRate: number;
    externalAcceptanceRate: number;
    confidenceIntervals: LongHorizonReportLike["confidenceIntervals"];
  };
  experiment: LongHorizonComparisonReport["baseline"] & {
    expandedDomains: string[];
  };
  deltas: {
    passRate: number;
    artifactAcceptanceRate: number;
    externalAcceptanceRate: number;
  };
  pairedTaskOverlap: string[];
  newDomains: string[];
  failureCases: {
    window: string;
    id: string;
    domain: string;
    status: string;
    failureCodes: string[];
  }[];
  conclusion: string;
}

export interface ContinuousOpsReport {
  kind: "agi_like_continuous_operations_report";
  generatedAt: string;
  codeVersions: Array<LongHorizonReportLike["codeVersion"]>;
  providerModels: string[];
  configurationSnapshots: Record<string, unknown>[];
  sampleCount: number;
  timeRange: { startedAt: string; finishedAt: string };
  cohorts: string[];
  metrics: {
    verifiedSuccess: number;
    artifactAcceptance: number;
    externalAcceptance: number;
    p50DurationMs: number | null;
    p95DurationMs: number | null;
    meanLlmCalls: number | null;
    meanToolCalls: number | null;
    repairRate: number;
    restartRecoveryRate: number;
    interruptGoalChangeRate: number;
    toolFailureRate: number;
    durableEventLossCases: number;
  };
  confidenceIntervals: {
    verifiedSuccess: { low: number; high: number };
    artifactAcceptance: { low: number; high: number };
    externalAcceptance: { low: number; high: number };
  };
  safety: {
    scopeViolations: number;
    unauthorizedSideEffects: number;
    sandboxDenials: number;
    duplicateActions: number;
  };
  failureSamples: Array<{
    window: string;
    id: string;
    domain: string;
    failureCodes: string[];
  }>;
  uncertainty: string[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function wilson95(
  successes: number,
  total: number,
): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    low: Number(Math.max(0, centre - margin).toFixed(4)),
    high: Number(Math.min(1, centre + margin).toFixed(4)),
  };
}

function delta(after: number, before: number): number {
  return Number((after - before).toFixed(4));
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const a = sorted[lower];
  const b = sorted[upper];
  return a === undefined || b === undefined
    ? null
    : Math.round(a + (b - a) * (index - lower));
}

function aggregate(
  report: LongHorizonReportLike,
): ContinuousOpsReport["metrics"] {
  const cases = report.cases;
  const durations = cases
    .map((item) => item.durationMs)
    .filter(Number.isFinite);
  const llm = cases.map((item) => item.llmCalls).filter(Number.isFinite);
  const tools = cases
    .map((item) => item.toolCallsFinished)
    .filter(Number.isFinite);
  return {
    verifiedSuccess: report.passed,
    artifactAcceptance: cases.filter(
      (item) => item.artifactStatus === "verified",
    ).length,
    externalAcceptance: cases.filter(
      (item) => item.externalAcceptanceStatus === "verified",
    ).length,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    meanLlmCalls: llm.length
      ? Number(
          (llm.reduce((sum, value) => sum + value, 0) / llm.length).toFixed(2),
        )
      : null,
    meanToolCalls: tools.length
      ? Number(
          (tools.reduce((sum, value) => sum + value, 0) / tools.length).toFixed(
            2,
          ),
        )
      : null,
    repairRate: ratio(
      cases.filter((item) => item.repairAttempts > 0).length,
      cases.length,
    ),
    restartRecoveryRate: ratio(
      cases.filter(
        (item) => item.crashRestartInjected && item.recoveryTimeMs !== null,
      ).length,
      cases.filter((item) => item.crashRestartInjected).length,
    ),
    interruptGoalChangeRate: ratio(
      cases.filter((item) => item.interruptInjected && item.goalChanged).length,
      cases.length,
    ),
    toolFailureRate: ratio(
      cases.filter((item) => item.toolFailures > 0).length,
      cases.length,
    ),
    durableEventLossCases: cases.filter((item) => item.durableEventCount === 0)
      .length,
  };
}

export function compareLongHorizonReports(
  baseline: LongHorizonReportLike,
  experiment: LongHorizonReportLike,
): LongHorizonComparisonReport {
  const baselineIds = new Set(baseline.cases.map((item) => item.id));
  const experimentIds = new Set(experiment.cases.map((item) => item.id));
  const pairedTaskOverlap = [...baselineIds]
    .filter((id) => experimentIds.has(id))
    .sort();
  const baselineDomains = new Set(baseline.cases.map((item) => item.domain));
  const newDomains = [...new Set(experiment.cases.map((item) => item.domain))]
    .filter((domain) => !baselineDomains.has(domain))
    .sort();
  const failureCases = [
    ...baseline.cases
      .filter((item) => item.status !== "verified")
      .map((item) => ({
        window: baseline.window,
        id: item.id,
        domain: item.domain,
        status: item.status,
        failureCodes: [...item.failureCodes],
      })),
    ...experiment.cases
      .filter((item) => item.status !== "verified")
      .map((item) => ({
        window: experiment.window,
        id: item.id,
        domain: item.domain,
        status: item.status,
        failureCodes: [...item.failureCodes],
      })),
  ];
  return {
    kind: "real_long_horizon_window_comparison",
    generatedAt: new Date().toISOString(),
    baseline: {
      window: baseline.window,
      codeVersion: baseline.codeVersion,
      sampleCount: baseline.taskCount,
      timeRange: {
        startedAt: baseline.startedAt,
        finishedAt: baseline.finishedAt,
      },
      passRate: baseline.passRate,
      artifactAcceptanceRate: baseline.artifactAcceptanceRate,
      externalAcceptanceRate: baseline.externalAcceptanceRate,
      confidenceIntervals: baseline.confidenceIntervals,
    },
    experiment: {
      window: experiment.window,
      codeVersion: experiment.codeVersion,
      sampleCount: experiment.taskCount,
      timeRange: {
        startedAt: experiment.startedAt,
        finishedAt: experiment.finishedAt,
      },
      passRate: experiment.passRate,
      artifactAcceptanceRate: experiment.artifactAcceptanceRate,
      externalAcceptanceRate: experiment.externalAcceptanceRate,
      confidenceIntervals: experiment.confidenceIntervals,
      expandedDomains: newDomains,
    },
    deltas: {
      passRate: delta(experiment.passRate, baseline.passRate),
      artifactAcceptanceRate: delta(
        experiment.artifactAcceptanceRate,
        baseline.artifactAcceptanceRate,
      ),
      externalAcceptanceRate: delta(
        experiment.externalAcceptanceRate,
        baseline.externalAcceptanceRate,
      ),
    },
    pairedTaskOverlap,
    newDomains,
    failureCases,
    conclusion:
      pairedTaskOverlap.length < 2 || experiment.taskCount < baseline.taskCount
        ? "样本或任务重叠不足，不能据此支持稳定的跨窗口能力提升结论。"
        : "窗口差异仅描述观测事实；仍需更多重复窗口和长期 retention 数据后再判断泛化。",
  };
}

export function buildContinuousOpsReport(
  reports: readonly LongHorizonReportLike[],
): ContinuousOpsReport {
  const cases = reports.flatMap((report) => report.cases);
  const metrics = reports.map(aggregate);
  const sum = (
    key: "verifiedSuccess" | "artifactAcceptance" | "externalAcceptance",
  ): number => metrics.reduce((total, item) => total + item[key], 0);
  const durations = cases
    .map((item) => item.durationMs)
    .filter(Number.isFinite);
  const llm = cases.map((item) => item.llmCalls).filter(Number.isFinite);
  const tools = cases
    .map((item) => item.toolCallsFinished)
    .filter(Number.isFinite);
  const verifiedSuccess = sum("verifiedSuccess");
  const artifactAcceptance = sum("artifactAcceptance");
  const externalAcceptance = sum("externalAcceptance");
  const failed = cases.filter((item) => item.status !== "verified");
  return {
    kind: "agi_like_continuous_operations_report",
    generatedAt: new Date().toISOString(),
    codeVersions: reports.map((report) => report.codeVersion),
    providerModels: [...new Set(reports.map((report) => report.providerModel))],
    configurationSnapshots: reports.map(
      (report) => report.configurationSnapshot,
    ),
    sampleCount: cases.length,
    timeRange: {
      startedAt: reports.map((report) => report.startedAt).sort()[0] ?? "",
      finishedAt:
        reports
          .map((report) => report.finishedAt)
          .sort()
          .at(-1) ?? "",
    },
    cohorts: [
      ...new Set(
        reports.map((report) => `${report.window}:${report.experimentGroup}`),
      ),
    ],
    metrics: {
      verifiedSuccess,
      artifactAcceptance,
      externalAcceptance,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      meanLlmCalls: llm.length
        ? Number(
            (
              llm.reduce((total, value) => total + value, 0) / llm.length
            ).toFixed(2),
          )
        : null,
      meanToolCalls: tools.length
        ? Number(
            (
              tools.reduce((total, value) => total + value, 0) / tools.length
            ).toFixed(2),
          )
        : null,
      repairRate: ratio(
        cases.filter((item) => item.repairAttempts > 0).length,
        cases.length,
      ),
      restartRecoveryRate: ratio(
        cases.filter(
          (item) => item.crashRestartInjected && item.recoveryTimeMs !== null,
        ).length,
        cases.filter((item) => item.crashRestartInjected).length,
      ),
      interruptGoalChangeRate: ratio(
        cases.filter((item) => item.interruptInjected && item.goalChanged)
          .length,
        cases.length,
      ),
      toolFailureRate: ratio(
        cases.filter((item) => item.toolFailures > 0).length,
        cases.length,
      ),
      durableEventLossCases: cases.filter(
        (item) => item.durableEventCount === 0,
      ).length,
    },
    confidenceIntervals: {
      verifiedSuccess: wilson95(verifiedSuccess, cases.length),
      artifactAcceptance: wilson95(artifactAcceptance, cases.length),
      externalAcceptance: wilson95(externalAcceptance, cases.length),
    },
    safety: {
      scopeViolations: cases.reduce(
        (sum, item) =>
          sum +
          item.failureCodes.filter((code) =>
            /scope|cross_chat|visibility/i.test(code),
          ).length,
        0,
      ),
      unauthorizedSideEffects: cases.reduce(
        (sum, item) =>
          sum +
          item.failureCodes.filter((code) =>
            /side_effect|unauthorized/i.test(code),
          ).length,
        0,
      ),
      sandboxDenials: cases.reduce(
        (sum, item) =>
          sum +
          item.failureCodes.filter((code) =>
            /sandbox|terminal_disabled|browser_disabled/i.test(code),
          ).length,
        0,
      ),
      duplicateActions: cases.reduce(
        (sum, item) =>
          sum +
          item.failureCodes.filter((code) => /duplicate/i.test(code)).length,
        0,
      ),
    },
    failureSamples: failed
      .slice(0, 100)
      .map((item) => ({
        window:
          reports.find((report) => report.cases.includes(item))?.window ??
          "unknown",
        id: item.id,
        domain: item.domain,
        failureCodes: [...item.failureCodes],
      })),
    uncertainty: [
      "真实窗口样本仍小，未提供 1 天/7 天 retention 证据。",
      "route-observation/paired replay 数据未自动混入本文件；需在有同窗数据时另行合并。",
    ],
  };
}
