#!/usr/bin/env python3
"""Flag census — 把 env.ts 里每个 flag 的"是什么 / 默认 / .env 实际值 / 有没有人读"
合成一张真表。纯静态，不打数据库，不改任何东西。

输出: docs/flag-census.md（人读）+ /tmp/flagcensus.json（后续用）
"""
import glob
import json
import os
import re
import subprocess
from collections import defaultdict

SRC = 'src/env.ts'
ENVF = '.env'

# 2026-09-21：schema 体按子系统拆到 src/env-sections/*.ts 了，src/env.ts 只用
# spread 组合。所以这里改成**逐段文件**解析——顺带把 section 名记进每一行，
#  census 从"一坨清单"变成"按子系统可导航的清单"，这才是拆段的目的。
import glob

SECTION_ORDER = [
    'infra', 'memory', 'timing', 'judge', 'cognition', 'core',
    'self', 'turn', 'meta', 'features', 'social', 'life',
]


def parse_section(path: str, section: str) -> list[dict]:
    lines = open(path, encoding='utf8').read().split('\n')
    out: list[dict] = []
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
            out.append({
                'name': name,
                'section': section,
                'file': path.replace('src/', ''),
                'line': i + 1,
                'rhs': rhs[:120],
                'default': default,
                'comment': ' '.join(reversed(comment))[:400],
            })
        i += 1
    return out


flags: list[dict] = []
for sec in SECTION_ORDER:
    path = f'src/env-sections/{sec}.ts'
    if not os.path.exists(path):
        print(f'⚠️  缺段文件 {path}')
        continue
    flags.extend(parse_section(path, sec))

# src/env.ts 本体若还有裸键（拆段后不该有）也抓一遍，别静默漏掉
flags.extend(parse_section(SRC, '(env.ts 本体)'))

seen = set()
dups = [f['name'] for f in flags if f['name'] in seen or seen.add(f['name'])]
if dups:
    print(f'⚠️  跨段重复的键: {sorted(set(dups))}')

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

# ── 2b. 值打码 ────────────────────────────────────────────────────────────
# 2026-09-22：docs/flag-census.md 是公开仓库里的产物，而 .env 里躺着 BOT_TOKEN /
# GEMINI_API_KEY / COMMON_API_KEY / WEBHOOK_SECRET 等真实凭据。这个脚本原来的
# 设计目的就是「把 .env 实际值写进表里」，产物一 commit 就等于公开发布凭据
# （GitHub secret scanning 已经有公开泄露告警）。现在一律不输出原值：
# 纯布尔 / 纯数字保留（不是凭据，且「ON/off」这类信息是 census 的价值所在），
# 其余一律替换成 <redacted>。
REDACTED = '\x00REDACTED'

def mask(v):
    if v is None:
        return None
    t = v.strip().strip("'\"")
    if t.lower() in TRUE or t.lower() in FALSE:
        return t
    if re.fullmatch(r'-?\d+(\.\d+)?', t):
        return t
    return REDACTED

envmap = {k: mask(v) for k, v in envmap.items()}

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
    # **声明处不算读者**：src/env.ts 和 src/env-sections/*.ts 只是"这个键存在"，
    # 不是"有人读它"。2026-09-21 拆段后漏了这条，结果 21 个死键一夜之间全变成
    # "有读者"——因为它们的声明文件自己被当成了读者。
    return [
        p for p in out
        if not p.endswith('src/env.ts') and not p.startswith('src/env-sections/')
    ]


# 读取形态。**五种都要算**——2026-09-21 我据这份清单写过"三个 CORE_* 旗标全是假开关"，
# 其中两个其实是接好的（state.ts 用 `e.CORE_BELIEF_VIEW_ENABLED`，loop.ts 用
# `envShim().CORE_PERMISSION_GATE_ENABLED`）。第一版只 grep `env().FLAG`，幸亏
# bare_word 那一列把它们捞回来了；但叙述还是写错了。现在把 `e.FLAG` / `envShim().FLAG`
# 显式列出来，不靠运气。
def readers_of(name: str) -> dict[str, list[str]]:
    return {
        'env_getter': hits(rf'env\(\)\.{name}\b', ['src/']),
        'destructured': hits(rf'\b(e|ev|env0|e0|cfg)\.{name}\b', ['src/']),
        'env_shim': hits(rf'envShim\(\)\.{name}\b', ['src/']),
        'bare_word': hits(rf'\b{name}\b', ['src/', 'scripts/', 'packages/']),
        'process_env': hits(rf'process\.env\.{name}\b|process\.env\[.{{0,4}}{name}', ['src/', 'scripts/']),
        'tests': hits(rf'\b{name}\b', ['tests/']),
    }


