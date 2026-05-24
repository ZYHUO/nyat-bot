import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormattedMessage } from "../../../src/shared/types.js";
import type { JudgeInput } from "../../../src/pipeline/judge/judge.js";

const mockEvaluateRules = vi.fn();
const mockMicroJudge = vi.fn();
const mockEnv = vi.fn();
const mockGetKnowledge = vi.fn();

vi.mock("../../../src/pipeline/judge/rules.js", () => ({
  evaluateRules: (...args: unknown[]) => mockEvaluateRules(...args),
}));

vi.mock("../../../src/pipeline/judge/micro.js", () => ({
  microJudge: (...args: unknown[]) => mockMicroJudge(...args),
}));

vi.mock("../../../src/env.js", () => ({
  env: (...args: unknown[]) => mockEnv(...args),
}));

vi.mock("../../../src/knowledge/manager.js", () => ({
  getKnowledge: (...args: unknown[]) => mockGetKnowledge(...args),
}));

vi.mock("../../../src/shared/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { judge } from "../../../src/pipeline/judge/judge.js";

function makeMessage(
  overrides: Partial<FormattedMessage> = {},
): FormattedMessage {
  return {
    role: "user",
    uid: 1001,
    username: "alice",
    fullName: "Alice",
    timestamp: 1700000000,
    messageId: 42,
    textContent: "hello",
    isForwarded: false,
    ...overrides,
  };
}

function makeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  const message = overrides.message ?? makeMessage();
  return {
    message,
    recentMessages: overrides.recentMessages ?? [message],
    botUid: overrides.botUid ?? 9999,
    botUsername: overrides.botUsername ?? "xxb_bot",
    botNicknames: overrides.botNicknames ?? ["xxb", "啾咪囝"],
    chatId: overrides.chatId ?? -100123,
    groupActivity: overrides.groupActivity ?? {
      messagesLast5Min: 5,
      messagesLast1Hour: 20,
    },
  };
}

describe("judge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateRules.mockReturnValue(null);
    mockEnv.mockReturnValue({
      JUDGE_KNOWLEDGE_ENABLED: false,
      JUDGE_KNOWLEDGE_PERMANENT: true,
      JUDGE_KNOWLEDGE_GROUP: true,
    });
    mockGetKnowledge.mockReturnValue("");
  });

  it("accepts medium-confidence L1 ignore without escalating to L2", async () => {
    mockMicroJudge.mockResolvedValue({
      action: "IGNORE",
      level: "L1_MICRO",
      confidence: 0.6,
      latencyMs: 120,
    });

    const result = await judge(makeInput());

    expect(result.action).toBe("IGNORE");
    expect(result.level).toBe("L1_MICRO");
    expect(mockMicroJudge).toHaveBeenCalledTimes(1);
    expect(mockMicroJudge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      9999,
      "judge",
      "",
      -100123,
    );
  });

  it("keeps L2 fallback for low-confidence L1 replies", async () => {
    mockMicroJudge
      .mockResolvedValueOnce({
        action: "REPLY",
        replyPath: "direct",
        replyTier: "normal",
        level: "L1_MICRO",
        confidence: 0.45,
        latencyMs: 80,
      })
      .mockResolvedValueOnce({
        action: "REPLY",
        replyPath: "planned",
        replyTier: "pro",
        level: "L1_MICRO",
        confidence: 0.92,
        latencyMs: 140,
      });

    const result = await judge(makeInput());

    expect(result.action).toBe("REPLY");
    expect(result.replyPath).toBe("planned");
    expect(result.replyTier).toBe("pro");
    expect(result.level).toBe("L2_AI");
    expect(mockMicroJudge).toHaveBeenCalledTimes(2);
    expect(mockMicroJudge).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      9999,
      "reply",
      "",
      -100123,
    );
  });
});
