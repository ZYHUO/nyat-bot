-- 功能 A:上学日程。手动维护的特殊日 override 表(节假日/补课/提早放学/考试/活动)。
-- 确定性周课表骨架写在代码里(school-state.ts);中国调休/补课无法靠算法推,
-- 必须人工在此登记(LLM 猜必胡编)。bj_date 为北京日期 'YYYY-MM-DD'。
CREATE TABLE IF NOT EXISTS school_overrides (
  bj_date    TEXT PRIMARY KEY,            -- '2026-10-01'
  kind       TEXT NOT NULL,              -- holiday | makeup | early_off | exam | activity
  makeup_dow INTEGER,                     -- kind=makeup 时:补哪个星期几的课 (1=周一..5=周五)
  end_min    INTEGER,                     -- kind=early_off 时:提早放学的北京分钟数
  note       TEXT NOT NULL DEFAULT '',   -- '国庆假期' / '期中考试' / '运动会'
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
