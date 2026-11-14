import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCodeActSystemPrompt, buildJournalCapabilityNote } from '../../../src/subagent/capability-prompt.js';
import { CODEACT_CAPABILITY_METHODS, META_CAPABILITY_METHODS } from '../../../src/sandbox/codeact/capabilities.js';

const executor = readFileSync(new URL('../../../src/subagent/executor.ts', import.meta.url), 'utf8');
const legacy = executor.match(/const EXECUTOR_SYSTEM = `([\s\S]*?)`;/)?.[1];
const methodPattern = /\b(?:telegram|memory|stickers|web|meta|chats|members|goals|allowlist|linuxsb|pixiv|runtime|computer|browser|art|admin|bots|self)\.[A-Za-z][A-Za-z0-9]*/g;

describe('isolated CodeAct runtime prompt', () => {
  it('documents only exported methods while preserving supported interaction', () => {
    expect(legacy).toBeTruthy();
    const rendered = buildCodeActSystemPrompt(legacy!);
    for (const method of rendered.match(methodPattern) ?? []) {
      expect(CODEACT_CAPABILITY_METHODS).toContain(method);
    }
    for (const method of ['telegram.sendText', 'telegram.sendVoice', 'memory.recallPerson', 'meta.request', 'runtime.endTask']) {
      expect(rendered).toContain(method);
    }
    for (const method of ['art.draw', 'telegram.sendFile', 'telegram.sendToChat', 'computer.exec', 'self.editPrompt']) {
      expect(rendered).not.toContain(method);
    }
    expect(rendered).toContain('必须 await');
    expect(rendered).toContain('不得声称已经交付');
  });

  it('applies to the final collected system text, including self-play overrides', () => {
    expect(executor).toContain("staticText('sub-system', buildCodeActSystemPrompt(systemPrompt, codeActMethodsForChat(task.chatId)))");
    expect(executor).toContain('methods: codeActMethodsForChat(task.chatId)');
    expect(executor).toContain('selectCodeActCapabilities(host, opts.methods ?? CODEACT_CAPABILITY_METHODS)');
    const rendered = buildCodeActSystemPrompt('扮演一个爱思考的猫。\n使用 art.draw 画图。\n使用 telegram.sendText 回复。');
    expect(rendered).toContain('爱思考的猫');
    expect(rendered).not.toContain('art.draw');
    expect(rendered).toContain('telegram.sendText');
  });

  it('follows the passed capability list instead of a second hardcoded API list', () => {
    const rendered = buildCodeActSystemPrompt('使用 telegram.sendText 回复。\n使用 web.search 检索。', ['web.search']);
    expect(rendered).not.toContain('telegram.sendText');
    expect(rendered).toContain('web.search');
  });

  it('gives each agent its real journal route without granting direct channel sends', () => {
    const sub = buildJournalCapabilityNote('https://t.me/synthetic', 'subagent');
    const meta = buildJournalCapabilityNote('https://t.me/synthetic', 'meta');
    expect(sub).toContain('meta.request');
    expect(meta).toContain('journal.tryWrite');
    expect(META_CAPABILITY_METHODS).toContain('journal.tryWrite');
    expect(sub + meta).not.toContain('telegram.sendToChat');
    expect(sub + meta).not.toContain('bot 有权限');
  });
});
