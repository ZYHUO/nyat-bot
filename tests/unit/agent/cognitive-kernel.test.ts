import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: Database.Database;

vi.mock("../../../src/db/sqlite.js", () => ({ getDb: () => db }));
vi.mock("../../../src/env.js", () => ({
  env: () => ({ COGNITIVE_KERNEL_ENABLED: true, COGNITIVE_EVENTS_ENABLED: true, COGNITIVE_OUTBOX_ENABLED: false }),
}));
vi.mock("../../../src/shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ingestKernelTrigger,
  isKernelShadowChat,
  openKernelFrame,
  proposeKernelAction,
  readKernelFrame,
  recordKernelActionOutcome,
  reduceKernelEvents,
  transitionKernelAction,
} from "../../../src/agent/cognitive-kernel.js";
import { CognitiveTurnRuntime } from "../../../src/agent/cognitive-turn-runtime.js";
import { appendCognitiveEvent, listCognitiveEvents } from "../../../src/agent/cognitive-events.js";

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(readFileSync("migrations/0089_cognitive_events.sql", "utf8"));
});

describe("NyatOS cognitive kernel", () => {
  it("builds one trigger/frame/action/outcome chain and deduplicates retries", () => {
    const scope = { visibility: "chat" as const, chatId: -100 };
    const first = ingestKernelTrigger({
      scope,
      kind: "telegram_message",
      source: "telegram",
      anchorEventId: "telegram-event-1",
      correlationId: "turn-1",
      dedupeKey: "kernel-trigger-1",
      metadata: { messageId: 7, reasoning: "must not persist" },
    });
    expect(first?.inserted).toBe(true);
    const retry = ingestKernelTrigger({
      scope,
      kind: "telegram_message",
      source: "telegram",
      anchorEventId: "telegram-event-1",
      correlationId: "turn-1",
      dedupeKey: "kernel-trigger-1",
      metadata: { messageId: 999 },
    });
    expect(retry?.inserted).toBe(false);
    expect(retry?.event.id).toBe(first?.event.id);

    const opened = openKernelFrame({ scope, triggerEventId: first!.event.id });
    expect(opened?.observedEventId).toBeTruthy();
    const action = proposeKernelAction({
      scope,
      triggerEventId: first!.event.id,
      frameEventId: opened?.observedEventId,
      lane: "social",
      kind: "speak",
      payload: { targetMessageId: 7, rawText: "should not be copied", summary: "answer" },
      prediction: { expectedEffect: "user follows up", watchFor: ["follow_up"] },
      idempotencyKey: "reply:7",
      correlationId: "turn-1",
    });
    expect(action?.inserted).toBe(true);
    expect(action?.envelope.payload).not.toHaveProperty("rawText");
    expect(action?.envelope.payload).toMatchObject({ summary: "answer" });

    const duplicate = proposeKernelAction({
      scope,
      triggerEventId: first!.event.id,
      lane: "social",
      kind: "speak",
      payload: { summary: "different retry" },
      idempotencyKey: "reply:7",
      correlationId: "turn-1",
    });
    expect(duplicate?.inserted).toBe(false);
    expect(duplicate?.envelope.id).toBe(action?.envelope.id);

    expect(transitionKernelAction({ scope, envelopeId: action!.envelope.id, status: "dispatched" })?.inserted).toBe(true);
    expect(recordKernelActionOutcome({
      scope,
      envelopeId: action!.envelope.id,
      status: "completed",
      predictionError: 0.25,
      receipt: { deliveredMessageIds: [8], reasoning: "hidden" },
    })?.inserted).toBe(true);
    expect(recordKernelActionOutcome({
      scope,
      envelopeId: action!.envelope.id,
      status: "completed",
      receipt: { deliveredMessageIds: [8] },
    })?.inserted).toBe(false);

    const frame = readKernelFrame({ scope, correlationId: "turn-1" });
    expect(frame).toMatchObject({ triggerCount: 1, proposalCount: 1, outcomeCount: 1 });
    expect(frame?.actions[0]).toMatchObject({ id: action!.envelope.id, status: "completed" });
    expect(frame?.outcomes[0]).toMatchObject({ envelopeId: action!.envelope.id, predictionError: 0.25 });
    const outcomeEvent = listCognitiveEvents({ scope, type: "action_envelope_outcome" })[0];
    expect(outcomeEvent?.fact).not.toHaveProperty("reasoning");
    expect(JSON.stringify(outcomeEvent?.fact)).not.toContain("hidden");
  });

  it("rejects orphan outcomes and keeps exact chat scopes isolated", () => {
    const first = ingestKernelTrigger({ scope: { visibility: "chat", chatId: -100 }, kind: "internal", source: "host", dedupeKey: "a" });
    expect(first).toBeTruthy();
    expect(recordKernelActionOutcome({
      scope: { visibility: "chat", chatId: -100 },
      envelopeId: "missing",
      status: "completed",
    })).toBeNull();
    const other = ingestKernelTrigger({ scope: { visibility: "chat", chatId: -200 }, kind: "internal", source: "host", dedupeKey: "b" });
    expect(other).toBeTruthy();
    expect(readKernelFrame({ scope: { visibility: "chat", chatId: -100 } })?.triggerCount).toBe(1);
    expect(readKernelFrame({ scope: { visibility: "chat", chatId: -100 } })?.eventIds).not.toContain(other!.event.id);
  });

  it("replays out-of-order duplicates deterministically and honors an as-of anchor", () => {
    const scope = { visibility: "chat" as const, chatId: -100 };
    const trigger = appendCognitiveEvent({ type: "cognitive_trigger", source: "host", scope, correlationId: "r", occurredAt: 10, dedupeKey: "r-trigger", fact: { kind: "internal" } });
    const action = appendCognitiveEvent({ type: "action_envelope_proposed", source: "model", scope, correlationId: "r", occurredAt: 12, dedupeKey: "r-action", causationId: trigger!.event.id, fact: { envelope: { id: "a", kind: "speak", lane: "social", status: "candidate", triggerEventId: trigger!.event.id, createdAt: 12, scope } } });
    const outcome = appendCognitiveEvent({ type: "action_envelope_outcome", source: "host", scope, correlationId: "r", occurredAt: 14, dedupeKey: "r-outcome", fact: { envelopeId: "a", status: "completed" } });
    const events = [outcome!.event, action!.event, trigger!.event, action!.event];
    const beforeOutcome = reduceKernelEvents({ scope, correlationId: "r", events, asOfEventId: action!.event.id });
    expect(beforeOutcome.triggerCount).toBe(1);
    expect(beforeOutcome.proposalCount).toBe(1);
    expect(beforeOutcome.outcomeCount).toBe(0);
    const replayed = reduceKernelEvents({ scope, correlationId: "r", events });
    expect(replayed.outcomeCount).toBe(1);
    expect(replayed.actions[0]).toMatchObject({ id: "a", status: "completed" });
  });

  it("gates kernel shadow by chatId so a first canary can stay bounded", () => {
    expect(isKernelShadowChat(-100, { enabled: false, chatIds: [] })).toBe(false);
    expect(isKernelShadowChat(-100, { enabled: true, chatIds: [] })).toBe(true);
    expect(isKernelShadowChat(-100, { enabled: true, chatIds: [-200] })).toBe(false);
    expect(isKernelShadowChat(-200, { enabled: true, chatIds: [-200] })).toBe(true);
    // A zero chatId is never a valid Telegram scope.
    expect(isKernelShadowChat(0, { enabled: true, chatIds: [] })).toBe(false);
  });

  it("rehydrates an open turn from the persisted frame after a restart", () => {
    const scope = { visibility: "chat" as const, chatId: -100 };
    const first = new CognitiveTurnRuntime();
    const turn = first.open({
      scope,
      kind: "telegram_message",
      source: "telegram",
      correlationId: "restart-turn",
      dedupeKey: "kernel:telegram:-100:1",
      occurredAt: 100,
    });
    expect(turn).toBeTruthy();
    const action = first.propose(turn!, {
      lane: "social",
      kind: "speak",
      idempotencyKey: "restart-speak",
    });
    expect(action).toBeTruthy();
    first.transition(turn!, action!.id, "dispatched");

    // A new runtime instance models the restarted process: the same trigger
    // must rebuild the open action instead of opening an empty turn.
    const reopened = new CognitiveTurnRuntime().open({
      scope,
      kind: "telegram_message",
      source: "telegram",
      correlationId: "restart-turn",
      dedupeKey: "kernel:telegram:-100:1",
      occurredAt: 100,
    });
    expect(reopened?.rehydrated).toBe(true);
    expect(reopened?.phase).toBe("executing");
    expect(reopened?.candidates.map((candidate) => candidate.id)).toContain(action!.id);
    expect(reopened?.selectedEnvelopeId).toBe(action!.id);
  });
});


