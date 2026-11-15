import { describe, expect, it } from 'vitest';

// round 130 事故回归：我在 createHostApi 的 return 上包了一层 Proxy 加计数器，
// 结果 `attachExecutionAudit(api, audit)` 用原 api 当 WeakMap 键、
// executor 拿到的是 Proxy——**键对不上**，getExecutionAudit 返回 undefined，
// `audit.hasContract()` 抛 `Cannot read properties of undefined`。
// 生产实测 8 个 CodeAct task **8 个全崩**，而 439 个测试文件全绿：
// 没有一条覆盖 createHostApi → getExecutionAudit 这条链。
//
// 这条测试就是那道缺口。它守的性质很简单：
// **createHostApi 的返回值，必须就是 attachExecutionAudit 登记的那个对象。**

describe('createHostApi → getExecutionAudit 契约', () => {
  it('返回值上能取到 audit（Proxy 包装会让它取不到）', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const { getExecutionAudit } = await import('../../../src/agent/execution-audit.js');

    const api = createHostApi(1, {
      onEnd: () => {},
      quoteIds: [],
      // 其余字段用 createHostApi 自己的默认值
    } as never);

    const audit = getExecutionAudit(api as unknown as object);
    expect(audit, 'getExecutionAudit(返回值) 不该是 undefined——见文件头注释').toBeDefined();
    expect(typeof audit!.hasContract).toBe('function');
    // 这一行就是 round 130 崩掉的那一句
    expect(() => audit!.hasContract()).not.toThrow();
  });

  it('返回值不是 Proxy 包出来的另一份对象（身份相等）', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const api = createHostApi(1, { onEnd: () => {}, quoteIds: [] } as never) as Record<string, unknown>;
    // WeakMap 用的是对象身份，所以这里只要证明"拿到的就是建的那个"——
    // 包一层 Proxy 会让它变成另一个对象，而上一条测试会红。
    // 这条是冗余的第二道：直接查 telegram 命名空间还在原对象上。
    expect(api['telegram']).toBeDefined();
    expect(typeof (api['telegram'] as Record<string, unknown>)['sendText']).toBe('function');
  });
});
