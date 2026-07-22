// ────────────────────────────────────────
// AI Label 管理 — 从 .env AI_PROVIDER_* / AI_USAGE_* 构建
// ────────────────────────────────────────

import type { AILabel, AIUsage } from './types.js';
import { getProviders, getUsageRouting, getReplyMaxLabels, env } from '../env.js';
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
 *   reply / reply_pro / reply_max / judge / summarize / vision / deep_think
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
  reply_pro: { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 90_000 },
  vision:    { label: 'sub2gpt54mini', backups: ['stepfunvision'], timeout: 30_000 },
  audio:     { label: 'stepfun',       backups: [],               timeout: 30_000 },
  judge:     { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 30_000, maxTokens: 800,  temperature: 0 },
  summarize: { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 180_000 },
  // Mundo「难题攻坚」部门(可选,默认关)
  mundo:     { label: 'mundo',         backups: ['stepfun'],      timeout: 480_000, maxTokens: 16_000 },
  // 「深想」异步深答(可选)
  deep_think:{ label: 'k27code',       backups: ['mundo', 'stepfunthink'], timeout: 120_000, maxTokens: 16_000 },
};

export function getUsage(name: string): AIUsage {
  const resolved = resolveUsageName(name);

  // reply_max: randomly rotate from AI_USAGE_REPLY_MAX_LABELS
  if (resolved === 'reply_max') {
    const maxLabels = getReplyMaxLabels();
    if (maxLabels.length === 0) {
      throw new AIConfigError('AI_USAGE_REPLY_MAX_LABELS not configured');
    }
    const shuffled = [...maxLabels].sort(() => Math.random() - 0.5);
    return ensureUsageLabelsExist(resolved, {
      label: shuffled[0]!,
      backups: shuffled.slice(1),
      timeout: 180_000,
    });
  }

  // Check env-defined usage routing first
  const envUsage = getUsageRouting().get(resolved);
  if (envUsage) {
    return ensureUsageLabelsExist(resolved, {
      label: envUsage.label,
      backups: envUsage.backups,
      timeout: envUsage.timeout ?? 60_000,
      maxTokens: envUsage.maxTokens,
      temperature: envUsage.temperature,
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
