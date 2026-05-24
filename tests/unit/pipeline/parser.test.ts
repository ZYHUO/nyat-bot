import { describe, it, expect } from 'vitest';
import { parseReplyResponse } from '../../../src/pipeline/reply/parser.js';

function parseSingle(raw: string, fallbackId: number) {
  const result = parseReplyResponse(raw, fallbackId);
  expect(result).toHaveLength(1);
  return result[0]!;
}

describe('Reply Parser', () => {
  const fallbackId = 999;

  // ── JSON parsing ──

  describe('JSON parsing', () => {
    it('parses valid JSON', () => {
      const raw = '{"replyContent": "你好呀", "targetMessageId": 123}';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('你好呀');
      expect(result.targetMessageId).toBe(123);
      expect(result.stickerIntent).toBeUndefined();
    });

    it('parses JSON with stickerIntent', () => {
      const raw = '{"replyContent": "喵~", "targetMessageId": 42, "stickerIntent": "cute"}';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('喵~');
      expect(result.targetMessageId).toBe(42);
      expect(result.stickerIntent).toEqual(['cute']);
    });

    it('parses JSON with all valid stickerIntent values', () => {
      for (const intent of ['cute', 'comfort', 'tease', 'happy', 'sleepy'] as const) {
        const raw = `{"replyContent": "test", "targetMessageId": 1, "stickerIntent": "${intent}"}`;
        const result = parseSingle(raw, fallbackId);
        expect(result.stickerIntent).toEqual([intent]);
      }
    });

    it('handles snake_case field names', () => {
      const raw = '{"reply_content": "hello", "target_message_id": 55}';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('hello');
      expect(result.targetMessageId).toBe(55);
    });

    it('uses fallback messageId when targetMessageId is missing', () => {
      const raw = '{"replyContent": "hey"}';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('hey');
      expect(result.targetMessageId).toBe(fallbackId);
    });

    it('uses fallback messageId for invalid targetMessageId', () => {
      const raw = '{"replyContent": "hey", "targetMessageId": "not_a_number"}';
      const result = parseSingle(raw, fallbackId);
      expect(result.targetMessageId).toBe(fallbackId);
    });

    it('preserves handoffToSplitter signal for downstream splitting', () => {
      const raw = '{"replyContent": "给主人：收到啦。给不听：也有你的份。", "targetMessageId": 123, "handoffToSplitter": true}';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('给主人：收到啦。给不听：也有你的份。');
      expect(result.targetMessageId).toBe(123);
      expect(result).toHaveProperty('handoffToSplitter', true);
    });
  });

  // ── Markdown code block ──

  describe('JSON in markdown code block', () => {
    it('parses JSON from code block', () => {
      const raw = '```json\n{"replyContent": "from code block", "targetMessageId": 88}\n```';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('from code block');
      expect(result.targetMessageId).toBe(88);
    });

    it('parses JSON from code block without language hint', () => {
      const raw = '```\n{"replyContent": "no hint", "targetMessageId": 77}\n```';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('no hint');
      expect(result.targetMessageId).toBe(77);
    });

    it('handles surrounding text with code block', () => {
      const raw = 'Here is my response:\n```json\n{"replyContent": "wrapped", "targetMessageId": 66}\n```\nHope that helps!';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('wrapped');
      expect(result.targetMessageId).toBe(66);
    });
  });

  // ── XML parsing ──

  describe('XML parsing', () => {
    it('parses standard XML with CDATA', () => {
      const raw = '<response><reply_content><![CDATA[本喵来啦]]></reply_content><target_message_id>100</target_message_id></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('本喵来啦');
      expect(result.targetMessageId).toBe(100);
    });

    it('parses XML with malformed CDATA (missing bracket)', () => {
      const raw = '<response><reply_content><![CDATA[喵喵喵]></reply_content><target_message_id>200</target_message_id></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('喵喵喵');
      expect(result.targetMessageId).toBe(200);
    });

    it('parses XML without CDATA', () => {
      const raw = '<response><reply_content>plain text reply</reply_content><target_message_id>300</target_message_id></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('plain text reply');
      expect(result.targetMessageId).toBe(300);
    });

    it('parses XML with sticker_intent', () => {
      const raw = '<response><reply_content><![CDATA[test]]></reply_content><target_message_id>50</target_message_id><sticker_intent>happy</sticker_intent></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('test');
      expect(result.stickerIntent).toEqual(['happy']);
    });

    it('strips residual CDATA markers', () => {
      const raw = '<response><reply_content><![CDATA[before <![CDATA[nested]]> after]]></reply_content><target_message_id>60</target_message_id></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).not.toContain('<![CDATA[');
      expect(result.replyContent).not.toContain(']]>');
    });

    it('uses fallback messageId when target_message_id missing from XML', () => {
      const raw = '<response><reply_content>hello</reply_content></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('hello');
      expect(result.targetMessageId).toBe(fallbackId);
    });
  });

  // ── Whitespace normalization ──

  describe('whitespace normalization', () => {
    it('normalizes \\r\\n to \\n', () => {
      const raw = '<response><reply_content><![CDATA[line1\\r\\nline2]]></reply_content><target_message_id>1</target_message_id></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('line1\nline2');
    });

    it('normalizes \\n to newline', () => {
      const raw = '<response><reply_content><![CDATA[line1\\nline2]]></reply_content><target_message_id>1</target_message_id></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('line1\nline2');
    });

    it('normalizes \\t to tab', () => {
      const raw = '<response><reply_content><![CDATA[col1\\tcol2]]></reply_content><target_message_id>1</target_message_id></response>';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('col1\tcol2');
    });

    it('normalizes whitespace in plain text fallback', () => {
      const raw = 'line1\\nline2\\tindented';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('line1\nline2\tindented');
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('handles empty string gracefully', () => {
      const result = parseSingle('', fallbackId);
      expect(result.replyContent).toBe('…');
      expect(result.targetMessageId).toBe(fallbackId);
    });

    it('handles whitespace-only input', () => {
      const result = parseSingle('   \n\t  ', fallbackId);
      expect(result.replyContent).toBe('…');
      expect(result.targetMessageId).toBe(fallbackId);
    });

    it('plain text fallback for unstructured response', () => {
      const raw = '本喵觉得你说得对呢';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('本喵觉得你说得对呢');
      expect(result.targetMessageId).toBe(fallbackId);
    });

    it('rejects invalid stickerIntent in JSON', () => {
      const raw = '{"replyContent": "test", "targetMessageId": 1, "stickerIntent": "invalid"}';
      const result = parseSingle(raw, fallbackId);
      // Should fall through to plain text since zod validation will fail
      expect(result.replyContent).toBeTruthy();
    });

    it('handles very long reply content', () => {
      const longText = 'a'.repeat(4000);
      const raw = `{"replyContent": "${longText}", "targetMessageId": 1}`;
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe(longText);
    });

    it('handles content field alias', () => {
      const raw = '{"content": "using content alias", "targetMessageId": 1}';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('using content alias');
    });
  });

  describe('multi-reply', () => {
    it('parses a JSON array of replies', () => {
      const raw = JSON.stringify([
        { replyContent: 'first', targetMessageId: 1 },
        { replyContent: 'second', targetMessageId: 2, stickerIntent: 'cute' },
      ]);
      const result = parseReplyResponse(raw, fallbackId);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ replyContent: 'first', targetMessageId: 1 });
      expect(result[1]).toEqual({
        replyContent: 'second',
        targetMessageId: 2,
        stickerIntent: ['cute'],
      });
    });
  });
});