usage: dict[str, dict[str, list[str]]] = {}
for f in flags:
    usage[f['name']] = readers_of(f['name'])

# ── 4. 汇总 ───────────────────────────────────────────────────────────────
rows = []
for f in flags:
    n = f['name']
    envval = envmap.get(n)
    is_bool = 'booleanFromEnv' in f['rhs']
    if envval == REDACTED:
        state = '=<redacted>'
    elif is_bool:
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
    # 活读者 = 四种读取形态的并集
    readers = sorted(set(u['env_getter']) | set(u['destructured']) | set(u['env_shim']))
    any_word = bool(u['bare_word']) or bool(u['process_env'])
    # 死 = src/scripts/packages 里一个字都不出现（四种读法都算过）
    dead = not any_word
    # 只被测试 mock、src 不读 = 假开关（测试以为关着它，其实什么都没发生）
    phantom = (not any_word) and bool(u['tests'])
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
        'destructured': [p.replace('src/', '') for p in sorted(set(u['destructured']) | set(u['env_shim']))],
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
out.append('# Flag census — 全量旗标清单\n')
out.append('生成方式：`python3 scripts/flag-census.py`（纯静态：逐段读 `src/env-sections/*.ts` 的注释与默认值 '
           '+ .env 实际值 + 五种读法 grep `src/`）。不打数据库、不改任何东西。\n')
out.append('2026-09-21 起 schema 按子系统拆成 `src/env-sections/*.ts`（`src/env.ts` 只用 spread 组合），'
           '所以这份清单**按段分组**、每行带「段」列——加旗标时先在这里找该进哪一段。'
           '另带「已退役」一节：删掉的旗标留名，免得下一个人再加回来。\n')
out.append('⚠️ 判定读者时**排除 `src/env.ts` 与 `src/env-sections/*`**——那两处只是"这个键存在"，'
           '不是"有人读它"。拆段当晚漏了这条，21 个死键一夜之间全变成"有读者"。\n')

SECTION_ORDER = ['infra', 'memory', 'timing', 'judge', 'cognition', 'core',
                 'self', 'turn', 'meta', 'features', 'social', 'life']
SECTION_DESC = {
    'infra': 'Telegram / Redis / SQLite / Qdrant / NyatDB / Server / 工具与密钥 / 跟踪 / 主人与身份 / 知识库 / 媒体开关',
    'memory': '主动参与、DM↔群记忆连结、长期记忆嵌入与相关性、CodeAct 长期记忆注入',
    'timing': 'Timing Gate（去抖 + 状态机 + LLM gate + talk-value + continuation）',
    'judge': '定型判断基座 + 深度反思',
    'cognition': 'AGI Level 4/5/6：经验沉淀、自我技能、爱好、经验验证、Dreaming、长期任务、证据门、Loop 策略、多智能体共享、世界状态、context rot、群体风格、ToM、记忆陈旧、Task 架构、反向阀门',
    'core': 'Core v2 Phase 0（Belief View + 黑板 ACL + L2 permission gate）+ 小模型增强',
    'self': '好奇心目标、自我模型、统一唤醒循环、StepFun 配额消费引擎、Mundo 难题攻坚',
    'turn': 'Turn Actor + Agentic planner + 中期记忆',
    'meta': 'Meta + Subagent 编排层',
    'features': 'StepFun 全网搜索、反广告行为气压、Silence Alert、Computer-use sandbox、Learner',
    'social': '主动搭话、RSS 监控、天气感知、其他 bot 命令学习、Multi-Agent 协调',
    'life': '硬作息门、DM 好感私聊、上学日程、心情漂移、自我叙事、NyatOS 影子、发言额度、关系叙事、TTS',
}
out.append('## 段索引\n')
out.append('拆段的主要收益就是这个：加旗标时知道该进哪个文件。\n')
out.append('| 段 | 文件 | 键数 | 布尔 | 生产开着 | 管什么 |')
out.append('|---|---|---|---|---|---|')
for _sec in SECTION_ORDER:
    _rs = [r for r in rows if r['section'] == _sec]
    if not _rs:
        continue
    _b = [r for r in _rs if r['is_bool']]
    out.append(f"| `{_sec}` | [`src/env-sections/{_sec}.ts`](../src/env-sections/{_sec}.ts) "
               f"| {len(_rs)} | {len(_b)} | {len([r for r in _b if r['on']])} | {SECTION_DESC.get(_sec, '')} |")
