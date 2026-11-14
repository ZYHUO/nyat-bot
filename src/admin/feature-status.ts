import type { Redis } from 'ioredis';
import type { Env } from '../env.js';
import type { TickTaskObservation } from '../cron/heartbeat.js';

type BooleanFlag = { [K in keyof Env]-?: Env[K] extends boolean ? K : never }[keyof Env];
interface FeatureDefinition {
  id: string;
  label: string;
  flag: BooleanFlag | 'VISION_ROUTING_CONFIGURED';
  requires?: BooleanFlag[];
  task?: string;
  redis?: boolean;
  probe?: 'model' | 'vector' | 'sandbox' | 'vision' | 'weather' | 'audio' | 'tts';
  scope?: keyof Env;
}

// Deliberately explicit: this manifest must never serialize the Env object,
// provider configuration, allowlist IDs, prompts, or exception text.
export const FEATURE_MANIFEST: readonly FeatureDefinition[] = [
  { id: 'cron', label: '定时任务', flag: 'CRON_ENABLED', redis: true },
  { id: 'diary', label: '梦境日记', flag: 'DREAM_JOURNAL_ENABLED', task: 'dream-journal:', redis: true, probe: 'model' },
  { id: 'dreaming', label: '梦境整理', flag: 'DREAMING_ENABLED', task: 'dreaming', redis: true, probe: 'model' },
  { id: 'dream-consolidate', label: '梦境记忆合并', flag: 'DREAM_CONSOLIDATE_ENABLED', task: 'dream-consolidate', redis: true, probe: 'model' },
  { id: 'turn', label: '会话合并与打断', flag: 'TURN_ACTOR_ENABLED', redis: true, scope: 'TURN_ACTOR_CHAT_IDS' },
  { id: 'heart', label: '心流回复决策', flag: 'HEART_ENABLED', redis: true, probe: 'model' },
  { id: 'timing', label: '回复时机', flag: 'TIMING_GATE_ENABLED', redis: true, probe: 'model' },
  { id: 'meta', label: 'Meta 任务编排', flag: 'META_SUBAGENT_ENABLED', requires: ['CODEACT_ISOLATION_ENABLED'], redis: true, probe: 'model', scope: 'META_SUBAGENT_CHAT_IDS' },
  { id: 'meta-defer', label: 'Meta 延后回复', flag: 'META_DEFER_ENABLED', requires: ['META_SUBAGENT_ENABLED', 'TIMING_GATE_ENABLED'], redis: true },
  { id: 'learning', label: '表达与黑话学习', flag: 'LEARNER_ENABLED', task: 'learner-scan', redis: true, probe: 'model' },
  { id: 'expression', label: '表达注入', flag: 'EXPRESSION_INJECT_ENABLED', redis: true },
  { id: 'jargon', label: '黑话查询', flag: 'JARGON_QUERY_ENABLED', redis: true },
  { id: 'identity', label: '人物身份记忆', flag: 'PERSON_IDENTITY_ENABLED', redis: true },
  { id: 'relationship', label: '人物关系', flag: 'RELATIONSHIP_ENABLED', redis: true },
  { id: 'memory-visibility', label: '记忆可见性', flag: 'MEMORY_VISIBILITY_ENABLED' },
  { id: 'memory-cross-context', label: '跨会话记忆', flag: 'MEMORY_CROSS_CONTEXT_ENABLED', requires: ['MEMORY_VISIBILITY_ENABLED'], probe: 'vector' },
  { id: 'memory-hybrid', label: '混合记忆检索', flag: 'MEMORY_HYBRID_ENABLED', probe: 'vector' },
  { id: 'memory-dedup', label: '记忆去重', flag: 'MEMORY_DEDUP_ENABLED', probe: 'vector' },
  { id: 'task-executor', label: '持久任务唤醒', flag: 'TASK_EXECUTOR_ENABLED', task: 'task-wake', redis: true, probe: 'model' },
  { id: 'bot-command-learning', label: '机器人命令学习', flag: 'BOT_COMMAND_LEARN_ENABLED', task: 'bot-command-learn', redis: true, probe: 'model' },
  { id: 'rss', label: 'RSS 监控', flag: 'RSS_MONITOR_ENABLED', task: 'rss-monitor', redis: true },
  { id: 'topics', label: '话题扫描', flag: 'TOPIC_REGISTRY_ENABLED', task: 'topic-scan', redis: true, probe: 'model' },
  { id: 'cache-warmup', label: '缓存预热', flag: 'CACHE_WARMUP_ENABLED', task: 'cache-warmup', redis: true },
  { id: 'self-reflect', label: '深度反思', flag: 'REFLECTION_ENABLED', task: 'deep-reflection', redis: true, probe: 'model' },
  { id: 'skill-distill', label: '技能提炼', flag: 'SKILL_DISTILL_ENABLED', task: 'skill-distill', redis: true, probe: 'model' },
  { id: 'skill-consolidate', label: '技能合并', flag: 'SKILL_CONSOLIDATE_ENABLED', task: 'skill-consolidate', redis: true, probe: 'model' },
  { id: 'hobby', label: '兴趣提炼', flag: 'HOBBY_DISTILL_ENABLED', task: 'hobby-distill', redis: true, probe: 'model' },
  { id: 'sleep', label: '作息调度', flag: 'SLEEP_SCHEDULE_ENABLED', task: 'sleep-cycle', redis: true },
  { id: 'sleep-announce', label: '作息问候', flag: 'SLEEP_ANNOUNCE_ENABLED', requires: ['SLEEP_SCHEDULE_ENABLED'], task: 'sleep-cycle', redis: true },
  { id: 'sleep-bedtime-guard', label: '对话中延后就寝', flag: 'SLEEP_BEDTIME_GUARD_ENABLED', requires: ['SLEEP_SCHEDULE_ENABLED'], task: 'sleep-cycle', redis: true },
  { id: 'mood', label: '情绪状态', flag: 'MOOD_ENABLED' },
  { id: 'mood-inject', label: '情绪提示', flag: 'MOOD_INJECT_ENABLED', requires: ['MOOD_ENABLED'] },
  { id: 'mood-tune', label: '随情绪调整表达', flag: 'MOOD_TUNE_ENABLED', requires: ['MOOD_ENABLED'] },
  { id: 'self-history', label: '自身发言记录', flag: 'SELF_HISTORY_ENABLED' },
  { id: 'own-history-retrieval', label: '自身历史召回', flag: 'OWN_HISTORY_RETRIEVAL_ENABLED', requires: ['SELF_HISTORY_ENABLED'] },
  { id: 'control-directive', label: '自然语言控制指令', flag: 'CONTROL_DIRECTIVE_ENABLED', probe: 'model' },
  { id: 'room-awareness', label: '房间感知', flag: 'ROOM_AWARENESS_ENABLED', requires: ['META_SUBAGENT_ENABLED'], redis: true },
  { id: 'open-threads', label: '未完成约定记录', flag: 'OPEN_THREADS_ENABLED' },
  { id: 'proactive-memory', label: '主动发言记忆', flag: 'PROACTIVE_MEMORY_ENABLED', probe: 'vector' },
  { id: 'proactive-coordinator', label: '主动发言限流', flag: 'PROACTIVE_COORDINATOR_ENABLED', redis: true },
  { id: 'outcome-tracking', label: '回复效果跟踪', flag: 'OUTCOME_TRACKING_ENABLED' },
  { id: 'bot-classifier', label: '其他机器人分类', flag: 'BOT_CLASSIFIER_ENABLED' },
  { id: 'bot-denoise', label: '机器人消息降噪', flag: 'BOT_DENOISE_ENABLED', requires: ['BOT_CLASSIFIER_ENABLED'] },
  { id: 'weather', label: '天气感知', flag: 'WEATHER_ENABLED', redis: true, probe: 'weather' },
  { id: 'vision-describe', label: '图片理解与贴纸描述', flag: 'VISION_ROUTING_CONFIGURED', probe: 'vision' },
  { id: 'vision', label: '原图直接输入回复模型', flag: 'REPLY_VISION_ENABLED', probe: 'vision' },
  { id: 'audio', label: '语音转文字', flag: 'AUDIO_TRANSCRIBE_ENABLED', probe: 'audio' },
  { id: 'tts', label: '语音回复', flag: 'TTS_ENABLED', probe: 'tts' },
  { id: 'sandbox', label: '命令沙箱', flag: 'SANDBOX_ENABLED', probe: 'sandbox' },
  { id: 'codeact-isolation', label: '生成代码进程隔离', flag: 'CODEACT_ISOLATION_ENABLED', probe: 'sandbox' },
];

