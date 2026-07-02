// ────────────────────────────────────────
// Multi-Agent Writer 路由接缝 — 编排器 or 原写手(抽出为可单测,L3)
// ────────────────────────────────────────
//
// deliver.ts 不再内联 isMultiAgentChat?runMultiAgentReply:generateReply 三元,
// 而是调本函数。这样"分支是否反转、参数是否对齐"能被单测覆盖(deliver.ts 本身
// 1000+ 行、依赖几十个模块,全量 mock 不现实)。

import { generateReply } from '../reply/reply.js';
import { runMultiAgentReply, type MultiAgentInput } from './orchestrator.js';

type ReplyResult = Awaited<ReturnType<typeof generateReply>>;

/** multiAgent=true → 编排器(专家并行+Writer);false → 原写手。 */
export async function runWriterRoute(args: MultiAgentInput, multiAgent: boolean): Promise<ReplyResult> {
  if (multiAgent) return runMultiAgentReply(args);
  return generateReply(
    args.message,
    args.retrievedContext,
    args.action,
    args.chatId,
    args.botUid,
    args.replyPath,
    args.replyTier,
    args.segmenterConfig,
    args.turnCallOpts,
  );
}
