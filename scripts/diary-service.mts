import 'dotenv/config';
import cron from 'node-cron';
import { env } from '../src/env.js';
import { getRedis, closeRedis } from '../src/db/redis.js';
import { closeDb } from '../src/db/sqlite.js';
import { inferDreamSlot, tryWriteDreamJournal } from '../src/cron/dream-journal.js';

// Dedicated diary scheduling while the general proactive scheduler is disabled.
const config = env();
if (!config.DREAM_JOURNAL_ENABLED) throw new Error('Dream journal is disabled');
if (config.CRON_ENABLED && process.env.XXB_ENABLE_CRON !== 'false') {
  throw new Error('The main cron scheduler owns diaries; disable the dedicated service');
}
if (config.DREAM_JOURNAL_DM || config.DREAM_JOURNAL_CHAT_ID !== 0) {
  throw new Error('This diary service is configured for local files only');
}
const expressions = config.DREAM_JOURNAL_CRON.split(',').map(s => s.trim()).filter(Boolean);
if (!expressions.length || expressions.some(expr => !cron.validate(expr))) {
  throw new Error('Invalid diary schedule');
}
await getRedis().connect();
let running = false;
async function attempt(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await tryWriteDreamJournal({slot: inferDreamSlot()});
    console.log(JSON.stringify({event:'diary_attempt',wrote:result.wrote,slot:result.slot,reason:result.reason}));
    if (result.reason === 'llm_failed' || result.reason === 'unparsed' || result.reason === 'empty_output') {
      throw new Error('Diary generation failed: ' + result.reason);
    }
  } finally { running = false; }
}
async function close(): Promise<void> {await closeRedis();closeDb();}
if (process.argv.includes('--once')) {
  try {await attempt();} finally {await close();}
  process.exit(0);
}
const tasks = expressions.map(expr => cron.schedule(expr, () => {
  void attempt().catch(error => console.error(JSON.stringify({event:'diary_error',type:error?.constructor?.name})));
}, {timezone:'UTC'}));
console.log(JSON.stringify({event:'diary_scheduler_ready',schedule_utc:expressions,times_beijing:['07:00','23:00'],directory:config.DREAM_JOURNAL_DIR}));
for (const signal of ['SIGTERM','SIGINT'] as const) {
  process.once(signal, () => {
    for (const task of tasks) task.stop();
    void close().finally(() => process.exit(0));
  });
}
