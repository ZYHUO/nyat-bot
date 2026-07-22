// ────────────────────────────────────────
// 每日安排 — 上学课表 / 暑假作息（确定性，北京时间）
// ────────────────────────────────────────
//
// 原「周课表」升级为「每日每个点干什么」：
//  - profile=school：工作日走高中课表（早读→上课→午休→放学→晚自习）
//  - profile=summer：暑假日计划（赖床/打游戏/吃饭/午睡/出门/晚上刷剧…）
//  - profile=auto：7–8 月北京时间 → summer，否则 school；周末始终偏自由
//
// 特殊日仍靠 school_overrides。睡眠硬门由 life-state 优先，本模块只出语气。

import { env } from '../env.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export type SchoolPhase =
  | 'before_school'
  | 'in_class'
  | 'break'
  | 'lunch'
  | 'after_school'
  | 'evening_study'
  | 'free'
  | 'holiday'
  /** 暑假/日常时段（打游戏、出门等） */
  | 'day_plan';

export type DailyLifeProfile = 'auto' | 'school' | 'summer';

export interface SchoolState {
  isSchoolDay: boolean;
  phase: SchoolPhase;
  currentSubject?: string;
  /** 0.3(忙/上课)~1.0(闲);只调 prompt 语气,不调回复延迟 */
  attentionFactor: number;
  /** 注入 self-state 的第一人称短句;闲时可为 null */
  selfLine: string | null;
  /** 当前在干嘛（暑假日计划 / 课名） */
  activity?: string;
  profile: DailyLifeProfile | 'weekend';
}

interface Period {
  start: number;
  end: number;
  subject: string;
}

interface DaySlot {
  start: number;
  end: number;
  phase: SchoolPhase;
  attention: number;
  activity: string;
  selfLine: string | null;
}

const READING_START = 7 * 60 + 30;
const LUNCH_START = 11 * 60 + 50;
const LUNCH_END = 14 * 60;
const EVENING_START = 19 * 60;
const EVENING_END = 21 * 60 + 30;
const AFTERNOON_END = 16 * 60 + 35;

const SUBJECTS_BY_DOW: Record<number, string[]> = {
  1: ['语文', '数学', '英语', '物理', '化学', '体育', '历史'],
  2: ['数学', '语文', '化学', '英语', '生物', '地理', '政治'],
  3: ['英语', '数学', '语文', '物理', '体育', '化学', '自习'],
  4: ['语文', '英语', '数学', '生物', '物理', '历史', '美术'],
  5: ['数学', '语文', '英语', '化学', '地理', '音乐', '班会'],
};

const PERIOD_SLOTS: Array<[number, number]> = [
  [8 * 60, 8 * 60 + 45],
  [8 * 60 + 55, 9 * 60 + 40],
  [10 * 60 + 10, 10 * 60 + 55],
  [11 * 60 + 5, 11 * 60 + 50],
  [14 * 60, 14 * 60 + 45],
  [14 * 60 + 55, 15 * 60 + 40],
  [15 * 60 + 50, 16 * 60 + 35],
];

/** 暑假日计划（北京分钟）。不是上课，是「这会儿在干嘛」。 */
const SUMMER_DAY_SLOTS: DaySlot[] = [
  {
    start: 0,
    end: 8 * 60 + 30,
    phase: 'free',
    attention: 0.4,
    activity: '深夜/赖床',
    selfLine: '暑假深夜或刚醒，迷迷糊糊回两句就行',
  },
  {
    start: 8 * 60 + 30,
    end: 10 * 60,
    phase: 'day_plan',
    attention: 0.7,
    activity: '赖床刷手机',
    selfLine: '暑假早晨，还赖在床上刷手机，有空就回',
  },
  {
    start: 10 * 60,
    end: 12 * 60,
    phase: 'day_plan',
    attention: 1,
    activity: '打游戏/追番',
    selfLine: '暑假上午在家打游戏或追番，能好好回消息',
  },
  {
    start: 12 * 60,
    end: 13 * 60 + 30,
    phase: 'lunch',
    attention: 0.7,
    activity: '午饭',
    selfLine: null, // 吃饭交给 life-state
  },
  {
    start: 13 * 60 + 30,
    end: 15 * 60,
    phase: 'day_plan',
    attention: 0.5,
    activity: '午睡/摸鱼',
    selfLine: '暑假午后犯困，回得慢、短一点',
  },
  {
    start: 15 * 60,
    end: 18 * 60,
    phase: 'day_plan',
    attention: 1,
    activity: '出门/逛街/继续玩',
    selfLine: '暑假下午有点空，出门或在家玩，可以正经聊',
  },
  {
    start: 18 * 60,
    end: 19 * 60 + 30,
    phase: 'lunch',
    attention: 0.7,
    activity: '晚饭',
    selfLine: null,
  },
  {
    start: 19 * 60 + 30,
    end: 23 * 60,
    phase: 'day_plan',
    attention: 1,
    activity: '晚上刷剧/群聊',
    selfLine: '暑假晚上最闲，刷剧刷群，话可以稍微多一点',
  },
  {
    start: 23 * 60,
    end: 24 * 60,
    phase: 'free',
    attention: 0.6,
    activity: '准备睡',
    selfLine: '暑假快睡了，回两句短的就收',
  },
];

