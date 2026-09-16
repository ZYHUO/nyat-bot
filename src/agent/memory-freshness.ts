// ────────────────────────────────────────
// Memory Freshness — 记忆陈旧检测 (AGI Level 5 Phase 12, L6)
//
// 问题: 群友换工作/分手了,记忆还自信引用旧事实; 记忆投毒风险。
// 设计(保守): 先检测后降权, 不自动删。
// - 超期未确认的属性 → 标记 stale
// - 新消息含变化词(换/离职/分手/搬/买了) → 相关旧属性 stale
// - 检索到 stale 属性 → prompt 注明可能过时
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

/** 新消息中的「人生变化」触发词。命中 → 相关旧属性可能过时。 */
export const CHANGE_WORDS = /换(工作|公司|城市|手机号|对象)|离职|辞职|分手|离婚|搬家|结婚|毕业|买车|买房|升职|降薪|失业|转行|跳槽|退学|休学|手术|住院/;

/**
 * 标记超期未确认的属性为 stale。
 * @param uid 用户 id
 * @param chatId 群 id(可为空)
 * @param staleAfterDays 默认从 env;测试可传
 * @returns 标记数量
 */
export function markStaleIfExpired(
  uid: number,
  chatId?: number | null,
  staleAfterDays: number = env().MEMORY_STALE_AFTER_DAYS,
  nowSecInput?: number,
): number {
  const now = nowSecInput ?? Math.floor(Date.now() / 1000);
  const cutoff = now - staleAfterDays * 86400;
  let count = 0;
  try {
    const db = getDb();
    // user_profiles: per-(chat,uid) 属性
    if (chatId !== undefined && chatId !== null) {
      const r = db
        .prepare(
          `UPDATE user_profiles SET stale = 1
           WHERE uid = ? AND chat_id = ? AND last_confirmed_at IS NOT NULL AND last_confirmed_at < ?
             AND stale = 0`,
        )
        .run(uid, chatId, cutoff);
      count += Number(r.changes);
    }
    // person_identity: 全局身份
    const r2 = db
      .prepare(
        `UPDATE person_identity SET stale = 1
         WHERE uid = ? AND last_confirmed_at IS NOT NULL AND last_confirmed_at < ?
           AND stale = 0`,
      )
      .run(uid, cutoff);
    count += Number(r2.changes);
    return count;
  } catch (err) {
    logger.warn({ err, uid, chatId }, 'markStaleIfExpired failed');
    return count;
  }
}

/**
 * 新消息含变化词 → 把该用户相关旧属性标记 stale 并返回提示文本。
 * @returns stale 提示(空串 = 无变化词)
 */
export function detectChangeInMessage(uid: number, message: string, chatId?: number | null): string {
  if (!CHANGE_WORDS.test(message)) return '';
  try {
    const db = getDb();
    const ts = Math.floor(Date.now() / 1000);
    let touched = 0;
    if (chatId !== undefined && chatId !== null) {
      const r = db
        .prepare(`UPDATE user_profiles SET stale = 1, last_confirmed_at = ? WHERE uid = ? AND chat_id = ? AND stale = 0`)
        .run(ts, uid, chatId);
      touched += Number(r.changes);
    }
    const r2 = db.prepare(`UPDATE person_identity SET stale = 1 WHERE uid = ? AND stale = 0`).run(uid);
    touched += Number(r2.changes);
    if (touched > 0) {
      logger.info({ uid, touched }, 'memory marked stale by change words');
      return '(此人刚透露生活变化,旧资料可能过时,以最新聊天为准)';
    }
    return '';
  } catch (err) {
    logger.warn({ err, uid }, 'detectChangeInMessage failed');
    return '';
  }
}

/** 刷新确认时间(每次用户发言时调用,表示「还活着/资料仍有效」)。 */
export function confirmFresh(uid: number, chatId?: number | null): void {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const db = getDb();
    if (chatId !== undefined && chatId !== null) {
      db.prepare(`UPDATE user_profiles SET last_confirmed_at = ?, stale = 0 WHERE uid = ? AND chat_id = ?`).run(ts, uid, chatId);
    }
    db.prepare(`UPDATE person_identity SET last_confirmed_at = ?, stale = 0 WHERE uid = ?`).run(ts, uid);
  } catch (err) {
    logger.warn({ err, uid }, 'confirmFresh failed');
  }
}

/** 构建检索时的 stale 注记(命中 stale 属性 → 提示可能过时)。 */
export function staleCaveat(uid: number, chatId?: number | null): string {
  try {
    const db = getDb();
    if (chatId !== undefined && chatId !== null) {
      const r = db
        .prepare(`SELECT COUNT(*) c FROM user_profiles WHERE uid = ? AND chat_id = ? AND stale = 1`)
        .get(uid, chatId) as { c: number };
      if (r.c > 0) return '(此人部分旧资料可能过时,以最新聊天为准)';
    }
    const r2 = db.prepare(`SELECT COUNT(*) c FROM person_identity WHERE uid = ? AND stale = 1`).get(uid) as { c: number };
    return r2.c > 0 ? '(此人部分旧资料可能过时,以最新聊天为准)' : '';
  } catch (err) {
    logger.warn({ err, uid }, 'staleCaveat failed');
    return '';
  }
}
