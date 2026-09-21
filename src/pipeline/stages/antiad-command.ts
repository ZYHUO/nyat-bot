// ─────────────────────────────────────────────────────────────────────
// 群主自助开关反广告 —— 确定性命令路径
// ─────────────────────────────────────────────────────────────────────
//
// 2026-09-21 round 135 加。起因是用户实测：在 uzumaru 群对 bot 说
// "开一下反广告"，**什么都没发生**。
//
// 追踪日志看到的形状：
//   message in → Meta dispatch.taskToGroup → CodeAct task start
//   → agent: message routed to running long task as interrupt
// 命令被吸进一个正在跑的长任务，而 `admin.setAntiAd` 在生产里调用次数为 0
// （round 125 的工具清单：广告了 79 个，生产只调过 14 个，它不在其中）。
//
// 一个会删消息、会禁言人的开关，不该只靠模型自己决定调工具。
// 所以这里认句式直接办，管理员校验 fail-closed。

import type { FormattedMessage } from '../../shared/types.js';
import { logger } from '../../shared/logger.js';

/** 开/关反广告的句式。故意窄：只认明确意图，不猜。 */
const ON_PATTERNS = [
  /^(?:请?|帮忙|给我)?\s*(?:开启|打开|开一下|开下|开|启用|开启一下)\s*(?:本群|群里|群|的)?\s*反广告$/,
  /^反广告\s*(?:开启|打开|开一下|启用)$/,
];
const OFF_PATTERNS = [
  /^(?:请?|帮忙|给我)?\s*(?:关闭|关一下|关下|关|停止|禁用)\s*(?:本群|群里|群|的)?\s*反广告$/,
  /^反广告\s*(?:关闭|关一下|停止|禁用)$/,
];

function matches(text: string, pats: RegExp[]): boolean {
  const t = text.trim().replace(/[。！？!?~～\s]+$/g, '');
  return pats.some((p) => p.test(t));
}

/**
 * 认出"开/关反广告"就办。返回 true = 已处理（调用方应短路）。
 *
 * 管理员校验：只有本群管理员/群主能开关。查失败按非管理员处理（fail-closed）。
 */
export async function tryAntiAdCommand(
  chatId: number,
  formatted: FormattedMessage,
): Promise<boolean> {
  const text = (formatted.textContent || formatted.captionContent || '').trim();
  if (!text) return false;

  const on = matches(text, ON_PATTERNS);
  const off = on ? false : matches(text, OFF_PATTERNS);
  if (!on && !off) return false;

  const asker = formatted.uid;
  try {
    const { getBot } = await import('../../bot/bot.js');
    const { isGroupAdmin } = await import('../../admin/bot-permission.js');
    const { sender } = await import('../shared.js');
    const { setAntiAd } = await import('../../nyatos/ad-pressure.js');

    if (!(asker > 0) || !(await isGroupAdmin(getBot(), chatId, asker))) {
      logger.info({ chatId, uid: asker, on }, 'antiad command rejected: not group admin');
      await sender.sendDirect(
        chatId,
        '反广告只有本群管理员/群主能开关喵~',
        formatted.messageId,
      );
      return true; // 认出了句式就短路，别让它再流到模型那儿
    }

    await setAntiAd(chatId, on);
    logger.info({ chatId, uid: asker, on }, 'antiad command applied (deterministic path)');
    await sender.sendDirect(
      chatId,
      on
        ? '好，本群反广告已开启喵。看到刷屏/发广告的我会处理。'
        : '好，本群反广告已关闭喵。',
      formatted.messageId,
    );
    return true;
  } catch (err) {
    logger.warn({ err, chatId, uid: asker, on }, 'antiad command failed');
    return false; // 办失败不短路——让模型还有一次机会
  }
}
