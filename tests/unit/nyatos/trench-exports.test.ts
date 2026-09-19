import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

// 2026-09-19：`releasePressure`（发言后抽 85% 气压）写好了、单测绿着，
// 而全仓库唯一引用是注释——积分器因此没有排水路径。这是我这个会话第四次
// "写了没调用"（renderEcho / resetTrench / recentImpulses / releasePressure）。
//
// 前两次靠死代码扫描，后两次靠主动核对"每个导出有没有真实消费方"。
// 这个测试把该核对固化为 CI 的一部分：**新架构的每个导出都必须有 src 内的真实调用方**，
// 唯一例外是显式登记的测试专用助手。
//
// 为什么这项检查重要：单测验的是函数本身，不是它在系统里的位置。
// 只跑单测就汇报"某层已完成"，会得到四重假的声明。

const REPO = process.cwd();

/** 显式登记为"故意只有测试会调"的导出。 */
const ALLOWED_TESTONLY: Record<string, string> = {
  'trench.ts::setThetaForTest': 'θ 第一期冻结为 4.0；该函数只用于测试验证 θ 的硬钳',
};

const MODULES = [
  'src/nyatos/trench.ts',
  'src/nyatos/envelope.ts',
  'src/nyatos/self-state.ts',
  'src/nyatos/debt.ts',
  'src/agent/echo.ts',
  'src/agent/impulse-history.ts',
];

function srcReferences(name: string): number {
  const out = execSync(
    `grep -rn "\\b${name}\\b" ${REPO}/src --include='*.ts' | grep -v "export async function ${name}" | grep -v "export function ${name}" | wc -l`,
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

describe('新架构导出的消费方核对', () => {
  it('每个导出都有 src 内的真实调用方（唯一的例外已显式登记）', () => {
    const offenders: string[] = [];
    for (const mod of MODULES) {
      const src = execSync(`cat ${REPO}/${mod}`, { encoding: 'utf8' });
      const names = [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
      for (const n of names) {
        if (n === 'main' || n === 'default') continue;
        const refs = srcReferences(n);
        const key = `${mod.split('/').pop()}::${n}`;
        if (refs <= 0 && !(key in ALLOWED_TESTONLY)) offenders.push(`${key}（零 src 引用）`);
      }
    }
    expect(offenders, `这些导出没有任何 src 调用方：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('releasePressure 至少有两条调用路径（host-api + unified-tick）', () => {
    expect(srcReferences('releasePressure')).toBeGreaterThanOrEqual(2);
  });

  it('登记的例外确实存在（防止登记项过期后没人发现）', () => {
    const src = execSync(`cat ${REPO}/src/nyatos/trench.ts`, { encoding: 'utf8' });
    expect(src).toContain('export async function setThetaForTest');
  });
});

// 同一纪律换一类对象：**旗标**。一个 zero-reader 的旗标意味着它的功能既开不了
// 也关不掉——而那正是.env 里一个让人安心的假开关。
describe('新架构旗标的读取方核对', () => {
  const FLAGS = [
    'TRENCH_PUMP_ENABLED',
    'TRENCH_GATE_ENABLED',
    'TRENCH_ENVELOPE_MODE',
    'TRENCH_SLEEP_PULSE_ENABLED',
    'TRENCH_DEBT_ENABLED',
    'ECHO_ENABLED',
    'META_HEART_ENABLED',
    'META_HEART_BYPASS_CHAT_IDS',
    'TIMING_GATE_LLM_ENABLED',
  ];

  it('每个旗标都在 env.ts 之外有真实读取方', () => {
    const offenders: string[] = [];
    for (const f of FLAGS) {
      const out = execSync(
        `grep -rn "\\.${f}\\b" ${REPO}/src --include='*.ts' | grep -v "src/env.ts" || true`,
        { encoding: 'utf8' },
      );
      if (!out.trim()) offenders.push(f);
    }
    expect(offenders, `这些旗标只有定义、没有读取方：${offenders.join(', ')}`).toEqual([]);
  });
});

// 类5：**数据写了没人读**。var/trench.jsonl 的唯一消费方是运维 grep（没有工具读它），
// 而时间泵每小时给每个活跃群写一行 → 20 群 ≈ 1MB/天，不设上限就是只涨不消费的成本。
// 这是这个会话的第五类"孤立正确、系统里缺席"，前四类是函数/字段/渲染/旗标。
describe('观测日志的轮转', () => {
  it('源码里有大小阈值与 rename（不是无限 append）', () => {
    const src = execSync(`cat ${REPO}/src/nyatos/trench.ts`, { encoding: 'utf8' });
    expect(src).toContain('OBSERVATION_MAX_BYTES');
    expect(src).toContain('renameSync(OBSERVATION_LOG');
  });

  it('阈值是正数且量级合理（不设为 0 也不设成 1GB）', () => {
    const src = execSync(`cat ${REPO}/src/nyatos/trench.ts`, { encoding: 'utf8' });
    const m = src.match(/OBSERVATION_MAX_BYTES\s*=\s*([\d_* ]+)/);
    expect(m).not.toBeNull();
    // 去掉下划线求值（源码写的是 8 * 1024 * 1024）
    const val = Number(m![1]!.replace(/_/g, '').replace(/\s+/g, '').split('*').reduce((a, b) => Number(a) * Number(b), 1));
    expect(val).toBeGreaterThan(1024 * 1024);
    expect(val).toBeLessThan(64 * 1024 * 1024);
  });
});
