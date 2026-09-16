import { describe, it, expect, vi } from 'vitest';

const { runGuard, runGuardPipeline } = await import('../../../../src/pipeline/reply/guards.js');

const isBlank = (t: string) => !t.trim() || t.trim() === '…';

function draft(text: string): { replyContent: string } {
  return { replyContent: text };
}

describe('runGuard', () => {
  it('pass-through when check returns null', async () => {
    const regenerate = vi.fn();
    const out = await runGuard(
      { name: 'g', check: async () => null, maxRetries: 1, temperature: 1, hintMode: 'none' },
      [draft('好回复')],
      { chatId: 1, regenerate, isBlank },
    );
    expect(out[0]!.replyContent).toBe('好回复');
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('hit → regen accepted when clean', async () => {
    const check = vi.fn()
      .mockResolvedValueOnce({ detail: 'dup' })
      .mockResolvedValueOnce(null);
    const regenerate = vi.fn().mockResolvedValue([draft('新说法')]);
    const out = await runGuard(
      { name: 'dup', check, maxRetries: 1, temperature: 1, hintMode: 'none' },
      [draft('复读的话')],
      { chatId: 1, regenerate, isBlank },
    );
    expect(out[0]!.replyContent).toBe('新说法');
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it('blank regen never replaces a good original (silence guard)', async () => {
    const check = vi.fn().mockResolvedValue({ detail: 'dup' });
    const regenerate = vi.fn().mockResolvedValue([draft('…')]);
    const out = await runGuard(
      { name: 'dup', check, maxRetries: 2, temperature: 1, hintMode: 'none' },
      [draft('虽然复读但还行')],
      { chatId: 1, regenerate, isBlank },
    );
    expect(out[0]!.replyContent).toBe('虽然复读但还行');
  });

  it('retries exhausted → keeps original', async () => {
    const check = vi.fn().mockResolvedValue({ detail: 'still dup' });
    const regenerate = vi.fn().mockResolvedValue([draft('还是复读')]);
    const out = await runGuard(
      { name: 'dup', check, maxRetries: 2, temperature: 1, hintMode: 'none' },
      [draft('原版')],
      { chatId: 1, regenerate, isBlank },
    );
    expect(out[0]!.replyContent).toBe('原版');
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  it('check throwing = skip guard, keep drafts', async () => {
    const check = vi.fn().mockRejectedValue(new Error('redis down'));
    const out = await runGuard(
      { name: 'fragile', check, maxRetries: 1, temperature: 1, hintMode: 'none' },
      [draft('正常')],
      { chatId: 1, regenerate: vi.fn(), isBlank },
    );
    expect(out[0]!.replyContent).toBe('正常');
  });

  it('constraint hint includes collided text for near-dup mode', async () => {
    const check = vi.fn()
      .mockResolvedValueOnce({ detail: 'near', collidedWith: '臭猫昨天说的话' })
      .mockResolvedValueOnce(null);
    const regenerate = vi.fn().mockResolvedValue([draft('换个角度')]);
    await runGuard(
      { name: 'near-dup', check, maxRetries: 1, temperature: 1, hintMode: 'constraint' },
      [draft('复读')],
      { chatId: 1, regenerate, isBlank },
    );
    const arg = regenerate.mock.calls[0]![0] as { constraintHint?: string };
    expect(arg.constraintHint).toContain('臭猫昨天说的话');
    expect(arg.constraintHint).toContain('禁止复读自己');
  });

  it('regen throwing keeps original', async () => {
    const check = vi.fn().mockResolvedValue({ detail: 'x' });
    const regenerate = vi.fn().mockRejectedValue(new Error('provider down'));
    const out = await runGuard(
      { name: 'g', check, maxRetries: 1, temperature: 1, hintMode: 'none' },
      [draft('原版留着')],
      { chatId: 1, regenerate, isBlank },
    );
    expect(out[0]!.replyContent).toBe('原版留着');
  });

  it('custom acceptRegen predicate is honored', async () => {
    const check = vi.fn().mockResolvedValue({ detail: 'hit' });
    const regenerate = vi.fn().mockResolvedValue([draft('重写的')]);
    const out = await runGuard(
      {
        name: 'custom',
        check,
        maxRetries: 1,
        temperature: 1,
        hintMode: 'none',
        acceptRegen: async (_c, r) => r[0]!.replyContent.length > 10,
      },
      [draft('原版')],
      { chatId: 1, regenerate, isBlank },
    );
    // regen '重写的' length 4 < 10 → not accepted → original kept
    expect(out[0]!.replyContent).toBe('原版');
  });
});

describe('runGuardPipeline', () => {
  it('runs guards in order, feeding output to next', async () => {
    const order: string[] = [];
    const g1 = {
      name: 'first',
      check: vi.fn(async () => { order.push('first'); return null; }),
      maxRetries: 0, temperature: 1, hintMode: 'none' as const,
    };
    const g2 = {
      name: 'second',
      check: vi.fn(async () => { order.push('second'); return null; }),
      maxRetries: 0, temperature: 1, hintMode: 'none' as const,
    };
    await runGuardPipeline([g1, g2], [draft('x')], { chatId: 1, regenerate: vi.fn(), isBlank });
    expect(order).toEqual(['first', 'second']);
  });

  it('empty drafts short-circuit', async () => {
    const check = vi.fn();
    const out = await runGuardPipeline(
      [{ name: 'g', check, maxRetries: 1, temperature: 1, hintMode: 'none' }],
      [],
      { chatId: 1, regenerate: vi.fn(), isBlank },
    );
    expect(out).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });
});
