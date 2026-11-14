import { describe, expect, it, vi } from 'vitest';
import { acquireAiLease, aiLeaseKeys, getAiWorkload, runWithAiWorkload } from '../../../src/ai/workload.js';
import { aiSection } from '../../../src/env-sections/ai.js';

describe('AI workload context', () => {
  it('defaults to interactive and isolates concurrent asynchronous tasks', async () => {
    expect(getAiWorkload()).toBe('interactive');
    const seen = await Promise.all([
      runWithAiWorkload('background', async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return getAiWorkload();
      }),
      Promise.resolve().then(() => getAiWorkload()),
    ]);
    expect(seen).toEqual(['background', 'interactive']);
    expect(getAiWorkload()).toBe('interactive');
  });

  it('restores the outer context after nested calls and exceptions', () => {
    runWithAiWorkload('background', () => {
      expect(() => runWithAiWorkload('interactive', () => {
        expect(getAiWorkload()).toBe('interactive');
        throw new Error('test');
      })).toThrow('test');
      expect(getAiWorkload()).toBe('background');
    });
    expect(getAiWorkload()).toBe('interactive');
  });

  it('keeps the feature off by default with one background slot', () => {
    expect(aiSection.AI_WORKLOAD_BUDGET_ENABLED.parse(undefined)).toBe(false);
    expect(aiSection.AI_MAX_BACKGROUND_INFLIGHT_PER_MODEL.parse(undefined)).toBe(1);
    expect(aiSection.AI_MAX_INFLIGHT_PER_MODEL.parse(undefined)).toBe(2);
  });

  it('rejects an unbounded timeout before touching Redis', async () => {
    const evalMock = vi.fn();
    await expect(acquireAiLease({ eval: evalMock }, {
      model: 'm', workload: 'background', totalLimit: 2, backgroundLimit: 1, timeoutMs: 0,
    })).rejects.toThrow('timeout');
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('uses a shared cluster slot without model-name collisions', () => {
    const a = aiLeaseKeys('one:{two}');
    const b = aiLeaseKeys('one:two');
    expect(a[0].match(/\{([^}]+)\}/)?.[1]).toBe(a[1].match(/\{([^}]+)\}/)?.[1]);
    expect(a).not.toEqual(b);
  });
});
