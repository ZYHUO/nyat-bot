/**
 * 同时段对照基线采集器（same-slot control baseline）。
 *
 * 为什么需要它
 * ─────────────
 * 实测过：**同一个群、同一个时段（04:39–07:39 UTC）、不同日期**的发送率是
 *   09-19  18%   09-18  26%   09-17  0%（心流全程开着也是 0%）
 * 也就是说单日读数不可归因——方差 0%–26%（其它时段实测到过 74%）。
 * 论文 §九·补三 因此把"同群同时段不同日期"写成 Phase 1 的前置条件。
 *
 * 这个脚本就是攒那个前提：每天同一时刻拍一张各群发送率快照，落到
 * var/control-baseline.jsonl。**纯只读**——不翻任何开关、不改任何行为，
 * 所以它本身零风险，可以一直跑。
 *
 * 用法：
 *   npx tsx scripts/control-baseline.mts record     # 拍一张（cron 每天调）
 *   npx tsx scripts/control-baseline.mts show       # 看已攒的同期对比
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OUT = 'var/control-baseline.jsonl';
const WINDOW_HOURS = 3;

/** 与金丝雀同一套分母口径：近 N 天的 self_replies vs message_received。 */
function sqlite(json: boolean, q: string): string {
  return execSync(
    `sqlite3 ${json ? '-json' : '-noheader'} "./data/xxb.db" "${q.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

function record(): void {
  const now = Math.floor(Date.now() / 1000);
  const from = now - WINDOW_HOURS * 3600;
  const rows: Array<{ chat_id: number; s: number; i: number }> = JSON.parse(
    sqlite(true, `
      SELECT s.chat_id AS chat_id,
             (SELECT COUNT(*) FROM self_replies r WHERE r.chat_id = s.chat_id AND r.ts >= ${from}) AS s,
             (SELECT COUNT(*) FROM cognitive_events e WHERE e.type='message_received'
                AND e.chat_id = s.chat_id AND e.occurred_at >= ${from}) AS i
      FROM (SELECT DISTINCT chat_id FROM self_replies) s
    `) || '[]',
  );
  const snap = {
    at: new Date(now * 1000).toISOString(),
    slotUtc: new Date(now * 1000).toISOString().slice(11, 13),
    windowHours: WINDOW_HOURS,
    chats: rows.map((r) => ({
      chat: r.chat_id,
      sends: r.s,
      inbound: r.i,
      rate: r.i > 0 ? Number((r.s / r.i).toFixed(4)) : null,
    })),
  };
  appendFileSync(OUT, JSON.stringify(snap) + '\n');
  console.log(`BASELINE recorded ${snap.chats.length} chats @ ${snap.at}`);
}

function show(): void {
  if (!existsSync(OUT)) {
    console.log('BASELINE no data yet — run `record` first');
    return;
  }
  const snaps = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // 按 UTC 小时聚成"同时段"组
  const bySlot = new Map<string, typeof snaps>();
  for (const s of snaps) {
    const k = s.slotUtc;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k)!.push(s);
  }
  console.log(`\n═══ 同时段对照基线 · ${snaps.length} 张快照 ═══\n`);
  for (const [slot, group] of [...bySlot.entries()].sort()) {
    console.log(`── UTC ${slot}:00 时段（${group.length} 天）──`);
    // 每个群在各天的发送率
    const chats = new Map<number, Array<{ day: string; rate: number | null }>>();
    for (const g of group) {
      const day = g.at.slice(0, 10);
      for (const c of g.chats) {
        if (!chats.has(c.chat)) chats.set(c.chat, []);
        chats.get(c.chat)!.push({ day, rate: c.rate });
      }
    }
    for (const [chat, days] of [...chats.entries()].sort()) {
      const rates = days.map((d) => d.rate).filter((r): r is number => r !== null);
      if (rates.length < 2) continue;
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length);
      const detail = days.map((d) => `${d.day.slice(5)}=${d.rate === null ? '—' : (d.rate * 100).toFixed(0) + '%'}`).join(' ');
      console.log(
        `  ${String(chat).padStart(15)}  均值 ${(mean * 100).toFixed(0).padStart(3)}%  ` +
        `σ ${(sd * 100).toFixed(0).padStart(3)}%   ${detail}`,
      );
    }
    console.log('');
  }
  console.log('判据：σ 大的群，任何单日读数都不可归因——必须先攒够同期天数。\n');
}

const cmd = process.argv[2] ?? 'record';
if (cmd === 'record') record();
else if (cmd === 'show') show();
else console.log(`unknown command: ${cmd} (record|show)`);
