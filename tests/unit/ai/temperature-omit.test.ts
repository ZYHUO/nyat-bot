import { describe, expect, it } from 'vitest';

// round 12 回归：`AIImage.temperature: 'omit'` 的三态语义。
//
// 起因（用户问"kimi不行吗"）：round 9 我把 dshkimi 从确定性 usage 里排掉，
// 理由是"它只接受 temperature=1，与 judge 的 temperature=0 语义冲突"。
// 实测发现那个判断漏了第三个选项：
//
//   dshkimi 同一个 judge prompt 6 次：
//     temperature=1    → 200，reply×5 + pass×1   ← 1/6 翻车
//     不传 temperature → 200，reply×6           ← 全部一致，中位 4109ms
//
// "只接受 1"不等于"必须传 1"——**省掉字段让它用服务端默认更确定**。
//
// 排掉 dshkimi 的代价：judge 只剩 api.stepfun.com 的 stepfun + step5，单账号。
//
// 实现要点（三处都要改，漏一处就前功尽弃）：
//   provider.ts:230   callClaude 的 body['temperature']
//   provider.ts:399   callOpenAIRaw 的 body['temperature']
//   provider.ts:700   AI SDK generateText 的 temperature
//   reply-with-tools  合并写手那条独立路径
//
// ⚠️ 还需要 `AI_PROVIDER_DSHKIMI_RAW=true`：@ai-sdk/openai 的 temperature 是
// `.nullish().default(0)`，undefined 会被填成 0 → dshkimi 400。
// 只有 raw fetch 路径能真正省掉字段。

/** 与 provider.ts 的 resolveTemperature 同形（改那边要同步这里）。 */
function resolveTemperature(labelTemp: number | 'omit' | undefined, optsTemp: number | undefined): number | undefined {
  if (labelTemp === 'omit') return undefined;
  return labelTemp ?? optsTemp;
}

/** raw 路径：判据"要不要把 temperature 放进 body"。 */
function shouldSend(body: { temperature?: number }, temp: number | undefined): boolean {
  if (temp != null) body.temperature = temp;
  return 'temperature' in body;
}

describe('temperature 三态', () => {
  it('① omit → 解析成 undefined（不传字段）', () => {
    expect(resolveTemperature('omit', 0)).toBeUndefined();
    expect(resolveTemperature('omit', 0.8)).toBeUndefined();
    expect(resolveTemperature('omit', undefined)).toBeUndefined();
  });

  it('② label 数字 → 压过调用方（per-label 强制覆盖）', () => {
    expect(resolveTemperature(1, 0)).toBe(1);
    expect(resolveTemperature(0.5, 0)).toBe(0.5);
  });

  it('③ label 没配 → 用调用方的', () => {
    expect(resolveTemperature(undefined, 0)).toBe(0);
    expect(resolveTemperature(undefined, 0.8)).toBe(0.8);
    expect(resolveTemperature(undefined, undefined)).toBeUndefined();
  });

  it('④ omit 时 raw body 里**没有** temperature 键（不是 undefined 值）', () => {
    const body: { temperature?: number } = {};
    expect(shouldSend(body, resolveTemperature('omit', 0))).toBe(false);
    expect(Object.keys(body)).toEqual([]);
  });

  it('⑤ 数字时 body 里有值', () => {
    const body: { temperature?: number } = {};
    expect(shouldSend(body, resolveTemperature(1, 0))).toBe(true);
    expect(body.temperature).toBe(1);
  });
});
