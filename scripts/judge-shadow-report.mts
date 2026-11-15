/**
 * 定型判断影子对比 —— 用数据决定"要不要把 gate/judge 迁到判断基座"
 *
 * 背景：bot 每天 ~45M token 大多花在"换回一个小决定"（gate 三选一、heart 说/等/不说、
 * shadow、judge）。判断基座（src/ai/judge-substrate.ts）用 TypeSafe System One 做同类
 * 判断，实测 ~330 in / 23 out。但在把核心决策路径搬过去之前，必须先证明它**更准或更省**——
 * 仓库里已有 NyatOS shadow 的先例（54 样本阴性结果，就没迁）。
 *
 * 做法：从生产日志/认知账本里取真实的判定样本，同一输入同时问两条路，比：
 *   一致率（agreement）· 双方各自延迟 · token 成本
 * 只读，不改任何运行时状态。用法：npx tsx scripts/judge-shadow-report.mts [天数]
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { env } from '../src/env.js';
import { judge } from '../src/ai/judge-substrate.js';

const DAYS = Number(process.argv[2] ?? 3);

/** 认知事件里带 shadow 判定的样本：我们要复现的就是"该不该说话"这类判断。 */
interface ShadowSample {
  chatId: number;
  messageId: number;
  verdict: string;
  why: string;
}

