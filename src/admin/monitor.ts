import { Hono } from 'hono';
import type { Redis } from 'ioredis';
import type { Bot } from 'grammy';
import type { Env } from '../env.js';
import { timingSafeEqual } from 'crypto';
import { listObligationSnapshots } from './obligations.js';
import { getRecent } from '../pipeline/context/manager.js';
import { getCognitiveRouteWindow } from '../agent/cognitive-route-observations.js';
import { listAgencyRunSummaries } from '../agent/agency-runtime.js';
import type { AgencyRunStatus } from '../agent/agency-runtime.js';
import { getTaskRecoverySummary } from '../agent/task-runtime-events.js';
import { listSkillRevisionVerificationSummaries } from '../core/skills/revisions.js';
import type { SkillRevisionStatus } from '../core/skills/revisions.js';

interface MonitorDeps {
  redis: Redis;
  bot: Bot;
  env: Env;
}

async function tryGetChat(bot: Bot, chatId: number): Promise<{ title?: string; username?: string } | null> {
  const idsToTry = chatId > 0 ? [Number(`-100${chatId}`), chatId] : [chatId];
  for (const id of idsToTry) {
    try { return await bot.api.getChat(id) as unknown as { title?: string; username?: string }; } catch { /* next */ }
  }
  return null;
}

// Title cache (avoid repeated getChat calls)
const _titleCache = new Map<number, { title: string; ts: number }>();
const TITLE_CACHE_TTL = 300_000; // 5 min

async function getCachedTitle(bot: Bot, chatId: number): Promise<string> {
  const cached = _titleCache.get(chatId);
  if (cached && Date.now() - cached.ts < TITLE_CACHE_TTL) return cached.title;
  const chat = await tryGetChat(bot, chatId);
  const title = chat?.title || (chat?.username ? `@${chat.username}` : `Chat ${chatId}`);
  _titleCache.set(chatId, { title, ts: Date.now() });
  return title;
}

async function listActiveChatIds(redis: Redis): Promise<number[]> {
  const ids = new Set<number>();
  // Groups still tracked on Redis; DMs may only exist in Redis ctx keys (legacy) or NyatDB.
  const members = await redis.zrange('xxb:active_groups', 0, -1);
  for (const m of members) {
    const n = Number(m);
    if (Number.isFinite(n)) ids.add(n);
  }
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'xxb:ctx:*', 'COUNT', 200);
    cursor = next;
    for (const key of batch) {
      const chatId = Number(key.replace('xxb:ctx:', ''));
      if (Number.isFinite(chatId)) ids.add(chatId);
    }
  } while (cursor !== '0');
  return [...ids];
}

