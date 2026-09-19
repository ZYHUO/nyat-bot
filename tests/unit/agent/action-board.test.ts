import { describe, expect, it } from "vitest";
import { buildActionBoard, selectedAction } from "../../../src/agent/action-board.js";
import type { ActionEnvelope } from "../../../src/agent/cognitive-kernel.js";
import type { CapabilitySnapshot } from "../../../src/agent/nyatos-contracts.js";

const scope = { visibility: "chat" as const, chatId: -100 };

function envelope(input: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    schema: "action_envelope.v1",
    id: input.id ?? "a",
    scope: input.scope ?? scope,
    triggerEventId: input.triggerEventId ?? "trigger-1",
    frameEventId: input.frameEventId ?? "frame-1",
    lane: input.lane ?? "social",
    kind: input.kind ?? "speak",
    payload: input.payload ?? {},
    budget: input.budget ?? { maxAttempts: 1, maxWallClockSec: 60 },
    status: input.status ?? "candidate",
    createdAt: input.createdAt ?? 100,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.prediction === undefined ? {} : { prediction: input.prediction }),
  };
}

function capability(canSendText: boolean | null): CapabilitySnapshot {
  return {
    schema: "capability_snapshot.v1",
    scope,
    observedAt: 100,
    chatKind: "group",
    transport: {
      sendText: "host_adapter",
      sendMedia: "host_adapter",
      react: "host_adapter",
      poll: "host_adapter",
      sticker: "host_adapter",
      voice: "host_adapter",
      deleteOwn: "host_adapter",
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
    limits: { maxTextChars: 4096, maxBubbles: 8, maxMediaItems: 4, maxReactions: 3, maxPolls: 1 },
  };
}

describe("NyatOS action board", () => {
  it("chooses one highest-scoring candidate per trigger and keeps losers explainable", () => {
    const board = buildActionBoard({
      scope,
      capability: capability(true),
      nowSec: 100,
      candidates: [
        { envelope: envelope({ id: "wait", kind: "wait" }), priority: -10 },
        { envelope: envelope({ id: "speak", kind: "speak" }), priority: 0 },
        { envelope: envelope({ id: "other-trigger", triggerEventId: "trigger-2", kind: "work" }), priority: -2 },
      ],
    });
    expect(selectedAction(board)).toBe("speak");
    expect(board.decisions.find((decision) => decision.id === "wait")).toMatchObject({ state: "rejected", reason: "trigger_conflict" });
    expect(board.decisions.find((decision) => decision.id === "other-trigger")).toMatchObject({ state: "eligible" });
  });

  it("defers unknown capabilities and rejects observed unavailable capabilities", () => {
    const unknown = buildActionBoard({ scope, candidates: [{ envelope: envelope() }] });
    expect(unknown.selected).toBeUndefined();
    expect(unknown.decisions[0]).toMatchObject({ state: "deferred", reason: "host_capability_unknown" });
    const unavailable = buildActionBoard({ scope, capability: capability(false), candidates: [{ envelope: envelope() }] });
    expect(unavailable.selected).toBeUndefined();
    expect(unavailable.decisions[0]).toMatchObject({ state: "rejected", reason: "host_capability_unavailable" });
  });

  it("rejects stale, non-candidate and cross-scope envelopes without side effects", () => {
    const board = buildActionBoard({
      scope,
      capability: capability(true),
      nowSec: 100,
      candidates: [
        { envelope: envelope({ id: "expired", expiresAt: 99 }) },
        { envelope: envelope({ id: "done", status: "completed" }) },
        { envelope: envelope({ id: "other", scope: { visibility: "chat", chatId: -200 } }) },
      ],
    });
    expect(board.selected).toBeUndefined();
    expect(board.rejectedCount).toBe(3);
    expect(board.decisions.map((decision) => decision.reason)).toEqual(["expired", "status_completed", "scope_mismatch"]);
  });
});