function buildPeriods(dow: number): Period[] {
  const subjects = SUBJECTS_BY_DOW[dow] ?? SUBJECTS_BY_DOW[1]!;
  return PERIOD_SLOTS.map(([start, end], i) => ({
    start,
    end,
    subject: subjects[i] ?? '自习',
  }));
}

interface SchoolOverride {
  kind: 'holiday' | 'makeup' | 'early_off' | 'exam' | 'activity';
  note?: string;
  makeupDow?: number;
  endMin?: number;
}

function getOverride(bjDate: string): SchoolOverride | undefined {
  try {
    const row = getDb()
      .prepare(
        `SELECT kind, note, makeup_dow, end_min FROM school_overrides WHERE date = ? LIMIT 1`,
      )
      .get(bjDate) as
      | { kind: string; note: string | null; makeup_dow: number | null; end_min: number | null }
      | undefined;
    if (!row) return undefined;
    return {
      kind: row.kind as SchoolOverride['kind'],
      note: row.note ?? undefined,
      makeupDow: row.makeup_dow ?? undefined,
      endMin: row.end_min ?? undefined,
    };
  } catch (err) {
    logger.debug({ err, bjDate }, 'getOverride failed (non-critical)');
    return undefined;
  }
}

/** 北京时间分解(UTC+8 固定) */
function beijing(now: Date): { date: string; dow: number; minutes: number; month: number } {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  return {
    date: bj.toISOString().slice(0, 10),
    dow: bj.getUTCDay(),
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
    month: bj.getUTCMonth() + 1,
  };
}

function resolveProfile(
  configured: DailyLifeProfile,
  month: number,
  dow: number,
  ov: SchoolOverride | undefined,
): DailyLifeProfile | 'weekend' {
  if (ov?.kind === 'holiday') return 'summer'; // 放假日用暑假日计划语气
  if (configured === 'school' || configured === 'summer') return configured;
  // auto
  if (dow === 0 || dow === 6) {
    if (!(ov?.kind === 'makeup' && ov.makeupDow)) return 'weekend';
  }
  // 中国暑假粗窗口：7–8 月（精确调休靠 overrides）
  if (month === 7 || month === 8) return 'summer';
  return 'school';
}

const IDLE: SchoolState = {
  isSchoolDay: false,
  phase: 'free',
  attentionFactor: 1,
  selfLine: null,
  profile: 'summer',
};

function summerState(minutes: number): SchoolState {
  const slot =
    SUMMER_DAY_SLOTS.find((s) => minutes >= s.start && minutes < s.end) ??
    SUMMER_DAY_SLOTS[SUMMER_DAY_SLOTS.length - 1]!;
  return {
    isSchoolDay: false,
    phase: slot.phase,
    attentionFactor: slot.attention,
    selfLine: slot.selfLine,
    activity: slot.activity,
    profile: 'summer',
  };
}

function schoolWeekdayState(
  minutes: number,
  effectiveDow: number,
  afternoonEnd: number,
  examNote: boolean,
): SchoolState {
  const periods = buildPeriods(effectiveDow).filter((p) => p.start < afternoonEnd);

  if (minutes < READING_START) {
    return {
      isSchoolDay: true,
      phase: 'before_school',
      attentionFactor: 0.8,
      selfLine: '还没到上学时间,赶在出门前回两句',
      profile: 'school',
    };
  }
  if (minutes < (periods[0]?.start ?? 8 * 60)) {
    return {
      isSchoolDay: true,
      phase: 'before_school',
      attentionFactor: 0.5,
      selfLine: '早读时间,你压低声音偷偷瞄手机回两句',
      profile: 'school',
    };
  }

  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]!;
    const pEnd = Math.min(p.end, afternoonEnd);
    if (minutes >= p.start && minutes < pEnd) {
      const verb = examNote ? `在考${p.subject}` : `在上${p.subject}课`;
      return {
        isSchoolDay: true,
        phase: 'in_class',
        currentSubject: p.subject,
        activity: p.subject,
        attentionFactor: examNote ? 0.2 : 0.3,
        selfLine: `你现在${verb},手机藏在桌肚里偷偷瞄,回话得又短又快,随时可能被老师抓到`,
        profile: 'school',
      };
    }
    const next = periods[i + 1];
    if (next && minutes >= p.end && minutes < next.start) {
      if (p.end <= LUNCH_START && next.start >= LUNCH_END) break;
      return {
        isSchoolDay: true,
        phase: 'break',
        attentionFactor: 0.9,
        selfLine: '课间十分钟,你赶紧掏手机回两句',
        profile: 'school',
      };
    }
  }

  if (minutes >= LUNCH_START && minutes < LUNCH_END) {
    return {
      isSchoolDay: true,
      phase: 'lunch',
      attentionFactor: 0.7,
      selfLine: null,
      activity: '午饭',
      profile: 'school',
    };
  }

  if (minutes >= afternoonEnd && minutes < EVENING_START) {
    return {
      isSchoolDay: true,
      phase: 'after_school',
      attentionFactor: 1,
      selfLine: '放学了,在回家路上/到家,终于能好好回消息了',
      profile: 'school',
    };
  }
  if (minutes >= EVENING_START && minutes < EVENING_END) {
    return {
      isSchoolDay: true,
      phase: 'evening_study',
      attentionFactor: 0.5,
      selfLine: '晚自习,你假装写作业,偷偷压着回消息',
      activity: '晚自习',
      profile: 'school',
    };
  }
  return {
    isSchoolDay: true,
    phase: 'free',
    attentionFactor: 1,
    selfLine: null,
    profile: 'school',
  };
}

