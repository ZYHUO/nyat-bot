import { describe, expect, it } from "vitest";
import { evaluateCanaryWindow } from "../../../src/eval/agency-canary.js";

describe("agency canary harness", () => {
  it("keeps baseline and experiment cohorts separate and triggers rollback on safety facts", () => {
    const report = evaluateCanaryWindow({
      codeVersion: "test",
      configSnapshot: { mode: "canary", authority: false },
      from: "2026-09-14T00:00:00Z",
      to: "2026-09-14T01:00:00Z",
      observations: [
        {
          sampleId: "b-1",
          cohort: "frozen_baseline",
          verifiedSuccess: true,
          latencyMs: 10,
          tokenCost: 1,
        },
        {
          sampleId: "e-1",
          cohort: "experiment",
          verifiedSuccess: false,
          scopeViolations: 1,
          failureCode: "scope_violation",
        },
      ],
    });
    expect(report.cohorts.frozen_baseline.samples).toBe(1);
    expect(report.cohorts.experiment.samples).toBe(1);
    expect(report.rollback.required).toBe(true);
    expect(report.rollback.reasons).toContain("scope_violation");
  });
});
