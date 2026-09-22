// ────────────────────────────────────────
// Help text + first-DM onboarding content
// ────────────────────────────────────────

/**
 * /help 内容。2026-08-08 dm-relay 关键词系统全删后,DM 不再有
 * 关键词/命令触发的功能——意图全部由 LLM 自然理解,这里只提示
 * 通用斜杠命令。
 */
export async function buildHelpText(): Promise<string> {
  const lines = [
    '🐱 本喵能帮你做这些事喵~',
    '',
    '直接说就行,本喵会自然理解你的意思,不用记关键词或固定句式喵~',
    '',
    '⚙️ 通用命令',
    '· /game guess — 小游戏',
    '· /cards — 我的猫娘图鉴',
    '· /wish — 心愿单',
    '· /muteme /unmuteme — 让本喵别回你 / 恢复回复',
    '· /checkin /stats — 签到 / 群聊统计',
  ];
  // round 37：**动态列出已加载的 skill**。原来这段是手写死的，
  // round 21 加了 8 个 skill（查 IP / 查币价 / 随机狗图 / …）之后
  // /help 一个字都没提——功能加了，入口没给，等于没加。
  try {
    const { listLoadedSkillNames } = await import('../../pipeline/tools/registry.js');
    const names = listLoadedSkillNames();
    if (names.length > 0) {
      lines.push('');
      lines.push(`🔌 还会用 ${names.length} 个工具喵~`);
      for (const n of names) lines.push(`· ${n}`);
      lines.push('（直接说"查一下 8.8.8.8 是哪的"/"BTC 现在多少"本喵就懂了喵）');
    }
  } catch { /* 工具链没起来（启动早期/测试）—— 不因为帮助文本坏掉 */ }
  return lines.join('\n');
}

/** First-contact onboarding message (prefix + full help). */
export async function buildOnboardingText(): Promise<string> {
  return `🐱 喵~ 第一次跟本喵私聊呀？\n\n${buildHelpText()}`;
}
