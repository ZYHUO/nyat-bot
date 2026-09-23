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
import { getCommandProfile, whyNotInvocable, listReplyInvocableCommands, whyNotReplyInvocable } from '../../learners/bot-command-store.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import type { FormattedMessage } from '../../shared/types.js';
import { incrCounter } from '../../metrics/registry.js';

export const PENDING_KEY = (chatId: number): string => `xxb:delegation:${chatId}`;
const COOLDOWN_KEY = (chatId: number): string => `xxb:delegation:cd:${chatId}`;
/** round 55（用户报"呼味将出去调用"）：目标 bot 在不在这个群的缓存。 */
const IN_CHAT_KEY = (chatId: number, bot: string): string => `xxb:delegation:inchat:${chatId}:${bot.toLowerCase()}`;
/** 缓存 10 分钟：getChatMember 是一次网络请求，而代发本身不频繁。 */
const IN_CHAT_TTL_SEC = 600;

/**
 * 目标 bot 在不在这个群。
 *
 * 2026-09-23（用户："这个群里没有那个 bot 也去调用，结果啥都没有还天天调用"）。
 *
 * 先验证再修（通过 GLOBAL_FETCH_PROXY 直连 Telegram，本地 DNS 把 api.telegram.org
 * 解析到 Facebook 的 IP，不走代理连不上）。今天 18 次代发里 **5 个目标不在群**：
 *   -1004430867819 @uzumaru_geoip_bot  left
 *   -1003543275052 @uzumaru_geoip_bot  left
 *   -1004451430063 @KairoClaw_bot      left
 *   -1003350411234 @uzumaru_geoip_bot  left
 *   -1002683458784 @KairoClaw_bot      left
 * 只有 -1003543275052 的 KairoClaw_bot 真的在（administrator）。
 *
 * 后果：代发进没有目标 bot 的群，那条消息没人接，于是 38 次代发无回执。
 * 而冷却/PENDING 按 chatId 计，所以它会在每个群里反复试。
 *
 * fail-open：查不动（网络/权限）旵3 true 继续发。否则一次 getChatMember
 * 故障就会把所有代发全撞停——那是另一种"啥都没有"。
 */
async function targetBotInChat(chatId: number, botName: string): Promise<boolean> {
  const key = IN_CHAT_KEY(chatId, botName);
  try {
    const cached = await getRedis().get(key);
    if (cached === '0') return false;
    if (cached === '1') return true;
  } catch { /* cache miss -> 下面两层 */ }

  // 第一层：本地 db。零网络、毫秒级、有 (chat_id, bot_username) 索引。
  try {
    const { getDb } = await import('../../db/sqlite.js');
    const row = getDb().prepare(
      'SELECT 1 FROM bot_interactions WHERE chat_id = ? AND bot_username = ? LIMIT 1',
    ).get(chatId, botName) as unknown;
    if (row) {
      void getRedis().set(key, '1', 'EX', IN_CHAT_TTL_SEC).catch(() => {});
      return true;
    }
  } catch { /* db 不可用 -> 落到 Telegram */ }

  // 第二层：db 没记录 —— 可能真不在群，也可能在群但沉默。歧义只能用 Telegram 解。
  try {
    const { getBot } = await import('../../bot/bot.js');
    // ⚠️ getChatMember 的 user_id **不吃 @username**（实测 Bad Request:
    // invalid user_id specified）——它要数字 uid，而这里只有用户名。
    // 所以先 getChat(@name) 拿 id，再 getChatMember。
    const api = getBot().api;
    const info = await api.getChat('@' + botName);
    const m = await api.getChatMember(chatId, info.id);
    const status = (m as { status?: string }).status ?? '';
    const inChat = status !== 'left' && status !== 'kicked';
    void getRedis().set(key, inChat ? '1' : '0', 'EX', IN_CHAT_TTL_SEC).catch(() => {});
    return inChat;
  } catch {
    logger.debug({ chatId, botName }, 'delegation: target-in-chat check failed, fail-open');
    return true;
  }
}
/**
 * 未完成代发的回执等待窗口。
 *
 * 2026-09-22 round 6：90s → 180s。subagent 审计实测：生产里 4 次成功代发，
 * **只有 1 次等到回执**（`Delegation: answered from receipt` ×1），
 * 另外 3 次用户看到的是"我帮你问问~"然后**永远没有下文**——
 * pending 到期静默消失，没有任何日志、没有任何补救。
 *
 * 翻日志那 3 次的形状：`/geo@uzumaru_geoip_bot` 发出去之后，
 * 那个群此后再没有该 bot 的入站消息。是 peer 不理 bot 发的命令，
 * 还是它回在 90s 之外——**分不清，因为过期时连一行日志都没有**。
 *
 * 所以两件事一起做：
 *   ① 窗口翻倍到 180s（对查股价/IP 这类足够，又不至于让下一轮代发干等太久）
 *   ② 下游 `claimPending`/回执匹配那边加"过期即 warn"，让"静默消失"变可观测
 *      （见 tryClaimDelegationReceipt 的调用方 handleDelegationReceipt）
 */
