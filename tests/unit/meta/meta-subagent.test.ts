import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextEngine,
  _resetContextEngines,
  staticText,
  deltaText,
  ephemeralText,
} from '../../../src/context-engine/index.js';
import {
  AttentionAccumulator,
  _resetAttentionAccumulator,
  MetaSandbox,
  getGlobalState,
  _resetGlobalState,
} from '../../../src/meta/index.js';

describe('ContextEngine', () => {
  beforeEach(() => _resetContextEngines());

  it('orders tiers and reports cache hits on second assemble', async () => {
    const eng = new ContextEngine('test');
    const providers = [
      ephemeralText('e', 'ephemeral-1'),
      staticText('s', 'static-hello'),
      deltaText('d', 'delta-1', 'fp1'),
    ];
    const a = await eng.assemble(providers);
    expect(a.prompt.indexOf('static-hello')).toBeLessThan(a.prompt.indexOf('delta-1'));
    expect(a.manifest.cacheHitRatio).toBe(0);

    const b = await eng.assemble(providers);
    expect(b.manifest.cacheHitChars).toBeGreaterThan(0);
    expect(b.manifest.cacheHitRatio).toBeGreaterThan(0.5);
  });
});

describe('AttentionAccumulator', () => {
  beforeEach(() => _resetAttentionAccumulator());

  it('keeps burst messages instead of overwriting', () => {
    const acc = new AttentionAccumulator();
    acc.ingest({ chatId: 1, layer: 'L0', reason: 'a', messageId: 1 });
    acc.ingest({ chatId: 1, layer: 'L0', reason: 'b', messageId: 2 });
    expect(acc.size()).toBe(2);
    const flushed = acc.flush(10);
    expect(flushed).toHaveLength(2);
  });

  it('flushes highest pressure first', () => {
    const acc = new AttentionAccumulator();
    acc.ingest({ chatId: 1, layer: 'L2', reason: 'passive' });
    acc.ingest({ chatId: 2, layer: 'L0', reason: 'direct', messageId: 9 });
    const flushed = acc.flush(1);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.layer).toBe('L0');
    expect(acc.size()).toBe(1);
  });
});

describe('MetaSandbox', () => {
  it('runs sync code with injected API', () => {
    const box = new MetaSandbox({
      add: (a: number, b: number) => a + b,
    });
    const r = box.execute('add(2, 40)');
    expect(r.error).toBe(false);
    expect(r.output).toContain('42');
  });
});

describe('GlobalState', () => {
  beforeEach(() => _resetGlobalState());

  it('keeps digests and callbacks', () => {
    const s = getGlobalState();
    s.addDigest('hello');
    s.enqueueCallback({
      id: 'c1',
      taskId: 't1',
      chatId: -100,
      summary: 'replied',
      ok: true,
      createdAt: Date.now(),
    });
    expect(s.recentDigests(1)[0]!.text).toBe('hello');
    expect(s.drainCallbacks()).toHaveLength(1);
    expect(s.drainCallbacks()).toHaveLength(0);
  });
});
