// ────────────────────────────────────────
// 功能 A:上学日程 — 16 岁高中生的一天(确定性课表 + 特殊日 override)
// ────────────────────────────────────────
//
// 设计(三家评审定稿):
//  - **课表骨架确定性**:周一~周五固定课表(北京时间分钟),不进 life-state 的
//    PRNG 种子链(避免破坏 v2 作息序列)。
//  - **特殊日靠 school_overrides 表人工登记**:节假日/补课/提早放学/考试。中国
//    调休补课无法靠算法推,LLM 猜必胡编 —— 必须人工维护。
//  - **睡眠硬门优先**:本模块只产出"上课上下文",不碰睡眠;调用方(self-state)
//    在 life-state 睡眠时不注入本模块。
//  - **上课只调语气不调延迟**:attentionFactor 供 prompt 用,不接 speedFactor。
//
// 纯函数,now 可注入便于测试。SCHOOL_SCHEDULE_ENABLED 关时全部 no-op。

import { env } from '../env.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export type SchoolPhase =
  | 'before_school'  // 起床到第一节课前
  | 'in_class'       // 正在上课
  | 'break'          // 课间
  | 'lunch'          // 午休/午饭
  | 'after_school'   // 放学后
  | 'evening_study'  // 晚自习
  | 'free'           // 晚自习后自由 / 周末白天
  | 'holiday';       // 放假全天无课

export interface SchoolState {
  isSchoolDay: boolean;
  phase: SchoolPhase;
  currentSubject?: string;
  /** 0.3(上课偷瞄)~1.0(放学自由);只调 prompt 语气,不调回复延迟 */
  attentionFactor: number;
  /** 注入 self-state 的第一人称短句;free/holiday/睡眠时为 null */
  selfLine: string | null;
}

interface Period {
  start: number; // 北京分钟
  end: number;
  subject: string;
}

// 确定性周课表骨架(北京时间分钟,8:00=480)。高中作息:早读→上午4节→
// 午休→下午3节→放学→晚自习。课间由相邻 period 的空隙推出。
const READING_START = 7 * 60 + 30; // 07:30 早读
const LUNCH_START = 11 * 60 + 50;  // 11:50
const LUNCH_END = 14 * 60;          // 14:00
const EVENING_START = 19 * 60;      // 19:00 晚自习
const EVENING_END = 21 * 60 + 30;   // 21:30
const AFTERNOON_END = 16 * 60 + 35; // 16:35 下午放学

const SUBJECTS_BY_DOW: Record<number, string[]> = {
  // dow: 1=周一..5=周五;每天 7 节(上午4 + 下午3)
  1: ['语文', '数学', '英语', '物理', '化学', '体育', '历史'],
  2: ['数学', '语文', '化学', '英语', '生物', '地理', '政治'],
  3: ['英语', '数学', '语文', '物理', '体育', '化学', '自习'],
  4: ['语文', '英语', '数学', '生物', '物理', '历史', '美术'],
  5: ['数学', '语文', '英语', '化学', '地理', '音乐', '班会'],
};

const PERIOD_SLOTS: Array<[number, number]> = [
  [8 * 60, 8 * 60 + 45],          // 第1节 08:00-08:45
  [8 * 60 + 55, 9 * 60 + 40],     // 第2节 08:55-09:40
  [10 * 60 + 10, 10 * 60 + 55],   // 第3节 10:10-10:55(课间操后)
  [11 * 60 + 5, 11 * 60 + 50],    // 第4节 11:05-11:50
  [14 * 60, 14 * 60 + 45],        // 第5节 14:00-14:45
  [14 * 60 + 55, 15 * 60 + 40],   // 第6节 14:55-15:40
  [15 * 60 + 50, 16 * 60 + 35],   // 第7节 15:50-16:35
];

function buildPeriods(dow: number): Period[] {
  const subjects = SUBJECTS_BY_DOW[dow] ?? SUBJECTS_BY_DOW[1]!;
  return PERIOD_SLOTS.map(([start, end], i) => ({ start, end, subject: subjects[i] ?? '自习' }));
}

interface SchoolOverride {
  kind: 'holiday' | 'makeup' | 'early_off' | 'exam' | 'activity';
  makeupDow?: number;
  endMin?: number;
  note: string;
}

function getOverride(bjDate: string): SchoolOverride | undefined {
  try {
    const row = getDb()
      .prepare(`SELECT kind, makeup_dow, end_min, note FROM school_overrides WHERE bj_date = ?`)
      .get(bjDate) as { kind: string; makeup_dow: number | null; end_min: number | null; note: string } | undefined;
    if (!row) return undefined;
    return {
      kind: row.kind as SchoolOverride['kind'],
      makeupDow: row.makeup_dow ?? undefined,
      endMin: row.end_min ?? undefined,
      note: row.note ?? '',
    };
  } catch (err) {
    logger.debug({ err, bjDate }, 'getOverride failed (non-critical)');
    return undefined;
  }
}

