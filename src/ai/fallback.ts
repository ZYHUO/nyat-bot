// ────────────────────────────────────────
// Fallback chain + hedged request
// ────────────────────────────────────────

import type { AICallOptions, AICallResult } from './types.js';
import { callModel } from './provider.js';
import { getUsage, getLabel } from './labels.js';
import { emitLlmResult, emitLlmError } from './events.js';
import { CooldownTracker } from './cooldown.js';
import { AIError } from '../shared/errors.js';
import { isCallerAbort } from '../shared/abort.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../db/redis.js';
import { incrCounter } from '../metrics/registry.js';
import { env } from '../env.js';
import { smartGroupReorder, recordSmartGroupResult, smartGroupAutoAssign, isAutoAssignEnabled } from './smart-group.js';

/**
 * round 83：403 / 账号级限流的冷却时长。
 *
 * 默认 60s / 熔断 120s 对「concurrent request limit」不够——那种限流
 * REST 解除取决于在飞的请求跑完，不是墙上时钟。实测 dshkimi 一天 570 次
 * 失败里 491 次是这个形状（86%），平均每 2.4 分钟一次循环。
 *
 * 5 分钟是折中：够长到让在飞请求跑完，又不至于一个账号被罚站半小时。
 */
const RATE_LIMIT_COOLDOWN_SEC = 300;

