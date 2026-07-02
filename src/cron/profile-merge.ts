// ────────────────────────────────────────
// 机制5:LLM 全局画像合并(借鉴 CyberGroupmate reflection 的 globalPersonUpdates)
// ────────────────────────────────────────
//
// 把某人各上下文(群 ∪ DM)的每群画像 + 聚合好感,喂便宜模型**提炼**(而非并集)
// 成跨上下文稳定认知(traits/interests/沟通风格/与 bot 的关系/稳定模式),写回
// person_identity 的全局列(机制2)。这是全局 PersonProfile 的唯一产出路径。
//
// 隐私(与机制1 配套):合并 prompt 明确只提炼**跨场景通用**的稳定特征,严禁写入
// 只在私聊透露的具体隐私(住址/工作/感情/健康等)——全局画像因此 safe-by-construction
// 可注入群;私聊里的**具体内容**的隔离由机制4(原始记忆召回的 scrub)兜底。
//
// 成功才更新 last_merged_at(借鉴"失败不推进水位线")。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { callWithFallback } from '../ai/fallback.js';
import { getUserContexts } from '../pipeline/context/manager.js';
import { getUserProfilePrompt } from '../tracking/user-profile.js';
import { getAggregatedAffinity } from '../tracking/user-affinity.js';
import { setGlobalProfile } from '../tracking/person-identity.js';
import { isPrivateChat } from '../memory/visibility.js';

// C:改为可配(PROFILE_MERGE_MAX_UIDS / PROFILE_MERGE_STALE_HOURS),默认更勤。
function maxUidsPerTick(): number { return env().PROFILE_MERGE_MAX_UIDS; }
function remergeAfterSec(): number { return env().PROFILE_MERGE_STALE_HOURS * 3600; }

const SYSTEM_PROMPT =
  '你是群聊 bot 的长期记忆整理器。下面给出同一个人在多个聊天场景(群/私聊)里的分场景画像。' +
  '请**提炼**出这个人跨场景稳定的整体特征,输出 JSON:' +
  '{"traits":[跨场景稳定性格/行为,≤6条],"interests":[长期兴趣,≤6条],' +
  '"comm_style":"一句话概括沟通风格","relation_to_bot":"一句话概括TA与你(bot)的总体关系",' +
  '"stable_patterns":[稳定互动模式如"深夜活跃""爱吐槽",≤4条],"confidence":0到1的置信度}。' +
  '只提炼跨场景通用的稳定特征;**绝不写入**任何只在私聊里透露的具体隐私(住址/工作单位/' +
  '感情状况/健康/真实姓名等)——那些不属于"整体印象"。只输出 JSON,不要解释、不要 markdown 围栏。';

interface MergeOutput {
  traits: string[];
  interests: string[];
  comm_style: string;
  relation_to_bot: string;
  stable_patterns: string[];
  confidence: number;
}

function parseMergeJson(raw: string): MergeOutput | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.trim()).slice(0, 8) : [];
    return {
      traits: arr(o['traits']),
      interests: arr(o['interests']),
      comm_style: typeof o['comm_style'] === 'string' ? o['comm_style'].slice(0, 120) : '',
      relation_to_bot: typeof o['relation_to_bot'] === 'string' ? o['relation_to_bot'].slice(0, 120) : '',
      stable_patterns: arr(o['stable_patterns']),
      confidence: typeof o['confidence'] === 'number' ? Math.max(0, Math.min(1, o['confidence'])) : 0.5,
    };
  } catch {
    return null;
  }
}

/**
 * 合并单个 uid 的全局画像。成功写回并返回 true;素材不足/解析失败返回 false(不推进水位线)。
 * 可被 cron 批量调,也可被 person-identity on-read 后台触发(dynamic import 防循环)。
 */
