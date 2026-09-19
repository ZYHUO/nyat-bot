/**
 * Meta 心流的三态路由。
 *
 * 为什么抽出来：Phase 1 旁路第一版写成"flag 假就整块跳过"，结果 META_HEART_ENABLED
 * =false 时 attention ingest 完全不发生——bot 直接静音，而不是"按 layer 分级进
 * attention"。注释说 A、代码做 B，而这个仓库已经出了五次同类失败。
 *
 * 根因是判定条件内联在一个 handler 里，没法测。抽成纯函数之后三态各自可断言：
 *
 *   heart   心流照常裁决（现状，零变化）
 *   bypass  心流不裁决，但消息仍按 layer 分级进 attention（Phase 1）
 *   off     心流全关：L2 旁观硬丢，L1 放行给 gate
 *
 * 关键不变量：**bypass 不得退化成静音**。bypass 与 off 的区别就是有没有人接管。
 */

export type HeartRoute = 'heart' | 'bypass' | 'off';

export interface HeartFlags {
  /** 心流总开关（既有）。 */
  HEART_ENABLED: boolean;
  /** Meta 心流适配器（Phase 1 旁路对象；默认 true）。 */
  META_HEART_ENABLED: boolean;
}

export function heartRoute(f: HeartFlags): HeartRoute {
  // 总开关关着 → 全关（旧行为，与 Phase 1 无关）
  if (!f.HEART_ENABLED) return 'off';
  // 总开关开着、适配器开着 → 心流裁决
  if (f.META_HEART_ENABLED) return 'heart';
  // 总开关开着、适配器关着 → 旁路，但仍要有人接管
  return 'bypass';
}

/** bypass 分支必须有 ingest，否则等于静音。这是上面那个 bug 的断言。 */
export function bypassMustIngest(route: HeartRoute): boolean {
  return route === 'bypass';
}
