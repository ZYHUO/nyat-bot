// Host-owned bounded semantic debt scorer.
// The model may rank candidates, but it cannot resolve a debt or provide
// evidence. All bounds and the provider usage are controlled by the host.

import { callWithFallback } from "../ai/fallback.js";
import { env } from "../env.js";
import type { CognitiveDebt } from "./cognitive-debts.js";

function parseScore(raw: string): number | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (typeof parsed === "number" && Number.isFinite(parsed))
      return Math.min(1, Math.max(0, parsed));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)["score"];
      if (typeof value === "number" && Number.isFinite(value))
        return Math.min(1, Math.max(0, value));
    }
  } catch {
    const match = cleaned.match(/(?:score\s*[:=]\s*)?([01](?:\.\d+)?)/i);
    if (match?.[1]) return Math.min(1, Math.max(0, Number(match[1])));
  }
  return null;
}

export async function scoreDebtSemanticMatch(input: {
  query: string;
  debt: CognitiveDebt;
  signal?: AbortSignal;
}): Promise<number> {
  const query = input.query
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, 800);
  const statement = input.debt.statement
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, 400);
  if (!query || !statement) return 0;
  try {
    const result = await callWithFallback({
      usage: env().DEBT_SEMANTIC_MATCH_USAGE,
      messages: [
        {
          role: "system",
          content:
            'Return JSON only: {"score": number}. Score semantic relevance from 0 to 1. Do not decide, resolve, or rewrite the debt.',
        },
        {
          role: "user",
          content: JSON.stringify({
            query,
            debt: { kind: input.debt.kind, statement },
          }),
        },
      ],
      maxTokens: 80,
      temperature: 0,
      maxTimeoutMs: env().DEBT_SEMANTIC_MATCH_TIMEOUT_MS,
      signal: input.signal,
      allowHedge: false,
      jsonMode: true,
      rejectEmpty: true,
    });
    return parseScore(result.content ?? "") ?? 0;
  } catch {
    return 0;
  }
}