export interface FeatureDependency {
  id: string;
  label: string;
  status: 'ready' | 'blocked' | 'unknown';
}

const TASK_NAMES = new Set([
  'model-check', 'process-lifetime', 'stale-agent-sweep', 'daily-report', 'cleanup',
  'behavioral-roles', 'feedback-aggregate', 'memory-dream', 'relationship-summarize',
  'token-report', 'group-episodes', 'expression-gate', 'user-profile-sync', 'unified-tick',
  'channel-sync', 'stats-flush', 'verify-cleanup', 'goal-close-sweep', 'debt-sweep',
  'cognitive-outbox', 'belief-verify', 'trench-pump', 'trench-wake-detect', 'echo-backfill',
  'control-baseline', 'cognitive-continuity', 'cognitive-kernel-recovery', 'social-prediction-sweep',
  'profile-merge', 'deep-reflection', 'stepfun-consumer', 'task-wake', 'connectivity-calc',
  'school-day-plan', 'resident-sticker-analyze', 'knowledge-sync', 'dreaming', 'dream-consolidate',
  'silence-alert', 'bot-command-learn', 'tic-penalty', 'sleep-cycle', 'self-reflect',
  'sycophancy-audit', 'skill-distill', 'skill-consolidate', 'hobby-distill', 'rss-monitor',
  'topic-scan', 'cache-warmup', 'learner-scan',
]);
const SAFE_REASONS = new Set(['disabled', 'no_evidence', 'cooldown', 'model_skip', 'empty_output', 'unparsed', 'llm_failed', 'not_due']);
const SAFE_DURABLE_STATES = new Set(['not_scheduled', 'scheduled', 'claimed', 'started', 'succeeded', 'skipped', 'failed', 'unknown']);
const PROBE_LABELS = { model: '模型端到端能力尚未探测', vector: '向量服务尚未探测', sandbox: '操作系统隔离能力尚未探测', vision: '图片模型能力尚未探测', weather: '天气源连通性尚未探测', audio: '转写接口尚未在当前进程探测', tts: '语音合成与编码尚未在当前进程探测' };

