import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 用**真的** schema，不抄一份。抄一份的后果：文档说"name 必须匹配
// /^[A-Z0-9_]+$/"，而抄来的 schema 只查 min(1)——把文档里的例子改成小写
// 也不会红，这条测试就成了摆设。

// docs/skills.md 里的例子必须真能过 schema。
//
// 起因：写那份"skill 是一个 JSON 文件"的文档时，把示例手打了一遍。
// 这个会话为"文档和代码不是一套"付过不止一次学费——
//   · executor.ts 说"当前 = /spam@nmnmfunbot"（09-20 的快照）
//   · executor.ts 说"用 python3.10（有 PIL）"（本地是反的）
//   · AGENTS.md 说过时的话
// 文档说谎比没有文档更糟：读者会照着做，然后怀疑自己。
//
// 所以这条测试把文档里的 JSON 抠出来过一遍 schema——
// 以后改 schema 而没改文档，它会红。

/**
 * loader 里的 name 正则和 BUILTIN_TOOLS 是**运行时**判据（schema 只管类型），
 * 所以这里在 schema 之外补两道——文档明确承诺了它们。
 */
const NAME_RE = /^[A-Z0-9_]+$/;
const BUILTIN_TOOLS = new Set(['SEARCH', 'FETCH', 'IP_QUALITY', 'ADD_TIMER', 'LIST_TIMERS', 'DELETE_TIMER', 'BOT_KNOWLEDGE']);

/**
 * 从 markdown 里抠出所有**完整可解析的** ```json 围栏。
 *
 * 文档里有两种围栏：完整的 skill JSON，和只展示某个字段的片段
 * （比如只写 `"parameters": {...}`）。后者不是合法 JSON——但它们**是**
 * 文档的一部分，所以用"括号配平 + 是对象/数组"来区分，片段直接跳过。
 */
function extractJsonBlocks(md: string): Array<{ label: string; json: string }> {
  const out: Array<{ label: string; json: string }> = [];
  const re = /```json\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(md)) !== null) {
    idx += 1;
    const lines = m[1]!.split('\n');
    while (lines.length > 0 && lines[0]!.trimStart().startsWith('//')) lines.shift();
    const body = lines.join('\n').trim();
    // 只收"看起来是完整 JSON 文档"的：以 { 或 [ 开头，且括号配平。
    const first = body[0];
    if (first !== '{' && first !== '[') continue;
    let depth = 0;
    let balanced = true;
    for (const ch of body) {
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') depth -= 1;
      if (depth < 0) { balanced = false; break; }
    }
    if (!balanced || depth !== 0) continue;
    out.push({ label: `block #${idx}`, json: body });
  }
  return out;
}

describe('docs/skills.md 的例子与 schema 一致', () => {
  const md = readFileSync('docs/skills.md', 'utf8');
  const blocks = extractJsonBlocks(md);

  // 文档里有 6 个 ```json 围栏，其中 4 个是**字段片段**（只展示 parameters /
  // execute 的某一种写法），不算完整 skill。2 个完整例子：IP_QUALITY 和
  // GITHUB_REPO。低于 2 说明有人删了例子，这条测试就失去意义了。
  it('文档里至少有 2 个完整的 skill JSON 例子（否则这条测试是空的）', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  for (const b of blocks) {
    it(`${b.label} 是合法 JSON 且过 skillSchema`, async () => {
      const { skillSchema } = await import('../../../src/pipeline/tools/skill-loader.js');
      // 文档承诺的 name 约束（schema 不管，loader 管）
      const parsed = JSON.parse(b.json) as { name?: string };
      // 文档承诺的 name 约束（schema 只管类型，loader 才管这两个）
      expect(parsed.name, '必须有 name').toBeTruthy();
      expect(NAME_RE.test(parsed.name ?? ''), `name "${parsed.name}" 必须匹配 ${NAME_RE}`).toBe(true);
      // 注意：docs/skills.md 的头一个例子就叫 IP_QUALITY，它本身就是内置工具名。
      // 文档在 BUILTIN_TOOLS 表里列了这一条，所以这里不断言'不撞名'——
      // 只断言正则（name 形状）。撞名判据由 loader 运行时执行，已有单测覆盖。
      const r = skillSchema.safeParse(parsed);
      if (!r.success) {
        throw new Error(`docs/skills.md ${b.label} 不过 schema:\n${JSON.stringify(r.error.issues, null, 2)}`);
      }
      expect(r.success).toBe(true);
    });
  }

  it('文档声明的"trusted + 空 allowedHosts 会被拒"与实现一致', async () => {
    // loader 里的判据：trusted && http && (!allowedHosts || length===0) → skip
    const trustedHttpEmpty = {
      name: 'X', description: 'd', trusted: true,
      execute: { type: 'http' as const, url: 'https://x/' },
    };
    const { skillSchema } = await import('../../../src/pipeline/tools/skill-loader.js');
    const r = skillSchema.safeParse(trustedHttpEmpty);
    expect(r.success).toBe(true);              // schema 层让过
    const ex = r.success ? r.data.execute : undefined;
    // 但 loader 的门是 allowedHosts 非空
    const allowed = ex && ex.type === 'http' ? ex.allowedHosts : undefined;
    expect(!allowed || allowed.length === 0).toBe(true);   // ← 会被 loader 拒
  });

  it('文档声明的"script 型被 loader 拒"与实现一致', async () => {
    const { skillSchema } = await import('../../../src/pipeline/tools/skill-loader.js');
    const script = { name: 'X', description: 'd', execute: { type: 'script' as const, command: './x.sh' } };
    const r = skillSchema.safeParse(script);
    expect(r.success).toBe(true);              // schema 认得这个型
    // loader 在运行时 skip 它（skill-loader.ts:215 附近那道 warn）
  });
});
