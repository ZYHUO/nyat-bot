import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * "说完有没有人接" 仪表盘（round 102）。
 *
 * 用户 41 轮来说"很难融入话题"。我 42 轮修的都是让它"说得出/说得对"
 * （trench 闸 33%→4%、maxTokens、去重），而这个最终指标
 * （replied = 有人回了它这句）一直在 self-act 里，从没进过仪表盘。
 *
 * round 100 第一次看到它（2-6%），round 101 验崩了"点名+钩子"，
 * round 102 验崩了"小群更容易被接"（r=0.03）。
 * 所以这个脚本的目的**不是解释**，是把数字常态化放在眼前。
 */
describe('measure:engage 仪表盘', () => {
  const SRC = 'scripts/measure-engage.mts';

  it('① 有 --hours 参数（默认 12，cron 里用 24）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("--hours=");
    expect(s).toContain('HOURS * 3600');
  });

  it('② 读 self-act（不是自己另统计）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('getSelfActSummary');
  });

  it('③ 输出区分 replied / mentioned / corrected / ignored', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    for (const k of ['o.replied', 'o.mentioned', 'o.corrected', 'o.ignored']) {
      expect(s).toContain(k);
    }
  });

  it('④ 说明了它跟回复率的区别（回复率能自己控制，这个不能）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('回复率可以由它自己控制');
  });

  it('⑤ npm script 叫 measure:engage', () => {
    const p = fs.readFileSync('package.json', 'utf8');
    expect(p).toContain('"measure:engage"');
    expect(p).toContain('scripts/measure-engage.mts');
  });

  it('⑥ voice-daily.sh 每天也收它', () => {
    const s = fs.readFileSync('scripts/voice-daily.sh', 'utf8');
    expect(s).toContain('measure:engage');
    expect(s).toContain('--hours=24');
  });

  it('⑦ 没有记录时不报 0%（空数据不是收敛）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('if (T === 0)');
    expect(s).toContain('process.exit(0)');
  });
});
