import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

let db: Database.Database;

vi.mock("../../../src/db/sqlite.js", () => ({ getDb: () => db }));
vi.mock("../../../src/env.js", () => ({
  env: () => ({
    RELATIONSHIP_ENABLED: true,
    RELATIONSHIP_ASYMMETRY_ENABLED: false,
    RELATIONSHIP_QUANT_ENABLED: false,
  }),
}));
vi.mock("../../../src/shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  applyHypothesisObservation,
  recordHypothesisCandidate,
} from "../../../src/agent/hypothesis-updates.js";

const migration = (name: string): string =>
  readFileSync(`migrations/${name}`, "utf8");

beforeEach(() => {
  db = new Database(":memory:");
  for (const name of [
    "0018_self_history_relationship.sql",
    "0056_self_model.sql",
    "0055_goals.sql",
    "0062_world_entities.sql",
    "0063_group_norms.sql",
    "0083_core_belief_view.sql",
    "0090_scope_boundaries.sql",
    "0096_world_model_history.sql",
    "0104_group_norm_revisions.sql",
    "0105_relationship_revisions.sql",
    "0109_hypothesis_update_audit.sql",
  ])
    db.exec(migration(name));
});

describe("host-evidence hypothesis gate", () => {
  it("rejects model self-certification without mutating active Person/Group/Self state", () => {
    expect(
      recordHypothesisCandidate({
        kind: "person",
        scope: { visibility: "chat", chatId: -100, userId: 7 },
        subjectKey: "uid:7",
        sourceEventId: "model-event-1",
        evidence: { claim: "we are close" },
      }).status,
    ).toBe("candidate");
    expect(
      applyHypothesisObservation({
        kind: "person",
        scope: { visibility: "chat", chatId: -100, userId: 7 },
        subjectKey: "uid:7",
        source: "model",
        sourceEventId: "model-event-1",
        evidence: { claim: "we are close" },
        chatId: -100,
        userId: 7,
        relationshipDelta: 50,
      }).accepted,
    ).toBe(false);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM chat_relationships").get(),
    ).toEqual({ count: 0 });

    expect(
      applyHypothesisObservation({
        kind: "group",
        scope: { visibility: "chat", chatId: -100 },
        subjectKey: "group:-100",
        source: "model",
        sourceEventId: "model-event-2",
        evidence: { sampleCount: 20 },
        chatId: -100,
        norms: ["短句"],
        sampleCount: 20,
      }).status,
    ).toBe("candidate");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM group_norms").get(),
    ).toEqual({ count: 0 });
    expect(
      applyHypothesisObservation({
        kind: "self",
        scope: { visibility: "global" },
        subjectKey: "bot",
        source: "model",
        sourceEventId: "model-event-3",
        evidence: { feedback: "looks good" },
        notes: [{ note: "我更擅长短答" }],
      }).status,
    ).toBe("candidate");
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM self_model_note_evidence")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("accepts host evidence, persists provenance, counterevidence, and stays idempotent", () => {
    const person = applyHypothesisObservation({
      kind: "person",
      scope: { visibility: "chat", chatId: -100, userId: 7 },
      subjectKey: "uid:7",
      source: "telegram",
      sourceEventId: "telegram-event-1",
      evidence: { kind: "user_replied" },
      counterevidence: ["no reply in prior window"],
      chatId: -100,
      userId: 7,
      relationshipDelta: 1,
      relationshipSummary: "positive:user_replied",
    });
    expect(person.accepted).toBe(true);
    expect(
      db
        .prepare("SELECT affinity, interaction_count FROM chat_relationships")
        .get(),
    ).toMatchObject({ affinity: 1, interaction_count: 1 });
    expect(
      applyHypothesisObservation({
        kind: "person",
        scope: { visibility: "chat", chatId: -100, userId: 7 },
        subjectKey: "uid:7",
        source: "telegram",
        sourceEventId: "telegram-event-1",
        evidence: { kind: "user_replied" },
        chatId: -100,
        userId: 7,
        relationshipDelta: 1,
      }).reason,
    ).toBe("host_evidence_applied");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM chat_relationships").get(),
    ).toEqual({ count: 1 });

    const group = applyHypothesisObservation({
      kind: "group",
      scope: { visibility: "chat", chatId: -100 },
      subjectKey: "group:-100",
      source: "host",
      sourceEventId: "host-event-group-1",
      evidence: { sampleCount: 12, moderatorConfirmed: true },
      chatId: -100,
      norms: ["先给结论", "短句为主"],
      sampleCount: 12,
    });
    expect(group.accepted).toBe(true);
    expect(
      db.prepare("SELECT norms FROM group_norms WHERE chat_id = -100").get(),
    ).toMatchObject({ norms: JSON.stringify(["先给结论", "短句为主"]) });

    const self = applyHypothesisObservation({
      kind: "self",
      scope: { visibility: "global" },
      subjectKey: "bot",
      source: "host",
      sourceEventId: "host-event-self-1",
      evidence: { acceptance: "verified" },
      notes: [{ note: "技术问题先给结论", evidence: "caller acceptance" }],
    });
    expect(self.accepted).toBe(true);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM self_model_note_evidence WHERE source_event_id = ?",
        )
        .get("host-event-self-1"),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT status, source_event_id FROM hypothesis_update_audit WHERE idempotency_key LIKE ?",
        )
        .get("%host-event-self-1") as {
        status: string;
        source_event_id: string;
      },
    ).toMatchObject({
      status: "accepted",
      source_event_id: "host-event-self-1",
    });
  });
});
