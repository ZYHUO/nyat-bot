import { beforeEach, describe, expect, it, vi } from 'vitest';

// host art 命名空间：异步自动送达（默认）画+发不绑单轮预算；autoSend:false 同步拿路径。
// artist/sender/沙盒全 mock——验证的是接线（keepalive、sendPhoto 参数、翻车说明、限次）。

const GROUP = -1002450361141;

const drawArtworkMock = vi.fn();
vi.mock('../../../src/agent/artist.js', () => ({
  drawArtwork: (...args: unknown[]) => drawArtworkMock(...args),
}));

const sendPhotoMock = vi.fn(async () => ({ messageId: 42 }));
const sendMessageMock = vi.fn(async () => 7);
const sendChatActionMock = vi.fn(async () => undefined);
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  sendPhoto: (...args: unknown[]) => sendPhotoMock(...args),
  sendChatAction: (...args: unknown[]) => sendChatActionMock(...args),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
}));

vi.mock('../../../src/sandbox/paths.js', () => ({
  resolveInsideSandbox: (rel: string) => `/tmp/sandbox/${rel}`,
}));

const addAssistantMock = vi.fn(async () => undefined);
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: (...args: unknown[]) => addAssistantMock(...args),
  getRecent: vi.fn(async () => []),
}));
const markAnsweredMock = vi.fn(async () => undefined);
vi.mock('../../../src/meta/answered.js', () => ({
  markMessageAnswered: (...args: unknown[]) => markAnsweredMock(...args),
}));

const envBase: Record<string, unknown> = {
  MASTER_UID: 6251541967,
  CODEACT_BANNED_WORDS: [],
  POST_TASK_WINDOW_ENABLED: false,
  MEMORY_CROSS_CONTEXT_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: false,
};
vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => []),
  searchMemoryByUser: vi.fn(async () => []),
}));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({
  getReadyStickersByIntent: vi.fn(() => []),
}));
vi.mock('../../../src/tracking/person-identity.js', () => ({
  getPersonIdentity: vi.fn(() => null),
  buildCrossGroupInjection: vi.fn(async () => ''),
}));

async function makeHost(chatId = GROUP) {
  const { createHostApi } = await import('../../../src/subagent/host-api.js');
  return createHostApi(chatId, {
    onEnd: vi.fn(),
    defaultReplyTo: 555,
    quoteIds: [555],
    taskId: 'task-art-test',
    messageThreadId: 7,
  });
}

describe('host art.draw', () => {
  beforeEach(() => {
    drawArtworkMock.mockReset();
    sendPhotoMock.mockClear();
    sendMessageMock.mockClear();
    sendChatActionMock.mockClear();
    addAssistantMock.mockClear();
    markAnsweredMock.mockClear();
  });

  it('默认异步：立刻返回 {started}，flush 后照片带 caption/thread 送达并记账', async () => {
    drawArtworkMock.mockResolvedValue({ pngPath: 'art/x.png', svgPath: 'art/x.svg', width: 100, height: 100 });
    const host = await makeHost();
    const r = await host.art.draw('画一只猫', { caption: '给你画的喵' });
    expect('started' in r && r.started).toBe(true);
    // 照片由后台 job 送达，flushBookkeeping 会等到它
    await host.runtime.flushBookkeeping();
    expect(sendPhotoMock).toHaveBeenCalledTimes(1);
    const [cid, path, opts] = sendPhotoMock.mock.calls[0]! as [number, string, Record<string, unknown>];
    expect(cid).toBe(GROUP);
    expect(path).toBe('/tmp/sandbox/art/x.png');
    expect(opts.caption).toBe('给你画的喵');
    expect(opts.messageThreadId).toBe(7);
    expect(opts.replyToId).toBe(555);
    // 上下文记账 + 引用标记（说过的话自己得记得；标记已答防 Meta 重派）
    expect(String(addAssistantMock.mock.calls[0]?.[1]?.textContent)).toContain('[photo] art/x.png');
    expect(markAnsweredMock).toHaveBeenCalledWith(GROUP, 555);
    // keepalive 至少打过一次 upload_photo
    expect(sendChatActionMock.mock.calls.some((c) => c[1] === 'upload_photo')).toBe(true);
  });

  it('画废了：自动发翻车说明，不发照片', async () => {
    drawArtworkMock.mockResolvedValue({ error: 'no_svg_in_output' });
    const host = await makeHost();
    await host.art.draw('画一只猫');
    await host.runtime.flushBookkeeping();
    expect(sendPhotoMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(String(sendMessageMock.mock.calls[0]![1])).toContain('翻车');
  });

  it('autoSend:false 同步拿路径（自己投递场景）', async () => {
    drawArtworkMock.mockResolvedValue({ pngPath: 'art/y.png', svgPath: 'art/y.svg', width: 200, height: 100 });
    const host = await makeHost();
    const r = await host.art.draw('画一只猫', { autoSend: false });
    expect('pngPath' in r && r.pngPath).toBe('art/y.png');
    await host.runtime.flushBookkeeping();
    expect(sendPhotoMock).not.toHaveBeenCalled();
  });

  it('每任务限 2 次', async () => {
    drawArtworkMock.mockResolvedValue({ pngPath: 'art/z.png', svgPath: 'art/z.svg', width: 1, height: 1 });
    const host = await makeHost();
    await host.art.draw('一');
    await host.art.draw('二');
    const third = await host.art.draw('三');
    expect('error' in third && third.error).toBe('art_limit:2_per_task');
    await host.runtime.flushBookkeeping();
  });
});
