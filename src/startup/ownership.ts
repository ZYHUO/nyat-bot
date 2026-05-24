function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function isPrimaryInstance(source: NodeJS.ProcessEnv): boolean {
  const instanceId = source['NODE_APP_INSTANCE'] ?? source['PM2_INSTANCE_ID'] ?? source['pm_id'];
  return instanceId === undefined || instanceId === '0';
}

export interface StartupOwnership {
  worker: boolean;
  botIngress: boolean;
  http: boolean;
  cron: boolean;
}

export function getStartupOwnership(source: NodeJS.ProcessEnv = process.env): StartupOwnership {
  const primary = isPrimaryInstance(source);

  return {
    worker: parseBoolean(source['XXB_ENABLE_WORKER']) ?? primary,
    botIngress: parseBoolean(source['XXB_ENABLE_BOT_INGRESS']) ?? primary,
    http: parseBoolean(source['XXB_ENABLE_HTTP']) ?? primary,
    cron: parseBoolean(source['XXB_ENABLE_CRON']) ?? primary,
  };
}
