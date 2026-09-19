// ────────────────────────────────────────
// Group Norms — 群体风格画像 (AGI Level 5 Phase 9, L3)
//
// LoSoNA 理念: 每个群都有自己的隐性规范(玩梗/正经/短句/不聊政治)。
// 观察群内消息 → LLM 推断该群规范 → 注入 reply prompt。
// 安全: DM 不建 norms; norms 只描述风格,不存具体用户隐私内容。
// ────────────────────────────────────────

import { callWithFallback } from "../ai/fallback.js";
import { env } from "../env.js";
import { logger } from "../shared/logger.js";
import { loadCachedPrompt } from "../shared/config.js";
import { getDb } from "../db/sqlite.js";
import { recordHypothesisCandidate } from "./hypothesis-updates.js";

export interface GroupNorms {
  chatId: number;
  norms: string[]; // ≤5 条
  sampleCount: number;
  lastUpdatedAt: number;
}

export interface NormsInput {
  chatId: number; // 负数 = 群
  recentMessages: string[]; // 最近 N 条消息(已去敏)
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hasRevisionTable(): boolean {
  try {
    return Boolean(
      getDb()
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'group_norm_revisions'",
        )
        .get(),
    );
  } catch {
    return false;
  }
}

/** 解析 LLM 输出为规范数组; 垃圾输出返回空数组。 */
export function parseNormsOutput(raw: string): string[] {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]) as unknown[];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim().slice(0, 80))
      .filter((s) => s.length >= 2)
      .slice(0, 5);
  } catch {
    return [];
  }
}

