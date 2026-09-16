#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw || true)}"
OPENCLAW_AGENT="${OPENCLAW_AGENT:-main}"
SESSION_KEY="${OPENCLAW_SESSION_KEY:-agent:main:telegram:direct:8744490096}"
CHANNEL_LABEL="${OPENCLAW_CHANNEL_LABEL:-telegram:8744490096}"
TZ_NAME="${TZ_NAME:-Asia/Shanghai}"
NOW_LOCAL="$(TZ="$TZ_NAME" date '+%F %T %Z')"
TODAY_LOCAL="$(TZ="$TZ_NAME" date '+%F')"
YESTERDAY_LOCAL="$(TZ="$TZ_NAME" date -d 'yesterday' '+%F')"
REVIEW_START_LOCAL="${YESTERDAY_LOCAL} 01:00:00"
REVIEW_END_LOCAL="${TODAY_LOCAL} 01:00:00"
RUNTIME_SERVICE_NAME="${RUNTIME_SERVICE_NAME:-xxb-ts.service}"
JOURNALCTL_BIN="${JOURNALCTL_BIN:-$(command -v journalctl || true)}"
CURL_BIN="${CURL_BIN:-$(command -v curl || true)}"
LOG_DIR="${ROOT_DIR}/logs"
REPORT_PATH="${LOG_DIR}/hermes-daily-review-${TODAY_LOCAL}.md"
CRON_LOG_PATH="${LOG_DIR}/daily-hermes-cron.log"
OUT_LOG_PATH="${LOG_DIR}/out.log"
ERROR_LOG_PATH="${LOG_DIR}/error.log"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-${BOT_TOKEN:-}}"
DAILY_CHANGELOG_CHANNEL="${DAILY_CHANGELOG_CHANNEL:-@jiumijuan}"
TELEGRAM_API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"
LOG_SOURCE="unknown"

resolve_runtime_log() {
  local preferred="$1"
  local glob_pattern="$2"

  python3 - "$preferred" "$glob_pattern" <<'PY'
import glob
import os
import sys

preferred = sys.argv[1]
glob_pattern = sys.argv[2]
paths = set(glob.glob(glob_pattern))
paths.add(preferred)
matches = [path for path in paths if os.path.isfile(path)]
if not matches:
    raise SystemExit(1)
latest = max(matches, key=lambda path: os.path.getmtime(path))
print(latest)
PY
}

append_log_section() {
  local title="$1"
  local limit="$2"
  local log_path="$3"

  if [[ -z "$log_path" || ! -f "$log_path" ]]; then
    return 1
  fi

  {
    echo
    echo "## ${title}"
    printf -- '- Source: %s\n' "$log_path"
    printf -- '- Modified: %s\n' "$(TZ="$TZ_NAME" stat -c '%y' "$log_path")"
    tail -n "$limit" "$log_path"
  } >> "$REPORT_PATH"
}

append_journal_section() {
  local title="$1"
  local limit="$2"
  local service_name="$3"
  local since_local="$4"
  local until_local="$5"
  local tmp_journal

  if [[ -z "$JOURNALCTL_BIN" || ! -x "$JOURNALCTL_BIN" ]]; then
    return 1
  fi

  tmp_journal="$(mktemp)"
  if ! TZ="$TZ_NAME" "$JOURNALCTL_BIN" --no-pager -u "$service_name" --since "$since_local" --until "$until_local" -n "$limit" -o short-iso >"$tmp_journal" 2>/dev/null; then
    rm -f "$tmp_journal"
    return 1
  fi

  {
    echo
    echo "## ${title}"
    printf -- '- Source: journald (%s)\n' "$service_name"
    printf -- '- Review window: %s %s -> %s %s\n' "$since_local" "$TZ_NAME" "$until_local" "$TZ_NAME"
    if [[ -s "$tmp_journal" ]]; then
      cat "$tmp_journal"
    else
      echo '(no journal entries found in review window)'
    fi
  } >> "$REPORT_PATH"

  LOG_SOURCE="journald:${service_name}"
  rm -f "$tmp_journal"
}

