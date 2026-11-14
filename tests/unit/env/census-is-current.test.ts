import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * docs/flag-census.md 必须是最新的（round 128）。
 *
 * 2026-09-23 实测：round 21 把一堆 flag 的 reader 从 executor.ts 迁到
 * prompt-inputs.ts，而 census 从那次起就没重新生成过（上次 09-22 16:23）。
 * 66 行 diff 悄悄躺着，而 AGENTS.md 第 6 条明写"每次加 flag 都要重跑 census"。
 *
 * `no-dead-switches` 能抓死旗标，但**没有守卫抓 census 该重新生成**——
 * 这个测试填那个缺口。做法：以公开模板重跑脚本，然后比较已有文档。
 *
 * 不读取私密 .env，也不要求其他文件或 HEAD 干净。
 */
describe('flag-census 是最新的', () => {
  // census 脚本要扫整个 src/，实测 ~24s，远超默认 5s。
  it('从公开模板重新生成后与已有文档无 diff', { timeout: 120_000 }, () => {
    const before = fs.readFileSync('docs/flag-census.md', 'utf8');
    let after: string;
    try {
      execFileSync('python3', ['scripts/flag-census.py', '--env-file', '.env.example'], { stdio: 'ignore' });
      after = fs.readFileSync('docs/flag-census.md', 'utf8');
    } finally {
      // 生成器失败也必须还原工作区文档。
      fs.writeFileSync('docs/flag-census.md', before);
    }
    if (after !== before) {
      // 给出前几行 diff 便于定位
      const b = before.split('\n');
      const a = after.split('\n');
      const firstDiff = a.findIndex((l, i) => l !== b[i]);
      throw new Error(
        'docs/flag-census.md 过期了 —— 跑 python3 scripts/flag-census.py 并提交。\n' +
        `首个差异在第 ${firstDiff + 1} 行:\n  期望: ${b[firstDiff]?.slice(0, 100)}\n  实际: ${a[firstDiff]?.slice(0, 100)}`,
      );
    }
    expect(after).toBe(before);
  });
});

interface FixtureCensus {
  source: { file: string; kind: string };
  summary: { on_in_source: number; set_in_source: number };
  rows: Array<{ name: string; envval: string | null }>;
}

function runFixture(args: string[] = [], operatorInput?: string) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'nyat-census-'));
  try {
    for (const path of ['src/env-sections', 'scripts', 'tests', 'packages', 'docs', 'temp']) {
      fs.mkdirSync(join(directory, path), { recursive: true });
    }
    fs.copyFileSync(resolve('scripts/flag-census.py'), join(directory, 'scripts/flag-census.py'));
    fs.writeFileSync(join(directory, 'src/env.ts'), '// composed schema fixture\n');
    fs.writeFileSync(join(directory, 'src/env-sections/infra.ts'), [
      '  EXAMPLE_ENABLED: booleanFromEnv.default(false),',
      '  BOT_TOKEN: z.string(),',
      '  TOKEN_BUDGET: z.number().default(5),',
      '',
    ].join('\n'));
    fs.writeFileSync(join(directory, '.env.example'), 'EXAMPLE_ENABLED=true\nBOT_TOKEN=synthetic-template-token\nTOKEN_BUDGET=10\n');
    // No private .env exists in this clean checkout fixture.
    if (operatorInput !== undefined) fs.writeFileSync(join(directory, 'operator-input.conf'), operatorInput);
    const output = execFileSync('python3', ['scripts/flag-census.py', ...args], {
      cwd: directory, encoding: 'utf8',
      env: { ...process.env, TMPDIR: join(directory, 'temp'), TMP: join(directory, 'temp'), TEMP: join(directory, 'temp') },
    });
    return {
      output,
      markdown: fs.readFileSync(join(directory, 'docs/flag-census.md'), 'utf8'),
      json: JSON.parse(fs.readFileSync(join(directory, 'temp/flagcensus.json'), 'utf8')) as FixtureCensus,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('flag-census 来源与脱敏', () => {
  it('无 .env 的干净 checkout 默认使用公开模板，不声称生产状态', () => {
    const result = runFixture();
    expect(result.json.source).toEqual({ file: '.env.example', kind: 'public_template' });
    expect(result.json.summary).toMatchObject({ on_in_source: 1, set_in_source: 3 });
    expect(result.markdown).toContain('配置来源：公开模板 ".env.example"');
    expect(result.markdown).toContain('不代表生产实际状态');
    expect(result.markdown).not.toMatch(/生产实际开着|生产开着的旗标|on_in_prod/);
    expect(result.json.rows.find(row => row.name === 'TOKEN_BUDGET')?.envval).toBe('10');
    expect(JSON.stringify(result)).not.toContain('synthetic-template-token');
  });

  it('显式文件覆盖模板，纯数字凭据也不会进入任何产物', () => {
    const result = runFixture(['--env-file', 'operator-input.conf'], 'EXAMPLE_ENABLED=false\nBOT_TOKEN=98765432101234567890\n');
    expect(result.json.source).toEqual({ file: 'operator-input.conf', kind: 'explicit_file' });
    expect(result.json.summary).toMatchObject({ on_in_source: 0, set_in_source: 2 });
    expect(result.markdown).toContain('配置来源：显式指定文件 "operator-input.conf"');
    expect(result.json.rows.find(row => row.name === 'BOT_TOKEN')?.envval).toBe('<redacted>');
    expect(result.markdown).toContain('&lt;redacted&gt;');
    expect(JSON.stringify(result)).not.toContain('98765432101234567890');
    expect(result.markdown).not.toContain('\0');
  });
});
