// Meta CodeAct sandbox — in-process vm, orchestration APIs only (no TG send).

import { Script, createContext, type Context } from 'node:vm';
import { logger } from '../shared/logger.js';

export interface MetaSandboxResult {
  output: string;
  error: boolean;
  logs: string[];
}

export class MetaSandbox {
  private readonly context: Context;
  private readonly logs: string[] = [];

  constructor(api: Record<string, unknown>, timeoutMs = 30_000) {
    const logs = this.logs;
    const consoleProxy = {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => logs.push('[warn] ' + args.map(String).join(' ')),
      error: (...args: unknown[]) => logs.push('[error] ' + args.map(String).join(' ')),
    };

    const globals: Record<string, unknown> = {
      console: consoleProxy,
      JSON,
      Math,
      Date,
      Array,
      Object,
      Map,
      Set,
      Promise,
      String,
      Number,
      Boolean,
      RegExp,
      ...api,
    };

    this.context = createContext(globals, {
      name: 'MetaSandbox',
    });
    // stash timeout for execute
    (this as unknown as { _timeoutMs: number })._timeoutMs = timeoutMs;
  }

  execute(code: string): MetaSandboxResult {
    this.logs.length = 0;
    const timeoutMs = (this as unknown as { _timeoutMs: number })._timeoutMs ?? 30_000;
    try {
      const wrapped = `"use strict";\n${code}`;
      const script = new Script(wrapped, { filename: 'meta-codeact.js' });
      const result = script.runInContext(this.context, { timeout: timeoutMs, displayErrors: true });
      const output =
        result === undefined || result === null
          ? this.logs.join('\n')
          : typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2);
      return { output: output || '(no output)', error: false, logs: [...this.logs] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug({ err: msg }, 'Meta sandbox execution error');
      return { output: msg, error: true, logs: [...this.logs] };
    }
  }
}