const PENDING_TTL_SEC = 180;

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
export interface DelegateResult {
  /** 命令是否真的发出去了(供调用路由判断"是否短路正常回复")。 */
  sent: boolean;
  /** 返回给模型/调用方的文本(成功=过渡指示;失败=原因 + 建议改教用户)。 */
  text: string;
}

/** 代发核心:返回结构化结果(sent + text)。安全/成熟度/冷却/并发闸全在这。 */
export async function tryDelegateCommand(
  chatId: number,
  botUsername: string,
  command: string,
  args: string,
): Promise<DelegateResult> {
  try {
    const e = env();
    if (!e.BOT_DELEGATION_ENABLED) {
      return { sent: false, text: '代发功能没开;可以把命令告诉用户,让 TA 自己发。' };
    }
    if (chatId >= 0) return { sent: false, text: '私聊里没有其他 bot 可借力。' };

    const bot = botUsername.replace(/^@/, '');
    const cmd = command.trim().toLowerCase().split('@')[0]!;
    if (!/^\/[a-z0-9_]+$/.test(cmd) || !bot) {
      return { sent: false, text: '命令格式不对(应是 /xxx 形式 + bot 用户名)。' };
    }

    const profile = getCommandProfile(bot, cmd);
    const why = whyNotInvocable(profile);
    if (why) {
      const reason = WHY_TEXT[why] ?? '暂时不能代发';
      const teach = profile?.usage_syntax
        ? `要的话可以建议用户自己发:${profile.usage_syntax}@${bot}`
        : '';
      return { sent: false, text: `${reason}。${teach}`.trim() };
    }

    // 限速:只读检查在前,**不在失败/空操作路径上烧冷却**(review #4)——
    // 真正 armed 放到成功发出之后。
    const redis = getRedis();
    if (await redis.get(COOLDOWN_KEY(chatId))) return { sent: false, text: '刚替你问过一次了,缓一下再说,别刷屏。' };

    // 已有未完成的代发 → 不并发(回执匹配会乱)
    const existing = await redis.get(PENDING_KEY(chatId));
    if (existing) return { sent: false, text: '上一条代发还在等回执,先等等。' };

    // round 55: **目标 bot 不在这个群就别发**。
    // 用户原话："这个群里没有那个 bot 也去调用，结果啥都没有还天天调用"。
    // 今天 18 次代发里 5 个目标不在群（uzumaru_geoip_bot 在 4 个群 left；
    // KairoClaw_bot 在 3 个群里 2 个 left）——发进去没人接，就是 38 次无回执的来源。
    if (!(await targetBotInChat(chatId, bot))) {
      // round 84：挡住要**可数**。round 55 加这个检查时只验证了"生效前有 5/6
      // 目标不在群"，之后没有任何数据说明它还在挡——防问题的 guard
      // 看不出自己是真在挡还是没被调用,是这一家族的通病
      //（round 75 截断重试走 debug / round 77 sticker pick 返裸 null /
      // round 78 reflection 和心流共账号）。
      //
      // 顺带：66 次代发里 38 次无回执——那个形状 round 55 也见过。
      // 有了这个计数就能分清"挡掉了"和"发了但没人接"。
      logger.info({ chatId, bot, cmd }, 'delegation: target bot not in chat — blocked');
      incrCounter('delegation_target_absent_total', { chat: chatId });
      return { sent: false, text: `${bot} 不在这个群里,代发了也没人接。` };
    }

    // round 169（计划第 2 步）：**arity-aware 的缺参闸。**
    //
    // 现场（2026-09-23 15:05）：代发 /geo 给 uzumaru_geoip_bot 时 args 为空，
    // 对端回用法说明，然后它自己编了个 8.8.8.8。第 1 步修"把退回当结果解"，
    // 这里修"根本就不该发的也发了"。
    //
    // 判据用库里已有的 usage_syntax 推 arity，**不用全局 IP 正则**（k3 评审点出的坑：
    // 1.1.1.1:8443 / 8.8.8.8/29 会漏；v2.1 / a.b / 文件名乱放行；而
    // "3U 预计100地区"里的 100 不是 IP——现场那句就是反例）。
    //
    //   /geo <IP或域名>    有占位 → 要参数
    //   /music <歌名>      有占位 → 要参数
    //   /q、/re、/checkin  无占位 → 不要参数，绝不拦
    //
    // 形状认两种：尖括号/方括号占位，和命令名之后还有裸 token。
    if (usageNeedsArg(profile?.usage_syntax) && !(args || '').trim()) {
      // 兜底：人类这条消息本身可能就带了实参（点名让查 1.1.1.1）。
      // 查不到才拦——否则会把"人明明给了 IP"的也吞掉。
      if (!(await humanMessageCarriesArg(chatId, profile?.usage_syntax))) {
        // round 84 的形状：挡住要**可数**，否则说不清"挡掉了"还是"没被调用"。
        logger.info(
          { chatId, bot, cmd, syntax: profile?.usage_syntax },
          'delegation: command needs an argument but none was given — blocked',
        );
        incrCounter('delegation_missing_args_total', { chat: chatId, bot, cmd });
        return {
          sent: false,
          text: `${profile?.usage_syntax ?? cmd} 这个命令要带参数,群里没人给。` +
            '直接跟群友说要查的那个(IP/域名/关键词),别自己编一个填进去。',
        };
      }
    }

    const cleanArgs = (args || '').trim().slice(0, 120);
    const text = `${cmd}@${bot}${cleanArgs ? ' ' + cleanArgs : ''}`;
    const sentMid = await sendMessage(chatId, text);
    if (!sentMid) return { sent: false, text: '代发没发出去,稍后再试。' };

    const pending: PendingDelegation = {
      bot, command: cmd, args: cleanArgs, sentMid, issuedAt: Math.floor(Date.now() / 1000),
    };
    // 发成功才登记 pending + armed 冷却
    await redis.set(PENDING_KEY(chatId), JSON.stringify(pending), 'EX', PENDING_TTL_SEC);
    await redis.set(COOLDOWN_KEY(chatId), '1', 'EX', Math.max(1, e.BOT_DELEGATION_COOLDOWN_SEC)).catch(() => {});
    logger.info({ chatId, bot, cmd }, 'Delegation: command sent, awaiting receipt');

    return {
      sent: true,
      text: `已经替用户向 @${bot} 发了 ${text},正在等它回结果。现在跟用户说一句"我帮你问问~"之类的过渡话,**不要编造结果**,真结果回来后会自动接着回。`,
    };
  } catch (err) {
    logger.warn({ err, chatId }, 'tryDelegateCommand failed');
    return { sent: false, text: '代发出了点问题,改成把命令告诉用户让 TA 自己发吧。' };
  }
}

