/**
 * 报告的自我核对：每个计数 vs 直接从日志 grep 同一形态的串。
 *
 * 为什么需要它：这个会话三次栽在"计数器恒 0 而日志里有"上——
 *   · round 41  `心流裁决` 恒 0（else-if 链被新分支切断）
 *   · round 57  `结构性忽略` / `语义降噪` 恒 0（宽泛前缀分支排在具体分支前面）
 * 三次都是**报告印了一个和真实情况相反却不矛盾的 0**。一个恒 0 的计数器
 * 比一个错误的数字更难发现，因为它从不反驳你。
 *
 * 所以每个计数都要有一个独立出处能对上。对不上就说明分类逻辑吃了那条日志。
 *
 * 用法：npx tsx scripts/xcheck-report.mts [天数]
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DAYS = Number(process.argv[2] ?? 1);
const sinceMs = Date.now() - DAYS * 86_400_000;

/** [人类可读名, 报告用的匹配方式, 直接 grep 的串] */
const CHECKS: Array<[string, 'msg-eq' | 'msg-includes' | 'err-includes', string]> = [
  ['心流裁决', 'msg-eq', 'Heart decision'],
  ['heart LLM 失败', 'msg-eq', 'heart LLM failed, fail-closed pass'],
  ['legacy 出口', 'msg-includes', 'Pipeline complete'],
  ['bot 降噪(legacy)', 'msg-includes', 'denoise: bot ad/verify/echo silenced'],
  ['结构性忽略(Meta)', 'msg-includes', '结构性忽略'],
  ['语义降噪(Meta)', 'msg-includes', 'denoise silenced'],
  ['trench gate 拦截', 'msg-includes', 'BLOCKED by trench gate'],
  ['包络拦截', 'msg-includes', 'BLOCKED by envelope'],
  ['保句闸', 'msg-includes', '转 wait 保句'],
  ['post-task 失败', 'msg-includes', 'post-task follow-up batch failed'],
  ['post-task 判过不接', 'msg-eq', 'post-task judge: no follow-up'],
  ['post-task 派发', 'msg-includes', 'post-task continuation dispatched'],
  ['distill 失败', 'msg-includes', 'distill output unparseable'],
  ['distill 成功', 'msg-includes', 'episode distilled'],
  ['dreaming 失败', 'msg-includes', 'dreaming output unparseable'],
  ['deep-reflection 失败', 'msg-includes', 'deep-reflection: LLM failed'],
  ['deep-reflection STARVED', 'msg-includes', 'tick STARVED'],
  ['topic-scan tick', 'msg-includes', 'Topic scan tick'],
  ['unified tick quiet', 'msg-includes', 'unified tick: quiet'],
  ['unified tick 否决', 'msg-includes', 'vetoed by drive satiation'],
  ['shadow THREW', 'msg-includes', 'shadow decision THREW'],
  ['shadow compare', 'msg-eq', 'core shadow compare'],
  ['Meta path asleep', 'msg-eq', 'Meta path: asleep'],
  ['截断加额', 'msg-includes', '思维链吃光额度'],
  ['空正文', 'msg-includes', '空正文'],
];

