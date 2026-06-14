// ────────────────────────────────────────
// 心流层 — 回复路径启发式(0ms,替代 L0 补路的 microJudge 调用)
// ────────────────────────────────────────
//
// L0 规则命中(@/回复bot/私聊 —— 最高频交互)后,旧链路还要打一次
// microJudge LLM **只为了**决定 direct/planned(要不要用工具)。
// 这个判断确定性关键词就能覆盖:要查实时信息/外部资料 → planned,
// 其余 → direct。误判代价温和:planned 的 planner 会再判 needTools
// (误进 planned 只多一次廉价规划调用),direct 误判则按现状直接答。
// 净效果:每次直接交互省 1 次 LLM 调用。

/** 明确需要外部/实时信息的意图 */
const LOOKUP_RE = new RegExp(
  [
    // 显式检索动词
    '查一?下', '查查', '搜一?下', '搜索', '帮我查', '帮我搜', '百度', '谷歌', 'google',
    // 实时数据
    '价格', '多少钱', '汇率', '币价', '股价', '天气', '气温',
    '最新', '新闻', '现在.{0,4}(几点|时间)', '今天.{0,6}(日期|星期|几号)',
    // 外部资料
    'wiki', '维基', '官网', '文档', '资料',
    // IP/网络查询(本 bot 有 ip 工具)
    '查.{0,3}ip', 'ip.{0,3}(归属|质量|纯净)',
    // 借力其他 bot 的典型意图(止血:needsLookup 漏判→走不到工具;
    // 终态由"合并带工具写手"取代正则路由)。翻译不算 —— LLM 自带,无需工具。
    '点歌', '听歌', '来一?首', '放一?首', '点一?首', '搜.{0,2}歌', '这首歌',
    '查.{0,3}(快递|物流|股票)',
  ].join('|'),
  'i',
);

const URL_RE = /https?:\/\/|www\./i;

/**
 * 确定性路径分类:true → planned(需要工具),false → direct。
 */
export function needsLookup(text: string): boolean {
  if (!text) return false;
  if (URL_RE.test(text)) return true; // 带链接多半要抓取
  return LOOKUP_RE.test(text);
}
