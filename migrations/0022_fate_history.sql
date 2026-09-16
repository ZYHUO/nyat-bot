-- P2: 缘分签记录表
-- 每人每天最多一次，用历史对话 + 自己的 data 做分析

CREATE TABLE IF NOT EXISTS fate_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    group_id TEXT,
    card1 TEXT NOT NULL,           -- 抽到的第一个猫娘
    card2 TEXT NOT NULL,           -- 抽到的第二个猫娘
    interpretation TEXT NOT NULL,  -- 签文分析
    blessing TEXT NOT NULL,        -- 祝福语
    drawn_at DATE NOT NULL,        -- 日期 (YYYY-MM-DD, 用于每天限制)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fate_user_date ON fate_history(user_id, drawn_at);
