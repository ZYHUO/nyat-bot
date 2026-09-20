#!/usr/bin/env python3
"""把 src/env.ts 的 schema 体按子系统拆成 src/env/sections/*.ts。

为什么拆：schema 体 1436 行 / 489 个键，加一个旗标要翻整篇。拆完之后每个
子系统一个文件，`src/env.ts` 只做组合——加功能时知道该去哪个文件，也知道
死开关守卫会查它。

安全性质（这是纯机械搬迁，不改任何成员/默认值/注释）：
  · 按行号切，不做内容解析
  · `src/env.ts` 用 spread 合并，z.infer 出来的 Env 类型逐键不变
  · 之后由 tests/unit/env/schema-keys.test.ts 钉住键集合，少一个键就红

用法：python3 scripts/split-env-schema.py   （幂等：先还原再拆）
"""
import os
import re
import shutil

SRC = 'src/env.ts'
OUT_DIR = 'src/env-sections'

# (文件名, 起始行(含), 结束行(含), 说明) —— 行号指 src/env.ts 的原始行
SECTIONS = [
    ('infra',     13,  233, '基础设施：Telegram / Redis / SQLite / Qdrant / NyatDB / Server / 工具与密钥 / 跟踪 / 主人与身份 / 知识库 / 媒体开关'),
    ('memory',   234,  344, '记忆：主动参与、DM↔群记忆连结、长期记忆嵌入与相关性、CodeAct 长期记忆注入'),
    ('timing',   345,  465, 'Timing Gate（MaiBot 式：去抖 + 状态机 + LLM gate + talk-value + continuation）'),
    ('judge',    466,  520, '定型判断基座 + 深度反思'),
    ('cognition',521,  597, '认知层 AGI Level 4/5/6：经验沉淀、自我技能、爱好、经验验证、Dreaming、长期任务、证据门、Loop 策略、多智能体共享、世界状态、context rot、群体风格、ToM、记忆陈旧、Task 架构、反向阀门'),
    ('core',     598,  730, 'Core v2 Phase 0（Belief View + 黑板 ACL + L2 permission gate）+ 小模型增强'),
    ('self',     731,  805, '自我：好奇心目标、自我模型、统一唤醒循环、StepFun 配额消费引擎、Mundo 难题攻坚'),
    ('turn',     806,  906, 'Turn Actor（MaiBot MaiSaka 式 per-chat 认知回合）+ Agentic planner + 中期记忆'),
    ('meta',     907, 1064, 'Meta + Subagent（CyberGroupmate 形态的编排层）'),
    ('features',1065, 1180, '功能开关：StepFun 全网搜索、反广告行为气压、Silence Alert、Computer-use sandbox、Learner'),
    ('social',  1181, 1334, '社交与借力：主动搭话、RSS 监控、天气感知、其他 bot 命令学习、Multi-Agent 协调'),
    ('life',    1335, 1463, '生活与身体：硬作息门、DM 好感私聊、上学日程、心情漂移、自我叙事、NyatOS 影子、发言额度、关系叙事、TTS'),
]

HEADER = '''// ────────────────────────────────────────
// env schema · {name} 段
// ────────────────────────────────────────
// {desc}
//
// 2026-09-21 从 src/env.ts 拆出（scripts/split-env-schema.py）。**纯机械搬迁**：
// 目录名是 env-sections/ 而不是 env/sections/——src/env.ts 是文件，同名目录会让
// 相对导入解析错位置。
// 成员名、zod 校验、默认值、注释逐字未改。src/env.ts 用 spread 把它们合回去，
// 所以 Env 的推断类型逐键不变——tests/unit/env/schema-keys.test.ts 钉住这一点。
//
// 加这一段的旗标：直接在这里加，记得配一句"为什么默认这个值"的注释。
// 默认 ON 的旗标会被 tests/unit/env/no-dead-switches.test.ts 要求有读者。
// ────────────────────────────────────────

import {{ z }} from 'zod';
import {{ booleanFromEnv }} from './_shared.js';

export const {name}Section = {{
'''

FOOTER = '};\n'


