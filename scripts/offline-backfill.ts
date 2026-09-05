// ────────────────────────────────────────
// Offline Backfill — 离线回放历史，喂 norms/exemplar/taste（只写表，不发消息）
// ────────────────────────────────────────
// 背景：H0~H4 全上线，但 norms/feedback/bandit 全 0 行 —— 深夜无流量转不起来。
// 本脚本读 Redis 群聊历史（getRecent 只读），离线跑：
//   1. norms infer（LLM，走 judge 便宜链，与线上 tick 同函数）
//   2. exemplar 抽取（确定性 pickExemplars，与 learner-scan 同函数）
//   3. taste 打分统计（只 log 分布，不写转发记录）
// 安全：只 INSERT/UPDATE 表，不调 sendMessage，不碰 Redis 写，不碰线上流程。
// 用法：tsx scripts/offline-backfill.ts [--dry] [--chats=...]
// ────────────────────────────────────────
import { getRecent } from '../src/pipeline/context/manager.js';
import { needsRefresh, inferGroupNorms } from '../src/agent/group-norms.js';
import { pickExemplars, saveExemplars, needsExemplars } from '../src/learners/dialect-exemplar.js';
import { scoreTaste } from '../src/pipeline/rhythm/taste.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const chatsArg = args.find((a) => a.startsWith('--chats='));
const CHATS = chatsArg
  ? chatsArg.slice(8).split(',').map(Number).filter((n) => n < 0)
  : [-1003931124139, -1003022727627, -1002450361141, -1003579270814, -1002767093213,
     -1003778222462, -1003184176508, -1003350411234, -1002683458784];

async function main(): Promise<void> {
  console.log(`backfill start dry=${DRY} chats=${CHATS.length}`);
  for (const chatId of CHATS) {
    const recent = await getRecent(chatId, 30);
    const humanTexts = recent
      .filter((m) => m.role !== 'assistant' && !m.isBot)
      .map((m) => (m.textContent || m.captionContent || '').trim())
      .filter((t) => t.length >= 2)
      .slice(-15);
    console.log(`chat ${chatId}: recent30=${recent.length} humanTexts=${humanTexts.length}`);

    // 1. norms（缺失/过期才 infer，与线上 tick 同条件）
    if (humanTexts.length >= 5 && needsRefresh(chatId)) {
      if (DRY) {
        console.log(`  norms: WOULD infer`);
      } else {
        const norms = await inferGroupNorms({ chatId, recentMessages: humanTexts });
        console.log(`  norms: ${norms ? `OK ${norms.length}条` : 'null(失败/垃圾输出)'}`);
      }
    } else {
      console.log(`  norms: skip (fresh or <5条)`);
    }

    // 2. exemplar（缺才补，与 learner-scan 同函数）
    if (needsExemplars(chatId)) {
      const lines = recent
        .filter((m) => m.role !== 'assistant' && !m.isBot)
        .map((m) => `${m.fullName || m.username || '?'}: ${(m.textContent || '').slice(0, 200)}`);
      const picked = pickExemplars(lines);
      console.log(`  exemplar: picked ${picked.length}条`);
      if (!DRY && picked.length) saveExemplars(chatId, picked);
    } else {
      console.log(`  exemplar: skip (已有)`);
    }

    // 3. taste 分布（只统计，不写转发记录）
    let hi = 0;
    let mid = 0;
    for (const m of recent) {
      if (m.role === 'assistant' || m.isBot) continue;
      const s = scoreTaste(m);
      if (s.score >= 0.6) hi++;
      else if (s.score >= 0.3) mid++;
    }
    console.log(`  taste: ≥0.6有${hi}条 0.3-0.6有${mid}条`);
  }
  console.log('backfill done');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', String(e).slice(0, 300)); process.exit(1); });
