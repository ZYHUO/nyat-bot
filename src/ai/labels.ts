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

// Fallback defaults — stepfun 全家桶;识图单独 sub2gpt54mini。
const USAGE_DEFAULTS: Record<string, AIUsage> = {
  reply:            { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 60_000 },
  reply_pro:        { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 90_000 },
  vision:           { label: 'sub2gpt54mini', backups: ['stepfunvision'], timeout: 30_000 },
  audio:            { label: 'stepfun',       backups: [],               timeout: 30_000 },
  judge:            { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 30_000, maxTokens: 200,  temperature: 0 },
  heart:            { label: 'stepfunjudge',  backups: ['longcat'],      timeout: 30_000, maxTokens: 120,  temperature: 0 },
  planner:          { label: 'sub2gpt54mini', backups: ['sub2gpt55'],     timeout: 60_000, maxTokens: 300,  temperature: 0 },
  summarize:        { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 120_000 },
  // Mundo「难题攻坚」部门(可选,默认关):深推理模型走 mundo,失败/未启用则兜底
  // 到 stepfun(reasoning 模型)。maxTokens 给足(深推理模型截断会返回空 content);
  // timeout 拉长(它想得很久)。仅手动/显式路由使用,不接任何自动热路径。
  mundo:            { label: 'mundo',          backups: ['stepfun'],      timeout: 480_000, maxTokens: 16_000 },
  // 后台深度摘要:high 推理(stepfunthink),只给配额消费 cron 用,不碰用户可见路径。
  // stepfunthink 缺失时回退 stepfun(medium),不致命。
  summarize_deep:   { label: 'stepfunthink',  backups: ['stepfun'],      timeout: 180_000 },
  path_reflection:  { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 20_000, maxTokens: 200,  temperature: 0 },
  allowlist_review: { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 60_000 },
  reply_splitter:   { label: 'stepfun',       backups: ['stepfunjudge'], timeout: 30_000, maxTokens: 500,  temperature: 0 },
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
