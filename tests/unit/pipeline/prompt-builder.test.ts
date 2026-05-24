import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSystemPrompt, buildMessages, _resetPromptCache } from '../../../src/pipeline/reply/prompt-builder.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

// Mock the config module to provide a known prompts directory
vi.mock('../../../src/shared/config.js', () => {
  const promptFiles: Record<string, string> = {
    'identity/persona.md': '# L1 Identity\nYou are the bot.',
    'safety/guardrails.md': '# L2 Safety\nBe safe.',
    'contract/reply-schema.json': '{"type":"object","required":["replyContent"]}',
    'style/tone.md': '# L4 Style\nBe concise.',
    'task/reply.md': '# Reply Task\nReply to the message.',
    'task/reply-pro.md': '# Reply Pro Task\nReply with depth.',
  };

  return {
    loadPrompt: (relativePath: string, _dir: string) => {
      return promptFiles[relativePath] ?? '';
    },
    loadCachedPrompt: (relativePath: string) => {
      return promptFiles[relativePath] ?? '';
    },
    getConfig: () => ({
      promptsDir: '/mock/prompts',
      migrationsDir: '/mock/migrations',
    }),
    _resetPromptCache: () => {},
  };
});

describe('Prompt Builder', () => {
  beforeEach(() => {
    _resetPromptCache();
  });

  describe('buildSystemPrompt', () => {
    it('builds correct 5-layer prompt for normal tier', () => {
      const prompt = buildSystemPrompt('normal');
      expect(prompt).toContain('# L1 Identity');
      expect(prompt).toContain('# L2 Safety');
      expect(prompt).toContain('# L3 — 输出契约');
      expect(prompt).toContain('# L4 Style');
      expect(prompt).toContain('# Reply Task');
      expect(prompt).not.toContain('Reply Pro Task');
    });

    it('builds correct 5-layer prompt for pro tier', () => {
      const prompt = buildSystemPrompt('pro');
      expect(prompt).toContain('# L1 Identity');
      expect(prompt).toContain('# L2 Safety');
      expect(prompt).toContain('# L3 — 输出契约');
      expect(prompt).toContain('# L4 Style');
      expect(prompt).toContain('# Reply Pro Task');
      expect(prompt).not.toContain('# Reply Task\n');
    });

    it('includes JSON schema in contract layer', () => {
      const prompt = buildSystemPrompt('normal');
      expect(prompt).toContain('"type":"object"');
      expect(prompt).toContain('"replyContent"');
    });

    it('uses section separators between layers', () => {
      const prompt = buildSystemPrompt('normal');
      expect(prompt).toContain('---');
    });
  });

  describe('buildMessages', () => {
    const latestMessage: FormattedMessage = {
      role: 'user',
      uid: 1001,
      username: 'alice',
      fullName: 'Alice Wang',
      timestamp: 1700000000,
      messageId: 42,
      textContent: 'What is TypeScript?',
      isForwarded: false,
    };

    it('returns correct message structure', () => {
      const messages = buildMessages('system prompt', 'context text', latestMessage);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe('system');
      expect(messages[1]!.role).toBe('user');
    });

    it('system message contains the prompt', () => {
      const messages = buildMessages('my system prompt', 'ctx', latestMessage);
      expect(messages[0]!.content).toBe('my system prompt');
    });

    it('user message contains context', () => {
      const messages = buildMessages('sys', 'some context here', latestMessage);
      expect(messages[1]!.content).toContain('some context here');
    });

    it('user message contains current message marker', () => {
      const messages = buildMessages('sys', 'ctx', latestMessage);
      expect(messages[1]!.content).toContain('[CURRENT_MESSAGE_TO_REPLY]');
      expect(messages[1]!.content).toContain('message_id: 42');
      expect(messages[1]!.content).toContain('Alice Wang');
      expect(messages[1]!.content).toContain('What is TypeScript?');
    });

    it('includes knowledge when provided', () => {
      const messages = buildMessages('sys', 'ctx', latestMessage, 'Some knowledge base content');
      expect(messages[1]!.content).toContain('[知识库]');
      expect(messages[1]!.content).toContain('Some knowledge base content');
    });

    it('excludes knowledge section when not provided', () => {
      const messages = buildMessages('sys', 'ctx', latestMessage);
      expect(messages[1]!.content).not.toContain('[知识库]');
    });

    it('uses caption when textContent is empty', () => {
      const captionMsg: FormattedMessage = {
        ...latestMessage,
        textContent: '',
        captionContent: 'A nice photo',
      };
      const messages = buildMessages('sys', 'ctx', captionMsg);
      expect(messages[1]!.content).toContain('A nice photo');
    });

    it('marks anonymous senders but still treats them as replyable current messages', () => {
      const anonMsg: FormattedMessage = {
        ...latestMessage,
        uid: -1001,
        username: '',
        fullName: 'Test Group',
        isAnonymous: true,
        anonymousType: 'admin',
      };
      const messages = buildMessages('sys', 'ctx', anonMsg);
      expect(messages[1]!.content).toContain('发送者: Test Group[匿名管理员]');
      expect(messages[1]!.content).toContain('[CURRENT_MESSAGE_TO_REPLY]');
    });

    it('includes strict multi-reply instruction when explicit count is requested', () => {
      const messages = buildMessages('sys', 'ctx', latestMessage, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
        exactReplyCount: 2,
      });
      expect(messages[1]!.content).toContain('[REPLY_COUNT_REQUIREMENT]');
      expect(messages[1]!.content).toContain('必须输出恰好 2 条消息');
    });
  });
});
