import { describe, expect, it } from "vitest";
import {
  deriveAgencyActionSemantics,
  createAnchoredAgencyEnvelope,
} from "../../../src/agent/agency-action-semantics.js";

describe("agency action semantics", () => {
  it("derives one stable anchor, trigger and obligation contract", () => {
    const semantics = deriveAgencyActionSemantics({
      action: { type: "act", goal: "do", taskId: "task-1" },
      scope: { visibility: "task", chatId: -100, taskId: "task-1" },
      source: "codeact",
      anchorEventId: "event-1",
      triggerEventId: "event-0",
      idempotencyKey: "k",
    });
    expect(semantics).toEqual({
      anchorEventId: "event-1",
      triggerEventId: "event-0",
      obligationId: "task:task-1",
      source: "codeact",
    });
  });

  it("always supplies semantics even when the caller only has a scoped trigger", () => {
    const result = createAnchoredAgencyEnvelope({
      action: { type: "observe", target: "meta:test" },
      scope: { visibility: "chat", chatId: -100 },
      source: "meta",
      triggerEventId: "telegram:-100:message:7",
      idempotencyKey: "meta-test",
    });
    expect(result.ok).toBe(true);
    expect(result.envelope?.semantics).toMatchObject({
      anchorEventId: "telegram:-100:message:7",
      triggerEventId: "telegram:-100:message:7",
      source: "meta",
    });
  });
});