/**
 * 当前每日安排。SCHOOL_SCHEDULE_ENABLED 关 → idle。
 */
export function getSchoolState(now: Date = new Date()): SchoolState {
  if (!env().SCHOOL_SCHEDULE_ENABLED) return { ...IDLE, profile: 'summer' };

  const { date, dow, minutes, month } = beijing(now);
  const ov = getOverride(date);
  const configured = (env().DAILY_LIFE_PROFILE ?? 'auto') as DailyLifeProfile;
  const profile = resolveProfile(configured, month, dow, ov);

  if (ov?.kind === 'holiday') {
    const base = summerState(minutes);
    return {
      ...base,
      phase: 'holiday',
      selfLine: `今天放假${ov.note ? `(${ov.note})` : ''}，按暑假节奏过日子：${base.activity ?? '自由'}`,
      profile: 'summer',
    };
  }

  if (profile === 'summer' || profile === 'weekend') {
    const base = summerState(minutes);
    if (profile === 'weekend') {
      return {
        ...base,
        profile: 'weekend',
        selfLine: base.selfLine
          ? base.selfLine.replace(/暑假/g, '周末')
          : '周末自由日，有空就回',
      };
    }
    return base;
  }

  // school profile
  let effectiveDow = dow;
  if (ov?.kind === 'makeup' && ov.makeupDow) effectiveDow = ov.makeupDow;
  if (effectiveDow === 0 || effectiveDow === 6) {
    const base = summerState(minutes);
    return {
      ...base,
      profile: 'weekend',
      selfLine: base.selfLine
        ? base.selfLine.replace(/暑假/g, '周末')
        : '周末自由日，有空就回',
    };
  }

  const afternoonEnd = ov?.kind === 'early_off' && ov.endMin ? ov.endMin : AFTERNOON_END;
  return schoolWeekdayState(minutes, effectiveDow, afternoonEnd, ov?.kind === 'exam');
}

export function getSchoolSelfStateLine(now: Date = new Date()): string | null {
  return getSchoolState(now).selfLine;
}

export function getSchoolAttentionFactor(now: Date = new Date()): number {
  return getSchoolState(now).attentionFactor;
}

/**
 * 今天安排的客观描述（喂「今日感想」LLM）。
 */
export function getDaySummary(now: Date = new Date()): { isSchoolDay: boolean; text: string } | null {
  if (!env().SCHOOL_SCHEDULE_ENABLED) return null;
  const { date, dow, month, minutes } = beijing(now);
  void minutes;
  const ov = getOverride(date);
  const configured = (env().DAILY_LIFE_PROFILE ?? 'auto') as DailyLifeProfile;
  const profile = resolveProfile(configured, month, dow, ov);

  if (ov?.kind === 'holiday') {
    return {
      isSchoolDay: false,
      text: `今天放假${ov.note ? `(${ov.note})` : ''}，暑假/假日日计划：赖床、玩、吃饭、出门、晚上刷剧`,
    };
  }
  if (profile === 'summer') {
    const plan = SUMMER_DAY_SLOTS.map((s) => {
      const h = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
      return `${h(s.start)}-${h(s.end)} ${s.activity}`;
    }).join('；');
    return { isSchoolDay: false, text: `今天暑假在家。日计划：${plan}` };
  }
  if (profile === 'weekend') {
    return { isSchoolDay: false, text: '今天周末，不用上学，按休息日节奏自由安排' };
  }

  let effectiveDow = dow;
  if (ov?.kind === 'makeup' && ov.makeupDow) effectiveDow = ov.makeupDow;
  if (effectiveDow === 0 || effectiveDow === 6) {
    return { isSchoolDay: false, text: '今天周末,不用上学,自由' };
  }
  const dowName = ['日', '一', '二', '三', '四', '五', '六'][effectiveDow];
  const subjects = (SUBJECTS_BY_DOW[effectiveDow] ?? SUBJECTS_BY_DOW[1]!).join('、');
  return {
    isSchoolDay: true,
    text: `今天周${dowName}工作日,要上学,课表大致是:${subjects}`,
  };
}
