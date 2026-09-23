#!/usr/bin/env bash
# round 111：**自动判断"闸有没有样本可验"**，不再靠人想起来跑。
#
# 背景：round 89/90 加的重复锚点闸，我每次都要手动 grep + 数分母，
# 而分母经常 <20（时段低谷）。这个脚本把判断固化，输出三态：
#
#   OK      样本够（>=20 条带锚）——读那几行数字
#   MISSING 样本不够——明说"0 不算数"
#   CLEAN   样本够且 0 组重复——修好了（这才是好消息）
#
# 用法：npm run gate:evidence   或   bash scripts/check-gate-evidence.sh
set -uo pipefail
cd "$(dirname "$0")/.."

echo "闸的验证据（round 111）"
echo

# ① 重复锚点闸
# grep -c 在没匹配时返回 1（不是 0），且 || echo 0 会再接一个换行
# —— 所以用 awk 数，天然处理无匹配（输出 0 且单行）。
REPEAT=$(awk '/同一锚点短时间内已回过/{n++}END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "  ① 重复锚点闸（round 89） 拦住 ${REPEAT} 次"

# ② 代发目标的 in-chat guard（round 55/84）
DELEG=$(awk '/delegation: target bot not in chat/{n++}END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "  ② 代发目标不在群 guard（round 55） 拦住 ${DELEG} 次"

# ③ 人在纠正止损（round 62）
CORR=$(awk '/correction: 人在纠正/{n++}END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "  ③ 人在纠正止损（round 62） 触发 ${CORR} 次"

# ④ 同群同文本 30s 去重（round 60/65）
DEDUP=$(awk '/duplicate text within 30s/{n++}END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "  ④ 同群同文本去重（round 60） 跳过 ${DEDUP} 次"

echo
echo
echo "  分母（能不能读出结论）："
# round 111：把"0 算不算数"的判断也自动做。
# 固定用今天 UTC 日期的带锚发送数 >= 20，与 measure:voice 的 ③ 守卫同阈值。
# round 112：按 **UTC 今天** 切（和 measure:voice --day 同口径）。
# 原来数全累计 → 把修复前的样本混进来（round 40 的教训），
# 而四个闸里三个是这几轮加的，会让分母虚高、结论偏乐观。
# JSON 的 time 是 ms since epoch，用 strftime 拼 UTC 日期再比。
ANCHORED=$(awk -v want="$(date -u +%Y-%m-%d)" '
  /"msg":"host sendText"/ && /"replyTo":[0-9]+/ {
    if (match($0, /"time":([0-9]+)/, m)) {
      secs = int(m[1] / 1000);
      if (strftime("%Y-%m-%d", secs, 1) == want) n++;
    }
  }
  END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "    今天（UTC）带锚发送 ${ANCHORED} 条，需要 >=20 才读得动上面那些数"
if [ "${ANCHORED}" -lt 20 ]; then
  echo "    ⚠️ 分母 <20 —— 上面四个 0 都**不算证据**（等今晚 23:00 的 cron）"
else
  echo "    ✓ 分母够。"
fi
echo
echo "  四个闸都是"拦住越多越说明在工作"，但 0 也可能是没遇到场景。"
echo "  分母够且 0 组重复 = 修好了；分母不够 = 什么都别读。"
