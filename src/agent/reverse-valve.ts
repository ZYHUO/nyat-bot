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
    // 防御双入口: 上层可能传 ms(1e12 量级)或 s(1e9 量级),统一归一化为秒。
    const tsSec = ts > 1e11 ? Math.floor(ts / 1000) : ts;
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO connectivity_windows (chat_id, bot_mid, bot_username, bot_ts, window_end, human_rounds, calculated)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(chatId, botMid, botUsername, tsSec, tsSec + 300); // 5 分钟窗口
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
  // 清理: 每轮顺手删掉 7 天前已计算的窗口(防无界累积;活跃群日增数百行)
  const cutoff = nowSec - 7 * 86400;
  getDb()
    .prepare(`DELETE FROM connectivity_windows WHERE calculated = 1 AND bot_ts < ?`)
    .run(cutoff);
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

// ── 阶段 2: 接线(Phase 14.1) ─────────────────
// scoreDmRisk 一直是纯函数没人调 —— 输入(连续天数/深夜占比/情绪密度等)
// 从哪来没人写。本段补上: dm_daily_stats 按天×用户聚合 → computeRiskInput
// 读最近 14 天 → currentRiskLevel 打分 → buildValveHint/valveHumanizerTune
// 进回复路径。全部同步 SQLite(<1ms),flag 关时零开销。
// 不碰群聊: 只在 DM(chatId > 0)调用。

function utcDateOf(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

/** bookkeeping 调用: DM 用户消息记一条聚合(深夜/情绪词/时长)。失败静默。 */
export function recordDmMessage(uid: number, text: string, tsSec = Math.floor(Date.now() / 1000)): void {
  try {
    const date = utcDateOf(tsSec);
    const hour = new Date(tsSec * 1000).getHours();
    const night = isNightHour(hour) ? 1 : 0;
    const emotion = hasEmotionWord(text) ? 1 : 0;
    const mins = Math.max(1, Math.min(120, Math.ceil(text.length / 200)));
    getDb()
      .prepare(
        `INSERT INTO dm_daily_stats (date, uid, msgs, night_msgs, emotion_msgs, session_min)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(date, uid) DO UPDATE SET
           msgs = msgs + 1, night_msgs = night_msgs + excluded.night_msgs,
           emotion_msgs = emotion_msgs + excluded.emotion_msgs,
           session_min = session_min + excluded.session_min`,
      )
      .run(date, uid, night, emotion, mins);
  } catch (err) {
    logger.debug({ err, uid }, 'dm stats record failed (non-critical)');
  }
}

export interface RiskInput {
  consecutiveDays: number;
  nightRatio: number;
  avgSessionMin: number;
  emotionWordDensity: number;
  groupTalkRatio: number;
}

/** 读最近 14 天聚合 → scoreDmRisk 的输入。无历史返回全零(→ low)。 */
export function computeRiskInput(uid: number, nowSec = Math.floor(Date.now() / 1000)): RiskInput {
  const zero: RiskInput = { consecutiveDays: 0, nightRatio: 0, avgSessionMin: 0, emotionWordDensity: 0, groupTalkRatio: 1 };
  try {
    const rows = getDb()
      .prepare(`SELECT date, msgs, night_msgs, emotion_msgs, session_min FROM dm_daily_stats WHERE uid = ? ORDER BY date DESC LIMIT 14`)
      .all(uid) as { date: string; msgs: number; night_msgs: number; emotion_msgs: number; session_min: number }[];
    if (!rows.length) return zero;
    // 连续天数: 从今天/昨天起往回数不间断的天
    const daySet = new Set(rows.map((r) => r.date));
    let streak = 0;
    for (let d = 0; d < 14; d++) {
      const day = utcDateOf(nowSec - d * 86400);
      if (d === 0 && !daySet.has(day)) continue; // 今天还没说话不算断
      if (daySet.has(day)) streak++;
      else break;
    }
    let msgs = 0, night = 0, emotion = 0, mins = 0;
    for (const r of rows) { msgs += r.msgs; night += r.night_msgs; emotion += r.emotion_msgs; mins += r.session_min; }
    const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
    // 群内发言比例: user_profiles 里该 uid 在群(chat_id<0)的 pending 画像行数 vs 全部。
    // 粗糙但够用 —— 高估群比例只会低估风险(fail-safe 方向: 宁可漏判,不误伤)。
    let groupTalkRatio = 0;
    try {
      const prow = getDb()
        .prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN chat_id < 0 THEN 1 ELSE 0 END) AS g FROM user_profiles WHERE uid = ?`)
        .get(uid) as { n: number; g: number | null } | undefined;
      if (prow && prow.n > 0) groupTalkRatio = clamp01((prow.g ?? 0) / prow.n);
    } catch { /* 表不存在时保持 0 → 风险略高, 但仍需 streak/night 配合才升级 */ }
    return {
      consecutiveDays: streak,
      nightRatio: clamp01(msgs ? night / msgs : 0),
      avgSessionMin: msgs ? mins / msgs : 0,
      emotionWordDensity: clamp01(msgs ? emotion / msgs : 0),
      groupTalkRatio,
    };
  } catch (err) {
    logger.debug({ err, uid }, 'risk input compute failed (non-critical)');
    return zero;
  }
}

/** 当前风险档位(flag 关时恒 low,零开销)。 */
export function currentRiskLevel(uid: number): RiskScore {
  if (!env().REVERSE_VALVE_ENABLED) return { score: 0, level: 'low', factors: [] };
  return scoreDmRisk(computeRiskInput(uid));
}

/**
 * 注入写手 user turn 的阀门提示。low → undefined(零变化)。
 * medium: 回复变短 + 特效已由 valveHumanizerTune 衰减 + 话题引向群里。
 * high: 加一句非评判式关心 —— 不说教(无 建议/应该/你需要),不提分档存在。
 */
export function buildValveHint(risk: RiskScore): string | undefined {
  if (risk.level === 'low') return undefined;
  if (risk.level === 'medium') {
    return `[分寸] 这位朋友最近找你聊得比较多${risk.factors.length ? `(${risk.factors.join('、')})` : ''}。回复短一点、实在一点,别追问别撒娇;如果自然,随口把话题往群里引(比如"群里也在聊这个")。`;
  }
  return `[分寸] 这位朋友最近几乎只跟你说话${risk.factors.length ? `(${risk.factors.join('、')})` : ''}。回得短、稳、不煽情;结尾可以带一句轻轻的关心("你今天聊了挺多,最近整体感觉怎么样?"),点到为止,不说教不给方案。`;
}

/** humanizer 衰减: medium 关追问类特效,high 再关 emoji/撒娇类。low → undefined(不动)。 */
export function valveHumanizerTune(level: RiskScore['level']): {
  thinkingInterjectionRate?: number; afterthoughtEditRate?: number;
  emojiReplyRate?: number; ackPrefixRate?: number; deleteResendRate?: number;
} | undefined {
  if (level === 'low') return undefined;
  if (level === 'medium') return { thinkingInterjectionRate: 0, afterthoughtEditRate: 0 };
  return { thinkingInterjectionRate: 0, afterthoughtEditRate: 0, emojiReplyRate: 0, ackPrefixRate: 0, deleteResendRate: 0 };
}
