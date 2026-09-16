-- 长期记忆的词法(BM25)旁路 — 与 Qdrant 向量库并行的第二路召回。
--
-- 为什么要它:384 维小模型对专有名词/群内黑话/ID/型号天然弱(jargon-miner 挖出来的
-- 正是这类词),纯向量召回抓不住。两路并行 + RRF 融合(src/memory/fusion.ts)。
--
-- 为什么不用 tokenize='trigram':FTS5 trigram 需要 ≥3 字符,生产机实测查「篮球」
-- 「拉面」这类**双字词返回空**,而中文双字词最常见。改为写入前用 Intl.Segmenter
-- 分词、空格拼接,再交给 unicode61(见 src/memory/lexical.ts)。
--
-- chat 列存的是 chatToken()(cn/cp + 绝对值):unicode61 会把 `-` 当分隔符吃掉,
-- 负数群 id 直接存会和正数 DM id 撞车。它是**被索引列**,所以按群过滤走倒排而非全表扫。
-- chroma_id 是 UNINDEXED —— 只作回连键,不参与全文匹配。
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    chroma_id UNINDEXED,
    chat,
    seg,
    tokenize='unicode61'
);
