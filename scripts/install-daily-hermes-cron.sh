#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/scripts/daily-hermes-review.sh"
CRON_TMP="$(mktemp)"
TZ_NAME="${TZ_NAME:-Asia/Shanghai}"
SESSION_KEY="${OPENCLAW_SESSION_KEY:-agent:main:telegram:direct:8744490096}"
CHANNEL_LABEL="${OPENCLAW_CHANNEL_LABEL:-telegram:8744490096}"
OPENCLAW_AGENT="${OPENCLAW_AGENT:-main}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw || true)}"

cleanup() {
  rm -f "$CRON_TMP"
}
trap cleanup EXIT

if [[ ! -x "$SCRIPT_PATH" ]]; then
  chmod +x "$SCRIPT_PATH"
fi

if [[ -z "$OPENCLAW_BIN" || ! -x "$OPENCLAW_BIN" ]]; then
  echo "openclaw binary not found; set OPENCLAW_BIN before installing cron" >&2
  exit 1
fi

crontab -l 2>/dev/null | grep -v 'daily-hermes-review.sh' > "$CRON_TMP" || true
{
  echo "CRON_TZ=${TZ_NAME}"
  echo "OPENCLAW_BIN=${OPENCLAW_BIN}"
  echo "OPENCLAW_SESSION_KEY=${SESSION_KEY}"
  echo "OPENCLAW_CHANNEL_LABEL=${CHANNEL_LABEL}"
  echo "OPENCLAW_AGENT=${OPENCLAW_AGENT}"
  echo "0 1 * * * ${SCRIPT_PATH} >> ${ROOT_DIR}/logs/daily-hermes-cron.log 2>&1"
} >> "$CRON_TMP"
crontab "$CRON_TMP"

echo "Installed daily Hermes review cron:"
echo "  CRON_TZ=${TZ_NAME}"
echo "  0 1 * * * ${SCRIPT_PATH} >> ${ROOT_DIR}/logs/daily-hermes-cron.log 2>&1"
