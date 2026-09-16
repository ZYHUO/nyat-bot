-- 常驻贴纸:用户指定的贴纸包(kawaiikipfel / NekoBia)作为 bot 的主力贴纸,
-- 选择时占多数候选槽位,优先级高于学习来的贴纸;其余贴纸仍可用,只是少些。
ALTER TABLE sticker_items ADD COLUMN resident INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sticker_resident ON sticker_items(resident, analysis_status);
