import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../../../src/shared/config.js';
import { clearKnowledgeSectionCache, resetPermanentKnowledgeCache } from '../../../src/knowledge/file-base.js';

describe('file-base knowledge', () => {
  let tmpPrompts: string;
  let tmpKb: string;
  let getConfigSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpPrompts = mkdtempSync(join(tmpdir(), 'xxb-prompts-'));
    tmpKb = mkdtempSync(join(tmpdir(), 'xxb-kb-'));
    mkdirSync(join(tmpPrompts, 'knowledge'), { recursive: true });
    clearKnowledgeSectionCache();
    resetPermanentKnowledgeCache();
    getConfigSpy = vi.spyOn(config, 'getConfig').mockReturnValue({
      promptsDir: tmpPrompts,
      migrationsDir: join(tmpPrompts, 'migrations'),
      knowledgeBaseDir: tmpKb,
      personaDir: join(tmpPrompts, 'persona'),
    });
  });

  afterEach(() => {
    getConfigSpy.mockRestore();
    clearKnowledgeSectionCache();
    resetPermanentKnowledgeCache();
  });

  it('splitIntoSections splits on ## headings', async () => {
    const { splitIntoSections } = await import('../../../src/knowledge/file-base.js');
    const md = 'intro line\n\n## One\nbody1\n\n## Two\nbody2';
    const s = splitIntoSections(md);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s.some((x) => x.title.includes('One') && x.content.includes('body1'))).toBe(true);
  });

  it('searchKnowledge returns matching section by keyword', async () => {
    writeFileSync(
      join(tmpPrompts, 'knowledge', 'permanent.md'),
      '## Alpha\nfoo bar\n\n## Beta\nqux zed\n',
      'utf-8',
    );
    writeFileSync(join(tmpKb, '-99.md'), '## Gamma\nuniquekeyword here\n', 'utf-8');

    const { searchKnowledge } = await import('../../../src/knowledge/file-base.js');
    const out = searchKnowledge(-99, 'uniquekeyword', 5);
    expect(out).toContain('uniquekeyword');
    expect(out).toContain('Gamma');
  });
});
