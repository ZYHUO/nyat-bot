// ────────────────────────────────────────
// AI Label 管理 — 从 .env AI_PROVIDER_* / AI_USAGE_* 构建
// ────────────────────────────────────────

import type { AILabel, AIUsage } from './types.js';
import { getProviders, getUsageRouting, env } from '../env.js';
import { AIConfigError } from '../shared/errors.js';

let _labels: Map<string, AILabel> | undefined;

export function getLabels(): Map<string, AILabel> {
  if (_labels) return _labels;

  const providers = getProviders();
  _labels = new Map<string, AILabel>();

  for (const [name, p] of Array.from(providers.entries())) {
    // Mundo 部门可开可不开:关时不注册 mundo label(零足迹;误路由到它会响亮报错,
    // 而不是悄悄走一个禁用端点)。开时正常注册,`mundo` usage 才可路由。
    if (name === 'mundo' && !env().MUNDO_ENABLED) continue;
    _labels.set(name, {
      name,
      endpoint: p.endpoint,
      apiKeys: p.apiKey ? [p.apiKey] : [],
      model: p.model,
      apiFormat: p.apiFormat,
      stream: p.stream,
      reasoningEffort: p.reasoningEffort,
      disableThinking: p.disableThinking,
      insecureTLS: p.insecureTLS,
      forceRaw: p.forceRaw,
      timeout: p.timeout,
      maxTokens: p.maxTokens,
      temperature: p.temperature,
      capabilities:
        p.vision !== undefined || p.video !== undefined
          ? {
              ...(p.vision !== undefined ? { vision: p.vision } : {}),
              ...(p.video !== undefined ? { video: p.video } : {}),
            }
          : undefined,
      tier: p.tier,
    });
  }

  return _labels;
}

export function getLabel(name: string): AILabel {
  const label = getLabels().get(name);
  if (!label) throw new AIConfigError(`AI label not found: ${name}`);
  return label;
}

function ensureUsageLabelsExist(usageName: string, usage: AIUsage): AIUsage {
  const labels = getLabels();
  const missing = [usage.label, ...usage.backups].filter((labelName) => !labels.has(labelName));
  if (missing.length > 0) {
    throw new AIConfigError(`AI usage ${usageName} references missing label(s): ${missing.join(', ')}`);
  }
  return usage;
}

/**
 * 核心部门（配 AI_USAGE_*）:
 *   reply / judge / summarize / vision / deep_think
 * 可选: audio / mundo
 *
 * 历史名 → 核心部门（旧调用/旧 .env 仍可解析）
 */
export const USAGE_ALIASES: Readonly<Record<string, string>> = {
  heart: 'judge',
  heart_reflect: 'summarize',
  path_reflection: 'judge',
  allowlist_review: 'judge',
  reply_splitter: 'judge',
  planner: 'judge',
  summarize_deep: 'summarize',
};

export function resolveUsageName(name: string): string {
  return USAGE_ALIASES[name] ?? name;
}

// Fallback defaults — 仅核心 + 可选重活；别名不在此表
const USAGE_DEFAULTS: Record<string, AIUsage> = {
  reply:     { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 60_000 },
  // 合并写手（reply-with-tools）专用：它走 AI SDK 的 tools，**只吃 OpenAI 兼容格式**，
  // 而 reply 默认链的两个 label 都是 claude 原生格式 → 循环里被静默跳过 →
  // 195 次 `Merged tool-writer exhausted` 而 `finished` **0 次**（2026-09-21 实测）。
  // 也就是说这个写手从上线起一次都没成功过，只是每次都安静地退回纯文本写手。
  //
  // 这里给的是池子里**唯一健康且非 claude 格式**的 label（spark13，
  // successCount 800）。它自己也不稳（newapi 侧偶发连接超时），所以失败仍会
  // 退回 legacy——但至少给了它一次真跑的机会，且失败现在有日志。
  reply_tools: { label: 'spark13',     backups: ['k26'],           timeout: 60_000 },
  // 2026-09-22 round 3：主 label 原为 sub2gpt54mini——**它在 round 133/134 清 7864
  // label 时被删了**，而这里没跟着改。于是每次 vision 调用都直接 fallback 到
  // stepfunvision（一个 reasoning 模型，思维链吃 max_tokens → 空正文）。
  // 日志观测到 3 分钟 9 次 `claude: 空正文 —— 思维链吃光 max_tokens（截断）`。
  // 现在直接拿 stepfunvision 当主（它声明 vision=true、实测能出正文），
  // backup 给 dshkimi（kimi-for-coding 同样声明 supports_image_in）。
  vision:    { label: 'stepfunvision', backups: ['dshkimi'],       timeout: 30_000 },
  audio:     { label: 'stepfun',       backups: [],               timeout: 30_000 },
  // 视频理解（2026-09-21）：独立 usage，不蹭 vision 链——见 env.ts 的
  // VIDEO_DESCRIBE_ENABLED 注释。step5（step-5-preview）是实测唯一稳定出正文的，
  // backup 给 stepfunvision（step-3.7-flash，同厂、支持 vision，但 reasoning
  // 会吃 token，所以 maxTokens 给得比图片大得多）。
  // backup 现在有两个：stepfunvision（同厂，reasoning 吃 token，所以 maxTokens 给大）
  // 和 dshkimi（kimi-for-coding，/v1/models 实测声明 supports_video_in）。
  video:     { label: 'step5',         backups: ['stepfunvision', 'dshkimi'], timeout: 120_000, maxTokens: 2_000 },
  // judge/heart（step-3.7-flash reasoning）：maxTokens 不设上限——reasoning_content 计入
  // completion，卡 800 会把 JSON 截成半截；实测 low 档自然输出 300-1000 token。
  // timeout 45s：开了 reasoning 后 P99 偶到 35s，30s 会无谓触发同模型 backup 重试。
  judge:     { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 45_000, temperature: 0, jsonMode: true },
  summarize: { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 180_000, jsonMode: true },
  // Mundo「难题攻坚」部门(可选,默认关)
  mundo:     { label: 'mundo',         backups: ['stepfun'],      timeout: 480_000, maxTokens: 16_000 },
  // 「深想」异步深答(可选)
  deep_think:{ label: 'k27code',       backups: ['mundo', 'stepfunthink'], timeout: 120_000, maxTokens: 16_000 },
};

export function getUsage(name: string): AIUsage {
  const resolved = resolveUsageName(name);

  // Check env-defined usage routing first
  const envUsage = getUsageRouting().get(resolved);
  if (envUsage) {
    return ensureUsageLabelsExist(resolved, {
      label: envUsage.label,
      backups: envUsage.backups,
      timeout: envUsage.timeout ?? 60_000,
      maxTokens: envUsage.maxTokens,
      temperature: envUsage.temperature,
      // .env 未配 JSON_MODE 时跟硬默认走（judge/summarize 默认 true）
      jsonMode: envUsage.jsonMode ?? USAGE_DEFAULTS[resolved]?.jsonMode,
    });
  }

  // Fallback to hardcoded defaults
  const usage = USAGE_DEFAULTS[resolved];
  if (!usage) throw new AIConfigError(`AI usage not found: ${name}${resolved !== name ? ` (alias→${resolved})` : ''}`);
  return ensureUsageLabelsExist(resolved, { ...usage });
}

/** Reset cached labels (for testing) */
export function _resetLabels(): void {
  _labels = undefined;
}
