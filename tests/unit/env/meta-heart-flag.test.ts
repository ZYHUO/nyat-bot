import { describe, expect, it } from 'vitest';
import { env } from '../../../src/env.js';

// 本仓库测试在 VITEST 下强制 getDb()=:memory:、getRedis()=db 0，
// 所以 import env.js 不会碰生产数据。


// Phase 1 的可执行性：关掉 Meta heart 必须是"翻一个旗"，不是"改代码再重测"。
// 这里只锁旗标本身（存在 + 默认 true + 独立于 HEART_ENABLED）。
// 真实路由条件在 src/bot/handlers/message.ts，由构建产物与既有 handler 测试覆盖；
// 刻意不做"镜像逻辑测试"——那种测试测的是复印件，会漂移。

describe('META_HEART_ENABLED', () => {
  it('默认 true：不翻旗时行为零变化', () => {
    // env() 读真实 .env + schema；CI 里未设置该变量，走 schema 的 default(true)。
    // VITEST 下 getDb()=:memory: / getRedis()=db 0，所以 import 不碰生产数据。
    const e = env();
    expect(e.META_HEART_ENABLED).toBe(true);
    expect(typeof e.HEART_ENABLED).toBe('boolean');
  });
});