// **每个检查都预建一行**。只在有命中时才建行的话，"报告的匹配从来没命中过"
// 的计数器根本不会出现在结果里——而那正是 round 41 / round 57 两个"恒 0"的形状，
// 这个核对脚本会连它们一起漏掉。
// 跑一遍真报告（--kv 模式），拿它自己吐的 key=value 做左端。
// **不能自己用 includes 重算"报告侧"**——那两边用的是同一套匹配，
// else-if 链顺序的 bug 两边都看不出来（第一版就这么写的，验守卫时红 0 个，白做）。
const REPORT_OUT = execFileSync('npx', ['tsx', 'scripts/session-report.mts', String(DAYS), '--kv'], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const kv = new Map<string, number>();
for (const line of REPORT_OUT.split('\n')) {
  const m = /^([A-Za-z_]+(?::[^=]+)?)=(-?\d+)$/.exec(line.trim());
  if (m) kv.set(m[1]!, Number(m[2]));
}

/** [核对名, 报告 KV 键, 直接 grep 日志的串] */
const PAIRS: Array<[string, string, string]> = [
  ['心流裁决', 'heart_decision', '"msg":"Heart decision"'],
  ['heart LLM 失败', 'heart_failed', 'heart LLM failed'],
  ['All labels exhausted', 'all_exhausted', 'All labels exhausted'],
  ['空正文(err)', 'empty_response', 'Empty response'],
  ['legacy 出口', 'legacy_exits', 'Pipeline complete'],
  ['bot 降噪(legacy)', 'legacy_denoise', 'denoise: bot ad/verify/echo silenced'],
  ['结构性忽略(Meta)', 'structural_ignore', '结构性忽略'],
  ['语义降噪(Meta)', 'semantic_denoise', 'denoise silenced'],
  ['trench gate 拦截', 'trench_gate_block', 'BLOCKED by trench gate'],
  ['包络拦截', 'envelope_block', 'BLOCKED by envelope'],
  ['保句闸', 'keep_addressed', '转 wait 保句'],
  ['post-task 失败', 'cron_fail:任务后追话·失败', 'post-task follow-up batch failed'],
  ['post-task 判过不接', 'cron_fail:任务后追话·判过不接', 'post-task judge: no follow-up'],
  ['post-task 派发', 'cron_fail:任务后追话·派发了', 'post-task continuation dispatched'],
  ['distill 失败', 'cron_fail:episode 蒸馏', 'distill output unparseable'],
  ['distill 成功', 'cron_ok:episode 蒸馏', 'episode distilled'],
  ['dreaming 失败', 'cron_fail:dreaming 整合', 'dreaming output unparseable'],
  ['deep-reflection 失败', 'cron_fail:深度反思', 'deep-reflection: LLM failed'],
  ['Meta path asleep', 'meta_asleep', 'Meta path: asleep'],
];

const rows = PAIRS.map(([name, key, needle]) => ({ name, key, needle, viaReport: kv.get(key), viaGrep: 0 }));
let lines = 0;
{
  const fd = readFileSync('logs/app.log', 'utf8');
  for (const line of fd.split('\n')) {
    const m = /"time":(\d{13})/.exec(line.slice(0, 80));
    if (m && Number(m[1]) >= sinceMs) lines++;
  }
}

// 独立出处：整行搜，不看 msg 字段
for (const row of rows) {
  let n = 0;
  const fd = readFileSync('logs/app.log', 'utf8');
  for (const line of fd.split('\n')) {
    const m = /"time":(\d{13})/.exec(line.slice(0, 80));
    if (!m || Number(m[1]) < sinceMs) continue;
    if (line.includes(row.needle)) n++;
  }
  row.viaGrep = n;
}

console.log(`\n═══ 报告计数自我核对 · 最近 ${DAYS} 天（${lines} 行）═══\n`);
let bad = 0;
for (const r of rows) {
  if (r.viaReport === undefined) {
    console.log(`  ? ${r.name.padEnd(22)} 报告没吐 ${r.key} —— KV 键少了？`);
    bad++;
    continue;
  }
  // 两条判据，都是这个脚本存在的理由：
  //  ① 报告 0 而整行 > 0 —— 报告的匹配**一次都没命中过**。这正是 round 41
  //     「心流裁决恒 0」和 round 57「两个降噪计数恒 0」的形状：else-if 链里
  //     一个宽泛前缀排在具体分支前面，具体的就永远数不到。
  //     （第一版只判 `grep >= report`，于是 0 vs 220 也印 ✓——守卫了个寂寞。）
  //  ② 整行 < 报告 —— 不可能，除非两次跑的窗口滑动了。
  // 整行 > 报告是正常的：grep 连 err/why 字段一起算，报告只数 msg。
  const ok = !(r.viaReport === 0 && r.viaGrep > 0) && r.viaGrep >= r.viaReport;
  if (!ok) bad++;
  const both0 = r.viaReport === 0 && r.viaGrep === 0;
  console.log(`  ${ok ? '✓' : '✗'} ${r.name.padEnd(22)} 报告 ${String(r.viaReport).padStart(6)}  整行 ${String(r.viaGrep).padStart(6)}`
    + `${ok ? '' : '   ← 报告漏了'}${both0 ? '   （两边都 0）' : ''}`);
}
console.log();
if (bad > 0) {
  console.log(`  ⚠️  ${bad} 处对不上。报告的独立出处比它自己多，说明分类逻辑`
    + '（通常是 else-if 链的顺序，或标签改了名）漏了那条日志。');
  console.log('      这正是 round 41「心流裁决恒 0」和 round 57「两个降噪计数恒 0」的形状。');
} else {
  console.log('  全部对得上。（整行 >= 报告数是正常的：grep 连 err/why 字段一起算。）');
}
console.log();
process.exit(bad > 0 ? 1 : 0);
