import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../src/pipeline/tools/agent-tools.js', () => ({ executeQueryPersonProfile: vi.fn() }));
vi.mock('../../../../src/shared/abort.js', () => ({ isCallerAbort: vi.fn(() => false) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { runPersonaSpecialist } from '../../../../src/pipeline/multiagent/persona-specialist.js';
import { executeQueryPersonProfile } from '../../../../src/pipeline/tools/agent-tools.js';
import { isCallerAbort } from '../../../../src/shared/abort.js';

beforeEach(() => {
  vi.clearAllMocks();
  (isCallerAbort as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
});

describe('runPersonaSpecialist (单次直接 QUERY_PERSON_PROFILE)', () => {
  it('命中 → toolResultsBlock 带 [人设/关系] 前缀,用 senderName 查', async () => {
    (executeQueryPersonProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      '老张(@zhang, uid=123)\n性格: 爱吹牛\n你和TA: 上次帮他怼过卖灵车的',
    );
    const r = await runPersonaSpecialist({ messageText: 'q', context: '', chatId: -1, userId: 123, senderName: '老张' });
    expect(executeQueryPersonProfile).toHaveBeenCalledTimes(1);
    expect(executeQueryPersonProfile).toHaveBeenCalledWith(-1, '老张');
    expect(r.failed).toBe(false);
    expect(r.toolsUsed).toEqual(['QUERY_PERSON_PROFILE']);
    expect(r.toolResultsBlock).toContain('[人设/关系]');
    expect(r.toolResultsBlock).toContain('爱吹牛');
  });

  it('没找到人(返回"(本群没找到...")→ 不注入', async () => {
    (executeQueryPersonProfile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      '(本群没找到叫「某人」的人;成员名单里最近活跃的有:...)',
    );
    const r = await runPersonaSpecialist({ messageText: 'q', context: '', chatId: -1, userId: 1, senderName: '某人' });
    expect(r.failed).toBe(false);
    expect(r.toolResultsBlock).toBeUndefined();
  });

  it('空 senderName → 不调 executeQueryPersonProfile', async () => {
    const r = await runPersonaSpecialist({ messageText: 'q', context: '', chatId: -1, userId: 1, senderName: '' });
    expect(executeQueryPersonProfile).not.toHaveBeenCalled();
    expect(r.failed).toBe(false);
  });

  it('抛 + turn 打断 → 上抛', async () => {
    (executeQueryPersonProfile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('aborted'));
    (isCallerAbort as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await expect(runPersonaSpecialist({ messageText: 'q', context: '', chatId: -1, userId: 1, senderName: '老张' })).rejects.toThrow('aborted');
  });

  it('抛(非打断)→ fail-soft,failed=true', async () => {
    (executeQueryPersonProfile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const r = await runPersonaSpecialist({ messageText: 'q', context: '', chatId: -1, userId: 1, senderName: '老张' });
    expect(r.failed).toBe(true);
    expect(r.toolResultsBlock).toBeUndefined();
  });
});
