#!/usr/bin/env bash
# round 111：**自动判断"闸有没有样本可验"**，不再靠人想起来跑。
#
# 四个闸的"拦住 0 次"我每轮都要手动 grep + 数分母，而分母经常 <20。
# 这个脚本把判断固化。其中 ② 已被生产验证（round 86：部署后 1 分钟
# 就挡住一次 uzumaru_geoip_bot）。
#
# round 131：① 也有了生产证据（2 次拦下"同锚点同句重发"）。
set -uo pipefail
cd "$(dirname "$0")/.."

echo "闸的验证据"
echo

# ① 重复锚点闸（round 89）
REPEAT=$(awk '/同一锚点短时间内已回过/{n++}END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "  ① 重复锚点闸（round 89） 拦住 ${REPEAT} 次"

# ② 代发目标的 in-chat guard（round 55）
DELEG=$(awk '/delegation: target bot not in chat/{n++}END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "  ② 代发目标不在群 guard（round 55） 拦住 ${DELEG} 次"

# ③ 人在纠正止损（round 62）
CORR=$(awk '/correction: 人在纠正/{n++}END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "  ③ 人在纠正止损（round 62） 触发 ${CORR} 次"

# ④ 同群同文本 30s 去重（round 60）
DEDUP=$(awk '/duplicate text within 30s/{n++}END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "  ④ 同群同文本去重（round 60） 跳过 ${DEDUP} 次"

# round 131：**被拦的具体内容单独列。** round 123 我只数"成功发送了几条"，
# 于是被闸拦掉的尝试看不见——我把"闸没拦"误判成"没有第三次尝试"，
# 而那次尝试发生在 5 分钟前，日志就在那儿（只是 msg 名不同）。
# 教训：闸自己的日志是它动作的唯一观测点；数"发生了多少次发送"看不见拦截。
BLOCKS=$(awk '/同一锚点短时间内已回过/{print}' logs/app.log 2>/dev/null | tail -3)
if [ -n "$BLOCKS" ]; then
  echo
  echo "  最近被①拦下的（chat / anchor / 已回次数 / 尝试发的文本）："
  echo "$BLOCKS" | python3 -c '
import json,sys
for l in sys.stdin:
    if not l.startswith("{"): continue
    try: d = json.loads(l)
    except Exception: continue
    print("     %s chat=%s anchor=%s recent=%s  %r" % (
        d.get("time","") and __import__("datetime").datetime.utcfromtimestamp(d["time"]/1000).strftime("%m-%d %H:%M:%S"),
        d.get("chatId"), d.get("anchor"), d.get("recent"), str(d.get("preview") or "")[:24]))
'
fi

echo
echo "  分母（能不能读出结论）："
# ⚠️ 口径：这里数的是今天 UTC 日期的带锚发送数，与 measure:voice --day 同阈值。
ANCHORED=$(awk -v want="$(date -u +%Y-%m-%d)" '
  /"msg":"host sendText"/ && /"replyTo":[0-9]+/ {
    if (match($0, /"time":([0-9]+)/, m)) {
      if (strftime("%Y-%m-%d", int(m[1] / 1000), 1) == want) n++;
    }
  }
  END{print n+0}' logs/app.log 2>/dev/null || echo 0)
echo "    今天（UTC）带锚发送 ${ANCHORED} 条，需要 >=20 才读得动上面那些数"
if [ "${ANCHORED}" -lt 20 ]; then
  echo "    ⚠️ 分母 <20 —— 上面四个 0 都**不算证据**"
else
  echo "    ✓ 分母够。"
fi
echo
echo "  四个闸都是"拦住越多越说明在工作"，但 0 也可能是没遇到场景。"
echo "  分母够且 0 组重复 = 修好了；分母不够 = 什么都别读。"
