# Direct/Planned Reply Architecture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the judge-controlled reply architecture so ordinary chat uses the fastest direct path, tool-using requests go through a real planner, and the system exposes enough telemetry to validate latency and correctness in production.

**Architecture:** Keep the current `judge -> pipeline -> reply` skeleton, but normalize the decision contract so reply intent, path, and model tier are separate dimensions. Add a dedicated planner stage for `planned` replies, then split generation into `direct writer` and `planned writer` flows. Introduce a lighter retrieval path for direct replies and add structured logging/verification around path selection, tool usage, and latency.

**Tech Stack:** TypeScript, Node 22, Vitest, Vercel AI SDK, OpenAI-compatible providers, Telegram bot pipeline, better-sqlite3, Redis, PM2.

---

## Current State Snapshot

- `replyPath` already exists in [src/shared/types.ts](/root/xxb-ts/src/shared/types.ts) and is wired through judge parsing plus reply execution.
- `direct` replies already skip `generateWithTools()` and use `callWithFallback()`.
- `planned` replies still reuse the old tool-aware reply path. There is no standalone planner yet.
- Both `direct` and `planned` still pay the full [src/pipeline/context/retriever.ts](/root/xxb-ts/src/pipeline/context/retriever.ts) cost.
- Observability is still log-only and does not clearly separate `direct` vs `planned` latency budgets.

## Architecture Analysis

### Why This Refactor Exists

The original discussion was not just about adding a planner. The actual problem statement is broader:

- Ordinary chat is currently overpaying for a heavy reply path.
- Tool selection currently happens too late, inside reply generation.
- Latency is hard to predict because the current reply path can silently escalate into tool usage.
- `REPLY_PRO` currently conflates at least two different concepts:
  - answer complexity / model budget
  - whether the system should do tool planning first

The target architecture is therefore not "add one more module". It is:

- move routing earlier
- separate concerns cleanly
- make direct chat cheap
- make planned replies explicit and controllable
- improve average latency and tail latency under concurrency

### What The Current Architecture Gets Wrong

Today the flow is effectively:

```text
judge -> full retrieval -> tool-aware reply model -> optional tools -> final answer
```

That has four structural problems:

1. **Simple and complex requests share the same expensive path**
   Direct banter, small clarifications, and factual short answers all go through the same heavy retrieval and tool-capable reply path as search / webpage / timer tasks.

2. **Tool usage is decided too late**
   The system cannot know early whether a request will stay cheap or become expensive, because tool choice is embedded inside the reply model call.

3. **Latency distribution becomes unstable**
   Even if most requests do not end up using tools, the tool-aware generation mode still adds overhead and unpredictability. This hurts P95/P99 more than median latency.

4. **The architecture becomes harder to extend**
   Every new tool increases reply complexity because the final writer can reach for it directly. That makes future tooling additions harder to reason about and test.

### Why Judge Should Stay Light

Judge is currently the fast gating stage:

- L0 local rules
- L1 micro judge
- L2 AI fallback judge

It should remain responsible for:

- whether to reply
- whether the reply path is `direct` or `planned`
- what model tier the answer should use

It should **not** become responsible for:

- exact tool arguments
- multi-step tool sequencing
- final content synthesis

If judge starts generating detailed tool plans, it stops being a low-cost classifier and becomes a second reply model. That makes the architecture muddled and slower.

### Why `replyPath` And `replyTier` Must Be Separate

These are different axes:

- `replyPath`
  - `direct`: no planning stage, no tool execution stage
  - `planned`: planning stage exists, tools may run before final writing
- `replyTier`
  - `fast` / `normal` / `pro` depending on chosen naming
  - describes model strength / cost / timeout / answer depth

Examples:

- A complex reasoning question with no external facts may be `direct + pro`.
- A short request that needs live web data may be `planned + fast`.

Treating `REPLY_PRO` as the planner switch is architecturally wrong because it couples two unrelated concerns.

### Why Direct Path Must Be Truly Cheap

