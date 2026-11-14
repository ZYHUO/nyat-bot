/** Read-only report inputs. Explicit paths never require a private .env. */
export function logInput(argv: readonly string[]): {
  args: string[]; logFile: string; nowMs: number; offline: boolean; dbFile?: string; metricsFile?: string;
} {
  const args: string[] = [];
  const values = new Map<string, string>();
  let offline = false;
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]!;
    if (item === '--') continue;
    if (item === '--offline') { offline = true; continue; }
    const match = /^(--log-file|--now|--db-file|--metrics-file)(?:=(.*))?$/u.exec(item);
    if (!match) { args.push(item); continue; }
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith('--') || values.has(match[1]!)) throw new Error('invalid_or_duplicate_report_input');
    values.set(match[1]!, value);
  }
  const rawNow = values.get('--now');
  const nowMs = rawNow === undefined ? Date.now() : Date.parse(rawNow);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('invalid_report_time');
  return { args, logFile: values.get('--log-file') ?? 'logs/app.log', nowMs, offline,
    dbFile: values.get('--db-file'), metricsFile: values.get('--metrics-file') };
}
