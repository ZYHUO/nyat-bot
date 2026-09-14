import { buildLongHorizonTaskSet } from "../../../src/eval/long-horizon.js";

describe("long-horizon held-out task set", () => {
  it("contains distinct multi-domain tasks with caller-owned acceptance", () => {
    const tasks = buildLongHorizonTaskSet();
    expect(tasks).toHaveLength(11);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
    expect(new Set(tasks.map((task) => task.domain)).size).toBe(tasks.length);
    for (const task of tasks) {
      expect(task.minTurns).toBeGreaterThanOrEqual(3);
      expect(task.maxTurns).toBeGreaterThan(task.minTurns);
      expect(task.phaseInstructions).toHaveLength(task.minTurns);
      expect(task.acceptance.source).toBe("caller");
      expect(task.acceptance.checks.length).toBeGreaterThan(0);
      expect(task.outputFiles.length).toBeGreaterThan(0);
      expect(task.externalAcceptance).toBeDefined();
    }
    expect(
      new Set(tasks.filter((task) => task.crashRestart).map((task) => task.id))
        .size,
    ).toBeGreaterThan(0);
    expect(
      tasks.filter((task) => task.interruptGoalChange).length,
    ).toBeGreaterThan(0);
  });

  it("returns fresh seed and phase collections for each evaluation run", () => {
    const first = buildLongHorizonTaskSet();
    const second = buildLongHorizonTaskSet();
    expect(first).not.toBe(second);
    expect(first[0]?.seedFiles).not.toBe(second[0]?.seedFiles);
    expect(first[0]?.phaseInstructions).not.toBe(second[0]?.phaseInstructions);
    expect(first.map((task) => task.id)).toEqual(second.map((task) => task.id));
  });
});