A "logical split" is not enough. The direct path only helps if it is also a **cost split**.

Direct path requirements:

- no tool-aware generation
- no planner stage
- reduced retrieval payload
- smaller prompt where possible
- lower timeout budget
- predictable latency envelope

If direct replies still pay for:

- full retrieval
- tool-capable model setup
- wide prompt assembly

then the architecture looks cleaner on paper but does not materially improve throughput.

### Why Planned Path Needs A Real Planner

The planned path should be:

```text
judge -> planner -> explicit tool execution -> final writer
```

This gives the system:

- explicit tool selection
- explicit execution order
- bounded tool counts
- bounded timeout budgets
- cleaner observability
- better failure handling

It also means the final writer only synthesizes from evidence rather than improvising tool usage mid-generation.

### Concurrency And Latency Goals

This refactor is justified mainly by concurrency and latency control, not feature richness.

Target improvements:

- Lower average latency for ordinary chat
- Lower queue pressure during spikes
- More predictable path-specific latency
- Better P95/P99 because only a minority of messages should enter the expensive path

The direct path is the throughput path.
The planned path is the capability path.
The system should default to throughput unless capability is clearly required.

### Path Selection Principles

Default stance:

- prefer `direct`
- require explicit evidence before choosing `planned`

Typical `direct` requests:

- greetings
- short roleplay / banter
- simple clarification
- answerable from existing context / static bot knowledge
- short discussion that does not require live external facts

Typical `planned` requests:

- live web search
- fetching a shared URL
- timers / actions
- bot-knowledge lookup
- explicit "go check / go search / read this link / set a reminder"
- multi-step "find then answer" tasks

### Planned Path Guardrails

Planner output must be bounded so planned replies cannot dominate the system under load.

Guardrails to enforce:

- maximum 2-3 tool steps
- per-tool single execution unless there is a strong reason otherwise
- total planner + tool budget capped
- only tools from the explicit registry may be emitted
- planner never writes the final user-facing answer

### Rollout Principle

This should be delivered in phases rather than as a single risky rewrite.

Phase 1:

- judge emits `replyPath`
- direct path disables tools
- planned path still reuses current executor

Phase 2:

- introduce real planner
- introduce explicit executor
- final writer consumes tool results instead of self-calling tools

Phase 3:

- add lightweight retrieval mode for direct
- add telemetry and production measurements

That phased approach preserves stability while still shipping the performance win early.

## Success Criteria

The implementation is successful only if all of these are true:

- Direct chat no longer goes through tool-aware generation.
- Planned replies use an explicit planning stage before final writing.
- Direct retrieval is materially lighter than planned retrieval.
- Logging clearly distinguishes `replyPath`, `replyTier`, tool count, and latency buckets.
- The team can add new tools without turning the final reply writer into an unbounded control surface.

## Non-Goals

This project is **not** trying to do these things in the same pass:

- redesign every prompt from scratch
- replace the whole judge cascade
- build a general-purpose workflow engine
- add new tools unrelated to this architecture
- optimize unrelated subsystems such as message formatting or admin APIs

## Key Risks

1. **Planner over-triggering**
   If planned path is selected too often, the latency benefit collapses.

2. **Direct path semantic regression**
   If direct retrieval becomes too thin, replies may become less coherent.

3. **Planner/output schema drift**
   If prompts and parsers diverge, the system can silently fall back to the wrong path.

4. **Double-execution risk**
   During migration, legacy tool-aware paths and explicit planned execution must not both run for the same message.

5. **Observability gaps**
   Without path-specific telemetry, rollout quality cannot be assessed honestly.

## File Map

**Modify:**
- `src/shared/types.ts`
- `src/pipeline/judge/judge.ts`
- `src/pipeline/judge/micro.ts`
- `src/pipeline/judge/rules.ts`
- `src/pipeline/pipeline.ts`
- `src/pipeline/context/retriever.ts`
- `src/pipeline/reply/reply.ts`
- `src/pipeline/tools/executor.ts`
- `prompts/task/judge.md`
- `prompts/contract/judge-schema.json`
- `prompts/task/reply.md`
- `prompts/task/reply-pro.md`

