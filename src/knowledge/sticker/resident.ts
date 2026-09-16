// ────────────────────────────────────────
// 常驻贴纸包 — 把用户指定的贴纸包灌进 sticker_items 作为主力贴纸
// ────────────────────────────────────────
//
// 通过 getStickerSet 拉取整包,逐张 upsertResidentSticker(ready+resident=1)。
// 幂等可重跑(刷新 file_id,不动学习/分析结果)。RESIDENT_STICKER_PACKS 配置包名。

import { getBot } from '../../bot/bot.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { upsertResidentSticker, listPendingResidentStickers, storeAnalysisResult, markAnalysisFailed } from './store.js';
import type { StickerFormat } from './types.js';

function formatOf(s: { is_video?: boolean; is_animated?: boolean }): StickerFormat {
  if (s.is_video) return 'video_webm';
  if (s.is_animated) return 'animated_tgs';
  return 'static_webp';
}

/** Seed 一个贴纸包为常驻(pending,待识图)。返回登记数量。 */
export async function seedResidentPack(setName: string): Promise<number> {
  const set = await getBot().api.getStickerSet(setName);
  let n = 0;
  for (const s of set.stickers) {
    try {
      // 静态贴纸直接喂图;视频/动图喂缩略图(静态)。
      const isStatic = !s.is_video && !s.is_animated;
      const analysisFileId = isStatic ? s.file_id : (s.thumbnail?.file_id ?? s.file_id);
      upsertResidentSticker({
        fileUniqueId: s.file_unique_id,
        fileId: s.file_id,
        analysisFileId,
        setName,
        emoji: s.emoji ?? '',
        format: formatOf(s),
      });
      n++;
    } catch (err) {
      logger.debug({ err, setName, fid: s.file_unique_id }, 'seedResidentPack: one sticker failed');
    }
  }
  logger.info({ setName, count: n }, 'Resident sticker pack seeded (pending vision analysis)');
  return n;
}

/**
 * 识图分析一批待处理的常驻贴纸:走视觉模型出情绪标签 → 转 ready 可选。
 * 串行 + 小批量(默认 6),避免一次性打爆视觉额度。返回成功分析数。
 */
export async function analyzeResidentStickers(limit = 6): Promise<number> {
  const pending = listPendingResidentStickers(limit);
  if (pending.length === 0) return 0;
  const { analyzeStickerEmotion } = await import('../../pipeline/vision.js');
  let ok = 0;
  for (const item of pending) {
    try {
      const emo = await analyzeStickerEmotion(item.analysisFileId);
      if (emo) {
        storeAnalysisResult(item.fileUniqueId, {
          emotionTags: emo.emotionTags,
          moodMap: emo.moodMap,
          personaFit: emo.personaFit,
          description: emo.description,
        });
        ok++;
      } else {
        markAnalysisFailed(item.fileUniqueId); // 识图失败:不卡队列(失败的不入选)
      }
    } catch (err) {
      logger.debug({ err, fid: item.fileUniqueId }, 'analyzeResidentStickers: one failed');
      markAnalysisFailed(item.fileUniqueId);
    }
  }
  logger.info({ analyzed: ok, batch: pending.length }, 'Resident stickers analyzed (vision)');
  return ok;
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
