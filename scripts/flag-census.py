#!/usr/bin/env python3
"""Flag census — 把 env.ts 里每个 flag 的"是什么 / 默认 / .env 实际值 / 有没有人读"
合成一张真表。纯静态，不打数据库，不改任何东西。

输出: docs/flag-census.md（人读）+ /tmp/flagcensus.json（后续用）
"""
import json
import re
import subprocess
from collections import defaultdict

SRC = 'src/env.ts'
ENVF = '.env'

src = open(SRC, encoding='utf8').read()
lines = src.split('\n')

# ── 1. 抓每个 flag 的 key / 默认值 / 上方注释 ────────────────────────────
flags = []
i = 0
while i < len(lines):
    m = re.match(r'^  ([A-Z][A-Z0-9_]+):\s*(.+?),?\s*$', lines[i])
    if m:
        name, rhs = m.group(1), m.group(2)
        j = i - 1
        comment = []
        while j >= 0:
            s = lines[j].strip()
            if s.startswith('//'):
                comment.append(s[2:].strip())
                j -= 1
            elif s == '' and not comment:
                j -= 1
            else:
                break
        dm = re.search(r"booleanFromEnv\.default\((\w+)\)", rhs)
        nm = re.search(r"\.default\(([^)]*)\)", rhs)
        default = dm.group(1) if dm else (nm.group(1) if nm else '')
        flags.append({
            'name': name,
            'line': i + 1,
            'rhs': rhs[:120],
            'default': default,
            'comment': ' '.join(reversed(comment))[:400],
        })
    i += 1

