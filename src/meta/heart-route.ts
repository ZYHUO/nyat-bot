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
  /** Phase 1 旁路的灰度群列表。空 = 不旁路任何群。 */
  META_HEART_BYPASS_CHAT_IDS: number[];
}

/**
 * 时限旁路的 Redis 键：存在即旁路，TTL 到期自动恢复。
 *
 * 为什么需要它：按群灰度（META_HEART_BYPASS_CHAT_IDS）是**持久**的——放进名单就会
 * 一直生效，直到有人记得把它删掉。一个会自己过期的开关让实验可以有时限，
 * 不需要依赖"我之后一定回来撤"。
 */
const BYPASS_TTL_KEY = (chatId: number) => `xxb:trench:heart_bypass:${chatId}`;

/** 给某个群开一个有时限的旁路。 */
export async function grantTimedBypass(chatId: number, minutes: number): Promise<void> {
  const redis = (await import('../db/redis.js')).getRedis();
  await redis.set(BYPASS_TTL_KEY(chatId), String(Math.floor(Date.now() / 1000)), 'EX', Math.max(60, Math.round(minutes * 60)));
}

/** 撤掉时限旁路（不必等 TTL）。 */
export async function revokeTimedBypass(chatId: number): Promise<void> {
  const redis = (await import('../db/redis.js')).getRedis();
  await redis.del(BYPASS_TTL_KEY(chatId));
}

/** 该群当前是否处于时限旁路中。 */
export async function hasTimedBypass(chatId: number): Promise<boolean> {
  try {
    const redis = (await import('../db/redis.js')).getRedis();
    return (await redis.get(BYPASS_TTL_KEY(chatId))) !== null;
  } catch {
    return false;   // 读失败按未开启处理——宁可不开，不要误开
  }
}

/**
 * 三态路由。
 *
 * bypass 的优先级：**灰度群列表 > 全局开关**。名单里有的群，即使
 * META_HEART_ENABLED 还是 true 也走旁路——否则"先开一个群试试"就要求先全局翻旗，
 * 那等于没有灰度。名单为空时完全按全局开关走，所以默认行为零变化。
 */
export function heartRoute(f: HeartFlags, chatId?: number): HeartRoute {
  // 总开关关着 → 全关（旧行为，与 Phase 1 无关）
  if (!f.HEART_ENABLED) return 'off';
  // 灰度名单命中 → 旁路（仍要有人接管，见 bypassMustIngest）
  if (chatId !== undefined && f.META_HEART_BYPASS_CHAT_IDS.includes(chatId)) return 'bypass';
  // 总开关开着、适配器开着 → 心流裁决
  if (f.META_HEART_ENABLED) return 'heart';
  // 总开关开着、适配器关着 → 全局旁路
  return 'bypass';
}

/** bypass 分支必须有 ingest，否则等于静音。这是上面那个 bug 的断言。 */
export function bypassMustIngest(route: HeartRoute): boolean {
  return route === 'bypass';
}
