import { describe, expect, it } from 'vitest';

// Phase 1 旁路第一版的 bug：写成"flag 假就整块跳过"，结果 attention ingest
// 完全不发生，bot 直接静音，而不是注释承诺的"按 layer 分级进 attention"。
// 根因是判定条件内联在 handler 里，没法测。抽成纯函数后三态各自可断言。

import { heartRoute, bypassMustIngest } from '../../../src/meta/heart-route.js';

describe('heartRoute 三态', () => {
  it('两个 flag 都开 → 心流照常裁决（现状，零变化）', () => {
    expect(heartRoute({ HEART_ENABLED: true, META_HEART_ENABLED: true, META_HEART_BYPASS_CHAT_IDS: [] })).toBe('heart');
  });

  it('Phase 1：总开关开、适配器关 → 旁路（不是静音）', () => {
    expect(heartRoute({ HEART_ENABLED: true, META_HEART_ENABLED: false, META_HEART_BYPASS_CHAT_IDS: [] })).toBe('bypass');
    expect(bypassMustIngest('bypass')).toBe(true);
  });

  it('总开关关 → 全关（旧行为，与 Phase 1 无关）', () => {
    expect(heartRoute({ HEART_ENABLED: false, META_HEART_ENABLED: true, META_HEART_BYPASS_CHAT_IDS: [] })).toBe('off');
    expect(heartRoute({ HEART_ENABLED: false, META_HEART_ENABLED: false, META_HEART_BYPASS_CHAT_IDS: [] })).toBe('off');
  });

  it('bypass 不等于 off：这是第一版 bug 的核心', () => {
    const bypass = heartRoute({ HEART_ENABLED: true, META_HEART_ENABLED: false, META_HEART_BYPASS_CHAT_IDS: [] });
    const off = heartRoute({ HEART_ENABLED: false, META_HEART_ENABLED: false, META_HEART_BYPASS_CHAT_IDS: [] });
    expect(bypass).not.toBe(off);
    // off 不需要有人接管；bypass 必须接管
    expect(bypassMustIngest(bypass)).toBe(true);
    expect(bypassMustIngest(off)).toBe(false);
  });

  it('单独设 META_HEART_ENABLED=false 不会导致 off（不会静音）', () => {
    expect(heartRoute({ HEART_ENABLED: true, META_HEART_ENABLED: false, META_HEART_BYPASS_CHAT_IDS: [] })).not.toBe('off');
  });

  it('灰度名单优先于全局开关：名单里的群即使全局 true 也旁路', () => {
    const f = { HEART_ENABLED: true, META_HEART_ENABLED: true, META_HEART_BYPASS_CHAT_IDS: [-1001, -1002] };
    expect(heartRoute(f, -1001)).toBe('bypass');
    expect(heartRoute(f, -1002)).toBe('bypass');
  });

  it('名单外不受影响（这是"先开一个群"能成立的前提）', () => {
    const f = { HEART_ENABLED: true, META_HEART_ENABLED: true, META_HEART_BYPASS_CHAT_IDS: [-1001] };
    expect(heartRoute(f, -1003)).toBe('heart');
  });

  it('名单为空时全局开关仍说了算（默认行为零变化）', () => {
    const off = { HEART_ENABLED: true, META_HEART_ENABLED: false, META_HEART_BYPASS_CHAT_IDS: [] };
    expect(heartRoute(off, -1009)).toBe('bypass');   // 全局关 → 全局旁路
    const on = { HEART_ENABLED: true, META_HEART_ENABLED: true, META_HEART_BYPASS_CHAT_IDS: [] };
    expect(heartRoute(on, -1009)).toBe('heart');
  });
});