**Create:**
- `src/pipeline/planner/types.ts`
- `src/pipeline/planner/parser.ts`
- `src/pipeline/planner/planner.ts`
- `src/pipeline/planner/executor.ts`
- `prompts/task/planner.md`
- `prompts/contract/planner-schema.json`
- `tests/unit/pipeline/planner.test.ts`
- `tests/unit/pipeline/pipeline-paths.test.ts`
- `tests/unit/pipeline/retriever-direct.test.ts`

**Extend tests:**
- `tests/unit/ai/fallback.test.ts`
- `tests/unit/judge/rules.test.ts`
- `tests/unit/pipeline/reply.test.ts`
- `tests/unit/pipeline/retriever.test.ts`
- `tests/unit/pipeline/tools/registry.test.ts`

## Chunk 1: Normalize The Judge Contract

### Task 1: Split reply decision into action, path, and tier

**Files:**
- Modify: `src/shared/types.ts`
- Test: `tests/unit/ai/fallback.test.ts`

- [ ] **Step 1: Write the failing tests for the normalized decision contract**

```ts
it('defaults REPLY to direct + normal tier', () => {
  const result = parseJudgeAction('{"action":"REPLY"}');
  expect(result).toMatchObject({
    action: 'REPLY',
    replyPath: 'direct',
    replyTier: 'normal',
  });
});

it('allows REPLY with planned path and pro tier', () => {
  const result = parseJudgeAction('{"action":"REPLY","replyPath":"planned","replyTier":"pro"}');
  expect(result).toMatchObject({
    action: 'REPLY',
    replyPath: 'planned',
    replyTier: 'pro',
  });
});
```

- [ ] **Step 2: Run the parser tests to verify they fail**

Run: `npx vitest run tests/unit/ai/fallback.test.ts`
Expected: FAIL because `replyTier` does not exist yet and parser still treats `REPLY_PRO` as a first-class action.

- [ ] **Step 3: Add normalized types**

```ts
export type JudgeAction = 'REPLY' | 'IGNORE' | 'REJECT';
export type ReplyPath = 'direct' | 'planned';
export type ReplyTier = 'normal' | 'pro';

export interface JudgeResult {
  action: JudgeAction;
  replyPath?: ReplyPath;
  replyTier?: ReplyTier;
  // ...
}
```

- [ ] **Step 4: Add helper defaults in `src/shared/types.ts`**

```ts
export function resolveReplyPath(action: JudgeAction, replyPath?: ReplyPath): ReplyPath | undefined {
  if (action === 'REPLY') return replyPath ?? 'direct';
  return undefined;
}

export function resolveReplyTier(action: JudgeAction, replyTier?: ReplyTier): ReplyTier | undefined {
  if (action === 'REPLY') return replyTier ?? 'normal';
  return undefined;
}
```

- [ ] **Step 5: Re-run the parser tests**

Run: `npx vitest run tests/unit/ai/fallback.test.ts`
Expected: PASS for newly added contract assertions.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts tests/unit/ai/fallback.test.ts
git commit -m "refactor: normalize judge decision contract"
```

### Task 2: Update judge prompt, schema, and parser to the normalized format

**Files:**
- Modify: `src/pipeline/judge/micro.ts`
- Modify: `prompts/task/judge.md`
- Modify: `prompts/contract/judge-schema.json`
- Test: `tests/unit/ai/fallback.test.ts`

- [ ] **Step 1: Write failing parser cases for legacy and new outputs**

```ts
it('maps legacy REPLY_PRO to REPLY + planned + pro', () => {
  const result = parseJudgeAction('{"action":"REPLY_PRO"}');
  expect(result).toMatchObject({
    action: 'REPLY',
    replyPath: 'planned',
    replyTier: 'pro',
  });
});
```

- [ ] **Step 2: Run parser tests and verify the new legacy-compat case fails**

Run: `npx vitest run tests/unit/ai/fallback.test.ts`
Expected: FAIL because the parser still emits `action: 'REPLY_PRO'`.

- [ ] **Step 3: Update `parseJudgeAction` to support both schemas**

```ts
if (action === 'REPLY_PRO') {
  return { action: 'REPLY', replyPath: 'planned', replyTier: 'pro', ... };
}