// ────────────────────────────────────────
// 回复式代发（bots.command 带 replyToMessageId）—— 让别的 bot 代罚
// ────────────────────────────────────────
//
// 为什么需要这条独立路径
// ────────────────────
// nmbot 的入群验证消息带 5 个按钮（在 App 中验证 / 打开浏览器验证 /
// 通过 / 拒绝 / 拒绝并举报骚扰），封禁回执带 2 个（解除封禁 / 举报骚扰）。
// **这些按钮我们点不了**：Telegram 的 callback_query 只能由真人点击产生，
// 没有 API 能让 bot 合成一次点击。pipeline/context/slim.ts 早就把它们渲染成
// "通过(需点击)" 告诉模型"这数据你够不到"。
//
// 但 nmbot 同时认命令，且其中几条**必须回复某条消息才生效**——档案里
// `/spam` 是 needs_reply=1、18 次观察、confidence 0.95、status=ready。
// 回复那条广告发 `/spam@nmnmfunbot`，效果就等于有人按了「拒绝并举报骚扰」：
// nmBot 封禁该用户并向 nmBot 举报。这就是 bot 唯一够得到的代罚通道。
//
// 与 admin.kick 的关系：**共用同一把钥匙**（ANTIAD_KICK_ENABLED 或该群已授权
// 反广告）。踢人是把号请出群（不可逆），/spam 是让群管 bot 记档封禁——
// 两者都是重手，都只在该群群主要过反广告之后才可用，且都由模型决定用不用。

