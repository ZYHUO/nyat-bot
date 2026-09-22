import { describe, expect, it } from 'vitest';

/**
 * 仓库自带的 4 个 example skill 必须**真的打得通**。
 *
 * 2026-09-22 round 6。前一条（shipped-skills.test.ts）只验 schema 合法，
 * 但合法不等于能用——文档里 script 型的字段名我就写错过一次（path vs command），
 * 是过真 schema 的测试抓出来的。所以这里真的去打一次。
 *
 * 4 个 skill 都选的是**免费、不需要 key** 的公开 API（ipinfo.io / api.github.com /
 * api.coingecko.com / dog.ceo）。这一条也是"新 clone 零配置可用"的验收。
 *
 * 网络失败不算测试失败（CI 无外网是常事），但**打到而返回错**算——
 * 那说明仓库带了个坏例子，比不带更糟。
 */
const CASES: Array<{ name: string; url: string; check: (body: string) => boolean }> = [
  {
    name: 'IP_GEO',
    url: 'https://ipinfo.io/8.8.8.8/json',
    check: (b) => { try { return JSON.parse(b).ip === '8.8.8.8'; } catch { return false; } },
  },
  {
    name: 'GITHUB_REPO',
    url: 'https://api.github.com/repos/ZYHUO/nyat-bot',
    check: (b) => { try { return JSON.parse(b).full_name === 'ZYHUO/nyat-bot'; } catch { return false; } },
  },
  {
    name: 'CRYPTO_PRICE',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
    check: (b) => { try { return typeof JSON.parse(b).bitcoin.usd === 'number'; } catch { return false; } },
  },
  {
    name: 'RANDOM_DOG',
    url: 'https://dog.ceo/api/breeds/image/random',
    check: (b) => { try { return typeof JSON.parse(b).message === 'string'; } catch { return false; } },
  },
];

describe('example skills 真的能通（需要外网，网络失败时跳过）', () => {
  for (const c of CASES) {
    it(`${c.name} 打 ${new URL(c.url).host} 返回预期形状`, async () => {
      let res: Response;
      try {
        res = await fetch(c.url, { signal: AbortSignal.timeout(20_000) });
      } catch {
        // 网络不通（CI / 离线）——跳过而不是失败
        return;
      }
      if (res.status === 429 || res.status === 403) {
        // 限流,不是例子坏了
        return;
      }
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(c.check(body), `${c.name}: 返回形状不对 → ${body.slice(0, 120)}`).toBe(true);
    }, 30_000);
  }
});
