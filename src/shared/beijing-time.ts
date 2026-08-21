// ────────────────────────────────────────
// 北京时间（UTC+8 / Asia/Shanghai）展示与日段
// ────────────────────────────────────────
// Meta / CodeAct 的 `## Now` 绝不能用 `toISOString()`（永远是 Zulu），
// 否则晚上 17:40 会被模型读成早上 09:40。

export const BEIJING_TZ = 'Asia/Shanghai';

export type DayPeriod =
  | '凌晨'
  | '清晨'
  | '早上'
  | '上午'
  | '中午'
  | '下午'
  | '傍晚'
  | '晚上'
  | '深夜';

/** 北京时间小时 0–23 */
export function beijingHour(now: Date = new Date()): number {
  const h = Number(
    now.toLocaleString('en-GB', {
      timeZone: BEIJING_TZ,
      hour: '2-digit',
      hour12: false,
    }),
  );
  // en-GB 偶发给 24:xx 表示午夜
  return Number.isFinite(h) ? h % 24 : 0;
}

export function dayPeriod(hour: number): DayPeriod {
  if (hour < 5) return '凌晨';
  if (hour < 7) return '清晨';
  if (hour < 9) return '早上';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 18) return '下午';
  if (hour < 19) return '傍晚';
  if (hour < 23) return '晚上';
  return '深夜';
}

/** 给 prompt 用的「现在几点」一行（含日段，避免模型只看 ISO 误判早晚） */
export function formatBeijingNowLine(now: Date = new Date()): string {
  const clock = now.toLocaleString('zh-CN', {
    timeZone: BEIJING_TZ,
    dateStyle: 'full',
    timeStyle: 'short',
  });
  const hour = beijingHour(now);
  const period = dayPeriod(hour);
  const fest = festivalHint(now);
  return `${clock}（北京时间 UTC+8，现在是${period}${fest ? `，${fest}` : ''}）`;
}

// ── 节日/纪念日环境感知 ────────────────────────────────────────────
// 真人感：bot 该自己知道今天是七夕/中秋，不用主人提醒（2026-08-19 七夕靠主人
// 教的事故）。这是「环境事实」不是语义判断——查表给事实，提不提由 bot 自己决定。
// 农历日期每年公历不同，查表只收**外部来源实证过**的日期（说错节日比不知道更糟）。
// ⚠️ 表覆盖到 2027 年底——2028 年到来前必须续表（搜「2028 农历公历对照」）。

const SOLAR_FESTIVALS: Record<string, string> = {
  '1/1': '元旦',
  '2/14': '情人节',
  '3/8': '妇女节',
  '4/1': '愚人节',
  '5/1': '劳动节',
  '5/4': '青年节',
  '5/20': '520',
  '6/1': '儿童节',
  '9/10': '教师节',
  '10/1': '国庆节',
  '10/31': '万圣夜',
  '11/1': '万圣节',
  '11/11': '双十一',
  '12/24': '平安夜',
  '12/25': '圣诞节',
  '12/31': '跨年夜',
};

// 农历节日（公历日期查表，已实证：2026 七夕 8/19 还有真实对话佐证）
const LUNAR_FESTIVALS: Record<number, Record<string, string>> = {
  2025: {
    '1/28': '除夕', '1/29': '春节', '2/12': '元宵节', '5/31': '端午节',
    '8/29': '七夕', '10/6': '中秋节', '10/29': '重阳节',
  },
  2026: {
    '2/16': '除夕', '2/17': '春节', '3/3': '元宵节', '6/19': '端午节',
    '8/19': '七夕', '9/25': '中秋节', '10/18': '重阳节',
  },
  2027: {
    '2/5': '除夕', '2/6': '春节', '2/20': '元宵节', '6/9': '端午节',
    '8/8': '七夕', '9/15': '中秋节',
  },
};

// 主要节气（日期浮动 ±1 天，同样只收实证年份）
const SOLAR_TERMS: Record<number, Record<string, string>> = {
  2025: { '2/3': '立春', '4/4': '清明', '12/21': '冬至' },
  2026: { '2/4': '立春', '4/5': '清明', '12/22': '冬至' },
  2027: { '2/4': '立春' },
};

function beijingYMD(now: Date): { y: number; m: number; d: number } {
  const [y, m, d] = now
    .toLocaleDateString('en-CA', {
      timeZone: BEIJING_TZ,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    })
    .split('-')
    .map(Number);
  return { y: y!, m: m!, d: d! };
}

function festivalNames(y: number, m: number, d: number): string[] {
  const key = `${m}/${d}`;
  const out: string[] = [];
  const solar = SOLAR_FESTIVALS[key];
  if (solar) out.push(solar);
  const lunar = LUNAR_FESTIVALS[y]?.[key];
  if (lunar) out.push(lunar);
  const term = SOLAR_TERMS[y]?.[key];
  if (term) out.push(term);
  return out;
}

/**
 * 今天/明天的节日提示（「今天是七夕」「明天是中秋节」），没有返回 null。
 * 给明天是为了让 bot 能提前一晚预告——真人会这么说。
 */
export function festivalHint(now: Date = new Date()): string | null {
  const t = beijingYMD(now);
  const names = festivalNames(t.y, t.m, t.d);
  const bits: string[] = [];
  if (names.length) bits.push(`今天是${names.join('·')}`);
  const tm = beijingYMD(new Date(now.getTime() + 86_400_000));
  const tmr = festivalNames(tm.y, tm.m, tm.d);
  if (tmr.length) bits.push(`明天是${tmr.join('·')}`);
  return bits.length ? bits.join('，') : null;
}
