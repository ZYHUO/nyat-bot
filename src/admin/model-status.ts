import type { Redis } from 'ioredis';

const HISTORY_KEY = 'xxb:model_status:history';

export interface ModelStatusSnapshot {
  ts: number;
  models: Record<
    string,
    {
      role: string;
      model: string;
      status: 'ok' | 'error' | 'timeout' | 'slow';
      latency_ms: number;
    }
  >;
}

export async function getModelStatusHistory(redis: Redis): Promise<ModelStatusSnapshot[]> {
  const raw = await redis.get(HISTORY_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ModelStatusSnapshot[];
  } catch {
    return [];
  }
}

export async function saveModelStatusSnapshot(
  redis: Redis,
  snapshot: ModelStatusSnapshot,
  maxSnapshots = 90,
): Promise<void> {
  const history = await getModelStatusHistory(redis);
  history.push(snapshot);
  if (history.length > maxSnapshots) {
    history.splice(0, history.length - maxSnapshots);
  }
  await redis.set(HISTORY_KEY, JSON.stringify(history));
}
