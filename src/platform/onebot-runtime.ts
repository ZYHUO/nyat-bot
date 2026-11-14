import type { Env } from '../env.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { OneBotClient } from './onebot-client.js';
import { ingestOneBotMessage, parseOneBotIds } from './onebot-ingress.js';
import { clearOneBotSender, registerOneBotSender } from './outbound.js';
import { PlatformBoundaryError } from './types.js';

let client: OneBotClient | undefined;
let registeredAccount: string | undefined;
let acceptingMessages = false;

export function validateOneBotConfig(config: Env): void {
  if (!config.ONEBOT_ENABLED) return;
  for (const value of [config.ONEBOT_ACCOUNT_ID, config.ONEBOT_OWNER_ID]) {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new PlatformBoundaryError('onebot_identity_required', 'Configure separate QQ bot and owner identities');
    }
  }
  if (config.ONEBOT_ACCOUNT_ID === config.ONEBOT_OWNER_ID) throw new PlatformBoundaryError('onebot_owner_is_bot', 'QQ owner must be a human account');
  if (!config.ONEBOT_ACCESS_TOKEN || /[^\x21-\x7e]/.test(config.ONEBOT_ACCESS_TOKEN)) {
    throw new PlatformBoundaryError('onebot_token_required', 'Configure the OneBot access token');
  }
  let endpoint: URL;
  try { endpoint = new URL(config.ONEBOT_WS_URL); } catch {
    throw new PlatformBoundaryError('onebot_endpoint_invalid', 'Invalid OneBot endpoint');
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new PlatformBoundaryError('onebot_endpoint_invalid', 'Use the combined OneBot v11 forward WebSocket root endpoint');
  }
  if (endpoint.protocol === 'ws:' && !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) {
    throw new PlatformBoundaryError('onebot_transport_insecure', 'Remote OneBot requires WSS or a loopback SSH tunnel');
  }
  parseOneBotIds(config.ONEBOT_ALLOWED_GROUP_IDS);
  parseOneBotIds(config.ONEBOT_ALLOWED_USER_IDS);
}

/** Each worker needs a sender; only the ingress owner consumes incoming events. */
export function startOneBotRuntime(acceptMessages: boolean): void {
  const config = env();
  if (!config.ONEBOT_ENABLED || client) return;
  validateOneBotConfig(config);
  acceptingMessages = acceptMessages;
  const next = new OneBotClient({
    endpoint: config.ONEBOT_WS_URL, accessToken: config.ONEBOT_ACCESS_TOKEN,
    accountId: config.ONEBOT_ACCOUNT_ID,
    limits: {
      requestTimeoutMs: config.ONEBOT_ACTION_TIMEOUT_MS,
      heartbeatIntervalMs: config.ONEBOT_HEARTBEAT_INTERVAL_MS,
      reconnectBaseMs: config.ONEBOT_RECONNECT_DELAY_MS,
      reconnectMaxMs: Math.max(30000, config.ONEBOT_RECONNECT_DELAY_MS),
    },
    onMessage: async (message, context) => { if (acceptingMessages) await ingestOneBotMessage(message, context); },
    onState: state => logger.info({ ...state, acceptMessages }, 'OneBot connection state'),
    onDiagnostic: code => logger.warn({ code }, 'OneBot protocol event'),
  });
  registerOneBotSender(next, config.ONEBOT_ACCOUNT_ID);
  registeredAccount = config.ONEBOT_ACCOUNT_ID;
  client = next;
  // QQ connectivity must not stop Telegram. The authenticated monitor exposes
  // readiness separately; a disconnected sender fails without Telegram fallback.
  void next.start().catch(() => logger.error('OneBot initial connection failed; inspect OneBot status'));
}

export function stopOneBotRuntime(): void {
  pauseOneBotIngress();
  client?.stop();
  if (registeredAccount) clearOneBotSender(registeredAccount);
  client = undefined;
  registeredAccount = undefined;
}

/** Leave the sender connected until already running workers have drained. */
export function pauseOneBotIngress(): void {
  acceptingMessages = false;
}

export function getOneBotRuntimeStatus() {
  return {
    enabled: env().ONEBOT_ENABLED,
    ...(client?.snapshot() ?? { state: 'stopped', pendingRequests: 0, queuedMessages: 0, handlingMessage: false, reconnectAttempts: 0, lastHeartbeatAt: null }),
    protocol: 'onebot-v11-forward-ws',
    supported: ['text', 'mention', 'reply', 'delete'],
    unavailable: ['media-content', 'reaction', 'poll', 'moderation', 'forward', 'typing'],
  };
}