# ── 2. .env 实际值 ────────────────────────────────────────────────────────
envmap = {}
for line in open(ENVF, encoding='utf8'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    envmap[k.strip()] = v.strip()

TRUE = {'true', '1', 'yes', 'on'}
FALSE = {'false', '0', 'no', 'off', ''}

# ── 3. 有没有人读 ────────────────────────────────────────────────────────
# 三种读法都要算，否则会把活旗标误判成死的（本会话已经因此差点误判 5 个）：
#   ① env().FLAG            直接点
#   ② const { FLAG } = env()  解构后在闭包里用
#   ③ process.env.FLAG      脚本/子进程/外部工具读（env.ts 之外）
# 判定"死"要求 ①②③ 全无命中，且 tests/ 里也没有（tests 里有说明至少有人当它活着）。
def hits(pattern: str, paths: list[str]) -> list[str]:
    out = subprocess.run(
        ['grep', '-rlE', '--include=*.ts', '--include=*.mts', '--include=*.js', pattern, *paths],
        capture_output=True, text=True,
    ).stdout.split()
    return [p for p in out if not p.endswith('src/env.ts')]


usage: dict[str, dict[str, list[str]]] = {}
for f in flags:
    n = f['name']
    usage[n] = {
        'env_getter': hits(rf'env\(\)\.{n}\b', ['src/']),
        'bare_word': hits(rf'\b{n}\b', ['src/', 'scripts/', 'packages/']),
        'process_env': hits(rf'process\.env\.{n}\b|process\.env\[.{0,4}{n}', ['src/', 'scripts/']),
        'tests': hits(rf'\b{n}\b', ['tests/']),
    }

# ── 4. 汇总 ───────────────────────────────────────────────────────────────
rows = []
for f in flags:
    n = f['name']
    envval = envmap.get(n)
    is_bool = 'booleanFromEnv' in f['rhs']
    if is_bool:
        if envval is None:
            state = f"默认 {f['default']}"
        elif envval.lower() in TRUE:
            state = 'ON'
        elif envval.lower() in FALSE:
            state = 'off'
        else:
            state = f'={envval}'
    else:
        state = f"={envval}" if envval is not None else f"默认 {f['default']}"
    u = usage[n]
    readers = sorted(set(u['env_getter']))
    # 死 = src/scripts/packages 里一个字都不出现（解构/process.env 都算过）
    dead = not u['bare_word'] and not u['process_env']
    # 只被测试 mock、src 不读 = 假开关（测试以为关着它，其实什么都没发生）
    phantom = (not u['bare_word'] and not u['process_env']) and bool(u['tests'])
    rows.append({
        **f,
        'is_bool': is_bool,
        'envval': envval,
        'state': state,
        'on': is_bool and (
            (envval is None and f['default'] == 'true')
            or (envval is not None and envval.lower() in TRUE)
        ),
        'readers': [p.replace('src/', '') for p in readers],
        'destructured': [p.replace('src/', '') for p in u['bare_word'] if p not in u['env_getter']],
        'process_env': u['process_env'],
        'tests': u['tests'],
        'dead': dead,
        'phantom': phantom,
    })

bools = [r for r in rows if r['is_bool']]
on_rows = [r for r in bools if r['on']]
dead = [r for r in rows if r['dead']]
phantom = [r for r in rows if r['phantom']]
dead_on = [r for r in dead if r['on']]

summary = {
    'total_keys': len(rows),
    'bool_flags': len(bools),
    'on_in_prod': len(on_rows),
    'set_in_env': len([r for r in rows if r['envval'] is not None]),
    'dead_no_reader': len(dead),
    'dead_and_on': len(dead_on),
    'phantom_only_in_tests': len(phantom),
}

# ── 5. 写 markdown ────────────────────────────────────────────────────────
out = []
out.append('# Flag census — env.ts 全量旗标清单\n')
out.append('生成方式：`python3 scripts/flag-census.py`（纯静态：env.ts 注释 + .env 实际值 + '
           '`grep env().<FLAG> src/`）。不打数据库、不改任何东西。\n')
out.append('## 总量\n')
out.append('| | |')
out.append('|---|---|')
for k, v in summary.items():
    out.append(f'| {k} | {v} |')
out.append('')
out.append(f'**{summary["bool_flags"]} 个布尔旗标里，生产实际开着 {summary["on_in_prod"]} 个。** '
           '这张表的意义就在于那一段：开着的东西才是要审计的对象。\n')
out.append('`readers` 列 = src/ 里 `env().<FLAG>` 出现的文件。`解构` 列 = 只在那里以 '
           '`const { FLAG } = env()` 之类形式出现的位置。**空 = 没人读**（要么是给脚本/'
           '外部进程读的 `process.env` 旗标，要么是死旗标）。\n')

out.append('## 🔴 死旗标：.env 开着，但代码里一个字都没有（%d 个）\n' % len(dead_on))
out.append('这些是"以为在跑"的开关。判定要求 src/ + scripts/ + packages/ 全无命中'
           '（`env().FLAG` / 解构 / `process.env.FLAG` 三种读法都算过）。\n')
out.append('| flag | .env | 注释怎么说 | tests/ 里有吗 |')
out.append('|---|---|---|---|')
for r in sorted(dead_on, key=lambda x: x['name']):
    c = (r['comment'] or '（无注释）').replace('|', '\\|').replace('\n', ' ')[:180]
    t = ', '.join(r['tests'][:3]) or '—'
    out.append(f"| `{r['name']}` | {r['envval']} | {c} | {t} |")

out.append('\n## 🟡 假开关：只被测试 mock，src/ 不读（%d 个）\n' % len(phantom))
out.append('比死旗标更坏——测试把它们当闸门 mock，于是"关着它"的断言其实什么都没验证。\n')
out.append('| flag | .env | 测试里怎么用 |')
out.append('|---|---|---|')
for r in sorted(phantom, key=lambda x: x['name']):
    out.append(f"| `{r['name']}` | {r['envval'] or '—'} | {', '.join(r['tests'][:3])} |")

out.append('\n## 生产开着的旗标（%d 个）\n' % len(on_rows))
out.append('| flag | 默认 | .env | 是什么（注释摘要） | 读者 |')
out.append('|---|---|---|---|---|')
for r in sorted(on_rows, key=lambda x: x['name']):
    c = (r['comment'] or '').replace('|', '\\|').replace('\n', ' ')[:150]
    rd = ', '.join(r['readers'][:4]) or ('**无人读**' if not r['destructured'] else '解构: ' + ', '.join(r['destructured'][:3]))
    out.append(f"| `{r['name']}` | {r['default']} | {r['envval']} | {c} | {rd} |")

out.append('\n## 关着的布尔旗标（%d 个）\n' % (len(bools) - len(on_rows)))
out.append('| flag | 默认 | .env | 是什么（注释摘要） |')
out.append('|---|---|---|---|')
for r in sorted([r for r in bools if not r['on']], key=lambda x: x['name']):
    c = (r['comment'] or '').replace('|', '\\|').replace('\n', ' ')[:150]
    out.append(f"| `{r['name']}` | {r['default']} | {r['envval'] or '—'} | {c} |")

out.append('\n## 非布尔参数（%d 个）\n' % (len(rows) - len(bools)))
out.append('| key | 默认 | .env | 是什么（注释摘要） |')
out.append('|---|---|---|---|')
for r in sorted([r for r in rows if not r['is_bool']], key=lambda x: x['name']):
    c = (r['comment'] or '').replace('|', '\\|').replace('\n', ' ')[:120]
    out.append(f"| `{r['name']}` | {r['default']} | {(r['envval'] or '—')[:40]} | {c} |")

out.append('\n## ✅ 已退役（2026-09-21）\n')
out.append('这些旗标曾出现在上面的死旗标表里，已经删掉——删的时候在 src/env.ts 原位'
           '留了注释说明为什么，避免下一个人再把它们加回来。\n')
out.append('| flag | 去向 |')
out.append('|---|---|')
out.append('| `PROACTIVE_PRESSURE_ENABLED` | 删（对应的独立 scan cron 已被 unified-tick 取代） |')
out.append('| `SCHEDULE_LLM_WAKE` | 删（机制从未落地） |')
out.append('| `AGENT_PROGRESS_PING_ENABLED` | 删（"确定性进度 ping"从未实现） |')
out.append('| `REPLY_MODE_ENABLED` | 删（"回复形态与安全分段"整个特性没接也没实现） |')
out.append('| `REPLY_ACK_THEN_EXPAND_ENABLED` | 同上 |')
out.append('| `REPLY_MICRO_REACTION_MAX_CHARS` | 同上 |')
out.append('| `REPLY_ACK_MAX_CHARS` | 同上 |')
out.append('| `REPLY_MAX_EXPANSION_SEGMENTS` | 同上 |')
out.append('| `TASK_PROGRESS_CODEACT_ENABLED` | 删（task-progress.ts 只读 TASK_PROGRESS_ENABLED） |')
out.append('| `TASK_PROGRESS_RESEARCH_ENABLED` | 同上 |')
out.append('| `GOAL_LONG_TERM_ENABLED` | **保留并真接上**：goals.ts 现在读它，关时 long_term 目标按 7 天窗口 stale |')
out.append('')
out.append('还没处理的（本轮不动，原因见下）：`CORE_BLACKBOARD_ENABLED` / '
           '`CORE_BELIEF_VIEW_ENABLED` / `CORE_PERMISSION_GATE_ENABLED` 是**假开关**——'
           'src/core/ 那一套无条件跑着，接它们要选对收口，接错会把在跑的东西关掉。'
           '`CODEACT_MAX_TURNS` / `TASK_MAX_ROUNDS` / `VERIFY_*` / `TTS_*` / '
           '`STREAMING_*` / `SEMANTIC_DUP_THRESHOLD` / `GROUNDING_*` / '
           '`JUDGE_PROACTIVE_*` / `EXPERIENCE_VERIFY_MIN_SUCCESS` / `DREAMING_USAGE` '
           '是参数型键，grep 不到读取点但可能被脚本或别处按名取用，删前要逐个确认。\n')

out.append('\n## src/ 里没人读的键（%d 个）\n' % len(dead))
out.append('| key | .env | 说明 |')
out.append('|---|---|---|')
for r in sorted(dead, key=lambda x: x['name']):
    out.append(f"| `{r['name']}` | {r['envval'] or '—'} | {(r['comment'] or '')[:100]} |")

open('docs/flag-census.md', 'w', encoding='utf8').write('\n'.join(out) + '\n')
json.dump({'summary': summary, 'rows': rows}, open('/tmp/flagcensus.json', 'w'), ensure_ascii=False, indent=1)

print(json.dumps(summary, indent=1))
print('\n=== 死旗标（开着但无人读）===')
for r in dead_on:
    print('  -', r['name'], '| .env =', r['envval'], '| tests:', ','.join(r['tests'][:2]) or '-')
print('\n=== 假开关（只被测试 mock）===')
for r in phantom:
    print('  -', r['name'])
