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

/** Configuration ownership is not a distributed lease or a claim of HA. */
export function ownsMetaLoop(ownership: StartupOwnership): boolean {
  return ownership.worker || (ownership.cron && !ownership.botIngress);
}

/** Reject a receiver configuration that can register a URL but never serve it. */
export function assertIngressHttpOwnership(
  ownership: StartupOwnership,
  webhook: { WEBHOOK_URL?: string; WEBHOOK_SECRET?: string },
): void {
  if (ownership.botIngress && !ownership.http && webhook.WEBHOOK_URL && webhook.WEBHOOK_SECRET) {
    throw new Error('Webhook ingress requires XXB_ENABLE_HTTP=true on the bot-ingress process');
  }
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
