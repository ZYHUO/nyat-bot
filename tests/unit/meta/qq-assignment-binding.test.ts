import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

const f = vi.hoisted(() => ({ enabled: true, active: vi.fn(), get: vi.fn(), bind: vi.fn(), recent: vi.fn() }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ QQ_ASSIGNMENTS_ENABLED: f.enabled }) }));
vi.mock('../../../src/platform/onebot-assignment-store.js', () => ({
  activeOneBotAssignment: f.active, getOneBotAssignment: f.get, bindOneBotAssignmentTask: f.bind,
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: f.recent }));
import { bindQQParticipationTask } from '../../../src/meta/qq-assignment-binding.js';

const chatId = -(2 ** 52 + 1), messageId = 2 ** 52 + 20;
const task = (overrides: Partial<DispatchTask> = {}): DispatchTask => ({ id: 'target-task', chatId,
  createdAt: Date.now(), status: 'queued', contentDirection: 'Target group context only', quoteMessageIds: [messageId], ...overrides });
beforeEach(() => {
  vi.clearAllMocks(); f.enabled = true;
  f.active.mockReturnValue({ id: 'grant', mode: 'participate', targetChatId: chatId, createdAt: Date.now() - 10_000 });
  f.get.mockImplementation(() => f.active());
  f.recent.mockResolvedValue([{ messageId, role: 'user', uid: 2 ** 52 + 9, timestamp: Math.floor(Date.now() / 1000) }]);
  f.bind.mockImplementation(() => undefined);
});

describe('host-selected QQ participation task binding', () => {
  it('uses only the target group context and binds a fresh host-selected message', async () => {
    const candidate = task();
    await bindQQParticipationTask(candidate, messageId);
    expect(f.recent).toHaveBeenCalledExactlyOnceWith(chatId, 80);
    expect(f.bind).toHaveBeenCalledExactlyOnceWith('grant', 'target-task', chatId);
    expect(candidate.qqAssignmentId).toBe('grant');
    expect(candidate.pendingUserInput).toBeUndefined();
  });

  it('does not turn background work or model-selected quotes into authorized participation', async () => {
    for (const candidate of [task({ executionMode: 'background' }), task({ chatId: 42 })]) {
      await bindQQParticipationTask(candidate, messageId);
      expect(candidate.qqAssignmentId).toBeUndefined();
    }
    await expect(bindQQParticipationTask(task())).rejects.toThrow('qq_assignment_source_mismatch');
    await expect(bindQQParticipationTask(task({ quoteMessageIds: [messageId + 1] }), messageId)).rejects.toThrow('qq_assignment_source_mismatch');
    expect(f.bind).not.toHaveBeenCalled();
  });

  it('does not bind a message predating the assignment, old input, bots, or absent source evidence', async () => {
    for (const messages of [[], [{ messageId, role: 'user', timestamp: Math.floor(Date.now() / 1000) - 11 }],
      [{ messageId, role: 'user', isBot: true, timestamp: Math.floor(Date.now() / 1000) }]]) {
      f.recent.mockResolvedValue(messages);
      await expect(bindQQParticipationTask(task(), messageId)).rejects.toThrow('qq_assignment_source_unverified');
    }
    f.active.mockReturnValue({ id: 'grant', mode: 'participate', targetChatId: chatId, createdAt: Date.now() - 900_000 });
    f.recent.mockResolvedValue([{ messageId, role: 'user', timestamp: Math.floor(Date.now() / 1000) - 301 }]);
    await expect(bindQQParticipationTask(task(), messageId)).rejects.toThrow('qq_assignment_source_unverified');
    expect(f.bind).not.toHaveBeenCalled();
  });

  it('revalidates the persisted grant after context reading and propagates a concurrent stop', async () => {
    f.bind.mockImplementation(() => { throw new Error('assignment_stopped'); });
    const candidate = task();
    await expect(bindQQParticipationTask(candidate, messageId)).rejects.toThrow('assignment_stopped');
    expect(candidate.qqAssignmentId).toBeUndefined();
  });

  it('leaves the ordinary path untouched when disabled or no active assignment exists', async () => {
    f.enabled = false; await bindQQParticipationTask(task(), messageId);
    expect(f.active).not.toHaveBeenCalled();
    f.enabled = true; f.active.mockReturnValue(null); await bindQQParticipationTask(task(), messageId);
    expect(f.recent).not.toHaveBeenCalled(); expect(f.bind).not.toHaveBeenCalled();
  });

  it('does not downgrade a Heart-originated grant after stop, expiry, or rollout disable', async () => {
    const old = f.active();
    f.active.mockReturnValue(null); f.get.mockReturnValue(old);
    f.enabled = false;
    f.bind.mockImplementation(() => { throw new Error('assignment_stopped'); });
    const candidate = task();
    await expect(bindQQParticipationTask(candidate, messageId, 'grant')).rejects.toThrow('assignment_stopped');
    expect(candidate.qqAssignmentId).toBeUndefined();
    f.get.mockReturnValue(null);
    await expect(bindQQParticipationTask(task(), messageId, 'grant')).rejects.toThrow('qq_assignment_provenance_missing');
  });

  it('passes only the explicitly approved public topic after binding', async () => {
    f.active.mockReturnValue({ ...f.active(), publicText: '合成公开主题' });
    const candidate = task();
    await bindQQParticipationTask(candidate, messageId);
    expect(candidate.contentDirection).toContain('合成公开主题');
  });
});
