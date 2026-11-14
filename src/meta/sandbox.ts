import { executeIsolatedCode } from '../sandbox/codeact/runner.js';
import { META_CAPABILITY_METHODS, selectCodeActCapabilities } from '../sandbox/codeact/capabilities.js';

export interface MetaSandboxResult {
  output: string;
  error: boolean;
  logs: string[];
}

export class MetaSandbox {
  /** Compatibility facade; generated code always goes through OS isolation. */
  constructor(private readonly api: Record<string, unknown>, private readonly timeoutMs = 30_000) {}

  async execute(code: string): Promise<MetaSandboxResult> {
    try {
      const { value, logs } = await executeIsolatedCode(code, selectCodeActCapabilities(this.api, META_CAPABILITY_METHODS), {
        timeoutMs: this.timeoutMs,
      });
      const output = value === undefined || value === null ? logs.join('\n')
        : typeof value === 'string' ? value : JSON.stringify(value);
      return { output: output || '(no output)', error: false, logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: msg, error: true, logs: [] };
    }
  }
}
