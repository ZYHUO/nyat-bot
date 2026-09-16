import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { Redis } from 'ioredis';
import type { Bot } from 'grammy';
import { logger } from '../shared/logger.js';
import { validateInitData, isMaster } from './auth.js';
import type { TelegramUser } from './auth.js';
import type { AllowlistConfig, GroupRecord, PendingRequest } from '../allowlist/types.js';
import * as allowlist from '../allowlist/allowlist.js';
import * as aiReview from '../allowlist/ai-review.js';
import * as notify from '../allowlist/notify.js';
import * as runtimeConfig from './runtime-config.js';
import * as modelStatus from './model-status.js';
import * as botPermission from './bot-permission.js';
import { checkHealth } from './health.js';
import type { Env } from '../env.js';
import * as stickerStore from '../knowledge/sticker/store.js';
import * as verifyStore from '../verification/store.js';
import { getDb } from '../db/sqlite.js';

type AdminGroupRecord = GroupRecord & {
  chat_username?: string;
  verify_enabled?: boolean;
};

function hasTitle(chat: unknown): chat is { title?: string; username?: string } {
  return typeof chat === 'object' && chat !== null && 'title' in chat;
}

async function tryGetChat(bot: Bot, chatId: number): Promise<unknown> {
  const idsToTry = chatId > 0 ? [Number(`-100${chatId}`), chatId] : [chatId];
  for (const id of idsToTry) {
    try { return await bot.api.getChat(id); } catch { /* try next */ }
  }
  return null;
}

interface ApiDeps {
  redis: Redis;
  bot: Bot;
  config: AllowlistConfig;
  env: Env;
  aiCall: (systemPrompt: string, userMessage: string) => Promise<string | null>;
  getRecentContext?: (chatId: number, limit: number, maxChars: number) => Promise<string>;
}

// ── Handler functions ──────────────────────────────────────────────

async function handleBootstrap(
  deps: ApiDeps,
  user: TelegramUser,
  master: boolean,
): Promise<Record<string, unknown>> {
  // Non-master users only see their own submissions
  if (!master) {
    const myData = await allowlist.listByUser(deps.redis, deps.config, user.id);
    return {
      ok: true,
      is_master: false,
      managed_enabled: deps.config.enabled,
      user: { id: user.id, first_name: user.first_name, username: user.username },
      ...myData,
    };
  }

  const pending = await allowlist.listPending(deps.redis, deps.config);
  const groups = await allowlist.listGroups(deps.redis, deps.config);
  const manualQueue = await allowlist.listManualQueue(deps.redis, deps.config);

  // Hydrate chat titles (bootstrap). Both record types share `chat_id`; the
  // mutated extras (`title` / `chat_title` / `chat_username`) are tracked on
  // the intersection so the loop is type-safe in place.
  type Hydratable = (PendingRequest | GroupRecord) & {
    title?: string;
    chat_title?: string;
    chat_username?: string;
  };
  for (const item of [...pending, ...groups] as Hydratable[]) {
    const cid = item.chat_id;
    if (!cid) continue;
    const idsToTry = cid > 0 ? [Number(`-100${cid}`), cid] : [cid];
    for (const tryId of idsToTry) {
      try {
        const chat = await deps.bot.api.getChat(tryId);
        if ('title' in chat && chat.title) { item.title = chat.title; item.chat_title = chat.title; }
        if ('username' in chat && chat.username) { item.chat_username = `@${chat.username}`; }
        break;
      } catch { /* best-effort */ }
    }
  }
  const override = await runtimeConfig.loadOverride(deps.redis);

  // Hydrate verify settings for groups
  const db = getDb();
  for (const group of groups as AdminGroupRecord[]) {
    const settings = verifyStore.getVerifySettings(db, group.chat_id);
    group.verify_enabled = settings?.enabled ?? false;
  }

  const modelRouting = runtimeConfig.buildModelRoutingAdminView();

  const stickerPolicy = runtimeConfig.buildStickerPolicyAdminView(override);

  return {
    ok: true,
    pending,
    groups,
    manual_queue: manualQueue,
    model_routing: modelRouting,
    sticker_policy: stickerPolicy,
    managed_enabled: deps.config.enabled,
    verify_enabled: deps.env.VERIFY_ENABLED,
    is_master: master,
    user: { id: user.id, first_name: user.first_name, username: user.username },
  };
}

// 2026-08-20 起申请入口搬到 bot 对话（私聊 bot 报群 ID/@username，AI 自动审核）。
// miniapp submit 路由保留但只回迁移提示——旧前端用户能看到引导而不是莫名 404。
function handleSubmitMovedToBot(): Record<string, unknown> {
  return {
    ok: false,
    error: 'moved_to_bot',
    message: '白名单申请已搬家：直接私聊 bot，把群 ID 或 @群username 发给 ta 就能申请，bot 会自动审核。',
  };
}