/** 保存/更新群的 norms。 */
export function saveGroupNorms(
  chatId: number,
  norms: string[],
  sampleCount: number,
): void {
  if (chatId >= 0) return; // DM 不建
  try {
    const db = getDb();
    const ts = nowSec();
    const existing = db
      .prepare("SELECT chat_id FROM group_norms WHERE chat_id = ?")
      .get(chatId) as { chat_id: number } | undefined;
    const json = JSON.stringify(norms.slice(0, 5));
    if (existing) {
      db.prepare(
        `UPDATE group_norms SET norms = ?, sample_count = ?, last_updated_at = ? WHERE chat_id = ?`,
      ).run(json, sampleCount, ts, chatId);
    } else {
      db.prepare(
        `INSERT INTO group_norms (chat_id, norms, sample_count, last_updated_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(chatId, json, sampleCount, ts, ts);
    }
  } catch (err) {
    logger.warn({ err, chatId }, "saveGroupNorms failed");
    return;
  }
  // Phase 2 双写：同步 belief（fire-and-forget，失败不抛；void 防浮 promise）
  void import("../core/migrate.js")
    .then(({ syncGroupNorms }) => syncGroupNorms(chatId))
    .catch(() => {
      /* non-critical */
    });
}

/** Apply norms only after a host-owned event supplied bounded evidence. */
export function saveVerifiedGroupNorms(
  chatId: number,
  norms: string[],
  sampleCount: number,
  provenance: {
    sourceEventId: string;
    source: "host" | "tool" | "telegram" | "scheduler" | "import";
    evidence: Record<string, unknown>;
  },
): boolean {
  if (
    chatId >= 0 ||
    !provenance.sourceEventId.trim() ||
    Object.keys(provenance.evidence).length === 0
  )
    return false;
  if (sampleCount < 5 || !norms.length) return false;
  saveGroupNorms(chatId, norms, sampleCount);
  return getGroupNorms(chatId)?.sampleCount === sampleCount;
}

/** 读某群 norms; 无 → null。 */
export function getGroupNorms(
  chatId: number,
  asOfSec?: number,
): GroupNorms | null {
  if (chatId >= 0) return null;
  try {
    const boundedAsOf =
      Number.isSafeInteger(asOfSec) && (asOfSec as number) > 0
        ? asOfSec
        : undefined;
    const db = getDb();
    const row = (
      hasRevisionTable()
        ? boundedAsOf === undefined
          ? db
              .prepare(
                `SELECT chat_id, norms, sample_count, last_updated_at
             FROM group_norm_revisions WHERE chat_id = ?
            ORDER BY revision DESC LIMIT 1`,
              )
              .get(chatId)
          : db
              .prepare(
                `SELECT chat_id, norms, sample_count, last_updated_at
             FROM group_norm_revisions
            WHERE chat_id = ? AND last_updated_at <= ?
            ORDER BY last_updated_at DESC, revision DESC LIMIT 1`,
              )
              .get(chatId, boundedAsOf)
        : boundedAsOf === undefined
          ? db
              .prepare("SELECT * FROM group_norms WHERE chat_id = ?")
              .get(chatId)
          : db
              .prepare(
                "SELECT * FROM group_norms WHERE chat_id = ? AND last_updated_at <= ?",
              )
              .get(chatId, boundedAsOf)
    ) as
      | {
          chat_id: number;
          norms: string;
          sample_count: number;
          last_updated_at: number;
        }
      | undefined;
    if (!row) return null;
    let norms: string[] = [];
    try {
      norms = JSON.parse(row.norms);
    } catch {
      norms = [];
    }
    return {
      chatId: row.chat_id,
      norms,
      sampleCount: row.sample_count,
      lastUpdatedAt: row.last_updated_at,
    };
  } catch (err) {
    logger.warn({ err, chatId }, "getGroupNorms failed");
    return null;
  }
}

/** 是否该重新推断(6h 过期或无 norms)。 */
export function needsRefresh(chatId: number, ttlSec = 6 * 3600): boolean {
  const n = getGroupNorms(chatId);
  if (!n) return true;
  return nowSec() - n.lastUpdatedAt > ttlSec;
}

/** LLM 推断一次该群规范并保存。返回规范数组; 失败返回 null。 */
export async function inferGroupNorms(
  input: NormsInput,
): Promise<string[] | null> {
  if (input.chatId >= 0 || input.recentMessages.length < 5) return null;
  try {
    const system = loadCachedPrompt("task/group-norms.md");
    const user = input.recentMessages
      .slice(-30)
      .map((m, i) => `[${i + 1}] ${m.slice(0, 200)}`)
      .join("\n");
    const res = await callWithFallback({
      usage: env().GROUP_NORMS_INFER_USAGE,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user.slice(0, 6000) },
      ],
      maxTokens: 800,
      temperature: 0.3,
      allowHedge: false,
      // 回放实测：step-3.7-flash 吐脏 JSON（围栏/前后缀）致 6/9 群 parse 失败。
      // gate/heart 同因已开 jsonMode，这里补上。
      jsonMode: true,
    });
    const norms = parseNormsOutput(res.content ?? "");
    if (norms.length && env().GROUP_NORMS_AUTO_UPDATE_ENABLED === true) {
      // A model output is not host evidence. The flag is retained only for a
      // future host verifier; record the proposal even when the active writer
      // remains closed.
      recordHypothesisCandidate({
        kind: "group",
        scope: { visibility: "chat", chatId: input.chatId },
        subjectKey: `group:${input.chatId}`,
        source: "model",
        evidence: { sampleCount: input.recentMessages.length, norms },
        reason: "model_norms_require_host_verification",
      });
    } else if (norms.length) {
      recordHypothesisCandidate({
        kind: "group",
        scope: { visibility: "chat", chatId: input.chatId },
        subjectKey: `group:${input.chatId}`,
        source: "model",
        evidence: { sampleCount: input.recentMessages.length, norms },
        reason: "group_auto_update_closed",
      });
    }
    return norms.length ? norms : null;
  } catch (err) {
    logger.warn({ err, chatId: input.chatId }, "inferGroupNorms failed");
    return null;
  }
}

/**
 * 构建注入 reply prompt 的 [群氛围] 块。
 *
 * 带上"这是什么时候的印象"：群规是 6 小时前推断的，而群里的梗和黑话是**会过气**的。
 * 三周前流行的说法现在还在用，就是那种"这人怎么还在玩这个梗"的尴尬。
 * 这是**事实**（多久以前观察到的），不是命令——模型自己判断还合不合时宜。
 */
export function buildNormsBlock(chatId: number): string {
  const n = getGroupNorms(chatId);
  if (!n?.norms.length) return "";
  const ageSec = Math.max(0, nowSec() - n.lastUpdatedAt);
  const ageDays = Math.floor(ageSec / 86400);
  const ageHours = Math.floor(ageSec / 3600);
  const freshness = ageDays >= 3
    ? `（这是 ${ageDays} 天前的印象，群里的梗可能已经换了）`
    : ageDays >= 1
      ? `（这是 ${ageDays} 天前的印象）`
      : ageHours >= 1
        ? `（这是 ${ageHours} 小时前的印象）`
        : '';
  return `\n\n[群氛围]\n这个群的隐性规则${freshness}：\n${n.norms.map((r) => `- ${r}`).join("\n")}\n回复时自然地贴合这个群的氛围。`;
}
