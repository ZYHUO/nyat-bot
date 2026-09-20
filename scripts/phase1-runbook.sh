#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 心流旁路 · 实验 runbook（预先写死，执行时不做任何新决定）
# ─────────────────────────────────────────────────────────────────────────────
#
# 论文依据：§九·补三（判据与反证）· §九·补七/B（样本量）· §九·补七·C（σ 与天数区间）
#
# 为什么是脚本而不是"到时候再说"：这次会话里我多次因为临场判断出错
# （拿窄窗当稳态、拿旧进程显示当证据、四道绿一道红时把红当噪音）。
# 把顺序和判据固定成脚本，是让"执行"不依赖我当时的状态。
#
# 用法：
#   bash scripts/phase1-runbook.sh pre      # 翻旗前：取基线读数 + 检查前置条件
#   bash scripts/phase1-runbook.sh grant    # 翻旗：授予时限旁路（默认 180 分钟）
#   bash scripts/phase1-runbook.sh read     # 读数：实验群 + 对照群 + 全群曲线
#   bash scripts/phase1-runbook.sh verdict  # 判定：按预注册判据给结论
#
# ⚠️ grant 会改变一个真人群的行为。论文 §九·补七 要求基线 ≥5 天同期数据，
#    pre 会检查这一点，不满足时拒绝继续。

set -euo pipefail
CHAT="${PHASE1_CHAT:--1002750574953}"
MINUTES="${PHASE1_MINUTES:-180}"
KEY="xxb:trench:heart_bypass:${CHAT}"
export PATH=/opt/node22/bin:$PATH
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺工具: $1"; exit 2; }; }
need redis-cli; need npx

pre() {
  echo "═══ Phase 1 · 翻旗前检查 ═══"
  local days
  days=$(cat var/control-baseline.jsonl | python3 -c "
import sys,json
print(len({(json.loads(l)['slotUtc'],json.loads(l)['at'][:10]) for l in sys.stdin}))")
  echo "同期基线天数: ${days}"
  if [ "${days}" -lt 5 ]; then
    echo "❌ 基线不足 5 天（§九·补七）。单日读数对着 σ≈23% 不可归因。中止。"
    exit 1
  fi
  echo "✅ 基线天数够"
  echo
  echo "--- 候选群同期基线（对照组的来源）---"
  npx tsx scripts/control-baseline.mts show 2>/dev/null | grep -e "${CHAT}" || echo "（该群暂无可用同期数据）"
  echo
  echo "--- 翻旗前读数（必须记下，否则无从比较）---"
  npx tsx scripts/trench-canary.mts 1 2>/dev/null | grep -E -e "chat ${CHAT}" -e "Phase 2 准入" -e "定向债" || true
  echo
  echo "--- 前置条件（论文 §九·补五）---"
  local mode
  mode=$(tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value xxb-ts)/environ | grep '^TRENCH_ENVELOPE_MODE=' | cut -d= -f2 || echo off)
  echo "包络模式: ${mode}（需 enforce）"
  [ "${mode}" = "enforce" ] || { echo "❌ 包络未 enforce，先拨过去再读真实拦截率。中止。"; exit 1; }
  echo "✅ 包络已 enforce"
  echo
  echo "--- 当前旁路状态（应为空）---"
  # **必须用 exists，不能用 get 的退出码**：redis-cli get 对 nil 也返回 0，
  # 于是这个检查恒定报"已存在"——一个永远同答案的检查等于没有检查。
  if [ "$(redis-cli -n 5 exists "${KEY}")" = "1" ]; then
    echo "⚠️ 已存在旁路键（TTL $(redis-cli -n 5 ttl "${KEY}")s），先 revoke 再 grant"
  else
    echo "✅ 无进行中的旁路"
  fi
}

grant() {
  echo "═══ Phase 1 · 授予时限旁路 ═══"
  echo "群: ${CHAT} · 时长: ${MINUTES} 分钟（TTL 到期自动恢复，无需人记得撤）"
  redis-cli -n 5 set "${KEY}" "$(date +%s)" EX $((MINUTES * 60))
  echo "已授予。TTL: $(redis-cli -n 5 ttl "${KEY}")s"
  echo "过期时刻: $(date -d "+${MINUTES} minutes" '+%H:%M:%S %Z')"
}

read_() {
  echo "═══ Phase 1 · 读数 ═══"
  echo "--- 实验群 ---"
  npx tsx scripts/trench-canary.mts 1 2>/dev/null | grep -e "chat ${CHAT}" || true
  echo "--- 全群曲线（对照：其余群应不动）---"
  npx tsx scripts/trench-canary.mts 1 2>/dev/null | grep -E "^  chat " || true
  echo "--- 定向债（实验 B 的判据）---"
  npx tsx scripts/trench-canary.mts 1 2>/dev/null | grep -E "窗口内回复|当前窗口基线" || true
  echo "--- 旁路是否真的在跑 ---"
  echo "BYPASSED 次数: $(grep -c 'Meta heart: BYPASSED' logs/app.log)"
  echo "心流裁决次数: $(grep -c 'Meta heart:' logs/app.log)"
}

verdict() {
  echo "═══ Phase 1 · 判定（判据跑之前已写死）════"
  cat <<'CRITERIA'
主判据    该群发送率  基线 ~28% → 60%+
反证      命中率/发送率升但总发言率翻倍且关系分或投诉下降 → 回滚
包络      拦截 >0 且持续 → 上限太紧，调参而不是回滚
灰度      其余群曲线不动 → 灰度生效；若其余群也动 → 不是灰度，是全局副作用
样本量    σ 23–26% ⇒ 60% 判据需 5–13 天/组（§九·补七/B）
          单日读数一律不可归因，必须攒满再判
CRITERIA
  echo
  echo "--- 当前旁路 TTL（-2 = 已过期自动恢复）---"
  redis-cli -n 5 ttl "${KEY}"
  echo
  echo "--- 同期对照（对照组来源）---"
  npx tsx scripts/control-baseline.mts show 2>/dev/null | grep -e "${CHAT}" || true
}

case "${1:-}" in
  pre)     pre ;;
  grant)   grant ;;
  read)    read_ ;;
  verdict) verdict ;;
  *) echo "用法: $0 {pre|grant|read|verdict}"; exit 2 ;;
esac
