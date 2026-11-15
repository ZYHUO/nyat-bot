/**
 * 2026 节假日登记（migrations/0114_seed_2026_holidays.sql）真的改变行为。
 *
 * 这条测试存在的理由：school_overrides 建表以来一行都没有，而生产
 * SCHOOL_SCHEDULE_ENABLED=true。后果不是"没有节假日感知"，是**反向**的——
 * resolveProfile() 只对 kind='holiday' 返回暑假日计划，其余日子按周几推。于是：
 *   · 2026-10-01～10-07 国庆 7 天里，10/1(四) 10/2(五) 10/5(一) 10/6(二) 10/7(三)
 *     全被当成"在上课"——bot 在假期里演高中生课表
 *   · 2026-10-10(六) 补班日被当成自由周末
 * 节日"提示"本来就有（beijing-time.ts 查表）；这里补的是**作息/语气**那一半。
 *
 * 数据来源是国办发明电〔2025〕7号（gov.cn 可查），不是算法推的——中国调休/补课
 * 没法靠算法推，LLM 猜必胡编（0040 迁移文件里写明了这条）。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ SCHOOL_SCHEDULE_ENABLED: true, DAILY_LIFE_PROFILE: 'auto' }),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getSchoolState, getDaySummary } from '../../../src/tracking/school-state.js';

/** 北京日期 + 时刻 → UTC Date（getSchoolState 内部 +8h 回推）。 */
function bj(isoBeijing: string): Date {
  return new Date(new Date(`${isoBeijing}:00Z`).getTime() - 8 * 3600_000);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0040_school_overrides.sql', 'utf8'));
  db.exec(readFileSync('migrations/0114_seed_2026_holidays.sql', 'utf8'));
});

describe('2026 节假日登记', () => {
  it('国庆 7 天全部判成放假（不是上课）', () => {
    // 10/1 周四、10/2 周五、10/5 周一、10/6 周二、10/7 周三 —— 全是工作日，
    // 没有 override 的话全部会掉进课表。取上午 10:20（第3节课时间）。
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']) {
      const s = getSchoolState(bj(`${d}T10:20`));
      expect(s.phase, d).toBe('holiday');
      expect(s.isSchoolDay, d).toBe(false);
      expect(s.selfLine, d).toContain('国庆');
      // 放假 → 满注意力（不是上课时的 0.3）
      expect(s.attentionFactor, d).toBeGreaterThan(0.9);
    }
  });

  it('中秋 3 天同样判成放假', () => {
    for (const d of ['2026-09-25', '2026-09-26', '2026-09-27']) {
      const s = getSchoolState(bj(`${d}T10:20`));
      expect(s.phase, d).toBe('holiday');
      expect(s.selfLine, d).toContain('中秋');
    }
  });

  it('补班日（10/10 周六）是上课日，不是自由周末', () => {
    const s = getSchoolState(bj('2026-10-10T10:20'));
    expect(s.phase).not.toBe('holiday');
    expect(s.isSchoolDay).toBe(true);
    // 周末自由日会说"周末自由日"；补班日不该这么说
    expect(s.selfLine ?? '').not.toContain('周末自由日');
  });

  it('普通周六仍然判自由周末（override 只影响登记过的那几天）', () => {
    // 2026-10-17 是周六，没登记
    const s = getSchoolState(bj('2026-10-17T10:20'));
    expect(s.isSchoolDay).toBe(false);
    expect(s.phase).not.toBe('holiday');
  });

  it('getDaySummary 也读得到节假日语气', () => {
    const sum = getDaySummary(bj('2026-10-01T10:20'));
    expect(sum.isSchoolDay).toBe(false);
    expect(sum.text).toContain('国庆');
  });

  it('迁移本身是幂等的（跑第二遍不报错、不加行）', () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM school_overrides').get() as { n: number }).n;
    db.exec(readFileSync('migrations/0114_seed_2026_holidays.sql', 'utf8'));
    const after = (db.prepare('SELECT COUNT(*) n FROM school_overrides').get() as { n: number }).n;
    expect(after).toBe(before);
    expect(before).toBeGreaterThan(30);
  });

  it('登记的范围与国办通知一致：7 段假 + 6 个补班日', () => {
    const holidays = db.prepare("SELECT COUNT(*) n FROM school_overrides WHERE kind='holiday'").get() as { n: number };
    const makeups = db.prepare("SELECT COUNT(*) n FROM school_overrides WHERE kind='makeup'").get() as { n: number };
    // 元旦3 + 春节9 + 清明3 + 劳动5 + 端午3 + 中秋3 + 国庆7 = 33
    expect(holidays.n).toBe(33);
    // 1/4 + 2/14 + 2/28 + 5/9 + 9/20 + 10/10 = 6
    expect(makeups.n).toBe(6);
  });
});
