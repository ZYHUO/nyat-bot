# Timing Gate：MaiBot (maisaka) 原版机制深挖 vs xxb-ts 移植版

> 2026-07-02，基于 /root/.tmp-maibot-study 当前源码逐行核对。
> 结论先行：xxb-ts 的 gate 是"**每条消息一次的无状态 LLM 三选一**"；MaiBot 的 gate 是
> "**确定性频率阈值先攒消息 → debounce 攒完一阵 → 回合开头带全量共享记忆的有状态门控 →
> continue 后整回合免检 + 连续 Planner 状态跨回合免检**"。移植只搬了三选一的壳，
> 没搬周围的整套节奏架构，所以体感差很多。

## MaiBot 原版架构（file:line 均指 .tmp-maibot-study）

### 0. 总循环形态
- 每个 chat 一个常驻 `MaisakaHeartFlowChatting`（runtime.py），内部 `_internal_turn_queue` +
  `ReasoningEngine.run_loop()`（reasoning_engine.py:871）消费 turn 触发（"message"/"timeout"/proactive）。
- 一个 turn = 最多 `_max_internal_rounds` 个内部轮次的工具循环（planner 反复调工具直到
  reply/no_action/finish/wait）。

### 1. 【xxb 完全缺失】talk_value 频率阈值层（gate 之前的确定性闸）
runtime.py:636-669, 748-753, 1451-1504：
- `effective_frequency = talk_value(0~1, 分群/分平台/分时段规则可配) × talk_frequency_adjust`
- 触发一轮思考需要 `pending_count >= ceil(1 / effective_frequency)` 条**新消息**
  （talk_value=1 → 每条都触发；0.2 → 攒 5 条才想一次）。
- 时段规则：`ChatConfigUtils.get_talk_value`（utils_config.py:452）按 `talk_value_rules`
  匹配 platform/item_id/时间段，特异性优先级 5>4>1。
- **空闲补偿**（runtime.py:870-899）：`idle_seconds / avg_interval` 折算等效消息数，
  封顶 `threshold-1`（纯沉默永不触发，至少 1 条真实消息）。
  avg_interval = 最近 30 分钟外部消息间隔均值（<5s 的 burst 间隔不计入样本，下限 30s）。
- 不够阈值时不是丢弃：挂 delayed task 到"预计凑够等效消息"的时刻再检查
  （runtime.py:1494-1504）——消息不会丢，只是延后评估。
- @/提及强制触发绕过阈值（`_has_forced_timing_trigger`）。
- 效果：**大部分"沉默"由这层 0 成本产生**，LLM gate 只在"值得想一想"时被调用。

### 2. 消息静默期 debounce
runtime.py:116 `_message_debounce_seconds = 1.0`；runtime.py:1531-1547：
进 turn 前等到距最后一条消息 ≥1s（对方连发时持续顺延），保证 gate 看到完整的一阵话。
内部轮次 round>0 开始前、planner 被打断重试前也会 debounce + 合并新消息
（reasoning_engine.py:951-962, 1190-1198）。

### 3. gate 的身份：与 planner 共享同一份对话历史的子代理
- 调用点：turn 的第一个内部轮次开头（reasoning_engine.py:1000-1040），
  `_run_timing_gate`（:554）→ `run_sub_agent(request_kind="timing_gate")`。
- **上下文 = planner 的 `_chat_history` 过滤版**（chat_loop_service.py:1183-1230）：
  保留普通消息、assistant 的文本 reasoning、以往 timing 工具链（continue/no_action/wait
  的调用与结果）、中期记忆 pinned 消息；剔除 planner 业务工具链噪声。
  → gate **看得到自己上次的节奏分析和决策**，是有状态的。
- 反向过滤：planner 的历史里剔除 continue/wait 工具链（:1247），只留 no_action。
- 上下文窗口 = max_context_size × 2（CACHE_STABILITY_RATIO，KV cache 稳定）。
- gate 可配独立模型 task（chat_loop_service.py:62-64 `timing_gate`），可开视觉。