function safeTask(task: TickTaskObservation, index: number): TickTaskObservation {
  const name = TASK_NAMES.has(task.name) || /^dream-journal:(?:[01]?\d|2[0-3]):[0-5]?\d$/.test(task.name) ? task.name : `unlisted-task-${index + 1}`;
  // Project every field; never pass arbitrary task metadata through the API.
  return {
    name, registered: true, running: task.running, schedule: {
      ...(task.schedule.everySec !== undefined ? { everySec: task.schedule.everySec } : {}),
      ...(task.schedule.dailyAt ? { dailyAt: { hour: task.schedule.dailyAt.hour, minute: task.schedule.dailyAt.minute } } : {}),
      ...(task.schedule.weeklyAt ? { weeklyAt: { day: task.schedule.weeklyAt.day, hour: task.schedule.weeklyAt.hour, minute: task.schedule.weeklyAt.minute } } : {}),
    },
    lastStartedAt: task.lastStartedAt, lastFinishedAt: task.lastFinishedAt, durationMs: task.durationMs,
    lastDispatchedAt: task.lastDispatchedAt, nextRunAt: task.nextRunAt, due: task.due,
    historyAvailable: task.historyAvailable, result: task.result,
    reason: task.reason && SAFE_REASONS.has(task.reason) ? task.reason : null, timedOut: task.timedOut,
    ...(task.durableState === undefined ? {} : { durableState: SAFE_DURABLE_STATES.has(task.durableState) ? task.durableState : 'unknown' }),
    ...(task.lastCompletedAt === undefined ? {} : { lastCompletedAt: typeof task.lastCompletedAt === 'number'
      && Number.isSafeInteger(task.lastCompletedAt) && task.lastCompletedAt > 0 ? task.lastCompletedAt : null }),
  };
}

