// ────────────────────────────────────────
// env schema 段共享的 zod 预处理器
// ────────────────────────────────────────
// "true"/"1"/"yes"/"on" → true；"false"/"0"/"no"/"off"/"" → false；
// 其余原样交给 z.boolean()（非字符串值直接透传，测试里常这么 mock env）。
//
// 从 src/env.ts 拆段时抽出来——否则 12 个段文件各复制一份，
// 改一处忘一处就成了"同一个 helper 两种行为"。
// ────────────────────────────────────────

import { z } from 'zod';

export const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());
