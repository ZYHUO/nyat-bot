import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCodeActSystemPrompt, buildJournalCapabilityNote, codeActMethodsForChat } from '../../../src/subagent/capability-prompt.js';
import ts from 'typescript';
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
    const tree = ts.createSourceFile('executor.ts', executor, ts.ScriptTarget.Latest, true);
    const selections: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'codeActMethodsForChat') selections.push(node);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(selections).toHaveLength(2);
    for (const call of selections) expect(call.arguments.map(arg => arg.getText(tree))).toEqual(['task.chatId', 'background', '!!qqAssignment']);
    expect(selections.some(call => ts.isCallExpression(call.parent) && call.parent.expression.getText(tree) === 'buildCodeActSystemPrompt')).toBe(true);
    expect(selections.some(call => ts.isPropertyAssignment(call.parent) && call.parent.name.getText(tree) === 'methods')).toBe(true);
    expect(executor).toContain('selectCodeActCapabilities(host, opts.methods ?? CODEACT_CAPABILITY_METHODS)');
    const rendered = buildCodeActSystemPrompt('扮演一个爱思考的猫。\n使用 art.draw 画图。\n使用 telegram.sendText 回复。');
    expect(rendered).toContain('爱思考的猫');
    expect(rendered).not.toContain('art.draw');
    expect(rendered).toContain('telegram.sendText');
  });

  it('background tasks get the same read/propose-only contract on both platforms', () => {
    for (const chatId of [123, 2 ** 52 + 1]) {
      const methods = codeActMethodsForChat(chatId, true);
      const rendered = buildCodeActSystemPrompt(legacy!, methods, chatId);
      expect(methods).toContain('runtime.proposePublication');
      expect(methods).toContain('memory.search');
      expect(methods.some(method => method.startsWith('telegram.') || method === 'meta.request')).toBe(false);
      for (const method of rendered.match(methodPattern) ?? []) expect(methods).toContain(method);
      expect(rendered).toContain('proposed 绝不是发送成功');
      expect(rendered).not.toContain('telegram.sendText');
    }
    expect(codeActMethodsForChat(123)).toContain('telegram.sendText');
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

  it('adds concise optional-quote guidance only for an explicitly QQ task, even without media', () => {
    const methods = ['telegram.sendText', 'runtime.endTask'];
    const qq = buildCodeActSystemPrompt('', methods, 2 ** 52 + 1);
    expect(qq).toContain('省略 replyTo 就是不引用');
    expect(qq).toContain('不必每轮两条');
    expect(qq).toContain('按真实气泡累计');
    expect(qq).not.toContain('telegram.sendTextFile');
    expect(buildCodeActSystemPrompt('', methods, -100123)).not.toContain('QQ 接话');
    expect(buildCodeActSystemPrompt('', methods)).not.toContain('QQ 接话');
  });
});


it('keeps assignment workers scoped and explains previews without fabricating QQ permission or mention requirements', () => {
  const methods = codeActMethodsForChat(2 ** 52 + 1, false, true);
  expect(methods).toContain('telegram.sendFinal');
  for (const method of ['telegram.react', 'telegram.sendVoice', 'runtime.scheduleSelfWake', 'goals.add', 'meta.request', 'chats.previewAssignment']) expect(methods).not.toContain(method);
  const prompt = buildCodeActSystemPrompt('', ['chats.previewAssignment', 'chats.assignmentStatus']);
  expect(prompt).toContain('不会授权或发送');
  expect(prompt).toContain('亲自提交');
  expect(prompt).toContain('不说明 QQ 群里没有发言权限');
  expect(prompt).toContain('回复、等待或略过');
  for (const method of prompt.match(methodPattern) ?? []) expect(['chats.previewAssignment', 'chats.assignmentStatus']).toContain(method);
});
