// ────────────────────────────────────────
// USE_BOT_COMMAND — 代发其他 bot 的命令(P2,成熟+安全才放行)
// ────────────────────────────────────────
//
// 安全/成熟度闸全在这里硬把关(不靠 prompt)。可代发 → 发 @指向命令 +
// 登记 pendingDelegation,回执由 pipeline 入站匹配后另起回合答用户。
// 不可代发 → 返回原因,让模型改"教用户自己发"。绝不同步阻塞等回执。

import { getRedis } from '../../db/redis.js';
import { sendMessage } from '../../bot/sender/telegram.js';
import { getCommandProfile, whyNotInvocable } from '../../learners/bot-command-store.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import type { FormattedMessage } from '../../shared/types.js';

export const PENDING_KEY = (chatId: number): string => `xxb:delegation:${chatId}`;
const COOLDOWN_KEY = (chatId: number): string => `xxb:delegation:cd:${chatId}`;
const PENDING_TTL_SEC = 90;

export interface PendingDelegation {
  bot: string;          // 目标 bot username(不含 @)
  command: string;      // /geo
  args: string;
  sentMid: number;      // 我们发出的命令消息 id
  issuedAt: number;     // epoch sec
}

const WHY_TEXT: Record<string, string> = {
  unknown_command: '还没学过这个 bot 的这条命令,不能代发',
  blocked_by_safety: '这是管理/敏感类命令,不能代发',
  needs_admin: '这条命令需要管理员权限,我没有,不能代发',
  not_mature_count: '这条命令还没观察够次数,不敢乱发',
  not_mature_confidence: '对这条命令还没把握,不敢乱发',
  output_unreachable: '这条命令的结果藏在按钮后面,bot 点不了,代发也拿不到',
  peer_ignores_bots: '那个 bot 不理会其他 bot 发的命令',
};

/**
 * 代发一条其他 bot 的命令。返回给模型的文本(成功=过渡指示;失败=原因 +
 * 建议改教用户)。execute 永不抛(AI SDK v4:抛会整轮 reject)。
 */
export async function executeUseBotCommand(
  chatId: number,
  botUsername: string,
  command: string,
  args: string,
): Promise<string> {
  try {
    const e = env();
    if (!e.BOT_DELEGATION_ENABLED) {
      return '代发功能没开;可以把命令告诉用户,让 TA 自己发。';
    }
    if (chatId >= 0) return '私聊里没有其他 bot 可借力。';

    const bot = botUsername.replace(/^@/, '');
    const cmd = command.trim().toLowerCase().split('@')[0]!;
    if (!/^\/[a-z0-9_]+$/.test(cmd) || !bot) {
      return '命令格式不对(应是 /xxx 形式 + bot 用户名)。';
    }

    const profile = getCommandProfile(bot, cmd);
    const why = whyNotInvocable(profile);
    if (why) {
      const reason = WHY_TEXT[why] ?? '暂时不能代发';
      // 可读类(url/有语法)仍可教用户自己发
      const teach = profile?.usage_syntax
        ? `要的话可以建议用户自己发:${profile.usage_syntax}@${bot}`
        : '';
      return `${reason}。${teach}`.trim();
    }

    // 限速:同 chat 两次代发最小间隔
    const redis = getRedis();
    const cd = await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', Math.max(1, e.BOT_DELEGATION_COOLDOWN_SEC), 'NX');
    if (cd === null) return '刚替你问过一次了,缓一下再说,别刷屏。';

    // 已有未完成的代发 → 不并发(回执匹配会乱)
    const existing = await redis.get(PENDING_KEY(chatId));
    if (existing) return '上一条代发还在等回执,先等等。';

    const cleanArgs = (args || '').trim().slice(0, 120);
    const text = `${cmd}@${bot}${cleanArgs ? ' ' + cleanArgs : ''}`;
    const sentMid = await sendMessage(chatId, text);
    if (!sentMid) return '代发没发出去,稍后再试。';

    const pending: PendingDelegation = {
      bot, command: cmd, args: cleanArgs, sentMid, issuedAt: Math.floor(Date.now() / 1000),
    };
    await redis.set(PENDING_KEY(chatId), JSON.stringify(pending), 'EX', PENDING_TTL_SEC);
    logger.info({ chatId, bot, cmd }, 'Delegation: command sent, awaiting receipt');

    return `已经替用户向 @${bot} 发了 ${text},正在等它回结果。现在跟用户说一句"我帮你问问~"之类的过渡话,**不要编造结果**,真结果回来后会自动接着回。`;
  } catch (err) {
    logger.warn({ err, chatId }, 'executeUseBotCommand failed');
    return '代发出了点问题,改成把命令告诉用户让 TA 自己发吧。';
  }
}

