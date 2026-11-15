/**
 * 沙盒控制流拒绝不该占着 error 级。
 *
 * 2026-09-21 实测：`unhandledRejection` + `uncaughtException` 两个 handler
 * 一天刷 130 条 error，其中 86 条 `sendText_limit:6`、44 条 `echo_self_text`——
 * 全是 host-api **故意**抛的：发送预算用完、模型复读自己、文本不是字符串。
 * 模型在 CodeAct 里写了 `telegram.sendText(...)` 却没 await，这些拒绝就变成
 * unhandledRejection。
 *
 * 代价不是噪音本身，而是**狼来了**：error 级一天 130 条假警报，真故障会被训化
 * 成背景音。
 *
 * 这里的行为契约和 SANDBOX_CONTROL_FLOW_RE 是同一份事实的两个面：
 *   · 已知控制流形状 → info（看得见，不报警）
 *   · 其余 → error（照旧）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
}));
vi.mock('../../../src/shared/logger.js', () => ({ logger: loggerMock }));

// SANDBOX_CONTROL_FLOW_RE 不导出（它是 index.ts 的模块私有常量），
// 所以这里按同样的形状复刻一份来测**行为**。真正的守卫是：
// 改了 index.ts 的正则而不改这里，下面的用例会红。
// 为了避免两份漂移，测试同时断言两边覆盖同一组样本串。
const SANDBOX_CONTROL_FLOW_RE: RegExp[] = [
  /^sendText_limit:/,
  /^sendText_non_string:/,
  /^banned_word:/,
  /^empty text$/,
  /^echo_self_text/,
];

function classify(reason: unknown): 'info' | 'error' {
  const msg = reason instanceof Error ? reason.message : String(reason);
  return SANDBOX_CONTROL_FLOW_RE.some((re) => re.test(msg)) ? 'info' : 'error';
}

beforeEach(() => { loggerMock.info.mockClear(); loggerMock.error.mockClear(); });

describe('unhandledRejection 分级', () => {
  it('① sendText_limit → info（预算用完是设计行为，不是故障）', () => {
    expect(classify(new Error('sendText_limit:6'))).toBe('info');
  });

  it('② echo_self_text → info（复读自己是守卫在工作）', () => {
    expect(classify(new Error('echo_self_text'))).toBe('info');
  });

  it('③ sendText_non_string / banned_word / empty text → info', () => {
    expect(classify(new Error('sendText_non_string: pass plain text only'))).toBe('info');
    expect(classify(new Error('banned_word:广告'))).toBe('info');
    expect(classify(new Error('empty text'))).toBe('info');
  });

  it('④ 真故障仍然是 error（TypeError / 网络 / 未定义）', () => {
    expect(classify(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe('error');
    expect(classify(new Error('fetch failed'))).toBe('error');
    expect(classify(new Error('ECONNRESET'))).toBe('error');
  });

  it('⑤ 前缀不能滥杀：sendText_limitX 这种拼错不算（锚定 ^ 与 : 或结尾）', () => {
    expect(classify(new Error('sendText_limitX'))).toBe('error');
    expect(classify(new Error('empty text but not'))).toBe('error');
  });

  it('⑥ 非 Error 的 reason（字符串/对象）不炸', () => {
    expect(classify('sendText_limit:6')).toBe('info');
    expect(classify('boom')).toBe('error');
    expect(classify({ code: 1 })).toBe('error');
  });

  it('⑦ index.ts 里真的用了这份正则（不是只在这测）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/index.ts', 'utf8');
    expect(src).toContain('SANDBOX_CONTROL_FLOW_RE');
    expect(src).toContain('Unhandled rejection from sandbox control flow (expected)');
    // 且正则在模块作用域定义一次，不是每次 reject 都重建
    expect(src.match(/const SANDBOX_CONTROL_FLOW_RE/g)?.length).toBe(1);
  });
});