export async function callWithFallback(options: AICallOptions): Promise<AICallResult> {
  const usage = getUsage(options.usage);
  const manualNames = [usage.label, ...usage.backups];

  // Smart Group auto-assign: 开了就忽略 .env 手动链,从全量 provider 池按
  // usage profile(tier/vision)自动选 top-N。选不出来(池空/全不符)回退手动链。
  let candidateNames = manualNames;
  if (isAutoAssignEnabled()) {
    const auto = await smartGroupAutoAssign(options.usage);
    if (auto.length > 0) candidateNames = auto;
  }

  // Smart Group: reorder candidates by health/latency/cost if enabled.
  // getLabels 由 smart-group 内部惰性 import —— 默认关闭时零开销,也不碰测试 mock。
  // 第二个参数传 usage 名：声明 respectManualOrder 的 usage（画摊子）不参与重排,
  // 否则手动链的顺序会被延迟排序翻回"最快但不会干这活"的模型。
  const smartOrderedNames = await smartGroupReorder(candidateNames, options.usage);

  const cooldown = new CooldownTracker(getRedis());
  // 后台批任务(allowHedge:false)不 hedge —— 2s 后双发对延迟无感,纯翻倍账单。
  const hedgeDelayMs = options.allowHedge === false ? 0 : env().HEDGE_DELAY_MS;

  const callOpts = {
    maxTokens: options.maxTokens ?? usage.maxTokens,
    temperature: options.temperature ?? usage.temperature,
    // Per-attempt budget: callModel turns this into a FRESH AbortSignal.timeout
    // for each attempt. maxTimeoutMs lets latency-bounded callers (heart/gate)
    // cap every attempt without baking a shared timeout signal into
    // options.signal (which would poison all backups once it fires).
    timeout: options.maxTimeoutMs !== undefined
      ? Math.min(usage.timeout, options.maxTimeoutMs)
      : usage.timeout,
    signal: options.signal,
    // H4.2: usage 级 jsonMode 默认（judge/summarize 已开）——调用方显式值优先，
    // 未传时跟 usage 走。根治 stepfun 系脏 JSON（gate 529/norms 6-9/tick 同因）。
    jsonMode: options.jsonMode ?? usage.jsonMode,
  };

  const errors: Error[] = [];
  let hedgeTriedLabel: string | undefined;
  /** 全链被冷却跳过时，最短的那个剩余冷却（秒）；0 表示没有候选被冷却跳过。 */
  let shortestCooldownSec = 0;
  /** 是否真的等过一次（等完仍全冷却时用来分开记账）。 */
  let waitedOnce = false;

  // P2 多模态:带图调用跳过明确声明 VISION=false 的 label(纯文本模型收到
  // image_url 必 400,白烧一跳还刷熔断)。undefined(未声明)照发,保持现状。
  const hasImageParts = options.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'),
  );

  for (let i = 0; i < smartOrderedNames.length; i++) {
    const labelName = smartOrderedNames[i]!;

    // Skip label already tried as a hedge
    if (labelName === hedgeTriedLabel) continue;

    const label = getLabel(labelName);

    if (hasImageParts && label.capabilities?.vision === false) {
      logger.debug({ label: labelName, model: label.model }, 'Skipping text-only label for image call');
      incrCounter('llm_vision_label_skipped_total', { label: labelName });
      continue;
    }

    // Skip if cooling down
    if (await cooldown.isCoolingDown(label.model)) {
      logger.debug({ label: labelName, model: label.model }, 'Skipping cooled-down model');
      // 记下最短的剩余冷却——全被跳过时用它决定要不要等一下（见函数尾部）。
      const rem = await cooldown.getRemainingSeconds(label.model).catch(() => 0);
      if (rem > 0 && (shortestCooldownSec === 0 || rem < shortestCooldownSec)) shortestCooldownSec = rem;
      continue;
    }

    // per-label 覆盖:给慢/推理模型(如 mundo,回复链里需几分钟 + 大 maxTokens 防
    // 推理截断成空)单独放宽,而不动 usage 配置(正常回复的快模型照旧 60s/小 maxTokens)。
    // 超时仍受调用方 maxTimeoutMs 上限约束(heart/gate 等延迟敏感路径设了 maxTimeoutMs
    // → 即便落到 mundo 也不会久等,会按上限超时后继续 fallback)。
    const attemptOpts = attemptOptsFor(label, callOpts, options.maxTimeoutMs);

    try {
      // Hedged request: if this is the primary and there's a backup,
      // race with a delayed backup call.
      // Note: hedgeTriedLabel is set before the call. If hedgedCall throws,
      // both primary and hedge have been attempted, so skipping the hedge
      // label in the fallback loop is correct.
      if (i === 0 && smartOrderedNames.length > 1 && hedgeDelayMs > 0) {
        hedgeTriedLabel = smartOrderedNames[1]!;
        const hedgeLabel = getLabel(hedgeTriedLabel);
        const result = await hedgedCall(
          label, hedgeLabel, options.messages, callOpts, hedgeDelayMs, cooldown,
          options.rejectEmpty ?? false, options.maxTimeoutMs,
          options.usage, options.suppressMetrics ?? false, options.chatId,
        );
        // rejectEmpty 已在 hedgedCall 内对两跳都施加;这里再兜一层,空则落到下个 backup。
        if (options.rejectEmpty && !result.content.trim()) {
          throw new AIError('Empty response', labelName, label.model, 'AI_EMPTY');
        }
        if (!options.suppressMetrics) emitLlmResult(options.usage, result, options.chatId);
        return result;
      }

      const result = await callModel(label, options.messages, attemptOpts);
      if (options.rejectEmpty && !result.content.trim()) {
        throw new AIError('Empty response', labelName, label.model, 'AI_EMPTY');
      }
      // 成功 → 重置熔断失败计数
      await cooldown.recordSuccess(label.model);
      // 观测:落到 backup(主模型失败/被拒后换的第 i 跳)成功时记 label+usage+耗时,
      // 便于盯 fallback 命中(尤其回复链里 mundo)与其真实耗时。只在 fallback 时打。
      if (i > 0) {
        logger.info(
          { usage: options.usage, label: labelName, model: label.model, attempt: i, latencyMs: result.latencyMs },
          'Fallback label used',
        );
      }
      if (!options.suppressMetrics) emitLlmResult(options.usage, result, options.chatId);
      // Smart Group: always record (decoupled from suppressMetrics — routing data ≠ metrics)
      void recordSmartGroupResult(labelName, result.latencyMs, true);
      return result;
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));

      // External abort (turn interrupt) — don't fallback, surface immediately.
      // 按 reason 区分:超时引发的 abort(TimeoutError)继续走 fallback 链。
      if (isCallerAbort(options.signal)) {
        throw err instanceof AIError && err.code === 'AI_ABORTED'
          ? err
          : new AIError('Aborted by caller', labelName, label.model, 'AI_ABORTED');
      }

      // Content safety rejection — **继续试下一个 provider**,不再一拒就放弃整条链。
      //
      // round 10（新 goal）：**不记熔断**。
      //
      // 2026-09-22 07:16 实测：stepfunvision 连续 5 次被 safety filter 拒
      // （群里在聊洗钱/广告类内容），3 次即达 DEFAULT_FAILURE_THRESHOLD
      // → 熔断 120s → 那 120s 内 **20 次 judge 调用全部 skipped**，
      // 用户侧看到的是"没回复"而不是"慢回复"。
      //
      // 根因是判据错位：safety filter 拒的是**这条内容**，不是 provider 的
      // 健康状态。同一个 model 对别的内容可能完全正常——拿内容问题罚 provider，
      // 等于"这条消息里有敏感词 ⇒ 这个模型坏了"。而 safety filter 本身已经
      // 给出了正确行为（换下一个 provider 试），再叠一层熔断是双重惩罚。
      //
      // 429 仍然记（那是真的 provider 侧限流，和内容无关）。
      const isContentRejected = err instanceof AIError && err.code === 'AI_CONTENT_REJECTED';
      if (isContentRejected) {
        logger.warn({ label: labelName, chatId: options.chatId, usage: options.usage, err: err.message }, 'Content rejected by safety filter, trying next provider (not counted against breaker)');
        // round 12（新 goal）：**把 censorship 拒绝记成独立计数器**。
        //
        // 2026-09-22 用户问"洗钱/广告那种会 safety 的该不该从 context 删除、
        // 该不该记为 ad"。实测（logs/app.log 13:00-13:20）：
        //   · 22 次 censorship_blocked，其中 15 次 stepfunthink
        //   · 时段内心流裁决全是 chat=-1003821093564 —— 那个群在聊
        //     '看他跳钢管舞' / 代理 / 节点 / 套餐 / grok，**是正常群聊**
        //   · 另一条可疑内容是 13:19:53 的 `www.kcna.kp / www.rodong.rep.kp/`
        //     （朝鲜通讯社，中国 provider 的敏感词）
        //
        // 也就是说 censorship 拒绝的内容**不等于是广告**——可能是政治敏感、
        // 色情暴力，也可能只是 provider 误伤。所以绝不能无差别记进 adP
        // （ad-pressure.ts:207 已经为"反安静"付过一次学费）。
        //
        // 但**完全丢掉更错**：provider 是独立的第三方判定，这条信号现在
        // 一丝不剩（Label failed → 换 label → 什么都不留）。先让它可观测，
        // 才能回答"哪个群/哪个 label 最常被拒、拒的可能是什么"。
        //
        // ⚠️ 这是第一步（可观测）。**没有**把它接进 anti-ad 的 adP 公式——
        // 那是第二步，改核心判据，要用户先拍板（选项见 commit message）。
        // **不带 chat 维度**：群有几百个，带上去 Prometheus 基数爆炸。
        // 要按群看就用日志（上面那条 warn 已带 label，加 chatId 更准）。
        incrCounter('llm_content_rejected_total', { label: labelName, usage: options.usage ?? 'unknown' });
      }

      // 429 → 短期冷却
      if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
        await cooldown.setCooldown(label.model);
      }
      // round 83：**403 concurrent limit（账号级限流）→ 冷却久一点。**
      //
      // 实测 09-23：dshkimi 一天 570 次失败，其中 **491 次（86%）是
      // `HTTP 403: You've reached your concurrent request limit`，
      // 平均每 2.4 分钟一次。而默认冷却只有 60s、熔断 120s——
      //  REST 解除需要的是「在飞的请求跑完」，不是墙上时钟走到 120s。
      // 于是形成循环：熔断 120s → 回链 → 立刻再被打 → 403 → 再熔断。
      //
      // 403 用 5 分钟（RATE_LIMIT_COOLDOWN_SEC），是账号级信号不是单次抖动。
      // 只影响这一个错误码，其余照旧。
      //
      // round 182：**把"并发限流"和"别的限流"分开。** 上面那个正则
      // （concurrent request limit|rate.?limit|too many requests）把普通
      // RPM 限流也一并打成 5 分钟——而 429 上面已经有 60s 短期冷却，这一行
      // 把它覆盖成 300s。于是：
      //   · 09-20 起 All labels exhausted 从 138/天 涨到 1600-2700/天
      //     （round 148 量的），这里有份功劳：每个 label 的不可用时间 x5
      //   · 链越短（reflection 只有 1 个 label）越容易整批全灭
      //     （round 147：deep-reflection 产出率掉到 35%）
      //
      // 分开的判据是**解除条件的物理形状**，不是错误码：
      //   · concurrent limit —— 等在飞请求跑完，与墙上时钟无关 → 长冷却
      //   · RPM / too many requests —— 滚动窗口，等一等就好 → 交给上面的 60s
      // 不缩短并发限流那一档：round 83 的实测就是说 120s 不够，
      // 改回去就是回到 403 死循环。
      const msg0 = err instanceof AIError ? err.message : '';
      if (/concurrent request limit|in-flight|concurrent requests/i.test(msg0)) {
        await cooldown.setCooldown(label.model, RATE_LIMIT_COOLDOWN_SEC);
      } else if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
        // 普通限流只保留 60s 短期冷却（上面那行已经设过，这里不再覆盖）。
        incrCounter('llm_short_cooldown_total', { label: labelName });
      }

      // 其余失败类型 → 熔断器记录（429 已有短期冷却，也记一笔加速熔断）。
      // **content rejected 例外**：它拒的是内容不是 provider 健康，见上。
      const errCode = err instanceof AIError ? err.code : 'AI_UNKNOWN';
      const tripped = isContentRejected ? false : await cooldown.recordFailure(label.model, errCode);
      if (tripped) {
        const remaining = await cooldown.getRemainingSeconds(label.model);
        logger.warn({ label: labelName, model: label.model, errCode, breakerSec: remaining }, 'Circuit breaker tripped');
      }

      // Metrics: this attempt failed
      if (!options.suppressMetrics) emitLlmError(options.usage, labelName, label.model, options.chatId);
      // Smart Group: always record failure (decoupled from suppressMetrics)
      void recordSmartGroupResult(labelName, 0, false);
      logger.warn({ label: labelName, err: errors.at(-1)?.message }, 'Label failed, trying next');
    }
  }

  // 等过但仍全冷却：结局和不抛一样是错，只是晚了十几秒。分开记才看得出值不值。
  if (waitedOnce) incrCounter('llm_wait_retry_total', { usage: options.usage, outcome: 'still_cooling' });

  const lastErr = errors.at(-1);
  if (lastErr) throw lastErr;

  // 一条都没试成，且原因全是"在冷却"→ 等最短的那个醒来再试一次。
  //
  // 2026-09-21 加。实测 awake 窗口里 `all candidates skipped by cooldown/breaker`
  // 出现 31 次（reflection 15 / vision 7 / judge 6 / summarize 3 / asi 1），
  // 被跳过的剩余冷却是 2-46 秒——**等十几秒就有一条能用了**，而旧行为是立刻失败。
  //
  // 只等一次、只等最短剩余冷却（上界 15s，别把调用方熬死）；调用方带了
  // maxTimeoutMs 的延迟敏感路径（heart/gate）不等——它们本来就该快速失败。
  // `waitIfCooling` 让后台批任务覆盖"有 maxTimeoutMs/signal 就不等"的默认——
  // 它们不怕等，却因为设了那两条而被排除在这个重试之外。
  const mayWait = options.waitIfCooling || (!options.maxTimeoutMs && !options.signal);
  if (shortestCooldownSec > 0 && mayWait) {
    waitedOnce = true;
    const waitSec = Math.min(shortestCooldownSec + 1, 15);
    logger.debug(
      { usage: options.usage, waitSec, candidates: smartOrderedNames },
      'all candidates cooling — waiting for the shortest to recover, then retrying once',
    );
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    for (const labelName of smartOrderedNames) {
      const label = getLabel(labelName);
      if (await cooldown.isCoolingDown(label.model)) continue;
      try {
        const result = await callModel(label, options.messages, attemptOptsFor(label, callOpts, options.maxTimeoutMs));
        if (options.rejectEmpty && !result.content.trim()) continue;
        await cooldown.recordSuccess(label.model);
        if (!options.suppressMetrics) emitLlmResult(options.usage, result, options.chatId);
        // 记账：这个重试到底救没救回来。2026-09-21 实测它在生产里已触发 46 次
        // （MainPID 1979127），但触发次数不等于有用——等完仍全冷却的话，
        // 结局和不等一样是抛错，只是晚了十几秒。没这个计数器，"我加了个重试"
        // 和"这个重试有用"看起来一模一样。
        incrCounter('llm_wait_retry_total', { usage: options.usage, outcome: 'ok' });
        return result;
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
        if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') void cooldown.setCooldown(label.model);
        void cooldown.recordFailure(label.model, err instanceof AIError ? err.code : 'AI_UNKNOWN');
      }
    }
  }

  // 一次都没尝试过就"全灭"——所有候选都被熔断/429 冷却跳过。
  //
  // 2026-09-21 加。这个分支此前抛的错和"每个 label 都真失败了"完全一样
  // （都是 `All labels exhausted`，label/model 都是 'unknown'），但两者的病因
  // 和处置相反：
  //   · 真失败 → 该看 provider 的 key/endpoint/额度
  //   · 全跳过 → 该等冷却过去，或者链里全是同一个模型（stepfun/stepfunjudge/
  //     stepfunvision/stepfunthink/stepfunasi 五个 label 共用 step-3.7-flash，
  //     一个熔断全死）
  // 不区分的时候，后者看起来像前者，于是一次"等 45 秒就好"的故障会被当成
  // "provider 全挂了"去查。实测触发路径：连跑几个探针把 step-3.7-flash 的
  // 熔断打满，之后 dreaming 的 4 个候选（stepfun/dsv4flash/grok43vision/grok45）
  // 全部在冷却中 → 25ms 内失败，零条 per-label 日志。
  const skipped = await Promise.all(
    smartOrderedNames.map(async (n) => {
      const l = getLabel(n);
      const remaining = await cooldown.getRemainingSeconds(l.model);
      return { label: n, model: l.model, coolingForSec: remaining };
    }),
  );
  logger.warn(
    { usage: options.usage, candidates: smartOrderedNames, skipped },
    'all candidates skipped by cooldown/breaker — nothing was attempted',
  );
  throw new AIError('All labels exhausted (all candidates cooling down)', 'unknown', 'unknown', 'AI_ALL_FAILED');
}

