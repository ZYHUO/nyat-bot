import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { sendMessage, sendSticker, reactToMessage, sendChatAction } from '../bot/sender/telegram.js';
import { searchMemory, searchMemoryByUser } from '../memory/chroma.js';
import { getReadyStickersByIntent } from '../knowledge/sticker/store.js';
import { getPersonIdentity, buildCrossGroupInjection } from '../tracking/person-identity.js';

export interface HostApi {
  telegram: {
    sendText: (text: string, replyToMessageId?: number) => Promise<{ messageId: number }>;
    sendSticker: (fileId: string) => Promise<{ messageId: number }>;
    react: (messageId: number, emoji: string) => Promise<boolean>;
  };
  memory: {
    search: (query: string) => Promise<string>;
    /** Person-centric recall across contexts (uses searchMemoryByUser + identity). */
    recallPerson: (uid: number, query: string) => Promise<string>;
    recentContext: (limit?: number) => Promise<string>;
  };
  stickers: {
    pick: (mood?: string) => Promise<string | null>;
  };
  runtime: {
    endTask: (summary: string) => void;
  };
}

export function createHostApi(
  chatId: number,
  opts: {
    onEnd: (summary: string) => void;
    defaultReplyTo?: number;
  },
): HostApi {
  const banned = env().CODEACT_BANNED_WORDS;
  let ended = false;

  const assertNotBanned = (text: string) => {
    const hit = banned.find((w) => w && text.includes(w));
    if (hit) throw new Error(`banned_word:${hit}`);
  };

  /** Resolve reply anchor: prefer task quote; never let model pass 0/NaN/garbage. */
  const resolveReplyTo = (replyToMessageId?: number): number | undefined => {
    const raw = replyToMessageId ?? opts.defaultReplyTo;
    const n = typeof raw === 'string' ? Number(raw) : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return opts.defaultReplyTo;
    // Model sometimes invents ids — in groups always stick to the task anchor when present.
    if (chatId < 0 && opts.defaultReplyTo && n !== opts.defaultReplyTo) {
      logger.info(
        { chatId, modelReplyTo: n, forced: opts.defaultReplyTo },
        'host sendText: force defaultReplyTo (ignore model replyTo)',
      );
      return opts.defaultReplyTo;
    }
    return n;
  };

  return {
    telegram: {
      async sendText(text: string, replyToMessageId?: number) {
        let clean = String(text ?? '').trim();
        if (!clean) throw new Error('empty text');
        assertNotBanned(clean);
        const maxLen = chatId > 0 ? 280 : 120;
        if (clean.length > maxLen) {
          const { softTruncate } = await import('../shared/soft-truncate.js');
          const next = softTruncate(clean, maxLen);
          logger.info({ chatId, from: clean.length, to: next.length }, 'host sendText truncated');
          clean = next || clean.slice(0, maxLen);
        }
        await sendChatAction(chatId, 'typing');
        const replyTo = resolveReplyTo(replyToMessageId);
        if (chatId < 0 && !replyTo) {
          logger.warn({ chatId }, 'host sendText: group send without reply_to anchor');
        } else {
          logger.info({ chatId, replyTo }, 'host sendText');
        }
        const messageId = await sendMessage(chatId, clean, replyTo);
        // Meta 不走 deliver.ts，必须自己写回 Redis 上下文，否则 recentContext/日记看不到本喵说过的话。
        void import('../pipeline/context/manager.js')
          .then(({ addAssistant }) => addAssistant(chatId, { textContent: clean, messageId }))
          .catch((err) => logger.debug({ err, chatId }, 'host addAssistant failed'));
        void import('../memory/chroma.js')
          .then(({ memorizeMessage }) =>
            memorizeMessage(chatId, {
              role: 'assistant',
              uid: 0,
              username: '',
              fullName: '',
              timestamp: Math.floor(Date.now() / 1000),
              messageId,
              textContent: clean,
              isForwarded: false,
            }),
          )
          .catch((err) => logger.debug({ err, chatId }, 'host memorize assistant failed'));
        return { messageId };
      },
      async sendSticker(fileId: string) {
        const id = String(fileId ?? '').trim();
        // Invalid file_id previously crashed the process via unhandled CodeAct promises.
        if (!id || id.length < 8 || /[\s<>"'`]/.test(id)) {
          logger.warn({ chatId, fileId: id.slice(0, 40) }, 'host sendSticker rejected bad fileId');
          return { messageId: 0 };
        }
        await sendChatAction(chatId, 'typing');
        try {
          const messageId = await sendSticker(chatId, id);
          if (messageId > 0) {
            void import('../pipeline/context/manager.js')
              .then(({ addAssistant }) =>
                addAssistant(chatId, { textContent: '[sticker]', messageId }),
              )
              .catch((err) => logger.debug({ err, chatId }, 'host addAssistant sticker failed'));
          }
          return { messageId };
        } catch (err) {
          logger.warn({ err, chatId }, 'host sendSticker failed (non-fatal)');
          return { messageId: 0 };
        }
      },
      async react(messageId: number, emoji: string) {
        return reactToMessage(chatId, messageId, emoji);
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
          const msgs = await getRecent(chatId, limit);
          if (!msgs.length) return '(empty)';
          return msgs
            .map((m, i) => `${i + 1}. ${m.fullName || m.username}: ${m.textContent.slice(0, 200)}`)
            .join('\n');
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
    runtime: {
      endTask(summary: string) {
        if (ended) return;
        ended = true;
        opts.onEnd(String(summary ?? '').slice(0, 1000));
      },
    },
  };
}
