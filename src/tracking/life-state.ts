// ────────────────────────────────────────
// Life State — bot 的作息/状态机(#5)+ lazy day(#12)
// ────────────────────────────────────────
//
// 真人有生活节奏:凌晨三点不会秒回,午饭点在吃饭,偶尔一整天犯懒。
// 此前 bot 只在 prompt 里有一行静态北京时间,行为上 24h 全勤等速。
//
// 设计:**纯函数,日期种子确定性**。当天的作息表由"北京日期字符串的
// hash"播种的 PRNG 生成 —— 同一天内多次调用结果一致,跨天自动重 roll,
// 不需要 cron、不需要 Redis、重启无状态丢失。
//
// 输出同时供三层使用:
//   - prompt hint([当前状态] 注入,人格层面自洽)
//   - speedFactor(去抖/延迟调速,行为层面自洽)
//   - energy(供 judge focus 调制)
// 边界:direct 交互(@/回复 bot/主人指令)不受调速影响(scheduler 的
// direct 路径 delay=0 不经过 speedFactor)。

/** mulberry32 — 小而稳定的种子 PRNG */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type LifeStateKind = 'sleeping' | 'eating' | 'lazy' | 'normal';

export interface LifeState {
  state: LifeStateKind;
  /** 0..1 当前精力(供 focus/judge 调制) */
  energy: number;
  /** 注入 prompt 的状态提示;normal 白天为 null(不打扰) */
  hint: string | null;
  /** 延迟/去抖的放大系数(1 = 正常速度) */
  speedFactor: number;
  /** 今天是不是 lazy day(全天生效,与瞬时 state 叠加) */
  lazyDay: boolean;
}

interface DaySchedule {
  /** 起床(北京分钟数) */
  wakeMin: number;
  /** 入睡(北京分钟数,>1440 表示跨到次日) */
  sleepMin: number;
  lunchStart: number;
  lunchEnd: number;
  dinnerStart: number;
  dinnerEnd: number;
  lazyDay: boolean;
}

/** 当天作息表(date-seeded,确定性) */
export function daySchedule(bjDateStr: string): DaySchedule {
  const rand = mulberry32(hashString(bjDateStr));
  const wakeMin = 7 * 60 + Math.floor(rand() * 90); // 07:00–08:30
  const sleepMin = 23 * 60 + 30 + Math.floor(rand() * 90); // 23:30–01:00(次日)
  const lunchStart = 12 * 60 + Math.floor(rand() * 30);
  const lunchEnd = lunchStart + 30 + Math.floor(rand() * 20);
  const dinnerStart = 18 * 60 + 30 + Math.floor(rand() * 40);
  const dinnerEnd = dinnerStart + 30 + Math.floor(rand() * 20);
  const lazyDay = rand() < 0.1;
  return { wakeMin, sleepMin, lunchStart, lunchEnd, dinnerStart, dinnerEnd, lazyDay };
}

const LAZY_HINTS = [
  '今天莫名有点蔫,什么都提不起劲,能一个字就不两个字',
  '今天是本喵的摆烂日,回话懒洋洋的,多用"嗯""哦""随便"',
];
const SLEEPY_HINTS = [
  '现在是深夜,你困得要命,刚被消息吵醒——回话又短又迷糊,带起床气,能不回就不回',
];
const NIGHT_OWL_HINT = '夜深了,你有点困但还赖着没睡,回话比白天慢半拍、短一些';
const EATING_HINTS = [
  '你正在吃饭,一边扒饭一边瞄手机——回话简短,可以提一嘴在吃什么',
];

/**
 * 当前生活状态。纯函数:同一时刻调用结果一致。
 * @param now 默认当前时间;测试可注入
 */
export function getLifeState(now: Date = new Date()): LifeState {
  // 北京时间(UTC+8 固定,无夏令时)
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const dateStr = bj.toISOString().slice(0, 10);
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const sched = daySchedule(dateStr);
  // 凌晨段(00:00–wake)属于"昨晚的睡眠",用昨天的表判断入睡点
  const prevDate = new Date(bj.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
  const prevSched = daySchedule(prevDate);

  const pick = <T>(arr: T[]): T => arr[hashString(dateStr) % arr.length]!;

  // ── sleeping:今晚入睡点(若在今天 24 点前)/ 昨晚的睡眠延续到今早起床 ──
  // 晚段:今天的 sleepMin < 1440 且已过 → 睡了
  const asleepEvening = sched.sleepMin < 1440 && minutes >= sched.sleepMin;
  // 早段:还没到今天的 wakeMin,且已过"昨晚入睡点在今天的投影"
  //   昨晚 sleepMin >= 1440 → 实际入睡在今天 (sleepMin-1440);否则昨晚就睡了
  const prevSleepStartToday = prevSched.sleepMin >= 1440 ? prevSched.sleepMin - 1440 : 0;
  const asleepMorning = minutes < sched.wakeMin && minutes >= prevSleepStartToday;
  if (asleepEvening || asleepMorning) {
    return {
      state: 'sleeping',
      energy: 0.12,
      hint: `[当前状态] ${pick(SLEEPY_HINTS)}`,
      speedFactor: 2.4,
      lazyDay: sched.lazyDay,
    };
  }

  // ── eating ──
  if ((minutes >= sched.lunchStart && minutes < sched.lunchEnd) || (minutes >= sched.dinnerStart && minutes < sched.dinnerEnd)) {
    return {
      state: 'eating',
      energy: 0.55,
      hint: `[当前状态] ${pick(EATING_HINTS)}`,
      speedFactor: 1.6,
      lazyDay: sched.lazyDay,
    };
  }

  // ── 深夜未睡(22:00 之后) ──
  const lateNight = minutes >= 22 * 60;
  // 刚醒一小时内迷糊
  const justWoke = minutes >= sched.wakeMin && minutes < sched.wakeMin + 45;

  let energy = 0.85;
  let speedFactor = 1;
  let hint: string | null = null;
  if (justWoke) {
    energy = 0.5;
    speedFactor = 1.3;
    hint = '[当前状态] 刚睡醒没多久,还有点迷糊';
  } else if (lateNight) {
    energy = 0.55;
    speedFactor = 1.4;
    hint = `[当前状态] ${NIGHT_OWL_HINT}`;
  }

  if (sched.lazyDay) {
    energy = Math.min(energy, 0.45);
    speedFactor = Math.max(speedFactor, 1.3);
    hint = `[今日状态] ${pick(LAZY_HINTS)}${hint ? `\n${hint}` : ''}`;
    return { state: 'lazy', energy, hint, speedFactor, lazyDay: true };
  }

  return { state: 'normal', energy, hint, speedFactor, lazyDay: false };
}
