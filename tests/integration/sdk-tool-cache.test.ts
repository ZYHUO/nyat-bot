import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ generate: vi.fn(), toolSet: vi.fn(() => ({})), events: vi.fn() }));
vi.mock('ai', () => ({ generateText: f.generate }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => (model: string) => ({ model }) }));
vi.mock('../../src/ai/labels.js', () => ({
  getUsage: () => ({ label: 'synthetic-primary', backups: ['synthetic-backup'], timeout: 5000 }),
  getLabel: (name: string) => ({ name, model: 'synthetic-model', apiKeys: ['synthetic-key'], endpoint: 'https://synthetic.invalid' }),
}));
vi.mock('../../src/ai/cooldown.js', () => ({ CooldownTracker: class {
  isCoolingDown = async () => false; setCooldown = async () => {};
} }));
vi.mock('../../src/ai/concurrency.js', () => ({
  AI_MAX_CONCURRENCY_PER_ACCOUNT: 7, acquireConcurrency: async () => () => {},
}));
vi.mock('../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../src/pipeline/tools/registry.js', () => ({ buildToolSet: f.toolSet }));
vi.mock('../../src/shared/config.js', () => ({ getConfig: () => ({ promptsDir: '' }), loadPrompt: () => 'synthetic scoped system' }));
vi.mock('../../src/env.js', () => ({ env: () => ({ REPLY_TOOLS_MAX_STEPS: 3, PLANNER_MAX_STEPS: 3 }) }));
vi.mock('../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { generateReplyWithTools } from '../../src/pipeline/reply/reply-with-tools.js';
import { runAgenticPlanner } from '../../src/pipeline/planner/agentic-loop.js';
import { llmEvents } from '../../src/ai/events.js';

const step = { usage: { promptTokens: 100, completionTokens: 5 }, providerMetadata: { openai: { cachedPromptTokens: 80 } } };
const result = { text: 'synthetic answer', steps: [{ toolCalls: [], toolResults: [] }], usage: step.usage };
const invoke = (kind: 'writer' | 'planner') => kind === 'writer'
  ? generateReplyWithTools({ usage: 'reply', chatId: -11, userId: 22, toolsOnly: ['RECALL'], messages: [{ role: 'user', content: 'synthetic question' }] })
  : runAgenticPlanner({ chatId: -11, userId: 22, toolFilter: ['RECALL'], messageText: 'synthetic question', context: 'synthetic context' });

beforeEach(() => {
  f.generate.mockReset(); f.toolSet.mockClear(); f.events.mockReset();
  llmEvents.on('result', f.events);
  f.generate.mockImplementation(async options => { options.onStepFinish(step); return result; });
});
afterEach(() => llmEvents.off('result', f.events));

describe('native SDK tool paths report cache usage without changing capability scope', () => {
  it.each(['writer', 'planner'] as const)('%s observes each completed step', async kind => {
    expect((await invoke(kind)).failed).toBe(false);
    expect(f.toolSet).toHaveBeenCalledWith(-11, 22, ['RECALL']);
    expect(f.events).toHaveBeenCalledOnce();
    expect(f.events.mock.calls[0]![0]).toMatchObject({
      usage: kind === 'writer' ? 'reply' : 'judge', label: 'synthetic-primary',
      promptTokens: 100, cachedTokens: 80, completionTokens: 5, chatId: -11,
    });
  });

  it('retains a completed tool-step measurement when a later step fails and the next label succeeds', async () => {
    f.generate.mockImplementationOnce(async options => {
      options.onStepFinish(step);
      throw new Error('synthetic later step failure');
    });
    expect((await invoke('writer')).failed).toBe(false);
    expect(f.events.mock.calls.map(([event]) => [event.label, event.cachedTokens])).toEqual([
      ['synthetic-primary', 80], ['synthetic-backup', 80],
    ]);
  });
});
