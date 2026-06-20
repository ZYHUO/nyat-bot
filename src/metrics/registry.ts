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
