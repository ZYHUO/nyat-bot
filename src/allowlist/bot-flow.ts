import type { Redis } from 'ioredis';
import type { Bot } from 'grammy';
import { logger } from '../shared/logger.js';
import * as allowlist from './allowlist.js';
import * as aiReview from './ai-review.js';
import type { AllowlistConfig, PendingRequest } from './types.js';

/**
 * 白名单 bot 对话流（2026-08-20 起替代 miniapp 申请入口）。
 *
 * 三条路径：
 *  1. applyViaBot   —— 申请人私聊 bot 报群 ID/@username（host API allowlist.apply）。
 *  2. reviewOnJoin  —— bot 被拉进群时立即自动审核（ALLOWLIST_REVIEW_ON_JOIN）。
 *  3. masterApprove / masterReject / listForMaster —— 主人在 DM 里评判/翻记录。
 *
 * 安全模型（对齐 env.ts 里 ALLOWLIST_AI_AUTO_ENABLE 的注释）：
 *  - AI 通过即启用**只在申请人经 getChatMember 核实为 creator/administrator** 时允许；
 *    普通成员/查不到身份 → AI 结论照写但 pending 转主人评判（note 是用户可控文本，防注入自助开通）。
 *  - bot 必须在目标群里（否则审核无数据、启用也无意义）。
 */

export interface BotFlowDeps {
  redis: Redis;
  bot: Bot;
  config: AllowlistConfig;
  aiCall: (systemPrompt: string, userMessage: string) => Promise<string | null>;
  getRecentContext?: (chatId: number, limit: number, maxChars: number) => Promise<string>;
  masterUid: number;
  botUid: number;
}

/** env → AllowlistConfig（index.ts 与 host API 共用，免得两处手写映射漂移）。 */
export function configFromEnv(e: {
  ALLOWLIST_ENABLED: boolean;
  ALLOWLIST_REDIS_PREFIX: string;
  ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE: boolean;
  ALLOWLIST_MAX_SUBMISSIONS_PER_DAY: number;
  ALLOWLIST_AUTO_AI_REVIEW: boolean;
  ALLOWLIST_AI_MESSAGE_LIMIT: number;
  ALLOWLIST_AI_CONTEXT_MAX_CHARS: number;
  ALLOWLIST_AI_AUTO_ENABLE: boolean;
  ALLOWLIST_AI_CONFIDENCE_THRESHOLD: number;
}): AllowlistConfig {
  return {
    enabled: e.ALLOWLIST_ENABLED,
    redisPrefix: e.ALLOWLIST_REDIS_PREFIX,
    defaultEnabledAfterApproval: e.ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE,
    maxSubmissionsPerUserPerDay: e.ALLOWLIST_MAX_SUBMISSIONS_PER_DAY,
    autoAiReviewOnSubmit: e.ALLOWLIST_AUTO_AI_REVIEW,
    autoAiReviewMessageLimit: e.ALLOWLIST_AI_MESSAGE_LIMIT,
    aiReviewContextMaxChars: e.ALLOWLIST_AI_CONTEXT_MAX_CHARS,
    aiApproveAutoEnable: e.ALLOWLIST_AI_AUTO_ENABLE,
    aiApproveConfidenceThreshold: e.ALLOWLIST_AI_CONFIDENCE_THRESHOLD,
  };
}

/** AI 审核拉最近群消息（bot 自己的上下文库）。host API / member handler 共用。 */
export async function defaultGetRecentContext(
  chatId: number,
  limit: number,
  maxChars: number,
): Promise<string> {
  try {
    const { getRecent } = await import('../pipeline/context/manager.js');
    const { slimSingleMessage } = await import('../pipeline/context/slim.js');
    const { getBotUid } = await import('../bot/bot.js');
    const msgs = await getRecent(chatId, limit);
    if (!msgs.length) return '';
    const botUid = getBotUid() || 0;
    return msgs
      .map((m) => slimSingleMessage(m, botUid))
      .join('\n')
      .slice(0, maxChars);
  } catch (err) {
    logger.debug({ err, chatId }, 'bot-flow getRecentContext failed');
    return '';
  }
}

