import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { sendMessage, sendSticker, reactToMessage, sendChatAction } from '../bot/sender/telegram.js';
import { searchMemory, searchMemoryByUser } from '../memory/chroma.js';
import { getReadyStickersByIntent } from '../knowledge/sticker/store.js';
import { getPersonIdentity, buildCrossGroupInjection } from '../tracking/person-identity.js';
import { isDM } from '../shared/chat.js';
import { isEchoOf } from '../shared/echo-text.js';
import { markMessageAnswered } from '../meta/answered.js';

/** Cross-task memory of recent bot lines in this process (beats Redis/NyatDB lag). */
const recentBotTextsByChat = new Map<number, string[]>();

function rememberBotText(chatId: number, text: string): void {
  const arr = recentBotTextsByChat.get(chatId) ?? [];
  arr.push(text);
  while (arr.length > 6) arr.shift();
  recentBotTextsByChat.set(chatId, arr);
}

function isRecentBotEcho(chatId: number, text: string): string | undefined {
  for (const prior of recentBotTextsByChat.get(chatId) ?? []) {
    if (isEchoOf(text, prior)) return prior;
  }
  return undefined;
}

/** Same wording just sent in another chat (group→DM 串台复读). */
function isCrossChatBotEcho(
  chatId: number,
  text: string,
): { otherChatId: number; prior: string } | undefined {
  for (const [cid, arr] of recentBotTextsByChat) {
    if (cid === chatId) continue;
    for (const prior of arr) {
      if (isEchoOf(text, prior)) return { otherChatId: cid, prior };
    }
  }
  return undefined;
}

export interface HostApi {
  telegram: {
    sendText: (text: string, replyToMessageId?: number) => Promise<{ messageId: number }>;
    sendSticker: (fileId: string) => Promise<{ messageId: number }>;
    react: (messageId: number, emoji: string) => Promise<boolean>;
  };
  memory: {
    search: (query: string) => Promise<string>;
    recallPerson: (uid: number, query: string) => Promise<string>;
    recentContext: (limit?: number) => Promise<string>;
  };
  stickers: {
    pick: (mood?: string) => Promise<string | null>;
  };
  web: {
    /** Live web search (Gemini / xAI / Searx / DDG). */
    search: (query: string) => Promise<string>;
  };
  meta: {
    /**
     * Ask Meta to do something Subagent cannot (journal.*, orchestration).
     * Queues Attention for the next Meta tick; does not block for a result.
     */
    request: (args: { action: string; detail?: string }) => Promise<{ queued: boolean; action: string }>;
  };
  runtime: {
    endTask: (summary: string) => void;
    didSendText: () => boolean;
    /** Await ctx/timing writes so Meta callback sees the reply. */
    flushBookkeeping: () => Promise<void>;
  };
}