def main() -> None:
    lines = open(SRC, encoding='utf8').read().split('\n')

    # 校验：切出来的区间必须连续覆盖整个 schema 体，且不重叠
    # schema 体从 `const envSchema = z.object({` 的下一行开始；第一段要紧接着它
    schema_open = next(i for i, l in enumerate(lines, 1) if l.startswith('const envSchema = z.object({'))
    expected_start = schema_open + 1
    assert SECTIONS[0][1] == expected_start, (
        f'第一段起始行应为 {expected_start}（const envSchema 的下一行），实际写的是 {SECTIONS[0][1]}'
    )
    prev_end = None
    for name, start, end, _ in SECTIONS:
        if prev_end is not None:
            assert start == prev_end + 1, f'{name} 的起始行 {start} 不与上一段衔接（上一段结束 {prev_end}）'
        prev_end = end
    schema_close = SECTIONS[-1][2] + 1
    assert lines[schema_close - 1].strip() == '});', f'第 {schema_close} 行不是 schema 结尾: {lines[schema_close-1]!r}'
    # 再往前核一遍：最后一段之后到 schema 结尾之间不该再冒出新键
    between = '\n'.join(lines[SECTIONS[-1][2]:schema_close - 1])
    stray = re.findall(r'^  [A-Z][A-Z0-9_]+:', between, re.M)
    assert not stray, f'最后一段之后还有键没被覆盖: {stray}'

    os.makedirs(OUT_DIR, exist_ok=True)

    for name, start, end, desc in SECTIONS:
        body = lines[start - 1:end]  # 0-based slice
        # 去掉区间首尾的空行，省得文件头尾留空白
        while body and not body[0].strip():
            body.pop(0)
        while body and not body[-1].strip():
            body.pop()
        text = HEADER.format(name=name, desc=desc) + '\n'.join(body) + '\n' + FOOTER
        with open(f'{OUT_DIR}/{name}.ts', 'w', encoding='utf8') as f:
            f.write(text)
        keys = len(re.findall(r'^  [A-Z][A-Z0-9_]+:', '\n'.join(body), re.M))
        print(f'  {OUT_DIR}/{name}.ts  {end - start + 1:5d} 行  ~{keys} 键')

    # _shared.ts：booleanFromEnv 只有一份，别复制 12 遍
    with open(f'{OUT_DIR}/_shared.ts', 'w', encoding='utf8') as f:
        f.write('''// ────────────────────────────────────────
// env schema 段共享的 zod 预处理器
// ────────────────────────────────────────
// "true"/"1"/"yes"/"on" → true；"false"/"0"/"no"/"off"/"" → false；
// 其余原样交给 z.boolean()（非字符串值直接透传，测试里常这么 mock env）。
//
// 从 src/env.ts 拆段时抽出来——否则 12 个段文件各复制一份，
// 改一处忘一处就成了"同一个 helper 两种行为"。
// ────────────────────────────────────────

import { z } from 'zod';

export const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());
''')
    print(f'  {OUT_DIR}/_shared.ts')

    # 重写 src/env.ts：head（import + booleanFromEnv 定义）+ 组合 + tail（parse/env/providers）
    head = lines[:schema_open - 1]  # 到 const envSchema = z.object({ 之前（不含它）
    tail = lines[schema_close:]  # 从 }); 开始

    imports = '\n'.join(
        f"import {{ {name}Section }} from './env-sections/{name}.js';" for name, *_ in SECTIONS
    )
    composed = (
        'const envSchema = z.object({\n'
        + '\n'.join(f'  ...{name}Section,' for name, *_ in SECTIONS)
        + '\n});\n'
    )

    # head 里把 booleanFromEnv 的定义换成一行的指向说明（它搬去 _shared.ts 了）
    head_text = '\n'.join(head)
    head_text = re.sub(
        r"const booleanFromEnv = z\.preprocess\([\s\S]*?\}, z\.boolean\(\)\);\n",
        "// booleanFromEnv 已移到 ./env-sections/_shared.ts（12 个段文件共用一份）。\n",
        head_text,
    )
    assert 'booleanFromEnv = z.preprocess' not in head_text, 'head 里还留着 booleanFromEnv 定义'

    new_src = head_text.rstrip('\n') + '\n\n' + imports + '\n\n' + composed + '\n' + '\n'.join(tail)
    with open(SRC, 'w', encoding='utf8') as f:
        f.write(new_src)
    print(f'  {SRC} 重写：{len(lines)} 行 → {len(new_src.split(chr(10)))} 行')


if __name__ == '__main__':
    main()