out.append('')
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
out.append('| flag | 段 | .env | 注释怎么说 | tests/ 里有吗 |')
out.append('|---|---|---|---|---|')
for r in sorted(dead_on, key=lambda x: x['name']):
    c = (r['comment'] or '（无注释）').replace('|', '\\|').replace('\n', ' ')[:180]
    t = ', '.join(r['tests'][:3]) or '—'
    out.append(f"| `{r['name']}` | {r['section']} | {r['envval']} | {c} | {t} |")

out.append('\n## 🟡 假开关：只被测试 mock，src/ 不读（%d 个）\n' % len(phantom))
out.append('比死旗标更坏——测试把它们当闸门 mock，于是"关着它"的断言其实什么都没验证。\n')
out.append('⚠️ 2026-09-21 更正：我曾据这份清单写过"CORE_BELIEF_VIEW_ENABLED / '
           'CORE_BLACKBOARD_ENABLED / CORE_PERMISSION_GATE_ENABLED 三个全是假开关，'
           'src/core/ 那一套无条件跑着"。**前两个说法错了**——BELIEF_VIEW 在 '
           'src/core/state.ts:49 被读（`e.CORE_BELIEF_VIEW_ENABLED`），PERMISSION_GATE 在 '
           'src/core/loop.ts:292 被读（`envShim().CORE_PERMISSION_GATE_ENABLED`）。'
           '只有 BLACKBOARD 是真的没人读。教训：读法不止 `env().FLAG` 一种，'
           '而"某一列是空"不等于"没人读"。\n')
out.append('| flag | 段 | .env | 测试里怎么用 |')
out.append('|---|---|---|---|')
for r in sorted(phantom, key=lambda x: x['name']):
    out.append(f"| `{r['name']}` | {r['section']} | {r['envval'] or '—'} | {', '.join(r['tests'][:3])} |")

out.append('\n## 生产开着的旗标（%d 个）\n' % len(on_rows))
out.append('按段分组、段内按名字排序——要加旗标时照这个找位置。\n')
out.append('| 段 | flag | 默认 | .env | 是什么（注释摘要） | 读者 |')
out.append('|---|---|---|---|---|---|')
for r in sorted(on_rows, key=lambda x: (x['section'], x['name'])):
    c = (r['comment'] or '').replace('|', '\\|').replace('\n', ' ')[:150]
    rd = ', '.join(r['readers'][:4]) or (
        '**无人读**' if not r['destructured']
        else '解构/envShim: ' + ', '.join(r['destructured'][:3])
    )
    out.append(f"| {r['section']} | `{r['name']}` | {r['default']} | {r['envval']} | {c} | {rd} |")

out.append('\n## 关着的布尔旗标（%d 个）\n' % (len(bools) - len(on_rows)))
out.append('| 段 | flag | 默认 | .env | 是什么（注释摘要） |')
out.append('|---|---|---|---|---|')
for r in sorted([r for r in bools if not r['on']], key=lambda x: (x['section'], x['name'])):
    c = (r['comment'] or '').replace('|', '\\|').replace('\n', ' ')[:150]
    out.append(f"| {r['section']} | `{r['name']}` | {r['default']} | {r['envval'] or '—'} | {c} |")

out.append('\n## 非布尔参数（%d 个）\n' % (len(rows) - len(bools)))
out.append('| 段 | key | 默认 | .env | 是什么（注释摘要） |')
out.append('|---|---|---|---|---|')
for r in sorted([r for r in rows if not r['is_bool']], key=lambda x: (x['section'], x['name'])):
    c = (r['comment'] or '').replace('|', '\\|').replace('\n', ' ')[:120]
    out.append(f"| {r['section']} | `{r['name']}` | {r['default']} | {(r['envval'] or '—')[:40]} | {c} |")

