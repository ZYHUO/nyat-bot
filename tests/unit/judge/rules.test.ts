import { describe, it, expect, vi } from "vitest";
import { evaluateRules, isActiveConv } from "../../../src/pipeline/judge/rules.js";
import type { RuleContext } from "../../../src/pipeline/judge/rules.js";
import type { FormattedMessage } from "../../../src/shared/types.js";

vi.mock("../../../src/env.js", () => {
  const envValues: Record<string, unknown> = {
    JUDGE_PROACTIVE_ENABLED: false,
    JUDGE_PROACTIVE_RATE: 0.05,
    JUDGE_PROACTIVE_MIN_INTERVAL_SEC: 600,
    JUDGE_PROACTIVE_MIN_RECENT_MSGS: 3,
  };
  return { env: () => envValues, _testEnvValues: envValues };
});

const { _testEnvValues: envValues } = await import("../../../src/env.js") as unknown as { _testEnvValues: Record<string, unknown> };

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

  it("reply to self with a URL → REPLY (LLM decides lookup in reply layer)", () => {
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
    expect(result!.rule).toBe("reply_to_self");
  });

  it("mention self with explicit lookup wording and domain → REPLY (LLM decides lookup)", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "@xxb_bot 看一下这个 nodeseek.com" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("mention_self");
  });

  it("reply to self with realtime weather request → REPLY (LLM decides lookup)", () => {
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
    expect(result!.rule).toBe("reply_to_self");
  });

  it("reply to self with explicit stock request → REPLY (LLM decides lookup)", () => {
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
    expect(result!.rule).toBe("reply_to_self");
  });

  it("reply to self with follow-up stock request → REPLY (LLM decides lookup)", () => {
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
    expect(result!.rule).toBe("reply_to_self");
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
    // mute 关键词已不在 L0 路由 → 落到 reply_to_self,由 directive.ts(回复前 LLM)接管。
    expect(result!.rule).toBe("reply_to_self");
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

  it("mention self with exact mute phrase → mention_self (directive layer handles mute)", () => {
    const ctx = makeCtx({
      chatId: -100123,
      message: makeMsg({ textContent: "啾咪囝 闭嘴" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    // mute 关键词已不在 L0 路由 → mention_self,由 directive.ts(回复前 LLM)接管。
    expect(result!.rule).toBe("mention_self");
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

  it("mention self with shorthand realtime weather request → REPLY (LLM decides lookup)", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "xxb 今天莫斯科天气" }),
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("REPLY");
    expect(result!.rule).toBe("mention_self");
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

  it("hot chat (5min ≥ 25 msgs) → fallthrough to Heart LLM", () => {
    // 纯 LLM 驱动：热群不再概率跳过，交给 Heart LLM 判断该不该插话。
    const ctx = makeCtx({
      groupActivity: { messagesLast5Min: 25, messagesLast1Hour: 100 },
    });
    expect(evaluateRules(ctx)).toBeNull();
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

  it("low-content follow-up (single char) within 2 messages → IGNORE recent_reply", () => {
    const ctx = makeCtx({ message: makeMsg({ textContent: "." }), lastBotReplyIndex: 1 });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("recent_reply");
  });

  it("answer to the bot's own question (no @/reply) → recent_reply cooldown (Heart LLM decides)", () => {
    // 纯 LLM 驱动：bot 刚说过话，自然跟进交给 Heart LLM 判断（不再正则猜问题）。
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "今天怎么这么早叫啾咪呀～" });
    const ctx = makeCtx({
      message: makeMsg({ textContent: "叫你起床呀" }),
      recentMessages: [botMsg],
      lastBotReplyIndex: 0,
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("recent_reply");
  });

  it("user's OWN question right after the bot (e.g. 几点了) → recent_reply cooldown (Heart LLM decides)", () => {
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "主人又叫本喵干嘛喵～" });
    const ctx = makeCtx({
      message: makeMsg({ textContent: "几点了" }),
      recentMessages: [botMsg],
      lastBotReplyIndex: 0,
    });
    const result = evaluateRules(ctx);
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("recent_reply");
  });

  it("statement after the bot's colloquial question (干嘛) → recent_reply cooldown (Heart LLM decides)", () => {
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "主人又叫本喵干嘛喵～" });
    const ctx = makeCtx({
      message: makeMsg({ textContent: "笨猫" }),
      recentMessages: [botMsg],
      lastBotReplyIndex: 0,
    });
    const result = evaluateRules(ctx);
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("recent_reply");
  });

  it("immediate follow-up that @s someone else → still IGNORE", () => {
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "在吗？" });
    const ctx = makeCtx({
      message: makeMsg({ textContent: "@someone 你看这个" }),
      recentMessages: [botMsg],
      lastBotReplyIndex: 0,
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
  });

  it("index-1 plain continuation in a calm thread → recent_reply cooldown (Heart LLM decides)", () => {
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "本喵也想吃火锅" });
    const human = makeMsg({ uid: 1002, textContent: "我也是" });
    const ctx = makeCtx({
      message: makeMsg({ textContent: "那一起去呀" }), // non-question statement
      recentMessages: [botMsg, human],
      lastBotReplyIndex: 1,
      groupActivity: { messagesLast5Min: 6, messagesLast1Hour: 40 }, // calm
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
    expect(result!.rule).toBe("recent_reply");
  });

  it("statement right after a bot STATEMENT → recent_reply cooldown (Heart LLM decides)", () => {
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "本喵去睡觉啦" });
    const ctx = makeCtx({
      message: makeMsg({ textContent: "好梦呀" }), // statement, neither side asks
      recentMessages: [botMsg],
      lastBotReplyIndex: 0,
      groupActivity: { messagesLast5Min: 6, messagesLast1Hour: 40 },
    });
    const r = evaluateRules(ctx);
    expect(r).not.toBeNull();
    expect(r!.action).toBe("IGNORE");
    expect(r!.rule).toBe("recent_reply");
  });

  it("statement right after a bot STATEMENT (same as engaged — no RNG anymore) → recent_reply", () => {
    // 纯 LLM 驱动：engage 概率已删除，行为确定——recent_reply 冷却。
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "本喵去睡觉啦" });
    const ctx = makeCtx({
      message: makeMsg({ textContent: "好梦呀" }),
      recentMessages: [botMsg],
      lastBotReplyIndex: 0,
      groupActivity: { messagesLast5Min: 6, messagesLast1Hour: 40 },
    });
    const r = evaluateRules(ctx);
    expect(r).not.toBeNull();
    expect(r!.action).toBe("IGNORE");
    expect(r!.rule).toBe("recent_reply");
  });

  it("isActiveConv: live only when the bot is among the last few msgs in a calm thread", () => {
    expect(isActiveConv(0, 10)).toBe(true);   // bot just spoke, calm
    expect(isActiveConv(3, 10)).toBe(true);   // within MAX_INDEX (tolerates an interjection)
    expect(isActiveConv(4, 10)).toBe(false);  // too far back (>= MAX_INDEX)
    expect(isActiveConv(0, 25)).toBe(false);  // hot (>= ceiling)
    expect(isActiveConv(-1, 5)).toBe(false);  // bot never spoke
  });

  it("user's question after someone else interjected (bot still in last few msgs) → recent_reply cooldown", () => {
    // bot spoke, another user interjected, then the user asks the bot a question.
    // 纯 LLM 驱动：正则问题检测已删，index 1 < 2 → recent_reply 冷却，Heart LLM 决定。
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "九点十九啦主人～" });
    const other = makeMsg({ uid: 2002, fullName: "千雪", textContent: "又收到一只啾咪啦" });
    const ctx = makeCtx({
      message: makeMsg({ uid: 1001, textContent: "是不是要起床啦" }), // 是不是 → question
      recentMessages: [botMsg, other],
      lastBotReplyIndex: 1, // bot is 2nd-to-last
      groupActivity: { messagesLast5Min: 8, messagesLast1Hour: 50 },
    });
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

  it("mentioning another @user right after bot should still IGNORE", () => {
    const botMsg = makeMsg({ uid: 9999, role: "assistant", textContent: "在吗？" });
    const ctx = makeCtx({
      message: makeMsg({ textContent: "@alice 你怎么看" }),
      recentMessages: [botMsg],
      lastBotReplyIndex: 0,
    });
    const result = evaluateRules(ctx);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("IGNORE");
  });

  it("ASCII nickname only matches as standalone token", () => {
    const ctx = makeCtx({
      message: makeMsg({ textContent: "@xxb123 你怎么看" }),
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

describe("L0 Rules — Proactive Engagement (Stage B)", () => {
  function hotCtx(overrides: Partial<RuleContext> = {}): RuleContext {
    return makeCtx({
      message: makeMsg({ textContent: "大家在聊什么" }),
      groupActivity: { messagesLast5Min: 30, messagesLast1Hour: 100 },
      lastBotReplyIndex: -1,
      lastBotReplyAt: undefined,
      recentHumanMsgCount: 5,
      ...overrides,
    });
  }

  it("hot chat always falls through to Heart LLM (no probability skip, no proactive RNG)", () => {
    // 纯 LLM 驱动 (2026-08-06)：hot_chat 概率跳过和 JUDGE_PROACTIVE 随机全部删除。
    // 热群消息统一 fallthrough，由 Heart LLM 决定该不该插话。
    envValues['JUDGE_PROACTIVE_ENABLED'] = false;
    expect(evaluateRules(hotCtx())).toBeNull();

    envValues['JUDGE_PROACTIVE_ENABLED'] = true;
    expect(evaluateRules(hotCtx({
      lastBotReplyAt: Date.now() - 60_000,
    }))).toBeNull();
    expect(evaluateRules(hotCtx({
      lastBotReplyAt: Date.now() - 700_000,
    }))).toBeNull();
    expect(evaluateRules(hotCtx({
      lastBotReplyAt: Date.now() - 700_000,
      recentHumanMsgCount: 2,
    }))).toBeNull();
  });
});

// looksLikeForgetRequest 已下线 —— 记住/忘掉改由 directive.ts(回复前 LLM 指令分类)
// 结合上下文听懂,不再用关键词 regex。相关误判(「忘掉你没脑子」等)由 LLM 语义判断规避。
