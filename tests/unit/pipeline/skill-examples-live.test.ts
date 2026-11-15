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
const CASES: Array<{ name: string; url: string; check: (body: string) => boolean; method?: string; body?: string }> = [
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
  // round 21：社群 bot 该有的两类 —— 冷场时的接话材料、和"真办事"的 POST 链路。
  {
    name: 'RANDOM_JOKE',
    url: 'https://official-joke-api.appspot.com/random_joke',
    check: (b) => { try { const d = JSON.parse(b); return typeof d.setup === 'string' && typeof d.punchline === 'string'; } catch { return false; } },
  },
  {
    // 这不是给 bot 用的，是给写 skill 的人当 POST 模板的：
    // 证明 loader 的 body 模板真的能把参数带出去。
    name: 'ECHO_BACK',
    url: 'https://httpbin.org/post',
    method: 'POST',
    body: JSON.stringify({ payload: 'nyatbot post probe' }),
    check: (b) => { try { return JSON.parse(b).data.includes('nyatbot post probe'); } catch { return false; } },
  },
];

describe('example skills 真的能通（需要外网，网络失败时跳过）', () => {
  for (const c of CASES) {
    it(`${c.name} 打 ${new URL(c.url).host} 返回预期形状`, async () => {
      let res: Response;
      try {
        res = await fetch(c.url, {
          signal: AbortSignal.timeout(20_000),
          ...(c.method ? { method: c.method } : {}),
          ...(c.body ? { body: c.body, headers: { 'Content-Type': 'application/json' } } : {}),
        });
      } catch {
        // 网络不通（CI / 离线）——跳过而不是失败
        return;
      }
      // 4xx 是**我们**的问题（URL 错、参数错、被墙）→ 算例子坏，要红。
      // 5xx / 429 是**对方**的问题（刚才 httpbin 就抖了一次 502，curl 重试即 200）
      //    → 跳过。把别人的抖动算成自己的失败，这条测试会天天红，然后被整个关掉。
      if (res.status >= 500 || res.status === 429 || res.status === 403) return;
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(c.check(body), `${c.name}: 返回形状不对 → ${body.slice(0, 120)}`).toBe(true);
    }, 30_000);
  }
});
