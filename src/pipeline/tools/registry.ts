// ────────────────────────────────────────
// Tool Registry — Vercel AI SDK tool definitions
// ────────────────────────────────────────

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import { executeSearch } from './search.js';
import { executeFetch } from './web-fetch.js';
import { executeIpQuality } from './ip-quality.js';
import { addTimer, listTimers, deleteTimer } from './timer.js';
import { queryBotKnowledge } from './bot-knowledge.js';
import { executePoll } from './poll.js';
import { env } from '../../env.js';
import { loadSkills, type LoadedSkillEntry } from './skill-loader.js';

// Skills are loaded once at startup and cached
let _skillsCache: Record<string, LoadedSkillEntry> | undefined;
let _skillsLoading: Promise<void> | undefined;

export function preloadSkills(): Promise<void> {
  if (_skillsLoading) return _skillsLoading;
  _skillsLoading = loadSkills(env().SKILLS_DIR).then((skills) => {
    _skillsCache = skills;
  });
  return _skillsLoading;
}

function buildSchemasAndTools(
  chatId: number,
  userId: number,
): { tools: Record<string, Tool>; schemas: Map<string, ZodTypeAny> } {
  const e = env();
  const tools: Record<string, Tool> = {};
  const schemas = new Map<string, ZodTypeAny>();

  const register = (name: string, schema: ZodTypeAny, t: Tool) => {
    tools[name] = t;
    schemas.set(name, schema);
  };

  const searchSchema = z.object({
    query: z.string().describe('搜索查询关键词'),
  });
  register(
    'SEARCH',
    searchSchema,
    tool({
      description: '搜索互联网获取最新信息。当用户询问你不确定的事实、新闻、或需要实时数据时使用。',
      parameters: searchSchema,
      execute: async ({ query }) => executeSearch(query),
    }),
  );

  const fetchSchema = z.object({
    url: z.string().url().describe('要抓取的网页URL'),
  });
  register(
    'FETCH',
    fetchSchema,
    tool({
      description: '抓取并读取指定URL的网页内容。当用户分享链接或需要读取特定网页时使用。',
      parameters: fetchSchema,
      execute: async ({ url }) => executeFetch(url),
    }),
  );

  if (e.IP_QUALITY_API_URL) {
    const ipSchema = z.object({
      ip: z.string().describe('要查询的IP地址或域名'),
    });
    register(
      'IP_QUALITY',
      ipSchema,
      tool({
        description: '查询IP地址或域名的质量信息，包括地理位置、ISP、是否为代理等。',
        parameters: ipSchema,
        execute: async ({ ip }) => executeIpQuality(ip),
      }),
    );
  }

  if (e.TIMER_API_URL) {
    const addTimerSchema = z.object({
      name: z.string().describe('定时器名称'),
      cron_expression: z.string().describe('Cron表达式（北京时间）：分 时 日 月 周，如 "30 14 12 4 *"'),
      one_time: z.boolean().default(false).describe('是否为一次性触发（触发后自动删除）'),
      message: z.string().optional().describe('提醒消息内容'),
    });
    register(
      'ADD_TIMER',
      addTimerSchema,
      tool({
        description: [
          '创建定时提醒或定时任务。支持自然语言时间，模型负责将其转换为 cron 表达式（北京时间 UTC+8）。',
          '示例:',
          '  "3小时后提醒我" → one_time=true，cron=当前时间+3h',
          '  "每天早上8点" → cron="0 8 * * *"，one_time=false',
          '  "下午3点提醒一次" → one_time=true，cron="0 15 <今天日> <今月> *"',
          '  "每周一早上9点" → cron="0 9 * * 1"',
          '注意: cron表达式用本地北京时间，分 时 日 月 周。one_time=true表示只触发一次后自动删除。',
        ].join('\n'),
        parameters: addTimerSchema,
        execute: async (params) => addTimer({ ...params, chatId, userId }),
      }),
    );

    const listTimersSchema = z.object({});
    register(
      'LIST_TIMERS',
      listTimersSchema,
      tool({
        description: '列出当前群组的所有活跃定时器。',
        parameters: listTimersSchema,
        execute: async () => listTimers(chatId),
      }),
    );

    const deleteTimerSchema = z.object({
      id: z.string().describe('要删除的定时器ID'),
    });
    register(
      'DELETE_TIMER',
      deleteTimerSchema,
      tool({
        description: '删除指定ID的定时器。',
        parameters: deleteTimerSchema,
        execute: async ({ id }) => deleteTimer(id),
      }),
    );
  }

  const botKnowledgeSchema = z.object({
    query: z.string().describe('Bot用户名（不含@）或 "list"'),
  });
  register(
    'BOT_KNOWLEDGE',
    botKnowledgeSchema,
    tool({
      description: '查询本群其他bot的知识。传入bot用户名查看该bot信息，或传"list"列出所有已知bot。',
      parameters: botKnowledgeSchema,
      execute: async ({ query }) => queryBotKnowledge(chatId, query),
    }),
  );

  const pollSchema = z.object({
    question: z.string().describe('投票问题'),
    options: z.array(z.string()).min(2).max(10).describe('选项列表，2-10个'),
  });
  register(
    'CREATE_POLL',
    pollSchema,
    tool({
      description: '创建投票。当用户想发起投票或群内决策时使用。',
      parameters: pollSchema,
      execute: async ({ question, options }) => executePoll(chatId, question, options),
    }),
  );

  if (_skillsCache) {
    for (const [name, entry] of Object.entries(_skillsCache)) {
      register(name, entry.parameterSchema, entry.tool);
    }
  }

  return { tools, schemas };
}

export function buildToolSet(chatId: number, userId: number): Record<string, Tool> {
  return buildSchemasAndTools(chatId, userId).tools;
}

/**
 * Parse tool arguments with the same Zod schemas as the AI SDK tools, then execute.
 * Used by the planner path so model-emitted JSON cannot skip validation.
 */
export async function executeValidatedToolStep(
  toolName: string,
  rawArgs: unknown,
  chatId: number,
  userId: number,
): Promise<unknown> {
  const { tools, schemas } = buildSchemasAndTools(chatId, userId);
  const schema = schemas.get(toolName);
  const t = tools[toolName];
  if (!schema || !t?.execute) {
    throw new Error(`Unknown or non-executable tool: ${toolName}`);
  }
  const parsed = schema.parse(rawArgs ?? {});
  const out = t.execute(parsed as never, {
    toolCallId: 'planner',
    messages: [],
  });
  return await Promise.resolve(out);
}

export function getToolNames(chatId: number, userId: number): string[] {
  return Object.keys(buildToolSet(chatId, userId));
}
