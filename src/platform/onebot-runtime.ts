import type { Env } from '../env.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { OneBotClient, OneBotClientError } from './onebot-client.js';
import type { OneBotGroupMetadata } from './onebot-client.js';
import { ingestOneBotMessage, parseOneBotIds } from './onebot-ingress.js';
import { clearOneBotSender, registerOneBotSender, sendPlatformText } from './outbound.js';
import { PlatformBoundaryError } from './types.js';
import { OneBotRequestService } from './onebot-requests.js';
import { getOrCreateConversationId } from './identity-store.js';
import { setOneBotMediaTransport } from './onebot-media.js';
import { ingestOneBotNotice } from './onebot-notices.js';
import { registerPlatformBotName } from './account-context.js';
import { startInboxRecovery } from '../ingress/durable.js';
import type { NormalizedMessage } from './types.js';

let client: OneBotClient | undefined;
let registeredAccount: string | undefined;
let acceptingMessages = false;
let drainingMessages = false;
let clearMedia: (() => void) | undefined;
let clearIdentity: (() => void) | undefined;
let stopRecovery: (() => Promise<void>) | undefined;
let recoveryDrain: Promise<void> | undefined;

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
  drainingMessages = false;
  const next = new OneBotClient({
    endpoint: config.ONEBOT_WS_URL, accessToken: config.ONEBOT_ACCESS_TOKEN,
    accountId: config.ONEBOT_ACCOUNT_ID,
    mediaEnabled: config.ONEBOT_MEDIA_ENABLED,
    groupFileSource: config.ONEBOT_GROUP_FILE_SOURCE,
    limits: {
      requestTimeoutMs: config.ONEBOT_ACTION_TIMEOUT_MS,
      heartbeatIntervalMs: config.ONEBOT_HEARTBEAT_INTERVAL_MS,
      reconnectBaseMs: config.ONEBOT_RECONNECT_DELAY_MS,
      reconnectMaxMs: Math.max(30000, config.ONEBOT_RECONNECT_DELAY_MS),
    },
    onMessage: async (message, context) => {
      if (acceptingMessages || drainingMessages) await ingestOneBotMessage(message, context, async (event, scope) => {
        const result = await requests.handleCommand(event, scope);
        if (result.reply && !scope.signal.aborted) {
          await sendPlatformText(getOrCreateConversationId(event.ref.conversation), result.reply);
        }
        return result.handled;
      });
    },
    onRequest: (request, context) => { if (acceptingMessages || drainingMessages) requests.record(request, context); },
    onNotice: async (notice, context) => { if (acceptingMessages || drainingMessages) await ingestOneBotNotice(notice, context); },
    onIdentity: identity => {
      clearIdentity?.();
      clearIdentity = registerPlatformBotName(identity.accountId, identity.displayName);
    },
    onState: state => logger.info({ ...state, acceptMessages }, 'OneBot connection state'),
    onDiagnostic: code => logger.warn({ code }, 'OneBot protocol event'),
  });
  const requests = new OneBotRequestService({ accountId: config.ONEBOT_ACCOUNT_ID, ownerId: config.ONEBOT_OWNER_ID,
    enabled: config.ONEBOT_ENABLED, activatedAtMs: config.META_ACTIVATED_AT_SEC * 1000, transport: next });
  if (acceptMessages) stopRecovery = startInboxRecovery('onebot', async entry => {
    await ingestOneBotMessage(entry.payload as NormalizedMessage, { signal: new AbortController().signal }, async (event, scope) => {
      const result = await requests.handleCommand(event, scope);
      if (result.reply && !scope.signal.aborted) await sendPlatformText(getOrCreateConversationId(event.ref.conversation), result.reply);
      return result.handled;
    });
  }, () => acceptingMessages && next.snapshot().state === 'ready');
  registerOneBotSender(next, config.ONEBOT_ACCOUNT_ID);
  if (config.ONEBOT_MEDIA_ENABLED) clearMedia = setOneBotMediaTransport(config.ONEBOT_ACCOUNT_ID, () => next.mediaTransport());
  registeredAccount = config.ONEBOT_ACCOUNT_ID;
  client = next;
  if (!acceptMessages) next.pauseIngress();
  // QQ connectivity must not stop Telegram. The authenticated monitor exposes
  // readiness separately; a disconnected sender fails without Telegram fallback.
  void next.start().catch(() => logger.error('OneBot initial connection failed; inspect OneBot status'));
}

export function stopOneBotRuntime(): void {
  pauseOneBotIngress();
  client?.stop();
  clearMedia?.();
  clearMedia = undefined;
  clearIdentity?.();
  clearIdentity = undefined;
  if (registeredAccount) clearOneBotSender(registeredAccount);
  client = undefined;
  registeredAccount = undefined;
}

/** Leave the sender connected until already running workers have drained. */
export function pauseOneBotIngress(): void {
  if (acceptingMessages) drainingMessages = true;
  acceptingMessages = false;
  client?.pauseIngress();
  if (stopRecovery) recoveryDrain = stopRecovery();
  stopRecovery = undefined;
}
export async function drainOneBotRecovery(): Promise<void> {
  pauseOneBotIngress();
  await Promise.all([recoveryDrain, client?.drainIngress()]);
  drainingMessages = false;
}

/** Host-only, read-only directory. A stopped/foreign account is unknown, never empty. */
export async function getOneBotGroupDirectory(accountId: string): Promise<OneBotGroupMetadata[]> {
  const current = client;
  if (!env().ONEBOT_ENABLED || !current || registeredAccount !== accountId
    || env().ONEBOT_ACCOUNT_ID !== accountId || current.snapshot().state !== 'ready') {
    throw new OneBotClientError('directory_unavailable');
  }
  const groups = await current.getGroupList({ accountId });
  if (client !== current || registeredAccount !== accountId || !env().ONEBOT_ENABLED
    || env().ONEBOT_ACCOUNT_ID !== accountId || current.snapshot().state !== 'ready') {
    throw new OneBotClientError('directory_unavailable');
  }
  return groups;
}

export function getOneBotRuntimeStatus() {
  return {
    enabled: env().ONEBOT_ENABLED,
    ...(client?.snapshot() ?? { state: 'stopped', pendingRequests: 0, queuedMessages: 0, handlingMessage: false, reconnectAttempts: 0, lastHeartbeatAt: null }),
    protocol: 'onebot-v11-forward-ws',
    supported: ['text', 'mention', 'reply', 'delete', 'reaction-send', 'friend-requests', 'group-requests', 'member-notices', 'recall',
      ...(env().ONEBOT_MEDIA_ENABLED ? ['image', 'voice', 'video', 'file', 'text-file'] : [])],
    unavailable: [...(env().ONEBOT_MEDIA_ENABLED ? [] : ['media-content']), 'poll', 'edit', 'moderation', 'forward', 'typing', 'telegram-sticker-id'],
    reactionFeedback: 'upstream-dependent-unverified',
    groupFileSource: env().ONEBOT_GROUP_FILE_SOURCE,
    cadence: { directQuietMs: env().META_DIRECT_COALESCE_MS, directMaxMs: env().META_DIRECT_COALESCE_MAX_MS,
      groupQuietMs: env().META_QQ_GROUP_COALESCE_MS, groupMaxMs: env().META_QQ_GROUP_COALESCE_MAX_MS,
      heartRefractoryMs: env().META_QQ_HEART_REFRACTORY_MS, mentionsUseHeart: env().META_QQ_MENTION_HEART_ENABLED },
  };
}