async function handleMySubmissions(
  deps: ApiDeps,
  user: TelegramUser,
): Promise<Record<string, unknown>> {
  const result = await allowlist.listByUser(deps.redis, deps.config, user.id);
  return { ok: true, ...result };
}

async function handleCheckBotPermissions(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id);
  if (!chatId || isNaN(chatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const perms = await botPermission.getBotPermissions(deps.bot, chatId);
  if (!perms) {
    return { ok: false, error: 'failed_to_fetch' };
  }
  return { ok: true, permissions: perms };
}

async function handleList(deps: ApiDeps): Promise<Record<string, unknown>> {
  const pending = await allowlist.listPending(deps.redis, deps.config);
  const groups = await allowlist.listGroups(deps.redis, deps.config);
  const manualQueue = await allowlist.listManualQueue(deps.redis, deps.config);

  // Hydrate chat titles
  for (const group of groups as AdminGroupRecord[]) {
    if (group.chat_id) {
      const chat = await tryGetChat(deps.bot, group.chat_id);
      if (hasTitle(chat)) {
        group.title = chat.title ?? `Chat ${group.chat_id}`;
        if ('username' in chat && chat.username) {
          group.chat_username = `@${chat.username}`;
        }
      }
    }
  }

  return { ok: true, pending, groups, manual_queue: manualQueue };
}

async function handleApprove(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = String(body.request_id ?? '');
  const enableNow = body.enable_now != null ? Boolean(body.enable_now) : undefined;
  if (!requestId) {
    return { ok: false, error: 'invalid_request_id' };
  }

  const result = await allowlist.approveRequest(
    deps.redis, deps.config, requestId, 'admin', enableNow,
  );
  if (result.ok && result.chat_id) {
    void notify
      .afterApproved(deps.bot, result.chat_id, result.enabled ?? false)
      .catch((err: unknown) =>
        logger.warn({ err, chatId: result.chat_id }, 'Approve notification failed'),
      );
  }
  return result;
}

async function handleReject(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = String(body.request_id ?? '');
  if (!requestId) {
    return { ok: false, error: 'invalid_request_id' };
  }

  const ok = await allowlist.rejectRequest(deps.redis, deps.config, requestId);
  return { ok };
}

async function handleAiReview(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = String(body.request_id ?? '');
  if (!requestId) {
    return { ok: false, error: 'invalid_request_id' };
  }

  const result = await aiReview.runAiReview(deps.redis, deps.config, requestId, {
    aiCall: deps.aiCall,
    getRecentContext: deps.getRecentContext,
    getChat: async (cid: number) => {
      return tryGetChat(deps.bot, cid);
    },
  });
  return result;
}

async function handleSetEnabled(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id);
  const enabled = Boolean(body.enabled);
  if (!chatId || isNaN(chatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const ok = await allowlist.setGroupEnabled(deps.redis, deps.config, chatId, enabled);
  if (ok) {
    void notify
      .afterToggleEnabled(deps.bot, chatId, enabled)
      .catch((err: unknown) => logger.warn({ err, chatId }, 'Toggle notification failed'));
  }
  return { ok };
}

async function handleRemoveGroup(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id);
  if (!chatId || isNaN(chatId)) {
    return { ok: false, error: 'invalid_chat_id' };
  }

  const ok = await allowlist.removeGroup(deps.redis, deps.config, chatId);
  return { ok };
}

async function handleModelRoutingGet(): Promise<Record<string, unknown>> {
  const view = runtimeConfig.buildModelRoutingAdminView();
  return { ok: true, ...view };
}

async function handleProviderValidate(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const provider = body.provider as runtimeConfig.ProviderValidateInput | undefined;
  if (!provider?.endpoint || !provider?.model) {
    return { ok: false, error: 'invalid_provider_params' };
  }

  const result = await runtimeConfig.validateProvider(provider);
  return { ...result };
}

async function handleStickerPolicyGet(deps: ApiDeps): Promise<Record<string, unknown>> {
  const override = await runtimeConfig.loadOverride(deps.redis);
  return {
    ok: true,
    ...runtimeConfig.buildStickerPolicyAdminView(override),
  };
}

async function handleStickerPolicySave(
  deps: ApiDeps,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const override = (await runtimeConfig.loadOverride(deps.redis)) ?? {};
  override.sticker_policy = body.sticker_policy as typeof override.sticker_policy;
  await runtimeConfig.saveOverride(deps.redis, override);
  logger.info('Sticker policy override saved via admin');
  return { ok: true };
}

async function handleStickerKbList(): Promise<Record<string, unknown>> {
  const raw = stickerStore.listStickerKbIndex();
  const items: Array<Record<string, unknown>> = [];
  for (const row of raw) {
    const item: Record<string, unknown> = {
      file_unique_id: row.file_unique_id,
      latest_file_id: row.latest_file_id,
      set_name: row.set_name,
      emoji: row.emoji,
      sticker_format: row.sticker_format,
      usage_count: row.usage_count,
      analysis_status: row.analysis_status,
      asset_status: row.asset_status,
    };
    if (row.analysis_status === 'ready') {
      const full = stickerStore.getItem(row.file_unique_id);
      item['persona_fit'] = full?.personaFit ?? null;
      item['emotion_tags'] = full?.emotionTags ?? [];
      item['mood_map'] = full?.moodMap ?? {};
    } else {
      item['persona_fit'] = null;
      item['emotion_tags'] = [];
      item['mood_map'] = {};
    }
    items.push(item);
  }
  return { ok: true, items };
}

async function handleStickerKbUpdate(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fuid = typeof body['file_unique_id'] === 'string' ? body['file_unique_id'].trim() : '';
  if (
    fuid === '' ||
    fuid.length > 100 ||
    !/^[a-zA-Z0-9_-]+$/.test(fuid)
  ) {
    return { ok: false, error: 'missing_file_unique_id' };
  }

  if (!stickerStore.getItem(fuid)) {
    return { ok: false, error: 'sticker_not_found' };
  }

  if (body['requeue']) {
    const ok = stickerStore.requeueStickerAnalysis(fuid);
    if (!ok) {
      return { ok: false, error: 'sticker_not_found' };
    }
    return { ok: true, action: 'requeued' };
  }

  if (Object.prototype.hasOwnProperty.call(body, 'persona_fit')) {
    const raw = body['persona_fit'];
    const newFit = raw === null ? null : Boolean(raw);
    const ok = stickerStore.setStickerPersonaFit(fuid, newFit);
    if (!ok) {
      return { ok: false, error: 'sticker_not_found' };
    }
    return { ok: true, action: 'persona_fit_updated', persona_fit: newFit };
  }

  return { ok: false, error: 'no_action_specified' };
}

// ── Verify handlers ──────────────────────────────────────────────

async function handleVerifyGetSettings(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id ?? 0);
  if (!chatId) return { ok: false, error: 'missing_chat_id' };

  const db = getDb();
  const settings = verifyStore.getVerifySettings(db, chatId);
  return {
    ok: true,
    settings: settings ?? {
      chat_id: chatId,
      enabled: false,
      timeout_seconds: 300,
      max_attempts: 3,
      kick_on_fail: false,
    },
  };
}

