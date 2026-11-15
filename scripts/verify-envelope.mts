/**
 * Nyat Trench · L1 包络的生产冒烟测试（可重跑）
 *
 * 为什么需要它：包络 enforce 之后可能很长时间 0 次拦截（夜里群安静），
 * 于是"它在生产 Redis 上到底通不通"永远是未知的。而这个会话已经出了四次
 * "接上了但没接在活的那条路上"——单测证明逻辑、bundle grep 证明代码在，
 * 但都不能证明 incr/get/expire 在**真实 Redis + 真实代码路径**上工作。
 *
 * 做法：用一个绝不会碰撞的探针 chatId 加上刻意极小的上限，跑一遍完整的
 * spend → check → block → retryAfter 循环，然后**删掉自己造的键**。
 *
 * 用法：npx tsx scripts/verify-envelope.mts
 */

const PROBE_CHAT = -999_999_001;

async function main(): Promise<void> {
  // 探针参数：绝不用生产默认值（150/100/小时），否则要等一小时才看得见结果。
  process.env.TRENCH_ENVELOPE_MODE = 'enforce';
  process.env.TRENCH_BURST_MAX = '3';
  process.env.TRENCH_BURST_MAX_ACTIVE = '2';
  process.env.TRENCH_BURST_WINDOW_SEC = '60';

  const m = await import('../src/nyatos/envelope.js');
  const checks: Array<[string, boolean]> = [];

  // ① enforce 模式生效
  const mode = (await m.checkEnvelope(PROBE_CHAT, true)).mode;
  checks.push(['mode=enforce', mode === 'enforce']);

  // ② 被叫到的上限精确生效
  const verdicts = [];
  for (let i = 0; i < 5; i++) {
    await m.spendEnvelope(PROBE_CHAT);
    verdicts.push(await m.checkEnvelope(PROBE_CHAT, true));
  }
  checks.push(['addressed 前 2 条放行', verdicts.slice(0, 2).every((v) => v.ok)]);
  checks.push(['addressed 第 3 条起拦', verdicts.slice(2).every((v) => !v.ok)]);

  // ③ 主动的上限更紧（此时已用 5 次，主动上限 2 → 立刻拦）
  const active = await m.checkEnvelope(PROBE_CHAT, false);
  checks.push(['主动上限更紧', !active.ok]);

  // ④ 拦下的信息是世界回弹，不是错误码
  const msg = m.renderEnvelopeBlock(active, false);
  checks.push(['拦截文案是身体感受', msg.includes('太快') && !msg.includes('Error')]);
  checks.push(['retryAfterSec 有界', (active.retryAfterSec ?? 0) > 0 && (active.retryAfterSec ?? 0) <= 60]);

  // ⑤ 清理探针键（TTL 也会兜底，但不留垃圾）
  const { getRedis } = await import('../src/db/redis.js');
  const keys = await getRedis().keys(`xxb:trench:burst:${PROBE_CHAT}:*`);
  for (const k of keys) await getRedis().del(k);

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failed += 1;
  }
  console.log(`\n${failed === 0 ? '✅ 包络在生产 Redis 上工作正常' : `❌ ${failed} 项未通过`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
