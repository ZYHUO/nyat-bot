// ────────────────────────────────────────
// Help text + first-DM onboarding content
// ────────────────────────────────────────

/**
 * /help 内容。2026-08-08 dm-relay 关键词系统全删后,DM 不再有
 * 关键词/命令触发的功能——意图全部由 LLM 自然理解,这里只提示
 * 通用斜杠命令。
 */
export function buildHelpText(): string {
  return [
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
  ].join('\n');
}

/** First-contact onboarding message (prefix + full help). */
export function buildOnboardingText(): string {
  return `🐱 喵~ 第一次跟本喵私聊呀？\n\n${buildHelpText()}`;
}
