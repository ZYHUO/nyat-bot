import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 不许再出现"写死的 1200 maxTokens"（round 70）。
 *
 * 2026-09-23。这一家人清了三轮还有：
 *   round 26  清了 7 处写死的数字（session/meta/session.ts 等）
 *   round 69  清了 ASI_RUBRIC_MAX_TOKENS（env 值 1200）
 *   round 70  清了 task-worker / topic-scan / deep-reflection / skill-distill（各 1200）
 *             + TIMING_GATE_MAX_TOKENS 默认值 1200
 *
 * 共同病因：这些值的注释**全都写对了**（"reasoning_content 计入 completion，
 * 给小了只会拿到空 content"），但值是上一个模型够用时的遗留。
 * 模型换成 step-3.7-flash 后思维链变长，同样的 1200 就被吃光了。
 *
 * 这条测试锁住"别再往 src/ 里写 1200"——不是 1200 这个数字有错，
 * 是它在调用点写死就没法随模型调整。
 */
const FILES = [
  'src/queue/task-worker.ts',
  'src/cron/topic-scan.ts',
  'src/cron/deep-reflection.ts',
  'src/cron/skill-distill.ts',
  'src/pipeline/timing/gate.ts',
  'src/tracking/asi-scoring.ts',
];

describe('调用点不许写死 maxTokens 1200', () => {
  it('① src/ 下这 6 个文件不再有 maxTokens: 1200', () => {
    for (const f of FILES) {
      const s = fs.readFileSync(f, 'utf8');
      expect(s.includes('maxTokens: 1200,'), `${f} 还有写死的 1200`).toBe(false);
    }
  });

  it('② 推理模型的 usage 预算都 >= 4000', () => {
    const env = fs.readFileSync('.env', 'utf8');
    const get = (k: string) => Number(env.match(new RegExp('^' + k + '=(\\d+)$', 'm'))?.[1] ?? 0);
    for (const k of ['AI_USAGE_SUMMARIZE_MAX_TOKENS', 'TIMING_GATE_MAX_TOKENS', 'ASI_RUBRIC_MAX_TOKENS']) {
      expect(get(k), k).toBeGreaterThanOrEqual(4000);
    }
  });

  it('③ 默认值也不许是 1200（改默认值而不只改 .env：.env gitignored）', () => {
    for (const f of ['src/env-sections/judge.ts', 'src/env-sections/social.ts']) {
      const s = fs.readFileSync(f, 'utf8');
      expect(s.includes('.default(1200)'), `${f} 还有 default(1200)`).toBe(false);
    }
  });
});
