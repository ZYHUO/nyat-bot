import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

let testDb: InstanceType<typeof Database>;
vi.mock("../../../../src/db/sqlite.js", () => ({ getDb: () => testDb }));

const { retrieveOwnHistory, formatOwnHistoryBlock } = await import(
  "../../../../src/pipeline/context/retriever.js"
);

const CHAT = -100123;

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE self_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      trigger_uid INTEGER NOT NULL,
      trigger_msg_id INTEGER,
      reply_text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO self_replies (chat_id, trigger_uid, trigger_msg_id, reply_text, ts) VALUES (?,?,?,?,?)").run(
    CHAT, 1, 1, "我不喜欢榴莲，闻着就受不了", now - 3600,
  );
  db.prepare("INSERT INTO self_replies (chat_id, trigger_uid, trigger_msg_id, reply_text, ts) VALUES (?,?,?,?,?)").run(
    CHAT, 1, 2, "今天天气不错，适合出去走走", now - 7200,
  );
  // 别的群的发言(不应被本群检索召回)
  db.prepare("INSERT INTO self_replies (chat_id, trigger_uid, trigger_msg_id, reply_text, ts) VALUES (?,?,?,?,?)").run(
    -999, 1, 3, "榴莲其实也还行", now - 3600,
  );
  // 很旧的发言(超过 withinDays,不应召回)
  db.prepare("INSERT INTO self_replies (chat_id, trigger_uid, trigger_msg_id, reply_text, ts) VALUES (?,?,?,?,?)").run(
    CHAT, 1, 4, "榴莲再难吃也要吃", now - 40 * 86400,
  );
  return db;
}

describe("retrieveOwnHistory", () => {
  beforeEach(() => {
    testDb = makeDb();
  });

  it("returns topic-relevant self replies from the same chat", async () => {
    const hits = await retrieveOwnHistory(CHAT, "榴莲 好吃吗", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("榴莲");
  });

  it("ignores other chats and stale rows", async () => {
    const hits = await retrieveOwnHistory(CHAT, "榴莲", 10);
    for (const h of hits) {
      expect(h.text).not.toContain("其实也还行"); // 别的群
      expect(h.text).not.toContain("再难吃"); // 过期(>30天)
    }
  });

  it("returns [] for empty query", async () => {
    expect(await retrieveOwnHistory(CHAT, "", 3)).toEqual([]);
    expect(await retrieveOwnHistory(CHAT, "   ", 3)).toEqual([]);
  });

  it("returns [] when nothing matches", async () => {
    expect(await retrieveOwnHistory(CHAT, "量子力学", 3)).toEqual([]);
  });
});

describe("formatOwnHistoryBlock", () => {
  it("returns empty string for empty list", () => {
    expect(formatOwnHistoryBlock([])).toBe("");
  });

  it("formats entries with date stamps", () => {
    const block = formatOwnHistoryBlock([{ text: "我不喜欢榴莲", ts: Math.floor(Date.now() / 1000) }]);
    expect(block).toContain("【你自己之前说过的相关的话】");
    expect(block).toContain("我不喜欢榴莲");
    expect(block).toContain("保持一致");
  });
});
