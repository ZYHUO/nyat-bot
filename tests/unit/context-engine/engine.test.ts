import { describe, it, expect, beforeEach } from 'vitest';
import {
  getContextEngine,
  _resetContextEngines,
  setContextEngineOptions,
  staticText,
  deltaText,
  ephemeralText,
  volatileText,
} from '../../../packages/context-engine/src/index.js';

describe('@nyat/context-engine', () => {
  beforeEach(() => {
    _resetContextEngines();
    setContextEngineOptions({ enabled: true });
  });

  it('assembles tiers in stable order', async () => {
    const eng = getContextEngine('t1');
    const { prompt, manifest } = await eng.assemble([
      volatileText('now', 'NOW'),
      staticText('persona', 'PERSONA'),
      ephemeralText('tmp', 'TMP'),
      deltaText('task', 'TASK'),
    ]);
    expect(prompt).toBe('PERSONA\n\nTASK\n\nTMP\n\nNOW');
    expect(manifest.parts.map((p) => p.tier)).toEqual([
      'static',
      'delta',
      'ephemeral',
      'volatile',
    ]);
  });

  it('marks cache hits on second assemble', async () => {
    const eng = getContextEngine('t2');
    const providers = [staticText('s', 'same'), deltaText('d', 'same-d')];
    const a = await eng.assemble(providers);
    const b = await eng.assemble(providers);
    expect(a.manifest.cacheHitRatio).toBe(0);
    expect(b.manifest.cacheHitRatio).toBe(1);
    expect(b.manifest.parts.every((p) => p.cacheHit)).toBe(true);
  });
});
