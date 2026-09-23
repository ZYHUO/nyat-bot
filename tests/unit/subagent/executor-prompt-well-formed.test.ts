import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * EXECUTOR_SYSTEM 必须是**形状完好**的 prompt（round 176）。
 *
 * 这个模板跑在每一次 CodeAct 任务上——它坏掉等于全部任务坏掉。
 * 而 round 175 我改它的时候差点把 `//` 注释行插进去：那些 `//` 会被模型
 * 当成乱码文本看到（因为工具清单是 prompt 内容，不是源码注释）。
 *
 * 所以这里钉三件事：
 *   ① 模板能渲染、没有未替换的 ${} 占位
 *   ② 没有源码注释残迹（`// round NNN` 形状的行）
 *   ③ 我加的约束在、且是中文不是乱码
 */
describe('EXECUTOR_SYSTEM 形状完好', () => {
  const render = (): string => {
    const src = fs.readFileSync('src/subagent/executor.ts', 'utf8');
    const start = src.indexOf('const EXECUTOR_SYSTEM = `');
    expect(start, 'EXECUTOR_SYSTEM 不在').toBeGreaterThan(-1);
    const open = src.indexOf('`', start + 24);
    const close = src.indexOf('`;', open + 1);
    expect(close, '模板没正常闭合').toBeGreaterThan(open);
    return src.slice(open + 1, close);
  };

  it('① 渲染得出来且没有未替换的 ${} 占位', () => {
    const body = render();
    expect(body.length).toBeGreaterThan(5000);   // 这个 prompt 一直是一万多字符
    const holes = body.match(/\$\{[^}]*\}/g) ?? [];
    // EXECUTOR_SYSTEM 本身是静态的（变量都靠后面拼接），有占位说明漏了替换
    expect(holes, `未替换的占位: ${holes.slice(0, 3).join(', ')}`).toEqual([]);
  });

  it('② 没有源码注释残迹（// round NNN 形状）', () => {
    // round 175 踩过：把约束写成 `  // round 175：...` 插进模板，
    // 而那些 // 会原样出现在 prompt 里——模型看到的是乱码文本。
    const body = render();
    const bad = body.split('\n').filter((l) => /^\s*\/\/\s*round\s+\d+/.test(l));
    expect(bad, `注释残迹: ${bad.slice(0, 2).join(' | ')}`).toEqual([]);
  });

  it('③ round 175 的约束在，且是正常中文', () => {
    const body = render();
    expect(body).toContain('一个任务对同一个 chat 只开口一次');
    expect(body).toContain('吱一声');
    // 乱码探测：0x549a(咚)/0x5431(吱) 之别——round 175 我把 吱 写成
    // 了 咚（用了错的 \u 转义），落成"咚一声"。测试第一版探的是"叮一声"
    // （叮），tamper 成咚之后照样绿——探错字等于没探。
    expect(body).not.toContain('咚一声');
  });

  it('④ 工具清单六件套都在（少一个就是改坏了）', () => {
    const body = render();
    for (const t of ['telegram.sendText', 'telegram.sendFinal', 'telegram.sendSticker',
      'telegram.sendFile', 'telegram.sendPhoto', 'art.draw']) {
      expect(body).toContain(t);
    }
  });

  it('⑤ 占位替换那次没残留反斜杠（round 119 家族的乱码探测）', () => {
    const body = render();
    expect(body).not.toContain('\\u5f00');
    expect(body).not.toContain('\\u4e00');
  });
});
