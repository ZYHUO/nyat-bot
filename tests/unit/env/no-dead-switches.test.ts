/**
 * 死开关守卫（dead-switch guard）。
 *
 * 这个会话反复踩同一类坑：**写了、测了、部署了，但没有任何东西读它**。
 *   · `canSpeakActively()` 全仓库唯一引用是它自己的定义（论文 §1.2）
 *   · `renderEcho` / `resetTrench` / `recentImpulses` / `releasePressure` 一个个
 *     "写了没调用"，其中一个还是 L0 积分器的主要排水路径
 *   · 入群筛查的 `extractJoinerName` 从错误的模块 import，运行时拿到 undefined，
 *     一调用就抛、被 catch 吞掉——而 typecheck 一直是红的，vitest 全绿
 *   · 旗标审计：9 个 `.env` 里开着的旗标，src/ 里一个字都没有
 *
 * 单测测的是"这个函数按它写的逻辑工作"，测不了"它被接上了"。
 * 这个测试补第二半：**任何在 .env 里开着（或默认开着）的旗标，必须有读者。**
 *
 * 新加旗标时如果忘了接线，这里会红——比等到审计时才发现好。
 * 真的需要"先加旗标后接线"，把它加进 ALLOWLIST 并写原因，别把测试关掉。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 已知例外。每条都要写原因——这是欠条，不是免责声明。 */
const ALLOWLIST: Record<string, string> = {
  // 假开关：src/core/blackboard/ 那一套**无条件跑着**（导入方是
  // agent/cognitive-workspace、agency-intent-adapter、core/promote、
  // core/permission/gate），这个旗标从未门控任何东西。接它要选收口，
  // 接错会把在跑的东西关掉——比留着危险。留到单独一轮处理。
  CORE_BLACKBOARD_ENABLED: 'src/core/blackboard 无条件跑，旗标是假开关；接线需单独一轮',
  // 只被测试 mock、src 不读（judge 的主动插话概率三件套）。
  // 真机制在别处（heart / unified-tick），这三个名字从未被代码读过。
  JUDGE_PROACTIVE_RATE: '只被 tests/unit/judge/rules.test.ts mock；真机制不读它',
  JUDGE_PROACTIVE_MIN_INTERVAL_SEC: '同上',
  JUDGE_PROACTIVE_MIN_RECENT_MSGS: '同上',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js)$/.test(entry)) out.push(p);
  }
  return out;
}

/** env.ts 里的旗标名 + 默认值 + 是否布尔。 */
function parseEnvFlags(): Array<{ name: string; isBool: boolean; defaultTrue: boolean }> {
  const src = readFileSync('src/env.ts', 'utf8');
  const out: Array<{ name: string; isBool: boolean; defaultTrue: boolean }> = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^ {2}([A-Z][A-Z0-9_]+):\s*(.+?),\s*$/);
    if (!m) continue;
    const isBool = /booleanFromEnv/.test(m[2]);
    const dm = m[2]!.match(/booleanFromEnv\.default\((\w+)\)/);
    out.push({
      name: m[1]!,
      isBool,
      defaultTrue: isBool && dm?.[1] === 'true',
    });
  }
  return out;
}

/** .env 里显式设成 true 的键。 */
function envTrueKeys(): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const [k, v] = t.split('=', 2) as [string, string];
    if (['true', '1', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())) out.add(k.trim());
  }
  return out;
}

describe('no dead switches', () => {
  it('每个开着的布尔旗标都有读者（env().X / 解构 / process.env.X 三种读法都算）', () => {
    const flags = parseEnvFlags();
    const trueInEnv = envTrueKeys();
    const files = [...walk('src'), ...walk('scripts'), ...walk('packages')]
      .filter((p) => !p.endsWith('env.ts'));

    // 一次性读盘，别为每个旗标重读 600 个文件
    const blobs = files.map((p) => ({ p, s: readFileSync(p, 'utf8') }));
    const hasReader = (name: string): boolean =>
      blobs.some(
        ({ s }) =>
          s.includes(`env().${name}`) ||
          s.includes(`env(). ${name}`) ||
          new RegExp(`\\b${name}\\b`).test(s.replace(/^\/\/.*$/gm, '')),
      );

    const dead: string[] = [];
    for (const f of flags) {
      if (!f.isBool) continue;
      const on = trueInEnv.has(f.name) || f.defaultTrue;
      if (!on) continue;
      if (ALLOWLIST[f.name]) continue;
      if (!hasReader(f.name)) dead.push(f.name);
    }

    expect(
      dead,
      `这些旗标开着但代码里没有读者（"写了没接"）：\n  ${dead.join('\n  ')}\n` +
        '要么接线，要么加进 ALLOWLIST 并写原因。',
    ).toEqual([]);
  });

  it('ALLOWLIST 里的每一项都还真的没有读者（欠条到期要清）', () => {
    const files = [...walk('src'), ...walk('scripts'), ...walk('packages')]
      .filter((p) => !p.endsWith('env.ts'));
    const blobs = files.map((p) => readFileSync(p, 'utf8'));
    const wired: string[] = [];
    for (const name of Object.keys(ALLOWLIST)) {
      const read = blobs.some((s) => s.includes(`env().${name}`));
      if (read) wired.push(name);
    }
    expect(
      wired,
      `这些旗标已经接上了，从 ALLOWLIST 里删掉：${wired.join(', ')}`,
    ).toEqual([]);
  });
});
