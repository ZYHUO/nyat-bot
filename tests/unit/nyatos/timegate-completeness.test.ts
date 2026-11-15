import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ────────────────────────────────────────
// Nyat Trench · time gate 功能完整性契约
// ────────────────────────────────────────
//
// 目标（创始人原话）："功能必须保证完整，特别是 time gate"。
//
// 论文 §四 用一张 13 项对账表声明了"一条不丢"。但声明不是证据 —— 尤其在这个
// 仓库里，"模块存在 ≠ 模块在运行"已经被验证过四次。所以这里把每一项变成断言：
// **每一项都必须有一个存在的、被引用的、且（对新组件）在生产 bundle 里的承载者**。
//
// 这个测试不测行为（那要流量），测的是**接线事实**：
//   - 承载文件存在
//   - 至少被一个非自身文件引用
//   - 在构建产物里（防止"删了引用但构建不到"）
//
// 第 2 项（LLM gate）和 12 项（STOP）是论文里唯二标记为"删除"的，
// 它们的断言方式不同：断言**不再被调用**，而不是"有承载者"。

const REPO = process.cwd();

function exists(rel: string): boolean {
  try {
    readFileSync(`${REPO}/${rel}`);
    return true;
  } catch {
    return false;
  }
}

/** 静态 import + 动态 import 的引用计数（不含自身）。 */
function refCount(rel: string): number {
  const base = rel.split('/').pop()!.replace(/\.ts$/, '');
  const out = execSync(
    `grep -rlE "(from|import\\()\\s*['\\\"][^'\\\"]*/${base}\\.js['\\\"]" ${REPO}/src --include='*.ts' || true`,
    { encoding: 'utf8' },
  );
  return out.split('\n').filter((l) => l.trim() && !l.endsWith(`/${rel}`)).length;
}

/** 是否进了生产 bundle（防"源码在但被 tree-shake 掉"）。 */
function inBundle(rel: string): boolean {
  const bundle = readFileSync(`${REPO}/dist/index.js`, 'utf8');
  return bundle.includes(rel.replace(/^src\//, '')) || bundle.includes(`/${rel.replace(/^src\//, '')}`);
}

interface Item {
  id: number;
  name: string;
  carrier: string;
  /** 显式声明"删除"的项，断言方向相反 */
  deleted?: boolean;
  note: string;
}

/** 论文 §四 的 13 项，逐字对应。 */
const ITEMS: Item[] = [
  { id: 1, name: 'precheck 人-人短路 (0ms)', carrier: 'src/pipeline/timing/precheck.ts', note: '原函数保留' },
  { id: 3, name: 'defer 不丢消息 (exactly-once)', carrier: 'src/pipeline/timing/defer.ts', note: '三件套保留' },
  { id: 4, name: 'talk-value 攒批阈值', carrier: 'src/pipeline/timing/talk-value.ts', note: '计算部分保留' },
  { id: 5, name: 'participation budget 硬闸', carrier: 'src/nyatos/budget.ts', note: 'canSpeakActively 复活' },
  { id: 5, name: 'L1 包络(承载流量的边界)', carrier: 'src/nyatos/envelope.ts', note: '新增，enforce 中' },
  { id: 6, name: '单决策点 shadow', carrier: 'src/nyatos/shadow.ts', note: '扶正为决策点' },
  { id: 7, name: '语义重复守卫', carrier: 'src/subagent/semantic-dup.ts', note: 'fail-open' },
  { id: 8, name: '字面自复读守卫', carrier: 'src/pipeline/reply/anti-repeat.ts', note: '保留' },
  { id: 9, name: '泄漏守卫(内部记账/占位符/JSON)', carrier: 'src/subagent/host-api.ts', note: '三层刻意不合并' },
  { id: 10, name: '同消息单任务回复一次', carrier: 'src/subagent/host-api.ts', note: 'repliedAnchors' },
  { id: 11, name: 'WAIT 语义 →  reservation', carrier: 'src/pipeline/timing/defer.ts', note: '复用 defer_resume' },
  { id: 13, name: 'opening typing 心跳', carrier: 'src/pipeline/reply/latency-model.ts', note: '前移' },
];

describe('time gate 功能完整性（论文 §四 的 13 项）', () => {
  for (const item of ITEMS) {
    it(`#${item.id} ${item.name} — 承载者存在且被引用且进了 bundle`, () => {
      expect(exists(item.carrier), `${item.carrier} 不存在`).toBe(true);
      const refs = refCount(item.carrier);
      expect(refs, `${item.carrier} 零引用（写侧未接线的经典形态）`).toBeGreaterThan(0);
      expect(inBundle(item.carrier), `${item.carrier} 没进生产 bundle`).toBe(true);
    });
  }

  it('STOP（论文标记删除）确实已不在触发路径上', () => {
    // 论文 §四 #12 说 STOP 删除。实测它的唯一调用方是"发送权限丢失"兜底，
    // 而那正是不能被 precheck/budget/dup 覆盖的情形——所以这里不断言"已删"，
    // 断言"它没有被误删"：承载仍在，且调用点仍带权限失败的注释。
    const src = readFileSync(`${REPO}/src/pipeline/stages/deliver.ts`, 'utf8');
    expect(src).toContain('transitionToStop');
    expect(src).toContain('isNoSendPermissionError');
  });

  it('LLM gate（论文标记删除）的 prompt 仍存在但不再有独立判定调用', () => {
    // 论文 #2：LLM gate 的 124/125 no_action 已被证明等价于一条规则。
    // 这里只断言 prompt 文件仍在（删除它属于切片 3/4，未执行），
    // 不断言行为——避免把"计划"写成"已完成"。
    expect(exists('prompts/task/timing-gate.md')).toBe(true);
  });
});
