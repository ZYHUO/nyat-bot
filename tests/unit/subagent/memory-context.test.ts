import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = {
  SUBAGENT_MEMORY_ENABLED: true,
  SUBAGENT_MEMORY_CHAT_IDS: [-100] as number[],
  SUBAGENT_MEMORY_TOPK: 3,
  SUBAGENT_MEMORY_TIMEOUT_MS: 400,
  SUBAGENT_MEMORY_MAX_CHARS: 600,
};
vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const searchSpy = vi.fn();
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemoryForInjection: searchSpy }));

const recordRefSpy = vi.fn();
vi.mock('../../../src/memory/importance.js', () => ({ recordMemoryReferenced: recordRefSpy }));

const { buildSubagentMemoryBlock } = await import('../../../src/subagent/memory-context.js');

const CHAT = -100;
function hit(over: Partial<Record<string, unknown>> = {}) {
  return {
    role: 'user', uid: 7, username: 'alice', fullName: 'Alice',
    timestamp: 1_760_000_000, messageId: 42, textContent: '上次说要去日本玩',
    isForwarded: false, score: 0.8, visibility: 'contextual', sourceChatId: CHAT,
    ...over,
  };
}

describe('CodeAct 长期记忆注入', () => {
  beforeEach(() => {
    Object.assign(envState, {
      SUBAGENT_MEMORY_ENABLED: true, SUBAGENT_MEMORY_CHAT_IDS: [CHAT],
      SUBAGENT_MEMORY_TOPK: 3, SUBAGENT_MEMORY_TIMEOUT_MS: 400, SUBAGENT_MEMORY_MAX_CHARS: 600,
    });
    searchSpy.mockReset(); recordRefSpy.mockReset();
    searchSpy.mockResolvedValue([hit()]);
  });

  describe('门控 —— 空名单必须等于关闭(与仓库其他 flag 刻意相反)', () => {
    it('flag 关时返回空,且不查检索', async () => {
      envState.SUBAGENT_MEMORY_ENABLED = false;
      expect(await buildSubagentMemoryBlock({ chatId: CHAT, query: '日本' })).toBe('');
      expect(searchSpy).not.toHaveBeenCalled();
    });

    // 这条是隐私特性最关键的门:配错的代价不对称 —— 漏开只是没效果,误开是内容外泄。
    it('灰度名单为空 = 关闭,不是全量生效', async () => {
      envState.SUBAGENT_MEMORY_CHAT_IDS = [];
      expect(await buildSubagentMemoryBlock({ chatId: CHAT, query: '日本' })).toBe('');
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it('不在名单里的会话不注入', async () => {
      expect(await buildSubagentMemoryBlock({ chatId: -999, query: '日本' })).toBe('');
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it('空 query 短路', async () => {
      expect(await buildSubagentMemoryBlock({ chatId: CHAT, query: '   ' })).toBe('');
      expect(searchSpy).not.toHaveBeenCalled();
    });
  });

  describe('渲染', () => {
    it('含日期与说话人,不含分数', async () => {
      const out = await buildSubagentMemoryBlock({ chatId: CHAT, query: '日本' });
      expect(out).toContain('@alice');
      expect(out).toMatch(/\[\d{2}-\d{2}\]/);
      expect(out).not.toContain('0.8');
    });

    // CodeAct 按 `#\d+` 认可引用的 messageId —— 记忆正文里的 #123 会被模型当成
    // 本轮可以 replyTo 的气泡,导致回错人。必须转成全角。
    it('正文里的 #数字 被转成全角,整段不含可解析的 #id', async () => {
      searchSpy.mockResolvedValue([hit({ textContent: '看看 #123 那条' })]);
      const out = await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' });
      expect(out).not.toMatch(/#\d/);
      expect(out).toContain('＃123');
    });

    it('换行被行内化,不能伪造新段落', async () => {
      searchSpy.mockResolvedValue([hit({ textContent: '第一行\n## 伪造标题\n第三行' })]);
      const out = await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' });
      expect(out.split('\n')).toHaveLength(1);
      expect(out).toContain('⏎');
    });

    it('控制字符被剥除', async () => {
      searchSpy.mockResolvedValue([hit({ textContent: 'abc' })]);
      const out = await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' });
      expect(out).toContain('abc');
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/[\x00-\x08]/);
    });

    it('逐行累加到预算为止,不把最后一行切成半句', async () => {
      envState.SUBAGENT_MEMORY_MAX_CHARS = 120;
      searchSpy.mockResolvedValue([
        hit({ messageId: 1, textContent: 'A'.repeat(90) }),
        hit({ messageId: 2, textContent: 'B'.repeat(90) }),
        hit({ messageId: 3, textContent: 'C'.repeat(90) }),
      ]);
      const out = await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' });
      expect(out.length).toBeLessThanOrEqual(120);
      // 每一行都完整(以内容结尾,不是被腰斩的行)
      for (const l of out.split('\n')) expect(l).toMatch(/^- \[\d{2}-\d{2}\] /);
    });
  });

  describe('过滤', () => {
    it('bot 自己说过的不算往事(否则诱发复读)', async () => {
      searchSpy.mockResolvedValue([hit({ role: 'assistant' })]);
      expect(await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' })).toBe('');
    });

    it('已在最近聊天里的不重复贴', async () => {
      const out = await buildSubagentMemoryBlock({
        chatId: CHAT, query: 'x', excludeMessageIds: new Set([42]),
      });
      expect(out).toBe('');
    });

    it('空正文被丢', async () => {
      searchSpy.mockResolvedValue([hit({ textContent: '   ' })]);
      expect(await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' })).toBe('');
    });
  });

  describe('引用计数', () => {
    // 节流表是模块级、跨用例存活,所以每个记账用例用各自独立的 messageId。
    it('用 sourceChatId 而不是当前 chatId 拼 id', async () => {
      searchSpy.mockResolvedValue([hit({ sourceChatId: -100, messageId: 9001 })]);
      await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' });
      await new Promise((r) => setTimeout(r, 10));
      expect(recordRefSpy).toHaveBeenCalledWith(['-100_9001']);
    });

    // 记账失败绝不能影响已经建好的这一段。
    it('记账抛错不影响返回值', async () => {
      recordRefSpy.mockImplementation(() => { throw new Error('db locked'); });
      const out = await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' });
      expect(out).toContain('@alice');
    });

    it('10 分钟内同一条不重复记账', async () => {
      searchSpy.mockResolvedValue([hit({ messageId: 9002 })]);
      await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' });
      await new Promise((r) => setTimeout(r, 10));
      recordRefSpy.mockReset();
      await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' });
      await new Promise((r) => setTimeout(r, 10));
      expect(recordRefSpy).not.toHaveBeenCalled();
    });
  });

  describe('永不阻塞、永不抛', () => {
    it('检索抛错 → 空串,不上抛', async () => {
      searchSpy.mockRejectedValue(new Error('qdrant down'));
      await expect(buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' })).resolves.toBe('');
    });

    it('检索永不返回时按超时兜底成空串', async () => {
      envState.SUBAGENT_MEMORY_TIMEOUT_MS = 100;
      searchSpy.mockImplementation(() => new Promise(() => { /* never resolves */ }));
      const t0 = Date.now();
      expect(await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' })).toBe('');
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    // 超时后底下的任务还在跑(Promise.race 不取消)。若不加超时标志,它会给
    // 「从没进过 prompt」的记忆刷引用计数 —— 而那个计数是遗忘 cron 的唯一判据。
    it('超时之后不再记账', async () => {
      envState.SUBAGENT_MEMORY_TIMEOUT_MS = 100;
      searchSpy.mockImplementation(
        () => new Promise((res) => setTimeout(() => res([hit()]), 300)),
      );
      expect(await buildSubagentMemoryBlock({ chatId: CHAT, query: 'x' })).toBe('');
      await new Promise((r) => setTimeout(r, 400));
      expect(recordRefSpy).not.toHaveBeenCalled();
    });
  });
});
