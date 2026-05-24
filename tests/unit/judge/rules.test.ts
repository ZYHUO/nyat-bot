import { describe, it, expect, vi } from "vitest";
import { evaluateRules } from "../../../src/pipeline/judge/rules.js";
import type { RuleContext } from "../../../src/pipeline/judge/rules.js";
import type { FormattedMessage } from "../../../src/shared/types.js";

function makeMsg(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: "user",
    uid: 1001,
    username: "alice",
    fullName: "Alice",
    timestamp: Math.floor(Date.now() / 1000),
    messageId: 100,
    textContent: "Hello world",
    isForwarded: false,
    isBot: false,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    message: makeMsg(),
    recentMessages: [],
    botUid: 9999,
    botUsername: "xxb_bot",
    botNicknames: ["xxb", "啾咪囝"],
    groupActivity: { messagesLast5Min: 5, messagesLast1Hour: 50 },
    lastBotReplyIndex: -1,
    ...overrides,
  };
}

describe("L0 Rules Engine", () => {
  it("bot message → IGNORE", () => {
    const ctx = makeCtx({
      message: makeMsg({ isBot: true, uid: 2000, textContent: "some bot msg" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("bot_message");
  });

  it("bot message @self → REPLY", () => {
    const ctx = makeCtx({
      message: makeMsg({ isBot: true, uid: 2000, textContent: "hey @xxb_bot" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.replyPath).toBe("direct");
    expect(result!.replyTier).toBe("normal");
    expect(result!.rule).toBe("bot_mentions_self");
  });

  it("direct @self → REPLY", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "hello @xxb_bot how are you" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.replyPath).toBeUndefined();
    expect(result!.replyTier).toBe("normal");
    expect(result!.rule).toBe("mention_self");
  });

  it("mention by nickname → REPLY", () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: "啾咪囝你好呀" }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("mention_self");
  });

  it("reply to self → REPLY", () => {
    const ctx = makeCtx({
      message: makeMsg({
        replyTo: {
          messageId: 50,
          uid: 9999,
          fullName: "XXB",
          textSnippet: "hi",
        },
      }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("reply_to_self");
  });

  it("reply to self with a URL → REPLY planned", () => {
    const ctx = makeCtx({
      message: makeMsg({
        textContent: "这个呢 https://example.com",
        replyTo: {
          messageId: 50,
          uid: 9999,
          fullName: "XXB",
          textSnippet: "hi",
        },
      }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.replyPath).toBe("planned");
    expect(result!.rule).toBe("reply_to_self_lookup");
  });

  it("mention self with explicit lookup wording and domain → REPLY planned", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "@xxb_bot 看一下这个 nodeseek.com" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.replyPath).toBe("planned");
    expect(result!.rule).toBe("mention_self_lookup");
  });

  it("reply to self with realtime weather request → REPLY planned", () => {
    const ctx = makeCtx({
      message: makeMsg({
        textContent: "看看今天新加坡天气",
        replyTo: {
          messageId: 50,
          uid: 9999,
          fullName: "XXB",
          textSnippet: "hi",
        },
      }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.replyPath).toBe("planned");
    expect(result!.rule).toBe("reply_to_self_lookup");
  });

  it("reply to self with explicit stock request → REPLY planned", () => {
    const ctx = makeCtx({
      message: makeMsg({
        textContent: "看看Microsoft的股票",
        replyTo: {
          messageId: 50,
          uid: 9999,
          fullName: "XXB",
          textSnippet: "hi",
        },
      }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.replyPath).toBe("planned");
    expect(result!.rule).toBe("reply_to_self_lookup");
  });

  it("reply to self with follow-up stock request → REPLY planned", () => {
    const ctx = makeCtx({
      message: makeMsg({
        textContent: "老黄的呢",
        replyTo: {
          messageId: 50,
          uid: 9999,
          fullName: "XXB",
          textSnippet:
            "主人，Microsoft (MSFT) 目前股价大约在 400 美元左右波动呢。",
        },
      }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.replyPath).toBe("planned");
    expect(result!.rule).toBe("reply_to_self_followup_lookup");
  });

  it("reply to self with exact mute phrase → mute_soft_request", () => {
    const ctx = makeCtx({
      chatId: -100123,
      message: makeMsg({
        textContent: "闭嘴",
        replyTo: {
          messageId: 50,
          uid: 9999,
          fullName: "XXB",
          textSnippet: "hi",
        },
      }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("mute_soft_request");
  });

  it("reply to self mentioning mute keyword in negated context → normal direct reply", () => {
    const ctx = makeCtx({
      chatId: -100123,
      message: makeMsg({
        textContent: "不要闭嘴了",
        replyTo: {
          messageId: 50,
          uid: 9999,
          fullName: "XXB",
          textSnippet: "hi",
        },
      }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("reply_to_self");
  });

  it("reply to self mentioning mute keyword in pasted content → normal direct reply", () => {
    const ctx = makeCtx({
      chatId: -100123,
      message: makeMsg({
        textContent: '闭嘴import os\nprint("hello")',
        replyTo: {
          messageId: 50,
          uid: 9999,
          fullName: "XXB",
          textSnippet: "hi",
        },
      }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("reply_to_self");
  });

  it("mention self with exact mute phrase → mute_soft_request", () => {
    const ctx = makeCtx({
      chatId: -100123,
      message: makeMsg({ textContent: "啾咪囝 闭嘴" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("mute_soft_request");
  });

  it("mention self with unmute phrase → normal direct reply", () => {
    // "解除闭嘴" 应详解为解除操作，不是发出闭嘴请求
    const ctx = makeCtx({
      chatId: -100123,
      message: makeMsg({ textContent: "啊咋囝 解除闭嘴" }),
    });
    const result = evaluateRules(ctx);
    expect(result?.action).not.toBe("MUTE");
    expect(result?.rule).not.toBe("mute_soft_request");
  });

  it("mention self quoting mute keyword → normal direct reply", () => {
    const ctx = makeCtx({
      chatId: -100123,
      message: makeMsg({ textContent: "啾咪囝 千万不要说出“闭嘴”两字" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("mention_self");
  });

  it("mention self with shorthand realtime weather request → REPLY planned", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "xxb 今天莫斯科天气" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.replyPath).toBe("planned");
    expect(result!.rule).toBe("mention_self_lookup");
  });

  it("slash command /checkin → REPLY", () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: "/checkin" }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("whitelisted_command");
  });

  it("slash command /checkin@bot → REPLY", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "/checkin@xxb_bot" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("whitelisted_command");
  });

  it("slash command /checkin@other_bot → falls through (not our bot)", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "/checkin@other_bot" }),
    });
    const result = evaluateRules(ctx);
    // Should NOT match as whitelisted_command since it's directed at another bot
    // Falls through to @others rule (contains @other_bot)
    expect(result).not.toBeNull();
    expect(result!.rule).not.toBe("whitelisted_command");
  });

  it("unknown slash command → IGNORE", () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: "/foobar" }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("unknown_command");
  });

  it("forwarded message → IGNORE", () => {
    const ctx = makeCtx({
      message: makeMsg({ isForwarded: true, forwardFrom: "SomeUser" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("forwarded");
  });

  it("hot chat (5min ≥ 20 msgs) → IGNORE", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const ctx = makeCtx({
      groupActivity: { messagesLast5Min: 25, messagesLast1Hour: 100 },
    });
    const result = evaluateRules(ctx);
    randomSpy.mockRestore();
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("hot_chat");
  });

  it("hot chat but @self → REPLY", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "xxb 你来说说" }),
      groupActivity: { messagesLast5Min: 25, messagesLast1Hour: 100 },
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("mention_self");
  });

  it("recent reply (within 5 messages) → IGNORE", () => {
    const ctx = makeCtx({ lastBotReplyIndex: 3 });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("recent_reply");
  });

  it("@others → IGNORE", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "hey @someone" }),
      lastBotReplyIndex: -1,
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("at_others");
  });

  it("normal message (no rule hit) → null", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "今天天气真好" }),
      lastBotReplyIndex: -1,
      groupActivity: { messagesLast5Min: 5, messagesLast1Hour: 30 },
    });
    const result = evaluateRules(ctx);
    expect(result).toBeNull();
  });

  it("L0 result always has level L0_RULE", () => {
    const ctx = makeCtx({ message: makeMsg({ isForwarded: true }) });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.level).toBe("L0_RULE");
  });
});