export function createHostApi(
  chatId: number,
  opts: {
    onEnd: (summary: string) => void;
    defaultReplyTo?: number;
    /** Burst siblings — mark answered only after successful sendText. */
    relatedQuoteIds?: number[];
    isClosed?: () => boolean;
    taskId?: string;
  },
): HostApi {
  const banned = env().CODEACT_BANNED_WORDS;
  let ended = false;
  let defaultQuoteUsed = false;
  let textSent = 0;
  let lastSentNorm = '';
  let metaRequested = false;
  const maxTextSends = 2;
  const pendingBookkeeping: Promise<unknown>[] = [];
  /** In-flight telegram/web ops — models often forget `await` before endTask. */
  const inflightOps = new Set<Promise<unknown>>();

  const assertOpen = () => {
    if (opts.isClosed?.()) throw new Error('host_closed');
  };

  const trackInflight = <T>(p: Promise<T>): Promise<T> => {
    inflightOps.add(p);
    // Attach handler so reject-before-await (tests / fire-and-forget) isn't "unhandled"
    void p.finally(() => inflightOps.delete(p)).catch(() => undefined);
    return p;
  };

  const assertNotBanned = (text: string) => {
    const hit = banned.find((w) => w && text.includes(w));
    if (hit) throw new Error(`banned_word:${hit}`);
  };

  const parseMsgId = (raw?: number): number | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const n = typeof raw === 'string' ? Number(raw) : Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return undefined;
  };

  const resolveReplyTo = (replyToMessageId?: number): number | undefined => {
    const explicit = parseMsgId(replyToMessageId);
    const fallback = parseMsgId(opts.defaultReplyTo);

    // Task quote exists: never accept a different #id (DM used to trust model and
    // pasted a *group* messageId → 私聊回「冒充号」对着群 #392467).
    if (fallback) {
      if (explicit && explicit !== fallback) {
        logger.warn(
          { chatId, fromModel: explicit, forced: fallback, dm: isDM(chatId) },
          'host sendText: reject model replyTo ≠ task quote',
        );
        throw new Error(
          `reply_to_mismatch: model used #${explicit} but task quote is #${fallback}. ` +
            `Omit replyTo or pass only ${fallback}, then retry sendText (do not reuse wrong bubble text).`,
        );
      }
      // DM: still never *force* quote (omit → plain bubble). Group: fill quote.
      if (isDM(chatId)) return explicit;
      if (!defaultQuoteUsed) {
        defaultQuoteUsed = true;
        return fallback;
      }
      return undefined;
    }

    // No task quote — DM/group: explicit only as last resort
    if (explicit && !isDM(chatId)) {
      logger.warn({ chatId, fromModel: explicit }, 'host sendText: group send with no task quote');
    }
    return explicit;
  };

  const track = (p: Promise<unknown>) => {
    pendingBookkeeping.push(p);
    return p;
  };

  return {
    telegram: {
      sendText(text: string, replyToMessageId?: number) {
        assertOpen();
        return trackInflight(
          (async () => {
            if (textSent >= maxTextSends) {
              throw new Error(`sendText_limit:${maxTextSends}`);
            }
            const clean = String(text ?? '').trim();
            if (!clean) throw new Error('empty text');
            assertNotBanned(clean);

            // Reject parroting the user's latest line(s) — common when direction embeds user text.
            // Also reject copying the bot's own recent lines (跨任务复读「小鱼干」回怼到「病好了」).
            const localHit = isRecentBotEcho(chatId, clean);
            if (localHit) {
              logger.info(
                { chatId, preview: clean.slice(0, 60), prior: localHit.slice(0, 60) },
                'host sendText rejected self-echo (local)',
              );
              throw new Error('echo_self_text');
            }
            const crossHit = isCrossChatBotEcho(chatId, clean);
            if (crossHit) {
              logger.info(
                {
                  chatId,
                  otherChatId: crossHit.otherChatId,
                  preview: clean.slice(0, 60),
                  prior: crossHit.prior.slice(0, 60),
                },
                'host sendText rejected self-echo (cross-chat)',
              );
              throw new Error('echo_self_text');
            }
            try {
              const { getRecent } = await import('../pipeline/context/manager.js');
              // Wide window: dual-write holes + busy groups push prior bot lines out of 16.
              const recent = await getRecent(chatId, 80);
              const userLines = recent
                .filter((m) => m.role !== 'assistant')
                .slice(-4)
                .map((m) => String(m.textContent ?? '').trim())
                .filter(Boolean);
              if (userLines.some((u) => isEchoOf(clean, u))) {
                logger.info({ chatId, preview: clean.slice(0, 60) }, 'host sendText rejected echo');
                throw new Error('echo_user_text');
              }
              const botLines = recent
                .filter((m) => m.role === 'assistant')
                .slice(-12)
                .map((m) => String(m.textContent ?? '').trim())
                .filter((t) => t.replace(/\s+/g, '').length >= 6);
              const hitSelf = botLines.find((b) => isEchoOf(clean, b));
              if (hitSelf) {
                logger.info(
                  { chatId, preview: clean.slice(0, 60), prior: hitSelf.slice(0, 60) },
                  'host sendText rejected self-echo',
                );
                throw new Error('echo_self_text');
              }
              try {
                const { checkNearDuplicate } = await import('../pipeline/reply/anti-repeat.js');
                const dup = await checkNearDuplicate(chatId, clean);
                if (dup.isNearDuplicate) {
                  logger.info(
                    {
                      chatId,
                      preview: clean.slice(0, 60),
                      ratio: dup.ratio,
                      prior: dup.collidedWith?.slice(0, 60),
                    },
                    'host sendText rejected near-dup self',
                  );
                  throw new Error('echo_self_text');
                }
              } catch (err) {
                if (err instanceof Error && err.message === 'echo_self_text') throw err;
              }
            } catch (err) {
              if (
                err instanceof Error &&
                (err.message === 'echo_user_text' || err.message === 'echo_self_text')
              ) {
                throw err;
              }
              /* context optional */
            }

            // 同一任务里连发两条几乎一样的（「催什么催」+「催什么催嘛喵」）——拒第二条
            if (lastSentNorm && isEchoOf(clean, lastSentNorm)) {
              logger.info({ chatId, preview: clean.slice(0, 60) }, 'host sendText rejected near-dup');
              throw new Error('near_dup_reply');
            }

            // MaiBot-style split (same segmenter as legacy reply). One sendText may
            // become multiple bubbles; only the first carries reply-to.
            const maxLen = chatId > 0 ? 280 : 160;
            const splitThreshold = 60;
            let parts: string[] = [clean];
            if (clean.length > splitThreshold) {
              try {
                const { segmentReply } = await import('../pipeline/reply/segmenter.js');
                const { segments } = segmentReply(clean);
                if (segments.length > 1) {
                  parts = segments.map((s) => s.trim()).filter(Boolean);
                  logger.info({ chatId, n: parts.length, chars: clean.length }, 'host sendText segmented');
                }
              } catch (err) {
                logger.debug({ err, chatId }, 'host segmentReply failed — single bubble');
              }
            }
            if (parts.length === 1 && clean.length > maxLen) {
              const { softTruncate } = await import('../shared/soft-truncate.js');
              const next = softTruncate(clean, maxLen);
              logger.info({ chatId, from: clean.length, to: next.length }, 'host sendText truncated');
              parts = [next || clean.slice(0, maxLen)];
            } else if (parts.length > 1) {
              const { softTruncate } = await import('../shared/soft-truncate.js');
              parts = parts.map((p) => (p.length > maxLen ? softTruncate(p, maxLen) || p.slice(0, maxLen) : p));
            }

            // Past gate: finish even if task closes (model often skips await before endTask).
            let lastMessageId = 0;
            let firstReplyTo: number | undefined;
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i]!;
              if (i > 0) {
                try {
                  const { calculateTypingDelay } = await import('../pipeline/reply/segmenter.js');
                  const sec = Math.min(1.2, calculateTypingDelay(part));
                  if (sec >= 0.05) {
                    await new Promise((r) => setTimeout(r, Math.round(sec * 1000)));
                  }
                } catch {
                  await new Promise((r) => setTimeout(r, 300));
                }
              }
              await sendChatAction(chatId, 'typing');
              // Group: first bubble quotes task; later bubbles plain (legacy firstMessageQuoteReply).
              // DM: model chooses — only first bubble may carry explicit replyTo.
              const replyTo = i === 0 ? resolveReplyTo(replyToMessageId) : undefined;
              if (i === 0) firstReplyTo = replyTo;
              if (i === 0 && chatId < 0 && !replyTo && !opts.defaultReplyTo) {
                logger.warn({ chatId }, 'host sendText: group send without reply_to anchor');
              } else if (i === 0) {
                logger.info(
                  {
                    chatId,
                    replyTo: replyTo ?? null,
                    fromModel: replyToMessageId ?? null,
                    fallback: opts.defaultReplyTo ?? null,
                    dmNoDefault: isDM(chatId),
                    parts: parts.length,
                    preview: part.slice(0, 80),
                  },
                  'host sendText',
                );
              }
              const messageId = await sendMessage(chatId, part, replyTo);
              lastMessageId = messageId;
              lastSentNorm = part;
              rememberBotText(chatId, part);
              await track(
                import('../pipeline/context/manager.js')
                  .then(({ addAssistant }) => addAssistant(chatId, { textContent: part, messageId }))
                  .catch((err) => logger.debug({ err, chatId }, 'host addAssistant failed')),
              );
              void import('../memory/chroma.js')
                .then(({ memorizeMessage }) =>
                  memorizeMessage(chatId, {
                    role: 'assistant',
                    uid: 0,
                    username: '',
                    fullName: '',
                    timestamp: Math.floor(Date.now() / 1000),
                    messageId,
                    textContent: part,
                    isForwarded: false,
                  }),
                )
                .catch((err) => logger.debug({ err, chatId }, 'host memorize assistant failed'));
            }

            textSent += 1;

            const answeredIds = new Set<number>();
            // Only mark after successful send — never a stale fromModel id.
            if (firstReplyTo) answeredIds.add(firstReplyTo);
            if (opts.defaultReplyTo && opts.defaultReplyTo > 0) answeredIds.add(opts.defaultReplyTo);
            for (const mid of opts.relatedQuoteIds ?? []) {
              if (mid > 0) answeredIds.add(mid);
            }
            // 必须 await：否则 endTask → Meta 下一 tick 时 answered 还没写上，会双回
            await Promise.all(
              [...answeredIds].map((mid) => markMessageAnswered(chatId, mid).catch(() => undefined)),
            );

            // Critical path: timing must land before Meta callback.
            await track(
              import('../meta/timing-adapter.js')
                .then(({ noteMetaBotReply }) => noteMetaBotReply(chatId))
                .catch((err) => logger.debug({ err, chatId }, 'host noteMetaBotReply failed')),
            );

            return { messageId: lastMessageId };
          })(),
        );
      },
      sendSticker(fileId: string) {
        assertOpen();
        return trackInflight(
          (async () => {
            const id = String(fileId ?? '').trim();
            if (!id || id.length < 8 || /[\s<>"'`]/.test(id)) {
              logger.warn({ chatId, fileId: id.slice(0, 40) }, 'host sendSticker rejected bad fileId');
              return { messageId: 0 };
            }
            await sendChatAction(chatId, 'typing');
            try {
              const messageId = await sendSticker(chatId, id);
              if (messageId > 0) {
                await track(
                  import('../pipeline/context/manager.js')
                    .then(({ addAssistant }) =>
                      addAssistant(chatId, { textContent: '[sticker]', messageId }),
                    )
                    .catch((err) => logger.debug({ err, chatId }, 'host addAssistant sticker failed')),
                );
                // Sticker-only reply still counts as handling the task quote.
                const answeredIds = new Set<number>();
                if (opts.defaultReplyTo && opts.defaultReplyTo > 0) answeredIds.add(opts.defaultReplyTo);
                for (const mid of opts.relatedQuoteIds ?? []) {
                  if (mid > 0) answeredIds.add(mid);
                }
                await Promise.all(
                  [...answeredIds].map((mid) => markMessageAnswered(chatId, mid).catch(() => undefined)),
                );
              }
              return { messageId };
            } catch (err) {
              logger.warn({ err, chatId }, 'host sendSticker failed (non-fatal)');
              return { messageId: 0 };
            }
          })(),
        );
      },
      react(messageId: number, emoji: string) {
        assertOpen();
        return trackInflight(reactToMessage(chatId, messageId, emoji));
      },
    },
    memory: {
      async search(query: string) {
        try {
          const hits = await searchMemory(chatId, String(query).slice(0, 200), 5, 1500);
          if (!hits.length) return '(no hits)';
          return hits
            .map((h, i) => `${i + 1}. ${String(h.textContent ?? '').slice(0, 200)}`)
            .join('\n');
        } catch (err) {
          logger.debug({ err }, 'host memory.search failed');
          return '(memory unavailable)';
        }
      },
      async recallPerson(uid: number, query: string) {
        const id = Number(uid);
        if (!Number.isFinite(id) || id <= 0) return '(invalid uid)';
        const bits: string[] = [];
        try {
          const ident = getPersonIdentity(id);
          if (ident?.impression) bits.push(`impression: ${ident.impression}`);
          const inj = buildCrossGroupInjection(id, chatId);
          if (inj) bits.push(inj);
        } catch { /* optional */ }
        try {
          const hits = await searchMemoryByUser(id, String(query || '最近').slice(0, 200), chatId, 5, 2000);
          if (hits.length) {
            bits.push(
              'memories:\n' +
                hits.map((h, i) => `${i + 1}. ${String(h.textContent ?? '').slice(0, 180)}`).join('\n'),
            );
          }
        } catch (err) {
          logger.debug({ err }, 'host memory.recallPerson failed');
        }
        return bits.join('\n') || '(no person recall)';
      },
      async recentContext(limit = 20) {
        try {
          const { getRecent } = await import('../pipeline/context/manager.js');
          const { slimSingleMessage } = await import('../pipeline/context/slim.js');
          const { getBotUid } = await import('../bot/bot.js');
          const msgs = await getRecent(chatId, limit);
          if (!msgs.length) return '(empty)';
          const botUid = getBotUid() || 0;
          const masterUid = env().MASTER_UID;
          const lines = msgs.map((m) => {
            const base = slimSingleMessage(m, botUid);
            if (m.role !== 'assistant' && m.uid > 0) {
              const tags: string[] = [`uid:${m.uid}`];
              if (masterUid && m.uid === masterUid) tags.push('主人');
              return `${base}  ⟨${tags.join(' ')}⟩`;
            }
            return base;
          });
          return lines.join('\n');
        } catch {
          return '(context unavailable)';
        }
      },
    },
    stickers: {
      async pick(mood = 'happy') {
        try {
          const cands = getReadyStickersByIntent(mood);
          if (!cands.length) return null;
          return cands[0]!.fileId;
        } catch {
          return null;
        }
      },
    },
    web: {
      async search(query: string) {
        assertOpen();
        if (!env().CODEACT_WEB_SEARCH_ENABLED) return '(web search disabled)';
        const q = String(query ?? '').trim().slice(0, 200);
        if (!q) throw new Error('empty query');
        try {
          const { executeSearch } = await import('../pipeline/tools/search.js');
          const raw = await executeSearch(q);
          const out = String(raw ?? '').trim().slice(0, 3500);
          logger.info({ chatId, q: q.slice(0, 80), chars: out.length }, 'host web.search');
          return out || '(no results)';
        } catch (err) {
          logger.warn({ err, chatId, q: q.slice(0, 80) }, 'host web.search failed');
          return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    meta: {
      async request(args: { action: string; detail?: string }) {
        assertOpen();
        if (metaRequested) {
          return { queued: false, action: String(args?.action ?? '').slice(0, 64) || 'dup' };
        }
        const action = String(args?.action ?? '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._:-]/g, '')
          .slice(0, 64);
        if (!action) throw new Error('meta.request action required');
        const detail = String(args?.detail ?? '').trim().slice(0, 500);
        const { getAttentionAccumulator } = await import('../meta/attention.js');
        await getAttentionAccumulator().ingestAsync({
          chatId,
          layer: 'L0',
          pressure: 95,
          reason: `subagent_request:${action}`,
          messageId: opts.defaultReplyTo,
          textPreview: detail || action,
          payload: {
            action,
            detail,
            source: 'subagent',
            taskId: opts.taskId ?? null,
          },
        });
        metaRequested = true;
        logger.info({ chatId, action, taskId: opts.taskId }, 'host meta.request');
        return { queued: true, action };
      },
    },
    runtime: {
      endTask(summary: string) {
        if (ended) return;
        ended = true;
        opts.onEnd(String(summary ?? '').slice(0, 1000));
      },
      didSendText() {
        return textSent > 0;
      },
      async flushBookkeeping() {
        // Drain until idle — fire-and-forget sends may still be registering.
        for (let i = 0; i < 8; i++) {
          const ops = [...inflightOps];
          const books = pendingBookkeeping.splice(0, pendingBookkeeping.length);
          if (!ops.length && !books.length) return;
          await Promise.allSettled([...ops, ...books]);
        }
      },
    },
  };
}