const REPLY_PENDING_KEY = (chatId: number): string => `xxb:delegation:reply:${chatId}`;
const REPLY_COOLDOWN_KEY = (chatId: number): string => `xxb:delegation:reply:cd:${chatId}`;
const REPLY_COUNT_KEY = (chatId: number): string => `xxb:delegation:reply:n:${chatId}`;
const REPLY_PENDING_TTL_SEC = 30;

const REPLY_WHY_TEXT: Record<string, string> = {
  unknown_command: '还没学过这个 bot 的这条命令',
  blocked_by_safety: '这是管理/敏感类命令,硬禁,不能代发',
  needs_admin: '这条命令需要管理员权限,不能代发',
  not_reply_command: '这条命令不需要回复某条消息——那种走普通代发(USE_BOT_COMMAND),不走回复式',
  not_mature_count: '这条命令还没观察够次数,不敢乱发',
  not_mature_confidence: '对这条命令还没把握,不敢乱发',
  output_unreachable: '这条命令的结果藏在按钮后面,拿不到',
  peer_ignores_bots: '那个 bot 不理会其他 bot 发的命令',
};

/** 合法清单的一行说明（给模型指路用）。 */
function replyMenuLine(): string {
  const list = listReplyInvocableCommands();
  if (list.length === 0) return '（当前一条都没有）';
  return list.map((c) => `${c.command}@${c.bot}（${c.useScenario || c.usageSyntax || '用途未知'}）`).join('；');
}

/**
 * 回复式代发。replyToMessageId 必填——它就是"按按钮"的替代物。
 * 永不抛：失败返回 { sent:false, text:原因+指路 }。
 */
