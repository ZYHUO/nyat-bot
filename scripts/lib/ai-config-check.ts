import type { AILabel, AIUsage } from '../../src/ai/types.js';

export interface AiConfigAuditInput {
  labels: ReadonlyMap<string, AILabel>;
  usageNames: readonly string[];
  usage: (name: string) => AIUsage;
  settings: { MUNDO_ENABLED?: boolean; TIMING_GATE_MAX_TOKENS: number; ASI_RUBRIC_MAX_TOKENS: number };
}

/** Configuration review, not provider health or proof that two keys belong to
 * different upstream billing accounts. Output is codes only, never credentials. */
export function auditAiConfig(input: AiConfigAuditInput): string[] {
  const issues = new Set<string>();
  const account = (label: AILabel): string => {
    try { return JSON.stringify([new URL(label.endpoint).origin, label.apiKeys[0] ?? '']); }
    catch { return JSON.stringify([label.endpoint, label.apiKeys[0] ?? '']); }
  };
  const usage = (name: string): AIUsage | undefined => {
    try { return input.usage(name); }
    catch { issues.add(`usage_invalid:${name}`); return undefined; }
  };
  const label = (name: string): AILabel | undefined => {
    const item = input.labels.get(name);
    if (!item) issues.add(`label_missing:${name}`);
    else if (!item.model || !item.endpoint || !item.apiKeys.some(key => key.trim())) issues.add(`provider_incomplete:${name}`);
    return item;
  };
  if (!input.labels.size) issues.add('provider_pool_empty');
  for (const name of new Set([...input.usageNames, 'reflection'])) {
    if (name === 'mundo' && !input.settings.MUNDO_ENABLED) continue;
    const route = usage(name);
    if (route) for (const name of [route.label, ...route.backups]) label(name);
  }
  const judge = usage('judge'), reflection = usage('reflection');
  const primary = judge && label(judge.label);
  if (judge && primary) {
    if (!judge.backups.length) issues.add('judge_backup_missing');
    const same: number[] = [], different: number[] = [];
    judge.backups.forEach((name, index) => {
      const candidate = label(name);
      if (candidate) (account(candidate) === account(primary) ? same : different).push(index);
    });
    if (!different.length) issues.add('judge_independent_account_missing');
    if (same.length && different.length && Math.max(...same) > Math.min(...different)) issues.add('judge_backup_order');
    const background = reflection && label(reflection.label);
    if (background && account(background) === account(primary)) issues.add('reflection_shares_judge_account');
  }
  if ((usage('summarize')?.maxTokens ?? 0) < 4000) issues.add('summarize_reasoning_budget_small');
  if (input.settings.TIMING_GATE_MAX_TOKENS < 4000) issues.add('timing_reasoning_budget_small');
  const vision = usage('vision')?.maxTokens ?? 0;
  if (vision <= 0) issues.add('vision_budget_missing');
  if (input.settings.ASI_RUBRIC_MAX_TOKENS < 8000) issues.add('asi_reasoning_budget_small');
  if (vision > 0 && input.settings.ASI_RUBRIC_MAX_TOKENS > vision * 2) issues.add('asi_vision_budget_ratio');
  return [...issues];
}
