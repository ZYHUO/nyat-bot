import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatJob,
  FormattedMessage,
  RetrievedContext,
} from "../../../src/shared/types.js";

const mockFormatMessage = vi.fn();
const mockAddMessage = vi.fn();
const mockGetRecent = vi.fn();
const mockGetRecentCount = vi.fn();
const mockAddAssistant = vi.fn();
const mockJudge = vi.fn();
const mockDescribeImage = vi.fn();
const mockRetrieveContext = vi.fn();
const mockGenerateReply = vi.fn();
const mockSendChatAction = vi.fn();
const mockSendSticker = vi.fn();
const mockGetBotUid = vi.fn();
const mockRecordActivity = vi.fn();
const mockGetBotTracker = vi.fn();
const mockTryGenerateDigest = vi.fn();
const mockRecordReply = vi.fn();
const mockCheckOutcome = vi.fn();
const mockGenerateReflection = vi.fn();
const mockRecordUserMessage = vi.fn();
const mockSaveUserPreference = vi.fn();
const mockGetUserPreferences = vi.fn();
const mockDeleteUserPreference = vi.fn();
const mockGetMuteLevel = vi.fn();
const mockGetMuteState = vi.fn();
const mockMuteUser = vi.fn();
const mockUnmuteUser = vi.fn();
const mockMemorizeMessage = vi.fn();
const mockGetReadyStickersByIntent = vi.fn();
const mockLoadOverride = vi.fn();
const mockGetRedis = vi.fn();
const mockCallWithFallback = vi.fn();
const mockEnv = vi.fn();
const mockApplyChatPathPolicy = vi.fn();
const mockReflectChatPathPolicy = vi.fn();
const mockAcquireChatLock = vi.fn();

const { mockLogger, sendDirect } = vi.hoisted(() => {
  const logger: Record<string, unknown> = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  // child() returns the same mock so chained loggers track the same spies
  logger['child'] = () => logger;
  return { mockLogger: logger, sendDirect: vi.fn() };
});

vi.mock("../../../src/pipeline/formatter.js", () => ({
  formatMessage: (...args: unknown[]) => mockFormatMessage(...args),
}));

vi.mock("../../../src/pipeline/context/manager.js", () => ({
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
  getRecent: (...args: unknown[]) => mockGetRecent(...args),
  getRecentCount: (...args: unknown[]) => mockGetRecentCount(...args),
  addAssistant: (...args: unknown[]) => mockAddAssistant(...args),
}));

vi.mock("../../../src/pipeline/judge/judge.js", () => ({
  judge: (...args: unknown[]) => mockJudge(...args),
  l0Rule: vi.fn(() => null), // replan rule recovery — null = keep turn_replan
}));

vi.mock("../../../src/pipeline/reply/latency-model.js", () => ({
  // 测试用真实计时器 — 把重尾人类延迟压成毫秒级,保持调用形状
  sampleHumanDelay: vi.fn(() => 0.01),
}));

vi.mock("../../../src/pipeline/judge/micro.js", () => ({
  microJudge: vi.fn().mockResolvedValue({
    action: "REPLY",
    replyPath: "direct",
    replyTier: "normal",
    level: "L1_MICRO",
    latencyMs: 0,
  }),
}));

vi.mock("../../../src/pipeline/vision.js", () => ({
  describeImage: (...args: unknown[]) => mockDescribeImage(...args),
}));

vi.mock("../../../src/pipeline/context/retriever.js", () => ({
  retrieveContext: (...args: unknown[]) => mockRetrieveContext(...args),
}));

vi.mock("../../../src/pipeline/reply/reply.js", () => ({
  generateReply: (...args: unknown[]) => mockGenerateReply(...args),
}));

vi.mock("../../../src/bot/sender/streaming.js", () => ({
  StreamingSender: class {
    sendDirect = sendDirect;
  },
}));

vi.mock("../../../src/bot/sender/telegram.js", () => ({
  sendChatAction: (...args: unknown[]) => mockSendChatAction(...args),
  sendSticker: (...args: unknown[]) => mockSendSticker(...args),
}));

