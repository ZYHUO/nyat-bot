// ────────────────────────────────────────
// 身体信号注册表（Body Signal Registry）
// ────────────────────────────────────────
//
// 为什么要有它
// ───────────────
// 实测：加一个"身体信号"（定向债）散落在 10+ 个文件里——
//   src/bot/handlers/message.ts、src/agent/{agency,agency-control-adapters,
//   agency-host-adapters,cognitive-workspace,cognitive-projector,replay,
//   belief-verify,semantic-debt-scorer,agency-action-semantics}.ts
// 加第二个（反广告）又要再改一遍 frame.ts 的类型、字段、渲染分支。
// 每加一个信号都要改 Frame 的结构 → 这是扩展性的真实瓶颈。
//
// 注册表把"加一个信号"变成：**一个文件 + 一行 register**，Frame 零改动。
//
// 契约（Nyat Trench §三 的立场不变）
// ─────────────────────────────────────
//   enabled()  宿主侧开关（env flag / 群主授权 / TTL）。未启用时 read 都不该被调。
//   read()     只做测量，返回任意结构。**不做判断**。
//   render()   把测量结果变成一句身体事实。返回 '' = 本次无话可说。
//
// 模型仍然只读事实、自己决定。注册表不改变这个分工，只是让"事实"可以线性增加。

import { logger } from '../shared/logger.js';

export interface BodyContext {
  /** 本回合出现过的发送者（uid 必填，name 可选）。 */
  senders?: Array<{ uid: number; name?: string }>;
}

export interface BodySignal<T = unknown> {
  /** 稳定 id，用于日志与去重。 */
  id: string;
  /** 呈现顺序（小者先）。 */
  order?: number;
  /** 该信号当前是否启用。未启用时不会 read/render。 */
  enabled(chatId: number): boolean | Promise<boolean>;
  /**
   * 测量。fail-soft：抛错由调用方吞掉并跳过该信号。
   *
   * ctx.senders 是本回合出现过的发送者——反广告这类"针对谁"的信号需要它，
   * 而气压/债/回声这类"群级"信号忽略它即可。可选项，不加也行。
   */
  read(chatId: number, ctx?: BodyContext): Promise<T>;
  /** 渲染成一句事实。空串 = 不呈现。 */
  render(value: T, chatId: number): string;
}

const registry: BodySignal[] = [];

/** 注册一个身体信号。重复 id 后者忽略并告警（防止热重载重复注册）。 */
export function registerBodySignal<T>(signal: BodySignal<T>): void {
  if (registry.some((s) => s.id === signal.id)) {
    logger.warn({ id: signal.id }, 'body signal duplicate registration, ignored');
    return;
  }
  registry.push(signal as BodySignal);
}

/** 按 order 排序的全部已注册信号。 */
export function listBodySignals(): BodySignal[] {
  return [...registry].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** 清空（仅测试用）。 */
export function _resetBodySignals(): void {
  registry.length = 0;
}

/**
 * 收集该群当前所有应呈现的身体事实。
 *
 * 单个信号失败只跳过它自己，不影响别的信号，也不影响调用方——
 * 反广告/定向债/气压任何一环读不到，Frame 仍然成立。
 */
export async function collectBodyFacts(chatId: number, ctx: BodyContext = {}): Promise<string[]> {
  const out: string[] = [];
  for (const sig of listBodySignals()) {
    try {
      if (!(await sig.enabled(chatId))) continue;
      const value = await sig.read(chatId, ctx);
      const line = sig.render(value, chatId);
      if (line) out.push(line);
    } catch (err) {
      logger.debug({ err, id: sig.id, chatId }, 'body signal failed (skipped)');
    }
  }
  return out;
}
