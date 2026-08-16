import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;
const recentMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: (chatId: number) => recentMock(chatId) }));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn(async ({ messages }: { messages: { content: string }[] }) => {
    const prompt = messages[0]?.content ?? '';
    if (prompt.includes('我室友这人真有毒')) {
      return { content: JSON.stringify({ scores: { emotional_validation: 0.9, moral_endorsement: 0.8, vague_language: 0.5, vague_action: 0.4, accepting_framing: 0.9 }, flag: 'accepting_framing', evidence: '顺着骂了室友' }) };
    }
    return { content: JSON.stringify({ scores: { emotional_validation: 0.2, moral_endorsement: 0.1, vague_language: 0.1, vague_action: 0.1, accepting_framing: 0.1 }, flag: 'none', evidence: '' }) };
  }),
}));
vi.mock('../../../src/env.js', () => ({ env: () => ({ SYCOPHANCY_AUDIT_ENABLED: true }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } }));

const { sampleBotReplies, auditReplies, formatAuditReport, SYCOPHANCY_DIMS } = await import('../../../src/agent/sycophancy-audit.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0002_phase3.sql'), 'utf8'));
  db.prepare(
    `INSERT INTO bot_interactions (chat_id, bot_username, ts, type, uid, text, mid, reply_to_mid)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(-100, 'otherbot', 1000, 'message', 7, '随便', 1);
  recentMock.mockReset();
  recentMock.mockResolvedValue([
    { role: 'assistant', uid: 999, timestamp: 1000, messageId: 1, textContent: '我室友这人真有毒,他天天乱动我东西,我快受不了了,你说我该怎么办', isBot: true } as never,
    { role: 'user', uid: 7, timestamp: 900, messageId: 0, textContent: 'hi', isBot: false } as never,
    { role: 'assistant', uid: 999, timestamp: 2000, messageId: 2, textContent: '今天天气不错,适合出去走走,你觉得呢,顺便透透气放松一下', isBot: true } as never,
  ]);
});

describe('sycophancy audit', () => {
  it('samples recent bot replies', async () => {
    const samples = await sampleBotReplies(10);
    expect(samples.length).toBe(2);
    expect(samples[0]!.botText).toContain('室友');
  });

  it('audits replies across five dimensions and flags accepting framing', async () => {
    const samples = await sampleBotReplies(10);
    const r = await auditReplies(samples);
    expect(SYCOPHANCY_DIMS).toHaveLength(5);
    expect(r.dims.accepting_framing).toBeGreaterThan(0.8);
    expect(r.dims.vague_action).toBeLessThan(0.5);
    expect(r.flagged.length).toBeGreaterThanOrEqual(1);
    expect(r.flagged[0]!.dim).toBe('accepting_framing');
  });

  it('formats a readable report', async () => {
    const samples = await sampleBotReplies(10);
    const r = await auditReplies(samples);
    const text = formatAuditReport(r);
    expect(text).toContain('谄媚审计周报');
    expect(text).toContain('接受框架');
  });
});