vi.mock("../../../src/bot/bot.js", () => ({
  getBotUid: (...args: unknown[]) => mockGetBotUid(...args),
}));

vi.mock("../../../src/tracking/activity.js", () => ({
  recordMessage: (...args: unknown[]) => mockRecordActivity(...args),
}));

vi.mock("../../../src/tracking/interaction.js", () => ({
  getBotTracker: (...args: unknown[]) => mockGetBotTracker(...args),
}));

vi.mock("../../../src/tracking/bot-digest.js", () => ({
  tryGenerateDigest: (...args: unknown[]) => mockTryGenerateDigest(...args),
}));

vi.mock("../../../src/tracking/outcome.js", () => ({
  recordReply: (...args: unknown[]) => mockRecordReply(...args),
  checkOutcome: (...args: unknown[]) => mockCheckOutcome(...args),
  generateReflection: (...args: unknown[]) => mockGenerateReflection(...args),
}));

vi.mock("../../../src/tracking/user-profile.js", () => ({
  recordUserMessage: (...args: unknown[]) => mockRecordUserMessage(...args),
  saveUserPreference: (...args: unknown[]) => mockSaveUserPreference(...args),
  getUserPreferences: (...args: unknown[]) => mockGetUserPreferences(...args),
  deleteUserPreference: (...args: unknown[]) =>
    mockDeleteUserPreference(...args),
  getMuteLevel: (...args: unknown[]) => mockGetMuteLevel(...args),
  getMuteState: (...args: unknown[]) => mockGetMuteState(...args),
  muteUser: (...args: unknown[]) => mockMuteUser(...args),
  unmuteUser: (...args: unknown[]) => mockUnmuteUser(...args),
}));

vi.mock("../../../src/memory/chroma.js", () => ({
  memorizeMessage: (...args: unknown[]) => mockMemorizeMessage(...args),
}));

vi.mock("../../../src/knowledge/sticker/store.js", () => ({
  getReadyStickersByIntent: (...args: unknown[]) =>
    mockGetReadyStickersByIntent(...args),
}));

vi.mock("../../../src/admin/runtime-config.js", () => ({
  loadOverride: (...args: unknown[]) => mockLoadOverride(...args),
  loadOverrideCached: (...args: unknown[]) => mockLoadOverride(...args),
}));

vi.mock("../../../src/db/redis.js", () => ({
  getRedis: (...args: unknown[]) => mockGetRedis(...args),
}));

vi.mock("../../../src/ai/fallback.js", () => ({
  callWithFallback: (...args: unknown[]) => mockCallWithFallback(...args),
}));

vi.mock("../../../src/env.js", () => ({
  env: (...args: unknown[]) => mockEnv(...args),
}));

vi.mock("../../../src/shared/logger.js", () => ({
  logger: mockLogger,
}));

vi.mock("../../../src/pipeline/path-policy.js", () => ({
  applyChatPathPolicy: (...args: unknown[]) => mockApplyChatPathPolicy(...args),
  reflectChatPathPolicy: (...args: unknown[]) =>
    mockReflectChatPathPolicy(...args),
}));

vi.mock("../../../src/queue/chat-lock.js", () => ({
  acquireChatLock: (...args: unknown[]) => mockAcquireChatLock(...args),
}));

import { processPipeline } from "../../../src/pipeline/pipeline.js";

function makeFormattedMessage(): FormattedMessage {
  return {
    role: "user",
    uid: 1001,
    username: "alice",
    fullName: "Alice",
    timestamp: 1700000000,
    messageId: 42,
    textContent: "hello",
    isForwarded: false,
  };
}

function makeRetrievedContext(): RetrievedContext {
  return {
    recent: [{ ...makeFormattedMessage(), messageId: 1 }],
    semantic: [{ ...makeFormattedMessage(), messageId: 2 }],
    thread: [{ ...makeFormattedMessage(), messageId: 3 }],
    entity: [{ ...makeFormattedMessage(), messageId: 4 }],
    merged: [],
    tokenCount: 0,
  };
}