export function buildFeatureStatus(config: Env, runtime: {
  schedulerRunning: boolean;
  redisReady: boolean;
  tasks: TickTaskObservation[];
  visionConfigured?: boolean;
  now?: number;
}) {
  const tasks = runtime.tasks.map(safeTask);
  const features = FEATURE_MANIFEST.map((definition) => {
    const enabled = definition.flag === 'VISION_ROUTING_CONFIGURED' ? runtime.visionConfigured === true : config[definition.flag] === true;
    const dependencies: FeatureDependency[] = (definition.requires ?? []).map((flag) => ({
      id: flag, label: flag, status: config[flag] === true ? 'ready' : 'blocked',
    }));
    if (definition.redis) dependencies.push({ id: 'redis', label: 'Redis 当前连接', status: runtime.redisReady ? 'ready' : 'blocked' });
    const matching = definition.task ? tasks.filter((task) => definition.task!.endsWith(':') ? task.name.startsWith(definition.task!) : task.name === definition.task) : [];
    if (definition.task || definition.id === 'cron') {
      dependencies.push({ id: 'CRON_ENABLED', label: '定时任务总开关', status: config.CRON_ENABLED ? 'ready' : 'blocked' });
      dependencies.push({ id: 'heartbeat', label: '当前进程心跳', status: runtime.schedulerRunning ? 'ready' : 'blocked' });
      if (definition.task) dependencies.push({ id: 'registration', label: '任务已注册', status: matching.length > 0 ? 'ready' : 'blocked' });
    }
    if (definition.probe) dependencies.push({ id: definition.probe, label: PROBE_LABELS[definition.probe], status: 'unknown' });
    let state: 'disabled' | 'blocked' | 'configured' | 'scheduled' | 'running' | 'degraded';
    if (!enabled) state = 'disabled';
    else if (dependencies.some((dependency) => dependency.status === 'blocked')) state = 'blocked';
    else if (matching.some((task) => task.running)) state = 'running';
    else if (matching.some((task) => task.result === 'failed' || task.timedOut)) state = 'degraded';
    else if (definition.task || definition.id === 'cron') state = 'scheduled';
    else state = 'configured';
    const scopeValue = definition.scope ? config[definition.scope] : undefined;
    const restricted = Array.isArray(scopeValue) ? scopeValue.length > 0 : typeof scopeValue === 'string' && scopeValue.trim().length > 0;
    return { id: definition.id, label: definition.label, flag: definition.flag, enabled, state, dependencies,
      requiredFlags: [...(definition.requires ?? []), ...(definition.task ? ['CRON_ENABLED'] : [])],
      expectedTask: definition.task ?? null, tasks: matching.map((task) => task.name),
      scope: definition.scope ? (restricted ? 'restricted' : 'all') : 'feature-policy',
    };
  });
  return {
    observedAt: runtime.now ?? Date.now(), scope: 'current-process', timezone: 'Asia/Shanghai',
    schedulerRunning: runtime.schedulerRunning, redisReady: runtime.redisReady,
    notes: ['仅观察当前主进程注册的任务，外部服务不在此表。', '已配置不等于已触发；已调度不保证模型或外部服务可用。', '完成表示任务回调正常结束；仅带明确 skipped 结果的任务能区分业务跳过。'],
    features, tasks,
  };
}

export async function getFeatureStatusReport(config: Env, redis: Pick<Redis, 'status'>) {
  // Lazy import keeps unrelated monitor routes independent of scheduler startup.
  const { getTickObservations, isStarted } = await import('../cron/heartbeat.js');
  let visionConfigured = false;
  try {
    const { getUsage, getLabel } = await import('../ai/labels.js');
    const usage = getUsage('vision');
    visionConfigured = [usage.label, ...usage.backups].some((name) => {
      const label = getLabel(name);
      return label.capabilities?.vision === true && label.apiKeys.some((key) => key.trim().length > 0);
    });
  } catch { /* Missing routing is a disabled capability, never a monitor failure. */ }
  return buildFeatureStatus(config, {
    schedulerRunning: isStarted(), redisReady: redis.status === 'ready', tasks: await getTickObservations(), visionConfigured,
  });
}
