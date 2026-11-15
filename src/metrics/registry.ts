// ────────────────────────────────────────
// Minimal dependency-free Prometheus counter registry (借鉴 CGM:不引 prom-client,保持瘦依赖)
// ────────────────────────────────────────

const counters = new Map<string, number>(); // key = `name{labels}` → value

function makeKey(name: string, labels: Record<string, string | number>): string {
  const l = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, '')}"`)
    .join(',');
  return `${name}{${l}}`;
}

/** Increment a labelled counter (creates it on first use). */
export function incrCounter(name: string, labels: Record<string, string | number>, by = 1): void {
  const k = makeKey(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

/** Render all counters in Prometheus text exposition format. */
export function renderMetrics(): string {
  const byName = new Map<string, string[]>();
  for (const [k, v] of counters) {
    const n = k.slice(0, k.indexOf('{'));
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n)!.push(`${k} ${v}`);
  }
  const out: string[] = [];
  for (const [n, samples] of byName) {
    out.push(`# TYPE ${n} counter`);
    out.push(...samples);
  }
  return out.join('\n') + '\n';
}

/**
 * round 73：**给 /metrics 加一个口径头**——raw Prometheus 是给机器读的，
 * 但这个仓库里它的主要读者其实是**人（我）每轮在看**。
 *
 * 问题（round 72 “输入不分级决策就会错”的应用）：逗号分隔的计数器列表
 * 没有任何"这个数为 0 是否可疑"的信息。round 64 给 session-report 加了机会成本，
 * 而兜看 /metrics 就看不到。
 *
 * 三句话写死在头里：
 *   1. 这些计数器托管在**进程内**，重启归零（原来就是这个语义，但要朗望一眼看到）
 *   2. 群睡期大量为 0 是**触发条件不成立**，不是功能坏了
 *   3. 想看越重启的越励，用 session-report.mts（它读日志，跟进程无关）
 *
 * 不随意加行：一行文本。这些信息本来就在 AGENTS.md “读生产效果”那节，
 * 但那里要主动想起去看；这里是读的时候就在眼前。
 */
const METRICS_BANNER = [
  '# NOTE 本轮进程内计数，重启归零（AGENTS.md: Reading the production effect of a change）',
  '# NOTE 群睡期大量为 0 = 触发条件不成立，不是功能坏了（round 44/64）',
  '# NOTE 要越重启的趋势看 npx tsx scripts/session-report.mts [days]（它读日志）',
].join('\n');

export function renderMetricsWithBanner(): string {
  return METRICS_BANNER + '\n' + renderMetrics();
}
