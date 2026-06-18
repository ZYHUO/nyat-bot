// ────────────────────────────────────────
// AI Label 管理 — 从 .env AI_PROVIDER_* / AI_USAGE_* 构建
// ────────────────────────────────────────

import type { AILabel, AIUsage } from './types.js';
import { getProviders, getUsageRouting, getReplyMaxLabels } from '../env.js';
import { AIConfigError } from '../shared/errors.js';

let _labels: Map<string, AILabel> | undefined;

export function getLabels(): Map<string, AILabel> {
  if (_labels) return _labels;

  const providers = getProviders();
  _labels = new Map<string, AILabel>();

  for (const [name, p] of Array.from(providers.entries())) {
    _labels.set(name, {
      name,
      endpoint: p.endpoint,
      apiKeys: p.apiKey ? [p.apiKey] : [],
      model: p.model,
      apiFormat: p.apiFormat,
      stream: p.stream,
      reasoningEffort: p.reasoningEffort,
      disableThinking: p.disableThinking,
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

// Fallback defaults — used when AI_USAGE_* is not configured for a given usage.
// 全部指向当前实际可用的 sub2api 标签(回复系 sub2gpt55、杂活 sub2gpt54mini):
// 旧默认指向已失效的 main/vision/claude/splitter(xiaomimimo 401),一旦某条
// AI_USAGE_* 路由被删/写错就会落到死端点。指向 live 供应商让兜底真能兜住。
const USAGE_DEFAULTS: Record<string, AIUsage> = {
  reply:            { label: 'sub2gpt55',     backups: ['sub2gpt54mini'], timeout: 60_000 },
  reply_pro:        { label: 'sub2gpt55',     backups: ['sub2gpt54mini'], timeout: 90_000 },
  vision:           { label: 'sub2gpt54mini', backups: [],                timeout: 30_000 },
  // 本环境无任何可用 input_audio/whisper 供应商:开 AUDIO_TRANSCRIBE_ENABLED 前
  // 必须先配 AI_USAGE_AUDIO_LABEL 指向真实可用 audio 端点。默认 label 用可达的
  // sub2gpt54mini:误翻开关时落到在线端点拿 400(被 try/catch 吞→中性占位),
  // 而不是反复打死主机吃满 timeout。
  audio:            { label: 'sub2gpt54mini', backups: [],                timeout: 30_000 },
  judge:            { label: 'sub2gpt54mini', backups: ['sub2gpt55'],     timeout: 30_000, maxTokens: 200,  temperature: 0 },
  planner:          { label: 'sub2gpt54mini', backups: ['sub2gpt55'],     timeout: 30_000, maxTokens: 300,  temperature: 0 },
  summarize:        { label: 'sub2gpt54mini', backups: ['sub2gpt55'],     timeout: 120_000 },
  path_reflection:  { label: 'sub2gpt54mini', backups: [],                timeout: 20_000, maxTokens: 200,  temperature: 0 },
  allowlist_review: { label: 'sub2gpt54mini', backups: ['sub2gpt55'],     timeout: 60_000 },
  reply_splitter:   { label: 'sub2gpt54mini', backups: ['sub2gpt55'],     timeout: 30_000, maxTokens: 500,  temperature: 0 },
};

export function getUsage(name: string): AIUsage {
  // reply_max: randomly rotate from AI_USAGE_REPLY_MAX_LABELS
  if (name === 'reply_max') {
    const maxLabels = getReplyMaxLabels();
    if (maxLabels.length === 0) {
      throw new AIConfigError('AI_USAGE_REPLY_MAX_LABELS not configured');
    }
    const shuffled = [...maxLabels].sort(() => Math.random() - 0.5);
    return ensureUsageLabelsExist(name, {
      label: shuffled[0]!,
      backups: shuffled.slice(1),
      timeout: 180_000,
    });
  }

  // Check env-defined usage routing first
  const envUsage = getUsageRouting().get(name);
  if (envUsage) {
    return ensureUsageLabelsExist(name, {
      label: envUsage.label,
      backups: envUsage.backups,
      timeout: envUsage.timeout ?? 60_000,
      maxTokens: envUsage.maxTokens,
      temperature: envUsage.temperature,
    });
  }

  // Fallback to hardcoded defaults
  const usage = USAGE_DEFAULTS[name];
  if (!usage) throw new AIConfigError(`AI usage not found: ${name}`);
  return ensureUsageLabelsExist(name, { ...usage });
}

/** Reset cached labels (for testing) */
export function _resetLabels(): void {
  _labels = undefined;
}
