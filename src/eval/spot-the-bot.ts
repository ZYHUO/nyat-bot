// ────────────────────────────────────────
// Spot-the-Bot 盲测 harness (H4, 纯确定性, 框架不断言真 LLM)
// ────────────────────────────────────────
//
// plan 原文 (Deriu et al. 2021 EMNLP + ACUTE-Eval):
//   50 bot + 50 真人混排, 3 个群外人标 bot-or-not;
//   核心指标 P(标为真人|bot) + 校准 P(标为bot|真人)。
//
// 本文件只做框架：混排 + 计分。真人标注流程在外部（人工标），
// 不进 CI（CI 只断言框架自洽，不烧真 LLM、不写穿 prompts）。

export const BLIND_SET_SIZE = 100;
export const BLIND_PER_CLASS = 50;

export interface BlindItem {
  /** 真实来源（标注时隐藏，计分时用） */
  source: 'bot' | 'human';
  text: string;
}

export interface BlindJudgment {
  text: string;
  /** 标注者猜这是真人吗 */
  guessedHuman: boolean;
}

export interface BlindScore {
  judged: number;
  /** P(标为真人|bot) —— 越高 bot 越像人 */
  pHumanGivenBot: number;
  /** P(标为bot|真人) —— 校准项，越高误杀越多 */
  pBotGivenHuman: number;
}

/** 50/50 混排 + Fisher-Yates 洗牌。数量不足抛错（防半吊子评测）。 */
export function buildBlindSet(botTexts: string[], humanTexts: string[]): BlindItem[] {
  if (botTexts.length < BLIND_PER_CLASS || humanTexts.length < BLIND_PER_CLASS) {
    throw new Error(
      `spot-the-bot needs 50+50, got bot=${botTexts.length} human=${humanTexts.length}`,
    );
  }
  const items: BlindItem[] = [
    ...botTexts.slice(0, BLIND_PER_CLASS).map((text) => ({ source: 'bot' as const, text })),
    ...humanTexts.slice(0, BLIND_PER_CLASS).map((text) => ({ source: 'human' as const, text })),
  ];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

/**
 * 计分。按 text 关联 item↔judgment；漏判的项不进分母（judged 缩），
 * 某类零判定 → 对应指标 NaN（不静默补 0，防"没人判=满分"假象）。
 */
export function scoreBlindJudgments(items: BlindItem[], judgments: BlindJudgment[]): BlindScore {
  const byText = new Map(judgments.map((j) => [j.text, j.guessedHuman]));
  let botN = 0;
  let botCalledHuman = 0;
  let humanN = 0;
  let humanCalledBot = 0;
  for (const item of items) {
    const g = byText.get(item.text);
    if (g === undefined) continue;
    if (item.source === 'bot') {
      botN++;
      if (g) botCalledHuman++;
    } else {
      humanN++;
      if (!g) humanCalledBot++;
    }
  }
  return {
    judged: botN + humanN,
    pHumanGivenBot: botN > 0 ? botCalledHuman / botN : NaN,
    pBotGivenHuman: humanN > 0 ? humanCalledBot / humanN : NaN,
  };
}
