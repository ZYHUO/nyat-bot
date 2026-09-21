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

/**
 * 已知例外。每条都要写原因——这是欠条，不是免责声明。
 *
 * 2026-09-21 清空过一次：这里原来躺着三个已退役旗标的过期豁免
 * （JUDGE_PROACTIVE_RATE / MIN_INTERVAL_SEC / MIN_RECENT_MSGS，第四轮就删了，
 * 连 rules.test.ts 里对它们的 mock 都清了），但 ALLOWLIST 没跟着清。
 *
 * 死豁免比没有豁免更危险：它不报错，只是安静地等着——将来谁再用其中一个名字
 * 加旗标，那个旗标**自动免检**，而旁边挂着的理由是三个月前针对另一个东西写的。
 * 所以下面有一条 self-check 盯着"ALLOWLIST 的每个键都还在 schema 里"。
 */
const ALLOWLIST: Record<string, string> = {};

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

/**
 * 旗标名 + 默认值 + 是否布尔。
 *
 * 2026-09-21 schema 按子系统拆到 `src/env-sections/*.ts` 之后，这里**必须**跟着改——
 * 否则它读 src/env.ts 只会看到 12 行 `...xxxSection,`，一个键都解析不到，
 * 于是"每个开着的旗标都有读者"变成**空集合上的恒真命题**：测试全绿，
 * 而 21 个死键一个都没少。守卫自己也需要守卫，见下面那个 self-check。
 */
function parseEnvFlags(): Array<{ name: string; isBool: boolean; defaultTrue: boolean }> {
  const out: Array<{ name: string; isBool: boolean; defaultTrue: boolean }> = [];
  for (const f of readdirSync('src/env-sections')) {
    if (!f.endsWith('.ts') || f === '_shared.ts') continue;
    for (const line of readFileSync(`src/env-sections/${f}`, 'utf8').split('\n')) {
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
  }
  return out;
}

/**
 * 每个文件里 env() 的别名。
 *
 * 为什么需要它：主断言用 `\bNAME\b` 兜底，太松——旗标名出现在任何非注释地方
 * （日志文案、别的标识符、文档字符串）都算"有读者"。实测 188 个开着的布尔旗标里
 * 有 72 个只能靠这个兜底认出来，而其中绝大多数其实是 `const e = env(); … e.FLAG`
 * 这种**解构/别名读法**——是真读者，但守卫说不上来它是怎么读的。
 *
 * 把别名读法显式认下来之后，剩下的"只靠裸词匹配"从 72 降到 6。那 6 个逐个查过，
 * 全是把 env 子集当参数传进来的真读法（如 heart-route.ts 的 `if (f.META_HEART_ENABLED)`）。
 * 所以它们不是死开关，但守卫**证明不了**——于是把这份名单钉在下面，
 * 多出一个就要求人来看。这比"永远绿灯"强。
 */
const WEAK_ONLY_READERS: ReadonlySet<string> = new Set([
  // deliver.ts 里 e.X（e 是从参数/别处拿到的 env 子集，不是本文件 const e = env()）
  'REPLY_HUMANIZER_SAFE_MODE',
  'TIMING_WAIT_HINT_ENABLED',
  'MOOD_TUNE_ENABLED',
  'TURN_UNANSWERED_REVISIT_ENABLED',
  // heart-route.ts:72 `if (f.META_HEART_ENABLED) return 'heart'`（f 是参数）
  'META_HEART_ENABLED',
]);

function aliasesIn(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\b(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*env\(\s*\)/g)) out.add(m[1]!);
  for (const m of src.matchAll(/\b(?:const|let)\s*\{\s*([^}]*?)\s*\}\s*=\s*env\(\s*\)/g)) {
    for (const part of m[1]!.split(',')) {
      const n = part.split(':')[0]!.trim();
      if (n) out.add(n);
    }
  }
  return [...out];
}

/** 读者强度：strong = 能确定在读 env；alias = 经别名读；weak = 只剩裸词匹配。 */
type ReaderKind = 'strong' | 'alias' | 'weak' | 'none';

interface Prepped { noComment: string; noStr: string; aliases: string[] }

/** 预处理一次，别为每个旗标重读 514 个文件（第一版这么写，直接超时 5s）。 */
function prepBlobs(blobs: Array<{ s: string }>): Prepped[] {
  return blobs.map(({ s }) => {
    const noComment = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\/\/.*$/gm, '');
    const noStr = noComment.replace(/"[^"\n]*"/g, '""').replace(/'[^'\n]*'/g, "''");
    return { noComment, noStr, aliases: aliasesIn(noComment) };
  });
}

