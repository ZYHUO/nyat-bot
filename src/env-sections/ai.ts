// ────────────────────────────────────────
// env schema · ai 段（Jev / TypeSafe System One 结构化判断）
// ────────────────────────────────────────
// 定位：Jev **不是又一个会写散文的聊天模型**，而是帮 LLM 少花时间做"定型判断"
// （noul 是非 / choice 选一个 / score 打分）的小基座。问一个封闭问题，返回带概率的
// 定型答案，不生成文本。code 拥有流程，模型只补那一点语义常识。
//
// 为什么单独一段、单独一套 JEV_*：仓库里已有一套 TYPESAFE_*（timing 段）打的是
// **官方** api.typesafe.ai / jev-latest，服务 semantic-dup 与 grounding-check 两个
// 异步校验（src/ai/judge-substrate.ts）。这里打的是**另一条 relay**（用户给的
// lfree 镜像 / jev-1.13）——请求/响应同构但端点不同，故意分开配置：改一条 relay
// 不该动另一条 backend，也不该让新 relay 的开关反过来影响既有异步校验。
//
// 加旗标默认值的原则（和全仓一致）：**总开关默认关**，所有取值放 .env（gitignored）。
// 不要把 relay 路由 token 或 API key 写进被跟踪的源码默认值里——那会进 git。
// 默认关 → tests/unit/env/no-dead-switches.test.ts 不要求读者；但接线后本来就有读者。
// ────────────────────────────────────────

import { z } from 'zod';
import { booleanFromEnv } from './_shared.js';

export const aiSection = {
  // Jev 结构化判断总开关。默认关：开了会影响用户等待路径上的延迟，先灰度再放开。
  JEV_ENABLED: booleanFromEnv.default(false),
  // lfree relay 的系统 one 端点基址（不带 /v1/systemone，代码自己拼）。
  // 默认空：真实的 /bot/<route> 只放 .env，不进被跟踪的源码。
  JEV_BASE_URL: z.string().default(''),
  // relay 的 bearer key。默认空；真值只在 .env。
  JEV_API_KEY: z.string().default(''),
  // 模型名。relay 的 /v1/models 里出现过 jev-1.13（owned_by: relay）。
  JEV_MODEL: z.string().default('jev-1.13'),
  // 单次调用超时(ms)。实测这条 relay 的 systemone 在 1.5–2.9s；官方宣称 ~100ms 但
  // 这条镜像到不了。留 4s 余量给抖动，又压在 command-router 那条 8s per-attempt
  // 预算之内——分类这一跳只是"要不要借别的 bot 办事"的前置筛选，等太久没意义。
  // 再配熔断：relay 假死后前几条消息最多各等一次超时，之后熔断期间零网络直接降级。
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  // 接受一个 choice 答案的最低置信度。低于它 → 当作"没把握"，交给原 LLM judge
  // 兜底（大模型可能直接判对）——绝不用一个低置信的结构化答案去驱动代发动作。
  // 0..1，confident 的判定实测常接近 1，0.6 挡住的是稀有的两头摇摆。
  JEV_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
  // 熔断：连续失败这么多次后开路一段时间，期间 callJev 直接返 null（不发起请求），
  // 让调用方走降级路径，而不是每条消息都干等一次超时。理由同 JUDGE_SUBSTRATE_*。
  JEV_BREAKER_FAILS: z.coerce.number().int().positive().default(3),
  JEV_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),
};
