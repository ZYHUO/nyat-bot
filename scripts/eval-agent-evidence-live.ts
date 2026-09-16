import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { validateAcceptance, type AcceptanceContract } from '../src/agent/task-evidence.js';

// Explicit opt-in component smoke test. Does not boot a Telegram bot or use production data.
// Only a public toy task is sent upstream. Credentials are read locally and never printed.
const envPath = process.env['NYAT_LIVE_ENV'];
if (!envPath) throw new Error('Set NYAT_LIVE_ENV to explicitly opt into the bounded provider smoke test');
const config = parse(await readFile(envPath));
const prefix = 'AI_PROVIDER_STEPFUN_';
const endpoint = config[`${prefix}ENDPOINT`];
const key = config[`${prefix}KEY`];
const model = config[`${prefix}MODEL`];
if (!endpoint || !key || !model) throw new Error('Required provider configuration missing');
const url = endpoint.replace(/\/$/, '').replace(/\/messages$/, '') + '/messages';
const root = await mkdtemp(join(tmpdir(), 'nyat-live-evidence-'));
const contract: AcceptanceContract = { source: 'caller', checks: [
  { kind: 'json_field', path: 'result.json', field: ['totals', 'A'], equals: 23 },
  { kind: 'json_field', path: 'result.json', field: ['totals', 'B'], equals: 12 },
  { kind: 'json_field', path: 'result.json', field: ['grandTotal'], equals: 35 },
] };
const messages: { role: string; content: string }[] = [{ role: 'user', content:
  'Compute revenue from rows sku,quantity,price: A,2,7; B,3,4; A,1,9. Write result.json with exactly this schema: {"totals":{"A":number,"B":number},"grandTotal":number}. Calculate the numbers from the rows. Your only tool protocol: output exactly JSON {"action":"write_file","path":"result.json","content":"<JSON document string>"}. The host writes bytes then independently validates. On feedback repair your document. Do not output Markdown.' }];
const trials: { turn: number; protocol: string; assessment: string }[] = [];
try {
  for (let turn = 1; turn <= 3; turn++) {
    const response = await fetch(url, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
    }, body: JSON.stringify({ model, max_tokens: 4096, messages }), signal: AbortSignal.timeout(90000) });
    if (!response.ok) {
      trials.push({ turn, protocol: `upstream_http_${response.status}`, assessment: 'unverified' });
      break;
    }
    const body = await response.json() as { content?: { type?: string; text?: string }[] };
    const text = body.content?.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('') ?? '';
    let action: Record<string, unknown>;
    try { action = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()); }
    catch {
      trials.push({ turn, protocol: 'invalid_json_action', assessment: 'unverified' });
      messages.push({ role: 'assistant', content: text || '(empty output)' }, { role: 'user', content: 'Invalid tool action JSON. Retry with only the specified JSON action.' });
      continue;
    }
    if (action['action'] !== 'write_file' || action['path'] !== 'result.json' || typeof action['content'] !== 'string' || action['content'].length > 20000) {
      trials.push({ turn, protocol: 'rejected_action', assessment: 'unverified' });
      break;
    }
    await writeFile(join(root, 'result.json'), action['content']);
    const result = await validateAcceptance(root, contract);
    trials.push({ turn, protocol: 'write_file_executed', assessment: result.status });
    if (result.status === 'verified') break;
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Host check failed: ${JSON.stringify(result)}. Recompute and repair.` });
  }
  console.log(JSON.stringify({ kind: 'live_provider_artifact_component_smoke_not_full_bot_benchmark', model, trials }, null, 2));
  if (trials.at(-1)?.assessment !== 'verified') process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