function makeJob(): ChatJob {
  return {
    type: "message",
    chatId: -100123,
    enqueuedAt: Date.now(),
    update: {},
  };
}

describe("processPipeline path branching", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockFormatMessage.mockReturnValue(makeFormattedMessage());
    mockAddMessage.mockResolvedValue(undefined);
    mockGetRecent.mockResolvedValue([]);
    mockGetRecentCount.mockResolvedValue([]);
    mockAddAssistant.mockResolvedValue(undefined);
    mockDescribeImage.mockResolvedValue(null);
    mockRetrieveContext.mockResolvedValue(makeRetrievedContext());
    mockGenerateReply.mockResolvedValue({
      replies: [{ replyContent: "hi", targetMessageId: 42 }],
      toolsUsed: [],
      toolExecutionFailed: false,
    });
    mockSendChatAction.mockResolvedValue(undefined);
    mockSendSticker.mockResolvedValue(undefined);
    mockGetBotUid.mockReturnValue(9999);
    mockRecordActivity.mockResolvedValue(undefined);
    mockGetBotTracker.mockReturnValue(null);
    mockTryGenerateDigest.mockResolvedValue(undefined);
    mockRecordReply.mockResolvedValue(undefined);
    mockCheckOutcome.mockResolvedValue({ needsReflection: false });
    mockGenerateReflection.mockResolvedValue(undefined);
    mockRecordUserMessage.mockResolvedValue(undefined);
    mockSaveUserPreference.mockImplementation(() => {});
    mockGetUserPreferences.mockReturnValue(null);
    mockDeleteUserPreference.mockReturnValue(null);
    mockGetMuteLevel.mockReturnValue(0);
    mockGetMuteState.mockReturnValue({ level: 0, temporary: false });
    mockMuteUser.mockImplementation(() => {});
    mockUnmuteUser.mockImplementation(() => {});
    mockMemorizeMessage.mockResolvedValue(undefined);
    mockGetReadyStickersByIntent.mockReturnValue([]);
    mockLoadOverride.mockResolvedValue(null);
    mockGetRedis.mockReturnValue({});
    mockCallWithFallback.mockResolvedValue({
      content: "reflection",
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      model: "x",
      label: "x",
      latencyMs: 0,
    });
    mockApplyChatPathPolicy.mockImplementation(
      async ({ rawReplyPath }: { rawReplyPath: string }) => ({
        replyPath: rawReplyPath,
        matchedPatterns: [],
        source: "raw",
      }),
    );
    mockReflectChatPathPolicy.mockResolvedValue(undefined);
    mockAcquireChatLock.mockResolvedValue(vi.fn().mockResolvedValue(undefined));
    mockEnv.mockReturnValue({
      BOT_USERNAME: "xxb_bot",
      BOT_NICKNAMES: ["xxb"],
      JUDGE_WINDOW_SIZE: 20,
      OUTCOME_TRACKING_ENABLED: false,
      CHANNEL_SOURCE_IDS: [],
    });
    sendDirect.mockResolvedValue({ messageId: 777 });
  });

  it("replan carries engagement over: judge is NOT re-run, reply still generates", async () => {
    // G3 修复:打断重规划后锚点是用户的简短补充,如果重新过 judge 会被
    // IGNORE → 本该有的回复凭空消失。重规划必须只改"说什么",不重审"说不说"。
    mockGenerateReply.mockResolvedValue({
      replies: [{ replyContent: "回你们两句", targetMessageId: 42 }],
      toolsUsed: [],
      toolExecutionFailed: false,
    });
    sendDirect.mockResolvedValue({ messageId: 1001 });

    const job = makeJob();
    job.turnContext = { isReplan: true, gateBypass: true, epoch: 2 };
    await processPipeline(job);

    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockGenerateReply).toHaveBeenCalledTimes(1);
    expect(sendDirect).toHaveBeenCalled();
  });

  // NL 软禁言(别理我/闭嘴)的关键词拦截已下线 —— 改由 directive.ts(回复前 LLM 分类)
  // 静默执行,不再产生 mute_soft_request 规则。

  it("clears temporary mute on next direct mention before continuing reply flow", async () => {
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "direct",
      replyTier: "normal",
      rule: "mention_self",
      level: "L0_RULE",
      latencyMs: 0,
    });
    mockGetMuteState.mockReturnValue({ level: 1, temporary: true });

    await processPipeline(makeJob());

    expect(mockUnmuteUser).toHaveBeenCalledWith(-100123, 1001);
    expect(mockGenerateReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "REPLY",
      -100123,
      9999,
      "direct",
      "normal",
      undefined,
      undefined, // turn-actor callOpts (legacy path: none)
    );
  });

  it("uses direct retrieval mode and logs direct telemetry", async () => {
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "direct",
      replyTier: "normal",
      level: "L1_MICRO",
      latencyMs: 12,
    });

    await processPipeline(makeJob());

    expect(mockRetrieveContext).toHaveBeenCalledWith(
      -100123,
      expect.objectContaining({ messageId: 42 }),
      9999,
      { mode: "direct" },
    );
    expect(mockGenerateReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "REPLY",
      -100123,
      9999,
      "direct",
      "normal",
      undefined,
      undefined, // turn-actor callOpts (legacy path: none)
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "REPLY",
        replyPath: "direct",
        replyTier: "normal",
        retrievalMode: "direct",
        recentCount: 1,
        semanticCount: 1,
        threadCount: 1,
        entityCount: 1,
        retrievalMs: expect.any(Number),
        replyMs: expect.any(Number),
      }),
      "Pipeline complete",
    );
    expect(mockReflectChatPathPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveReplyPath: "direct",
        replyText: "hi",
        toolsUsed: [],
        toolExecutionFailed: false,
      }),
    );
  });

  it("releases intake lock before generating reply and reacquires before send", async () => {
    const firstRelease = vi.fn().mockResolvedValue(undefined);
    const secondRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireChatLock
      .mockResolvedValueOnce(firstRelease)
      .mockResolvedValueOnce(secondRelease);
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "direct",
      replyTier: "normal",
      level: "L1_MICRO",
      latencyMs: 12,
    });

    await processPipeline(makeJob());

    expect(mockAcquireChatLock).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
    expect(firstRelease.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerateReply.mock.invocationCallOrder[0]!,
    );
    expect(sendDirect).toHaveBeenCalledTimes(1);
  });

  it("suppresses stale proactive reply if a newer assistant turn already exists", async () => {
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "direct",
      replyTier: "normal",
      level: "L1_MICRO",
      latencyMs: 12,
    });
    mockGetRecent.mockResolvedValueOnce([]).mockResolvedValueOnce([
      makeFormattedMessage(),
      {
        role: "assistant",
        uid: 9999,
        username: "",
        fullName: "",
        timestamp: 1700000001,
        messageId: 99,
        textContent: "already replied",
        isForwarded: false,
      },
    ]);

    await processPipeline(makeJob());

    expect(mockGenerateReply).toHaveBeenCalledTimes(1);
    expect(sendDirect).not.toHaveBeenCalled();
    expect(mockAddAssistant).not.toHaveBeenCalled();
  });

  it("uses planned retrieval mode and logs planned telemetry", async () => {
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "planned",
      replyTier: "pro",
      level: "L2_AI",
      latencyMs: 30,
    });

    await processPipeline(makeJob());

    expect(mockRetrieveContext).toHaveBeenCalledWith(
      -100123,
      expect.objectContaining({ messageId: 42 }),
      9999,
      { mode: "planned" },
    );
    expect(mockGenerateReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "REPLY",
      -100123,
      9999,
      "planned",
      "pro",
      undefined,
      undefined, // turn-actor callOpts (legacy path: none)
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "REPLY",
        replyPath: "planned",
        replyTier: "pro",
        retrievalMode: "planned",
        recentCount: 1,
        semanticCount: 1,
        threadCount: 1,
        entityCount: 1,
        retrievalMs: expect.any(Number),
        replyMs: expect.any(Number),
      }),
      "Pipeline complete",
    );
    expect(mockReflectChatPathPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveReplyPath: "planned",
        replyText: "hi",
        toolsUsed: [],
        toolExecutionFailed: false,
      }),
    );
  });

  it("applies chat-local path policy overlay before retrieval", async () => {
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "direct",
      replyTier: "normal",
      level: "L1_MICRO",
      latencyMs: 12,
    });
    mockApplyChatPathPolicy.mockResolvedValue({
      replyPath: "planned",
      matchedPatterns: ["market_quote"],
      source: "policy",
    });

    await processPipeline(makeJob());

    expect(mockRetrieveContext).toHaveBeenCalledWith(
      -100123,
      expect.objectContaining({ messageId: 42 }),
      9999,
      { mode: "planned" },
    );
    expect(mockGenerateReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "REPLY",
      -100123,
      9999,
      "planned",
      "normal",
      undefined,
      undefined, // turn-actor callOpts (legacy path: none)
    );
  });

  it("reflects path policy only after at least one reply was sent successfully", async () => {
    sendDirect.mockRejectedValueOnce(new Error("telegram send failed"));

    await processPipeline(makeJob());

    expect(mockReflectChatPathPolicy).not.toHaveBeenCalled();
  });

  it("sends multiple replies when reply generator returns multiple messages", async () => {
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "direct",
      replyTier: "normal",
      level: "L1_MICRO",
      latencyMs: 12,
    });
    mockGenerateReply.mockResolvedValue({
      replies: [
        { replyContent: "first", targetMessageId: 42 },
        { replyContent: "second", targetMessageId: 42 },
      ],
      toolsUsed: [],
      toolExecutionFailed: false,
    });
    sendDirect
      .mockResolvedValueOnce({ messageId: 1001 })
      .mockResolvedValueOnce({ messageId: 1002 });

    await processPipeline(makeJob());

    expect(sendDirect).toHaveBeenCalledTimes(2);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        replyCount: 2,
        replyMsgIds: [1001, 1002],
      }),
      "Pipeline complete",
    );
  }, 15000); // real humanizer delays — generous timeout to avoid suite-load flakiness

  it("sticker-only send failure records NOTHING (no messageId:0 phantom) — #39c", async () => {
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "direct",
      replyTier: "normal",
      level: "L1_MICRO",
      latencyMs: 12,
    });
    mockGenerateReply.mockResolvedValue({
      replies: [{
        replyContent: "[sticker]",
        targetMessageId: 42,
        stickerIntent: ["happy"],
        modelStickerAct: true, // 跳过冷却,确定走贴纸路径
      }],
      toolsUsed: [],
      toolExecutionFailed: false,
    });
    // 防 RNG:关掉 emoji/sticker-only 替换,贴纸只走主路径
    mockLoadOverride.mockResolvedValue({ humanizer: { emoji_reply_enabled: false } });
    mockGetReadyStickersByIntent.mockReturnValue([
      { fileId: "f1", fileUniqueId: "u1", score: 1 },
    ]);
    mockSendSticker.mockRejectedValue(new Error("sticker send failed"));

    await processPipeline(makeJob()); // 内部吞错,不应 throw

    // 修复前:push {messageId: 0} 幻影 → addAssistant(chatId, {messageId: 0})
    expect(mockAddAssistant).not.toHaveBeenCalled();
    // sentMessages 为空 → 走"全部发送失败"故障路径(兜底致歉消息)
    const fallbackSent = sendDirect.mock.calls.some(
      (c: unknown[]) => typeof c[1] === "string" && (c[1] as string).includes("故障"),
    );
    expect(fallbackSent).toBe(true);
  }, 15000);

  it("quote-replies each DISTINCT target in a multi-target reply", async () => {
    // Bug: a reply aimed at someone other than the requester must quote THAT
    // person's message, not get its quote dropped just because an earlier bubble
    // already sent text. Reply 1 → #42 (requester), reply 2 → #99 (other person).
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "direct",
      replyTier: "normal",
      level: "L1_MICRO",
      latencyMs: 12,
    });
    mockGenerateReply.mockResolvedValue({
      replies: [
        { replyContent: "ok let me", targetMessageId: 42 },
        { replyContent: "hey you", targetMessageId: 99 },
      ],
      toolsUsed: [],
      toolExecutionFailed: false,
    });
    sendDirect
      .mockResolvedValueOnce({ messageId: 1001 })
      .mockResolvedValueOnce({ messageId: 1002 })
      .mockResolvedValue({ messageId: 1003 });

    await processPipeline(makeJob());

    // The 3rd positional arg of sendDirect is replyToId. Each distinct target
    // must appear — pre-fix, #99 was dropped (sent with undefined).
    const replyTargets = sendDirect.mock.calls.map((c: unknown[]) => c[2]);
    expect(replyTargets).toEqual(expect.arrayContaining([42, 99]));
  }, 15000); // real humanizer delays — generous timeout to avoid suite-load flakiness

  it("direct (reply-to-bot) interactions are exempt from small-group quote suppression", async () => {
    // #3 小群降 quote 修复:rule ∈ DIRECT_INTERACTION_RULES → 跳过抑制评估。
    // 场景构造:群风格 quoteRatio=0 → suppressProb=0.92,Math.random=0.9
    // 本应抑制(0.9 < 0.92,且 0.9 > 全部 humanizer 概率 → 不误触发);
    // direct 豁免后引用必须保留(2026-06-12 reply-to-bot 裸消息根因)。
    const { _resetChatStyleCache } = await import("../../../src/tracking/chat-style.js");
    _resetChatStyleCache();
    mockJudge.mockResolvedValue({
      action: "REPLY",
      rule: "reply_to_self",
      replyPath: "direct",
      replyTier: "normal",
      level: "L0_RULE",
      latencyMs: 0,
    });
    // 15 条无 replyTo 的人类消息 → quoteRatio=0;触发消息(42)在窗口
    // 尾部 → 无人插话,抑制前置条件全部满足
    const fillers = Array.from({ length: 15 }, (_, i) => ({
      ...makeFormattedMessage(),
      messageId: 100 + i,
      uid: 2000 + i,
      textContent: `msg ${i}`,
    }));
    mockGetRecent.mockResolvedValue([...fillers, makeFormattedMessage()]);
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      await processPipeline({ type: "message", chatId: -100777, enqueuedAt: Date.now(), update: {} });
    } finally {
      rand.mockRestore();
    }
    const replyCall = sendDirect.mock.calls.find((c: unknown[]) => c[1] === "hi");
    expect(replyCall).toBeDefined();
    expect(replyCall![2]).toBe(42);
  }, 15000);

  it("small-group quote suppression still fires for non-direct replies", async () => {
    // 同样的抑制场景,但非 direct(无 rule)→ 策略照常生效,引用被砍
    const { _resetChatStyleCache } = await import("../../../src/tracking/chat-style.js");
    _resetChatStyleCache();
    mockJudge.mockResolvedValue({
      action: "REPLY",
      replyPath: "chat",
      replyTier: "normal",
      level: "L1_MICRO",
      latencyMs: 0,
    });
    const fillers = Array.from({ length: 15 }, (_, i) => ({
      ...makeFormattedMessage(),
      messageId: 100 + i,
      uid: 2000 + i,
      textContent: `msg ${i}`,
    }));
    mockGetRecent.mockResolvedValue([...fillers, makeFormattedMessage()]);
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      await processPipeline({ type: "message", chatId: -100778, enqueuedAt: Date.now(), update: {} });
    } finally {
      rand.mockRestore();
    }
    const replyCall = sendDirect.mock.calls.find((c: unknown[]) => c[1] === "hi");
    expect(replyCall).toBeDefined();
    expect(replyCall![2]).toBeUndefined();
  }, 15000);
});
