import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../src/pipeline/tools/recall.js', () => ({ executeRecall: vi.fn() }));
vi.mock('../../../../src/shared/abort.js', () => ({ isCallerAbort: vi.fn(() => false) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { runMemorySpecialist } from '../../../../src/pipeline/multiagent/memory-specialist.js';
import { executeRecall } from '../../../../src/pipeline/tools/recall.js';
import { isCallerAbort } from '../../../../src/shared/abort.js';

beforeEach(() => {
  vi.clearAllMocks();
  (isCallerAbort as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
});

describe('runMemorySpecialist (单次直接 RECALL)', () => {
  it('命中 → toolResultsBlock 带 [记忆员] 前缀,toolsUsed=[RECALL]', async () => {
    (executeRecall as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      '关于"老张"的回忆(共 2 条):\n- 2026-06-01 老张:吹牛赚了一万\n- 2026-06-02 老张:又被拆穿了',
    );
    const r = await runMemorySpecialist({ messageText: '老张最近怎样', context: '', chatId: -1, userId: 2 });
    expect(executeRecall).toHaveBeenCalledTimes(1);
    expect(executeRecall).toHaveBeenCalledWith(-1, '老张最近怎样', 8);
    expect(r.failed).toBe(false);
    expect(r.toolsUsed).toEqual(['RECALL']);
    expect(r.toolResultsBlock).toContain('[记忆员]');
    expect(r.toolResultsBlock).toContain('老张');
  });

  it('没命中(executeRecall 返回"没有回忆起...")→ 不注入(toolResultsBlock 空)', async () => {
    (executeRecall as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('没有回忆起与"xyz"相关的旧对话。');
    const r = await runMemorySpecialist({ messageText: 'xyz', context: '', chatId: -1, userId: 2 });
    expect(r.failed).toBe(false);
    expect(r.toolResultsBlock).toBeUndefined();
  });

  it('空 query → 不调 executeRecall', async () => {
    const r = await runMemorySpecialist({ messageText: '   ', context: '', chatId: -1, userId: 2 });
    expect(executeRecall).not.toHaveBeenCalled();
    expect(r.failed).toBe(false);
  });

  it('executeRecall 抛 + turn 打断 → 上抛(不吞)', async () => {
    (executeRecall as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('aborted'));
    (isCallerAbort as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await expect(runMemorySpecialist({ messageText: 'q', context: '', chatId: -1, userId: 2 })).rejects.toThrow('aborted');
  });

  it('executeRecall 抛(非打断)→ fail-soft,failed=true,无 block', async () => {
    (executeRecall as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const r = await runMemorySpecialist({ messageText: 'q', context: '', chatId: -1, userId: 2 });
    expect(r.failed).toBe(true);
    expect(r.toolResultsBlock).toBeUndefined();
  });
});