if (action === 'REPLY') {
  return {
    action: 'REPLY',
    replyPath: resolveReplyPath('REPLY', parsedReplyPath),
    replyTier: resolveReplyTier('REPLY', parsedReplyTier),
    // ...
  };
}
```

- [ ] **Step 4: Rewrite the judge prompt and schema so the model emits only the new shape**

```json
{
  "action": "REPLY" | "IGNORE" | "REJECT",
  "replyPath": "direct" | "planned",
  "replyTier": "normal" | "pro",
  "confidence": 0.0,
  "reasoning": "..."
}
```

- [ ] **Step 5: Re-run parser tests**

Run: `npx vitest run tests/unit/ai/fallback.test.ts`
Expected: PASS, including legacy compatibility.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/judge/micro.ts prompts/task/judge.md prompts/contract/judge-schema.json tests/unit/ai/fallback.test.ts
git commit -m "refactor: migrate judge prompt to path and tier outputs"
```

### Task 3: Update L0 rules and judge orchestration to emit normalized decisions

**Files:**
- Modify: `src/pipeline/judge/rules.ts`
- Modify: `src/pipeline/judge/judge.ts`
- Test: `tests/unit/judge/rules.test.ts`

- [ ] **Step 1: Add failing rule tests for `replyTier` defaults**

```ts
it('mention_self returns REPLY with direct path and normal tier', () => {
  const result = evaluateRules(ctx)!;
  expect(result).toMatchObject({
    action: 'REPLY',
    replyPath: 'direct',
    replyTier: 'normal',
  });
});
```

- [ ] **Step 2: Run the rules test file to confirm failure**

Run: `npx vitest run tests/unit/judge/rules.test.ts`
Expected: FAIL because rule results do not include `replyTier`.

- [ ] **Step 3: Update `makeResult()` and logging**

```ts
function makeResult(action: JudgeAction, rule: string): JudgeResult {
  return {
    action,
    replyPath: resolveReplyPath(action),
    replyTier: resolveReplyTier(action),
    level: 'L0_RULE',
    rule,
    latencyMs: 0,
  };
}
```

- [ ] **Step 4: Thread `replyTier` through `judge()` logging and return values**

Run path: `src/pipeline/judge/judge.ts`
Expected code shape: logger fields include `replyPath` and `replyTier`.

- [ ] **Step 5: Re-run rules tests**

Run: `npx vitest run tests/unit/judge/rules.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/judge/rules.ts src/pipeline/judge/judge.ts tests/unit/judge/rules.test.ts
git commit -m "refactor: emit normalized judge decisions from local rules"
```

## Chunk 2: Introduce A Real Planner Path

### Task 4: Define planner types, schema, and parser

**Files:**
- Create: `src/pipeline/planner/types.ts`
- Create: `src/pipeline/planner/parser.ts`
- Create: `prompts/contract/planner-schema.json`
- Test: `tests/unit/pipeline/planner.test.ts`

- [ ] **Step 1: Write a failing parser test for planner output**

```ts
it('parses a tool plan with ordered steps', () => {
  const plan = parsePlannerResponse(JSON.stringify({
    needTools: true,
    steps: [
      { tool: 'SEARCH', args: { query: 'latest openai api changes' }, purpose: 'fetch fresh facts' },
      { tool: 'FETCH', args: { url: 'https://example.com' }, purpose: 'read the linked page' },
    ],
  }));

  expect(plan).toMatchObject({
    needTools: true,
    steps: [
      { tool: 'SEARCH' },
      { tool: 'FETCH' },
    ],
  });
});
```

