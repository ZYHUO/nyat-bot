// ────────────────────────────────────────
// Bot Command Profiles — 其他 bot 命令档案存储 + 安全分类 + 成熟度闸
// ────────────────────────────────────────
//
// 长期观察学出"某 bot 的某命令怎么用/何时用/约束",成熟后才允许代发。
// 安全分类是**代码硬编码**(prompt 约束挡不住模型乱试):管理/财务类命令
// 无论学到什么都 status=blocked,永不代发。

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface BotCommandProfile {
  bot_username: string;
  command_name: string;
  usage_syntax: string;
  use_scenario: string;
  needs_reply: number;
  needs_admin: number;
  output_type: string; // text|url|callback|media|mixed|unknown
  peer_accepts_bot: number | null;
  confidence: number;
  observation_count: number;
  status: string; // learning|ready|blocked
  last_learned_ts: number;
}

// 安全门:这些命令(或含这些关键词)无论学到什么都硬禁代发。管理/封禁/
// 财务/转账/邀请/抽奖参与 —— 自主调用都是事故。
const HARD_DENY_COMMANDS = new Set([
  '/ban', '/unban', '/kick', '/mute', '/unmute', '/warn', '/promote', '/demote',
  '/invite', '/report', '/take', '/give', '/pay', '/transfer', '/withdraw',
  '/buy', '/sell', '/bet', '/join', '/draw', '/createlottery', '/delete', '/del',
  '/pin', '/unpin', '/purge', '/settings', '/setadmin',
]);
const HARD_DENY_KEYWORDS = /(ban|kick|mute|admin|wallet|pay|transfer|withdraw|invite|lottery|抽奖|封禁|踢|禁言|转账|提现|管理员)/i;

// 成熟度闸:观察够 N 次 + 置信度够,才允许首次真用
export const MATURITY_MIN_OBSERVATIONS = 3;
export const MATURITY_MIN_CONFIDENCE = 0.7;
// 可代发的回执形态(callback 按钮后的数据 bot 够不到)
const USABLE_OUTPUT_TYPES = new Set(['text', 'url', 'media', 'mixed']);

/** 命令安全分类(代码硬编码,先于学习):blocked = 永不代发 */
export function classifyCommandSafety(command: string): 'blocked' | 'candidate' {
  const cmd = command.toLowerCase().split('@')[0]!.trim();
  if (HARD_DENY_COMMANDS.has(cmd)) return 'blocked';
  if (HARD_DENY_KEYWORDS.test(cmd)) return 'blocked';
  return 'candidate';
}

/**
 * 累积一次命令观察。新命令插入(安全分类决定初始 status);已有命令则
 * 提升 observation_count + confidence,并更新学到的字段(非空才覆盖)。
 */