async function handleVerifySetEnabled(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id ?? 0);
  const enabled = Boolean(body.enabled);
  if (!chatId) return { ok: false, error: 'missing_chat_id' };

  const db = getDb();
  verifyStore.setVerifyEnabled(db, chatId, enabled);
  return { ok: true };
}

async function handleVerifySetConfig(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id ?? 0);
  if (!chatId) return { ok: false, error: 'missing_chat_id' };

  const config: Record<string, unknown> = {};
  if (body.timeout_seconds !== undefined) config.timeout_seconds = Number(body.timeout_seconds);
  if (body.max_attempts !== undefined) config.max_attempts = Number(body.max_attempts);
  if (body.kick_on_fail !== undefined) config.kick_on_fail = Boolean(body.kick_on_fail);

  const db = getDb();
  verifyStore.setVerifyConfig(db, chatId, config as Parameters<typeof verifyStore.setVerifyConfig>[2]);
  return { ok: true };
}

async function handleVerifyStats(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const chatId = Number(body.chat_id ?? 0);
  if (!chatId) return { ok: false, error: 'missing_chat_id' };

  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600; // last 7 days
  const stats = verifyStore.getRecentStats(db, chatId, since);
  return { ok: true, stats };
}

// ── Create Hono API ────────────────────────────────────────────────