export async function tryDelegateReplyCommand(
  chatId: number,
  botUsername: string,
  command: string,
  args: string,
  replyToMessageId: number,
): Promise<DelegateResult> {
  try {
    const e = env();
    if (!e.BOT_REPLY_DELEGATION_ENABLED) {
      return { sent: false, text: '回复式代发没开(BOT_REPLY_DELEGATION_ENABLED)。' };
    }
    if (chatId >= 0) return { sent: false, text: '私聊里没有别的 bot 可借力。' };

    const bot = botUsername.replace(/^@/, '');
    const cmd = command.trim().toLowerCase().split('@')[0]!;
    if (!/^\/[a-z0-9_]+$/.test(cmd) || !bot) {
      return { sent: false, text: '命令格式不对(应是 /xxx 形式 + bot 用户名)。' };
    }
    const mid = Math.floor(Number(replyToMessageId));
    if (!Number.isFinite(mid) || mid <= 0) {
      return { sent: false, text: 'replyToMessageId 必填——回复式代发必须挂在某条真实消息上。' };
    }

    // **授权与 admin.kick 同一把钥匙**：群主没要反广告，就一张牌都不能打。
    const { antiAdEnabled } = await import('../../nyatos/ad-pressure.js');
    const ownerGranted = e.ANTIAD_KICK_ENABLED === true || (await antiAdEnabled(chatId));
    if (!ownerGranted) {
      return {
        sent: false,
        text: '这个群没授权反广告(ANTIAD_KICK_ENABLED 关着,也没有 xxb:trench:antiad 授权键)。让群主先说"开反广告"。',
      };
    }

    const profile = getCommandProfile(bot, cmd);
    const why = whyNotReplyInvocable(profile);
    if (why) {
      const reason = REPLY_WHY_TEXT[why] ?? '暂时不能回复式代发';
      return {
        sent: false,
        text: `${reason}。当前可回复式代发的只有:${replyMenuLine()}`,
      };
    }

    // 回复目标必须是我们**真的见过**的那条消息——防模型拿一个臆想的 messageId
    // 去回复（回复到不存在的消息上，Telegram 直接 400，白烧一次配额）。
    const { getRecent } = await import('../../pipeline/context/manager.js');
    const recent = await getRecent(chatId, 60);
    const target = recent.find((m) => m.messageId === mid);
    if (!target) {
      return { sent: false, text: `最近 60 条里没有 messageId=${mid} 这条消息——换个真存在的 id。` };
    }

    const redis = getRedis();
    if (await redis.get(REPLY_COOLDOWN_KEY(chatId))) {
      return { sent: false, text: '刚代罚过一次,缓一下——群管动作连着来就像机器。' };
    }
    const n = Number((await redis.get(REPLY_COUNT_KEY(chatId))) ?? 0);
    if (n >= e.BOT_REPLY_DELEGATION_MAX_PER_HOUR) {
      return { sent: false, text: `这个群这一小时已经代罚 ${n} 次了(上限 ${e.BOT_REPLY_DELEGATION_MAX_PER_HOUR})。先观察,真要继续找群主。` };
    }

    const cleanArgs = (args || '').trim().slice(0, 120);
    const text = `${cmd}@${bot}${cleanArgs ? ' ' + cleanArgs : ''}`;
    const sentMid = await sendMessage(chatId, text, mid);
    if (!sentMid) return { sent: false, text: '代罚没发出去,稍后再试。' };

    // 只登记一个短命"正在等回执"标记，**不登记 pendingDelegation**——
    // nmbot 的封禁回执不是"用户问题的答案"，不该被 tryHandleDelegationReceipt
    // 抓去另起一条回复。它会自然进上下文，模型自己看得见。
    await redis.set(REPLY_PENDING_KEY(chatId), String(sentMid), 'EX', REPLY_PENDING_TTL_SEC).catch(() => {});
    await redis.set(REPLY_COOLDOWN_KEY(chatId), '1', 'EX', Math.max(1, e.BOT_REPLY_DELEGATION_COOLDOWN_SEC)).catch(() => {});
    await redis.incr(REPLY_COUNT_KEY(chatId)).catch(() => {});
    await redis.expire(REPLY_COUNT_KEY(chatId), 3600).catch(() => {});
    logger.info(
      { chatId, bot, cmd, replyTo: mid, targetUid: target.uid, targetText: (target.textContent ?? '').slice(0, 40) },
      'Delegation: reply-command sent (bot 代罚)',
    );

    return {
      sent: true,
      text: `已经回复那条消息向 @${bot} 发了 ${text}。它会自己封禁并举报,回执随后会出现在上下文里——**别急着跟群友宣布结果**,等真回执到了再说。`,
    };
  } catch (err) {
    logger.warn({ err, chatId }, 'tryDelegateReplyCommand failed');
    return { sent: false, text: '代罚除了点问题,这次先别用了。' };
  }
}

