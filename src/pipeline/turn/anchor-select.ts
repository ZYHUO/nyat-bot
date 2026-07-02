// ────────────────────────────────────────
// 多锚点锚点选择 —— 纯函数,无运行时依赖(便于单测)
// ────────────────────────────────────────
//
// flat 群里"线程"≈"人":burst 按发送者 uid 分组,每组各自挑锚点 judge→reply,
// 写手 reply_to 自然落在本人消息上(治"只回最后一条→像回错人")。
// 本模块只做纯计算,不 import 任何有副作用的模块 —— actor.ts 调用它,
// 单测直接 import 本模块即可,无需 mock redis/ai/pipeline。

import type { PendingEntry } from './types.js';

/** 多锚点分组的候选条目(已从 entries 抽出关键字段)。 */
export interface AnchorCandidate {
  idx: number;
  uid: number;
  direct: boolean;
  isEdit: boolean;
  ts: number;
}

/**
 * 多锚点分组选择:按 uid 分组,每组挑组内锚点(组内最后 direct,否则组内最后
 * 非编辑),按"含 direct 优先 + 最新时间倒序"排序,取前 budget 组。全是编辑
 * 的组无锚点(跳过)。返回选中的锚点 idx(按优先序,长度 ≤ budget)。
 *
 * direct 也受 budget 约束 —— 同一波超过 budget 人 @bot 时,只回最新的 budget
 * 个(兑现"每回合最多回 N 人",direct 不再绕过预算)。
 */
export function pickMultiAnchorGroups(
  candidates: AnchorCandidate[],
  budget: number,
): number[] {
  const groups = new Map<number, AnchorCandidate[]>();
  for (const c of candidates) {
    let arr = groups.get(c.uid);
    if (!arr) { arr = []; groups.set(c.uid, arr); }
    arr.push(c);
  }
  const groupAnchors: Array<{ idx: number; hasDirect: boolean; lastTs: number }> = [];
  for (const idxs of groups.values()) {
    let pick: AnchorCandidate | undefined;
    for (let k = idxs.length - 1; k >= 0; k--) {
      if (idxs[k]!.direct) { pick = idxs[k]!; break; }
    }
    if (!pick) {
      for (let k = idxs.length - 1; k >= 0; k--) {
        if (!idxs[k]!.isEdit) { pick = idxs[k]!; break; }
      }
    }
    if (!pick) continue; // 全是编辑 → 该组无锚点
    groupAnchors.push({ idx: pick.idx, hasDirect: pick.direct, lastTs: pick.ts });
  }
  groupAnchors.sort(
    (a, b) => (Number(b.hasDirect) - Number(a.hasDirect)) || (b.lastTs - a.lastTs),
  );
  return groupAnchors.slice(0, Math.max(0, budget)).map((g) => g.idx);
}

/**
 * 从 PendingEntry.update 取发送者 uid。与 formatter.ts 对齐:匿名管理员
 * (from=GroupAnonymousBot 1087968824)/频道代发(from.is_bot + sender_chat)
 * → 用 sender_chat.id;否则用 from.id。确保与 processPipeline 里 formatted.uid
 * 一致,否则 per-person 抑制(waitTriggerUids 来自 formatted.uid)会匹配不上。
 */
export function entryUid(entry: PendingEntry): number {
  const u = entry.update as {
    message?: { from?: { id: number; is_bot?: boolean }; sender_chat?: { id: number } };
    edited_message?: { from?: { id: number; is_bot?: boolean }; sender_chat?: { id: number } };
    channel_post?: { from?: { id: number; is_bot?: boolean }; sender_chat?: { id: number } };
    edited_channel_post?: { from?: { id: number; is_bot?: boolean }; sender_chat?: { id: number } };
  };
  const msg = u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post;
  const from = msg?.from;
  const senderChat = msg?.sender_chat;
  const isAnonymousAdmin = from?.id === 1087968824;
  const isChannelBot = !!(from?.is_bot && senderChat);
  const effectiveSenderChat = (isAnonymousAdmin || !from || isChannelBot) ? senderChat : undefined;
  return effectiveSenderChat ? effectiveSenderChat.id : (from?.id ?? 0);
}

/** 取 update 候选消息的 date/edit_date(多锚点组排序用;无则 0)。 */
export function entryDate(entry: PendingEntry): number {
  const u = entry.update as {
    message?: { date?: number; edit_date?: number };
    edited_message?: { date?: number; edit_date?: number };
    channel_post?: { date?: number; edit_date?: number };
    edited_channel_post?: { date?: number; edit_date?: number };
  };
  const msg = u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post;
  return msg?.edit_date ?? msg?.date ?? 0;
}
