import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * round 66：**src/ 里不许有 tamper 残留标记**。
 *
 * 事故（round 66 发现）：我 round 54 写的 `scripts/tamper-audit.mts` 会就地改源码
 * 再跑测试。它用 `try/finally` 还原，但 **harness 的 60s 超时是 SIGKILL，
 * finally 不执行**。round 50 那次跑到一半被杀，`incrCounter('ZZ_BROKEN_ZZ', ...)`
 * 留在了 `src/subagent/host-api.ts`——而我当时没跑全量测试（只跑了那个 pytest
 * 子集），于是**它被 commit 进了 736857d，在生产里待了 15 轮**。
 *
 * 后果：`send_topic_word_repeat_total` 这个计数器 15 轮没数据，
 * 而 round 196 我还把它写进了 OBJECTIVE-STATUS 的表（"闸在生产有证据"）。
 *
 * 这条守卫治的是工具本身：**任何 ZZ_ 形状的标记进 src/ 就是 bug**。
 * 它比"记得还原"强——记得会忘，尤其是工具被外部杀掉的时候。
 */

describe('src/ 里没有 tamper 残留', () => {
  it('① 没有 ZZ_ 形状的占位标记', () => {
    const out = execSync(
      "grep -rn 'ZZ_BROKEN\\|ZZ_TAMPERED\\|ZZ_[A-Z]' src/ --include=*.ts || true",
      { encoding: 'utf8' },
    ).trim();
    expect(out, 'src/ 里有 tamper 残留（tamper-audit 被杀时留下的）：\n' + out).toBe('');
  });

  it('② dist/ 里也没有（构建产物同步污染）', () => {
    // grep -c 无匹配时返回 1 且输出 "0"；有匹配时输出计数。两种都要读成 0 才算干净。
    const out = execSync(
      "grep -c 'ZZ_BROKEN\\|ZZ_TAMPERED' dist/index.js || echo 0",
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const n = Number(out.split('\n').pop());
    expect(Number.isFinite(n) ? n : 0, `dist 里有 ${out}`).toBe(0);
  });

  it('③ tamper-audit 脚本启动时会清残留（治本：不让它再发生）', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync('scripts/tamper-audit.mts', 'utf8');
    // 启动时扫 /tmp/tamper-audit-backup* 并还原
    expect(src).toContain('tamper-audit-backup');
    expect(src).toMatch(/restoreLeftovers|recoverLeftovers|readdirSync/);
  });
});
