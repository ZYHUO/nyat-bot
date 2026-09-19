/**
 * Nyat Trench · Phase 1 时限实验（开 / 停 / 查）
 *
 * 为什么用 TTL 而不是改 .env：按群灰度名单是**持久**的——放进去就一直生效，
 * 直到有人记得删。一个会自己过期的开关让实验有时限，不依赖"我之后一定回来撤"。
 *
 * 用法：
 *   npx tsx scripts/trench-experiment.mts grant  <chatId> <分钟>
 *   npx tsx scripts/trench-experiment.mts revoke <chatId>
 *   npx tsx scripts/trench-experiment.mts status [chatId]
 *
 * 判据与预测在论文 §九·补三，跑之前就已写死。这里只负责开关与状态。
 */

import { grantTimedBypass, revokeTimedBypass, hasTimedBypass } from '../src/meta/heart-route.js';

const [cmd, chatArg, minArg] = process.argv.slice(2);

async function main(): Promise<void> {
  if (cmd === 'grant') {
    const chatId = Number(chatArg);
    const minutes = Number(minArg);
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      console.error('chatId 必须是非零整数（群为负）');
      process.exit(1);
    }
    if (!(minutes > 0)) {
      console.error('分钟数必须是正数');
      process.exit(1);
    }
    await grantTimedBypass(chatId, minutes);
    const { getRedis } = await import('../src/db/redis.js');
    const ttl = await getRedis().ttl(`xxb:trench:heart_bypass:${chatId}`);
    console.log(`✓ 已为群 ${chatId} 开启 ${minutes} 分钟时限旁路（Redis TTL ${ttl}s 后自动恢复）`);
    return;
  }

  if (cmd === 'revoke') {
    const chatId = Number(chatArg);
    await revokeTimedBypass(chatId);
    console.log(`✓ 已撤销群 ${chatId} 的时限旁路（或它本就未开启）`);
    return;
  }

  if (cmd === 'status') {
    if (chatArg) {
      const chatId = Number(chatArg);
      const on = await hasTimedBypass(chatId);
      const { getRedis } = await import('../src/db/redis.js');
      const ttl = await getRedis().ttl(`xxb:trench:heart_bypass:${chatId}`);
      console.log(`群 ${chatId}：${on ? `时限旁路中（剩余 ${ttl}s）` : '未开启'}`);
      return;
    }
    const { getRedis } = await import('../src/db/redis.js');
    const keys = await getRedis().keys('xxb:trench:heart_bypass:*');
    if (keys.length === 0) {
      console.log('当前没有群处于时限旁路中。');
      return;
    }
    for (const k of keys) {
      const ttl = await getRedis().ttl(k);
      console.log(`  ${k.replace('xxb:trench:heart_bypass:', '')}：剩余 ${ttl}s`);
    }
    return;
  }

  console.error('用法：grant <chatId> <分钟> | revoke <chatId> | status [chatId]');
  process.exit(1);
}

void main();
