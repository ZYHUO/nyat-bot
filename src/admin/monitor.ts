import { Hono } from 'hono';
import type { Redis } from 'ioredis';
import type { Bot } from 'grammy';
import type { Env } from '../env.js';
import { timingSafeEqual } from 'crypto';
import { listObligationSnapshots } from './obligations.js';

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
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await deps.redis.scan(cursor, 'MATCH', 'xxb:ctx:*', 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');

    // Parallel: get last message + title for all chats
    const results = await Promise.all(keys.map(async (key) => {
      const chatId = Number(key.replace('xxb:ctx:', ''));
      if (isNaN(chatId)) return null;
      const [raw, title] = await Promise.all([
        deps.redis.lrange(key, -1, -1),
        getCachedTitle(deps.bot, chatId),
      ]);
      const lastMessage = raw[0] ? JSON.parse(raw[0]) : null;
      return { chatId, title, lastMessage };
    }));

    const chats = results.filter(Boolean) as Array<{ chatId: number; title: string; lastMessage: unknown }>;
    chats.sort((a, b) => ((b.lastMessage as { timestamp?: number })?.timestamp ?? 0) - ((a.lastMessage as { timestamp?: number })?.timestamp ?? 0));
    return c.json({ ok: true, chats });
  });

  // Get messages for a chat
  api.get('/messages', async (c) => {
    const chatId = c.req.query('chat_id');
    const limit = Math.min(Number(c.req.query('limit') || 50), 200);
    if (!chatId) return c.json({ ok: false, error: 'missing chat_id' }, 400);
    const raw = await deps.redis.lrange(`xxb:ctx:${chatId}`, -limit, -1);
    const messages = raw.map((r) => JSON.parse(r));
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

  // Long poll for new messages
  api.get('/poll', async (c) => {
    const chatId = c.req.query('chat_id');
    const after = Number(c.req.query('after') || 0);
    if (!chatId) return c.json({ ok: false, error: 'missing chat_id' }, 400);

    const key = `xxb:ctx:${chatId}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const len = await deps.redis.llen(key);
      if (len > after) {
        const raw = await deps.redis.lrange(key, after, -1);
        const messages = raw.map((r) => JSON.parse(r));
        return c.json({ ok: true, messages, total: len });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return c.json({ ok: true, messages: [], total: after });
  });

  return api;
}
