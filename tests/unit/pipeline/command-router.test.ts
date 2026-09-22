import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

const envValues: Record<string, unknown> = {};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const callWithFallback = vi.fn();
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...a: unknown[]) => callWithFallback(...a) }));

const listAllProfiles = vi.fn();
vi.mock('../../../src/learners/bot-command-store.js', () => ({ listAllProfiles: (...a: unknown[]) => listAllProfiles(...a) }));

const tryDelegateCommand = vi.fn();
vi.mock('../../../src/pipeline/tools/bot-delegation.js', () => ({ tryDelegateCommand: (...a: unknown[]) => tryDelegateCommand(...a) }));

// Jev 结构化判断快路径(command-router 里 JEV_ENABLED 时才动态 import)。
const callJevChoice = vi.fn();
vi.mock('../../../src/ai/jev.js', () => ({ callJevChoice: (...a: unknown[]) => callJevChoice(...a) }));

import { routeLearnedCommand } from '../../../src/pipeline/command-router.js';

const READY = [
  { bot_username: 'uzumaru_geoip_bot', command_name: '/geo', usage_syntax: '/geo <IP>', use_scenario: '查IP归属', status: 'ready', needs_admin: 0, needs_reply: 0 },
  { bot_username: 'Music163bot', command_name: '/music', usage_syntax: '/music <歌名>', use_scenario: '点歌', status: 'ready', needs_admin: 0, needs_reply: 0 },
  { bot_username: 'adminbot', command_name: '/ban', usage_syntax: '/ban', use_scenario: '封人', status: 'ready', needs_admin: 1, needs_reply: 0 },
];

function fmt(text: string): FormattedMessage {
  return { role: 'user', uid: 100, username: 'u', fullName: 'U', timestamp: 0, messageId: 42, textContent: text, isForwarded: false, isBot: false } as FormattedMessage;
}
function setClassify(obj: unknown) { callWithFallback.mockResolvedValueOnce({ content: JSON.stringify(obj), label: 'stepfun' }); }
function setJevChoice(obj: unknown) { callJevChoice.mockResolvedValueOnce(obj); }

beforeEach(() => {
  for (const k of Object.keys(envValues)) delete envValues[k];
  Object.assign(envValues, { BOT_COMMAND_ROUTER_ENABLED: true, BOT_DELEGATION_ENABLED: true });
  vi.clearAllMocks();
  callJevChoice.mockReset();
  listAllProfiles.mockReturnValue(READY);
  tryDelegateCommand.mockResolvedValue({ sent: true, text: '已经替用户向 @x 发了…' });
});

