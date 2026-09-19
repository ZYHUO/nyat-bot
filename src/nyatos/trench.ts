// ────────────────────────────────────────
// Nyat Trench · L0 海床（Bed）——有界积分器
// ────────────────────────────────────────
//
// 论文：docs/plans/2026-09-19-nyat-trench.md §3.2 机制二
//
// 这是整个新架构里**唯一有状态**的一层，因此也是唯一必须被硬测试锁死的一层。
// 它做的事只有一件：把"过去发生过什么"压成两个有界标量，对外只给一个读数。
//
//   P（气压）= 想说而未说出口的冲动存量 + 已说而未得到回声的负债
//   θ（岸线）= 开口水位线，单位 次/小时
//   r = clamp(θ · g(P), 0.25, 6) 次/小时
//
// **结构性保证（不是调参）**：
//   P=0  时 r ≥ 1.4 次/小时  → 不会消失
//   P=12 时 r ≤ 6   次/小时 → 不会吵
// 两个方向同时封死，靠的是夹取，不是阈值调优。
//
// 三条铁律（论文 §3.2）：
//   1. **单点写入**：唯一增量方是 L2-Echo（pulseFor），唯一衰减方是时间泵
//      （pump），唯一硬复位方是运维端点（reset）。不存在第二个 setter。
//   2. **可观测**：每次变化写 JSONL，5 分钟内可检索。
//   3. **失败泄压**：下层异常不得使 P 增加（见 releasePressure）。
//
// 为什么这东西必须存在（论文 §1.3，本仓库已做过的负结果）：
//   NyatOS Phase 2.3 用 54 样本影子运行测过"删掉物理约束、让单决策点自己选
//   什么时候说"——28 分钟 48 次 speak、间隔中位 7 秒；即使把"你 2 分钟发了
//   4 条、3 条没人理"当纯事实告诉模型，它仍然选择说。
//   所以宿主必须持有一个**模型看得见但改不了**的量。P/θ 就是那个量。

import { getRedis } from '../db/redis.js';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../shared/logger.js';

/** 气压上下界。超出即钳制，不是拒绝。 */
export const P_MIN = 0;
export const P_MAX = 12;

/** 速率夹取带（次/小时）。这是整个架构的"沟壁"。 */
export const R_MIN = 0.25;
export const R_MAX = 6;

/** 岸线初值与第一期冻结值。开放学习前的保守值。 */
const THETA_DEFAULT = 4.0;
const THETA_MIN = 0.35;
const THETA_MAX = 4.0;

/** 时间泵半衰期（秒）。 */
const PUMP_HALFLIFE_SEC = 3600;

const KEY_P = 'xxb:trench:p:';
const KEY_THETA = 'xxb:trench:theta:';
const KEY_LAST_PUMP = 'xxb:trench:lastpump:';
const KEY_PFULL_SINCE = 'xxb:trench:pfull_since:';

// 观测日志路径。
//
// **VITEST 下改道**：与 src/db/sqlite.ts、src/db/redis.ts 同一套隔离约定——
// 测试里 getRedis() 走 db 0、getDb() 走 :memory:，所以观测也必须改道，否则
// observe() 的 appendFileSync 会把测试的假 chatId 写进生产 var/trench.jsonl。
// 实测踩过两次：trench.test.ts 的 afterEach 删掉过 178 行真实事件；
// echo.test.ts 的 settleEcho 又写进一批 chatId=-100 的假脉冲。
const isVitest = !!process.env['VITEST'];
const OBSERVATION_LOG = isVitest ? 'var/trench.test.jsonl' : 'var/trench.jsonl';

