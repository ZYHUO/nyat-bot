import { getLabels } from '../src/ai/labels.js';
import { callModel } from '../src/ai/provider.js';
const labels = getLabels();
for (const [name, l] of labels) {
  const t0 = Date.now();
  try {
    const r = await callModel(l, [{ role: 'user', content: 'reply with the single word: pong' }], { maxTokens: 200, temperature: 0, timeout: 30000 });
    console.log(`${name.padEnd(14)} ${String(l.model).padEnd(18)} OK ${Date.now()-t0}ms len=${(r.content||'').length} :: ${JSON.stringify((r.content||'').slice(0,60))}`);
  } catch (e) {
    console.log(`${name.padEnd(14)} ${String(l.model).padEnd(18)} FAIL ${Date.now()-t0}ms :: ${(e as Error).message.slice(0,140)}`);
  }
}
