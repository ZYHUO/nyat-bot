// ────────────────────────────────────────
// StepFun 配额消费引擎(用户选:滚动深反思)
// ────────────────────────────────────────
// 目标:8000M/月订阅目前用得太少(<20M/天)。真实流量(~13 活跃群 + 数十跨群用户)
// 产不出 100M/天的**新**内容,所以本引擎在 10 并发/2000RPM 内,对**全量工作池**
// (所有群深反思 + 跨上下文画像合并)做**滚动再加工**:内容真实演化的群反思是主力
// (最不浪费),跨上下文合并顺带跑。速率用旋钮控:
//   日调用 ≈ CALLS_PER_TICK × 1440(每分钟一 tick)。
//   工作池 ≈ 群数×REFLECT_WEIGHT + person_identity 人数;池越大 → 单项重复率越低。
// 全部走 STEPFUN_CONSUMER_USAGE(默认 summarize → step-3.7-flash)。默认关。

import pLimit from 'p-limit';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { reflectChat } from './deep-reflection.js';
import { mergeGlobalProfile } from './profile-merge.js';

const CURSOR_KEY = 'xxb:stepfun_consumer:cursor';

interface WorkItem {
  kind: 'group' | 'merge';
  id: number;
}

/**
 * 构建滚动工作池:所有群(反思,按 REFLECT_WEIGHT 重复入池抬高占比)+ 所有已知人(合并)。
 * 群反思内容随对话真实演化、最有价值;merge 对单上下文用户会秒退(无 LLM),只有跨上下文才真跑。
 */
function buildPool(): WorkItem[] {
  const db = getDb();
  const pool: WorkItem[] = [];
  try {
    const groups = db
      .prepare('SELECT DISTINCT chat_id FROM user_profiles WHERE chat_id < 0')
      .all() as Array<{ chat_id: number }>;
    const weight = Math.max(1, env().STEPFUN_CONSUMER_REFLECT_WEIGHT);
    for (const g of groups) {
      for (let i = 0; i < weight; i++) pool.push({ kind: 'group', id: g.chat_id });
    }
    const people = db
      .prepare('SELECT uid FROM person_identity WHERE uid > 0 ORDER BY updated_at DESC')
      .all() as Array<{ uid: number }>;
    for (const p of people) pool.push({ kind: 'merge', id: p.uid });
  } catch (err) {
    logger.warn({ err }, 'stepfun-consumer: pool build failed');
  }
  return pool;
}

/** cron 入口:每分钟拉一批工作项,并发跑,推进 Redis 游标实现全池滚动覆盖。 */
export async function runStepfunConsumer(): Promise<void> {
  const e = env();
  if (!e.STEPFUN_CONSUMER_ENABLED) return;

  const pool = buildPool();
  if (pool.length === 0) return;

  const perTick = e.STEPFUN_CONSUMER_CALLS_PER_TICK;
  const r = getRedis();

  let cursor = 0;
  try {
    const raw = await r.get(CURSOR_KEY);
    const parsed = raw ? parseInt(raw, 10) : 0;
    if (Number.isFinite(parsed) && parsed >= 0) cursor = parsed % pool.length;
  } catch { /* 游标丢失从 0 起,无害 */ }

  const batch: WorkItem[] = [];
  for (let i = 0; i < perTick; i++) batch.push(pool[(cursor + i) % pool.length]!);
  try {
    await r.set(CURSOR_KEY, String((cursor + perTick) % pool.length));
  } catch { /* 推进失败下 tick 重叠覆盖,非致命 */ }

  const limit = pLimit(Math.max(1, e.STEPFUN_CONSUMER_CONCURRENCY));
  let reflected = 0;
  let merged = 0;
  let approxInputTokens = 0;

  await Promise.all(
    batch.map((item) =>
      limit(async () => {
        try {
          if (item.kind === 'group') {
            const t = await reflectChat(item.id);
            if (t > 0) {
              reflected++;
              approxInputTokens += t;
            }
          } else {
            const ok = await mergeGlobalProfile(item.id);
            if (ok) merged++;
          }
        } catch (err) {
          logger.debug({ err, item }, 'stepfun-consumer: item failed (non-critical)');
        }
      }),
    ),
  );

  // 估算日 token(输入口径×1.15;每分钟一 tick → ×1440)。merge 的输出未计入,偏保守。
  const estTokensPerDay = Math.round(approxInputTokens * 1.15 * 1440);
  logger.info(
    {
      poolSize: pool.length,
      perTick,
      concurrency: e.STEPFUN_CONSUMER_CONCURRENCY,
      reflected,
      merged,
      approxInputTokens,
      estTokensPerDay,
      cursorNext: (cursor + perTick) % pool.length,
    },
    'stepfun-consumer tick complete',
  );
}
