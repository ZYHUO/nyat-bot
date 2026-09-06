// ────────────────────────────────────────
// Core v2 Phase 1 — 分层 loop 编排（不合并旧 loop）
//
// heart/reply/subagent 原样保留。runCoreTick 只做分层编排：
//   L0 反射（复用 l0Rule，0ms，决定"要不要想一下"）
//   L1 会话（复用 microJudge，写 proposal 上黑板）
//   L2 deliberative（只读 authorized_intent；Phase 1 默认不开，
//     开了也只 dry-run：classify+approve 记日志，不执行真工具）
//
// 共享的是黑板 + Belief View，不是决策。每一步 fail-soft：
// core 任一步抛错 → 打日志回退（L1 判走旧链路，不拦旧 pipeline）。
// ────────────────────────────────────────

import { l0Rule } from '../pipeline/judge/judge.js';
import { microJudge } from '../pipeline/judge/micro.js';
import { getRecent } from '../pipeline/context/manager.js';
import { getBotUid, getBotIdentity } from '../bot/bot.js';
import { getActivitySummary } from '../tracking/activity.js';
import { env } from './env-shim.js';
import { logger } from '../shared/logger.js';
import { assembleState, type CoreState } from './state.js';
import { writeEntry, setEntryStatus } from './blackboard/store.js';
import { freezeBeliefSnapshot } from './blackboard/snapshot.js';
import { classify } from './permission/tiers.js';
import { approve } from './permission/gate.js';
import type { FormattedMessage, JudgeResult } from '../shared/types.js';

export type CoreLevel = 'l0-pass' | 'l1-converse' | 'l2-upgrade';

export interface CoreTickInput {
  chatId: number;
  message: FormattedMessage;
  recentMessages: FormattedMessage[];
  burstHint?: string;
  focusLevel?: number;
}

export interface CoreTickResult {
  level: CoreLevel;
  /** L1 的会话判决（复用旧 JudgeResult 形状，下游可直接用） */
  judgeResult?: JudgeResult;
  /** L2 dry-run 的工具审批记录（Phase 1 不执行真工具） */
  l2DryRun?: Array<{ tool: string; tier: string; approved: boolean }>;
  state?: CoreState;
  fallbackToLegacy?: boolean;
}

/**
 * L0 反射：复用 l0Rule（0ms 确定性规则）。
 * 命中 REPLY/IGNORE/REJECT → l0-pass（不用想，旧链路照走）。
 * 未命中 → l1-converse（值得想一下）。
 * 带 @/回复 bot 的直接交互 → l2-upgrade 候选（Phase 1 只记 proposal，不真升）。
 */
export function classifyLevel(
  l0: JudgeResult | null,
  opts: { mentioned: boolean; repliedToBot: boolean },
): CoreLevel {
  if (l0) return 'l0-pass';
  if (opts.mentioned || opts.repliedToBot) return 'l2-upgrade';
  return 'l1-converse';
}

function detectDirectInteraction(
  message: FormattedMessage,
  botUid: number,
  botUsername: string,
  botNicknames: string[],
): { mentioned: boolean; repliedToBot: boolean } {
  const text = message.textContent || message.captionContent || '';
  const lower = text.toLowerCase();
  const mentioned =
    lower.includes(`@${botUsername.toLowerCase()}`) ||
    botNicknames.some((n) => n && lower.includes(n.toLowerCase()));
  return {
    mentioned,
    // replyTo 只有 messageId 没有 uid 时保守判 false（防把路人回复当@我）
    repliedToBot: message.replyTo !== undefined && message.replyTo.uid === botUid,
  };
}

