import { describe, expect, it } from 'vitest';
import { logInput } from '../../../scripts/log-input.mts';
import { reportFixture, REPORT_NOW } from '../../helpers/log-script.js';

describe('explicit offline report input', { timeout: 30_000 }, () => {
  it('preserves default operational paths and accepts both option forms', () => {
    expect(logInput([]).logFile).toBe('logs/app.log');
    expect(logInput(['3', '--log-file=fixture.jsonl', '--now', REPORT_NOW, '--offline', '--metrics-file=snapshot.txt']))
      .toMatchObject({ args: ['3'], logFile: 'fixture.jsonl', nowMs: Date.parse(REPORT_NOW), offline: true, metricsFile: 'snapshot.txt' });
  });
  it('rejects missing/duplicate input and an invalid clock rather than silently reading live data', () => {
    for (const args of [['--log-file'], ['--log-file', '--offline'], ['--now=not-time'], ['--log-file=a', '--log-file=b']]) {
      expect(() => logInput(args)).toThrow();
    }
  });
  it('offline session report has no implicit metrics or database connection', () => {
    const fixture = reportFixture([]);
    try {
      const result = fixture.run('scripts/session-report.mts', ['1', '--offline']);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain('离线模式未提供可读 metrics 快照——未读到，不是零');
      expect(result.out).toContain('离线模式未提供 SQLite 快照');
    } finally { fixture.cleanup(); }
  });
  it('day selection excludes later days, not just earlier timestamps', () => {
    const fixture = reportFixture([
      { time: Date.parse('2026-11-14T10:00:00Z'), msg: 'Meta heart: pass', why: 'llm_failed' },
      { time: Date.parse('2026-11-15T10:00:00Z'), msg: 'Meta heart: pass', why: 'llm_failed' },
    ]);
    try {
      const result = fixture.run('scripts/measure-voice.mts', ['--day', '2026-11-14']);
      expect(result.code, result.err).toBe(0);
      expect(result.out).toContain('1 次 pass 是 LLM 失败 fail-closed');
      expect(result.out).not.toContain('2 次 pass');
    } finally { fixture.cleanup(); }
  });
});