export function createAdminApi(deps: ApiDeps): Hono {
  const api = new Hono();

  // CORS
  api.use(
    '*',
    cors({
      origin: deps.env.ADMIN_CORS_ORIGINS.length > 0 ? deps.env.ADMIN_CORS_ORIGINS : '*',
      allowMethods: ['GET', 'POST'],
    }),
  );

  // Public endpoints
  api.get('/health', async (c) => {
    const health = await checkHealth(deps.redis);
    return c.json(health);
  });

  // Sticker preview PNG (master-only). Used by miniapp StickerKbPanel.
  // Cached aggressively because preview content is immutable per file_unique_id.
  api.get('/sticker_preview/:fuid', async (c) => {
    const initData = c.req.query('init_data');
    if (!initData) {
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }
    const user = validateInitData(initData, deps.env.BOT_TOKEN);
    if (!user || !isMaster(user.id, deps.env.MASTER_UID)) {
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }
    const fuid = c.req.param('fuid');
    if (!/^[a-zA-Z0-9_-]+$/.test(fuid) || fuid.length > 100) {
      return c.json({ ok: false, error: 'invalid_fuid' }, 400);
    }
    // Resolution order:
    //   1. Preview PNG generated for video_webm / animated_tgs
    //   2. Original static_webp (browser-native, no conversion needed)
    // Both directories are validated to be inside data/sticker_assets/.
    const previewDir = resolvePath(process.cwd(), 'data/sticker_assets/preview');
    const rawDir = resolvePath(process.cwd(), 'data/sticker_assets/raw');
    const previewPng = resolvePath(previewDir, `${fuid}.png`);
    const rawWebp = resolvePath(rawDir, fuid, 'original.webp');
    if (!previewPng.startsWith(previewDir) || !rawWebp.startsWith(rawDir)) {
      return c.json({ ok: false, error: 'invalid_path' }, 400);
    }
    // Try PNG first
    try {
      const buf = await readFile(previewPng);
      return c.body(buf, 200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=86400',
      });
    } catch { /* fall through to webp */ }
    try {
      const buf = await readFile(rawWebp);
      return c.body(buf, 200, {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, max-age=86400',
      });
    } catch {
      return c.json({ ok: false, error: 'not_found' }, 404);
    }
  });

  api.get('/model_status', async (c) => {
    // Require master auth via query param
    const initData = c.req.query('init_data');
    if (!initData) {
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }
    const user = validateInitData(initData, deps.env.BOT_TOKEN);
    if (!user || !isMaster(user.id, deps.env.MASTER_UID)) {
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }
    const history = await modelStatus.getModelStatusHistory(deps.redis);
    return c.json({ ok: true, history });
  });

  // Main dispatch endpoint (PHP compatibility)
  api.post('/', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const initData = body.init_data as string;
    const action = body.action as string;

    if (!initData || !action) {
      return c.json({ ok: false, error: 'missing_params' }, 400);
    }

    // Validate initData
    const user = validateInitData(initData, deps.env.BOT_TOKEN);
    if (!user) {
      return c.json({ ok: false, error: 'invalid_init_data' }, 401);
    }

    const master = isMaster(user.id, deps.env.MASTER_UID);

    // Route by action
    try {
      switch (action) {
        case 'bootstrap':
          return c.json(await handleBootstrap(deps, user, master));
        // User-accessible actions (any authenticated user):
        case 'submit':
          return c.json(handleSubmitMovedToBot());
        case 'my_submissions':
          return c.json(await handleMySubmissions(deps, user));
        case 'check_bot_permissions':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleCheckBotPermissions(deps, body));
        case 'list':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleList(deps));
        case 'approve':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleApprove(deps, body));
        case 'reject':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleReject(deps, body));
        case 'ai_review':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleAiReview(deps, body));
        case 'set_enabled':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleSetEnabled(deps, body));
        case 'remove_group':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleRemoveGroup(deps, body));
        case 'model_routing_get':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleModelRoutingGet());
        case 'provider_validate':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleProviderValidate(body));
        case 'sticker_policy_get':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleStickerPolicyGet(deps));
        case 'sticker_policy_save':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleStickerPolicySave(deps, body));
        case 'sticker_kb_list':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleStickerKbList());
        case 'sticker_kb_update': {
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          const skRes = await handleStickerKbUpdate(body);
          if (!skRes.ok) {
            const err = String(skRes['error'] ?? '');
            if (err === 'sticker_not_found') return c.json(skRes, 404);
            if (err === 'missing_file_unique_id' || err === 'no_action_specified') {
              return c.json(skRes, 400);
            }
          }
          return c.json(skRes);
        }
        case 'verify_get_settings':
          // 与同组 verify_set_* 对齐:handler 内部只校验 chat_id 非零,而 chat_id 完全由
          // 请求体决定且可枚举 —— 缺这道闸时任意已认证用户可读任意群的验证配置/统计。
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleVerifyGetSettings(body));
        case 'verify_set_enabled':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleVerifySetEnabled(body));
        case 'verify_set_config':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleVerifySetConfig(body));
        case 'verify_stats':
          if (!master) return c.json({ ok: false, error: 'forbidden' }, 403);
          return c.json(await handleVerifyStats(body));
        default:
          return c.json({ ok: false, error: 'unknown_action' }, 400);
      }
    } catch (err) {
      logger.error({ err, action }, 'Admin API error');
      return c.json({ ok: false, error: 'internal_error' }, 500);
    }
  });

  return api;
}
