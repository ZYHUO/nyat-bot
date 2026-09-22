#!/bin/bash
# 装 cron：每天北京 23:00 跑一次 scripts/voice-daily.sh，把当天的四个数
# 追加到 logs/voice-daily.log。
#
# 为什么要自动：这个会话为了等 awake 窗口空转了 6 轮（round 14-19），
# 每轮都差 20-30 分钟。让 cron 在就寝后收一次，人只要读日志。
#
# 卸载：bash scripts/install-voice-daily-cron.sh --uninstall
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/voice-daily.sh"
MARKER="# nyatbot-voice-daily"
TZ_NAME="${TZ_NAME:-Asia/Shanghai}"

if [[ ! -x "$SCRIPT" ]]; then chmod +x "$SCRIPT"; fi

CRON_LINE="0 23 * * * cd $ROOT_DIR && TZ=$TZ_NAME bash $SCRIPT $MARKER"

if [[ "${1:-}" == "--uninstall" ]]; then
  ( crontab -l 2>/dev/null | grep -v "$MARKER" || true ) | crontab -
  echo "已移除 cron（$MARKER）"
  exit 0
fi

( crontab -l 2>/dev/null | grep -v "$MARKER" || true; echo "$CRON_LINE" ) | crontab -
echo "已安装："
echo "  $CRON_LINE"
echo
echo "卸掉：bash $0 --uninstall"
echo "手动跑一次看看：bash $SCRIPT"
