// ────────────────────────────────────────
// Checkin (签到) Service
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { creditCoins } from './gacha/gacha.js';

export interface CheckinResult {
  isNew: boolean;          // true if this is today's first checkin
  streak: number;          // consecutive days
  totalCheckins: number;   // all-time total
  rewardCoins: number;     // 喵币
  rewardExp: number;       // 经验值
  luckyNumber: number;     // 幸运数字 1-100
  fortune: string;         // 今日运势
  rank: number;            // today's checkin rank in this chat
  todayCheckins: number;   // how many people checked in today
  milestone?: 7 | 30 | 100; // 连续签到里程碑
}

export interface CheckinStats {
  todayRank: Array<{ rank: number; fullName: string; username: string; streak: number; totalCheckins: number }>;
  allTimeRank: Array<{ rank: number; fullName: string; username: string; totalCheckins: number }>;
  todayCount: number;
}

const FORTUNES = [
  '大吉！今天做什么都超顺利喵~',
  '中吉！会有小惊喜等着你哦',
  '小吉！平平淡淡也是一种幸福',
  '吉！好运正在向你靠近~',
  '半吉！稍微注意一下就好啦',
  '末吉！虽然一般但不会太差的',
  '小凶...今天小心点比较好',
  '大吉！感觉今天能中彩票！',
  '超大吉！简直欧皇附体！！',
  '中吉！适合和朋友一起玩~',
  '吉！今天的饭会特别好吃',
  '小吉！适合学习新东西',
  '末吉！早点睡觉就没事',
  '吉！会遇到可爱的猫猫',
  '大吉！今天怎么做都是对的',
];

function getTodayDate(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getYesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

// Single round-trip to fetch both the user's rank for today and the total
// number of checkins today.
function getRankAndTodayTotal(
  db: ReturnType<typeof getDb>,
  chatId: number,
  uid: number,
  today: string,
): { rank: number; total: number } {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN id <= (
        SELECT id FROM checkins WHERE chat_id = ? AND uid = ? AND checkin_date = ?
      ) THEN 1 ELSE 0 END) AS rank,
      COUNT(*) AS total
    FROM checkins
    WHERE chat_id = ? AND checkin_date = ?
  `).get(chatId, uid, today, chatId, today) as
    | { rank: number | null; total: number }
    | undefined;
  return { rank: row?.rank ?? 0, total: row?.total ?? 0 };
}

export function doCheckin(
  chatId: number,
  uid: number,
  username: string,
  fullName: string,
): CheckinResult {
  const db = getDb();
  const today = getTodayDate();
  const yesterday = getYesterdayDate();

  return db.transaction(() => {
  // Check if already checked in today
  const existing = db.prepare(
    'SELECT streak, total_checkins, reward_coins, reward_exp, lucky_number, fortune FROM checkins WHERE chat_id = ? AND uid = ? AND checkin_date = ?',
  ).get(chatId, uid, today) as {
    streak: number;
    total_checkins: number;
    reward_coins: number;
    reward_exp: number;
    lucky_number: number;
    fortune: string;
  } | undefined;

  if (existing) {
    // Already checked in, return existing data
    const { rank, total: todayTotal } = getRankAndTodayTotal(db, chatId, uid, today);

    return {
      isNew: false,
      streak: existing.streak,
      totalCheckins: existing.total_checkins,
      rewardCoins: existing.reward_coins,
      rewardExp: existing.reward_exp,
      luckyNumber: existing.lucky_number,
      fortune: existing.fortune,
      rank,
      todayCheckins: todayTotal,
    };
  }

  // Check yesterday's streak
  const yesterdayRecord = db.prepare(
    'SELECT streak, total_checkins FROM checkins WHERE chat_id = ? AND uid = ? AND checkin_date = ?',
  ).get(chatId, uid, yesterday) as { streak: number; total_checkins: number } | undefined;

  const streak = yesterdayRecord ? yesterdayRecord.streak + 1 : 1;
  const prevTotal = yesterdayRecord?.total_checkins ??
    ((db.prepare(
      'SELECT MAX(total_checkins) as max_total FROM checkins WHERE chat_id = ? AND uid = ?',
    ).get(chatId, uid) as { max_total: number | null })?.max_total ?? 0);
  const totalCheckins = prevTotal + 1;

  // Generate rewards
  const baseCoins = 10 + Math.floor(Math.random() * 41); // 10-50
  const streakBonus = Math.min(streak * 5, 100);          // up to 100 bonus
  const rewardCoins = baseCoins + streakBonus;
  const rewardExp = 5 + Math.floor(Math.random() * 16) + Math.min(streak * 2, 30); // 5-20 + streak bonus
  const luckyNumber = Math.floor(Math.random() * 100) + 1;
  const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)]!;

  // INSERT OR IGNORE: if a concurrent call already inserted, this is a no-op
  const result = db.prepare(`
    INSERT OR IGNORE INTO checkins (chat_id, uid, username, full_name, checkin_date, streak, total_checkins, reward_coins, reward_exp, lucky_number, fortune)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chatId, uid, username, fullName, today, streak, totalCheckins, rewardCoins, rewardExp, luckyNumber, fortune);

  if (result.changes !== 0) {
    // First check-in of the day — credit the spendable gacha wallet
    try { creditCoins(chatId, uid, rewardCoins); }
    catch { /* gacha wallet credit is non-critical */ }
  }

  if (result.changes === 0) {
    // Another concurrent call inserted first — return their data
    const existing2 = db.prepare(
      'SELECT streak, total_checkins, reward_coins, reward_exp, lucky_number, fortune FROM checkins WHERE chat_id = ? AND uid = ? AND checkin_date = ?',
    ).get(chatId, uid, today) as {
      streak: number; total_checkins: number; reward_coins: number;
      reward_exp: number; lucky_number: number; fortune: string;
    };
    const { rank: rank2, total: todayTotal2 } = getRankAndTodayTotal(db, chatId, uid, today);
    return {
      isNew: false,
      streak: existing2.streak,
      totalCheckins: existing2.total_checkins,
      rewardCoins: existing2.reward_coins,
      rewardExp: existing2.reward_exp,
      luckyNumber: existing2.lucky_number,
      fortune: existing2.fortune,
      rank: rank2,
      todayCheckins: todayTotal2,
    };
  }

  // Get rank
  const rank = (db.prepare(
    'SELECT COUNT(*) as cnt FROM checkins WHERE chat_id = ? AND checkin_date = ?',
  ).get(chatId, today) as { cnt: number }).cnt;

  return {
    isNew: true,
    streak,
    totalCheckins,
    rewardCoins,
    rewardExp,
    luckyNumber,
    fortune,
    rank,
    todayCheckins: rank,
    milestone: ([100, 30, 7] as const).find(m => streak % m === 0 && streak > 0),
  };
  })();
}

