import { getLabels } from '../src/ai/labels.js';
const rows: Array<{ name: string; endpoint: string; model: string; status: string; served: string }> = [];
for (const [name, l] of getLabels()) {
  if (!l.apiKeys[0]) continue;
  const base = l.endpoint.replace(/\/+$/, '');
  let status = '?'; let served = '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${l.apiKeys[0]}` }, signal: ctrl.signal });
    clearTimeout(t);
    status = String(res.status);
    if (res.ok) {
      const d = await res.json() as { data?: Array<{ id?: string }> };
      const ids = (d.data ?? []).map((m) => m.id ?? '').filter(Boolean);
      served = ids.length ? ids.join(',') : '(empty)';
    } else {
      served = (await res.text().catch(() => '')).slice(0, 60);
    }
  } catch (e) { status = 'ERR:' + (e instanceof Error ? e.name : '?'); }
  rows.push({ name, endpoint: base, model: l.model, status, served });
}
console.log('NAME|MODEL|HTTP|SERVED');
for (const r of rows) console.log(`${r.name}|${r.model}|${r.status}|${r.served.slice(0, 150)}`);
process.exit(0);
