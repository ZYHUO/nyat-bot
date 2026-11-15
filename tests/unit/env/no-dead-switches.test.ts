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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { booleanFromEnv } from '../../../src/env-sections/_shared.js';

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

type Flag = ReturnType<typeof parseEnvFlags>[number];

/** Explicit candidate files must exist. CI without .env still audits schema defaults. */
function auditValues(explicitPath = process.env['NYATBOT_FLAG_AUDIT_ENV'], read = (path: string) => readFileSync(path, 'utf8')): Record<string, string> {
  try { return parseDotenv(read(explicitPath || '.env')); }
  catch (error) {
    if (!explicitPath && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Use the same coercion as production; explicit false overrides a true schema default. */
function effectiveTrueKeys(flags: Flag[], values: Record<string, string>): Set<string> {
  const on = new Set<string>();
  for (const flag of flags) {
    if (!flag.isBool) continue; // Numeric parameters (including 1) are not switches.
    const explicit = Object.prototype.hasOwnProperty.call(values, flag.name);
    const result = explicit ? booleanFromEnv.safeParse(values[flag.name]) : { success: true, data: flag.defaultTrue };
    if (!result.success) throw new Error(`Invalid boolean flag: ${flag.name}`); // Never print input values.
    if (result.data) on.add(flag.name);
  }
  return on;
}

function enabledFlags(): Set<string> { return effectiveTrueKeys(parseEnvFlags(), auditValues()); }

function readerFiles(): string[] {
  return [...walk('src'), ...walk('scripts'), ...walk('packages')]
    .filter((path) => {
      const normalized = path.replace(/\\/g, '/');
      return !normalized.endsWith('/env.ts') && !normalized.startsWith('src/env-sections/');
    });
}

function unreachableChildren(families: Array<[string, string[]]>, on: Set<string>): Array<{ parent: string; child: string }> {
  return families.flatMap(([parent, children]) => on.has(parent) ? []
    : children.filter((child) => on.has(child)).map((child) => ({ parent, child })));
}

describe('flag audit input semantics', () => {
  const flags: Flag[] = [
    { name: 'PARENT', isBool: true, defaultTrue: true },
    { name: 'CHILD', isBool: true, defaultTrue: true },
    { name: 'COUNT', isBool: false, defaultTrue: false },
  ];
  it('parses quotes/comments/duplicate assignments and boolean 1 like dotenv and the schema', () => {
    const values = parseDotenv('PARENT="false" # override\nCHILD="off"\nexport CHILD=\'1\'\nCOUNT=1');
    expect([...effectiveTrueKeys(flags, values)]).toEqual(['CHILD']);
  });
  it('uses schema defaults when .env is absent, but never silently ignores an explicit missing path', () => {
    const missing = () => { throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' }); };
    expect([...effectiveTrueKeys(flags, auditValues('', missing))]).toEqual(['PARENT', 'CHILD']);
    expect(() => auditValues('explicit-flags.env', missing)).toThrow('missing fixture');
  });
  it('rejects invalid boolean overrides without printing their contents', () => {
    expect(() => effectiveTrueKeys(flags, { CHILD: 'secret-invalid-value' })).toThrow(/^Invalid boolean flag: CHILD$/);
  });
  it('checks effective parent/child pairs including defaults and unrelated enabled families', () => {
    const families: Array<[string, string[]]> = [['PARENT', ['CHILD']], ['OTHER', ['OTHER_CHILD']]];
    expect(unreachableChildren(families, new Set(['CHILD', 'OTHER']))).toEqual([{ parent: 'PARENT', child: 'CHILD' }]);
    expect(unreachableChildren(families, effectiveTrueKeys(flags, { PARENT: 'false' }))).toEqual([{ parent: 'PARENT', child: 'CHILD' }]);
    expect(unreachableChildren(families, effectiveTrueKeys(flags, {}))).toEqual([]);
    expect(unreachableChildren(families, effectiveTrueKeys(flags, { PARENT: 'false', CHILD: 'false' }))).toEqual([]);
  });
});

describe('no dead switches', () => {
  it('explicit audit input contains only known boolean flags (no production secrets needed)', () => {
    if (!process.env['NYATBOT_FLAG_AUDIT_ENV']) return;
    const names = new Set(parseEnvFlags().filter((flag) => flag.isBool).map((flag) => flag.name));
    const unknown = Object.keys(auditValues()).filter((key) => !names.has(key));
    expect(unknown, 'NYATBOT_FLAG_AUDIT_ENV must contain only known boolean flag names').toEqual([]);
  });
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
    const on = enabledFlags();
    const files = readerFiles();
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
      if (!on.has(f.name)) continue;
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
    const files = readerFiles();
    const prepped = prepBlobs(files.map((p) => ({ s: readFileSync(p, 'utf8') })));
    const enabled = enabledFlags();
    const on = parseEnvFlags().filter((f) => f.isBool && enabled.has(f.name));

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
    const files = readerFiles();
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
    // src/pipeline/multiagent/flags.ts: both switches must be on.
    ['TURN_ACTOR_ENABLED', ['MULTI_AGENT_ENABLED']],
    ['MULTI_AGENT_ENABLED', [
      'MULTI_AGENT_MEMORY_ENABLED',
      'MULTI_AGENT_PERSONA_ENABLED',
      'MULTI_AGENT_PERSONA_CRITIC_ENABLED',
      'MULTI_AGENT_DIRECTOR_ENABLED',
      'MULTI_AGENT_CONTEXT_DIGEST_ENABLED',
      'MULTI_AGENT_CHAT_SPECIALISTS',
      'MULTI_AGENT_ROUTE_CONVERGENCE_ENABLED',
      'MULTI_AGENT_CHECKER_ENABLED',
      'MULTI_AGENT_CRITIC_ENABLED',
      // round 74 补：WRITER_SELECTOR 也在 orchestrator.ts:464，同一个父。
      // 上一轮列 FAMILIES 时漏了它——只看了 orchestrator 里 185/404 两个位置。
      'WRITER_SELECTOR_ENABLED',
    ]],
    ['MULTI_AGENT_CRITIC_ENABLED', ['MULTI_AGENT_CRITIC_ON_LOOKUP']],
    // round 4（v1.0 周期）：subagent 审计扫全库前缀找到的第二族。
    // `STEPFUN_CONSUMER_*` 是那个"8000M/月订阅用起来"的后台引擎，父开关切在
    // `cron/scheduler.ts:387`——**关时连 cron 都不注册**，四个子旗标
    // （CALLS_PER_TICK / CONCURRENCY / REFLECT_WEIGHT）的值全是死值。
    // .env 里现在父=false 而子旗标全有值（4 / 1 / 40），正是"父关子开"的形状。
    ['STEPFUN_CONSUMER_ENABLED', [
      'STEPFUN_CONSUMER_CALLS_PER_TICK',
      'STEPFUN_CONSUMER_CONCURRENCY',
      'STEPFUN_CONSUMER_REFLECT_WEIGHT',
    ]],
  ];
  /** Existing schema inconsistency only, never an exemption for a deployment candidate. */
  const DEFAULT_PARENT_GATED: Record<string, string> = {
    'TURN_ACTOR_ENABLED->MULTI_AGENT_ENABLED':
      'turn.ts defaults TURN_ACTOR to false while social.ts defaults MULTI_AGENT to true; flags.ts requires both. Track the existing default debt without accepting it in any supplied configuration.',
  };
  it('self-check：effective 配置没有未解释的父关子开，候选配置不使用历史生产豁免', () => {
    const defaultsOnly = !process.env['NYATBOT_FLAG_AUDIT_ENV'] && !existsSync('.env');
    const offenders = unreachableChildren(FAMILIES, enabledFlags())
      .filter(({ parent, child }) => !(defaultsOnly && DEFAULT_PARENT_GATED[`${parent}->${child}`]))
      .map(({ parent, child }) => `${child}=true but effective parent ${parent}=false`);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('self-check：父子关系键存在，schema 默认欠条只匹配仍不可达的确切父子对', () => {
    const flags = parseEnvFlags();
    const names = new Set(flags.map((flag) => flag.name));
    expect(FAMILIES.flatMap(([parent, children]) => [parent, ...children]).filter((name) => !names.has(name))).toEqual([]);
    const defaultProblems = new Set(unreachableChildren(FAMILIES, effectiveTrueKeys(flags, {}))
      .map(({ parent, child }) => `${parent}->${child}`));
    const stale = Object.keys(DEFAULT_PARENT_GATED).filter((pair) => !defaultProblems.has(pair));
    expect(stale, `schema 默认关系已修复，清掉对应欠条: ${stale.join(', ')}`).toEqual([]);
  });
});
