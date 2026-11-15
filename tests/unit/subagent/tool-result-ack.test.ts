import { describe, expect, it } from 'vitest';
import { stringifyToolResult } from '../../../src/subagent/executor.js';

// 2026-09-19: sendText 的工具回执被 JSON.stringify 压成 {"messageId":123}，
// 挂在上面的「距你上一条仅 N 秒」注记、file_sent/cross_sent 标签、以及
// file_send_failed 的原因，全都到不了模型眼前。contract: 有人话标签的对象必须
// 透传字符串，普通数据对象才 JSON 化。

const ackLike = (label: string, messageId: number) => ({
  messageId,
  toString: () => label,
  [Symbol.toPrimitive]: () => label,
});

describe('stringifyToolResult', () => {
  it('passes through the human-readable label on send acks', () => {
    // This is the exact object makeSendAck() returns.
    const out = stringifyToolResult(ackLike('text_sent#6682（距你上一条仅 5 秒——同一个意思别换个说法再发）', 6682));
    expect(out).toBe('text_sent#6682（距你上一条仅 5 秒——同一个意思别换个说法再发）');
    expect(out).not.toBe('{"messageId":6682}');
  });

  it('passes through file/photo/cross-send labels and failure reasons', () => {
    expect(stringifyToolResult(ackLike('file_sent:report.pdf#91', 91))).toBe('file_sent:report.pdf#91');
    expect(stringifyToolResult(ackLike('cross_sent#12', 12))).toBe('cross_sent#12');
    expect(stringifyToolResult(ackLike('file_send_failed:no such file', 0))).toContain('file_send_failed:no such file');
  });

  it('still JSON-serialises plain data objects (tool query results)', () => {
    expect(stringifyToolResult({ hits: [{ id: 1 }], total: 1 })).toBe('{"hits":[{"id":1}],"total":1}');
    expect(stringifyToolResult([1, 2, 3])).toBe('[1,2,3]');
    expect(stringifyToolResult({ nested: { a: 1 } })).toBe('{"nested":{"a":1}}');
  });

  it('handles primitives and undefined', () => {
    expect(stringifyToolResult(undefined)).toBe('ok');
    expect(stringifyToolResult('plain string')).toBe('plain string');
    expect(stringifyToolResult(null)).toBe('null');
    expect(stringifyToolResult(42)).toBe('42');
    expect(stringifyToolResult(true)).toBe('true');
  });

  it('arrays with custom toString still JSON (join would lose structure)', () => {
    const arr = ['a', 'b'] as string[] & { toString?: () => string };
    arr.toString = () => 'a,b';
    expect(stringifyToolResult(arr)).toBe('["a","b"]');
  });
});
