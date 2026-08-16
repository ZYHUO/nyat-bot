import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const callWithFallbackMock = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallbackMock(...args),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ DISTILL_USAGE: 'summarize' }),
}));

vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: () => 'distill system prompt',
}));

const { parseDistillOutput, distillEpisode } = await import('../../../src/agent/distiller.js');

const baseTask = {
  id: 'task-1',
  chatId: 6251541967,
  contentDirection: '写个贪吃蛇 HTML 给主人',
  createdAt: Date.now(),
  status: 'done' as const,
  totalTurns: 8,
  segment: 0,
};

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0054_episodes_experience.sql'), 'utf8'));
  callWithFallbackMock.mockReset();
});

describe('parseDistillOutput', () => {
  it('parses clean JSON', () => {
    const raw = JSON.stringify({
      summary: '写了 snake.html 并交付',
      lessons: ['写完要 sendFile'],
      tags: ['写代码'],
      experience: [{ kind: 'pitfall', content: '写完文件必须 sendFile', tags: ['交付'] }],
    });
    const r = parseDistillOutput(raw)!;
    expect(r.summary).toContain('snake.html');
    expect(r.lessons).toEqual(['写完要 sendFile']);
    expect(r.experience.length).toBe(1);
    expect(r.experience[0]!.kind).toBe('pitfall');
    expect(r.followUpGoal).toBeNull();
  });

  it('parses JSON wrapped in code fence and prose', () => {
    const raw = '好的，复盘如下：\n```json\n{"summary":"干了活","lessons":[],"tags":[],"experience":[]}\n```\n以上。';
    const r = parseDistillOutput(raw)!;
    expect(r.summary).toBe('干了活');
  });

  it('returns null on garbage', () => {
    expect(parseDistillOutput('')).toBeNull();
    expect(parseDistillOutput('我觉得吧这个任务挺有意思的')).toBeNull();
    expect(parseDistillOutput('{"lessons":[]}')).toBeNull(); // no summary
  });

  it('caps experience at 3 and drops invalid kinds/blank content', () => {
    const raw = JSON.stringify({
      summary: 's',
      experience: [
        { kind: 'pitfall', content: 'e1', tags: [] },
        { kind: 'weird', content: 'e2', tags: [] },
        { kind: 'trick', content: '   ', tags: [] },
        { kind: 'trick', content: 'e3', tags: [] },
        { kind: 'preference', content: 'e4', tags: [] },
        { kind: 'trick', content: 'e5-should-be-dropped', tags: [] },
      ],
    });
    const r = parseDistillOutput(raw)!;
    expect(r.experience.length).toBe(3);
    expect(r.experience.map((e) => e.kind)).toEqual(['pitfall', 'trick', 'trick']); // weird→trick, blank dropped
    expect(r.experience.some((e) => e.content.includes('e5'))).toBe(false);
  });

  it('parses follow_up_goal when present and sane', () => {
    const withGoal = parseDistillOutput(
      JSON.stringify({ summary: 's', follow_up_goal: '主人的 Sub2API 项目进展' }),
    )!;
    expect(withGoal.followUpGoal).toBe('主人的 Sub2API 项目进展');
    const tooShort = parseDistillOutput(JSON.stringify({ summary: 's', follow_up_goal: 'ab' }))!;
    expect(tooShort.followUpGoal).toBeNull();
  });
});

describe('distillEpisode', () => {
  it('writes episode + experience entries on success', async () => {
    callWithFallbackMock.mockResolvedValue({
      content: JSON.stringify({
        summary: '写了 snake.html，sendFile 交付成功',
        lessons: ['文件要交付'],
        tags: ['写代码', '文件交付'],
        experience: [
          { kind: 'pitfall', content: '写完文件必须 telegram.sendFile 交付', tags: ['交付', '文件'] },
          { kind: 'trick', content: '先 computer.run 验证再交付', tags: ['验证'] },
        ],
      }),
    });

    const r = await distillEpisode({ task: baseTask, outcome: 'done', progressSummary: 'seg summary', tailText: 'tail' });
    expect(r).not.toBeNull();

    const ep = db.prepare('SELECT * FROM episodes WHERE task_id = ?').get('task-1') as Record<string, unknown>;
    expect(ep['outcome']).toBe('done');
    expect(ep['chat_id']).toBe(6251541967);
    expect(ep['turns']).toBe(8);

    const entries = db.prepare('SELECT * FROM experience_entries').all() as Record<string, unknown>[];
    expect(entries.length).toBe(2);
    expect(entries[0]!['source_episode_id']).toBe(ep['id']);

    // LLM called with the cheap summarize chain
    expect(callWithFallbackMock).toHaveBeenCalledOnce();
    const callArg = callWithFallbackMock.mock.calls[0]![0] as { usage: string; maxTokens: number };
    expect(callArg.usage).toBe('summarize');
    expect(callArg.maxTokens).toBeLessThanOrEqual(1200);
  });

  it('returns null and writes nothing on unparseable LLM output', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '我也不知道怎么说' });
    const r = await distillEpisode({ task: baseTask, outcome: 'done', progressSummary: 's', tailText: 't' });
    expect(r).toBeNull();
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM episodes').get() as { c: number };
    expect(c).toBe(0);
  });

  it('returns null and does not throw when LLM call fails', async () => {
    callWithFallbackMock.mockRejectedValue(new Error('all providers down'));
    const r = await distillEpisode({ task: baseTask, outcome: 'failed', progressSummary: 's', tailText: 't' });
    expect(r).toBeNull();
  });

  it('empty experience array is fine — episode still saved', async () => {
    callWithFallbackMock.mockResolvedValue({
      content: JSON.stringify({ summary: '普通闲聊，没新经验', lessons: [], tags: ['聊天'], experience: [] }),
    });
    const r = await distillEpisode({ task: baseTask, outcome: 'done', progressSummary: 's', tailText: 't' });
    expect(r).not.toBeNull();
    expect(r!.experience).toEqual([]);
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM episodes').get() as { c: number };
    expect(c).toBe(1);
    const { c: ec } = db.prepare('SELECT COUNT(*) AS c FROM experience_entries').get() as { c: number };
    expect(ec).toBe(0);
  });
});