### 4. 输出协议：工具调用，先文本分析后调工具，fail-closed
- prompt：prompts/zh-CN/maisaka_timing_gate.prompt。动作是 continue/wait/**no_reply**
  （工具名 no_action），要求"先输出对当前聊天节奏的文本简短分析，然后调用一个工具"
  ——**分析文本留在共享历史里**，下轮 gate/planner 都能看到。
- 非法工具 → 注入纠正 hint 重试（TIMING_GATE_MAX_ATTEMPTS 次），全失败 →
  **按 no_action 处理并进 STOP**（reasoning_engine.py:607-615）。**fail-closed：宁可沉默**。

### 5. no_action 语义 + 指数退避（延迟重评，不丢消息）
- no_action 工具（builtin_tool/no_action.py）→ `_enter_stop_state()`：等下一条新消息，
  下一轮仍要过频率阈值 + 退避。
- 退避（runtime.py:1020-1101）：仅群聊；连续第 `start_count`(默认见 config) 次起
  `base × 2^n` 封顶 cap。**退避中不是放行也不是吞掉，而是挂 delayed task 到退避结束
  重新检查**；pending 数 ≥ bypass 阈值可绕过；@/提及即刻重置退避。
- planner 层也有自己的 no_action（见 §7），同样计入退避（source="planner"）。

### 6. wait 语义
- 工具 schema 只有 `seconds`（builtin_tool/wait.py），**无 min/max clamp**（默认 30，max(0,n)）。
- 期间新消息**不打断**（run_loop :891-898 忽略消息触发但消息仍在缓存）。
- 到点（runtime.py:1574-1593）→ 状态回 RUNNING → 投递 "timeout" turn →
  把「wait 已完成(有/无新消息)」的标记消息注入共享历史 → 若有缓存新消息一起收进来，
  否则**复用锚点消息立刻开新一轮完整思考**（reasoning_engine.py:915-936）。
  "等一下"永远有下文，不会变成永久沉默。

### 7. 【体感差距最大】continue 后的免检期：连续 Planner 状态
- gate 每 turn 只跑一次（`_mark_timing_gate_completed`，reasoning_engine.py:1027）：
  continue 之后同 turn 的所有内部轮次不再过 gate。
- planner 被新消息**打断后重试也跳过 gate**（:1183-1198，"保持活跃状态直接重试 Planner"）。
- planner 调 no_action（不是 finish）→ **保留连续 Planner 状态**：下一条消息直接进
  planner，完全不过 gate（no_action.py 描述 + reasoning_engine.py:1112-1114）；
  只有 finish 才结束连续状态、恢复 gate 门控。
- 效果：bot 一旦入场，处于对话中时不再反复自问"该不该说话"——
  xxb 的「对话中途蒸发」问题在 MaiBot 是架构性不存在的（xxb 只能靠 presenceBlock prompt 补丁）。

### 8. @/提及强制 continue
runtime.py:921-1003：@ 或提及（inevitable_at_reply / mentioned_bot_reply）→ 武装一次性
force flag：绕过频率阈值 + 重置退避 + **下次 gate 不烧 LLM 直接伪 continue**（理由写入历史）。

### 9. planner 打断
新消息到达且 planner 在跑 → set interrupt flag 打断重规划；连续打断有上限
（planner_interrupt_max_consecutive_count），同一请求只打断一次（runtime.py:604-632）。

## xxb-ts 现状（src/pipeline/timing/gate.ts 等）与逐点差距

| # | MaiBot | xxb-ts | 差距评级 |
|---|--------|--------|---------|
| 1 | talk_value 频率阈值 + 时段规则 + 空闲补偿，确定性攒消息 | 无此层，每条过 judge 的消息都打 gate LLM（15s cooldown 兜底） | **大**（借了指数退避，没借阈值层本体；gap 文档里用 focus 标量替代，但 focus 是调制不是闸） |
| 2 | gate 与 planner 共享历史，有状态，见得到自己过去的分析/决策 | slimContext 30 条纯文本 + judge 摘要，无状态 | **大** |
| 3 | 先文本分析后工具调用；分析入历史 | 纯 JSON 输出；reason 只进日志 | 中 |
| 4 | 解析失败 fail-closed（no_action+STOP） | fail-open（continue） | **方向相反** |
| 5 | 退避/未达阈值 = 挂 delayed task 延迟重评，消息不丢 | TURN_GATE_DEFER_COOLDOWN=defer 吞掉这条（无 timed re-check）；旧语义直接放行 | **大**（两种语义都不对） |
| 6 | continue 后整 turn 免检 + 连续 Planner 跨 turn 免检（finish 才恢复门控） | 每 turn 前都重跑 gate；无连续状态概念 | **大**（「对话中蒸发」根因） |
| 7 | wait 无 clamp，LLM 自定秒数；到点注入 wait-completed 标记 + 立即完整重评（合并期间新消息） | clamp [5,120]；TURN_WAIT_RESUME_ENABLED 才回访，回访靠锚点重注入 | 中 |
| 8 | @/提及 force-continue 不烧 LLM，理由入历史 | direct bypass ✓（等价） | 无 |
| 9 | debounce 1s 静默期后才评估 | turn scheduler 有防抖，但 gate 输入是 judge 时刻快照 | 小 |
| 10 | 私聊无退避、talk_value 独立；focus 模式 frequency=1 | 群/私聊同一套 gate | 小 |

## 若要修，优先级建议（未实施）
1. **P0 连续对话免检**：judge/gate continue 或 bot 刚回复后 N 分钟内（或直到显式 finish 类信号）
   跳过 gate——对齐"连续 Planner"。presenceBlock 补丁可退役。
2. **P0 defer 语义改为延迟重评**：cooldown/退避中不丢消息，改为把消息 append pending +
   scheduleTurn(delay=剩余冷却)，到点重评（MaiBot 的 delayed task 语义）。
3. **P1 talk_value 阈值层**：per-chat 频率(0-1) → ceil(1/f) 条消息阈值 + 30min 平均间隔的
   空闲补偿，放在 gate LLM 之前，砍掉大部分 gate 调用。可复用现有 focus 标量做 adjust 乘子。
4. **P1 gate 有状态化**：把最近 K 次 gate 决策（action+reason+时间）注入 gate prompt；
   或更彻底：gate 用 turn-actor 的同一份上下文。
5. **P2 fail 方向**：非 direct 场景解析失败改 fail-closed（direct 已在上游 bypass，不受影响）。
6. **P2 wait 到点注入「等待结束(有/无新消息)」标记**进 reply 上下文，而不只是重排 turn。
