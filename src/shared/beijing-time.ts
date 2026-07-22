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
  return `${clock}（北京时间 UTC+8，现在是${period}）`;
}
