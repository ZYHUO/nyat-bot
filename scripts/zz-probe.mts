import { callWithFallback } from '../src/ai/fallback.js';

const t0 = Date.now();
try {
  const r = await callWithFallback({
    usage: process.argv[2] ?? 'reply',
    messages: [{ role: 'user', content: '回一个字：喵' }],
    maxTokens: 50,
    allowHedge: false,
  });
  console.log('OK', Date.now() - t0, 'ms, content:', JSON.stringify((r.content ?? '').slice(0, 40)));
} catch (e) {
  console.log('FAIL', Date.now() - t0, 'ms', e instanceof Error ? e.message : String(e));
}
process.exit(0);