export interface TrenchReading {
  chatId: number;
  /** 气压，已钳制在 [P_MIN, P_MAX]。 */
  p: number;
  /** 岸线（次/小时）。 */
  theta: number;
  /** 当前允许速率（次/小时），已夹取在 [R_MIN, R_MAX]。 */
  rate: number;
  /** 从 P 读出的"饥渴感"，供 Frame 渲染成事实。 */
  urge: number;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function chatKey(prefix: string, chatId: number): string {
  return `${prefix}${chatId}`;
}

/** P 不影响速率的方向性，只影响幅度：g(0)=0.35, g(12)=1.0。 */
function gain(p: number): number {
  return 0.35 + 0.65 * (p / P_MAX);
}

/** 观测日志的轮转阈值：超过就改名成 .1（只保留一代）。 */
const OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;

function observe(event: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(OBSERVATION_LOG), { recursive: true });
    // 轮转：这个日志没有任何工具消费方（唯一读取方式是运维 grep），
    // 而时间泵每个小时给每个活跃群写一行——20 群 ≈ 480 行/小时 ≈ 1MB/天，
    // 不设上限就是一条只涨不消费的纯成本。保留一代 .1 够做"上一次"的对照。
    try {
      const st = statSync(OBSERVATION_LOG);
      if (st.size > OBSERVATION_MAX_BYTES) renameSync(OBSERVATION_LOG, `${OBSERVATION_LOG}.1`);
    } catch { /* 文件不存在 = 首次写入，无需轮转 */ }
    appendFileSync(OBSERVATION_LOG, `${JSON.stringify({ ts: Math.floor(Date.now() / 1000), ...event })}\n`);
  } catch {
    /* 观测失败绝不影响主路径 */
  }
}

/**
 * 读一次海床。**这是 L1/L2/L3/L4 唯一的入口，只有这一个 getter。**
 *
 * 读失败 → 返回一个中立读数（P=0, θ=默认），调用方按"可以走常规路径"处理。
 * 刻意不抛错：海床读不到不该让整条链停下（论文 §7.1 失败泄压）。
 */
export async function readTrench(chatId: number): Promise<TrenchReading> {
  const neutral: TrenchReading = { chatId, p: 0, theta: THETA_DEFAULT, rate: R_MIN * 4, urge: 0 };
  if (!Number.isSafeInteger(chatId) || chatId === 0) return neutral;
  try {
    const redis = getRedis();
    const [pRaw, thetaRaw] = await Promise.all([
      redis.get(chatKey(KEY_P, chatId)),
      redis.get(chatKey(KEY_THETA, chatId)),
    ]);
    // pRaw/thetaRaw 是 string | null；null → 默认值（0 / 默认岸线）
    const p = clamp(Number(pRaw === null ? 0 : pRaw), P_MIN, P_MAX);
    const theta = clamp(Number(thetaRaw === null ? THETA_DEFAULT : thetaRaw), THETA_MIN, THETA_MAX);
    const rate = clamp(theta * gain(p), R_MIN, R_MAX);
    return { chatId, p, theta, rate, urge: p / P_MAX };
  } catch (err) {
    logger.debug({ err, chatId }, 'trench read failed — neutral reading');
    return neutral;
  }
}

/**
 * 渲染成 Frame 事实行。
 *
 * 刻意做成"身体感受"而不是配额：不说"你还可以说 N 条"，说"你有点想说话/
 * 你这一阵子说得够多了"。论文 §4 表 5：旧 gate 静默丢弃，海沟把状态告诉模型。
 */
export function renderTrench(r: TrenchReading): string {
  if (r.p <= 0.05) return '';
  if (r.urge < 0.34) return `[身体] 你有点想说话（气压 ${r.p.toFixed(1)}）。`;
  if (r.urge < 0.67) return `[身体] 你挺想说话的，攒了一阵子了（气压 ${r.p.toFixed(1)}）。`;
  return `[身体] 你憋了一肚子话（气压 ${r.p.toFixed(1)}）——但嗓子的事另算，别当许可。`;
}

