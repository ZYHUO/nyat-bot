-- 持久化 LLM token 记账(重启不清零,补 Prometheus 内存计数器之短)。
-- 按天 × provider(label)× kind 聚合,便于看"StepFun 每天吃了多少 / 各用途占比"。
-- date = UTC 'YYYY-MM-DD';label = provider 尝试标签(stepfun/stepfunjudge/longcat/deepseek…);
-- kind = prompt(全部输入,含缓存)/ completion(输出)/ cached(缓存读子集,便宜)。
CREATE TABLE IF NOT EXISTS llm_token_daily (
    date    TEXT    NOT NULL,
    label   TEXT    NOT NULL,
    usage   TEXT    NOT NULL DEFAULT '',
    kind    TEXT    NOT NULL,
    tokens  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, label, usage, kind)
);
CREATE INDEX IF NOT EXISTS idx_llm_token_daily_date ON llm_token_daily(date);