- [ ] **Step 2: Run the planner test file and verify failure**

Run: `npx vitest run tests/unit/pipeline/planner.test.ts`
Expected: FAIL because planner files do not exist yet.

- [ ] **Step 3: Add planner types**

```ts
export interface ToolPlanStep {
  tool: string;
  args: Record<string, unknown>;
  purpose: string;
}

export interface ToolPlan {
  needTools: boolean;
  answerStrategy: 'direct' | 'tool_then_answer';
  steps: ToolPlanStep[];
}
```

- [ ] **Step 4: Add planner parser and schema validation**

```ts
const PlannerSchema = z.object({
  needTools: z.boolean(),
  answerStrategy: z.enum(['direct', 'tool_then_answer']).default('tool_then_answer'),
  steps: z.array(ToolPlanStepSchema).max(3),
});
```

- [ ] **Step 5: Re-run planner tests**

Run: `npx vitest run tests/unit/pipeline/planner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/planner/types.ts src/pipeline/planner/parser.ts prompts/contract/planner-schema.json tests/unit/pipeline/planner.test.ts
git commit -m "feat: add planner response contract"
```

### Task 5: Implement the planner module

**Files:**
- Create: `src/pipeline/planner/planner.ts`
- Create: `prompts/task/planner.md`
- Modify: `src/pipeline/reply/prompt-builder.ts`
- Test: `tests/unit/pipeline/planner.test.ts`

- [ ] **Step 1: Add a failing test proving planner is only called for `planned` replies**

```ts
it('builds a tool plan only when replyPath is planned', async () => {
  const plan = await planReply({ replyPath: 'planned', /* ... */ });
  expect(plan.needTools).toBe(true);
});
```

- [ ] **Step 2: Run planner tests to confirm failure**

Run: `npx vitest run tests/unit/pipeline/planner.test.ts`
Expected: FAIL because `planReply()` does not exist.

- [ ] **Step 3: Implement `planReply()`**

```ts
export async function planReply(input: PlannerInput): Promise<ToolPlan> {
  const result = await callWithFallback({
    usage: input.replyTier === 'pro' ? 'reply_pro' : 'reply',
    messages: [
      { role: 'system', content: loadPrompt('task/planner.md', promptsDir) },
      { role: 'user', content: buildPlannerPrompt(input) },
    ],
    maxTokens: 300,
    temperature: 0,
  });

  return parsePlannerResponse(result.content);
}
```

- [ ] **Step 4: Add planner prompt rules**

Prompt must say:
- Prefer zero tools unless tools are clearly required.
- Output at most 3 steps.
- Only choose tools that exist in `buildToolSet()`.
- Never write the final user-facing answer.

- [ ] **Step 5: Re-run planner tests**

Run: `npx vitest run tests/unit/pipeline/planner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/planner/planner.ts prompts/task/planner.md src/pipeline/reply/prompt-builder.ts tests/unit/pipeline/planner.test.ts
git commit -m "feat: add dedicated planner stage for tool replies"
```

### Task 6: Add a deterministic planner executor

**Files:**
- Create: `src/pipeline/planner/executor.ts`
- Modify: `src/pipeline/tools/executor.ts`
- Modify: `tests/unit/pipeline/tools/registry.test.ts`
- Test: `tests/unit/pipeline/planner.test.ts`

- [ ] **Step 1: Write failing tests for plan execution**

```ts
it('executes only planner-selected tools in order', async () => {
  const result = await executeToolPlan(plan, { chatId: 1, userId: 2 });
  expect(result.executedSteps.map((s) => s.tool)).toEqual(['SEARCH', 'FETCH']);
});
```

- [ ] **Step 2: Run planner tests and verify failure**

Run: `npx vitest run tests/unit/pipeline/planner.test.ts tests/unit/pipeline/tools/registry.test.ts`
Expected: FAIL because there is no plan executor.

