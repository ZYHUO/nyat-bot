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
  # --since 04:00 UTC = 北京 12:00，覆盖白天主体（awake 07:36–23:52 减去 nap）
  npm run --silent measure:voice -- --since 04:00 2>/dev/null \
    | grep -E '①|②|③|④|⑤|条/时|按群|小计|-1003|-1002|-1004|react 真的' \
    || echo '  (measure:voice 失败——见 logs/app.log)'
  echo
} >> "$OUT"

# 只留最近 60 天，别让日志无限长
tail -n 4000 "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