// ─── 2026-09-21：reducer 的 default 分支 ─────────────────────────────────
//
// `reduceKernelEvent` 的 switch 此前没有 default。往 KERNEL_EVENT_TYPES 加了类型
// 而没写 case 的话，那个事件会：通过顶部守卫 → 被记进 eventIds（从此不再重放）
// → switch 静默落空。**看起来处理过了，其实什么都没做**，而且因为 eventIds 已记，
// 永远不会再试。
describe('kernel reducer 的 default 分支', () => {
  const scope = { visibility: 'chat' as const, chatId: -100 };

  it('① 已知类型照常归约（不受 default 影响）', () => {
    ingestKernelTrigger({ scope, kind: 'telegram_message', source: 'telegram', anchorEventId: 't-1' });
    const r = reduceKernelEvents({ scope, events: listCognitiveEvents(db, scope), asOfEventId: 't-1' });
    expect(r.triggerCount).toBe(1);
    expect(r.unknowns).not.toContain('unreduced_kernel_event:cognitive_trigger');
  });

  it('② switch 的 case 与 KERNEL_EVENT_TYPES 目前完全对齐（default 是防将来的）', async () => {
    // 说明白：今天 default 走不到——5 个类型 5 个 case，一一对应。
    // 它的作用是**将来**有人往 KERNEL_EVENT_TYPES 加第 6 个而忘了写 case 时，
    // 那个事件不会无声消失。所以这条用例不断言"能触发 default"，
    // 而是断言"两者当前对齐"——一旦哪天不对齐，说明 default 真的在兜底，值得回头看。
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/agent/cognitive-kernel.ts', 'utf8');
    const setBlock = src.slice(src.indexOf('KERNEL_EVENT_TYPES'), src.indexOf('MAX_METADATA_BYTES'));
    const inSet = new Set([...setBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    const switchBlock = src.slice(src.indexOf('switch (event.type)'), src.indexOf('default: {', src.indexOf('switch (event.type)')));
    const inSwitch = new Set([...switchBlock.matchAll(/case "([a-z_]+)"/g)].map((m) => m[1]));
    expect([...inSet].sort()).toEqual([...inSwitch].sort());
  });

  it('③ reducer 对任何输入都不 throw（default 不能把异常放出去）', () => {
    ingestKernelTrigger({ scope, kind: 'telegram_message', source: 'telegram', anchorEventId: 't-3' });
    const events = listCognitiveEvents(db, scope);
    expect(() => reduceKernelEvents({ scope, events, asOfEventId: 't-3' })).not.toThrow();
  });

  it('④ 源码里 default 分支存在且用的是本文件的 addUnknown 习惯', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/agent/cognitive-kernel.ts', 'utf8');
    expect(src).toContain('unreduced_kernel_event:');
    // default 必须在 reduceKernelEvent 里面，不能跑到别的函数去
    const fnStart = src.indexOf('export function reduceKernelEvent(');
    const fnEnd = src.indexOf('\n}', src.indexOf('default: {', fnStart));
    expect(src.slice(fnStart, fnEnd)).toContain('unreduced_kernel_event:');
  });
});
