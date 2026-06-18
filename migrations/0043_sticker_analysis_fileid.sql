-- 常驻贴纸走识图:视频/动图贴纸不能直接喂视觉模型,需用其缩略图(静态)。
-- analysis_file_id = 用于视觉分析的图片 file_id(静态贴纸=贴纸本身;视频/动图=缩略图)。
-- 为空时回退用 latest_file_id。latest_file_id 始终是「发送用」的贴纸 file_id。
ALTER TABLE sticker_items ADD COLUMN analysis_file_id TEXT;
-- 之前误把常驻贴纸标成 ready 但没情绪标签(靠 emoji 没法标)。退回 pending,走识图重析。
UPDATE sticker_items SET analysis_status = 'pending' WHERE resident = 1 AND emotion_tags IS NULL;
