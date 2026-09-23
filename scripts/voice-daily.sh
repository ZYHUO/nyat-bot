#!/bin/bash
# 每天在北京 23:00（= 就寝后）跑一次 `measure:voice`，把结果追加到
# logs/voice-daily.log。它不决策、不告警——只是把一天的数落成一行，
# 免得"该量的时候没量"（这个会话在 awake 窗口前空转了 6 轮）。
#
# 装 cron：  bash scripts/install-voice-daily-cron.sh
# 手动跑：   bash scripts/voice-daily.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="/opt/node22/bin:$PATH"

OUT="$ROOT_DIR/logs/voice-daily.log"
mkdir -p "$ROOT_DIR/logs"

{
  echo "─ $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M %Z') ─"
  # round 144：**记下跑的这一刻（UTC）和最近一次部署。**
  #
  # 今天 20:21 那条日报里"react 真的点出去 0 次"是 round 114 修复之前的数据
  # （20:21 CST = 12:21 UTC，修复在 12:40 UTC）——差了 19 分钟就足以让读数失真。
  # 而这个仓每次改动都要重启才生效（AGENTS.md），所以混合窗口会把效果藏在里面。
  # 学 session-report.mts 的做法：单独一列"部署之后"。
  # 部署边界用 systemd 的服务启动时间（不是最后一条日志的时间——那等于现在）
  DEPLOYED=$(systemctl show xxb-ts -p ActiveEnterTimestamp --value 2>/dev/null | sed 's/^[A-Za-z]* //' | head -c 16)
  echo "  跑于 UTC $(date -u '+%H:%M:%S') · 服务启动（=最近部署） ${DEPLOYED:-?}"
  # --since 04:00 UTC = 北京 12:00，覆盖白天主体（awake 07:36–23:52 减去 nap）
  npm run --silent measure:voice -- --since 04:00 2>/dev/null \
    | grep -E '①|②|③|④|⑤|条/时|按群|小计|-1003|-1002|-1004|react 真的' \
    || echo '  (measure:voice 失败——见 logs/app.log)'
  echo
  # round 102：**"说完有没有人接"也每天收。**
  # 用户 41 轮来说"很难融入话题"，而我 42 轮修的都是让它"说得出"。
  # 这个数（replied 率）是那件事的最终指标，此前从没进过日报。
  npm run --silent measure:engage -- --hours=24 2>/dev/null \
    | grep -E '说完|n=|合计|replied =|回复率|corrected' \
    || echo '  (measure:engage 失败——见 logs/app.log)'
  echo
  # round 108：**接话延迟的三段账也每天收。**
  # round 103-106 诊断出"很难融入话题"是延迟问题（30s 快接 51%、
  # 两段 16.6s + 19.5s），round 107 固化成 measure:timing。
  # 不接进 cron 的话那四轮诊断就只是 commit message，下次看要重写脚本。
    # ⚠️ 日期口径：measure-timing 按 **UTC 日期**过滤日志（new Date(t).toISOString()），
  # 而这里显示的是北京日期。cron 在北京 23:00 = UTC 15:00 跑，两者碰巧同一天；
  # 但如果把 cron 改到北京 00:00-08:00，UTC 就是前一天，日期会错。
  # 所以传 **UTC 日期**，和脚本口径一致，不受 cron 时间影响。
  npm run --silent measure:timing -- --day="$(date -u +%Y-%m-%d)" 2>/dev/null \
    | grep -E '接话延迟|①|②|快接率|30s|300s|600s|基线' \
    || echo '  (measure:timing 失败——见 logs/app.log)'
  echo
} >> "$OUT"

# 只留最近 60 天，别让日志无限长
tail -n 4000 "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
