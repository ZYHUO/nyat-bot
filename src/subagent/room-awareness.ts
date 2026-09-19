// ────────────────────────────────────────
// 房间感知注入 — 让 CodeAct 任务 prompt 带上"这个房间里正在发生什么"
// ────────────────────────────────────────
//
// 为什么需要它（2026-09-19 真人对比分析）：
// 真人群友的消息**不是**对被引用消息的反应——
//   - 「插你的色屁股」「你一个机器人有个狗屁对讲机」——直白粗鲁
//   - 「就是一个ip对应一个v4或者v4+v6」「这种场景建议是分流走」——**主动贡献知识**，没人问
//   - 「后来隔了整整一天才看到消息」——**讲自己的事**，没人问
// 而 bot 的每一条发言都锚定在"上一条消息"上：它永远在**回应**，从不在**参与**。
// 这是"差一口气"的最大来源，不是措辞问题（bot 的短嘲其实已经很像人：
// "欠费艺术家"、"原生橘喵，血统自带喵"）。
//
// frame.ts 里其实**已经算好**了这些信号（谁在跟谁说话 / 未了话题 / 我的发言占比 /
// 我多久没说话），但它们只喂给 NyatOS shadow——而 shadow 在生产里只对 3 个群
// 开着（NYATOS_SHADOW_CHAT_IDS），**主回复路径一个字都用不到**。
// 这就是"模块存在但没接线"的又一例：造好了房间感知，驱动回复的 prompt 却看不到。
//
// 本模块只做一件事：把 frame 渲染进任务 prompt。不改变任何决策逻辑，
// fail-soft（读不到就不加），flag 默认关。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface RoomAwarenessInput {
  chatId: number;
  botUid: number;
  /** 本次任务要回的那条消息 id（用于 triggerAge）与 forum 线程 */
  quoteMessageId?: number;
  messageThreadId?: number;
}

export interface RoomAwareness {
  /** 渲染好的文本块；为空字符串表示没拿到可用信号 */
  text: string;
  /** 供日志/观测 */
  signals: string[];
}

/**
 * 渲染一段「你现在在这个房间里的处境」。fail-soft：任何一环读不到就少一段，
 * 全读不到返回空字符串（调用方直接跳过注入）。
 */
export async function renderRoomAwareness(input: RoomAwarenessInput): Promise<RoomAwareness> {
  if (!env().ROOM_AWARENESS_ENABLED) return { text: '', signals: [] };
  const signals: string[] = [];
  try {
    const { buildFrame, renderFrame } = await import('../nyatos/frame.js');
    const { getBotIdentity, getBotDisplayName } = await import('../bot/bot.js');
    const identity = getBotIdentity();

    const frame = await buildFrame({
      scope: { visibility: 'chat', chatId: input.chatId },
      trigger: {
        messageId: input.quoteMessageId ?? 0,
        role: 'user',
        uid: 0,
        username: '',
        fullName: '',
        timestamp: nowSec(),
        textContent: '',
        isForwarded: false,
        ...(input.messageThreadId !== undefined ? { messageThreadId: input.messageThreadId } : {}),
      },
      recent: [],
      botUid: input.botUid,
      botUsername: identity.username,
      botDisplayName: getBotDisplayName(),
    });
    const rendered = renderFrame(frame, { maxMessages: 8, maxChars: 1200 }).trim();
    if (!rendered) return { text: '', signals };

    if (frame.field) signals.push('field');
    if (frame.inner) signals.push('inner');
    const lines: string[] = [];
    lines.push('[这个房间现在什么样]（以下是你的处境感知，不是要你汇报的内容）');
    lines.push(rendered);
    lines.push(
      '用法：真人不是只回"上一条"的——他们看圈子在聊什么、自己多久没说话、有没有人正在跟自己说话。' +
      '上面的信息是给你判断"现在该不该说、说给谁、说什么"用的，**不要**把这些字段名念出来。',
    );
    if (frame.self.openThreads) signals.push('threads');
    if (frame.addressedToOthers) signals.push('addressed_to_others');
    return { text: lines.join('\n'), signals };
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'room awareness unavailable — skip injection');
    return { text: '', signals };
  }
}