export function getCheckinStats(chatId: number): CheckinStats {
  const db = getDb();
  const today = getTodayDate();

  const todayRank = db.prepare(`
    SELECT full_name, username, streak, total_checkins,
      ROW_NUMBER() OVER (ORDER BY id ASC) as rank
    FROM checkins
    WHERE chat_id = ? AND checkin_date = ?
    ORDER BY id ASC
    LIMIT 10
  `).all(chatId, today) as Array<{
    rank: number; full_name: string; username: string; streak: number; total_checkins: number;
  }>;

  const allTimeRank = db.prepare(`
    SELECT full_name, username, MAX(total_checkins) as total_checkins,
      ROW_NUMBER() OVER (ORDER BY MAX(total_checkins) DESC) as rank
    FROM checkins
    WHERE chat_id = ?
    GROUP BY uid
    ORDER BY total_checkins DESC
    LIMIT 10
  `).all(chatId) as Array<{
    rank: number; full_name: string; username: string; total_checkins: number;
  }>;

  const todayCount = (db.prepare(
    'SELECT COUNT(*) as cnt FROM checkins WHERE chat_id = ? AND checkin_date = ?',
  ).get(chatId, today) as { cnt: number }).cnt;

  return {
    todayRank: todayRank.map(r => ({
      rank: Number(r.rank),
      fullName: r.full_name,
      username: r.username,
      streak: r.streak,
      totalCheckins: r.total_checkins,
    })),
    allTimeRank: allTimeRank.map(r => ({
      rank: Number(r.rank),
      fullName: r.full_name,
      username: r.username,
      totalCheckins: r.total_checkins,
    })),
    todayCount,
  };
}