/**
 * L2-Echo 的唯一入口：一次交互闭环结算后给 P 加 δ。
 *
 * δ ∈ [0,1]，一次闭环最多 +1。这不是奖励函数，是"没被听见的累积"。
 * 注意方向：**被无视才让 P 涨**（憋着），被接住让 P 泄（见 releasePressure）。
 */
export async function pulseForUnheard(chatId: number, delta: number): Promise<void> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return;
  const d = clamp(Number(delta), 0, 1);
  if (d <= 0) return;
  try {
    const redis = getRedis();
    const k = chatKey(KEY_P, chatId);
    const cur = Number(await redis.get(k));
    const next = clamp((Number.isFinite(cur) ? cur : 0) + d, P_MIN, P_MAX);
    await redis.set(k, String(next));
    observe({ chatId, kind: 'pulse', delta: d, p: next });
  } catch (err) {
    logger.debug({ err, chatId }, 'trench pulse failed (non-critical)');
  }
}

/**
 * 说出口了 → 气压泄放。
 *
 * 抽 85% 而不是清零：论文 §7.1 的结构性论证——"一次 speak 抽掉 85% 气压，而
 * τ=3h 的念头 10 分钟只衰减 4%，抽水速率严格超过填充速率上界，稳态 P 有界"。
 */
export async function releasePressure(chatId: number): Promise<void> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return;
  try {
    const redis = getRedis();
    const k = chatKey(KEY_P, chatId);
    const pRaw = await redis.get(k);
    const before = clamp(Number(pRaw === null ? 0 : pRaw), P_MIN, P_MAX);
    const after = before * 0.15;
    await redis.set(k, String(after));
    observe({ chatId, kind: 'release', delta: before - after, p: after });
  } catch (err) {
    logger.debug({ err, chatId }, 'trench release failed (non-critical)');
  }
}

/**
 * 时间泵：每个窗口把 P 减半。
 *
 * 由调用方（heart 泵）每 PUMP_HALFLIFE_SEC 调一次，内部用 Redis 记上次泵浦时间
 * 防止重复半衰（半衰两次 = 除了四分之一，时钟被绕）。
 */
export async function pump(chatId: number, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return false;
  try {
    const redis = getRedis();
    const lastRaw = await redis.get(chatKey(KEY_LAST_PUMP, chatId));
    const last = Number(lastRaw ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < PUMP_HALFLIFE_SEC) return false;
    const k = chatKey(KEY_P, chatId);
    const cur = Number(await redis.get(k));    const before = clamp(Number.isFinite(cur) ? cur : 0, P_MIN, P_MAX);
    const after = before * 0.5;
    await redis.set(k, String(after));
    await redis.set(chatKey(KEY_LAST_PUMP, chatId), String(now));
    observe({ chatId, kind: 'pump', delta: before - after, p: after, resetKind: 'time' });
    return true;
  } catch (err) {
    logger.debug({ err, chatId }, 'trench pump failed (non-critical)');
    return false;
  }
}

/**
 * 运维硬复位：立即 P←0、θ←默认、写审计行。
 *
 * 这是 satiation latch 事故（4 天 66 veto 无人知，根因是 `updated_at` 被非权威方
 * 刷新）的直接对策——论文 §6 约束 4：任何 host 否决器必须可被强制解锁。
 */
export async function resetTrench(chatId: number): Promise<void> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return;
  try {
    const redis = getRedis();
    await Promise.all([
      redis.set(chatKey(KEY_P, chatId), '0'),
      redis.set(chatKey(KEY_THETA, chatId), String(THETA_DEFAULT)),
      redis.del(chatKey(KEY_LAST_PUMP, chatId)),
    ]);
    observe({ chatId, kind: 'reset', p: 0, theta: THETA_DEFAULT, resetKind: 'ops' });
    logger.warn({ chatId }, 'trench hard reset by operator');
  } catch (err) {
    logger.debug({ err, chatId }, 'trench reset failed (non-critical)');
  }
}

