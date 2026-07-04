// ────────────────────────────────────────
// StepFun 配额消费引擎(用户选:滚动深反思)
// ────────────────────────────────────────
// 目标:8000M/月订阅目前用得太少(<20M/天)。真实流量(~13 活跃群 + 数十跨群用户)
// 产不出 100M/天的**新**内容,所以本引擎在 10 并发/2000RPM 内,对**全量工作池**
// (所有群深反思 + 跨上下文画像合并)做**滚动再加工**:内容真实演化的群反思是主力
// (最不浪费),跨上下文合并顺带跑。速率用旋钮控:
//   日调用 ≈ CALLS_PER_TICK × 1440(每分钟一 tick)。
//   工作池 ≈ 群数×REFLECT_WEIGHT + person_identity 人数;池越大 → 单项重复率越低。
// 路由:群反思走 reflectChat → REFLECTION_USAGE;跨上下文合并走 mergeGlobalProfile
// → PROFILE_MERGE_USAGE(引擎本身不做模型路由,复用这俩已导出函数各自的 usage)。默认关。
//
// 内部时限(TICK_DEADLINE_MS):safeRun 的超时用 Promise.race,**不会取消**已在跑的
// p-limit 任务;若一 tick 因 StepFun 拥塞跑过 60s,下一分钟的 cron tick 会与之重叠、
// 叠加占用共享的 8 并发账号 → 挤到用户可见的 reply/judge。故引擎自带墙钟时限:超时后
// 不再启动新工作项,把单 tick 的在飞时间收敛在一个 tick 间隔内,杜绝跨 tick 重叠。

import pLimit from 'p-limit';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { reflectChat } from './deep-reflection.js';
import { mergeGlobalProfile } from './profile-merge.js';

const CURSOR_KEY = 'xxb:stepfun_consumer:cursor';
// 单 tick 墙钟时限:超过就不再启动新工作项(已在飞的自然收尾)。略小于 cron 间隔(60s),
// 确保本 tick 的在飞调用在下一 tick 起跑前基本清空,不叠加占用共享的 8 并发账号。
const TICK_DEADLINE_MS = 55_000;

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
  const groups: WorkItem[] = [];
  const merges: WorkItem[] = [];
  try {
    const groupRows = db
      .prepare('SELECT DISTINCT chat_id FROM user_profiles WHERE chat_id < 0')
      .all() as Array<{ chat_id: number }>;
    const weight = Math.max(1, env().STEPFUN_CONSUMER_REFLECT_WEIGHT);
    for (const g of groupRows) {
      for (let i = 0; i < weight; i++) groups.push({ kind: 'group', id: g.chat_id });
    }
    const people = db
      .prepare('SELECT uid FROM person_identity WHERE uid > 0 ORDER BY updated_at DESC')
      .all() as Array<{ uid: number }>;
    for (const p of people) merges.push({ kind: 'merge', id: p.uid });
  } catch (err) {
    logger.warn({ err }, 'stepfun-consumer: pool build failed');
    return [];
  }
  return interleave(groups, merges);
}

/**
 * 交错编织两类工作项,让**任意连续游标窗口**都保持稳定的 群/合并 混合比例。
 * 否则(简单拼接)游标会整段落进"只有合并项(多为无产出秒退)"的区间 → token 速率忽高忽低。
 * 以较长的一方为基准,按均匀步长把较短一方插入其间。
 */
function interleave(a: WorkItem[], b: WorkItem[]): WorkItem[] {
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (short.length === 0) return long;
  const pool: WorkItem[] = [];
  const step = long.length / short.length;
  let si = 0;
  let nextInsert = step;
  for (let i = 0; i < long.length; i++) {
    pool.push(long[i]!);
    if (i + 1 >= nextInsert && si < short.length) {
      pool.push(short[si++]!);
      nextInsert += step;
    }
  }
  while (si < short.length) pool.push(short[si++]!);
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
  const deadline = Date.now() + TICK_DEADLINE_MS;
  let reflected = 0;
  let merged = 0;
  let approxInputTokens = 0;
  let skipped = 0;

  await Promise.all(
    batch.map((item) =>
      limit(async () => {
        // 墙钟时限:排队中的任务在轮到自己时若已超时,直接跳过——把单 tick 的在飞
        // 时间收敛在 TICK_DEADLINE_MS 内,杜绝与下一 tick 重叠挤爆账号并发。
        if (Date.now() > deadline) { skipped++; return; }
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
      skipped, // 因墙钟时限被跳过的项数;持续 >0 说明 tick 跑不完,该降 CALLS_PER_TICK/CONCURRENCY
      approxInputTokens,
      estTokensPerDay,
      cursorNext: (cursor + perTick) % pool.length,
    },
    'stepfun-consumer tick complete',
  );
}