- [ ] **Step 3: Implement a non-agentic executor around `buildToolSet()`**

```ts
const tools = buildToolSet(chatId, userId);
for (const step of plan.steps) {
  const tool = tools[step.tool];
  if (!tool?.execute) throw new Error(`Unknown tool: ${step.tool}`);
  const output = await tool.execute(step.args as never);
  results.push({ ...step, output });
}
```

- [ ] **Step 4: Keep `generateWithTools()` for legacy fallback only**

Do not remove it yet. Restrict new planner path to `executeToolPlan()` plus a normal writer call.

- [ ] **Step 5: Re-run planner and tool tests**

Run: `npx vitest run tests/unit/pipeline/planner.test.ts tests/unit/pipeline/tools/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/planner/executor.ts src/pipeline/tools/executor.ts tests/unit/pipeline/planner.test.ts tests/unit/pipeline/tools/registry.test.ts
git commit -m "feat: execute explicit planner tool steps"
```

### Task 7: Split reply generation into direct writer and planned writer

**Files:**
- Modify: `src/pipeline/reply/reply.ts`
- Modify: `prompts/task/reply.md`
- Modify: `prompts/task/reply-pro.md`
- Test: `tests/unit/pipeline/reply.test.ts`

- [ ] **Step 1: Add failing tests for the final architecture**

