import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { findTopicRepeat } from '../../../src/subagent/topic-repeat.js';
import { reportFixture } from '../../helpers/log-script.js';

/**
 * round 42 的进程内重放回归，现在使用明确合成日志，CI 不读生产聊天。
 *
 * Round 41 的结论不是"闸坏了"，而是"判据状态在进程内，全日志回放不能否证"，
 * 并说"要定论需要同一进程内的样本"。
 *
 * 这一步不宣称复现生产流量：从每项测试自己的临时 JSONL 取合成的
 * (chat, text) 序列，在同一进程里依次调 `findTopicRepeat`。
 * 这样窗口、停用词、`recent.length < 3` 全部按闸自己的判据走。
 *
 * 顺带发现 round 41 我的回放有两个口径错：
 *   · 窗口用了 5 条，闸是 `history.slice(-6)` = **6 条**
 *   · 停用词只列了 3 个，闸有 ~60 个
 * 所以这不是"闸认同我的子集"，而是两个不同的口径。
 */

interface Row { t: number; chat: string; text: string }
const fixture = reportFixture(Object.entries({
  A: ['窗台', '枫树', '窗台', '窗台'],
  B: ['我们', '我们', '我们', '我们'],
  C: ['星河', '桃花', '月亮', '白云', '星河', '青山', '星河'],
}).flatMap(([chatId, texts], group) => texts.map((preview, i) => ({
  time: Date.parse('2026-11-15T10:00:00Z') + group * 10_000 + i * 1000,
  msg: 'host sendText', chatId, preview,
}))));
afterAll(() => fixture.cleanup());

function loadSends(): Row[] {
  const out: Row[] = [];
  const lines = fs.readFileSync(fixture.logFile, 'utf8').split('\n');
  for (const l of lines) {
    if (l.indexOf('"host sendText"') < 0) continue;
    if (!l.startsWith('{')) continue;
    let d: { preview?: string; time?: number; chatId?: string };
    try { d = JSON.parse(l); } catch { continue; }
    if (!d || typeof d !== 'object') continue;
    const text = String(d.preview ?? '');
    if (!text) continue;
    out.push({ t: d.time ?? 0, chat: String(d.chatId ?? ''), text });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** 与 round 41 同口径的回放（窗口 5、停用词 3）——用来对比差多少。 */
function myRound41Replay(sends: Row[]): number {
  const STOP = new Set(['本喵', '啾咪', '喵喵']);
  const bigramsOf = (t: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < t.length - 1; i++) {
      const b = t.slice(i, i + 2);
      if (/[一-龥]{2}/.test(b)) out.push(b);
    }
    return out;
  };
  const byChat: Record<string, string[]> = {};
  let hits = 0;
  for (const s of sends) {
    if (!s.chat || s.chat === 'undefined') continue;
    const hist = (byChat[s.chat] ??= []);
    const cand = bigramsOf(s.text);
    let mine = '';
    for (const b of cand) {
      if (STOP.has(b)) continue;
      let n = 1;
      for (const h of hist.slice(-5)) if (bigramsOf(h).includes(b)) n++;
      if (n >= 3) { mine = b; break; }
    }
    if (mine) hits++;
    hist.push(s.text);
  }
  return hits;
}

describe('合成日志在同一进程里喂真闸（不依赖生产文件）', () => {
  it('① 闸的判据在本进程样本里有真实命中（证明它能响）', () => {
    const sends = loadSends();
    const byChat: Record<string, string[]> = {};
    let guardHits = 0;
    const bigramsHit: Record<string, number> = {};
    for (const s of sends) {
      if (!s.chat || s.chat === 'undefined') continue;
      const hist = (byChat[s.chat] ??= []);
      const hit = findTopicRepeat(hist.slice(-6), s.text);
      if (hit) {
        guardHits++;
        bigramsHit[hit.bigram] = (bigramsHit[hit.bigram] ?? 0) + 1;
      }
      hist.push(s.text);
      while (hist.length > 12) hist.shift();
    }
    expect(guardHits).toBe(2);
    expect(bigramsHit).toEqual({ 窗台: 1, 星河: 1 });
  });

  it('② 旧口径的短窗口和不完整停用词给出不同结果，不能代替真实闸', () => {
    const sends = loadSends();
    const mine = myRound41Replay(sends);
    // 旧口径误报两次“我们”，漏掉跨六条窗口的“星河”。
    expect(mine).toBe(3);
  });

  it('③ 闸命中的 bigram 不是停用词家族（否则判据失效）', () => {
    const sends = loadSends();
    const byChat: Record<string, string[]> = {};
    const hits: string[] = [];
    for (const s of sends) {
      if (!s.chat || s.chat === 'undefined') continue;
      const hist = (byChat[s.chat] ??= []);
      const hit = findTopicRepeat(hist.slice(-6), s.text);
      if (hit) hits.push(hit.bigram);
      hist.push(s.text);
      while (hist.length > 12) hist.shift();
    }
    expect(hits).toEqual(['窗台', '星河']);
    // 高频命中词应该看起来像真话题词，而不是"我们/什么"这类
    const freq: Record<string, number> = {};
    for (const h of hits) freq[h] = (freq[h] ?? 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
    expect(top).toEqual([['窗台', 1], ['星河', 1]]);
  });
});
