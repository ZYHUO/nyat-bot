// hedge abort tests
import { describe, it, expect, vi, beforeEach } from "vitest";

const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));

vi.mock("../../../src/ai/provider.js", () => ({ callModel: callModelMock }));
vi.mock("../../../src/db/redis.js", () => ({ getRedis: () => ({}) }));
vi.mock("../../../src/shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../src/ai/cooldown.js", () => ({
  CooldownTracker: class {
    isCoolingDown = vi.fn().mockResolvedValue(false);
    setCooldown = vi.fn().mockResolvedValue(undefined);
    recordSuccess = vi.fn().mockResolvedValue(undefined);
    recordFailure = vi.fn().mockResolvedValue(false);
  },
}));
vi.mock("../../../src/ai/labels.js", () => ({
  getUsage: () => ({
    label: "primary",
    backups: ["hedge"],
    maxTokens: 100,
    temperature: 0.7,
    timeout: 60_000,
  }),
  getLabel: (name: string) => ({ name, model: `model-${name}`, endpoint: "http://test", apiKeys: ["k"] }),
}));
vi.mock("../../../src/env.js", () => ({ env: () => ({ HEDGE_DELAY_MS: 20 }) }));
vi.mock("../../../src/ai/events.js", () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));

import { callWithFallback } from "../../../src/ai/fallback.js";

function result(label: string) {
  return {
    content: `from ${label}`,
    tokenUsage: { prompt: 10, completion: 5, total: 15 },
    model: `model-${label}`,
    label,
    latencyMs: 1,
  };
}

describe("hedged call cancels the loser", () => {
  beforeEach(() => callModelMock.mockReset());

  it("aborts the in-flight hedge once the primary wins", async () => {
    let hedgeAborted = false;

    callModelMock.mockImplementation((label?: { name: string }, _msgs?: unknown, opts?: { signal?: AbortSignal }) => {
      if (!label) {
        // leaked timer / stray call — ignore like fallback-hedge.test.ts
        return Promise.resolve(result("leak"));
      }
      if (label.name === "primary") {
        return new Promise((res) => setTimeout(() => res(result("primary")), 60));
      }
      return new Promise((_res, rej) => {
        opts?.signal?.addEventListener("abort", () => {
          hedgeAborted = true;
          rej(new Error("aborted"));
        });
      });
    });

    const r = await callWithFallback({ usage: "reply", messages: [{ role: "user", content: "hi" }] });

    expect(r.label).toBe("primary");
    // at least primary+hedge; stray leak calls ok
    expect(callModelMock.mock.calls.filter((c) => c[0]?.name === "primary").length).toBe(1);
    expect(callModelMock.mock.calls.filter((c) => c[0]?.name === "hedge").length).toBe(1);
    expect(hedgeAborted).toBe(true);
  });

  it("aborts the primary when the hedge wins", async () => {
    let primaryAborted = false;

    callModelMock.mockImplementation((label?: { name: string }, _msgs?: unknown, opts?: { signal?: AbortSignal }) => {
      if (!label) return Promise.resolve(result("leak"));
      if (label.name === "hedge") {
        return new Promise((res) => setTimeout(() => res(result("hedge")), 10));
      }
      return new Promise((_res, rej) => {
        opts?.signal?.addEventListener("abort", () => {
          primaryAborted = true;
          rej(new Error("aborted"));
        });
      });
    });

    const r = await callWithFallback({ usage: "reply", messages: [{ role: "user", content: "hi" }] });

    expect(r.label).toBe("hedge");
    expect(primaryAborted).toBe(true);
  });

  it("never starts the hedge when the primary beats hedgeDelayMs", async () => {
    callModelMock.mockImplementation((label?: { name: string }) => {
      if (!label) return Promise.resolve(result("leak"));
      if (label.name === "primary") return Promise.resolve(result("primary"));
      return Promise.reject(new Error("hedge should not have been started"));
    });

    const r = await callWithFallback({ usage: "reply", messages: [{ role: "user", content: "hi" }] });

    expect(r.label).toBe("primary");
    expect(callModelMock.mock.calls.filter((c) => c[0]?.name === "hedge").length).toBe(0);
  });
});