```ts
it('direct path never calls planner or tool executor', async () => {
  await generateReply(/* replyPath: direct */);
  expect(mockPlanReply).not.toHaveBeenCalled();
  expect(mockExecuteToolPlan).not.toHaveBeenCalled();
});

it('planned path calls planner, executes tools, then writes final answer without tools', async () => {
  await generateReply(/* replyPath: planned */);
  expect(mockPlanReply).toHaveBeenCalledTimes(1);
  expect(mockExecuteToolPlan).toHaveBeenCalledTimes(1);
  expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run reply tests to verify failure**

Run: `npx vitest run tests/unit/pipeline/reply.test.ts`
Expected: FAIL because planned replies still go through `generateWithTools()`.

- [ ] **Step 3: Refactor `generateReply()` into explicit sub-functions**

```ts
async function generateDirectReply(/* ... */) { /* callWithFallback only */ }
async function generatePlannedReply(/* ... */) {
  const plan = await planReply(/* ... */);
  const toolResults = await executeToolPlan(plan, /* ... */);
  return callWithFallback({
    usage,
    messages: buildMessages(systemPrompt, context, latestMessage, knowledge, undefined, undefined, toolResultsBlock),
  });
}
```

- [ ] **Step 4: Update prompts so final writers consume `[TOOL_RESULTS]` rather than self-calling tools**

Prompt requirement:
- If `[TOOL_RESULTS]` exists, synthesize from it.
- Do not claim to have used tools that are not in the provided block.
- `direct` prompt text should explicitly avoid unnecessary external lookup language.

- [ ] **Step 5: Re-run reply tests**

Run: `npx vitest run tests/unit/pipeline/reply.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/reply/reply.ts prompts/task/reply.md prompts/task/reply-pro.md tests/unit/pipeline/reply.test.ts
git commit -m "refactor: split direct and planned reply writers"
```

## Chunk 3: Make The Direct Path Actually Fast

### Task 8: Add a lightweight retrieval strategy for direct replies

**Files:**
- Modify: `src/pipeline/context/retriever.ts`
- Modify: `src/pipeline/pipeline.ts`
- Create: `tests/unit/pipeline/retriever-direct.test.ts`
- Modify: `tests/unit/pipeline/retriever.test.ts`

- [ ] **Step 1: Write failing tests for direct retrieval**

```ts
it('direct retrieval skips semantic, thread, and entity lookups when disabled', async () => {
  await retrieveContext(chatId, message, botUid, { mode: 'direct' });
  expect(mockSearchMemory).not.toHaveBeenCalled();
  expect(mockGetAll).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run retriever tests and confirm failure**

Run: `npx vitest run tests/unit/pipeline/retriever.test.ts tests/unit/pipeline/retriever-direct.test.ts`
Expected: FAIL because the retriever has no mode option.

- [ ] **Step 3: Extend retriever config with modes**

```ts
export interface RetrieverConfig {
  mode: 'direct' | 'planned';
  includeSemantic: boolean;
  includeThread: boolean;
  includeEntity: boolean;
}
```

- [ ] **Step 4: In pipeline, select retriever mode from `judgeResult.replyPath`**

Direct path behavior:
- Fetch recent window only.
- Skip `getAll()`-backed thread/entity scans.
- Skip semantic memory.
- Use a smaller token budget, for example `400-600`.

- [ ] **Step 5: Re-run retriever tests**

Run: `npx vitest run tests/unit/pipeline/retriever.test.ts tests/unit/pipeline/retriever-direct.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/context/retriever.ts src/pipeline/pipeline.ts tests/unit/pipeline/retriever.test.ts tests/unit/pipeline/retriever-direct.test.ts
git commit -m "perf: add lightweight retrieval mode for direct replies"
```

### Task 9: Add pipeline path integration tests

**Files:**
- Create: `tests/unit/pipeline/pipeline-paths.test.ts`
- Modify: `src/pipeline/pipeline.ts`

- [ ] **Step 1: Write failing tests for end-to-end path branching**

```ts
it('direct path uses lightweight retrieval and direct writer', async () => {
  await processPipeline(job);
  expect(mockRetrieveContext).toHaveBeenCalledWith(expect.any(Number), expect.anything(), expect.any(Number), expect.objectContaining({ mode: 'direct' }));
  expect(mockGenerateReply).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'REPLY', expect.any(Number), expect.any(Number), 'direct', 'normal');
});
```

- [ ] **Step 2: Run the new pipeline path test and verify failure**

Run: `npx vitest run tests/unit/pipeline/pipeline-paths.test.ts`
Expected: FAIL until the full normalized contract is threaded through `processPipeline()`.

- [ ] **Step 3: Update `processPipeline()` to pass `replyPath` and `replyTier` explicitly**

Expected call shape:

```ts
const retrievalMode = judgeResult.replyPath === 'planned' ? 'planned' : 'direct';
const replies = await generateReply(
  formatted,
  retrievedContext,
  judgeResult.action,
  job.chatId,
  getBotUid(),
  judgeResult.replyPath,
  judgeResult.replyTier,
);
```

- [ ] **Step 4: Re-run the pipeline path test**

Run: `npx vitest run tests/unit/pipeline/pipeline-paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/pipeline.ts tests/unit/pipeline/pipeline-paths.test.ts
git commit -m "test: cover direct and planned pipeline branching"
```

## Chunk 4: Observability, Rollout, And Production Verification

### Task 10: Add structured path/tier/tool telemetry

**Files:**
- Modify: `src/pipeline/pipeline.ts`
- Modify: `src/pipeline/reply/reply.ts`
- Modify: `src/pipeline/tools/executor.ts`

- [ ] **Step 1: Write a failing test for reply logging payload**

If logger tests do not exist, add a focused unit test around the helper used to build telemetry fields rather than snapshotting raw logs.

```ts
expect(buildReplyTelemetry({
  replyPath: 'planned',
  replyTier: 'pro',
  toolsUsed: ['SEARCH'],
})).toMatchObject({
  replyPath: 'planned',
  replyTier: 'pro',
  toolCount: 1,
});
```

- [ ] **Step 2: Run the targeted telemetry test and confirm failure**

Run: `npx vitest run tests/unit/pipeline/reply.test.ts`
Expected: FAIL until telemetry helpers exist.

- [ ] **Step 3: Add structured telemetry fields**

Required fields:
- `replyPath`
- `replyTier`
- `retrievalMode`
- `retrievalMs`
- `replyMs`
- `plannerMs`
- `toolExecMs`
- `toolCount`
- `toolsUsed`
- `plannedNeedTools`

- [ ] **Step 4: Ensure direct replies log zeroed tool metrics**

Example:

```ts
{
  replyPath: 'direct',
  plannerMs: 0,
  toolExecMs: 0,
  toolCount: 0,
}
```

- [ ] **Step 5: Re-run targeted tests**

Run: `npx vitest run tests/unit/pipeline/reply.test.ts tests/unit/pipeline/pipeline-paths.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/pipeline.ts src/pipeline/reply/reply.ts src/pipeline/tools/executor.ts tests/unit/pipeline/reply.test.ts tests/unit/pipeline/pipeline-paths.test.ts
git commit -m "feat: add reply path telemetry"
```

### Task 11: Run the full verification suite

**Files:**
- Test only

- [ ] **Step 1: Run the focused unit suite**

Run:

```bash
npx vitest run \
  tests/unit/ai/fallback.test.ts \
  tests/unit/judge/rules.test.ts \
  tests/unit/pipeline/planner.test.ts \
  tests/unit/pipeline/reply.test.ts \
  tests/unit/pipeline/retriever.test.ts \
  tests/unit/pipeline/retriever-direct.test.ts \
  tests/unit/pipeline/pipeline-paths.test.ts \
  tests/unit/pipeline/tools/registry.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run the broader pipeline suite**

Run:

```bash
npx vitest run tests/unit/pipeline/*.test.ts tests/unit/pipeline/tools/*.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: `Build success` and `DTS Build success`.

- [ ] **Step 4: Commit verification-safe changes**

```bash
git add .
git commit -m "test: verify planner and fast-path architecture"
```

### Task 12: Production rollout verification

**Files:**
- Runtime only

- [ ] **Step 1: Restart the service**

Run: `pm2 restart xxb-ts --update-env`
Expected: PM2 restarts the app cleanly.

- [ ] **Step 2: Check recent logs for startup health**

Run: `pm2 logs xxb-ts --lines 100 --nostream`
Expected:
- No startup exception
- Existing memory health line still appears
- New `replyPath` / `replyTier` fields show up in judge or reply logs

- [ ] **Step 3: Manually test a direct scenario**

Manual scenario:
- Send a greeting or short banter message.
- Confirm logs show `replyPath=direct`.
- Confirm there is no `Tools executed` line for that request.

- [ ] **Step 4: Manually test a planned scenario**

Manual scenario:
- Ask the bot to search fresh info or inspect a URL.
- Confirm logs show `replyPath=planned`.
- Confirm planner and tool execution fields are present.

- [ ] **Step 5: Capture before/after latency samples**

Record:
- 10 direct requests median reply latency
- 10 planned requests median reply latency
- tool usage rate after rollout

- [ ] **Step 6: Run a second code review**

Required review focus:
- Regression risk in planner execution
- Prompt/tool mismatch
- Missing telemetry
- Uncovered failure paths

---

## Notes For Execution

- Preserve the current partial `replyPath` implementation while migrating. Do not break the already-working direct no-tools path during the refactor.
- Keep backward compatibility in `parseJudgeAction()` until the judge prompt has been deployed and observed stable in logs.
- Do not remove `generateWithTools()` until the planned path is stable and telemetry confirms the planner path is working.
- Prefer extracting new files for planner logic instead of making [src/pipeline/reply/reply.ts](/root/xxb-ts/src/pipeline/reply/reply.ts) larger.
- Use TDD exactly: write failing test, watch it fail, implement minimum code, watch it pass.

## Suggested Execution Order

1. Chunk 1: Normalize contract and defaults.
2. Chunk 2: Add real planner path.
3. Chunk 3: Make direct mode fast.
4. Chunk 4: Add telemetry and perform rollout verification.

Plan complete and saved to `docs/superpowers/plans/2026-04-11-direct-planned-reply-architecture.md`. Ready to execute?