function classifyReader(name: string, prepped: Prepped[]): ReaderKind {
  // 三遍扫描，**不能合成一遍**：第一版把 strong 和 alias 放进同一个 for，
  // 于是"第 3 个文件里能确定是 env().X"会被"第 1 个文件里的别名匹配"抢先返回，
  // 分类结果取决于文件遍历顺序。
  for (const f of prepped) {
    if (new RegExp(`env\\(\\)[\\.\\s]+${name}\\b`).test(f.noComment)) return 'strong';
    if (new RegExp(`envShim\\(\\)\\.${name}\\b`).test(f.noComment)) return 'strong';
    if (new RegExp(`process\\.env\\.${name}\\b`).test(f.noComment)) return 'strong';
    if (new RegExp(`\\[\\s*['"\`]${name}['"\`]\\s*\\]`).test(f.noComment)) return 'strong';
  }
  for (const f of prepped) {
    for (const a of f.aliases) {
      if (new RegExp(`\\b${a}\\.${name}\\b`).test(f.noStr)) return 'alias';
    }
  }
  for (const f of prepped) {
    if (new RegExp(`\\b${name}\\b`).test(f.noStr)) return 'weak';
  }
  return 'none';
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
  // 守卫自己的守卫：解析不到旗标 = 下面的断言是空集合上的恒真命题。
  // 2026-09-21 拆段时就差点这么静默失效（schema 搬走了，这里还在读旧位置）。
  it('self-check：真的解析到了旗标（否则后面全是空集合上的恒真）', () => {
    const flags = parseEnvFlags();
    expect(flags.length).toBeGreaterThan(400); // 拆段后是 495
    expect(flags.filter((f) => f.isBool).length).toBeGreaterThan(150); // 215
    // 抽几个不同段的键，确认不是只读到一个文件
    const names = new Set(flags.map((f) => f.name));
    for (const k of ['BOT_TOKEN', 'TIMING_GATE_ENABLED', 'CORE_V2_ENABLED', 'AGENT_TASK_SEND_BUDGET', 'VIDEO_DESCRIBE_ENABLED', 'NYATOS_BUDGET_MAX_ACTS']) {
      expect(names.has(k), `没解析到 ${k}——段文件漏了？`).toBe(true);
    }
  });

  it('每个开着的布尔旗标都有读者（env().X / 解构 / process.env.X 三种读法都算）', () => {
    const flags = parseEnvFlags();
    const trueInEnv = envTrueKeys();
    const files = [...walk('src'), ...walk('scripts'), ...walk('packages')]
      .filter((p) => !p.endsWith('env.ts') && !p.startsWith('src/env-sections/'));
    // **声明处不算读者**：src/env.ts 与 src/env-sections/*.ts 只是"这个键存在"，
    // 不是"有人读它"。2026-09-21 schema 按子系统拆段后漏了这条——段文件自己
    // 被当成读者，守卫一夜之间全绿，而 21 个死键一个都没少。

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

  // 守卫自己的守卫·二：ALLOWLIST 里的键必须还在 schema 里。
  // 2026-09-21 加。此前这里躺着三个已退役旗标的条目——旗标删了、mock 清了，
  // 豁免没清，于是一个静默的地雷放了很久。死豁免不报错，只是安静地等着。
  it('self-check：ALLOWLIST 里没有死豁免（键必须还在 schema 里）', () => {
    const names = new Set(parseEnvFlags().map((f) => f.name));
    const stale = Object.keys(ALLOWLIST).filter((k) => !names.has(k));
    expect(
      stale,
      `这些 ALLOWLIST 条目对应的旗标已经不在 schema 里了——清掉它们，\n` +
        `否则将来有人再用这些名字加旗标，会自动免检：\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  // 读者强度分级：把"只靠裸词匹配"的名单钉住。
  //
  // 主断言用 `\bNAME\b` 兜底，太松——旗标名出现在日志文案里都算有读者。
  // 这个测试不替代主断言（主断言语义上更安全），它只是让**松的那部分可见**：
  // 188 个开着的布尔旗标里，72 个只能靠兜底认出，显式认下别名读法之后剩 6 个。
  // 那 6 个逐个查过都是真读法，但守卫证明不了——所以钉住名单，多一个就停下来看。
  it('只靠裸词匹配的旗标名单没有变长（松的那部分要可见）', () => {
    const files = [...walk('src'), ...walk('scripts'), ...walk('packages')]
      .filter((p) => !p.endsWith('env.ts') && !p.startsWith('src/env-sections/'));
    const prepped = prepBlobs(files.map((p) => ({ s: readFileSync(p, 'utf8') })));
    const trueInEnv = envTrueKeys();
    const on = parseEnvFlags().filter((f) => f.isBool && (trueInEnv.has(f.name) || f.defaultTrue));

    const weak: string[] = [];
    const none: string[] = [];
    for (const f of on) {
      const kind = classifyReader(f.name, prepped);
      if (kind === 'weak') weak.push(f.name);
      if (kind === 'none') none.push(f.name);
    }
    // none 比 weak 更糟：连裸词都匹配不到。那一定是漏了某种读法（本会话见过：
    // `current['FLAG']` 方括号读法），要么补进 classifyReader，要么它真是死开关。
    expect(none, `这些开着的旗标一种读法都认不出来——先查是不是漏了读法：\n  ${none.join('\n  ')}`).toEqual([]);
    const extra = weak.filter((n) => !WEAK_ONLY_READERS.has(n));
    expect(
      extra,
      `这些旗标只剩裸词匹配、证明不了是读者。要么把它加进 WEAK_ONLY_READERS 并注明读法，\n` +
        `要么它真是死开关（接上线或退役）：\n  ${extra.join('\n  ')}`,
    ).toEqual([]);
    // 反向：名单里的如果已经能显式认出，就从名单里删掉（欠条到期要清）
    const stale = [...WEAK_ONLY_READERS].filter((n) => classifyReader(n, prepped) !== 'weak');
    expect(stale, `这些已经能显式认出读法了，从 WEAK_ONLY_READERS 删掉：${stale.join(', ')}`).toEqual([]);
  });

  it('ALLOWLIST 里的每一项都还真的没有读者（欠条到期要清）', () => {
    const files = [...walk('src'), ...walk('scripts'), ...walk('packages')]
      .filter((p) => !p.endsWith('env.ts') && !p.startsWith('src/env-sections/'));
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

  // 守卫自己的守卫·三：**父旗标关着，子旗标开着**——子旗标有读者却永远不可达。
  //
  // 2026-09-21 发现：`MULTI_AGENT_PERSONA_ENABLED` / `_PERSONA_CRITIC_` /
  // `_MEMORY_` / `_DIRECTOR_` 四个在 .env 里全是 true，读者也在
  // （src/pipeline/multiagent/orchestrator.ts:185/404），所以"有读者"那条检查全过
  // ——但它们的父 `MULTI_AGENT_ENABLED=false`，整条编排器从来没跑过。
  // 生产日志里 `Multi-agent: persona-critic rewrite` 0 次。
  //
  // "有读者"和"可达"是两件事：读者在一条被父旗标关掉的分支里，等于没有。
  //
  // 处理方式和 ALLOWLIST 同款：**故意留着的要写理由**，没写理由的一律算漏配。
  // 这样下一个"父关子开"出现时必须有人决定"是开父还是关子"，不会静默躺着。
  const FAMILIES: Array<[parent: string, children: string[]]> = [
    ['MULTI_AGENT_ENABLED', [
      'MULTI_AGENT_MEMORY_ENABLED',
      'MULTI_AGENT_PERSONA_ENABLED',
      'MULTI_AGENT_PERSONA_CRITIC_ENABLED',
      'MULTI_AGENT_DIRECTOR_ENABLED',
      // round 74 补：WRITER_SELECTOR 也在 orchestrator.ts:464，同一个父。
      // 上一轮列 FAMILIES 时漏了它——只看了 orchestrator 里 185/404 两个位置。
      'WRITER_SELECTOR_ENABLED',
    ]],
  ];
  /** 父关着但子旗标故意开着的，写理由。没在这里的一律算漏配。 */
  const PARENT_GATED: Record<string, string> = {
    MULTI_AGENT_PERSONA_ENABLED: '人设员是"身份认知加强"要用的机制；父 MULTI_AGENT_ENABLED=false 是生产选择（并行专家贵、无生产证据），不是忘了开。开父之前它就该是 true。',
    MULTI_AGENT_PERSONA_CRITIC_ENABLED: '同上：人设批评员，等父旗标。',
    MULTI_AGENT_MEMORY_ENABLED: '记忆专家，等父旗标。',
    MULTI_AGENT_DIRECTOR_ENABLED: '导演，等父旗标。',
    WRITER_SELECTOR_ENABLED: '写手择优选择，在 orchestrator.ts:464，等父旗标。',
  };
  it('self-check：没有"父关子开"且没写理由的不可达旗标', () => {
    const on = envTrueKeys();
    const offenders: string[] = [];
    for (const [parent, children] of FAMILIES) {
      if (on.has(parent)) continue;             // 父开着 → 子旗标可达
      for (const c of children) {
        if (!on.has(c)) continue;               // 子也关着 → 一致
        if (!PARENT_GATED[c]) {
          offenders.push(`${c}=true 但父 ${parent}=false → 永远不可达，且没在 PARENT_GATED 里写理由`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('self-check：PARENT_GATED 里没有过期条目（父开了就该清掉）', () => {
    const on = envTrueKeys();
    const stale = Object.keys(PARENT_GATED).filter((c) => on.has(c) && FAMILIES.some(([p]) => on.has(p)));
    expect(stale, `父旗标已开，这些子旗标的理由该删了: ${stale.join(', ')}`).toEqual([]);
  });
});