out.append('\n## ✅ 已退役（2026-09-21）\n')
out.append('这些旗标曾出现在上面的死旗标表里，已经删掉——删的时候在段文件原位'
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
out.append('| `CORE_BLACKBOARD_ENABLED` | **保留并真接上**：blackboard/store.ts 四个入口都读它 |')
out.append('| `GROUNDING_PRESENT_MAX` / `GROUNDING_ASKED_MAX` | **保留并真接上**：grounding-check.ts 原来写死 0.35 |')
out.append('| `EXPERIENCE_VERIFY_MIN_SUCCESS` | **保留并真接上**：experience-verify.ts 原来用硬编码默认 2 |')
out.append('| `TASK_MAX_ROUNDS` | **保留并真接上**：task-store.ts 原来写死 6 |')
out.append('')
out.append('### 2026-09-21 第二批退役（14 个，全仓核过无读者）\n')
out.append('| flag | 去向 |')
out.append('|---|---|')
out.append('| `DREAMING_USAGE` | 删（dreaming 实际 usage 在 cron 里另取） |')
out.append('| `CODEACT_MAX_TURNS` | 删（每段轮数上限是 executor.ts 写死的 30，不是这个 8） |')
out.append('| `TASK_PROGRESS_START_DELAY_MS` | 删（task-progress.ts 只读 KEEPALIVE/MIN_INTERVAL） |')
out.append('| `JUDGE_PROACTIVE_RATE` | 删（随机主动插话机制整个已删；ENABLED 仍在，但只门控上下文预计算） |')
out.append('| `JUDGE_PROACTIVE_MIN_INTERVAL_SEC` | 同上 |')
out.append('| `JUDGE_PROACTIVE_MIN_RECENT_MSGS` | 同上 |')
out.append('| `SEMANTIC_DUP_THRESHOLD` | 删（semantic-dup.ts 阈值写死 0.7） |')
out.append('| `STREAMING_MIN_INTERVAL` | 删（流式节流归 TASK_PROGRESS_* 管） |')
out.append('| `STREAMING_MIN_CHARS` | 删（同上） |')
out.append('| `TTS_VOICE_PROBABILITY` | 删（TTS 概率在发送路径另有一处） |')
out.append('| `TTS_MAX_CHARS` | 删（同上） |')
out.append('| `TURN_UNIFIED_DECISION_ENABLED` | 删（注释说"防 .env 报错"，但 zod 对未知键是剥离不是报错） |')
out.append('| `VERIFY_DEFAULT_TIMEOUT` | 删（入群验证超时来自 per-chat 的 group_verify_settings） |')
out.append('| `VERIFY_MAX_ATTEMPTS` | 删（同上） |')
out.append('')
out.append('### 保留但 grep 不到读者的 2 个\n')
out.append('`TS_WEBHOOK_URL` / `PHP_WEBHOOK_URL` —— **不是死键**：`scripts/cutover.sh` 用 shell 读它们。'
           'census 只 grep .ts/.mts/.js，所以它们出现在"没人读"表里。删它们会弄坏 cutover 脚本。\n')
out.append('')
out.append('还没处理的（本轮不动，原因见下）：`CORE_BLACKBOARD_ENABLED` 是唯一真的没人读的 '
           'CORE_* 旗标——blackboard 是 storage 层，被 agent/cognitive-workspace、'
           'agency-intent-adapter、core/promote、core/permission/gate 四个模块当存储用了，'
           '给它加闸门要同时管住读和写，接错会把在跑的东西关掉，所以留着单独一轮。'
           '（另两个 CORE_BELIEF_VIEW_ENABLED / CORE_PERMISSION_GATE_ENABLED 是**接好的**，'
           '见上面「假开关」一节的更正。）\n\n'
           '`CODEACT_MAX_TURNS` / `TASK_MAX_ROUNDS` / `VERIFY_*` / `TTS_*` / '
           '`STREAMING_*` / `SEMANTIC_DUP_THRESHOLD` / `GROUNDING_*` / '
           '`JUDGE_PROACTIVE_*` / `EXPERIENCE_VERIFY_MIN_SUCCESS` / `DREAMING_USAGE` '
           '是参数型键，grep 不到读取点但可能被脚本或别处按名取用，删前要逐个确认。\n')

out.append('\n## src/ 里没人读的键（%d 个）\n' % len(dead))
out.append('| key | 段 | .env | 说明 |')
out.append('|---|---|---|---|')
for r in sorted(dead, key=lambda x: x['name']):
    out.append(f"| `{r['name']}` | {r['section']} | {r['envval'] or '—'} | {(r['comment'] or '')[:100]} |")

open('docs/flag-census.md', 'w', encoding='utf8').write('\n'.join(out) + '\n')
json.dump({'summary': summary, 'rows': rows}, open('/tmp/flagcensus.json', 'w'), ensure_ascii=False, indent=1)

print(json.dumps(summary, indent=1))
print('\n=== 死旗标（开着但无人读）===')
for r in dead_on:
    print('  -', r['name'], '| .env =', r['envval'], '| tests:', ','.join(r['tests'][:2]) or '-')
print('\n=== 假开关（只被测试 mock）===')
for r in phantom:
    print('  -', r['name'])
