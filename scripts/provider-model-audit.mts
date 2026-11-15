// ─────────────────────────────────────────────────────────────────────
// 逐个问 provider 端点"你 serving 什么"——把"死 provider"拆成具体病因
// ─────────────────────────────────────────────────────────────────────
//
// 2026-09-21 加。round 44 曾把 23 个死 provider 一并归因成"credits exhausted"
// （依据是 relay 的 state.json）。round 82 发现其中至少一个（amdqwen）根本不是
// 额度问题，是**请求的型号在端点上不存在**，每次 404。
//
// 所以这个脚本对每个 label 打 `GET /v1/models`，把"请求的型号"和"实际 serving 的"
// 并排印出来。用法：
//
//   npx tsx scripts/provider-model-audit.mts
//
// ⚠️ **输出是线索，不是结论。** `/v1/models` 不是完整目录：`step5`、`spark13`、
// `lfree`、`stepexplore` 请求的型号都不在列表里，但它们照样工作。
// 所以"不在列表里"只说明值得再探一次，不说明配错了。
// 真正确认要打一次 chat/completions 看错误体（InvalidSubscription /
// Invalid API key / no credits / 404 是四件不同的事）。
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