// ── 目标解析 / 身份核验 ────────────────────────────────────────────

interface ResolvedChat {
  chatId: number;
  title: string;
  username: string;
}

/** 把「群 ID（全形或去 -100 短形）/ @username / t.me 链接」解析成群。只认群（chatId<0）。 */
async function resolveTargetChat(
  deps: BotFlowDeps,
  rawTarget: string,
): Promise<ResolvedChat | null> {
  const t = rawTarget.trim();
  if (!t) return null;
  const candidates: Array<number | string> = [];
  if (/^-?\d{4,16}$/.test(t)) {
    const n = Number(t);
    if (n < 0) {
      candidates.push(n);
    } else {
      // 正数可能是去掉 -100 前缀的短群 id（老 miniapp 存的就是短形），先试全形
      candidates.push(Number(`-100${n}`), n);
    }
  } else {
    const uname = t.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').split('/')[0] ?? '';
    if (!/^\w{3,32}$/.test(uname)) return null;
    candidates.push(`@${uname}`);
  }
  for (const c of candidates) {
    try {
      const chat = (await deps.bot.api.getChat(c)) as {
        id?: number;
        title?: string;
        username?: string;
      };
      if (typeof chat.id === 'number' && chat.id < 0) {
        return {
          chatId: chat.id,
          title: typeof chat.title === 'string' ? chat.title : '',
          username: typeof chat.username === 'string' ? chat.username : '',
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

async function membershipOf(
  deps: BotFlowDeps,
  chatId: number,
  uid: number,
): Promise<string> {
  try {
    const m = (await deps.bot.api.getChatMember(chatId, uid)) as { status?: string };
    return m.status ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function safeSend(bot: Bot, chatId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text);
  } catch (err) {
    logger.warn({ err, chatId }, 'bot-flow notify send failed');
  }
}

function applicantTag(p: {
  applicantUid: number;
  applicantUsername?: string;
  applicantFirstName?: string;
}): string {
  const name = [p.applicantFirstName, p.applicantUsername ? `@${p.applicantUsername}` : '']
    .filter(Boolean)
    .join(' ');
  return name || `uid ${p.applicantUid}`;
}

function chatTag(chat: { chatId: number; title: string; username?: string }): string {
  const un = chat.username ? ` @${chat.username}` : '';
  return `「${chat.title || chat.chatId}」(${chat.chatId}${un})`;
}

/** 回填 source / 成员身份到 pending 记录（best-effort，主人翻记录时用）。 */
async function markPendingMeta(
  deps: BotFlowDeps,
  requestId: string,
  patch: Partial<PendingRequest>,
): Promise<void> {
  try {
    const raw = await deps.redis.hget(`${deps.config.redisPrefix}pending`, requestId);
    if (!raw) return;
    const req = JSON.parse(raw) as PendingRequest;
    Object.assign(req, patch);
    await deps.redis.hset(
      `${deps.config.redisPrefix}pending`,
      requestId,
      JSON.stringify(req),
    );
  } catch (err) {
    logger.debug({ err, requestId }, 'markPendingMeta failed');
  }
}

// ── ① DM 申请 ─────────────────────────────────────────────────────

export type ApplyOutcome =
  | { kind: 'approved'; chatId: number; title: string; confidence: number; reason: string }
  | { kind: 'needs_master'; chatId: number; title: string; reason: string }
  | { kind: 'already_enabled'; chatId: number; title: string }
  | { kind: 'already_pending'; chatId: number; title: string }
  | { kind: 'not_in_group'; chatId: number; title: string }
  | { kind: 'not_found'; target: string }
  | { kind: 'not_a_member'; chatId: number; title: string }
  | { kind: 'rate_limited' }
  | { kind: 'error'; message: string };

export async function applyViaBot(
  deps: BotFlowDeps,
  params: {
    applicantUid: number;
    applicantUsername?: string;
    applicantFirstName?: string;
    target: string;
    note?: string;
  },
): Promise<ApplyOutcome> {
  const target = String(params.target ?? '').trim();
  if (!target) return { kind: 'error', message: 'empty target' };
  const note = String(params.note ?? '').slice(0, 400);

  const chat = await resolveTargetChat(deps, target);
  if (!chat) return { kind: 'not_found', target };

  // 已在白名单
  const existing = await allowlist.getGroupRecord(deps.redis, deps.config, chat.chatId);
  if (existing?.approved) {
    if (!existing.enabled) {
      // 批过但没启用——新流程语义「申请=要启用」，顺手启用并告诉群里
      await allowlist.setGroupEnabled(deps.redis, deps.config, chat.chatId, true);
      await safeSend(deps.bot, chat.chatId, '✅ 本群已启用，直接叫我名字或 @ 我就好喵～');
    }
    return { kind: 'already_enabled', chatId: chat.chatId, title: chat.title };
  }

  // bot 必须在目标群里（否则审核没数据、启用了也收不到消息）
  const botStatus = await membershipOf(deps, chat.chatId, deps.botUid);
  if (botStatus === 'left' || botStatus === 'kicked' || botStatus === 'unknown') {
    return { kind: 'not_in_group', chatId: chat.chatId, title: chat.title };
  }

  // pending 查重
  const pendings = await allowlist.listPending(deps.redis, deps.config);
  const dup = pendings.find((p) => p.chat_id === chat.chatId);
  if (dup) {
    return { kind: 'already_pending', chatId: chat.chatId, title: chat.title || dup.chat_title };
  }

  // 申请人身份：必须是群成员；是否管理决定 AI 能不能直接启用
  const mstatus = await membershipOf(deps, chat.chatId, params.applicantUid);
  if (mstatus === 'left' || mstatus === 'kicked') {
    return { kind: 'not_a_member', chatId: chat.chatId, title: chat.title };
  }
  const isAdmin = mstatus === 'creator' || mstatus === 'administrator';

  // 建 pending（复用 submit 的限流 + dedup）
  const sub = await allowlist.submit(deps.redis, deps.config, {
    chatId: chat.chatId,
    userId: params.applicantUid,
    username: params.applicantUsername,
    firstName: params.applicantFirstName,
    note,
    chatTitle: chat.title,
  });
  if (!sub.ok || !sub.request_id) {
    if (sub.error === 'rate_limited') return { kind: 'rate_limited' };
    if (sub.error === 'already_registered') {
      return { kind: 'already_enabled', chatId: chat.chatId, title: chat.title };
    }
    if (sub.error === 'already_pending') {
      return { kind: 'already_pending', chatId: chat.chatId, title: chat.title };
    }
    return { kind: 'error', message: sub.error ?? 'submit failed' };
  }
  await markPendingMeta(deps, sub.request_id, {
    source: 'dm',
    applicant_member_status: mstatus,
  });

  // AI 审核（标准与 miniapp 相同：同一 prompt/解析，仅数据更全）。非管理申请人禁止自动启用。
  const reviewed = await aiReview.runAiReview(deps.redis, deps.config, sub.request_id, {
    aiCall: deps.aiCall,
    getRecentContext: deps.getRecentContext,
    getChat: async (cid: number) => {
      try {
        return await deps.bot.api.getChat(cid);
      } catch {
        return null;
      }
    },
  }, { enableNowOverride: true, autoApproveAllowed: isAdmin });

  const who = `${applicantTag(params)}(uid ${params.applicantUid}${isAdmin ? `, 群${mstatus === 'creator' ? '主' : '管理'}` : `, 身份:${mstatus}`})`;

  if (reviewed.ok && reviewed.decision === 'APPROVE' && reviewed.enabled_now) {
    await safeSend(deps.bot, chat.chatId, '✅ 白名单审核通过，本群已启用，直接叫我名字或 @ 我就好喵～');
    await safeSend(
      deps.bot,
      deps.masterUid,
      `【白名单·自动通过】${chatTag(chat)}\n申请人：${who}\nAI 置信 ${reviewed.confidence}：${reviewed.reason}`,
    );
    return {
      kind: 'approved',
      chatId: chat.chatId,
      title: chat.title,
      confidence: reviewed.confidence ?? 0,
      reason: reviewed.reason ?? '',
    };
  }

  // 没通过/没把握/申请人非管理 → 转主人评判
  const why = !reviewed.ok
    ? 'AI 审核调用失败，转人工评判'
    : isAdmin
      ? `AI ${reviewed.decision}（置信 ${reviewed.confidence}）：${reviewed.reason}`
      : `AI ${reviewed.decision}（置信 ${reviewed.confidence}）：${reviewed.reason}；另：申请人不是群管理，按规矩留你定夺`;
  await safeSend(
    deps.bot,
    deps.masterUid,
    `【白名单·待你评判】${chatTag(chat)}\n申请人：${who}\n备注：${note || '（无）'}\n${why}\n想放行就说「让群 ${chat.chatId} 通过」，想拒就说「拒了 ${chat.chatId}」。`,
  );
  return {
    kind: 'needs_master',
    chatId: chat.chatId,
    title: chat.title,
    reason: reviewed.reason ?? 'ai_call_failed',
  };
}

// ── ② 入群自动审核 ────────────────────────────────────────────────

export async function reviewOnJoin(
  deps: BotFlowDeps,
  chatId: number,
  inviter: { uid: number; username?: string; firstName?: string },
): Promise<void> {
  if (!deps.config.enabled) return;

  const existing = await allowlist.getGroupRecord(deps.redis, deps.config, chatId);
  if (existing?.approved) {
    if (!existing.enabled) {
      await allowlist.setGroupEnabled(deps.redis, deps.config, chatId, true);
    }
    await safeSend(deps.bot, chatId, '✅ Bot 已就绪，可以正常使用了！');
    return;
  }

  // 已有 pending：审过的提示等主人；没审过的接着审
  let requestId: string | null = null;
  const pendings = await allowlist.listPending(deps.redis, deps.config);
  const dup = pendings.find((p) => p.chat_id === chatId);
  if (dup) {
    if (dup.ai_reviewed_at) {
      await safeSend(deps.bot, chatId, '⏳ 本群的开通申请正在等主人评判，请稍等喵。');
      return;
    }
    requestId = dup.request_id;
  } else {
    let title = '';
    try {
      const chat = (await deps.bot.api.getChat(chatId)) as { title?: string };
      title = typeof chat.title === 'string' ? chat.title : '';
    } catch {
      /* best-effort */
    }
    const sub = await allowlist.submit(deps.redis, deps.config, {
      chatId,
      userId: inviter.uid,
      username: inviter.username,
      firstName: inviter.firstName,
      note: '[入群自动审核]',
      chatTitle: title,
    });
    if (!sub.ok || !sub.request_id) {
      logger.info({ chatId, error: sub.error }, 'reviewOnJoin submit skipped');
      return;
    }
    requestId = sub.request_id;
  }

  // 拉群人的身份决定 AI 能不能直接启用
  const mstatus = await membershipOf(deps, chatId, inviter.uid);
  const isAdmin = mstatus === 'creator' || mstatus === 'administrator';
  await markPendingMeta(deps, requestId, { source: 'join', applicant_member_status: mstatus });

  const reviewed = await aiReview.runAiReview(deps.redis, deps.config, requestId, {
    aiCall: deps.aiCall,
    getRecentContext: deps.getRecentContext,
    getChat: async (cid: number) => {
      try {
        return await deps.bot.api.getChat(cid);
      } catch {
        return null;
      }
    },
  }, { enableNowOverride: true, autoApproveAllowed: isAdmin });

  let title = '';
  try {
    const chat = (await deps.bot.api.getChat(chatId)) as { title?: string };
    title = typeof chat.title === 'string' ? chat.title : '';
  } catch {
    /* best-effort */
  }
  const who = `拉群人：${applicantTag({ applicantUid: inviter.uid, applicantUsername: inviter.username, applicantFirstName: inviter.firstName })}(uid ${inviter.uid}, 身份:${mstatus})`;

  if (reviewed.ok && reviewed.decision === 'APPROVE' && reviewed.enabled_now) {
    await safeSend(deps.bot, chatId, '✅ 我通过白名单审核啦，本群已启用，叫我名字或 @ 我就好喵～');
    await safeSend(
      deps.bot,
      deps.masterUid,
      `【白名单·入群自动通过】${chatTag({ chatId, title })}\n${who}\nAI 置信 ${reviewed.confidence}：${reviewed.reason}`,
    );
    return;
  }

  // 不通过/没把握/拉群人非管理 → 群里静默，只找主人
  const why = !reviewed.ok
    ? 'AI 审核调用失败，转人工评判'
    : `AI ${reviewed.decision}（置信 ${reviewed.confidence}）：${reviewed.reason}${isAdmin ? '' : '；另：拉群的人不是群管理'}`;
  await safeSend(
    deps.bot,
    deps.masterUid,
    `【白名单·入群待评判】${chatTag({ chatId, title })}\n${who}\n${why}\n想放行就说「让群 ${chatId} 通过」，想拒就说「拒了 ${chatId}」（拒了我也不会退群，只是不服务）。`,
  );
}

// ── ③ 主人评判 / 翻记录 ───────────────────────────────────────────

export type MasterActionOutcome =
  | { kind: 'approved'; chatId: number; title: string }
  | { kind: 'rejected'; chatId: number; title: string }
  | { kind: 'not_pending'; target: string }
  | { kind: 'error'; message: string };

/** 按 requestId / chatId(全形或短形) / @username / 群名片段 找 pending。 */
async function findPendingByTarget(
  deps: BotFlowDeps,
  target: string,
): Promise<PendingRequest | null> {
  const pendings = await allowlist.listPending(deps.redis, deps.config);
  const t = target.trim();
  if (!t) return null;
  const byId = pendings.find((p) => p.request_id === t);
  if (byId) return byId;
  const chat = await resolveTargetChat(deps, t);
  if (chat) {
    const byChat = pendings.find((p) => p.chat_id === chat.chatId);
    if (byChat) return byChat;
  }
  const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const nt = norm(t.replace(/^@/, ''));
  if (!nt) return null;
  return (
    pendings.find((p) => {
      const pt = norm(p.chat_title ?? '');
      return pt && (pt.includes(nt) || nt.includes(pt));
    }) ?? null
  );
}

export async function masterApprove(
  deps: BotFlowDeps,
  target: string,
): Promise<MasterActionOutcome> {
  const req = await findPendingByTarget(deps, target);
  if (!req) {
    // 不在 pending：也许早就批过只是没启用 → 顺手启用；已启用 → 幂等回报
    const chat = await resolveTargetChat(deps, target);
    if (chat) {
      const rec = await allowlist.getGroupRecord(deps.redis, deps.config, chat.chatId);
      if (rec?.approved) {
        if (!rec.enabled) {
          await allowlist.setGroupEnabled(deps.redis, deps.config, chat.chatId, true);
          await safeSend(deps.bot, chat.chatId, '✅ 本群已启用，直接叫我名字或 @ 我就好喵～');
        }
        return { kind: 'approved', chatId: chat.chatId, title: chat.title };
      }
    }
    return { kind: 'not_pending', target };
  }
  const r = await allowlist.approveRequest(deps.redis, deps.config, req.request_id, 'master', true);
  if (!r.ok) return { kind: 'error', message: 'approveRequest failed' };
  await safeSend(deps.bot, req.chat_id, '✅ 白名单申请已通过，本群已启用，直接叫我名字或 @ 我就好喵～');
  await safeSend(
    deps.bot,
    req.user_id,
    `✅ 你申请的群「${req.chat_title || req.chat_id}」已通过审核并启用啦，去群里叫我吧喵～`,
  );
  return { kind: 'approved', chatId: req.chat_id, title: req.chat_title };
}

export async function masterReject(
  deps: BotFlowDeps,
  target: string,
  reason?: string,
): Promise<MasterActionOutcome> {
  const req = await findPendingByTarget(deps, target);
  if (!req) return { kind: 'not_pending', target };
  const ok = await allowlist.rejectRequest(deps.redis, deps.config, req.request_id);
  if (!ok) return { kind: 'error', message: 'rejectRequest failed' };
  const why = String(reason ?? '').trim().slice(0, 200);
  await safeSend(
    deps.bot,
    req.user_id,
    `❌ 你申请的群「${req.chat_title || req.chat_id}」这次没通过审核${why ? `：${why}` : '。'}`,
  );
  return { kind: 'rejected', chatId: req.chat_id, title: req.chat_title };
}

/** 主人问「最近有哪些群申请 / 申请理由」——聚合 pending + groups + reviewed 成紧凑文本。 */
export async function listForMaster(deps: BotFlowDeps): Promise<string> {
  const fmtAgo = (ts?: number): string => {
    if (!ts) return '?';
    const mins = Math.max(0, Math.floor(Date.now() / 1000 - ts) / 60);
    if (mins < 60) return `${Math.floor(mins)}分钟前`;
    if (mins < 1440) return `${Math.floor(mins / 60)}小时前`;
    return `${Math.floor(mins / 1440)}天前`;
  };
  const who = (p: PendingRequest): string =>
    [p.first_name, p.username ? `@${p.username}` : ''].filter(Boolean).join(' ') || `uid ${p.user_id}`;

  const pendings = await allowlist.listPending(deps.redis, deps.config);
  const groups = await allowlist.listGroups(deps.redis, deps.config);
  const reviewedRaw = await deps.redis.hgetall(`${deps.config.redisPrefix}reviewed`);
  const reviewed = Object.values(reviewedRaw).map((j) => JSON.parse(j) as PendingRequest);

  const lines: string[] = [];
  lines.push(`待评判 (${pendings.length}):`);
  for (const p of pendings.slice(0, 15)) {
    const ai = p.ai_reviewed_at
      ? `AI ${p.ai_decision ?? '?'} 置信${p.ai_confidence ?? '?'}: ${p.ai_reason || '(无理由)'}`
      : 'AI 还没审';
    lines.push(
      `- 「${p.chat_title || p.chat_id}」 ${p.chat_id} | 申请人 ${who(p)}(${p.user_id}${p.applicant_member_status ? `, ${p.applicant_member_status}` : ''}) | ${ai} | 备注: ${p.note || '(无)'} | ${fmtAgo(p.created_at)} | requestId ${p.request_id}`,
    );
  }
  lines.push(`已通过 (${groups.length}):`);
  for (const g of groups.slice(0, 15)) {
    lines.push(
      `- 「${g.title || g.chat_id}」 ${g.chat_id} | ${g.review_state === 'auto_approved' ? 'AI自动' : `人工(${g.approved_by})`} | ${g.enabled ? '启用中' : '已停用'} | AI: ${g.ai_reason || '(无)'} | ${fmtAgo(g.approved_at)}`,
    );
  }
  lines.push(`已拒绝 (${reviewed.length}, 30天自动清理):`);
  for (const p of reviewed.slice(0, 10)) {
    lines.push(
      `- 「${p.chat_title || p.chat_id}」 ${p.chat_id} | 申请人 ${who(p)} | AI: ${p.ai_reason || '(无)'} | ${fmtAgo(p.created_at)}`,
    );
  }
  return lines.join('\n');
}
