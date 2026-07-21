import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { sendMessage, sendSticker, reactToMessage } from '../bot/sender/telegram.js';
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

  return {
    telegram: {
      async sendText(text: string, replyToMessageId?: number) {
        const clean = String(text ?? '').trim();
        if (!clean) throw new Error('empty text');
        assertNotBanned(clean);
        const replyTo = replyToMessageId ?? opts.defaultReplyTo;
        const messageId = await sendMessage(chatId, clean, replyTo);
        return { messageId };
      },
      async sendSticker(fileId: string) {
        const messageId = await sendSticker(chatId, fileId);
        return { messageId };
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
