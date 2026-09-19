import { describe, expect, it, vi } from 'vitest';
import type { ActionEnvelope } from '../../../src/agent/cognitive-kernel.js';
import type { CapabilitySnapshot } from '../../../src/agent/nyatos-contracts.js';
import {
  CognitiveTurnRuntime,
  type KernelRuntimePort,
} from '../../../src/agent/cognitive-turn-runtime.js';

const scope = { visibility: 'chat' as const, chatId: -100 };

function capability(canSendText: boolean | null): CapabilitySnapshot {
  return {
    schema: 'capability_snapshot.v1',
    scope,
    observedAt: 100,
    chatKind: 'group',
    transport: {
      sendText: 'host_adapter',
      sendMedia: 'host_adapter',
      react: 'host_adapter',
      poll: 'host_adapter',
      sticker: 'host_adapter',
      voice: 'host_adapter',
      deleteOwn: 'host_adapter',
    },
    observed: {
      canSendText,
      canSendMedia: null,
      canReact: null,
      canPoll: null,
      canSendSticker: null,
      canSendVoice: null,
      canDeleteOwn: null,
    },
    limits: {
      maxTextChars: 4096,
      maxBubbles: 8,
      maxMediaItems: 4,
      maxReactions: 3,
      maxPolls: 1,
    },
  };
}

function fakePort(): KernelRuntimePort & {
  transitions: Array<{ envelopeId: string; status: string }>;
  settlements: Array<{ envelopeId: string; status: string }>;
} {
  let proposalNumber = 0;
  const proposals = new Map<string, ActionEnvelope>();
  const transitions: Array<{ envelopeId: string; status: string }> = [];
  const settlements: Array<{ envelopeId: string; status: string }> = [];
  return {
    transitions,
    settlements,
    ingest: vi.fn((input) => ({
      inserted: true,
      event: {
        id: 'trigger-1',
        type: 'cognitive_trigger',
        scopeKey: 'chat:-100',
        visibility: 'chat',
        chatId: -100,
        userId: null,
        taskId: null,
        source: input.source,
        occurredAt: 100,
        sequence: 1,
        causationId: null,
        correlationId: input.correlationId ?? 'turn-1',
        dedupeKey: input.dedupeKey ?? null,
        fact: {},
        createdAt: 100,
      },
    })),
    openFrame: vi.fn((input) => ({
      inserted: true,
      observedEventId: 'frame-1',
      frame: {
        schema: 'kernel_frame.v1' as const,
        scope: input.scope,
        scopeKey: 'chat:-100',
        correlationId: input.correlationId ?? 'turn-1',
        asOf: 100,
        eventIds: ['trigger-1'],
        triggerCount: 1,
        observationCount: 0,
        proposalCount: 0,
        outcomeCount: 0,
        actions: [],
        outcomes: [],
        unknowns: [],
      },
    })),
    propose: vi.fn((input) => {
      const existing = proposals.get(input.idempotencyKey);
      if (existing) return { inserted: false, eventId: 'proposal-1', envelope: existing };
      proposalNumber += 1;
      const envelope: ActionEnvelope = {
        schema: 'action_envelope.v1',
        id: `envelope-${proposalNumber}`,
        scope: input.scope,
        triggerEventId: input.triggerEventId,
        frameEventId: input.frameEventId ?? 'frame-1',
        lane: input.lane,
        kind: input.kind,
        payload: input.payload ?? {},
        ...(input.prediction ? { prediction: input.prediction } : {}),
        budget: { maxAttempts: 1, maxWallClockSec: 60 },
        status: 'candidate',
        createdAt: 100,
      };
      proposals.set(input.idempotencyKey, envelope);
      return { inserted: true, eventId: `proposal-${proposalNumber}`, envelope };
    }),
    transition: vi.fn((input) => {
      transitions.push({ envelopeId: input.envelopeId, status: input.status });
      return { inserted: true, eventId: `transition-${transitions.length}` };
    }),
    settle: vi.fn((input) => {
      settlements.push({ envelopeId: input.envelopeId, status: input.status });
      const first = settlements.filter((item) => item.envelopeId === input.envelopeId && item.status === input.status).length === 1;
      return { inserted: first, eventId: `outcome-${settlements.length}` };
    }),
  };
}

