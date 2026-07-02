// ────────────────────────────────────────
// USE_BOT_COMMAND — 代发其他 bot 的命令(P2,成熟+安全才放行)
// ────────────────────────────────────────
//
// 安全/成熟度闸全在这里硬把关(不靠 prompt)。可代发 → 发 @指向命令 +
// 登记 pendingDelegation,回执由 pipeline 入站匹配后另起回合答用户。
// 不可代发 → 返回原因,让模型改"教用户自己发"。绝不同步阻塞等回执。

import { getRedis } from '../../db/redis.js';
import { getBotUsername } from '../../bot/bot.js';
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
  needs_reply: '这条命令得回复某条消息才生效,代发搞不定',
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

    // 限速:只读检查在前,**不在失败/空操作路径上烧冷却**(review #4)——
    // 真正 armed 放到成功发出之后。
    const redis = getRedis();
    if (await redis.get(COOLDOWN_KEY(chatId))) return '刚替你问过一次了,缓一下再说,别刷屏。';

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
    // 发成功才登记 pending + armed 冷却
    await redis.set(PENDING_KEY(chatId), JSON.stringify(pending), 'EX', PENDING_TTL_SEC);
    await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', Math.max(1, e.BOT_DELEGATION_COOLDOWN_SEC)).catch(() => {});
    logger.info({ chatId, bot, cmd }, 'Delegation: command sent, awaiting receipt');

    return `已经替用户向 @${bot} 发了 ${text},正在等它回结果。现在跟用户说一句"我帮你问问~"之类的过渡话,**不要编造结果**,真结果回来后会自动接着回。`;
  } catch (err) {
    logger.warn({ err, chatId }, 'executeUseBotCommand failed');
    return '代发出了点问题,改成把命令告诉用户让 TA 自己发吧。';
  }
}

/**
 * 模型走 direct 路径时常**直接把 `/命令@bot 参数` 当回复打出去**(没用
 * USE_BOT_COMMAND 工具)—— 这其实有效(对方会回),但没登记 pending,结果
 * 接不回来。这里在出站回复里识别这种自发代发,补登记 pending,让回执照样
 * 被认领。只认"消息开头就是 /cmd@bot"的(排除解释性提到命令的句子)。
 */
export async function maybeRegisterTypedDelegation(chatId: number, text: string, sentMid: number): Promise<void> {
  if (!env().BOT_DELEGATION_ENABLED || chatId >= 0) return;
  const m = text.trim().match(/^(\/[a-zA-Z][a-zA-Z0-9_]{0,30})@(\w+)(?:\s+([\s\S]{0,120}))?$/);
  if (!m) return;
  const cmd = m[1]!.toLowerCase();
  const bot = m[2]!;
  if (bot.toLowerCase() === getBotUsername().toLowerCase()) return; // 别认成自己
  try {
    const redis = getRedis();
    if (await redis.get(PENDING_KEY(chatId))) return; // 已有 pending,不覆盖
    const pending: PendingDelegation = { bot, command: cmd, args: (m[3] || '').trim(), sentMid, issuedAt: Math.floor(Date.now() / 1000) };
    await redis.set(PENDING_KEY(chatId), JSON.stringify(pending), 'EX', PENDING_TTL_SEC);
    logger.info({ chatId, bot, cmd }, 'Delegation: auto-registered from typed command');
  } catch { /* non-critical */ }
}

// 进度占位识别:⏳/Initializing/Querying/正在.../please wait 这类不是最终结果。
// 长度上限放宽到 120(review #9:啰嗦的中文进度句也得认出来),仍设上限避免
// 把"正好含'正在'二字的真结果"误判成占位。
const PROGRESS_RE = /⏳|initializing|querying|loading|正在(查询|搜索|发送|处理|努力)|please\s*wait|稍候|稍等|命中缓存|查询中|搜索中|加载中/i;
function isProgressPlaceholder(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length < 120 && PROGRESS_RE.test(t);
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
  if (!env().BOT_DELEGATION_ENABLED || !formatted.isBot) return false;
  const redis = getRedis();
  let pending: PendingDelegation | undefined;
  try {
    const raw = await redis.get(PENDING_KEY(chatId));
    if (!raw) return false;
    pending = JSON.parse(raw) as PendingDelegation;
  } catch {
    return false;
  }
  if (!pending) return false;
  // 回执认领:目标 bot 常不直接以自己的名义回 —— 可能 via inline(viaBot)、
  // 由配套下载 bot 代发(正文带 "via @目标bot"),或就是自己。三者皆认。
  const target = pending.bot.toLowerCase();
  const fromMatch = (formatted.username || '').toLowerCase() === target;
  const viaMatch = (formatted.viaBot || '').toLowerCase() === target;
  const textMatch = `${formatted.textContent || ''} ${formatted.captionContent || ''}`.toLowerCase().includes(`@${target}`);
  if (!fromMatch && !viaMatch && !textMatch) return false;

  const resultText = (formatted.textContent || formatted.captionContent || '').trim();
  const hasMedia = !!(formatted.audioFileId || formatted.voiceFileId || formatted.documentFileId || formatted.imageFileId || formatted.videoFileId);

  // 纯进度占位 → 不消费,继续等真结果(review #9:含长进度句)
  if (!resultText && !hasMedia && (formatted.inlineKeyboard?.length ?? 0) > 0) {
    // 只有按钮、没正文也没媒体 → 可能是"先发个带按钮的占位,正文随后到"
    // (review #5)。不消费、不放弃,继续等后续真结果;真被按钮 gate 住就让
    // TTL 自然过期。
    return false;
  }
  if (isProgressPlaceholder(resultText)) return false; // 还在跑,继续等
  if (!resultText && !hasMedia) return false; // 空消息,继续等

  // 命中最终结果(文本或媒体):清 pending,另起一条回复
  await redis.del(PENDING_KEY(chatId)).catch(() => {});
  // 媒体类:对方已把文件/音频发到群里(大家都看得见),没有正文时给个说明,
  // 让写手自然致意而不是答"没查到"(review #6)
  const payload = resultText || (hasMedia ? '(对方已经把文件/音频/图片发到群里了)' : '');
  try {
    await answerFromDelegation(chatId, botUid, pending, payload.slice(0, 600));
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
  const { parseReplyResponse, isBlankReply } = await import('../reply/parser.js');

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
  const text = parsed.filter((p) => !p.action || p.action === 'reply').map((p) => p.replyContent.trim()).find((t) => !isBlankReply(t));
  if (!text) return;
  const mid = await sendMessage(chatId, text.slice(0, 500));
  if (mid) await addAssistant(chatId, { textContent: text.slice(0, 500), messageId: mid });
  logger.info({ chatId, bot: pending.bot, cmd: pending.command }, 'Delegation: answered from receipt');
}