build_daily_changelog() {
  local tmp_commits
  local commit_count tracked_modified untracked_count

  tmp_commits="$(mktemp)"
  if ! TZ="$TZ_NAME" git -C "$ROOT_DIR" log \
    --since "$REVIEW_START_LOCAL" \
    --until "$REVIEW_END_LOCAL" \
    --pretty=format:'- %h %s' >"$tmp_commits"; then
    rm -f "$tmp_commits"
    return 1
  fi

  commit_count=$(grep -c '^-' "$tmp_commits" || true)
  tracked_modified=$(git -C "$ROOT_DIR" status --short | grep -Ec '^[ MARCUDT][MDARCUT? ] ' || true)
  untracked_count=$(git -C "$ROOT_DIR" status --short | grep -c '^?? ' || true)

  {
    printf '啾咪囝每日报更 %s\n' "$TODAY_LOCAL"
    printf '时间窗：%s %s -> %s %s\n' "$REVIEW_START_LOCAL" "$TZ_NAME" "$REVIEW_END_LOCAL" "$TZ_NAME"
    printf '运行日志来源：%s\n' "$LOG_SOURCE"
    printf '提交数：%s\n' "$commit_count"
    printf '工作区变更：tracked=%s, untracked=%s\n' "$tracked_modified" "$untracked_count"
    echo
    echo '最近提交：'
    if [[ -s "$tmp_commits" ]]; then
      cat "$tmp_commits"
    else
      echo '- （该时间窗内无新提交）'
    fi
    echo
    printf '日报：%s\n' "$REPORT_PATH"
  }

  rm -f "$tmp_commits"
}