describe('CognitiveTurnRuntime', () => {
  it('owns one open/propose/arbitrate/settle lifecycle and preserves loser transitions', () => {
    const port = fakePort();
    const runtime = new CognitiveTurnRuntime(port);
    const turn = runtime.open({
      scope,
      kind: 'telegram_message',
      source: 'telegram',
      correlationId: 'turn-1',
      dedupeKey: 'telegram:-100:1',
    });
    expect(turn).toBeTruthy();
    const wait = runtime.propose(turn!, {
      lane: 'reflection',
      kind: 'wait',
      idempotencyKey: 'wait',
      priority: -10,
    });
    const speak = runtime.propose(turn!, {
      lane: 'social',
      kind: 'speak',
      idempotencyKey: 'speak',
    });
    expect(wait?.id).not.toBe(speak?.id);

    const board = runtime.arbitrate(turn!, { capability: capability(true), nowSec: 100 });
    expect(board?.selected?.id).toBe(speak?.id);
    expect(turn?.phase).toBe('arbitrated');
    expect(port.transitions).toEqual([
      { envelopeId: speak!.id, status: 'accepted' },
      { envelopeId: wait!.id, status: 'cancelled' },
    ]);

    runtime.transition(turn!, speak!.id, 'dispatched');
    const completed = runtime.settle(turn!, {
      status: 'completed',
      receipt: { messageId: 9 },
    });
    const retry = runtime.settle(turn!, {
      status: 'completed',
      receipt: { messageId: 9 },
    });
    expect(completed?.inserted).toBe(true);
    expect(retry?.inserted).toBe(false);
    expect(turn?.phase).toBe('settled');
    expect(port.settlements).toHaveLength(2);
  });

  it('keeps unknown host capability deferred instead of selecting a sender action', () => {
    const port = fakePort();
    const runtime = new CognitiveTurnRuntime(port);
    const turn = runtime.open({
      scope,
      kind: 'telegram_message',
      source: 'telegram',
      correlationId: 'turn-2',
      dedupeKey: 'telegram:-100:2',
    });
    const speak = runtime.propose(turn!, {
      lane: 'social',
      kind: 'speak',
      idempotencyKey: 'speak',
    });
    const board = runtime.arbitrate(turn!, { capability: capability(null), nowSec: 100 });
    expect(board?.selected).toBeUndefined();
    expect(board?.deferredCount).toBe(1);
    // Deferral is persisted as an explicit lifecycle state, not left as an
    // in-memory board result: that is what makes it replayable after restart.
    expect(port.transitions).toEqual([{ envelopeId: speak!.id, status: 'deferred' }]);
  });

  it('re-arbitrates a deferred candidate once the host capability is observed', () => {
    const port = fakePort();
    const runtime = new CognitiveTurnRuntime(port);
    const turn = runtime.open({
      scope,
      kind: 'telegram_message',
      source: 'telegram',
      correlationId: 'turn-defer',
      dedupeKey: 'telegram:-100:defer',
    });
    const speak = runtime.propose(turn!, {
      lane: 'social',
      kind: 'speak',
      idempotencyKey: 'defer-speak',
    });
    runtime.arbitrate(turn!, { capability: capability(null), nowSec: 100 });
    expect(turn?.selectedEnvelopeId).toBeUndefined();

    // A deferred envelope is still a candidate, so once the host observes the
    // capability the same turn can select and accept it.
    const board = runtime.arbitrate(turn!, { capability: capability(true), nowSec: 110 });
    expect(board?.selected?.id).toBe(speak!.id);
    expect(turn?.selectedEnvelopeId).toBe(speak!.id);
    expect(port.transitions).toEqual([
      { envelopeId: speak!.id, status: 'deferred' },
      { envelopeId: speak!.id, status: 'accepted' },
    ]);
  });

  it('rejects new proposals after a settled turn while allowing idempotent settle replay', () => {
    const port = fakePort();
    const runtime = new CognitiveTurnRuntime(port);
    const turn = runtime.open({
      scope,
      kind: 'internal',
      source: 'host',
      correlationId: 'turn-3',
      dedupeKey: 'internal:3',
    });
    const action = runtime.propose(turn!, {
      lane: 'reflection',
      kind: 'observe',
      idempotencyKey: 'observe',
    });
    runtime.arbitrate(turn!, { nowSec: 100 });
    runtime.settle(turn!, { envelopeId: action!.id, status: 'completed' });
    expect(runtime.propose(turn!, {
      lane: 'social',
      kind: 'speak',
      idempotencyKey: 'late-speak',
    })).toBeNull();
    expect(runtime.settle(turn!, { envelopeId: action!.id, status: 'completed' })?.inserted).toBe(false);
  });
});