export function upsertCommandObservation(p: {
  botUsername: string;
  command: string;
  usageSyntax?: string;
  useScenario?: string;
  needsReply?: boolean;
  needsAdmin?: boolean;
  outputType?: string;
  peerAcceptsBot?: boolean;
}): void {
  const db = getDb();
  const bot = p.botUsername.replace(/^@/, '');
  const cmd = p.command.toLowerCase().split('@')[0]!.trim();
  if (!bot || !/^\/[a-z0-9_]+$/.test(cmd)) return;

  const blocked = classifyCommandSafety(cmd) === 'blocked';
  const now = Math.floor(Date.now() / 1000);

  try {
    const existing = db
      .prepare('SELECT * FROM bot_command_profiles WHERE bot_username = ? AND command_name = ?')
      .get(bot, cmd) as BotCommandProfile | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO bot_command_profiles
         (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
          output_type, peer_accepts_bot, confidence, observation_count, status, last_learned_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        bot, cmd,
        p.usageSyntax ?? '', p.useScenario ?? '',
        p.needsReply ? 1 : 0,
        // needs_admin 保守默认 1(需要→禁),只有明确学到不需要才 0
        p.needsAdmin === false ? 0 : 1,
        p.outputType ?? 'unknown',
        p.peerAcceptsBot === undefined ? null : p.peerAcceptsBot ? 1 : 0,
        0.35,
        blocked ? 'blocked' : 'learning',
        now,
      );
      return;
    }

    // 已存在:观察 +1,置信度爬升(封顶 0.95),字段择新更新
    const newCount = existing.observation_count + 1;
    const newConf = Math.min(0.95, existing.confidence + 0.15);
    // blocked 永远是 blocked;否则成熟后转 ready
    const newStatus =
      existing.status === 'blocked' || blocked
        ? 'blocked'
        : newCount >= MATURITY_MIN_OBSERVATIONS && newConf >= MATURITY_MIN_CONFIDENCE
          ? 'ready'
          : 'learning';
    db.prepare(
      `UPDATE bot_command_profiles SET
         usage_syntax = ?, use_scenario = ?, needs_reply = ?, needs_admin = ?,
         output_type = ?, peer_accepts_bot = COALESCE(?, peer_accepts_bot),
         confidence = ?, observation_count = ?, status = ?, last_learned_ts = ?
       WHERE bot_username = ? AND command_name = ?`,
    ).run(
      p.usageSyntax || existing.usage_syntax,
      p.useScenario || existing.use_scenario,
      p.needsReply === undefined ? existing.needs_reply : p.needsReply ? 1 : 0,
      // needs_admin 只会从 1→0(学到不需要),不会无故收紧回 1
      p.needsAdmin === false ? 0 : existing.needs_admin,
      p.outputType && p.outputType !== 'unknown' ? p.outputType : existing.output_type,
      p.peerAcceptsBot === undefined ? null : p.peerAcceptsBot ? 1 : 0,
      newConf, newCount, newStatus, now,
      bot, cmd,
    );
  } catch (err) {
    logger.warn({ err, bot, cmd }, 'upsertCommandObservation failed');
  }
}

export function getCommandProfile(botUsername: string, command: string): BotCommandProfile | undefined {
  const bot = botUsername.replace(/^@/, '');
  const cmd = command.toLowerCase().split('@')[0]!.trim();
  return getDb()
    .prepare('SELECT * FROM bot_command_profiles WHERE bot_username = ? AND command_name = ?')
    .get(bot, cmd) as BotCommandProfile | undefined;
}

/** 某 bot 的全部命令档案(供 QUERY_BOT_KNOWLEDGE / planner 看) */
export function getProfilesForBot(botUsername: string): BotCommandProfile[] {
  const bot = botUsername.replace(/^@/, '');
  return getDb()
    .prepare('SELECT * FROM bot_command_profiles WHERE bot_username = ? ORDER BY confidence DESC')
    .all(bot) as BotCommandProfile[];
}

/** 全部已知命令档案(用于教用户/planner 选型) */
export function listAllProfiles(limit = 100): BotCommandProfile[] {
  return getDb()
    .prepare('SELECT * FROM bot_command_profiles ORDER BY confidence DESC LIMIT ?')
    .all(limit) as BotCommandProfile[];
}

/**
 * 能不能现在就代发这条命令(P2 闸):非 blocked + 成熟 + 回执可达 +
 * 不需要 admin(我们不是管理员)。返回拒绝原因或 null(可用)。
 */
export function whyNotInvocable(profile: BotCommandProfile | undefined): string | null {
  if (!profile) return 'unknown_command';
  if (profile.status === 'blocked') return 'blocked_by_safety';
  if (profile.needs_admin === 1) return 'needs_admin';
  // 代发是"新发一条命令",没有可 reply 的目标消息;needs_reply 类只能教用户
  if (profile.needs_reply === 1) return 'needs_reply';
  if (profile.observation_count < MATURITY_MIN_OBSERVATIONS) return 'not_mature_count';
  if (profile.confidence < MATURITY_MIN_CONFIDENCE) return 'not_mature_confidence';
  if (!USABLE_OUTPUT_TYPES.has(profile.output_type)) return 'output_unreachable';
  if (profile.peer_accepts_bot === 0) return 'peer_ignores_bots';
  return null;
}