export async function runCoreTick(input: CoreTickInput): Promise<CoreTickResult> {
  const e = env();
  void e;
  const botUid = getBotUid();
  const botIdentity = getBotIdentity();

  // ── assembleState（只读，fail-soft） ──
  let state: CoreState | undefined;
  try {
    state = await assembleState(input.chatId, input.message, input.recentMessages);
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'core assembleState failed, legacy fallback');
    return { level: 'l0-pass', fallbackToLegacy: true };
  }

  // ── L0 反射（复用旧规则，0ms） ──
  const now = Math.floor(Date.now() / 1000);
  let messagesLast5Min = input.recentMessages.filter((m) => m.timestamp >= now - 300).length;
  let messagesLast1Hour = input.recentMessages.filter((m) => m.timestamp >= now - 3600).length;
  try {
    const act = await getActivitySummary(input.chatId);
    messagesLast5Min = Math.max(messagesLast5Min, act.messages5min);
    messagesLast1Hour = Math.max(messagesLast1Hour, act.messages1hour);
  } catch {
    /* fail-soft */
  }
  const l0 = l0Rule({
    message: input.message,
    recentMessages: input.recentMessages,
    botUid,
    botUsername: botIdentity.username,
    botNicknames: botIdentity.nicknames,
    chatId: input.chatId,
    groupActivity: { messagesLast5Min, messagesLast1Hour },
  });

  const direct = detectDirectInteraction(
    input.message,
    botUid,
    botIdentity.username,
    botIdentity.nicknames,
  );
  const level = classifyLevel(l0, direct);

  // L0 observation 上黑板（best-effort，不拦路）
  try {
    writeEntry({
      kind: 'observation',
      author: 'l0',
      content: JSON.stringify({
        level,
        l0rule: l0?.rule ?? null,
        mentioned: direct.mentioned,
        messageId: input.message.messageId,
      }),
      chatId: input.chatId,
    });
  } catch {
    /* non-critical */
  }

  if (level === 'l0-pass') {
    return { level, judgeResult: l0 ?? undefined, state };
  }

  // ── L1 会话（复用 microJudge，结果形状与旧链路一致） ──
  let judgeResult: JudgeResult;
  try {
    judgeResult = await microJudge(
      input.message,
      input.recentMessages,
      botUid,
      'judge',
      state.knowledge,
      input.chatId,
      undefined,
      input.burstHint,
    );
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'core L1 judge failed, legacy fallback');
    return { level, fallbackToLegacy: true, state };
  }

  // L1 proposal 上黑板（"我建议回/不回，因为…"，L2 可执行的 plan 永不直接写）
  try {
    writeEntry({
      kind: 'proposal',
      author: 'l1',
      content: JSON.stringify({
        action: judgeResult.action,
        rule: judgeResult.rule ?? null,
        confidence: judgeResult.confidence ?? null,
        messageId: input.message.messageId,
      }),
      chatId: input.chatId,
    });
  } catch {
    /* non-critical */
  }

  if (level === 'l1-converse') {
    return { level, judgeResult, state };
  }

  // ── L2 upgrade（Phase 1：只 dry-run，不执行真工具） ──
  // 冻结 belief 快照 → L2 看到的是开工前世界。
  try {
    freezeBeliefSnapshot(input.chatId, state.beliefs);
  } catch {
    /* non-critical */
  }
  // 读 authorized_intent（没有 → L2 无事可做，直接回 L1 判决）
  const { listEntries } = await import('./blackboard/store.js');
  const intents = listEntries('authorized_intent', 'open', 5).filter(
    (en) => en.chatId === input.chatId || en.chatId === null,
  );
  if (intents.length === 0) {
    return { level, judgeResult, state, l2DryRun: [] };
  }
  // 有 intent：对 intent 内容里声明的 tool 做 classify+approve，只记日志不执行
  const dryRun: Array<{ tool: string; tier: string; approved: boolean }> = [];
  for (const intent of intents.slice(0, 2)) {
    let tool = 'unknown';
    let args: unknown = {};
    try {
      const parsed = JSON.parse(intent.content) as { tool?: string; args?: unknown };
      tool = parsed.tool ?? 'unknown';
      args = parsed.args ?? {};
    } catch {
      continue;
    }
    const tier = classify(tool, args);
    const ap = await approve(tier, intent.id);
    dryRun.push({ tool, tier, approved: ap.ok });
    logger.info(
      { chatId: input.chatId, tool, tier, approved: ap.ok, intentId: intent.id },
      'core L2 dry-run (no tool executed)',
    );
    void setEntryStatus;
  }
  return { level, judgeResult, state, l2DryRun: dryRun };
}

/** pipeline 侧调用：graylist 内才跑 core，否则直接 legacy（零开销）。 */
export function isCoreChat(chatId: number): boolean {
  // 全开：空名单 = 全量生效（与 SUBAGENT_MEMORY_CHAT_IDS 的空=关闭相反，
  // 与 TURN_ACTOR/MULTI_AGENT 的空=全量一致 —— core 是行为兼容层不是隐私特性）。
  // 要关：设 CORE_V2_ENABLED=false（一刀切）。
  if (!env().CORE_V2_ENABLED) return false;
  const ids = env().CORE_V2_CHAT_IDS.split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => !Number.isNaN(n) && n !== 0);
  if (ids.length === 0) return true;
  void chatId;
  return ids.includes(chatId);
}

/** shadow 入口：pipeline 在 judge 之后调，对比 core 判 vs 旧判，只记日志。 */
export async function shadowCompare(opts: {
  chatId: number;
  message: FormattedMessage;
  legacy: JudgeResult;
  burstHint?: string;
  focusLevel?: number;
}): Promise<void> {
  try {
    const recentMessages = await getRecent(opts.chatId, 30);
    const r = await runCoreTick({
      chatId: opts.chatId,
      message: opts.message,
      recentMessages,
      burstHint: opts.burstHint,
      focusLevel: opts.focusLevel,
    });
    logger.info(
      {
        chatId: opts.chatId,
        messageId: opts.message.messageId,
        legacy: `${opts.legacy.action}/${opts.legacy.level}/${opts.legacy.rule ?? '-'}`,
        core: `${r.level}/${r.judgeResult?.action ?? 'fallback'}/${r.judgeResult?.rule ?? '-'}`,
        agree: r.judgeResult ? r.judgeResult.action === opts.legacy.action : 'n/a',
      },
      'core shadow compare',
    );
  } catch (err) {
    logger.debug({ err, chatId: opts.chatId }, 'core shadow failed (non-critical)');
  }
}