export function createMonitorApi(deps: MonitorDeps): Hono {
  const api = new Hono();

  // Auth middleware
  api.use('*', async (c, next) => {
    const token = c.req.query('token') || '';
    if (!deps.env.MONITOR_TOKEN || !token) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    const a = Buffer.from(token);
    const b = Buffer.from(deps.env.MONITOR_TOKEN);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    await next();
  });

  // List all chats with last message preview
  api.get('/chats', async (c) => {
    const chatIds = await listActiveChatIds(deps.redis);

    const results = await Promise.all(chatIds.map(async (chatId) => {
      const [recent, title] = await Promise.all([
        getRecent(chatId, 1),
        getCachedTitle(deps.bot, chatId),
      ]);
      const lastMessage = recent[recent.length - 1] ?? null;
      return { chatId, title, lastMessage };
    }));

    const chats = results.filter((r) => r.lastMessage);
    chats.sort((a, b) => ((b.lastMessage as { timestamp?: number })?.timestamp ?? 0) - ((a.lastMessage as { timestamp?: number })?.timestamp ?? 0));
    return c.json({ ok: true, chats });
  });

  // Get messages for a chat
  api.get('/messages', async (c) => {
    const chatId = c.req.query('chat_id');
    const limit = Math.min(Number(c.req.query('limit') || 50), 200);
    if (!chatId) return c.json({ ok: false, error: 'missing chat_id' }, 400);
    const messages = await getRecent(Number(chatId), limit);
    return c.json({ ok: true, messages });
  });

  api.get('/obligations', async (c) => {
    const rawChatId = c.req.query('chat_id');
    const chatId = rawChatId ? Number(rawChatId) : undefined;
    if (rawChatId && !Number.isFinite(chatId)) {
      return c.json({ ok: false, error: 'invalid chat_id' }, 400);
    }
    const snapshots = await listObligationSnapshots(deps.redis, chatId);
    return c.json({ ok: true, snapshots });
  });

  // Read-only route cost/quality window for canary operations. The underlying
  // query is already bounded and returns aggregate metadata only.
  api.get('/route-observations', async (c) => {
    const rawChatId = c.req.query('chat_id');
    const rawSince = c.req.query('since');
    const rawLimit = c.req.query('limit');
    const filters: { chatId?: number; since?: number; limit?: number } = {};
    if (rawChatId !== undefined) {
      const chatId = Number(rawChatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) {
        return c.json({ ok: false, error: 'invalid chat_id' }, 400);
      }
      filters.chatId = chatId;
    }
    if (rawSince !== undefined) {
      const since = Number(rawSince);
      if (!Number.isSafeInteger(since) || since <= 0) {
        return c.json({ ok: false, error: 'invalid since' }, 400);
      }
      filters.since = since;
    }
    if (rawLimit !== undefined) {
      const limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        return c.json({ ok: false, error: 'invalid limit' }, 400);
      }
      filters.limit = Math.min(200, limit);
    }
    const rows = getCognitiveRouteWindow(filters);
    return c.json({ ok: true, rows });
  });

  // Redacted Agency lifecycle window. Content-bearing action arguments and
  // adapter results stay out of the monitor response.
  api.get('/agency-runs', async (c) => {
    const rawChatId = c.req.query('chat_id');
    const rawSince = c.req.query('since');
    const rawStatus = c.req.query('status');
    const rawLimit = c.req.query('limit');
    const filters: { chatId?: number; since?: number; status?: AgencyRunStatus; limit?: number } = {};
    if (rawChatId !== undefined) {
      const chatId = Number(rawChatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) return c.json({ ok: false, error: 'invalid chat_id' }, 400);
      filters.chatId = chatId;
    }
    if (rawSince !== undefined) {
      const since = Number(rawSince);
      if (!Number.isSafeInteger(since) || since <= 0) return c.json({ ok: false, error: 'invalid since' }, 400);
      filters.since = since;
    }
    if (rawStatus !== undefined) {
      if (!['pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'expired'].includes(rawStatus)) {
        return c.json({ ok: false, error: 'invalid status' }, 400);
      }
      filters.status = rawStatus as AgencyRunStatus;
    }
    if (rawLimit !== undefined) {
      const limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit <= 0) return c.json({ ok: false, error: 'invalid limit' }, 400);
      filters.limit = Math.min(200, limit);
    }
    const rows = listAgencyRunSummaries(filters);
    return c.json({ ok: true, rows });
  });

  // Read-only task recovery summary. Runtime events and acceptance evidence
  // are aggregated server-side; task direction and model/tool content stay out
  // of the response.
  api.get('/task-recovery', async (c) => {
    const taskId = c.req.query('task_id')?.trim() ?? '';
    const rawChatId = c.req.query('chat_id');
    if (!taskId || taskId.length > 120 || taskId.includes('\0')) {
      return c.json({ ok: false, error: 'invalid task_id' }, 400);
    }
    let chatId: number | undefined;
    if (rawChatId !== undefined) {
      const parsed = Number(rawChatId);
      if (!Number.isSafeInteger(parsed) || parsed === 0) return c.json({ ok: false, error: 'invalid chat_id' }, 400);
      chatId = parsed;
    }
    const summary = getTaskRecoverySummary(taskId, chatId);
    if (!summary) return c.json({ ok: false, error: 'task_recovery_not_found' }, 404);
    return c.json({ ok: true, summary });
  });

  // Bounded verification lineage for release/evaluation windows. The skill
  // artifact, check reasons and rollback text stay out of this monitor view.
  api.get('/skill-verifications', async (c) => {
    const rawStatus = c.req.query('status');
    const rawSince = c.req.query('since');
    const rawLimit = c.req.query('limit');
    const filters: { status?: SkillRevisionStatus; since?: number; limit?: number } = {};
    const statuses: SkillRevisionStatus[] = ['candidate', 'verified', 'approved', 'published', 'rejected', 'deprecated', 'rolled_back'];
    if (rawStatus !== undefined) {
      if (!statuses.includes(rawStatus as SkillRevisionStatus)) return c.json({ ok: false, error: 'invalid status' }, 400);
      filters.status = rawStatus as SkillRevisionStatus;
    }
    if (rawSince !== undefined) {
      const since = Number(rawSince);
      if (!Number.isSafeInteger(since) || since <= 0) return c.json({ ok: false, error: 'invalid since' }, 400);
      filters.since = since;
    }
    if (rawLimit !== undefined) {
      const limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit <= 0) return c.json({ ok: false, error: 'invalid limit' }, 400);
      filters.limit = Math.min(200, limit);
    }
    const rows = listSkillRevisionVerificationSummaries(filters);
    return c.json({ ok: true, rows });
  });

  // File proxy (server-side fetch, no token exposure)
  api.get('/file', async (c) => {
    const fileId = c.req.query('file_id');
    if (!fileId) return c.json({ ok: false }, 400);
    try {
      const file = await deps.bot.api.getFile(fileId);
      const url = `https://api.telegram.org/file/bot${deps.env.BOT_TOKEN}/${file.file_path}`;
      const resp = await fetch(url);
      if (!resp.ok) return c.json({ ok: false, error: 'file_not_found' }, 404);
      c.header('Content-Type', resp.headers.get('Content-Type') || 'application/octet-stream');
      return c.body(resp.body as ReadableStream);
    } catch {
      return c.json({ ok: false, error: 'file_not_found' }, 404);
    }
  });

  // Long poll for new messages (after = already-seen count in recent window)
  api.get('/poll', async (c) => {
    const chatId = c.req.query('chat_id');
    const after = Number(c.req.query('after') || 0);
    if (!chatId) return c.json({ ok: false, error: 'missing chat_id' }, 400);

    const id = Number(chatId);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const messages = await getRecent(id, 200);
      if (messages.length > after) {
        return c.json({ ok: true, messages: messages.slice(after), total: messages.length });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return c.json({ ok: true, messages: [], total: after });
  });

  return api;
}
