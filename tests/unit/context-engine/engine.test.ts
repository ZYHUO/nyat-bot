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

  it('does not reuse omitted or previous-chat text and forgets omitted fingerprints', async () => {
    const eng = getContextEngine('subagent:qq:1');
    await eng.assemble([ephemeralText('memory', 'PRIVATE_QQ_TEXT')]);
    expect((await eng.assemble([])).prompt).toBe('');
    const returned = await eng.assemble([ephemeralText('memory', 'PRIVATE_QQ_TEXT')]);
    expect(returned.manifest.parts[0]!.cacheHit).toBe(false);
    const tg = await getContextEngine('subagent:tg:1').assemble([ephemeralText('memory', 'TG_CONTEXT')]);
    expect(tg.prompt).toBe('TG_CONTEXT');
    expect(tg.manifest.cacheHitRatio).toBe(0);
  });

  it('keeps hashes, not raw prompt text; disabled mode clears equality history', async () => {
    const eng = getContextEngine('hash');
    await eng.assemble([ephemeralText('memory', 'SYNTHETIC_PRIVATE_BODY')]);
    const internal = eng as unknown as { lastFingerprints: Map<string, string> };
    expect([...internal.lastFingerprints.values()]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    setContextEngineOptions({ enabled: false });
    const rendered = await eng.assemble([ephemeralText('memory', 'SYNTHETIC_PRIVATE_BODY')]);
    expect(rendered.prompt).toBe('SYNTHETIC_PRIVATE_BODY');
    expect(rendered.manifest.cacheHitRatio).toBe(0);
    expect(internal.lastFingerprints.size).toBe(0);
  });

  it('bounds idle conversation caches without changing assembled content', async () => {
    const old = getContextEngine('old');
    for (let i = 0; i < 256; i++) getContextEngine(`chat:${i}`);
    expect(getContextEngine('old')).not.toBe(old);
  });
});
