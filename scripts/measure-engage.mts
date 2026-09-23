// round 102：**「说完有没有人接」的仪表盘。**
//
// 为什么不加进 measure-voice：那个脚本是纯日志解析（无 DB/Redis 依赖），
// 它的价值在于 grep 日志就能跑。而 replied 率存在 self-act（Redis + DB）里。
//
// 为什么单独一个脚本：用户 41 轮来说「很难融入话题」。我 42 轮修的都是
// 让它"说得出/说得对"（trench 闸、maxTokens、去重），而**说完之后有没有人接**
// 这个最终指标一直在 self-act 里躺着，我从没在仪表盘上看过它。
//
// round 100 我第一次看，报了 2-6%；round 101 验崩了自己编的"点名+钩子"口诀；
// round 102 又验崩了"小群更容易被接"（r=0.03）。
// **所以这个脚本的目的不是解释，是把那个数字常态化地放在眼前。**
import { getSelfActSummary } from '../src/tracking/self-history.js';

const HOURS = Number(process.argv.find((a) => a.startsWith('--hours='))?.slice(8) ?? 12);
const CHATS = [
  -1003821093564, -1003543275052, -1004430867819, -1003184176508,
  -1003350411234, -1004451430063, -1002450361141, -1004249431047,
  -1004449419602, -1003676333777,
];

const P = (s: string): string => `  ${s}`;
const rows: string[] = [];
let T = 0; let R = 0; let M = 0; let C = 0; let I = 0;
for (const c of CHATS) {
  const s = getSelfActSummary(c, HOURS * 3600);
  if (!s || !s.total) continue;
  const o = s.byOutcome;
  rows.push(P(`${c}  n=${String(s.total).padStart(2)}  replied ${String(o.replied).padStart(2)}(${String((100 * o.replied / s.total) | 0).padStart(2)}%)  mentioned ${o.mentioned}  corrected ${o.corrected}  ignored ${o.ignored}`));
  T += s.total; R += o.replied; M += o.mentioned; C += o.corrected; I += o.ignored;
}
if (T === 0) {
  console.log(P(`近 ${HOURS} 小时没有 self-act 记录（可能机器人在睡，或这些群没说话）。`));
  process.exit(0);
}
console.log(P(`说完有没有人接（近 ${HOURS} 小时，self-act outcome）`));
for (const r of rows) console.log(r);
console.log(P(`合计 n=${T}  replied ${R}(${(100 * R / T).toFixed(0)}%)  mentioned ${M}(${(100 * M / T).toFixed(0)}%)  corrected ${C}(${(100 * C / T).toFixed(0)}%)  ignored ${I}(${(100 * I / T).toFixed(0)}%)`));
console.log();
console.log(P('replied = 有人回了它这句。这是"融不融入话题"的最终指标，'));
console.log(P('跟回复率（它说了多少）是两件事——回复率可以由它自己控制，这个不能。'));
console.log(P('基线：09-22 全天 15-18%，09-23 全天 2-6%（口径见 docs/voice-tuning.md round 100）。'));
if (C > 0) console.log(P(`corrected ${C} 次 = 人被它惹到/纠正了它。那是止损闸的输入。`));
process.exit(0);
