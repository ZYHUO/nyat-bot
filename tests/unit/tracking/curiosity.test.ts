import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory redis double:支持 multi().hset().expire().exec() / hgetall / del
const store = new Map<string, Record<string, string>>();
const ttls = new Map<string, number>();

const redis = {
  multi() {
    const ops: Array<() => void> = [];
    const m = {
      hset: (k: string, ...fv: string[]) => {
        ops.push(() => {
          const h = store.get(k) ?? {};
          for (let i = 0; i < fv.length; i += 2) h[fv[i]!] = fv[i + 1]!;
          store.set(k, h);
        });
        return m;
      },
      expire: (k: string, sec: number) => {
        ops.push(() => ttls.set(k, sec));
        return m;
      },
      exec: async () => {
        ops.forEach((f) => f());
        return [];
      },
    };
    return m;
  },
  hgetall: async (k: string) => store.get(k) ?? {},
  del: async (k: string) => {
    store.delete(k);
    ttls.delete(k);
    return 1;
  },
};

vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redis }));

import {
  noteAskedQuestion,
  peekPendingQuestion,
  commitPendingQuestion,
} from '../../../src/tracking/curiosity.js';

const CHAT = -100123;
const UID = 777;
const KEY = `xxb:curio:${CHAT}:${UID}`;

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  store.clear();
  ttls.clear();
});

describe('curiosity 惦记', () => {
  it('记录以全角?收尾的问句(中文回复的常态,review #1)', async () => {
    await noteAskedQuestion(CHAT, UID, '主人今天吃的什么呀？');
    expect(store.get(KEY)?.['q']).toBe('主人今天吃的什么呀？');
    // 写入与 TTL 原子成对(review #15)
    expect(ttls.get(KEY)).toBe(48 * 3600);
  });

  it('半角 ? 同样记录;非问句/太短的不记', async () => {
    await noteAskedQuestion(CHAT, UID, 'what is that thing?');
    expect(store.get(KEY)?.['q']).toBe('what is that thing?');
    store.clear();
    await noteAskedQuestion(CHAT, UID, '好哦喵~');
    await noteAskedQuestion(CHAT, UID, '嗯??');
    expect(store.size).toBe(0);
  });

  it('peek 不到 30 分钟的问题 → null(太快追显得逼问)', async () => {
    store.set(KEY, { q: '你昨天去哪了？', ts: String(nowSec() - 60) });
    expect(await peekPendingQuestion(CHAT, UID)).toBeNull();
    expect(store.has(KEY)).toBe(true);
  });

  it('peek 悬置够久的问题 → 返回且**不删**(两段式,review #7)', async () => {
    store.set(KEY, { q: '你昨天去哪了？', ts: String(nowSec() - 31 * 60) });
    expect(await peekPendingQuestion(CHAT, UID)).toBe('你昨天去哪了？');
    expect(store.has(KEY)).toBe(true); // 被打断/抑制时惦记保留
  });

  it('commit 只核销悬置够久的(已注入的);新鲜问题不被误删', async () => {
    store.set(KEY, { q: '老问题？', ts: String(nowSec() - 31 * 60) });
    await commitPendingQuestion(CHAT, UID);
    expect(store.has(KEY)).toBe(false);

    store.set(KEY, { q: '新问题？', ts: String(nowSec() - 60) });
    await commitPendingQuestion(CHAT, UID);
    expect(store.get(KEY)?.['q']).toBe('新问题？');
  });
});
