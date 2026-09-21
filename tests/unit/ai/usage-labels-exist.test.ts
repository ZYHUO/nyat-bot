import { describe, expect, it } from 'vitest';

// round 1（新 goal）回归。用户报"/checkin 好像挂了"，追下来是：
//
//   AI usage reply_tools references missing label(s): spark13, k26
//
// spark13 / k26 在 round 134 清 label 时被删，而 labels.ts 的 reply_tools 默认链
// 没跟着改 → 每次调用抛 AIUsageError → 整条回复被带走 → 用户看不到回音。
// 09-21 六次 Pipeline reply/send failed 全是这个。
//
// 这是本会话"删了东西没删指向它的引用"的**第七次**。前六次各自只有事后证据，
// 没有一道测试能在删除的当时拦住。这道就是：
// **每一个 usage 的整条链，必须每一个 label 都在池子里。**
//
// 没有它，下次删 label 还会再中一次——这个错误在日志里长得不像配置错误
// （它是 AIError，栈在 callClaude 里），更像"模型挂了"。

import { env } from '../../../src/env.js';
import { getUsage, getLabels, USAGE_NAMES } from '../../../src/ai/labels.js';

describe('每个 usage 的链都指向真实存在的 label', () => {
  const live = new Set([...getLabels().keys()]);

  it('USAGE_NAMES 覆盖了所有会路由的 usage', () => {
    expect(USAGE_NAMES.length).toBeGreaterThan(5);
  });

  for (const name of USAGE_NAMES) {
    it(`${name} 的主 + 备选都在池子里`, () => {
      // `mundo` 是唯一的例外，而且是**设计如此**：labels.ts:20 在
      // MUNDO_ENABLED=false 时干脆不注册 mundo label（零足迹），
      // 误路由到它会响亮报错而不是悄悄走一个禁用端点。
      // 所以它"引用不存在的 label"是特性，本条测试照它例外处理。
      if (name === 'mundo' && !env().MUNDO_ENABLED) return;
      const u = getUsage(name);
      const missing = [u.label, ...u.backups].filter((l) => !live.has(l));
      expect(missing, `usage ${name} 引用已删除的 label: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('池子本身非空（否则上面的断言全是空集合上的恒真）', () => {
    expect(live.size).toBeGreaterThan(0);
  });
});
