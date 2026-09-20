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
/**
 * 窗口结束的锚点 UTC 小时。
 *
 * **record 与 backfill 必须用同一个锚点**，否则 cron 每天拍的快照落在 slot 11
 * （cron 11:30 触发），而 backfill 按 `now - d天` 落在 slot 12 —— 两个时段的水永远
 * 合不到一起，cron 攒的那份数据对统计毫无贡献。这是本轮发现的静默 bug。
 */
const ANCHOR_HOUR = 12;
/**
 * 进统计的最低入站条数，**按该群自己的中位数动态定**。
 *
 * 第一版用全局常数 40，结果把实验目标群整体排除了——它同时段 3 小时窗的入站
 * 从未达到 40（最高 33）。统计器把要测的对象筛掉了，这正是最坏的一类 bug。
 * 现在改为：低于该群历史入站中位数的 1/3 的一天不进统计（小样本相对自身才是噪声）。
 */
function minInboundFor(chat: number, all: Array<{ chat: number; inbound: number }>): number {
  const xs = all.filter((x) => x.chat === chat).map((x) => x.inbound).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const median = xs[Math.floor(xs.length / 2)]!;
  return Math.max(5, Math.floor(median / 3));
}

/** 与金丝雀同一套分母口径：近 N 天的 self_replies vs message_received。 */
function sqlite(json: boolean, q: string): string {
  return execSync(
    `sqlite3 ${json ? '-json' : '-noheader'} "./data/xxb.db" "${q.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

/** 窗口结束时刻：当天 ANCHOR_HOUR；若此刻还没到锚点，就用昨天的（保证窗口已闭合）。 */
function anchorEnd(now: number): number {
  const d = new Date(now * 1000);
  const cand = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ANCHOR_HOUR, 0, 0) / 1000;
  return cand <= now ? cand : cand - 86400;
}

function record(): void {
  const now = Math.floor(Date.now() / 1000);
  const end = anchorEnd(now);
  const from = end - WINDOW_HOURS * 3600;
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
    // **at 必须是窗口结束时刻，不是触发时刻**：否则跨午夜跑的 cron 会
    // 把昨天的窗口盖成今天的日期，造出一个幽灵日（去重键取自 at 的日期）。
    at: new Date(end * 1000).toISOString(),
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
  const all = readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // **按 (slot, day) 去重，保留当天最后一张**：同一天手动 record 两次会被当成两天，
  // 虚增 n、把 σ 算低、把所需天数算少——那正是这套统计最不能出的错。
  const seen = new Map<string, (typeof all)[number]>();
  for (const s of all) seen.set(`${s.slotUtc}:${s.at.slice(0, 10)}`, s);
  const snaps = [...seen.values()].sort((a, b) => a.at.localeCompare(b.at));
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
    const chats = new Map<number, Array<{ day: string; rate: number | null; inbound: number }>>();
    const flat: Array<{ chat: number; inbound: number }> = [];
    for (const g of group) for (const c of g.chats) flat.push({ chat: c.chat, inbound: c.inbound });
    for (const g of group) {
      const day = g.at.slice(0, 10);
      for (const c of g.chats) {
        if (!chats.has(c.chat)) chats.set(c.chat, []);
        chats.get(c.chat)!.push({ day, rate: c.rate, inbound: c.inbound });
      }
    }
    for (const [chat, days] of [...chats.entries()].sort()) {
      // **样本量过滤**：3 小时窗在小群里可能只有十几条入站，那种天的发送率
      // 是噪声不是信号（实测候选群某窗 12 条入站算出 83%，而同期大样本是 24%）。
      // 少于 MIN_INBOUND 的一天不进统计，否则会把 σ 算虚高、把需要的天数算错。
      const floorIn = minInboundFor(chat, flat);
      const usable = days.filter((d) => d.rate !== null && d.inbound >= floorIn);
      if (usable.length < 2) continue;
      const rates = usable.map((d) => d.rate as number);
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length);
      const detail = usable.map((d) => `${d.day.slice(5)}=${(d.rate as number * 100).toFixed(0)}%`).join(' ');
      console.log(
        `  ${String(chat).padStart(15)}  均值 ${(mean * 100).toFixed(0).padStart(3)}%  ` +
        `σ ${(sd * 100).toFixed(0).padStart(3)}%   ${detail}`,
      );
    }
    console.log('');
  }
  console.log('判据：σ 大的群，任何单日读数都不可归因——必须先攒够同期天数。\n');
}

/**
 * 回填历史同时段快照：cron 是今天才挂上的，而 §九·补七 需要 6 天同期数据。
 * 历史都在 SQLite 里，直接按"今天的同一 UTC 时刻回溯 N 天"算出来，
 * 写进同一个 jsonl（与 cron 产出的格式一致，去重逻辑天然兼容）。
 */
function backfill(days = 8): void {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 86400;
  const rows: Array<{ chat_id: number; s: number; i: number; end: number }> = JSON.parse(
    sqlite(true, `
      SELECT s.chat_id AS chat_id,
             (SELECT COUNT(*) FROM self_replies r WHERE r.chat_id = s.chat_id
                AND r.ts >= ${from - WINDOW_HOURS * 3600} AND r.ts < s.end_ts) AS s,
             (SELECT COUNT(*) FROM cognitive_events e WHERE e.type='message_received'
                AND e.chat_id = s.chat_id
                AND e.occurred_at >= ${from - WINDOW_HOURS * 3600} AND e.occurred_at < s.end_ts) AS i,
             s.end_ts AS end
      FROM (SELECT DISTINCT chat_id, ${now} AS end_ts FROM self_replies) s
    `) || '[]',
  );
  // 上面的 end_ts 是同一个 now，退回按天重算：一天一条，窗口为该天的同一时刻往前 WINDOW_HOURS
  let wrote = 0;
  const todayAnchor = anchorEnd(now);
  for (let d = 1; d <= days; d++) {
    const end = todayAnchor - d * 86400;
    const start = end - WINDOW_HOURS * 3600;
    const dayRows: Array<{ chat_id: number; s: number; i: number }> = JSON.parse(
      sqlite(true, `
        SELECT s.chat_id AS chat_id,
               (SELECT COUNT(*) FROM self_replies r WHERE r.chat_id = s.chat_id
                  AND r.ts >= ${start} AND r.ts < ${end}) AS s,
               (SELECT COUNT(*) FROM cognitive_events e WHERE e.type='message_received'
                  AND e.chat_id = s.chat_id
                  AND e.occurred_at >= ${start} AND e.occurred_at < ${end}) AS i
        FROM (SELECT DISTINCT chat_id FROM self_replies) s
      `) || '[]',
    );
    const chats = dayRows
      .filter((r) => r.i > 0)
      .map((r) => ({ chat: r.chat_id, sends: r.s, inbound: r.i, rate: Number((r.s / r.i).toFixed(4)) }));
    if (chats.length === 0) continue;
    const snap = {
      at: new Date(end * 1000).toISOString(),
      slotUtc: String(ANCHOR_HOUR).padStart(2, '0'),
      windowHours: WINDOW_HOURS,
      backfilled: true,
      chats,
    };
    appendFileSync(OUT, JSON.stringify(snap) + '\n');
    wrote += 1;
  }
  console.log(`BASELINE backfilled ${wrote} days`);
}

const cmd = process.argv[2] ?? 'record';
if (cmd === 'record') record();
else if (cmd === 'show') show();
else if (cmd === 'backfill') backfill(Number(process.argv[3] ?? 8));
else console.log(`unknown command: ${cmd} (record|show)`);