/** AI SDK 工具入口:只返文本(契约不变)。永不抛。 */
export async function executeUseBotCommand(
  chatId: number,
  botUsername: string,
  command: string,
  args: string,
): Promise<string> {
  return (await tryDelegateCommand(chatId, botUsername, command, args)).text;
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

// round 168（计划第 1 步）：**命令被对端退回**的识别，与 isProgressPlaceholder 同级。
//
// 现场（2026-09-23 15:05，群 -1003184176508）：
//   15:05:20 代发 /geo 给 uzumaru_geoip_bot —— 无参数
//   15:05:22 对端回 "Please provide an IP or domain / Usage: /geo IP_or_domain"
//   15:05:3x 它把这个当成"查询结果"，按 answerFromDelegation 的指示
//            （"结果用不上或为空就说没查到"）解了一句"没查到相关数据喵"
//
// 所以在旧代码里它既不是结果也不是占位，而是**第三种**回执：
// 命令根本不成立，再发一次也一样。必须和"结果"分开处理，
// 否则就是教模型把用法说明当数据解。
//
// 判据收紧：必须是明显的 usage/参数缺失形状，且短（真结果也可能含 "Usage" 一词，
// 所以加长度上限，和 isProgressPlaceholder 同一个思路）。
const REJECTION_RE = /usage\s*:|please\s*(provide|specify|enter)|命令格式|用法|使用方法|缺少参数|参数不足|参数错误|无效参数|invalid\s*(argument|usage|command)|missing\s*(argument|parameter)|required argument/i;
// round 169：usage_syntax 是否要求参数。判据只认两种形状，认不出来的一律
// **不当成要参数**——漏拦好过误拦：误拦会让该发的也不发，而漏拦有第 1 步兜底。
function usageNeedsArg(usageSyntax: string | undefined): boolean {
  const s = (usageSyntax || '').trim();
  if (!s) return false;
  // 形状一：占位符 <IP或域名> / [链接] / <me|chat|ID|用户名|链接>
  if (/[<\[][^>\]]{1,60}[>\]]/.test(s)) return true;
  // 形状二：命令名之后还有裸 token（"/geo IP 域名"）。
  // 但"或回复消息使用"这类是说明不是参数要求，排除掉。
  const rest = s.replace(/^\/[a-z0-9_]+/i, '').trim();
  if (rest && !/^(或|回复消息|回复时)/.test(rest)) return true;
  return false;
}

/**
 * 最近几条人类消息里有没有"像实参"的串（IP / 域名 / 普通关键词）。
 * 只为兜底"人明明给了实参"，所以判据故意宽——宽一点只会少拦，
 * 不会造成"该发的也不发"。
 */
async function humanMessageCarriesArg(
  chatId: number,
  usageSyntax?: string,
): Promise<boolean> {
  // round 201：**按占位符的形状判，不再"任何中文就算带了参"。**
  //
  // 现场：全日志 72 条 delegated learned command 里 36 条本该被这个闸拦，
  // 而闸的日志出现 0 次。原因就是原来第三个条件太宽：
  //
  //   // 任何 >=2 字的非纯标点串
  //   if (/[\u4e00-\u9fa5\w]{2,}/.test(t)) return true;
  //
  // 群聊里最近 6 条人类消息几乎总有两个以上中文字符，于是这个函数几乎
  // 恒为 true——**闸永远不拦**。
  //
  // 现在：占位符里写什么，就只认什么形状。推不出来的形状 → fail-open
  // （宁可少拦，不可误拦——和 round 169 的 usageNeedsArg 同一个原则）。
  const shapes = argShapesFor(usageSyntax);
  if (shapes.length === 0) return true;
  try {
    const { getRecent } = await import('../context/manager.js');
    const recent = await getRecent(chatId, 6);
    for (const m of recent) {
      if (m.role !== 'user' || m.isBot) continue;
      const t = (m.textContent || '').trim();
      if (!t) continue;
      for (const re of shapes) if (re.test(t)) return true;
    }
    return false;
  } catch {
    return true;   // 读不到上下文时不拦（fail-open）
  }
}

/**
 * round 201：从 `usage_syntax` 的占位符文字推它要什么形状。
 * `/geo <IP或域名>` → [IPv4, 域名]；`/copy [@用户名]` → [@name]；`/jx [链接]` → [URL]。
 * 推不出来返回 []（调用方据此 fail-open）。
 */
