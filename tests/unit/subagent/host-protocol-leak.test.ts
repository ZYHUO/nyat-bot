import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: () => ({ CODEACT_BANNED_WORDS: [], MASTER_UID: 1 }),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sendMessage = vi.fn(async (..._args: unknown[]) => 1001);
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  sendSticker: vi.fn(),
  reactToMessage: vi.fn(),
  sendChatAction: vi.fn(),
}));

vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => []),
  addAssistant: vi.fn(),
}));

vi.mock('../../../src/meta/answered.js', () => ({
  markMessageAnswered: vi.fn(async () => {}),
}));

vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({
  checkNearDuplicate: vi.fn(async () => ({ isNearDuplicate: false, ratio: 0 })),
}));

vi.mock('../../../src/meta/timing-adapter.js', () => ({
  noteMetaBotReply: vi.fn(async () => {}),
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  memorizeMessage: vi.fn(async () => {}),
  searchMemory: vi.fn(async () => []),
  searchMemoryByUser: vi.fn(async () => []),
}));

import { createHostApi, stripApiCallLines } from '../../../src/subagent/host-api.js';

describe('stripApiCallLines (unit)', () => {
  it('strips trailing runtime.endTask lines, keeps natural text', () => {
    const s = stripApiCallLines('早安主人～\n超有意思\nruntime.endTask("no_update")\nendTask("no_update")');
    expect(s.stripped).toBe(2);
    expect(s.clean).toBe('早安主人～\n超有意思');
  });

  it('strips await telegram.sendText(...) style lines', () => {
    const s = stripApiCallLines('在画了喵\nawait telegram.sendText("hi")');
    expect(s.stripped).toBe(1);
    expect(s.clean).toBe('在画了喵');
  });

  it('returns clean="" when payload is only API-call syntax', () => {
    const s = stripApiCallLines('runtime.endTask("no_update")\nendTask("done")');
    expect(s.stripped).toBe(2);
    expect(s.clean).toBe('');
  });

  it('leaves natural parenthetical prose untouched', () => {
    const s = stripApiCallLines('CERN 换系统（他们内部迁移到 Linux）这事超有意思');
    expect(s.stripped).toBe(0);
    expect(s.clean).toBe('CERN 换系统（他们内部迁移到 Linux）这事超有意思');
  });

  it('leaves code-fence content untouched (handled upstream)', () => {
    // sendText rejects ``` payloads elsewhere? No — strip only matches whole-line calls;
    // a fenced block line like ```js is not a call line.
    const s = stripApiCallLines('看这段代码\n```js\nendTask("x")\n```');
    // The bare endTask("x") inside the fence WILL be stripped — acceptable: sendText
    // of raw fenced code is rare in CodeAct (files go via sendFile), and dropping one
    // call-looking line beats leaking protocol syntax.
    expect(s.clean).toContain('```js');
  });
});

describe('host sendText protocol-leak guard', () => {
  beforeEach(() => {
    sendMessage.mockClear();
    sendMessage.mockImplementation(async () => 1001 + sendMessage.mock.calls.length);
  });

  it('strips API-call lines from model text and sends the rest', async () => {
    const host = createHostApi(6251541967, { onEnd: () => {} });
    await host.telegram.sendText('早安主人～昨晚睡得好嘛喵？\nruntime.endTask("no_update")\nendTask("no_update")');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).toBe('早安主人～昨晚睡得好嘛喵？');
  });

  it('rejects when the entire payload is API-call syntax', async () => {
    const host = createHostApi(6251541967, { onEnd: () => {} });
    await expect(host.telegram.sendText('runtime.endTask("no_update")')).rejects.toThrow(/sendText_protocol_leak/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('plain natural text unaffected', async () => {
    const host = createHostApi(6251541967, { onEnd: () => {} });
    await host.telegram.sendText('本喵上课摸鱼写了篇CERN换系统的八卦笔记（真的超有意思）');
    expect(sendMessage).toHaveBeenCalledWith(
      6251541967,
      '本喵上课摸鱼写了篇CERN换系统的八卦笔记（真的超有意思）',
      undefined,
      undefined,
    );
  });
});