// 进度占位识别:⏳/Initializing/Querying/正在.../please wait 这类不是最终结果
const PROGRESS_RE = /⏳|initializing|querying|loading|正在(查询|发送|处理)|please\s*wait|稍候|命中缓存/i;
function isProgressPlaceholder(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length < 40 && PROGRESS_RE.test(t);
}

/**
 * 入站消息是不是某条代发的回执;是则消费它并另起一条回复用结果答原问题。
 * 返回 true = 已处理(调用方应 return,别再走 judge)。
 * 目标 bot 常"先占位再出结果",占位消息不消费 pending(继续等)。
 */
export async function tryHandleDelegationReceipt(
  chatId: number,
  formatted: FormattedMessage,
  botUid: number,
): Promise<boolean> {
  if (!env().BOT_DELEGATION_ENABLED || !formatted.isBot || !formatted.username) return false;
  const redis = getRedis();
  let pending: PendingDelegation | undefined;
  try {
    const raw = await redis.get(PENDING_KEY(chatId));
    if (!raw) return false;
    pending = JSON.parse(raw) as PendingDelegation;
  } catch {
    return false;
  }
  if (!pending || formatted.username.toLowerCase() !== pending.bot.toLowerCase()) return false;

  const resultText = (formatted.textContent || formatted.captionContent || '').trim();
  // 结果藏在按钮后 / 纯进度占位 → 不消费,继续等真结果(TTL 到了自然放弃)
  const buttonsOnly = !resultText && (formatted.inlineKeyboard?.length ?? 0) > 0;
  if (buttonsOnly) {
    await redis.del(PENDING_KEY(chatId)).catch(() => {});
    logger.info({ chatId, bot: pending.bot }, 'Delegation: result gated behind buttons, giving up');
    return true; // 消费掉(避免把按钮消息当普通 bot 消息),但不答(够不到)
  }
  if (isProgressPlaceholder(resultText)) return false; // 还在跑,继续等

  // 命中最终结果:清 pending,另起一条回复用结果答原问题
  await redis.del(PENDING_KEY(chatId)).catch(() => {});
  try {
    await answerFromDelegation(chatId, botUid, pending, resultText.slice(0, 600));
  } catch (err) {
    logger.warn({ err, chatId }, 'Delegation: answer generation failed');
  }
  return true;
}

async function answerFromDelegation(
  chatId: number,
  botUid: number,
  pending: PendingDelegation,
  resultText: string,
): Promise<void> {
  const { getRecent, addAssistant } = await import('../context/manager.js');
  const { slimContextForAI } = await import('../context/slim.js');
  const { buildSystemPrompt } = await import('../reply/prompt-builder.js');
  const { callWithFallback } = await import('../../ai/fallback.js');
  const { parseReplyResponse } = await import('../reply/parser.js');

  const recent = await getRecent(chatId, 15);
  if (recent.length === 0) return;
  const current = recent.at(-1)!;
  const contextStr = slimContextForAI(recent.slice(0, -1), current, botUid);
  const systemPrompt = buildSystemPrompt('normal', undefined, chatId);
  const userMsg =
    `[群聊上下文]\n${contextStr}\n\n` +
    `[代发结果] 你刚才替群里某人向 @${pending.bot} 发了 ${pending.command}${pending.args ? ' ' + pending.args : ''},它回的结果是:\n「${resultText}」\n\n` +
    `用这个结果,自然口语地回答群友最初的问题。别复述命令、别说"我代发/我查询",就像你自己知道一样顺口说出来。结果用不上或为空就说没查到。输出 JSON。`;

  const result = await callWithFallback({
    usage: 'reply',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ],
    maxTokens: 400,
    temperature: 0.8,
  });
  const parsed = parseReplyResponse(result.content, current.messageId);
  if (parsed.some((p) => p.action === 'silent')) return;
  const text = parsed.filter((p) => !p.action || p.action === 'reply').map((p) => p.replyContent.trim()).find((t) => t.length >= 1);
  if (!text) return;
  const mid = await sendMessage(chatId, text.slice(0, 500));
  if (mid) await addAssistant(chatId, { textContent: text.slice(0, 500), messageId: mid });
  logger.info({ chatId, bot: pending.bot, cmd: pending.command }, 'Delegation: answered from receipt');
}
