import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

/**
 * 不重启开 debug（round 85）。
 *
 * 全仓 408 处 `logger.debug`，生产 `LOG_LEVEL=info`——一律不可见。
 * 这个会话为它付过两次学费：
 *
 *   round 75：截断重试走 debug，grep 到 0 条就判定"没走到"，
 *             排了十二项代码逻辑。真相是**走了但被过滤了**。
 *   round 81：grep `AI call failed` 漏了 `Label failed, trying next`，
 *             把 570 次失败看成 0 次。
 *
 * 原先唯一办法是改 `.env` + restart。而限流/熔断是**瞬态**的——
 * 重启那 30 秒里要抓的东西早没了。
 *
 * 现在：`redis-cli set xxb:log:level debug`，30s 内生效。
 */
describe('动态日志级别', () => {
  const SRC = 'src/shared/logger.ts';

  it('① 有 startDynamicLogLevel 导出', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('export function startDynamicLogLevel');
  });

  it('② Redis 键名固定（文档/运维要能引用）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("const LEVEL_KEY = 'xxb:log:level';");
  });

  it('③ 有轮询 + unref（不占事件循环，不阻止退出）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('setInterval(poll, LEVEL_POLL_MS).unref()');
  });

  it('④ 只接受合法 pino level（防一个错值把日志全关掉）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('VALID_LEVELS');
    expect(s).toContain("'trace', 'debug', 'info', 'warn', 'error', 'fatal'");
  });

  it('⑤ 切换时自己打一条 warn（不能静默改）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("'log level changed (dynamic)'");
  });

  it('⑥ 关在 index.ts 启动时装（在任何 logger.info 之前）', () => {
    const s = fs.readFileSync('src/index.ts', 'utf8');
    const iLevel = s.indexOf('startDynamicLogLevel();');
    const iProxy = s.indexOf('installGlobalFetchProxy(config.GLOBAL_FETCH_PROXY)');
    expect(iLevel).toBeGreaterThan(-1);
    expect(iProxy).toBeGreaterThan(-1);
    // 启动序列里紧跟代理安装（两个都是 1.x 号段）
    expect(iLevel).toBeGreaterThan(iProxy);
  });

  it('⑦ LOG_LEVEL_DYNAMIC=false 可关（有人不想要这个行为）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("process.env['LOG_LEVEL_DYNAMIC'] === 'false'");
  });

  it('⑧ 键没了要回到 baseline（不能只进不退）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 第一版写 `if (!VALID_LEVELS.has(next)) return` —— 只能改进去，
    // 运维 del 键后期望回 info，实际永远停在 debug（实测删键后仍 49→283）。
    expect(s).not.toContain('if (!VALID_LEVELS.has(next)) return;');
    expect(s).toContain("const target = next === '' ? baseline : (VALID_LEVELS.has(next) ? next : logger.level);");
  });

  it('⑨ 非法的 level 值被忽略（手滑打错不该把日志关掉）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('VALID_LEVELS.has(next) ? next : logger.level');
  });
});
