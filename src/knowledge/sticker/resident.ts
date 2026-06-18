// ────────────────────────────────────────
// 常驻贴纸包 — 把用户指定的贴纸包灌进 sticker_items 作为主力贴纸
// ────────────────────────────────────────
//
// 通过 getStickerSet 拉取整包,逐张 upsertResidentSticker(ready+resident=1)。
// 幂等可重跑(刷新 file_id,不动学习/分析结果)。RESIDENT_STICKER_PACKS 配置包名。

import { getBot } from '../../bot/bot.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { upsertResidentSticker } from './store.js';
import type { StickerFormat } from './types.js';

function formatOf(s: { is_video?: boolean; is_animated?: boolean }): StickerFormat {
  if (s.is_video) return 'video_webm';
  if (s.is_animated) return 'animated_tgs';
  return 'static_webp';
}

/** Seed 一个贴纸包为常驻。返回插入/更新的数量。 */
export async function seedResidentPack(setName: string): Promise<number> {
  const set = await getBot().api.getStickerSet(setName);
  let n = 0;
  for (const s of set.stickers) {
    try {
      upsertResidentSticker({
        fileUniqueId: s.file_unique_id,
        fileId: s.file_id,
        setName,
        emoji: s.emoji ?? '',
        format: formatOf(s),
      });
      n++;
    } catch (err) {
      logger.debug({ err, setName, fid: s.file_unique_id }, 'seedResidentPack: one sticker failed');
    }
  }
  logger.info({ setName, count: n }, 'Resident sticker pack seeded');
  return n;
}

/** Seed 配置里的所有常驻包(RESIDENT_STICKER_PACKS,逗号分隔)。 */
export async function seedResidentPacks(): Promise<number> {
  const packs = (env().RESIDENT_STICKER_PACKS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  let total = 0;
  for (const p of packs) {
    try {
      total += await seedResidentPack(p);
    } catch (err) {
      logger.warn({ err, pack: p }, 'seedResidentPack failed');
    }
  }
  return total;
}