describe('routeLearnedCommand', () => {
  it('意图匹配 ready 命令 → 代发 → 返回 true(短路)', async () => {
    setClassify({ bot: 'uzumaru_geoip_bot', command: '/geo', args: '1.1.1.1' });
    const ok = await routeLearnedCommand(-100, fmt('啾咪 查下 1.1.1.1 是哪的'));
    expect(ok).toBe(true);
    expect(tryDelegateCommand).toHaveBeenCalledWith(-100, 'uzumaru_geoip_bot', '/geo', '1.1.1.1');
  });

  it('flag 关 → 不动', async () => {
    envValues['BOT_COMMAND_ROUTER_ENABLED'] = false;
    const ok = await routeLearnedCommand(-100, fmt('查下 1.1.1.1'));
    expect(ok).toBe(false);
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('没有 ready 命令 → 不判定', async () => {
    listAllProfiles.mockReturnValue([]);
    const ok = await routeLearnedCommand(-100, fmt('查下 1.1.1.1'));
    expect(ok).toBe(false);
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('classify 不命中 → false,不代发', async () => {
    setClassify({ match: false });
    const ok = await routeLearnedCommand(-100, fmt('啾咪今天天气真好呀'));
    expect(ok).toBe(false);
    expect(tryDelegateCommand).not.toHaveBeenCalled();
  });

  it('模型编了个 ready 里没有的命令 → 拒绝(防幻觉)', async () => {
    setClassify({ bot: 'faker_bot', command: '/hack', args: '' });
    const ok = await routeLearnedCommand(-100, fmt('啾咪帮我 hack 一下'));
    expect(ok).toBe(false);
    expect(tryDelegateCommand).not.toHaveBeenCalled();
  });

  it('needs_admin 的命令不进候选(即便模型指它也无效)', async () => {
    setClassify({ bot: 'adminbot', command: '/ban', args: '' });
    const ok = await routeLearnedCommand(-100, fmt('啾咪把他 ban 了'));
    expect(ok).toBe(false); // /ban 被 needs_admin 过滤掉,不在候选
  });

  it('代发被闸拦/冷却(sent:false)→ false,交给正常回复', async () => {
    setClassify({ bot: 'Music163bot', command: '/music', args: '晴天' });
    tryDelegateCommand.mockResolvedValue({ sent: false, text: '刚替你问过一次了' });
    const ok = await routeLearnedCommand(-100, fmt('啾咪来首晴天'));
    expect(ok).toBe(false);
  });

  it('DM(chatId>0)不走', async () => {
    const ok = await routeLearnedCommand(100, fmt('查下 1.1.1.1'));
    expect(ok).toBe(false);
    expect(callWithFallback).not.toHaveBeenCalled();
  });
});

describe('routeLearnedCommand — Jev 结构化快路径', () => {
  // needs_admin/needs_reply 过滤后,ready = [uzumaru_geoip_bot /geo = c0, Music163bot /music = c1],兜底 __none__。
  const enableJev = () => Object.assign(envValues, { JEV_ENABLED: true, JEV_MIN_CONFIDENCE: 0.6 });

  it('flag 关 → 一次都不调 Jev,照旧走 LLM judge(行为不变)', async () => {
    envValues.JEV_ENABLED = false;
    setClassify({ bot: 'uzumaru_geoip_bot', command: '/geo', args: '1.1.1.1' });
    const ok = await routeLearnedCommand(-100, fmt('查下 1.1.1.1'));
    expect(ok).toBe(true);
    expect(callJevChoice).not.toHaveBeenCalled();
    expect(callWithFallback).toHaveBeenCalledTimes(1);
  });

  it('Jev 自信命中 ready 命令 → 直接代发,LLM judge 被跳过;args 恒空(Jev 不给文本)', async () => {
    enableJev();
    setJevChoice({ type: 'choice', choice: 'c0', confidence: 0.9, probability: 0.9 });
    const ok = await routeLearnedCommand(-100, fmt('啾咪 查下 1.1.1.1 是哪的'));
    expect(ok).toBe(true);
    expect(callJevChoice).toHaveBeenCalledTimes(1);
    expect(tryDelegateCommand).toHaveBeenCalledWith(-100, 'uzumaru_geoip_bot', '/geo', ''); // ← args 空
    expect(callWithFallback).not.toHaveBeenCalled(); // 快路径省掉了 LLM
  });

  it('Jev 有信心的“不借”(none)→ 不代发,LLM judge 也跳过(省延迟的大头)', async () => {
    enableJev();
    setJevChoice({ type: 'choice', choice: '__none__', confidence: 0.95, probability: 0.95 });
    const ok = await routeLearnedCommand(-100, fmt('啾咪今天天气真好呀'));
    expect(ok).toBe(false);
    expect(tryDelegateCommand).not.toHaveBeenCalled();
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('Jev 低置信 → 不静默采用,退回 LLM judge', async () => {
    enableJev();
    setJevChoice({ type: 'choice', choice: 'c0', confidence: 0.3, probability: 0.3 }); // < JEV_MIN_CONFIDENCE
    setClassify({ match: false });
    const ok = await routeLearnedCommand(-100, fmt('含糊一句'));
    expect(ok).toBe(false);
    expect(callJevChoice).toHaveBeenCalledTimes(1);
    expect(callWithFallback).toHaveBeenCalledTimes(1); // 退回大模型
    expect(tryDelegateCommand).not.toHaveBeenCalled();
  });

  it('降级:Jev 挂了(返 null)→ 退回 LLM judge,行为逐字不变(含 args 照旧)', async () => {
    enableJev();
    setJevChoice(null); // relay 超时/熔断/乱码 → callJevChoice 返 null
    setClassify({ bot: 'Music163bot', command: '/music', args: '晴天' });
    const ok = await routeLearnedCommand(-100, fmt('啾咪来首晴天'));
    expect(ok).toBe(true);
    expect(tryDelegateCommand).toHaveBeenCalledWith(-100, 'Music163bot', '/music', '晴天');
    expect(callWithFallback).toHaveBeenCalledTimes(1);
  });

  it('降级:Jev 抛异常 → 不拖垮路由,退回 LLM judge', async () => {
    enableJev();
    callJevChoice.mockRejectedValueOnce(new Error('jev boom'));
    setClassify({ bot: 'uzumaru_geoip_bot', command: '/geo', args: '8.8.8.8' });
    const ok = await routeLearnedCommand(-100, fmt('查 8.8.8.8'));
    expect(ok).toBe(true);
    expect(tryDelegateCommand).toHaveBeenCalledWith(-100, 'uzumaru_geoip_bot', '/geo', '8.8.8.8');
  });

  it('反向验证:Jev 返了个不在 ready 名单的答案 → 不静默绕过,退回 LLM judge', async () => {
    enableJev();
    // 模拟 relay 漂移/乱码:给了一个 buildJevCriteria 压根没生成的 key。
    setJevChoice({ type: 'choice', choice: 'c999-not-real', confidence: 0.99, probability: 0.99 });
    setClassify({ match: false });
    const ok = await routeLearnedCommand(-100, fmt('啾咪帮我随便弄下'));
    expect(ok).toBe(false);
    expect(tryDelegateCommand).not.toHaveBeenCalled(); // 假答案没有被当真去代发
    expect(callWithFallback).toHaveBeenCalledTimes(1); // 走了 LLM 兜底
  });
});
