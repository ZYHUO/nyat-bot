// ────────────────────────────────────────
// Skill Loader — load external skill plugins from JSON files
// ────────────────────────────────────────

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import { logger } from '../../shared/logger.js';
import { assertUrlSsrfSafe, fetchUrlPinned } from './ssrf.js';

// ── Schema ────────────────────────────────────────

const paramSchema = z.record(
  z.object({
    type: z.enum(['string', 'number', 'boolean']).default('string'),
    description: z.string().default(''),
  }),
);

const httpExecuteSchema = z.object({
  type: z.literal('http'),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.record(z.unknown()).optional(),
  resultPath: z.string().optional(),
  // When trusted=true, every resolved URL must point to one of these hosts
  // (lowercase). Required when trusted is true. Wildcard via "*.example.com".
  allowedHosts: z.array(z.string().min(1)).optional(),
});

const scriptExecuteSchema = z.object({
  type: z.literal('script'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  timeout: z.number().default(10000),
});

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: paramSchema.default({}),
  trusted: z.boolean().default(false),
  execute: z.discriminatedUnion('type', [httpExecuteSchema, scriptExecuteSchema]),
});

type SkillDef = z.infer<typeof skillSchema>;
type ParamDef = z.infer<typeof paramSchema>;

// ── Helpers ───────────────────────────────────────

function applyTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    params[key] !== undefined ? String(params[key]) : `{{${key}}}`,
  );
}

function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const entry of allowedHosts) {
    const allowed = entry.toLowerCase();
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // ".example.com"
      if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
    } else if (host === allowed) {
      return true;
    }
  }
  return false;
}

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function buildZodParams(params: ParamDef): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(params)) {
    let field: z.ZodTypeAny;
    if (def.type === 'number') field = z.number();
    else if (def.type === 'boolean') field = z.boolean();
    else field = z.string();
    shape[key] = def.description ? field.describe(def.description) : field;
  }
  return z.object(shape);
}

// ── Executors ─────────────────────────────────────

async function executeHttp(
  exec: z.infer<typeof httpExecuteSchema>,
  params: Record<string, unknown>,
  trusted = false,
): Promise<unknown> {
  const url = applyTemplate(exec.url, params);
  if (trusted) {
    const allowedHosts = exec.allowedHosts ?? [];
    if (allowedHosts.length === 0) {
      throw new Error('trusted skill missing allowedHosts');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL after template expansion');
    }
    if (!isHostAllowed(parsed.hostname, allowedHosts)) {
      throw new Error(`Host ${parsed.hostname} not in allowedHosts`);
    }
  } else {
    assertUrlSsrfSafe(url);
  }

  const headers: Record<string, string> = exec.headers
    ? Object.fromEntries(Object.entries(exec.headers).map(([k, v]) => [k, applyTemplate(v, params)]))
    : {};

  let body: string | undefined;
  if (exec.body && exec.method !== 'GET') {
    body = JSON.stringify(
      Object.fromEntries(
        Object.entries(exec.body).map(([k, v]) => [
          k,
          typeof v === 'string' ? applyTemplate(v, params) : v,
        ]),
      ),
    );
    headers['Content-Type'] = 'application/json';
  }

  let statusCode: number;
  let bodyText: string;

  if (trusted) {
    const res = await fetch(url, { method: exec.method, headers, body, signal: AbortSignal.timeout(60_000) });
    statusCode = res.status;
    bodyText = await res.text();
  } else {
    const res = await fetchUrlPinned(url, { method: exec.method, headers, body, signal: AbortSignal.timeout(30_000), timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 });
    statusCode = res.statusCode;
    bodyText = res.body;
  }

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP ${statusCode}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error('Response is not valid JSON');
  }
  return exec.resultPath ? getNestedValue(data, exec.resultPath) : data;
}

// ── Skill → Tool ──────────────────────────────────

export interface LoadedSkillEntry {
  tool: Tool;
  parameterSchema: ZodTypeAny;
}

function skillEntry(skill: SkillDef): LoadedSkillEntry {
  const parameterSchema = buildZodParams(skill.parameters);
  return {
    parameterSchema,
    tool: tool({
      description: skill.description,
      parameters: parameterSchema,
      execute: async (params: Record<string, unknown>) => {
        try {
          if (skill.execute.type === 'http') {
            return await executeHttp(skill.execute, params, skill.trusted);
          }
          return { error: 'Script execution is disabled' };
        } catch (err) {
          logger.warn({ err, skill: skill.name }, 'Skill execution failed');
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
}

// ── Public API ────────────────────────────────────

export async function loadSkills(skillsDir: string): Promise<Record<string, LoadedSkillEntry>> {
  const tools: Record<string, LoadedSkillEntry> = {};

  let files: string[];
  try {
    files = (await readdir(skillsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    // Directory doesn't exist or unreadable — silently skip
    return tools;
  }

  const BUILTIN_TOOLS = new Set(['SEARCH', 'FETCH', 'IP_QUALITY', 'ADD_TIMER', 'LIST_TIMERS', 'DELETE_TIMER', 'BOT_KNOWLEDGE']);

  for (const file of files) {
    const filePath = join(skillsDir, file);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const json: unknown = JSON.parse(raw);
      const skill = skillSchema.parse(json);
      if (!/^[A-Z0-9_]+$/.test(skill.name)) {
        logger.warn({ name: skill.name, file }, 'Skill name contains invalid characters (must match /^[A-Z0-9_]+$/), skipping');
        continue;
      }
      if (skill.execute.type === 'script') {
        logger.warn({ name: skill.name }, 'Skill type "script" is disabled for security reasons, skipping');
        continue;
      }
      if (BUILTIN_TOOLS.has(skill.name)) {
        logger.warn({ name: skill.name }, 'Skill name conflicts with a built-in tool, skipping');
        continue;
      }
      if (
        skill.trusted &&
        skill.execute.type === 'http' &&
        (!skill.execute.allowedHosts || skill.execute.allowedHosts.length === 0)
      ) {
        logger.warn(
          { name: skill.name },
          'Trusted skill must declare a non-empty allowedHosts list, skipping',
        );
        continue;
      }
      tools[skill.name] = skillEntry(skill);
      logger.debug({ name: skill.name, file }, 'Loaded skill');
    } catch (err) {
      logger.warn({ err, file: filePath }, 'Failed to load skill, skipping');
    }
  }

  return tools;
}