/**
 * 相位跳变检测：睡→醒的那一瞬间当场记录各群气压。
 *
 * 为什么必须**独立于时间泵**：泵浦每 30 分钟一次，且先减半 P。如果用它检测，
 * 00:14 醒来要等 00:34 才被记录，而 P 已被减半两次——记录值只有实际醒来值的
 * 四分之一，足以让"睡眠积压"这个特性看起来完全没生效。
 *
 * @returns 是否检测到本次调用是新的一次醒来
 */
export async function detectWakeTransition(activeChatIds: number[]): Promise<boolean> {
  const KEY = 'xxb:trench:lastphase';
  try {
    const { getLifeState } = await import('../tracking/life-state.js');
    const redis = getRedis();
    const phase = getLifeState().state;
    const prev = await redis.get(KEY);
    if (prev === phase) return false;
    await redis.set(KEY, phase);
    if (prev === 'sleeping' && phase !== 'sleeping') {
      const atWake = await Promise.all(
        activeChatIds.map(async (id) => ({ id, p: (await readTrench(id)).p })),
      );
      const elevated = atWake.filter((x) => x.p > 0);
      logger.warn(
        { event: 'trench_wakeup', chats: elevated },
        'trench: bot woke up — pressure carried into the first minutes',
      );
      return true;
    }
    return false;
  } catch (err) {
    logger.debug({ err }, 'wake transition detect failed (non-critical)');
    return false;
  }
}

/**
 * 卡死自恢复：P 连续顶在 P_MAX 超过 stuckHours → 硬复位。
 *
 * 为什么抽成函数：之前这段逻辑内联在 cron 里，测试只能"复刻它的判断"而不是调用它
 * ——而复刻的测试验的是复印件。这个仓库最爱的那类失败。
 *
 * @returns 是否执行了复位
 */
export async function recoverIfStuck(chatId: number, stuckHours = 6): Promise<boolean> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return false;
  try {
    const redis = getRedis();
    const pRaw = await redis.get(chatKey(KEY_P, chatId));
    const p = clamp(Number(pRaw === null ? 0 : pRaw), P_MIN, P_MAX);
    if (p < P_MAX - 0.001) {
      // 没顶格：清掉计时键，避免残留导致将来误复位
      await redis.del(chatKey(KEY_PFULL_SINCE, chatId));
      return false;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceKey = chatKey(KEY_PFULL_SINCE, chatId);
    const sinceRaw = await redis.get(sinceKey);
    if (sinceRaw === null) {
      await redis.set(sinceKey, String(nowSec), 'EX', Math.round(stuckHours * 3600 * 2));
      return false;
    }
    const since = Number(sinceRaw);
    if (!Number.isFinite(since) || nowSec - since < stuckHours * 3600) return false;

    await resetTrench(chatId);
    await redis.del(sinceKey);
    logger.warn(
      { chatId, stuckHours, p },
      'trench: pressure pinned at P_MAX — hard reset by recoverIfStuck',
    );
    return true;
  } catch (err) {
    logger.debug({ err, chatId }, 'recoverIfStuck failed (non-critical)');
    return false;
  }
}

/** 测试/运维用：把岸线写回去（生产不开放，θ 第一期冻结）。
 *
 * 这是**故意**只有测试会调的导出：θ 在第一期冻结为 4.0，生产没有任何理由改它；
 * 它存在的意义是让测试能验证 θ 被硬钳在 [0.35, 4.0]，从而证明 R_MAX 是死钳。
 * tests/unit/nyatos/trench-exports.test.ts 把它登记为唯一允许的 TESTONLY 导出。 */
export async function setThetaForTest(chatId: number, theta: number): Promise<void> {
  const redis = getRedis();
  await redis.set(chatKey(KEY_THETA, chatId), String(clamp(theta, THETA_MIN, THETA_MAX)));
}

/** 观测日志路径导出，便于测试清理。 */
export const TRENCH_OBSERVATION_LOG = OBSERVATION_LOG;
