import { describe, it, expect } from "vitest";
import { classifyAddressee } from "../../../src/pipeline/floor/addressee.js";
import type { FormattedMessage } from "../../../src/shared/types.js";

const BOT_UID = 9999;
const BOT_NAME = "xxb_bot";
const NICKS = ["xxb", "咪咪"];

let mid = 1000;
function makeMsg(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: "user",
    uid: 1001,
    username: "alice",
    fullName: "Alice",
    timestamp: Math.floor(Date.now() / 1000),
    messageId: ++mid,
    textContent: "hello",
    isForwarded: false,
    isBot: false,
    ...overrides,
  };
}

describe("classifyAddressee", () => {
  it("reply to bot → to_me", () => {
    const msg = makeMsg({
      replyTo: { messageId: 50, uid: BOT_UID, fullName: "XXB", textSnippet: "hi" },
    });
    expect(classifyAddressee(msg, [], BOT_UID, BOT_NAME, NICKS).verdict).toBe("to_me");
  });

  it("@bot → to_me", () => {
    const msg = makeMsg({ textContent: "hey @xxb_bot 你觉得呢" });
    expect(classifyAddressee(msg, [], BOT_UID, BOT_NAME, NICKS).verdict).toBe("to_me");
  });

  it("nickname call → to_me", () => {
    const msg = makeMsg({ textContent: "咪咪在吗" });
    expect(classifyAddressee(msg, [], BOT_UID, BOT_NAME, NICKS).verdict).toBe("to_me");
  });

  it("@other user → to_other", () => {
    const msg = makeMsg({ textContent: "@bob 你来说" });
    const r = classifyAddressee(msg, [], BOT_UID, BOT_NAME, NICKS);
    expect(r.verdict).toBe("to_other");
    expect(r.reason).toBe("at_others");
  });

  it("bot on floor + short follow-up → to_me", () => {
    const botMsg = makeMsg({
      role: "assistant",
      uid: BOT_UID,
      username: BOT_NAME,
      fullName: "XXB",
      textContent: "我觉得这电影还行",
    });
    const follow = makeMsg({ textContent: "为啥啊", uid: 1002, username: "bob", fullName: "Bob" });
    const r = classifyAddressee(follow, [botMsg], BOT_UID, BOT_NAME, NICKS);
    expect(r.verdict).toBe("to_me");
    expect(r.reason).toBe("floor_followup");
  });

  it("bot on floor but follow-up @others → to_other (floor stolen)", () => {
    const botMsg = makeMsg({
      role: "assistant",
      uid: BOT_UID,
      username: BOT_NAME,
      fullName: "XXB",
      textContent: "我觉得这电影还行",
    });
    const follow = makeMsg({ textContent: "@bob 你觉得呢" });
    expect(classifyAddressee(follow, [botMsg], BOT_UID, BOT_NAME, NICKS).verdict).toBe("to_other");
  });

  it("bot not on floor + ambient chat → ambient", () => {
    const a = makeMsg({ textContent: "今天天气不错" });
    const b = makeMsg({ textContent: "是啊挺好的", uid: 1002, username: "bob", fullName: "Bob" });
    const c = makeMsg({ textContent: "周末去哪玩" });
    expect(classifyAddressee(c, [a, b], BOT_UID, BOT_NAME, NICKS).verdict).toBe("ambient");
  });

  it("bot talked long ago (>3 msgs) → ambient not to_me", () => {
    const botMsg = makeMsg({
      role: "assistant",
      uid: BOT_UID,
      username: BOT_NAME,
      fullName: "XXB",
      textContent: "早",
      messageId: 1,
    });
    const filler = [2, 3, 4, 5].map((i) =>
      makeMsg({ textContent: `闲聊${i}`, uid: 1002 + i, username: `u${i}`, fullName: `U${i}` }),
    );
    const cur = makeMsg({ textContent: "继续聊" });
    expect(classifyAddressee(cur, [botMsg, ...filler], BOT_UID, BOT_NAME, NICKS).verdict).toBe("ambient");
  });

  it("A↔B duet (3+ alternating rounds, no bot) → not_me", () => {
    const seq: FormattedMessage[] = [];
    for (let i = 0; i < 6; i++) {
      seq.push(
        makeMsg({
          textContent: `duet${i}`,
          uid: i % 2 === 0 ? 1001 : 1002,
          username: i % 2 === 0 ? "alice" : "bob",
          fullName: i % 2 === 0 ? "Alice" : "Bob",
        }),
      );
    }
    const cur = makeMsg({ textContent: "duet6", uid: 1001, username: "alice", fullName: "Alice" });
    const r = classifyAddressee(cur, seq, BOT_UID, BOT_NAME, NICKS);
    expect(r.verdict).toBe("not_me");
    expect(r.reason).toBe("duet_no_interrupt");
  });

  it("duet broken by third human → ambient (not hard not_me)", () => {
    const seq: FormattedMessage[] = [];
    for (let i = 0; i < 4; i++) {
      seq.push(
        makeMsg({
          textContent: `duet${i}`,
          uid: i % 2 === 0 ? 1001 : 1002,
          username: i % 2 === 0 ? "alice" : "bob",
          fullName: i % 2 === 0 ? "Alice" : "Bob",
        }),
      );
    }
    seq.push(makeMsg({ textContent: "我插一句", uid: 1003, username: "carol", fullName: "Carol" }));
    const cur = makeMsg({ textContent: "啥事", uid: 1001, username: "alice", fullName: "Alice" });
    expect(classifyAddressee(cur, seq, BOT_UID, BOT_NAME, NICKS).verdict).toBe("ambient");
  });

  it("private chat (chatId>0) without explicit signal → to_me", () => {
    const msg = makeMsg({ textContent: "在吗" });
    expect(classifyAddressee(msg, [], BOT_UID, BOT_NAME, NICKS, 12345).verdict).toBe("to_me");
  });

  it("forwarded message → not_me", () => {
    const msg = makeMsg({ textContent: "转一个", isForwarded: true });
    const r = classifyAddressee(msg, [], BOT_UID, BOT_NAME, NICKS);
    expect(r.verdict).toBe("not_me");
    expect(r.reason).toBe("forwarded");
  });

  it("other bot message without targeting us → not_me", () => {
    const msg = makeMsg({ textContent: "bot 广播", isBot: true, uid: 2000 });
    expect(classifyAddressee(msg, [], BOT_UID, BOT_NAME, NICKS).verdict).toBe("not_me");
  });

  it("reply to other human → to_other", () => {
    const msg = makeMsg({
      textContent: "同意",
      replyTo: { messageId: 60, uid: 1002, fullName: "Bob", textSnippet: "我说得对吧" },
    });
    expect(classifyAddressee(msg, [], BOT_UID, BOT_NAME, NICKS).verdict).toBe("to_other");
  });

  it("bot question + human answer = floor follow-up → to_me", () => {
    const botQ = makeMsg({
      role: "assistant",
      uid: BOT_UID,
      username: BOT_NAME,
      fullName: "XXB",
      textContent: "你们周末一般去哪玩",
    });
    const ans = makeMsg({ textContent: "去爬山", uid: 1002, username: "bob", fullName: "Bob" });
    expect(classifyAddressee(ans, [botQ], BOT_UID, BOT_NAME, NICKS).verdict).toBe("to_me");
  });
});