/** 单跳尝试参数:给有 per-label timeout/maxTokens 覆盖的 label 套上(顺序 fallback 与
 *  hedge 共用同一逻辑,修 codex #1:原来 hedge 直接用 callOpts、丢了 per-label 覆盖)。 */
function attemptOptsFor(
  label: ReturnType<typeof getLabel>,
  callOpts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal },
  maxTimeoutMs: number | undefined,
): { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal } {
  if (label.timeout === undefined && label.maxTokens === undefined) return callOpts;
  return {
    ...callOpts,
    timeout: label.timeout === undefined
      ? callOpts.timeout
      : (maxTimeoutMs !== undefined ? Math.min(label.timeout, maxTimeoutMs) : label.timeout),
    maxTokens: label.maxTokens ?? callOpts.maxTokens,
  };
}

async function hedgedCall(
  primaryLabel: ReturnType<typeof getLabel>,
  hedgeLabel: ReturnType<typeof getLabel>,
  messages: AICallOptions['messages'],
  callOpts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal },
  hedgeDelayMs: number,
  cooldown: CooldownTracker,
  rejectEmpty: boolean,
  maxTimeoutMs: number | undefined,
  usage: string,
  suppressMetrics: boolean,
  chatId: number | undefined,
): Promise<AICallResult> {
  const toError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

  // 每一跳一个自己的 AbortController,并把调用方的 signal 合进去。
  //
  // 原实现只用 clearTimeout 取消 hedge —— 那只在"主标签 2s 内先完成"时有效。定时器一旦
  // 触发、hedge 的 fetch 已经发出,主标签随后胜出时 Promise.any 直接返回,**没有任何东西
  // 去掐掉 hedge 的请求**:它会跑到底并被 provider 完整计费。而 HEDGE_DELAY_MS 默认 2000,
  // 回复链主模型(grok-4.5, REASONING=low)的延迟远高于 2s,heart 判定也在 2-6s ——
  // 这不是边缘情况,是几乎每次都命中,等于整条链的 token 账单翻倍。
  const controllers = new Map<string, AbortController>();
  let settledWinner: string | null = null;
  // hedge 双跳计费去重(P0 fix 2026-08-22): 输家"已完成但被掐"是否已 emit 过 usage,
  // 用单调 Set 判定而不是读 settledWinner——两跳几乎同时完成时 .then 与 Promise.any.then
  // 的 microtask 顺序不保证, 靠 winner 指针会随机多记/漏记一份。
  const emittedUsageLabels = new Set<string>();
  const abortLosers = (winner: string | null) => {
    for (const [name, ac] of controllers) {
      if (name !== winner) ac.abort(new Error('hedge lost the race'));
    }
  };

  // 单跳:用该 label 自己的 attemptOpts(修 #1:per-label timeout/maxTokens 覆盖);
  // rejectEmpty 时空内容视为失败**在这里 reject**(修 #1:否则 Promise.any 把空当成功,
  // heart/gate 解析失败 → fail-open pass → 吞回复)。
  const attempt = (label: ReturnType<typeof getLabel>): Promise<AICallResult> => {
    const ac = new AbortController();
    controllers.set(label.name, ac);
    const opts = attemptOptsFor(label, callOpts, maxTimeoutMs);
    const signal = callOpts.signal
      ? AbortSignal.any([callOpts.signal, ac.signal])
      : ac.signal;
    return callModel(label, messages, { ...opts, signal }).then((r) => {
      // abort 之前就已经完成的输家(两跳几乎同时返回)仍然被 provider 计费过。原实现让
      // 它的 rejection/resolution 被 Promise.any 吞掉,既不 emitLlmResult 也不 emitLlmError
      // —— 于是 llm_token_daily 与 llm_tokens_total 系统性少算了 hedge 那一份,
      // 这也正是"hedge 不取消输家"能长期没被发现的原因。这里把它记成 discarded。
      if (settledWinner !== null && settledWinner !== label.name && !suppressMetrics) {
        if (!emittedUsageLabels.has(label.name)) {
          emittedUsageLabels.add(label.name);
          emitLlmResult(usage, r, chatId);
          logger.info(
            { usage, label: label.name, tokens: r.tokenUsage.total },
            'Hedge loser completed anyway — tokens billed, counted as discarded',
          );
        }
      }
      if (rejectEmpty && !r.content.trim()) {
        throw new AIError('Empty response', label.name, label.model, 'AI_EMPTY');
      }
      return r;
    });
  };

  // Wrap each call to handle rate-limit cooldown side-effects and normalize errors
  const primaryPromise = attempt(primaryLabel).catch((err: unknown) => {
    if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
      void cooldown.setCooldown(primaryLabel.model);
    }
    // 熔断记录
    const errCode = err instanceof AIError ? err.code : 'AI_UNKNOWN';
    void cooldown.recordFailure(primaryLabel.model, errCode).then((tripped) => {
      if (tripped) logger.warn({ label: primaryLabel.name, model: primaryLabel.model, errCode }, 'Circuit breaker tripped (hedge primary)');
    });
    return Promise.reject(toError(err));
  });

  // After hedgeDelayMs, start hedge if primary hasn't resolved yet and hedge isn't cooling down
  let hedgeStarted = false;
  const hedgePromise = new Promise<AICallResult>((resolve, reject) => {
    const timer = setTimeout(async () => {
      // caller 已 abort(turn 打断/关机)时不再发射 hedge——否则白烧一跳还会给 hedge label 刷熔断(P1 fix 2026-08-22)
      if (isCallerAbort(callOpts.signal)) {
        reject(new AIError('Hedge skipped (caller aborted)', 'unknown', 'unknown', 'AI_ABORTED'));
        return;
      }
      if (await cooldown.isCoolingDown(hedgeLabel.model)) {
        reject(new AIError('Hedge skipped (cooldown)', 'unknown', 'unknown', 'AI_HEDGE_FAILED'));
        return;
      }
      hedgeStarted = true;
      attempt(hedgeLabel).then((r) => {
        void cooldown.recordSuccess(hedgeLabel.model);
        return r;
      }).then(resolve, (err: unknown) => {
        // 2026-08-07 事故修复:hedge 输掉 race 被 abort 不是真实故障,不计熔断。
        // 原实现把输家的 abort 也 recordFailure —— k27code "Empty response"(真故障)
        // + hedge 输家 timeout(无辜)双杀,把熔断退避刷到 405s+,冻死 summarize 链,
        // deep-reflection 12 群全灭。settledWinner 非空说明已有赢家,hedge 是被掐掉的。
        if (settledWinner === null || settledWinner === hedgeLabel.name) {
          if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') void cooldown.setCooldown(hedgeLabel.model);
          const errCode = err instanceof AIError ? err.code : 'AI_UNKNOWN';
          void cooldown.recordFailure(hedgeLabel.model, errCode).then((tripped) => {
            if (tripped) logger.warn({ label: hedgeLabel.name, model: hedgeLabel.model, errCode }, 'Circuit breaker tripped (hedge backup)');
          });
        }
        reject(toError(err));
      });
    }, hedgeDelayMs);

    // If primary resolves before the timer fires, cancel the hedge
    primaryPromise.then(() => clearTimeout(timer), () => { /* let timer fire */ });
  });

  // Return whichever succeeds first; only reject if both fail
  return Promise.any([primaryPromise, hedgePromise])
    .then((r) => {
      // 赢家返回前先掐掉输家在飞的请求 —— 否则它跑到底并被计费。
      settledWinner = r.label;
      abortLosers(r.label);
      // 赢家成功 → 只重置赢家自己的熔断失败计数
      // (primary 失败但 hedge 赢时，primary 的计数不应被重置 — 否则永远不熔断)
      if (r.label === primaryLabel.name) void cooldown.recordSuccess(primaryLabel.model);
      if (r.label === hedgeLabel.name) void cooldown.recordSuccess(hedgeLabel.model);
      if (hedgeStarted) {
        logger.info(
          { winner: r.label, primary: primaryLabel.name, hedge: hedgeLabel.name },
          'Hedge raced; loser aborted',
        );
      }
      return r;
    })
    .catch((err: unknown) => {
      abortLosers(null);
      if (err instanceof AggregateError && err.errors.length > 0) {
        throw err.errors[0];
      }
      throw err;
    });
}
