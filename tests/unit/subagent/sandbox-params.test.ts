/**
 * 沙盒参数表的位置对齐守卫。
 *
 * 背景：subagent 的沙盒用 `new AsyncFunction('telegram', …, 'console', code)` 建函数，
 * 再 `fn(host.telegram, …, console)` **按位置**传实参。加一个命名空间要同时改两张表，
 * 而位置错位的后果是静默的：模型写的 `bots.command(...)` 实际拿到的是另一个命名空间
 * 的对象，报的错会是"xxx is not a function"，看上去像工具没接，其实是接错位了。
 *
 * 2026-09-21 加 `bots` 时手工核对了对齐（18 个名字 / 17 个 host.* + 1 个裸 console），
 * 但下一次加命名空间的人不会这么仔细。这个测试把核对固化成守卫。
 *
 * 同时锁三件事：
 *   ① 参数名与实参逐个对齐（含末尾那个裸 console）
 *   ② EXECUTOR_SYSTEM 的文档里出现的每个 `X.command(` / `X.xxx(` 都能在沙盒里找到 X
 *      （文档写了但沙盒没有 = 模型照文档调用必然失败）
 *   ③ 反向：沙盒给了但文档没提的命名空间列出来（不一定错，但值得看一眼）
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = 'src/subagent/executor.ts';

function extract(): { names: string[]; args: string[] } {
  const s = readFileSync(SRC, 'utf8');
  const nStart = s.indexOf('const fn = new AsyncFunction(');
  const oStart = s.indexOf('const out = await Promise.race');
  const fStart = s.indexOf('fn(', oStart);
  const fEnd = s.indexOf('),', fStart);
  expect(nStart, '找不到 new AsyncFunction 调用').toBeGreaterThan(-1);
  expect(oStart, '找不到 Promise.race').toBeGreaterThan(-1);
  expect(fStart, '找不到 fn( 实参列表').toBeGreaterThan(-1);

  const names = [...s.slice(nStart, oStart).matchAll(/'([a-zA-Z_]+)'/g)].map((m) => m[1]!);
  // 逐行扫实参：`host.X,` 取 X；裸的 `console,` 取 console。按顺序收集，
  // 这样末尾那个不走 host.* 的全局参数也能对上位置。
  const args: string[] = [];
  for (const line of s.slice(fStart, fEnd).split('\n')) {
    const t = line.trim();
    const host = /^host\.([a-zA-Z]+),?$/.exec(t);
    if (host) { args.push(host[1]!); continue; }
    const bare = /^([a-zA-Z]+),?$/.exec(t);
    if (bare) args.push(bare[1]!);
  }
  return { names, args };
}

describe('沙盒参数表对齐', () => {
  it('① 参数名与实参逐个对齐（含末尾裸 console）', () => {
    const { names, args } = extract();
    expect(args.length, `实参个数 ${args.length} 与参数名个数 ${names.length} 不一致`).toBe(names.length);
    for (let i = 0; i < names.length; i++) {
      expect(args[i], `第 ${i} 位：参数名 ${names[i]} 但实参是 ${args[i]}`).toBe(names[i]);
    }
  });

  it('①b 末尾确实有一个裸 console（沙盒要能 console.log）', () => {
    const s = readFileSync(SRC, 'utf8');
    const fStart = s.indexOf('fn(', s.indexOf('const out = await Promise.race'));
    const fEnd = s.indexOf('),', fStart);
    const argsBlock = s.slice(fStart, fEnd);
    expect(argsBlock, 'fn( 实参里没有裸 console').toMatch(/^\s{2,}console,\s*$/m);
  });

  it('② 文档里写的 X.xxx( 都能在沙盒里找到 X', () => {
    const s = readFileSync(SRC, 'utf8');
    const { names } = extract();
    const sysStart = s.indexOf('const EXECUTOR_SYSTEM = `');
    const sys = s.slice(sysStart, s.indexOf('`;', sysStart));
    // 文档形如 "- telegram.sendText(...)" / "- bots.command({...})"
    const documented = new Set(
      [...sys.matchAll(/^\s*-\s*\*{0,2}([a-z][a-zA-Z]+)\.([a-zA-Z]+)\(/gm)].map((m) => m[1]!),
    );
    expect(documented.size, 'EXECUTOR_SYSTEM 里没解析到任何 命名空间.方法( —— 正则该修了').toBeGreaterThan(5);
    const missing = [...documented].filter((ns) => !names.includes(ns));
    expect(
      missing,
      `这些命名空间在模型可见文档里出现，但沙盒参数表里没有——模型照文档调用必然失败：\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('③ 沙盒有但文档没提的命名空间（列出来供review，不一定是错）', () => {
    const s = readFileSync(SRC, 'utf8');
    const { names } = extract();
    const sysStart = s.indexOf('const EXECUTOR_SYSTEM = `');
    const sys = s.slice(sysStart, s.indexOf('`;', sysStart));
    const documented = new Set(
      [...sys.matchAll(/^\s*-\s*\*{0,2}([a-z][a-zA-Z]+)\.([a-zA-Z]+)\(/gm)].map((m) => m[1]!),
    );
    const extra = names.filter((n) => !documented.has(n) && n !== 'console');
    // 只打印不断言——新增命名空间常常是先接沙盒后补文档
    if (extra.length > 0) console.log('[sandbox] 沙盒有但文档未提:', extra.join(', '));
    expect(Array.isArray(extra)).toBe(true);
  });
});