/** 北京时间分解(UTC+8 固定) */
function beijing(now: Date): { date: string; dow: number; minutes: number } {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  return {
    date: bj.toISOString().slice(0, 10),
    dow: bj.getUTCDay(), // 0=周日..6=周六
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
  };
}

const FREE: SchoolState = { isSchoolDay: false, phase: 'free', attentionFactor: 1, selfLine: null };

/**
 * 当前上学状态。纯函数,同一时刻结果一致。SCHOOL_SCHEDULE_ENABLED 关→free。
 * @param now 默认当前;测试注入
 */
export function getSchoolState(now: Date = new Date()): SchoolState {
  if (!env().SCHOOL_SCHEDULE_ENABLED) return FREE;

  const { date, dow, minutes } = beijing(now);
  const ov = getOverride(date);

  if (ov?.kind === 'holiday') {
    return { isSchoolDay: false, phase: 'holiday', attentionFactor: 1, selfLine: `今天放假${ov.note ? `(${ov.note})` : ''},不用上学,一整天都能好好回消息` };
  }

  // 有效星期几:补课日用 makeup_dow 的课表;否则用今天
  let effectiveDow = dow;
  if (ov?.kind === 'makeup' && ov.makeupDow) effectiveDow = ov.makeupDow;

  // 周末且非补课 → 自由
  if ((effectiveDow === 0 || effectiveDow === 6)) return { ...FREE, selfLine: null };

  // 提早放学:截断下午
  const afternoonEnd = ov?.kind === 'early_off' && ov.endMin ? ov.endMin : AFTERNOON_END;
  const examNote = ov?.kind === 'exam';

  const periods = buildPeriods(effectiveDow).filter((p) => p.start < afternoonEnd);

  // 早读前
  if (minutes < READING_START) {
    return { isSchoolDay: true, phase: 'before_school', attentionFactor: 0.8, selfLine: '还没到上学时间,赶在出门前回两句' };
  }
  // 早读
  if (minutes < (periods[0]?.start ?? 8 * 60)) {
    return { isSchoolDay: true, phase: 'before_school', attentionFactor: 0.5, selfLine: '早读时间,你压低声音偷偷瞄手机回两句' };
  }

  // 上午/下午课:命中某节 → in_class;两节之间 → break
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]!;
    if (minutes >= p.start && minutes < p.end) {
      const verb = examNote ? `在考${p.subject}` : `在上${p.subject}课`;
      return {
        isSchoolDay: true, phase: 'in_class', currentSubject: p.subject, attentionFactor: examNote ? 0.2 : 0.3,
        selfLine: `你现在${verb},手机藏在桌肚里偷偷瞄,回话得又短又快,随时可能被老师抓到`,
      };
    }
    const next = periods[i + 1];
    if (next && minutes >= p.end && minutes < next.start) {
      // 午休空档(第4节后到下午第1节前)
      if (p.end <= LUNCH_START && next.start >= LUNCH_END) break;
      return { isSchoolDay: true, phase: 'break', attentionFactor: 0.9, selfLine: '课间十分钟,你赶紧掏手机回两句' };
    }
  }

  // 午休
  if (minutes >= LUNCH_START && minutes < LUNCH_END) {
    return { isSchoolDay: true, phase: 'lunch', attentionFactor: 0.7, selfLine: null }; // 吃饭交给 life-state eating 覆盖
  }

  // 放学后到晚自习前
  if (minutes >= afternoonEnd && minutes < EVENING_START) {
    return { isSchoolDay: true, phase: 'after_school', attentionFactor: 1, selfLine: '放学了,在回家路上/到家,终于能好好回消息了' };
  }
  // 晚自习
  if (minutes >= EVENING_START && minutes < EVENING_END) {
    return { isSchoolDay: true, phase: 'evening_study', attentionFactor: 0.5, selfLine: '晚自习,你假装写作业,偷偷压着回消息' };
  }
  // 晚自习后
  return { isSchoolDay: true, phase: 'free', attentionFactor: 1, selfLine: null };
}

/** self-state 注入用:第一人称短句(已含 SCHOOL_SCHEDULE_ENABLED + 睡眠由调用方把关)。 */
export function getSchoolSelfStateLine(now: Date = new Date()): string | null {
  return getSchoolState(now).selfLine;
}