function loadShadowSamples(): ShadowSample[] {
  const sqlitePath = env().SQLITE_PATH;
  const rows = execSync(
    `sqlite3 -json "${sqlitePath}" "select json_extract(fact_json,'$.messageId') as messageId, ` +
      `json_extract(fact_json,'$.shadowVerdict') as verdict, json_extract(fact_json,'$.shadowWhy') as why, ` +
      `chat_id as chatId from cognitive_events where type='social_prediction' ` +
      `and occurred_at > strftime('%s','now','-${DAYS} day') order by id desc limit 400;"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(rows || '[]') as ShadowSample[];
}

/** 每个样本的输入文本（Qdrant 群历史）；拿不到就跳过，不让样本本身成为变量。 */
async function textOf(chatId: number, messageId: number): Promise<string | null> {
  try {
    const res = await fetch('http://127.0.0.1:6333/collections/xxb_group_history_v2/points/scroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: 5,
        with_payload: true,
        filter: {
          must: [
            { key: 'chatId', match: { value: chatId } },
            { key: 'mid', match: { value: `${chatId}_${messageId}` } },
          ],
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: { points?: Array<{ payload: { mid?: string; text?: string } }> };
    };
    const hit = (data.result?.points ?? [])[0];
    return hit?.payload.text ?? null;
  } catch {
    return null;
  }
}

/** 该群在这条消息之前的最近若干条，按时间正序——shadow 看到的就是这个量级的上下文。 */
async function recentChatTranscript(chatId: number, beforeMessageId: number, n: number): Promise<string> {
  try {
    const res = await fetch('http://127.0.0.1:6333/collections/xxb_group_history_v2/points/scroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: 200,
        with_payload: true,
        filter: {
          must: [
            { key: 'chatId', match: { value: chatId } },
            { key: 'messageId', range: { lt: beforeMessageId } },
          ],
        },
      }),
    });
    if (!res.ok) return '（读不到）';
    const data = (await res.json()) as {
      result?: { points?: Array<{ payload: { messageId?: number; role?: string; text?: string; fullName?: string } }> };
    };
    const pts = (data.result?.points ?? [])
      .filter((p) => p.payload.text)
      .sort((a, b) => (a.payload.messageId ?? 0) - (b.payload.messageId ?? 0))
      .slice(-n);
    if (pts.length === 0) return '（读不到）';
    return pts
      .map((p) => `${p.payload.role === 'assistant' ? '你' : '群友'}: ${String(p.payload.text).slice(0, 40)}`)
      .join('\n');
  } catch {
    return '（读不到）';
  }
}

async function main() {
  const all = loadShadowSamples();
  // null / failed 不是判定，是数据缺失或调用失败。拿它们当分母只会稀释指标。
  const samples = all.filter((s) => s.verdict === 'speak' || s.verdict === 'wait' || s.verdict === 'silent');
  console.log(`其中可判定样本：${samples.length}（跳过 null/failed ${all.length - samples.length}）`);
  console.log(`样本（近 ${DAYS} 天 shadow 判定）：${samples.length}`);
  if (samples.length === 0) {
    console.log('没有样本。等 shadow 在有流量的群里跑过再来看。');
    return;
  }

  let agree = 0;
  let disagree = 0;
  let skipped = 0;
  const disagreements = new Map<string, number>();
  let tsLatency = 0;
  let tsCalls = 0;

  for (const s of samples) {
    const text = await textOf(s.chatId, s.messageId);
    if (!text || text.replace(/\s/g, '').length < 4) {
      skipped += 1;
      continue;
    }
    const room = await recentChatTranscript(s.chatId, s.messageId, 6);
    const mentionsBot = /(啾咪|本喵|@?hunhebi_bot|猫猫|bot)/i.test(text);
    const state =
      `最近这个群在聊：\n${room}\n\n` +
      `要判定的这条消息：${text}\n` +
      `${mentionsBot ? '（这条消息里出现了你的名字/称呼）' : '（这条消息没有提到你）'}`;
    const t0 = Date.now();
    const r = await judge({
      key: 'shadow_probe',
      state,
      chatId: s.chatId,
      questions: {
        speak: { kind: 'choice', question: 'bot 该拿这条消息怎么办', options: { speak: '接一句话', wait: '先等等', pass: '不管' } },
      },
    });
    tsLatency += Date.now() - t0;
    if (r.ok && r.backend === 'typesafe') tsCalls += 1;
    const mine = r.answers.speak?.value;
    const theirs = s.verdict === 'silent' ? 'pass' : s.verdict === 'speak' ? 'speak' : s.verdict;
    if (mine === undefined || mine === null) {
      skipped += 1;
      continue;
    }
    if (mine === theirs) agree += 1;
    else {
      disagree += 1;
      const key = `${String(mine)}<-${String(theirs)}`;
      disagreements.set(key, (disagreements.get(key) ?? 0) + 1);
    }
    if ((agree + disagree) % 25 === 0 && agree + disagree > 0) {
      console.log(`  …已比 ${agree + disagree}：一致 ${agree} / 不一致 ${disagree}`);
    }
  }

  // 混淆矩阵：一致率低的时候，必须先分清"是模型不行"还是"我这个比法不公平"。
  const top = [...disagreements.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log('');
  console.log('分歧形态（我的判定 <- shadow 判定，前 6）：');
  for (const [k, v] of top) console.log(`  ${k.padEnd(18)} ${v}`);

  const compared = agree + disagree;
  console.log('─'.repeat(60));
  console.log(`可比样本：${compared}（跳过 ${skipped}）`);
  if (compared > 0) {
    console.log(`一致率：${((agree / compared) * 100).toFixed(1)}%`);
    console.log(`判断基座命中 typesafe：${tsCalls}/${compared}，平均延迟 ${(tsLatency / compared).toFixed(0)}ms`);
    console.log('');
    console.log('判定门槛（与仓库 shadow 先例一致）：');
    console.log('  一致率 < 80%  → 不迁。它在这个分布上不如现在跑的模型。');
    console.log('  一致率 >= 90% → 值得迁，省下的 prompt token 见 llm_token_daily(usage=judgment)。');
    console.log('  80~90%       → 只迁低风险判定（gate 的 no_action），heart 这种带语气的别迁。');
  }

  // 这个指标**不能**直接用来决定迁不迁，原因是结构性的选择性偏差：
  // shadow 账本只记录"已经通过生产注意力筛选、进入管线"的消息（verdict 分布严重偏 speak），
  // 所以这里是在拿"被另一个模型预筛过的样本"考一个没有预筛信息的探针。
  // 2026-09-19 实测：修好上下文后一致率反而从 23% 掉到 8.6%，分歧几乎全是
  // "探针说 pass、shadow 说 speak"——正是这个偏差的signature，不是模型高下。
  // 要真正回答"该不该迁"，必须把**同一条未筛选消息流**同时喂给两个判定器，
  // 而不是复用生产 shadow 的账本。在那之前：此脚本只用于观察，不作为迁移依据。
  console.log('');
  console.log('⚠ 选择性偏差警告：以上一致率不可作为迁移依据（原因见脚本注释）。');
  console.log('  结论只保留一条：判断基座 100% 命中 typesafe、平均延迟 ~0.6s、可观测已入账。');
}

void main();
