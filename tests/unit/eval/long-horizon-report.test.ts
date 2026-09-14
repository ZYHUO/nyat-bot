import { describe, expect, it } from "vitest";
import {
  buildContinuousOpsReport,
  compareLongHorizonReports,
  type LongHorizonReportLike,
} from "../../../src/eval/long-horizon-report.js";

function report(
  window: string,
  taskCount: number,
  passed: number,
  domains: string[],
): LongHorizonReportLike {
  const cases = domains.map((domain, index) => ({
    id: `task-${index}`,
    domain,
    status: index < passed ? "verified" : "failed",
    artifactStatus: index < passed ? "verified" : "failed",
    externalAcceptanceStatus: index < passed ? "verified" : "failed",
    turns: 3,
    llmCalls: 3,
    llmFailures: 0,
    inputTokens: 1,
    outputTokens: 1,
    toolCallsStarted: 2,
    toolCallsFinished: 2,
    toolFailures: 0,
    durableEventCount: 5,
    repairAttempts: index === 0 ? 1 : 0,
    durationMs: 100 + index,
    failureCodes: index < passed ? [] : ["acceptance_check_failed"],
    crashRestartInjected: index === 0,
    interruptInjected: index === 1,
    goalChanged: index === 1,
    recoveryTimeMs: index === 0 ? 4 : null,
    checkpointCount: index === 0 ? 1 : 0,
  }));
  return {
    kind: "real_long_horizon_execution_evaluation",
    window,
    experimentGroup: "test",
    generatedAt: "2026-09-14T00:00:00Z",
    startedAt: "2026-09-14T00:00:00Z",
    finishedAt: "2026-09-14T00:01:00Z",
    codeVersion: { revision: window, dirty: false },
    providerModel: "test",
    taskCount,
    passed,
    failed: taskCount - passed,
    unverified: 0,
    passRate: passed / taskCount,
    artifactAcceptanceRate: passed / taskCount,
    externalAcceptanceRate: passed / taskCount,
    horizonRequirementRate: 1,
    confidenceIntervals: {},
    cases,
    failureCases: cases.filter((item) => item.status !== "verified"),
    configurationSnapshot: {},
  };
}

describe("long-horizon report aggregation", () => {
  it("compares repeated and expanded windows without overclaiming", () => {
    const comparison = compareLongHorizonReports(
      report("window-1", 2, 1, ["data", "docs"]),
      report("window-2", 3, 2, ["data", "docs", "programming"]),
    );
    expect(comparison.pairedTaskOverlap).toEqual(["task-0", "task-1"]);
    expect(comparison.newDomains).toEqual(["programming"]);
    expect(comparison.conclusion).toContain("更多");
  });

  it("aggregates operations and retains safety/uncertainty fields", () => {
    const ops = buildContinuousOpsReport([
      report("window-1", 2, 1, ["data", "docs"]),
    ]);
    expect(ops.sampleCount).toBe(2);
    expect(ops.metrics.restartRecoveryRate).toBe(1);
    expect(ops.uncertainty.length).toBeGreaterThan(0);
  });
});
