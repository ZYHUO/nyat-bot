// ────────────────────────────────────────
// Reply verifier 离线评估器 — AGI L6 三阶段(verifier 地基)
//
// 数据: reply_outcomes(正样本=user_replied/user_mentioned_bot/explicit_positive,
//       负样本=ignored_5_msgs/explicit_negative/repair_loop)
// 方法: 抽正负样本各 N 条,丢给现有 verifier(best-of-n.verifyReplyQuality LLM 打分),
//       统计正/负样本分数分布 + 区分度(正均值-负均值、正确率@0.5 阈值)。
// 意义: 量化"verifier 到底能不能分好坏"。区分度差 → 先修 verifier 再谈 best-of-N。
//       每次改动后重跑,看质量信号有没有变好(plan: "没有这一步,后面都是凭感觉")。
//
// 用法: npx tsx src/eval/reply-verifier-eval.ts [N_per_class] [--sample]
//   --sample 只跑 8 条(发版前快速冒烟),默认跑 30/类。
// ────────────────────────────────────────
import { getDb } from '../db/sqlite.js';
import { verifyReplyQuality } from '../agent/best-of-n.js';
import { logger } from '../shared/logger.js';

const N = Number(process.argv[2] ?? 30);
const SAMPLE = process.argv.includes('--sample');
// 正负样本都可选信号;默认用"明确信号"(explicit_positive vs explicit_negative/repair)
// —— ignored_5_msgs 只是"没被理",不是"差回复",会稀释区分度。
const POSITIVE_SIGNALS = (process.argv[3] ?? 'explicit_positive,user_replied').split(',');
const NEGATIVE_SIGNALS = (process.argv[4] ?? 'explicit_negative,repair_loop').split(',');

interface Sample {
  replyText: string;
  triggerText: string;
  signal: string;
  outcome: string;
}

function loadSamples(signals: string[], limit: number): Sample[] {
  const q = getDb().prepare(
    `SELECT reply_text, trigger_text, signal, outcome FROM reply_outcomes
     WHERE signal IN (${signals.map(() => '?').join(',')}) AND length(reply_text) BETWEEN 3 AND 200
     ORDER BY RANDOM() LIMIT ?`,
  );
  return (q.all(...signals, limit) as Array<Record<string, string>>).map((r) => ({
    replyText: String(r.reply_text ?? ''),
    triggerText: String(r.trigger_text ?? ''),
    signal: r.signal ?? '',
    outcome: r.outcome ?? '',
  }));
}

async function main(): Promise<void> {
  const pos = loadSamples(POSITIVE_SIGNALS, N);
  const neg = loadSamples(NEGATIVE_SIGNALS, N);
  if (pos.length === 0 || neg.length === 0) {
    logger.error({ pos: pos.length, neg: neg.length }, 'no samples');
    process.exit(1);
  }

  let posSum = 0;
  let negSum = 0;
  let correctAt50 = 0;
  const posScores: number[] = [];
  const negScores: number[] = [];

  for (const s of pos) {
    const score = await verifyReplyQuality({
      reply: s.replyText,
      contextHint: `群聊里用户说:「${s.triggerText.slice(0, 80)}」, bot 这样回复了。`,
    });
    posScores.push(score);
    posSum += score;
    if (score >= 0.5) correctAt50++;
  }
  for (const s of neg) {
    const score = await verifyReplyQuality({
      reply: s.replyText,
      contextHint: `群聊里用户说:「${s.triggerText.slice(0, 80)}」, bot 这样回复了。`,
    });
    negScores.push(score);
    negSum += score;
    if (score < 0.5) correctAt50++;
  }

  const posMean = posSum / pos.length;
  const negMean = negSum / neg.length;
  const acc = correctAt50 / (pos.length + neg.length);
  const sep = posMean - negMean;

  // 简单 AUC(无 ties 假设)
  let auc = 0;
  for (const p of posScores) for (const n of negScores) if (p > n) auc++;
  auc /= posScores.length * negScores.length;

  logger.info(
    {
      n: pos.length + neg.length,
      posMean: posMean.toFixed(3),
      negMean: negMean.toFixed(3),
      separation: sep.toFixed(3),
      accAt50: acc.toFixed(3),
      auc: auc.toFixed(3),
    },
    'verifier offline eval done',
  );
  console.log(
    `verifier eval: pos=${pos.length} neg=${neg.length}\n` +
      `  positive mean score: ${posMean.toFixed(3)}\n` +
      `  negative mean score: ${negMean.toFixed(3)}\n` +
      `  separation (pos-neg): ${sep.toFixed(3)}${sep <= 0 ? ' ⚠️ 无区分度!' : ''}\n` +
      `  accuracy @ 0.5: ${acc.toFixed(3)}\n` +
      `  AUC: ${auc.toFixed(3)}${auc < 0.6 ? ' ⚠️ 弱' : auc < 0.75 ? ' (中)' : ' ✓ 强'}`,
  );
}

if (SAMPLE) {
  // 冒烟: 只跑 2 条验证链路无错
  const pos1 = loadSamples(POSITIVE_SIGNALS, 1);
  const neg1 = loadSamples(NEGATIVE_SIGNALS, 1);
  const r1 = await verifyReplyQuality({ reply: pos1[0]!.replyText });
  const r2 = await verifyReplyQuality({ reply: neg1[0]!.replyText });
  console.log(`smoke: pos=${r1.toFixed(2)} neg=${r2.toFixed(2)}`);
  process.exit(0);
}

void main();