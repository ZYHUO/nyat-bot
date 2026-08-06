// ────────────────────────────────────────
// Reply Guard Registry — 回复自检管线 (AGI Level 5 P5-C)
//
// 旧世界：reply.ts 里 tool-artifact / exact-dup / near-dup 三块 regen 逻辑
// 手写串行，各自管自己的 retry 计数和 fallback 语义，加新检查要抄一遍模板。
// 新世界：声明式 guard 注册表——一个 guard = 检测 + regen 策略 + 接受条件，
// 管线统一跑。新增检查 = 加一个定义，不碰流程代码。
//
// 设计约束（从旧实现提炼，全部保留）：
// - regen 返回空/占位 → 保留第一版（别为了过检发更差的）
// - near-dup regen 带约束提示（REGENERATE_CONSTRAINT 块）
// - 每个 guard 独立失败容错（检测自己抛错 = 跳过，不影响发送）
// ────────────────────────────────────────

import { logger } from '../../shared/logger.js';

export interface GuardHit {
  /** 命中时的诊断信息（log 用）。 */
  detail?: string;
  /** near-dup 类：撞上的旧文本（约束提示用）。 */
  collidedWith?: string;
  /** 数值证据（ratio 等）。 */
  metric?: number;
}

export interface ReplyDraft {
  replyContent: string;
  targetMessageId: number;
}

export interface ReplyGuard<T extends ReplyDraft = ReplyDraft> {
  name: string;
  /** 返回 null = 通过；返回 GuardHit = 命中需要 regen。 */
  check: (chatId: number, drafts: T[]) => Promise<GuardHit | null>;
  /** regen 次数上限。 */
  maxRetries: number;
  /** regen 时的温度。 */
  temperature: number;
  /** 命中后 regen 的提示注入方式：constraint=往最后一条 user 消息追加约束块；instruction=追加指令消息。 */
  hintMode: 'constraint' | 'instruction' | 'none';
  /** 接受 regen 结果的条件：仍命中 = 保留第一版；空占位 = 保留第一版。 */
  acceptRegen?: (chatId: number, regenerated: T[]) => Promise<boolean>;
}

export interface GuardPipelineDeps<T extends ReplyDraft = ReplyDraft> {
  chatId: number;
  /** 重新生成一次。messages 已被 guard 按需改造。 */
  regenerate: (opts: { temperature: number; constraintHint?: string; instructionHint?: string }) => Promise<T[]>;
  isBlank: (text: string) => boolean;
}

/** 跑一个 guard。返回 (可能被 regen 替换的) drafts。 */
export async function runGuard<T extends ReplyDraft>(
  guard: ReplyGuard<T>,
  drafts: T[],
  deps: GuardPipelineDeps<T>,
): Promise<T[]> {
  if (!drafts[0]) return drafts;
  let hit: GuardHit | null = null;
  try {
    hit = await guard.check(deps.chatId, drafts);
  } catch (err) {
    logger.debug({ err, guard: guard.name, chatId: deps.chatId }, 'reply guard check failed (non-critical)');
    return drafts;
  }
  if (!hit) return drafts;

  logger.info({ guard: guard.name, chatId: deps.chatId, detail: hit.detail, metric: hit.metric }, 'reply guard hit, regenerating');

  for (let i = 0; i < guard.maxRetries; i++) {
    const constraintHint =
      guard.hintMode === 'constraint'
        ? `你刚刚说过非常类似的话（「${(hit.collidedWith ?? '').slice(0, 80)}…」）。换一个说法、换个角度、或者补充新的信息——禁止复读自己。`
        : undefined;
    const instructionHint =
      guard.hintMode === 'instruction'
        ? '上次输出包含工具痕迹/格式杂物。只输出干净的回复 JSON，禁止任何工具调用痕迹。'
        : undefined;

    let regenerated: T[];
    try {
      regenerated = await deps.regenerate({ temperature: guard.temperature, constraintHint, instructionHint });
    } catch (err) {
      logger.warn({ err, guard: guard.name, chatId: deps.chatId }, 'reply guard regen failed — keeping original');
      return drafts;
    }

    // 空占位不覆盖本来不错的第一版（会变静默）
    if (!regenerated[0] || deps.isBlank(regenerated[0].replyContent)) {
      return drafts;
    }

    // 接受条件：默认「不再命中该 guard」
    const accept = guard.acceptRegen
      ? await guard.acceptRegen(deps.chatId, regenerated)
      : (await guard.check(deps.chatId, regenerated).catch(() => null)) === null;

    if (accept) return regenerated;
    // 仍不通过 → 继续重试（还有次数的话）
  }

  // 重试耗尽仍命中 → 保留第一版（已尽力）
  logger.info({ guard: guard.name, chatId: deps.chatId }, 'reply guard retries exhausted, keeping original');
  return drafts;
}

/** 按注册顺序跑全部 guard。 */
export async function runGuardPipeline<T extends ReplyDraft>(
  guards: ReplyGuard<T>[],
  drafts: T[],
  deps: GuardPipelineDeps<T>,
): Promise<T[]> {
  let current = drafts;
  for (const guard of guards) {
    current = await runGuard(guard, current, deps);
  }
  return current;
}
