import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const envMock = vi.fn();

vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/db/redis.js', () => ({
  getRedis: vi.fn(() => ({})),
}));
vi.mock('../../../../src/env.js', () => ({ env: () => envMock() }));
vi.mock('../../../../src/bot/sender/telegram.js', () => ({ sendMessage: vi.fn(async () => 1) }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('bullmq', () => {
  class Queue {
    constructor(name: string, opts: unknown) {}
    async add(name: string, data: unknown) { return { id: 'mock-job' }; }
  }
  return { Queue };
});

const { parseResearchRequest, tryCreateResearchTask } = await import('../../../../src/pipeline/judge/task-trigger.js');
const { getTask, listActiveTasks } = await import('../../../../src/agent/task-store.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../../migrations/0065_tasks.sql'), 'utf8'));
  envMock.mockReturnValue({ TASK_EXECUTOR_ENABLED: true });
});

describe('parseResearchRequest', () => {
  it('extracts goal from 帮我查 X', () => {
    expect(parseResearchRequest('@bot 帮我查一下 Rust 异步最佳实践')).toBe('Rust 异步最佳实践');
  });

  it('extracts from 搜一下', () => {
    expect(parseResearchRequest('@bot 搜一下 2026 年 AI 会议')).toBe('2026 年 AI 会议');
  });

  it('rejects non-research chatter', () => {
    expect(parseResearchRequest('@bot 你好呀')).toBeNull();
    expect(parseResearchRequest('@bot 晚上好')).toBeNull();
  });

  it('rejects empty target', () => {
    expect(parseResearchRequest('@bot 帮我查一下')).toBeNull();
  });

  it('strips @bot and punctuation', () => {
    expect(parseResearchRequest('@bot,帮我找找 Whisper 中文模型')).toBe('Whisper 中文模型');
  });

  it('rejects 帮我查一下,不过先别急 (tail clause, regression major #3)', () => {
    expect(parseResearchRequest('@bot 帮我查一下,不过先别急')).toBeNull();
  });

  it('rejects 你看看这个 (casual 看 is not research, regression major #3)', () => {
    expect(parseResearchRequest('@bot 你看看这个')).toBeNull();
  });

  it('rejects pronouns/demonstratives at target start', () => {
    expect(parseResearchRequest('@bot 帮我看看这是什么')).toBeNull();
    expect(parseResearchRequest('@bot 帮我查一下那个')).toBeNull();
  });

  it('rejects direct questions ending with 吗/?', () => {
    expect(parseResearchRequest('@bot 帮我查一下 Qwen 最新版本吗')).toBeNull();
    expect(parseResearchRequest('@bot 帮我查一下这个?')).toBeNull();
  });

  it('still accepts 帮我查一下 Rust 异步最佳实践 with 一下', () => {
    expect(parseResearchRequest('@bot 帮我查一下 Rust 异步最佳实践')).toBe('Rust 异步最佳实践');
  });
});

describe('tryCreateResearchTask', () => {
  it('creates task + queues when mentioned and research-like', async () => {
    const taken = await tryCreateResearchTask(-100, 42, '@bot 帮我查一下 Qwen 最新版本', true);
    expect(taken).toBe(true);
    const tasks = listActiveTasks(42, -100);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.goal).toBe('Qwen 最新版本');
  });

  it('does NOT create task without mention (security rule)', async () => {
    const taken = await tryCreateResearchTask(-100, 42, '帮我查一下 Qwen 最新版本', false);
    expect(taken).toBe(false);
    expect(listActiveTasks(42, -100)).toHaveLength(0);
  });

  it('does NOT create task when flag disabled', async () => {
    envMock.mockReturnValue({ TASK_EXECUTOR_ENABLED: false });
    const taken = await tryCreateResearchTask(-100, 42, '@bot 帮我查一下 Qwen', true);
    expect(taken).toBe(false);
    expect(listActiveTasks(42, -100)).toHaveLength(0);
  });

  it('does NOT create task for non-research mention', async () => {
    const taken = await tryCreateResearchTask(-100, 42, '@bot 今天天气怎么样', true);
    expect(taken).toBe(false);
    expect(listActiveTasks(42, -100)).toHaveLength(0);
  });
});