function argShapesFor(usageSyntax: string | undefined): RegExp[] {
  if (!usageSyntax) return [];
  const placeholders = [...usageSyntax.matchAll(/[<[]([^>\]]{1,40})[>\]]/g)].map((m) => m[1]!);
  const out: RegExp[] = [];
  for (const ph of placeholders) {
    const low = ph.toLowerCase();
    if (/ip|地址|address/.test(low)) {
      out.push(new RegExp('\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b'));
      out.push(new RegExp('\\b[a-z0-9][a-z0-9-]{1,62}(?:\\.[a-z0-9][a-z0-9-]{1,62})+\\b', 'i'));
    }
    if (/url|链接|http/.test(low)) out.push(/https?:\/\//i);
    if (/@|用户名|user/.test(low)) out.push(/@[A-Za-z0-9_]{3,}/);
    if (/关键词|搜索|query|keyword/.test(low)) out.push(/[一-龥\w]{2,}/);
  }
  return out;
}
function isCommandRejection(text: string): boolean {
  const t = text.trim();
  // 120 字上限：用法说明都是短句；长文本里出现 "Usage" 更可能是真结果在解释用法。
  return t.length > 0 && t.length < 120 && REJECTION_RE.test(t);
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

  // round 168：**命令被退回 ≠ 结果。** 放在这里（占位之后、结果之前）是因为
  // 它的语义是"这条代发死了"：不清 pending 的话下一条群消息会被当成它的结果
  // 消费掉（现场就是这么串味的），而当结果解就会教模型说"没查到"。
  if (resultText && isCommandRejection(resultText)) {
    await redis.del(PENDING_KEY(chatId)).catch(() => {});
    incrCounter('delegation_receipt_usage_error_total', { chat: String(chatId) });
    logger.info(
      { chatId, bot: pending.bot, cmd: pending.command, args: pending.args, preview: resultText.slice(0, 80) },
      'Delegation: receipt is a usage error, not a result',
    );
    try {
      await answerFromDelegation(chatId, botUid, pending, resultText.slice(0, 300), true);
    } catch (err) {
      logger.warn({ err, chatId }, 'Delegation: rejection answer failed');
    }
    return true;
  }

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
  rejected = false,
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
  const systemPrompt = buildSystemPrompt(undefined, chatId);
  // round 168：退回和结果用两套完全不同的指示。
  // 旧代码只有一套"结果"指示，于是 usage 说明被当成数据、模型还说"没查到"。
  const userMsg = rejected
    ? `[群聊上下文]\n${contextStr}\n\n` +
      `[代发被退回] 你刚才替群里某人向 @${pending.bot} 发了 ${pending.command}` +
      `${pending.args ? ' ' + pending.args : ''}——**没有给参数**。对方回的是用法说明:\n「${resultText}」\n\n` +
      `这不是查询结果,别把它当数据,更别说"没查到相关数据"——那样是把人家的` +
      `使用说明误解成了查询答案。现在两条路:直接跟群友说这个命令要带什么参数、` +
      `问他要;或者直说这个查不了。**绝对不要自己编一个参数再发一次。**输出 JSON。`
    : `[群聊上下文]\n${contextStr}\n\n` +
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
    // prompt 明写"输出 JSON"，下面也确实走 parseReplyResponse——所以这里要
    // jsonMode。reply usage 全局是 REPLY_JSON_MODE=false（写手要的是自然散文，
    // 不是 JSON），但**这一处**是结构化调用，不能跟着全局设置走。
    // 2026-09-21：jsonMode 现在在 claude 格式 label 上也生效（assistant 预填 {），
    // 而 reply 的主 label 正是 claude 格式的 stepfun。
    jsonMode: true,
  });
  const parsed = parseReplyResponse(result.content, current.messageId);
  if (parsed.some((p) => p.action === 'silent')) return;
  const text = parsed.filter((p) => !p.action || p.action === 'reply').map((p) => p.replyContent.trim()).find((t) => !isBlankReply(t));
  if (!text) return;
  const mid = await sendMessage(chatId, text.slice(0, 500));
  if (mid) await addAssistant(chatId, { textContent: text.slice(0, 500), messageId: mid });
  logger.info({ chatId, bot: pending.bot, cmd: pending.command }, 'Delegation: answered from receipt');
}
