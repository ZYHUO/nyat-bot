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
    const { prompt, cachePrefix, manifest } = await eng.assemble([
      volatileText('now', 'NOW'),
      staticText('persona', 'PERSONA'),
      ephemeralText('tmp', 'TMP'),
      deltaText('task', 'TASK'),
    ]);
    expect(prompt).toBe('PERSONA\n\nTASK\n\nTMP\n\nNOW');
    expect(cachePrefix).toBe('PERSONA');
    expect(manifest.parts.map((p) => p.tier)).toEqual([
      'static',
      'delta',
      'ephemeral',
      'volatile',
    ]);
  });

  it('reports local unchanged characters separately from the first-request cache boundary', async () => {
    const eng = getContextEngine('t2');
    const providers = [staticText('s', 'same'), deltaText('d', 'same-d')];
    const a = await eng.assemble(providers);
    const b = await eng.assemble(providers);
    expect(a.manifest.unchangedContextRatio).toBe(0);
    expect(a.cachePrefix).toBe('same');
    expect(b.cachePrefix).toBe(a.cachePrefix);
    expect(b.manifest.unchangedContextRatio).toBe(1);
    expect(b.manifest.parts.every((p) => p.unchanged)).toBe(true);
    expect(b.manifest.unchangedChars).toBe('same'.length + 'same-d'.length);
    expect(b.manifest).not.toHaveProperty('cacheHitRatio');
  });

  it('does not reuse omitted or previous-chat text and forgets omitted fingerprints', async () => {
    const eng = getContextEngine('subagent:qq:1');
    await eng.assemble([ephemeralText('memory', 'PRIVATE_QQ_TEXT')]);
    expect((await eng.assemble([])).prompt).toBe('');
    const returned = await eng.assemble([ephemeralText('memory', 'PRIVATE_QQ_TEXT')]);
    expect(returned.manifest.parts[0]!.unchanged).toBe(false);
    const tg = await getContextEngine('subagent:tg:1').assemble([ephemeralText('memory', 'TG_CONTEXT')]);
    expect(tg.prompt).toBe('TG_CONTEXT');
    expect(tg.manifest.unchangedContextRatio).toBe(0);
  });

  it('keeps hashes, not raw prompt text; disabled mode clears equality history', async () => {
    const eng = getContextEngine('hash');
    await eng.assemble([ephemeralText('memory', 'SYNTHETIC_PRIVATE_BODY')]);
    const internal = eng as unknown as { lastFingerprints: Map<string, string> };
    expect([...internal.lastFingerprints.values()]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    setContextEngineOptions({ enabled: false });
    const rendered = await eng.assemble([ephemeralText('memory', 'SYNTHETIC_PRIVATE_BODY')]);
    expect(rendered.prompt).toBe('SYNTHETIC_PRIVATE_BODY');
    expect(rendered.manifest.unchangedContextRatio).toBe(0);
    expect(internal.lastFingerprints.size).toBe(0);
  });

  it('bounds idle conversation caches without changing assembled content', async () => {
    const old = getContextEngine('old');
    for (let i = 0; i < 256; i++) getContextEngine(`chat:${i}`);
    expect(getContextEngine('old')).not.toBe(old);
  });

  it('keeps the exact static prefix when task, memory, state and time change', async () => {
    const eng = getContextEngine('subagent:synthetic');
    const assemble = (turn: string) => eng.assemble([
      ephemeralText('memory', `MEMORY_${turn}`), staticText('b-policy', 'POLICY\n'),
      deltaText('task', `TASK_${turn}`), staticText('a-identity', '  IDENTITY'),
      ephemeralText('self', `SELF_${turn}`), volatileText('now', `NOW_${turn}`),
    ]);
    const first = await assemble('FIRST');
    const second = await assemble('SECOND');
    expect(first.cachePrefix).toBe('  IDENTITY\n\nPOLICY\n');
    expect(second.cachePrefix).toBe(first.cachePrefix);
    for (const result of [first, second]) {
      expect(result.prompt.startsWith(result.cachePrefix)).toBe(true);
      expect(result.cachePrefix + result.prompt.slice(result.cachePrefix.length)).toBe(result.prompt);
    }
    expect(second.prompt).toBe('  IDENTITY\n\nPOLICY\n\n\nTASK_SECOND\n\nMEMORY_SECOND\n\nSELF_SECOND\n\nNOW_SECOND');
    expect(second.prompt).not.toContain('FIRST');
  });

  it('returns no prefix without static content and the full prompt when all content is static', async () => {
    const eng = getContextEngine('edges');
    expect((await eng.assemble([])).cachePrefix).toBe('');
    const dynamic = await eng.assemble([deltaText('task', 'CURRENT_TASK')]);
    expect(dynamic.cachePrefix).toBe('');
    expect(dynamic.prompt).toBe('CURRENT_TASK');
    const fixed = await eng.assemble([staticText('b', 'B'), staticText('empty', ' '), staticText('a', 'A')]);
    expect(fixed.cachePrefix).toBe('A\n\nB');
    expect(fixed.prompt).toBe(fixed.cachePrefix);
  });

  it('renders changed scoped static text instead of reusing another turn or session', async () => {
    const eng = getContextEngine('scope:one');
    const old = await eng.assemble([staticText('policy', 'SCOPE_ONE_OLD'), ephemeralText('ctx', 'PRIVATE_ONE')]);
    const updated = await eng.assemble([staticText('policy', 'SCOPE_ONE_REVOKED'), ephemeralText('ctx', 'CURRENT_ONE')]);
    const other = await getContextEngine('scope:two').assemble([staticText('policy', 'SCOPE_TWO'), ephemeralText('ctx', 'PRIVATE_TWO')]);
    expect(old.cachePrefix).toBe('SCOPE_ONE_OLD');
    expect(updated.cachePrefix).toBe('SCOPE_ONE_REVOKED');
    expect(updated.prompt).not.toContain('OLD');
    expect(other.cachePrefix).toBe('SCOPE_TWO');
    expect(other.prompt).not.toContain('ONE');
    expect(other.manifest.unchangedContextRatio).toBe(0);
  });

  it('does not mistake later equal segments for a continuous cache prefix', async () => {
    const eng = getContextEngine('non-prefix-equality');
    await eng.assemble([deltaText('task', 'OLD'), ephemeralText('memory', 'SAME')]);
    const next = await eng.assemble([deltaText('task', 'NEW'), ephemeralText('memory', 'SAME')]);
    expect(next.manifest.unchangedChars).toBe(4);
    expect(next.manifest.unchangedContextRatio).toBe(4 / 7);
    expect(next.cachePrefix).toBe('');
  });
});
