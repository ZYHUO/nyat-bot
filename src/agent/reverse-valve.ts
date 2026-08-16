// ────────────────────────────────────────
// Reverse valve — AGI Level 6 Phase 14 (反向阀门 L7)
// 防「谄媚陷阱」: 陪伴 AI 反致孤独的元凶是"永远站在你这边的 bot"。
//
// 阶段 0: 连接率埋点 —— bot 消息后 5 分钟内的人-人对话轮数(新核心指标)
// 阶段 1: 私聊风险分档 —— 连续天数/深夜占比/单次时长/情绪词密度/(1-群内发言比例)
// 初期全部只记录(insight-only),不改行为;阈值调好后再启用降温。
// ────────────────────────────────────────
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

// ── 阶段 0: 连接率 ──────────────────────

/**
 * 记录 bot 消息(发送后调用): 5 分钟后统计该消息后的人-人对话轮数。
 * 连接率 = 群里的对话延续性 —— 把话题抛出去让群活起来的 bot > 吸走注意力的 bot。
 */
export async function recordBotMessageForConnectivity(
  chatId: number,
  botMid: number,
  botUsername: string,
  ts: number,
): Promise<void> {
  if (!env().CONNECTIVITY_TRACKING_ENABLED) return;
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO connectivity_windows (chat_id, bot_mid, bot_username, bot_ts, window_end, human_rounds, calculated)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(chatId, botMid, botUsername, ts, ts + 300); // 5 分钟窗口
  } catch (err) {
    logger.debug({ err }, 'connectivity window record failed');
  }
}

/**
 * 计算并回填已到窗口期的连接率。
 * 人-人对话轮数 = bot 消息后窗口内,相邻两人类消息来自不同用户的对数。
 * 数据源: Redis ctx 列表(getRecent,消息含 uid/role/isBot)。
 */
export async function calculateConnectivityWindows(nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  if (!env().CONNECTIVITY_TRACKING_ENABLED) return 0;
  const { getRecent } = await import('../pipeline/context/manager.js');
  const due = getDb()
    .prepare(`SELECT id, chat_id, bot_mid, bot_ts, window_end FROM connectivity_windows WHERE calculated = 0 AND window_end <= ? LIMIT 50`)
    .all(nowSec) as { id: number; chat_id: number; bot_mid: number; bot_ts: number; window_end: number }[];
  let updated = 0;
  for (const w of due) {
    // 窗口内的人类消息(按到达顺序)。Redis ctx 只保留最近 N 条 —— 取足够多,
    // 然后按 bot_ts 过滤。
    const msgs = await getRecent(w.chat_id, 300);
    const inWindow = msgs.filter(
      (m) => m.timestamp >= w.bot_ts && m.timestamp < w.bot_ts + 300 && !m.isBot,
    );
    let rounds = 0;
    let prevUid = 0;
    for (const m of inWindow) {
      if (prevUid !== 0 && m.uid !== prevUid) rounds++;
      prevUid = m.uid ?? 0;
    }
    getDb()
      .prepare(`UPDATE connectivity_windows SET human_rounds = ?, calculated = 1 WHERE id = ?`)
      .run(rounds, w.id);
    updated++;
  }
  return updated;
}

/** 某群 24h 平均连接率(诊断用)。 */
export function groupConnectivity(chatId: number, sinceSec: number): number {
  const rows = getDb()
    .prepare(
      `SELECT human_rounds FROM connectivity_windows WHERE chat_id = ? AND calculated = 1 AND bot_ts >= ?`,
    )
    .all(chatId, sinceSec) as { human_rounds: number }[];
  if (!rows.length) return 0;
  return rows.reduce((a, b) => a + b.human_rounds, 0) / rows.length;
}

// ── 阶段 1: 私聊风险分档 ──────────────────

export interface RiskScore {
  score: number;
  level: 'low' | 'medium' | 'high';
  factors: string[];
}

const NIGHT_START_H = 23;
const NIGHT_END_H = 6;
const EMOTION_WORDS = ['孤独', '难受', '难过', '失眠', '压力', '焦虑', '抑郁', '烦', '累', '没人', '一个人', '想哭', '撑不住', '崩溃'];

/**
 * 私聊风险打分(纯规则,不进 LLM)。
 * risk = w1·连续天数 + w2·深夜占比 + w3·单次时长 + w4·情绪词密度 + w5·(1-群内发言比例)
 */
export function scoreDmRisk(input: {
  consecutiveDays: number;
  nightRatio: number;       // 0..1 深夜消息占比
  avgSessionMin: number;    // 平均单次时长(分钟)
  emotionWordDensity: number; // 0..1 情绪词消息占比
  groupTalkRatio: number;   // 0..1 群内发言占其全部发言比例
}): RiskScore {
  const { consecutiveDays: d, nightRatio: n, avgSessionMin: s, emotionWordDensity: e, groupTalkRatio: g } = input;
  const w1 = Math.min(d / 14, 1) * 30;       // 连续 14 天满 30 分
  const w2 = n * 25;                          // 深夜占比满 25
  const w3 = Math.min(s / 120, 1) * 15;       // 2 小时满 15
  const w4 = e * 20;                           // 情绪词密度满 20
  const w5 = (1 - g) * 10;                     // 只跟 bot 说话满 10
  const score = Math.round(w1 + w2 + w3 + w4 + w5);
  const level: RiskScore['level'] = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  const factors: string[] = [];
  if (d >= 7) factors.push(`连续 ${d} 天`);
  if (n > 0.4) factors.push(`深夜占比 ${Math.round(n * 100)}%`);
  if (s > 60) factors.push(`单次 ${Math.round(s)} 分钟`);
  if (e > 0.3) factors.push(`情绪词密集 ${Math.round(e * 100)}%`);
  if (g < 0.3) factors.push('几乎只跟 bot 说话');
  return { score, level, factors };
}

/** 消息是否含情绪词(风险打分输入)。 */
export function hasEmotionWord(text: string): boolean {
  return EMOTION_WORDS.some((w) => text.includes(w));
}

/** 是否深夜时段(按本地时区小时)。 */
export function isNightHour(hour: number): boolean {
  return hour >= NIGHT_START_H || hour < NIGHT_END_H;
}