send_telegram_message() {
  local chat_id="$1"
  local text="$2"

  if [[ -z "$chat_id" || -z "$text" ]]; then
    return 1
  fi
  if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then
    echo "[$(date -Is)] changelog send skipped: BOT_TOKEN/TELEGRAM_BOT_TOKEN missing" >> "$CRON_LOG_PATH"
    return 0
  fi
  if [[ -z "$CURL_BIN" || ! -x "$CURL_BIN" ]]; then
    echo "[$(date -Is)] changelog send skipped: curl missing" >> "$CRON_LOG_PATH"
    return 0
  fi

  local response
  response=$("$CURL_BIN" -sS --fail \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" \
    --data-urlencode 'disable_web_page_preview=true' \
    "${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage")

  echo "[$(date -Is)] changelog sent: ${chat_id}" >> "$CRON_LOG_PATH"
  printf '%s\n' "$response" >/dev/null
}

OUT_RUNTIME_PATH="$(resolve_runtime_log "$OUT_LOG_PATH" "${LOG_DIR}/out*.log" || true)"
ERROR_RUNTIME_PATH="$(resolve_runtime_log "$ERROR_LOG_PATH" "${LOG_DIR}/error*.log" || true)"

mkdir -p "$LOG_DIR"

if [[ -z "$OPENCLAW_BIN" || ! -x "$OPENCLAW_BIN" ]]; then
  echo "[$(date -Is)] openclaw binary not found" | tee -a "$CRON_LOG_PATH" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/.git" ]]; then
  echo "[$(date -Is)] repo not found at $ROOT_DIR" | tee -a "$CRON_LOG_PATH" >&2
  exit 1
fi

append_section() {
  local title="$1"
  shift
  {
    echo
    echo "## ${title}"
    "$@"
  } >> "$REPORT_PATH"
}

{
  echo "# Hermes Daily Review - ${TODAY_LOCAL}"
  echo
  echo "- Generated: ${NOW_LOCAL}"
  echo "- Repo: ${ROOT_DIR}"
  echo "- Review window: ${REVIEW_START_LOCAL} ${TZ_NAME} -> ${REVIEW_END_LOCAL} ${TZ_NAME}"
  echo
  echo "This report captures runtime signals, repository state, and Hermes review output for the last day."
} > "$REPORT_PATH"

append_section "Git Status" git -C "$ROOT_DIR" status --short
append_section "Recent Commits" git -C "$ROOT_DIR" log --oneline -n 8

if ! append_journal_section "Recent runtime journal (review window, tail 200)" 200 "$RUNTIME_SERVICE_NAME" "$REVIEW_START_LOCAL" "$REVIEW_END_LOCAL"; then
  LOG_SOURCE="fallback:runtime-logs"
  append_log_section "Recent runtime out log (tail 200)" 200 "$OUT_RUNTIME_PATH" || true
  append_log_section "Recent runtime error log (tail 120)" 120 "$ERROR_RUNTIME_PATH" || true
fi

PROMPT=$(cat <<EOF
Please review the project at ${ROOT_DIR} based on the current code and recent runtime evidence.

Context:
- Daily review time: ${NOW_LOCAL}
- Review window: ${REVIEW_START_LOCAL} ${TZ_NAME} -> ${REVIEW_END_LOCAL} ${TZ_NAME}
- Focus on recent logs, likely user-visible issues, operational problems, code quality, and opportunities for optimization or new features.
- If there are safe, minimal fixes clearly warranted, you may make them. Otherwise provide a prioritized review and recommendations.
- Write your full answer directly in Markdown so it can be appended to the report file at ${REPORT_PATH}.

Required output structure:
## Hermes Review
- Findings ordered by severity/impact
- Suggested optimizations
- New feature ideas worth considering
- Fixes applied today (or say none)
- Validation performed
- Suggested next actions
EOF
)

{
  echo
  echo "## Hermes Invocation"
  echo '- Tool: openclaw sessions spawn/summarize via CLI prompt'
  echo '- Prompt sent:'
  echo '```text'
  echo "$PROMPT"
  echo '```'
} >> "$REPORT_PATH"

TMP_OUTPUT="$(mktemp)"
cleanup() {
  rm -f "$TMP_OUTPUT"
}
trap cleanup EXIT

if ! "$OPENCLAW_BIN" --help >/dev/null 2>&1; then
  echo "[$(date -Is)] openclaw executable failed basic health check" | tee -a "$CRON_LOG_PATH" >&2
  exit 1
fi

python3 - <<'PY' "$OPENCLAW_BIN" "$OPENCLAW_AGENT" "$PROMPT" "$TMP_OUTPUT"
import subprocess
import sys
from pathlib import Path

openclaw_bin, agent, prompt, output_path = sys.argv[1:5]
result = subprocess.run(
    [openclaw_bin, 'agent', '--agent', agent, '--message', prompt, '--json'],
    capture_output=True,
    text=True,
    timeout=600,
)
combined = ''
if result.stderr:
    combined += result.stderr
if result.stdout:
    if combined and not combined.endswith('\n'):
        combined += '\n'
    combined += result.stdout
Path(output_path).write_text(combined, encoding='utf-8')
sys.exit(result.returncode)
PY

python3 - <<'PY' "$TMP_OUTPUT" "$REPORT_PATH"
import json
import sys
from pathlib import Path

out_path = Path(sys.argv[1])
report_path = Path(sys.argv[2])
raw = out_path.read_text(encoding='utf-8', errors='replace')
review_text = None
json_obj = None

for idx, ch in enumerate(raw):
    if ch != '{':
        continue
    try:
        json_obj = json.loads(raw[idx:])
        break
    except json.JSONDecodeError:
        continue

if isinstance(json_obj, dict):
    payloads = (((json_obj.get('result') or {}).get('payloads')) or [])
    texts = [p.get('text', '') for p in payloads if isinstance(p, dict) and p.get('text')]
    if texts:
        review_text = "\n\n".join(texts).strip()

with report_path.open('a', encoding='utf-8') as f:
    f.write("\n## OpenClaw Output\n")
    if review_text:
        f.write(review_text)
        f.write("\n")
    else:
        f.write("```text\n")
        f.write(raw)
        if not raw.endswith("\n"):
            f.write("\n")
        f.write("```\n")
PY

if [[ -n "$SESSION_KEY" ]]; then
  MESSAGE="每日 Hermes 审查已完成：\n${REPORT_PATH}\n请读取并把具体更改、建议和结论发给我。"
  "$OPENCLAW_BIN" send --session "$SESSION_KEY" --message "$MESSAGE" >/dev/null 2>&1 || true
fi

if [[ -n "$CHANNEL_LABEL" ]]; then
  echo "[$(date -Is)] report ready: ${REPORT_PATH}" >> "$CRON_LOG_PATH"
fi

CHANGELOG_MESSAGE="$(build_daily_changelog || true)"
if [[ -n "$CHANGELOG_MESSAGE" ]]; then
  send_telegram_message "$DAILY_CHANGELOG_CHANNEL" "$CHANGELOG_MESSAGE" || \
    echo "[$(date -Is)] changelog send failed: ${DAILY_CHANGELOG_CHANNEL}" >> "$CRON_LOG_PATH"
fi

echo "Daily Hermes review completed: ${REPORT_PATH}"
