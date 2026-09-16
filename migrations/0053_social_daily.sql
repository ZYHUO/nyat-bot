-- 社交决策日度指标 —— G8(合并人格决策)A/B 的对照基线。
--
-- 为什么落库而不是只用 Prometheus:src/metrics/registry.ts 的 counter 是纯内存态,
-- 每次部署重启就归零。基线要跑一周,中间必然有重启 —— 与 llm_token_daily(0048)
-- 面对的是同一个问题,所以用同一套解法。
--
-- 为什么按 chat_id 分:G8 要灰度对比(开了的群 vs 没开的群)。全局聚合看不出差别 ——
-- 各群的活跃度和话题密度差异远大于 G8 本身的效应。
--
-- metric 取值:
--   msg_seen            进入决策路径的消息数(分母)
--   decision_reply/wait/pass   心流三种出口各自的次数
--   reply_sent          真正投递出去的回复数
--   interrupt           回合被新消息打断的次数
--   llm_calls           归属到本群的 LLM 调用次数(分子)
--   e2e_latency_ms_sum / e2e_latency_count   端到端延迟,均值 = sum/count
--
-- 四个 A/B 指标由此派生:
--   每回复 LLM 调用数 = llm_calls / reply_sent
--   端到端延迟       = e2e_latency_ms_sum / e2e_latency_count
--   打断率           = interrupt / reply_sent
--   回复/消息比      = reply_sent / msg_seen
CREATE TABLE IF NOT EXISTS social_daily (
    date    TEXT    NOT NULL,          -- UTC 'YYYY-MM-DD',与 llm_token_daily 同口径
    chat_id INTEGER NOT NULL,
    metric  TEXT    NOT NULL,
    value   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, chat_id, metric)
);
CREATE INDEX IF NOT EXISTS idx_social_daily_date ON social_daily(date);
