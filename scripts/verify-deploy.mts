/**
 * Nyat Trench · 部署核验（Deploy Verification）
 *
 * 为什么需要它：2026-09-19 我发现用相对路径改 scripts/ 下的文件可以**报告成功但
 * 什么都没写**（shell 的 cwd 是 /root，不是仓库根）。而我这个会话里的失败，
 * 绝大多数都是"某一步报告成功但并未发生"——未接线的导出、静默 catch、陈旧日志、
 * 静默失败的读数器。代码和账本都能测，**"改动落在产物里"这件事没有守卫**。
 *
 * 所以这个脚本在 build 之后核验：这次会话新增的每一项机制都在 dist/index.js 里。
 * 匹配要同时处理三种形态，否则会误报（我一次核验里连错三次）：
 *   ① 单引号 —— esbuild 把 ' 规范成 "
 *   ② CJK   —— esbuild 把非 ASCII 转义成 \\uXXXX
 *   ③ 压缩后的变量改名（init_xxx / _exports 后缀）
 *
 * 用法：npx tsx scripts/verify-deploy.mts        （build 之后跑）
 */

import { readFileSync } from 'node:fs';

const BUNDLE = 'dist/index.js';

/** 一次匹配要试的四种形态：原样 / 双引号 / CJK 转义 / 两者兼有。 */
function variants(pattern: string): string[] {
  const dq = pattern.replace(/'/g, '"');
  // **必须大写 hex**：esbuild 发 \\u503C 而不是 \\u503c。第一版用小写，
  // 于是三项中文串全部误报缺失——而它们确实在产物里。
  const esc = (s: string): string =>
    [...s].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('');
  return [pattern, dq, esc(pattern), esc(dq)];
}

const CHECKS: Array<[string, string]> = [
  ['QQ 主人指派入口', 'tryHandleOneBotAssignmentCommand'],
  ['QQ 指派发送围栏', 'assertOneBotAssignmentReservation'],
  ['日记配置版本与审计', 'business_config_revision_conflict'],
  ['主人配置命令入口', 'tryHandleJournalConfigCommand'],
  ['受限版本更新请求', 'tryHandleUpdateCommand'],
  ['版本进程真实就绪', 'StartupReadiness'],
  ['停机即撤销就绪', 'registerReadinessLifecycle'],
  ['本地任务排空不伪造确认', 'codeact_local_pending_without_queue_receipt'],
  ['旧终端清空宿主环境', '--clearenv'],
  ['独立音频转写协议', 'AUDIO_TRANSCRIBE_API_MODE'],
  ['语音私有运行时', 'TTS_PYTHON_PATH'],
  ['语音 Opus 编码器', 'TTS_FFMPEG_PATH'],
  ['有状态搜索结果', 'executeSearchDetailed'],
  ['CodeAct 隔离总闸', 'CODEACT_ISOLATION_ENABLED'],
  ['CodeAct 内核隔离执行', 'codeact_isolation_unavailable'],
  ['迁移后真人活动门控', 'checkProactiveActivation'],
  ['主动动作固定启用时间', 'PROACTIVE_ACTIVATED_AT_SEC'],
  ['后台模型并发预算', 'AI_WORKLOAD_BUDGET_ENABLED'],
  ['后台模型预算上限', 'AI_MAX_BACKGROUND_INFLIGHT_PER_MODEL'],
  // L0 海床
  ['L0 有界积分器渲染', 'renderTrench'],
  ['L0 时间泵', 'xxb:trench:lastpump:'],
  ['L0 睡眠积压', 'TRENCH_SLEEP_PULSE_ENABLED'],
  ['L0 定向债记账', 'oweFor'],
  ['L0 定向债渲染', '[欠话]'],
  ['L0 卡死自恢复', 'recoverIfStuck'],
  ['L0 发言抽气 85%', 'releasePressure'],
  // L1 沟壁
  ['L1 包络开关', 'TRENCH_ENVELOPE_MODE'],
  ['L1 包络拦截文案', '回得太密'],
  ['L1 发送前硬闸', 'BLOCKED by trench gate'],
  // L2 反射
  ['L2 Echo 回填', 'backfillEcho'],
  ['L2 回声渲染', '[回声]'],
  ['L2 放行入账 spoke', 'noteLiveOutcome'],
  ['L2 睡眠独立 asleep', 'asleep'],
  ['L2 绕过入账 intercepted', 'intercepted'],
  // Phase 1 与开关
  ['heart 三态路由', 'heartRoute'],
  ['heart 灰度名单', 'META_HEART_BYPASS_CHAT_IDS'],
  ['时限旁路', 'hasTimedBypass'],
  ['gate LLM 开关', 'TIMING_GATE_LLM_ENABLED'],
  // 反广告 · 第二张牌（回复式代发：让别的 bot 代罚）
  ['回复式代发闸', 'tryDelegateReplyCommand'],
  ['可回复命令清单', 'listReplyInvocableCommands'],
  ['回复式代发限流键', 'xxb:delegation:reply:cd:'],
  ['可用手段渲染', '[授权]'],
  ['bot 工具进沙盒', 'BOT_REPLY_DELEGATION_MAX_PER_HOUR'],
  // 频率治理（2026-09-21）
  ['被叫回复也有间隔', 'addressedSpeechCooldownRemainingSec'],
  ['被叫间隔拦措辞', 'just_answered'],
  ['每任务发送预算', 'AGENT_TASK_SEND_BUDGET'],
  ['预算耗尽收尾', 'send_budget_exhausted'],
  // 黑板总闸（2026-09-21）
  ['blackboard 总闸', 'blackboardEnabled'],
  // ASI rubric 真在测（2026-09-21）
  ['ASI 走独立 usage', 'ASI_USAGE'],
  ['ASI 未测到不写分', 'measured'],
  // 心流 LLM 失败保句闸（2026-09-21）
  ['失败保句闸', 'llmFailedDecision'],
  ['保句闸寻址判定', 'isAddressedToBot'],
  // 思维链截断加额重试（2026-09-21）
  ['截断加额重试', 'claude: 空正文'],
  // 链的上游去重（2026-09-21）
  ['链上游去重', 'diversifyByUpstream'],
  // Meta 路径 bot 两道闸（2026-09-21）
  ['bot 结构闸', 'decideBotMessage'],
  ['bot 结构闸判据', 'ignore-structural'],
  // 视频描述可观测性（2026-09-21）
  ['视频描述遥测', 'Video described'],
  // Meta 主路径接上 peer-reaction / network-burst（2026-09-21）
  ['Meta peer-reaction', 'Meta: peer-reaction'],
  // 图片描述写进 textContent（Meta 路径才看得见，2026-09-21）
  ['图片描述进正文', '[图片: '],
  // Meta 路径认领代发回执（2026-09-21）
  ['Meta 代发回执', 'Meta: delegation receipt handled'],
  // Meta 主路径的实时学习 + ASI 自评（2026-09-21）
  ['Meta 实时学习', 'learnFromReply'],
  // 批次级总闸（round 65/66）：这两个 tick 预算必须进包，否则循环没有上限
  ['反思 tick 预算', 'REFLECTION_TICK_BUDGET_SEC'],
  ['topic-scan tick 预算', 'TOPIC_SCAN_TICK_BUDGET_SEC'],
  ['tick 预算跳过计数', 'skippedForBudget'],
  // Meta 路径也接上学到的 bot 命令代发（2026-09-21，此前只在 legacy）
  ['Meta 学命令代发', 'Meta: learned-command router failed'],
  ['学命令代发入口', 'routeLearnedCommand'],
  // Meta 路径也接上控制指令（2026-09-21，此前只在 legacy deliver.ts）
  ['Meta 控制指令', 'Meta: control directive executed'],
  // 包络按群活跃度缩放（2026-09-21）
  ['包络活跃度缩放', 'scaledBurst'],
  // 沙盒参数表对齐守卫（2026-09-21）
  ['沙盒 RPC 能力白名单', 'codeact_capability_denied_or_limit'],
  // reasoning token 下限（2026-09-21）
  ['reasoning token 下限', 'REASONING_TOKEN_FLOOR'],
  // topic-scan 低抽取告警（2026-09-21）
  ['topic-scan 低产告警', 'topic-scan: 连续低抽取'],
  // claude 路径的 jsonMode 预填（2026-09-21）
  ['claude jsonMode 预填', 'jsonPrefill'],
  // follow-up judge / 代发回执的 jsonMode（2026-09-21）
  ['follow-up judge jsonMode', 'parseJudgeResult'],
  // 全候选被冷却跳过的可诊断失败（2026-09-21）
  ['全冷却可诊断', 'nothing was attempted'],
  // Qdrant 写瞬断重试（2026-09-21）
  ['Qdrant 瞬断重试', 'withQdrantRetry'],
  // embedding 离线装载（2026-09-21）：onnx 权重若已在本地，必须锁死 local_files_only，
  // 否则 proxy 一抖 memory 就被兜进 "Memory write failed" 里 —— 而那正是 2270/2280
  // 条告警的真实来源（一度被误诊成 Qdrant 瞬断）。打包后这条机制必须还在。
  ['embedding 离线装载', 'local_files_only'],
  // 权重判定的兜底：HF 307 redirect stub（~1KB 文本）不能算"已在本地"。
  // 匹配源里那个正则 /^\s*(?:found\.redirecting|<|<!doctype)/i 的片段
  // （'\' 是转义符，别把带点的整串当 pattern，includes 会 miss）。
  ['onnx 权重去 stub', 'redirecting'],
  // 缺权重时的可操作告警（把出路写进日志：去跑 scripts/fetch-embed-model.mts）
  ['embedding 缺失告警', 'Memory embedding weights'],
  // 离线锁要以整套文件为条件（2026-09-30）：09-24 只抓了权重就锁，tokenizer.json 再没
  // 机会下载，六天 18,915 次 "Memory embedding unavailable"、零次成功。
  ['embedding JSON 齐全判定', 'findMissingEmbedJson'],
  ['embedder 加载成功日志', 'Memory embedder loaded'],
  // 长轮询死后原地重开（2026-09-30）：409 让 bot.start() reject，原来 void 掉 →
  // 轮询静默死、5 分钟后看门狗重启进程，09-28→09-30 每 12 分钟一次。
  ['轮询死后自愈', 'Polling loop died'],
  // 学来的东西接进 Meta 路径（2026-10-01）：读侧原来只在 legacy buildMessages（~0.17% 发送）。
  ['学习产物 Meta 读侧', 'learned context injected'],
  ['学习产物总闸', 'META_INJECT_LEARNED_ENABLED'],
  // 无 contract 任务的 host 证据（2026-10-01）：task_evidence 7038/7039 恒 unverified，
  // episodes 自 09-05 起零 done。用 self_replies 的结局（有没有人接）给任务补证据。
  ['Echo 证据升级', 'applyEchoEvidence'],
  ['Echo 证据落盘日志', 'task evidence upgraded from host echo'],
  ['skill 注入留痕', 'recordSkillInjections'],
  ['skill 延迟记功', 'recordSkillVerifiedUseForTask'],
  // 在飞上限挡下时 waitIfCooling 的调用方要等一下再试（2026-10-01）：unified-tick 797 次里 794 次
  // llm_failed，skipped 的 coolingForSec 全是 0 —— 是在飞上限而不是冷却。
  ['在飞上限挡下可等待', 'blockedByInFlight'],
  ['tick 决策声明可等待', 'tick 是 5 分钟一次的后台决策'],
  // tick 独立 usage（2026-10-01）：与回复链共用 spacebunny 的在飞坑 → 794/797 次 llm_failed。
  ['tick 独立 usage 链', 'tick: { label: "mimo"'],
  ['tick 选路交还手动链', 'tick: { minTier: "medium", vision: false, video: false, count: 1, respectManualOrder: true }'],
  // goal 待关闭观察期（2026-10-01）：声称完成但无独立证据 → pending_close → 看「有没有人再提」。
  ['goal 观察期决策函数', 'settleUnverifiedCompletion'],
  ['goal 沉默后未验证归档', 'goal archived unverified after silence'],
  ['goal 观察期结算 cron', 'goal-close-sweep'],
  // web.fetchToFile（2026-10-02）：沙盒无网络，宿主侧带数据进来；并修了 fetchUrlPinned 超量不 settle。
  ['web.fetchToFile 宿主实现', 'fetchToSandboxFile'],
  ['web.fetchToFile 开关', 'CODEACT_WEB_FETCH_TO_FILE_ENABLED'],
  ['fetchUrlPinned 超量截断收尾', 'truncatedByCap'],
  // care_master 不被群里 group_speak 的 connection 饱和连带封住（2026-10-02）：39 次否决 vs 12 次发出。
  ['care_master 豁免全局 connection 饱和', "if (a.type === \"care_master\") return null"],
  ['tick 外壳超时常量', 'TICK_RACE_TIMEOUT_MS'],
  ['tick 决策耗时留痕', 'tick decision call finished'],
  ['tick 默认走独立 usage', 'UNIFIED_TICK_USAGE: z9.string().default("tick")'],
  // 沙盒控制流拒绝降级（2026-09-21）
  ['控制流拒绝降级', 'sandbox control flow (expected)'],
  // 选路：零成功 demote + vision 严格过滤（2026-09-21）
  ['零成功 demote', 'slowest + newcomerLatency'],
  // 沙盒不可用时改写 prompt（2026-09-21）
  ['沙盒 prompt 改写', 'applySandboxAvailabilityNotes'],
  // 随手日记（2026-09-21）
  ['日记分时段语气', 'slotGuidance'],
  // 视频理解（2026-09-21）
  ['视频描述接线', 'describeVideo'],
  ['视频 MIME 兜底', 'videoMimeFromPath'],
  ['video_url 序列化', 'video_url'],
  ['claude 分支不再吞媒体', 'carriesMedia'],
  ['provider 健康播报', 'neverSucceeded'],
  // 画摊子：SVG 长代码活的授权链 + 选路交还手动链（2026-09-21）
  ['画摊子 usage 默认链', 'artist: { label: "spacebunny"'],
  ['代发回执：命令被退回单独一支', 'isCommandRejection'],
  ['代发缺参闸（arity-aware）', 'usageNeedsArg'],
  ['代发缺参兜底：人类消息带实参', 'humanMessageCarriesArg'],
  ['代发缺参兜底：按占位形状判（round 201）', 'argShapesFor('],
  ['发送日志带 taskId（per-task 发送分布可算）', "taskId: opts.taskId ?? null"],
  ['task 级 burst 闸（同任务连发）', 'send_task_burst_total'],
  ['interrupt 寻址分桶（寻址）', 'agent_interrupt_addressed_total'],
  ['interrupt 寻址分桶（背景）', 'agent_interrupt_background_total'],
  ['关机分步：CodeAct worker', "'codeact-worker'"],
  ['关机分步：CodeAct queue', "'codeact-queue'"],
  ['boot context log (in-process guards reset)', 'process boot context (in-process guards reset)'],
  ['stale agent sweep health log', 'agent sweep: stale running-task indexes scanned'],
  ['process lifetime 量纸', 'process lifetime: short'],
  ['task 级 burst 闸的键只在调用完成后写', 'taskLastSendKey(burstTaskId)'],
  ['命令路由要求寻址', 'command_router_skip_unaddressed_total'],
  ['画摊子交还手动链', 'respectManualOrder'],
  // 仪器
  ['醒来检测', 'detectWakeTransition'],
  ['压力轨迹日志', 'trench pump tick'],
  ['cron 心跳', 'wake-detect ran'],
  // Jev / TypeSafe System One 结构化判断(lfree relay)——客户端与命令路由接入都得在包里
  ['Jev systemone 端点', 'v1/systemone'],
  ['Jev 命令路由接入', 'JEV_ENABLED'],
];

let bundle = '';
try {
  bundle = readFileSync(BUNDLE, 'utf8');
} catch {
  console.error(`✗ 读不到 ${BUNDLE} —— 先跑 npm run build`);
  process.exit(2);
}

const missing: string[] = [];
CHECKS.push(['Meta 启动隔离实测', 'Meta isolation preflight passed']);
CHECKS.push(['Meta/CodeAct 有界排队', 'codeact_isolation_queue_full']);
CHECKS.push(['OneBot 启动连接', 'OneBot connection state']);
CHECKS.push(['QQ/Telegram 发送隔离', 'telegram_platform_id_blocked']);
CHECKS.push(['OneBot 未知送达停止重试', 'failed_delivery_unknown_no_retry']);
CHECKS.push(['QQ 持久身份映射', 'platform_identity_refs']);
for (const [name, pattern] of CHECKS) {
  if (!variants(pattern).some((v) => bundle.includes(v))) missing.push(`${name} (${pattern})`);
}

console.log(`\n═══ 部署核验 · ${CHECKS.length} 项 ═══\n`);
for (const [name] of CHECKS) {
  const hit = !missing.some((m) => m.startsWith(`${name} (`));
  console.log(`  ${hit ? '✓' : '✗'} ${name}`);
}
if (missing.length === 0) {
  console.log(`\n✅ ${CHECKS.length}/${CHECKS.length} 项都在构建产物里。\n`);
  process.exit(0);
}
console.log(`\n❌ 缺失 ${missing.length} 项：`);
for (const m of missing) console.log(`   - ${m}`);
console.log('\n先确认是不是漏 build，再确认是不是编辑没落盘（相对路径！）。\n');
process.exit(1);