export async function mergeGlobalProfile(uid: number): Promise<boolean> {
  // 负数 uid = sender_chat(匿名管理员/频道),不是真实的人,不合并全局画像。
  if (!uid || uid <= 0) return false;
  try {
    const contexts = await getUserContexts(uid).catch(() => [] as number[]);
    if (contexts.length <= 1) return false; // 单上下文无需"跨上下文"合并

    const blocks: string[] = [];
    for (const chatId of contexts) {
      const prompt = getUserProfilePrompt(chatId, uid);
      if (!prompt || prompt.trim().length < 8) continue;
      const kind = isPrivateChat(chatId) ? '私聊' : '群';
      blocks.push(`【${kind}场景 ${chatId}】\n${prompt.slice(0, 400)}`);
    }
    if (blocks.length < 2) return false; // 至少两个有料场景才值得跨场景提炼

    const agg = getAggregatedAffinity(uid);
    const user =
      `这个人出现在 ${contexts.length} 个场景,跨场景好感度约 ${Math.round(agg.affinity)}(${agg.bucket})。\n\n` +
      blocks.join('\n\n') +
      '\n\n请提炼跨场景整体特征,输出 JSON:';

    const result = await callWithFallback({
      usage: env().PROFILE_MERGE_USAGE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      maxTokens: 400,
      temperature: 0,
    });

    const parsed = parseMergeJson(result.content);
    if (!parsed) {
      logger.debug({ uid, raw: result.content.slice(0, 120) }, 'profile-merge: parse failed, water-mark not advanced');
      return false;
    }

    setGlobalProfile(uid, {
      traits: parsed.traits,
      interests: parsed.interests,
      commStyle: parsed.comm_style,
      relationToBot: parsed.relation_to_bot,
      stablePatterns: parsed.stable_patterns,
      sourceContextIds: contexts,
      confidence: parsed.confidence,
    });
    logger.info({ uid, contexts: contexts.length, traits: parsed.traits.length }, 'profile-merge: global profile updated');
    return true;
  } catch (err) {
    logger.debug({ err, uid }, 'mergeGlobalProfile failed (non-critical)');
    return false;
  }
}

/**
 * cron:挑跨上下文(chat_count>1)且久未合并的候选,批量跑 mergeGlobalProfile。
 * 候选来源 person_identity(由 refreshPersonIdentity 维护),避免遍历全量 uid。
 */
export async function runProfileMerge(): Promise<void> {
  const e = env();
  if (!e.PROFILE_MERGE_ENABLED) return;
  // review #4:candidate 表 person_identity 靠 refreshPersonIdentity 填充,后者
  // 只在 PERSON_IDENTITY_ENABLED 时跑。没它这张表基本是空的,合并会静默无产出——
  // 明确告警而不是悄悄空转。
  if (!e.PERSON_IDENTITY_ENABLED) {
    logger.warn({}, 'profile-merge: PERSON_IDENTITY_ENABLED off → person_identity 候选表不被填充,合并无候选(请同时开启 PERSON_IDENTITY_ENABLED)');
  }

  let uids: number[];
  try {
    const cutoff = Math.floor(Date.now() / 1000) - remergeAfterSec();
    // review #4:不再以 chat_count>1 为硬 SQL 条件(chat_count 由另一 flag 的
    // refreshPersonIdentity 维护,可能为 0)。改为按 last_merged_at 陈旧 + 近期活跃
    // 取候选,>1 上下文的判定放到运行时 getUserContexts(权威、含 DM)。
    const rows = getDb().prepare(
      `SELECT uid FROM person_identity
        WHERE last_merged_at IS NULL OR last_merged_at < ?
        ORDER BY updated_at DESC
        LIMIT ?`,
    ).all(cutoff, maxUidsPerTick() * 3) as Array<{ uid: number }>;
    uids = rows.map((r) => r.uid);
  } catch (err) {
    logger.warn({ err }, 'profile-merge: candidate query failed');
    return;
  }
  if (uids.length === 0) return;

  // 灰度:PROFILE_MERGE_CHAT_IDS 非空时,只合并"至少出现在某个灰度群"的人。
  const graylist = e.PROFILE_MERGE_CHAT_IDS;
  let merged = 0;
  let processed = 0;
  for (const uid of uids) {
    if (processed >= maxUidsPerTick()) break;
    const contexts = await getUserContexts(uid).catch(() => [] as number[]);
    if (contexts.length <= 1) continue; // 运行时权威判定"跨上下文"
    if (graylist.length > 0 && !contexts.some((c) => graylist.includes(c))) continue;
    processed++;
    if (await mergeGlobalProfile(uid)) merged++;
  }
  logger.info({ candidates: uids.length, processed, merged }, 'profile-merge tick complete');
}
