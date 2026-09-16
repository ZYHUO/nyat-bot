import type { ReplyObligation } from "./obligation.js";
import { sortObligations } from "./obligation.js";
import type { ObligationSelectionResult } from "./obligation.js";

export function selectActiveObligation(obligations: ReplyObligation[]): ObligationSelectionResult {
  const contenders = sortObligations(
    obligations.filter((o) => o.state === "pending" || o.state === "active" || o.state === "waiting"),
  );
  return {
    active: contenders[0],
    contenders,
  };
}
