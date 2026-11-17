import { describe, expect, it, vi } from 'vitest';
import {
  readOpenAIStream, supportsOpenAIStreamUsage,
} from '../../../src/ai/openai-stream.js';

function body(source: string, chunkSize = 4096): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(source);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
}

const content = (text: string) => ({ choices: [{ delta: { content: text } }] });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

describe('OpenAI streaming response parser', () => {
  it('decodes fragmented UTF-8 and CRLF without losing or duplicating characters', async () => {
    const source = [frame(content('你好🐈')), frame(content('，世界。')), 'data: [DONE]\n\n']
      .join('').replaceAll('\n', '\r\n');
    const stream = body(source, 1);
    expect(await readOpenAIStream(stream)).toEqual({ text: '你好🐈，世界。', usage: undefined });
    expect(stream.locked).toBe(false);
  });

  it('joins data lines in one SSE event while ignoring other SSE fields and comments', async () => {
    const stream = body([
      ': keepalive', 'event: completion', 'id: synthetic-1', 'retry: 1000',
      'data: {"choices":',
      'data: [{"delta":{"content":"joined"}}],',
      'data: "usage":{"prompt_tokens":20,"completion_tokens":1}}', '', '',
    ].join('\n'), 7);
    expect(await readOpenAIStream(stream)).toEqual({
      text: 'joined', usage: { prompt_tokens: 20, completion_tokens: 1 },
    });
  });

  it('keeps the final cumulative usage snapshot instead of summing snapshots', async () => {
    const first = { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 60 } };
    const final = { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 60 } };
    const result = await readOpenAIStream(body(
      frame({ ...content('a'), usage: first })
      + frame({ ...content('b'), usage: first })
      + frame({ choices: [], usage: final })
      + 'data: [DONE]\n\n',
    ));
    expect(result).toEqual({ text: 'ab', usage: final });
  });

  it('does not erase known usage when subsequent ordinary chunks report null or no usage', async () => {
    const usage = { prompt_tokens: 20, completion_tokens: 2 };
    expect(await readOpenAIStream(body(
      frame({ choices: [], usage })
      + frame({ ...content('a'), usage: null })
      + frame(content('b')),
    ))).toEqual({ text: 'ab', usage });
  });

  it('preserves a final explicit zero snapshot as an observation', async () => {
    expect(await readOpenAIStream(body(
      frame({ choices: [], usage: { prompt_tokens: 20 } })
      + frame({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
    ))).toEqual({ text: '', usage: { prompt_tokens: 0, completion_tokens: 0 } });
  });

  it('ignores text and usage after DONE in the same chunk and cancels unread chunks', async () => {
    const cancel = vi.fn();
    const usage = { prompt_tokens: 20, completion_tokens: 1 };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          frame({ ...content('before'), usage }) + 'data: [DONE]\n\n'
          + frame({ ...content('must not appear'), usage: { prompt_tokens: 999 } }),
        ));
        controller.enqueue(new TextEncoder().encode(frame(content('also ignored'))));
        controller.close();
      },
      cancel,
    });
    expect(await readOpenAIStream(stream)).toEqual({ text: 'before', usage });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it('dispatches the final unterminated data line at EOF', async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 1 };
    const source = frame(content('first')) + `data:${JSON.stringify({ ...content('last'), usage })}`;
    expect(await readOpenAIStream(body(source, 3))).toEqual({ text: 'firstlast', usage });
  });

  it('discards malformed JSON and unrelated payloads without losing later valid events', async () => {
    const usage = { prompt_tokens: 9, completion_tokens: 1 };
    const source = 'data: {malformed\n\n' + frame(null) + frame([]) + frame('not a chunk')
      + frame({ choices: [{ delta: { content: 42 } }], usage: 'not usage' })
      + frame({ choices: null, usage: [] })
      + frame({ ...content('valid'), usage });
    expect(await readOpenAIStream(body(source, 2))).toEqual({ text: 'valid', usage });
  });

  it('keeps absent usage unknown for content-only and empty streams', async () => {
    expect(await readOpenAIStream(body(frame(content('hello'))))).toEqual({ text: 'hello', usage: undefined });
    expect(await readOpenAIStream(body(''))).toEqual({ text: '', usage: undefined });
  });

  it('supports compatible endpoints that omit blank lines between complete JSON data records', async () => {
    const usage = { prompt_tokens: 20, completion_tokens: 2 };
    const source = [
      `data: ${JSON.stringify(content('first'))}`,
      `data: ${JSON.stringify(content('second'))}`,
      `data: ${JSON.stringify({ choices: [], usage })}`,
      'data: [DONE]',
      `data: ${JSON.stringify(content('ignored'))}`,
    ].join('\n');
    expect(await readOpenAIStream(body(source, 5))).toEqual({ text: 'firstsecond', usage });
  });

  it('still joins incomplete multi-line JSON before accepting the next complete unseparated record', async () => {
    const source = [
      'data: {"choices":',
      'data: [{"delta":{"content":"split"}}]}',
      `data: ${JSON.stringify(content('next'))}`,
      'data: [DONE]',
    ].join('\r\n');
    expect(await readOpenAIStream(body(source, 1))).toEqual({ text: 'splitnext', usage: undefined });
  });

  it('propagates stream errors and releases the reader lock', async () => {
    const failure = new Error('synthetic stream failure');
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure); } });
    await expect(readOpenAIStream(stream)).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
  });
});

describe('OpenAI stream usage endpoint capability', () => {
  it.each([
    'https://api.openai.com', 'https://api.openai.com/v1',
    'https://api.openai.com:443/v1/', 'https://API.OPENAI.COM/v1/chat/completions',
  ])('allows the verified HTTPS origin %s', endpoint => {
    expect(supportsOpenAIStreamUsage(endpoint)).toBe(true);
  });

  it.each([
    'https://api.openai.com.attacker.invalid/v1',
    'https://attacker.invalid/api.openai.com/v1',
    'https://api.openai.com@attacker.invalid/v1',
    'https://attacker.invalid@api.openai.com/v1',
    'https://user:password@api.openai.com/v1',
    'https://:password@api.openai.com/v1',
    'https://api.openai.com:444/v1',
    'http://api.openai.com/v1',
    'ftp://api.openai.com/v1',
    'https://api.openai.com./v1',
    'https://openai.com/v1',
    'https://compatibility.example/v1',
    '//api.openai.com/v1', '/v1', 'not a URL', '',
  ])('does not enable an optional protocol field for unverified endpoint %s', endpoint => {
    expect(supportsOpenAIStreamUsage(endpoint)).toBe(false);
  });
});
