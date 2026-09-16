import { describe, it, expect } from 'vitest';
import { parseReplyResponse, salvageReplyContent, isBlankReply } from '../../../src/pipeline/reply/parser.js';

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

    it('schema 反刍 → 降级 silent,绝不把 schema 当文本发出(stepfun 偶发)', () => {
      const raw = JSON.stringify({
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'ReplyOutput',
        oneOf: [{ $ref: '#/$defs/singleReply' }],
        $defs: { singleReply: { type: 'object', required: ['replyContent', 'targetMessageId'], properties: { replyContent: { type: 'string' } } } },
      });
      const result = parseSingle(raw, fallbackId);
      expect(result.action).toBe('silent');
      expect(result.replyContent).toBe('');
    });

    it('schema 反刍(带 ```json 围栏)→ 仍降级 silent', () => {
      const raw = '```json\\n{"$schema":"http://json-schema.org/draft-07/schema#","title":"ReplyOutput","oneOf":[...],"$defs":{}}\\n```';
      const result = parseSingle(raw, fallbackId);
      expect(result.action).toBe('silent');
    });

    it('CoT 泄漏(英文推理文本)→ 降级 silent,绝不发到群里(kimi-k3 偶发)', () => {
      const cotSamples = [
        'Let me look at the context. This is a channel (频道) "啾咪囝の碎碎念" — which seems to be my own channel actually',
        'Let me think about this. The chat is a channel called "碎碎念" and I need to figure out what to reply',
        'I need to check the context before responding to this message from the user',
        'Looking at the messages, I should consider what the group is talking about',
        'Okay, let me analyze this conversation and decide how to reply to the user',
        'This is a group chat message and I need to determine the appropriate response',
      ];
      for (const raw of cotSamples) {
        const result = parseSingle(raw, fallbackId);
        expect(result.action).toBe('silent');
        expect(result.replyContent).toBe('');
      }
    });

    it('正常回复不会被误判为 CoT(中文/短句/无分析词)', () => {
      const okSamples = [
        '本喵觉得你说得对呢',
        'Let me tell you a story about cats',
        'So cute! 我也想养一只喵',
        '好的马上去',
      ];
      for (const raw of okSamples) {
        const result = parseSingle(raw, fallbackId);
        expect(result.replyContent).not.toBe('');
      }
    });

    it('正常回复里偶尔出现 "title" 字样不会被误判为 schema', () => {
      const raw = '{"replyContent":"这个title不错","targetMessageId":123}';
      const result = parseSingle(raw, fallbackId);
      expect(result.replyContent).toBe('这个title不错');
      expect(result.action).toBeUndefined();
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

  describe('malformed-JSON salvage (波5)', () => {
    it('recovers replyContent from truncated JSON instead of leaking it', () => {
      // broken/truncated JSON — must NOT dump raw braces to the user
      const r = parseSingle('{"replyContent": "你好喵~", "targetMessage', 42);
      expect(r.replyContent).toBe('你好喵~');
      expect(r.replyContent).not.toContain('{');
    });
    it('recovers replyContent when maxTokens cuts off mid-string (no closing quote)', () => {
      const r = parseSingle('{"replyContent":"唔…早安喵', 42);
      expect(r.replyContent).toBe('唔…早安喵');
      expect(r.replyContent).not.toContain('replyContent');
    });
    it('recovers replyContent from truncated ```json fence', () => {
      const r = parseSingle('```json\n{\n  "replyContent": "猪肉包啊笨', 42);
      expect(r.replyContent).toBe('猪肉包啊笨');
      expect(r.replyContent).not.toContain('```');
    });
    it('unescapes within the salvaged string', () => {
      expect(salvageReplyContent('{"replyContent":"行\\"吧\\"喵"} oops')).toBe('行"吧"喵');
    });
    it('returns null for non-JSON text (plain fallback path)', () => {
      expect(salvageReplyContent('就是一句普通的话')).toBeNull();
    });
    it('plain text still falls through unchanged', () => {
      expect(parseSingle('今天天气不错', 42).replyContent).toBe('今天天气不错');
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

describe('isBlankReply (空回复/省略号占位识别)', () => {
  it('true for empty / whitespace / dots-or-ellipsis-only', () => {
    for (const s of ['', '   ', '\n\t', '…', '...', '。。。', '. . .', '·', '•••', '… …', null, undefined]) {
      expect(isBlankReply(s as string)).toBe(true);
    }
  });
  it('false for real content (even short)', () => {
    for (const s of ['在', 'ok', '喵', '好的喵', '?', '哈哈…']) {
      expect(isBlankReply(s)).toBe(false);
    }
  });
});

describe('single-quoted / Python-dict salvage (DeepSeek quirk)', () => {
  it('parseReplyResponse extracts replyContent, never sends the raw blob', () => {
    const raw = "{'replyContent': '大A日常表演高开低走，习惯就好喵', 'targetMessageId': 578557}";
    const result = parseReplyResponse(raw, 999);
    expect(result).toHaveLength(1);
    expect(result[0]!.replyContent).toBe('大A日常表演高开低走，习惯就好喵');
    expect(result[0]!.replyContent).not.toContain('replyContent');
    expect(result[0]!.replyContent).not.toContain('{');
  });
  it('salvageReplyContent handles single, double, and mixed quotes', () => {
    expect(salvageReplyContent("{'replyContent': 'hi喵', 'targetMessageId': 1}")).toBe('hi喵');
    expect(salvageReplyContent('{"replyContent": "hi喵", "targetMessageId": 1}')).toBe('hi喵');
    expect(salvageReplyContent("{'reply_content': '换皮也行喵'}")).toBe('换皮也行喵');
    expect(salvageReplyContent('not a dict')).toBeNull();
  });
});
