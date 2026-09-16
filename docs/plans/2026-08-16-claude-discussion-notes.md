# Claude 讨论内容整理 (2026-08-16, 链接 b3f435ec)
来源: claude.ai/share/b3f435ec-55ea-4f14-a70f-75ce595dc522
获取方式: socks2(82.108.198.149:1080) → 本地 http 转发(127.0.0.1:18080) → headless chrome 渲染

## 已入 plan(Phase 7-12, 已实现 ✅)
L1 原则级经验 / L2 Context rot / L3 LoSoNA / L4 ToM / L5 情绪惯性(已存在撤销) / L6 记忆陈旧

## 新发现方向(待用户拍板)

### A. Task 对象架构(最重磅, 建议 Phase 13)
- 用户痛点: bot 缺少长时间工作连续性, 只能给情绪价值, 搜索这种简单任务都难执行
- Claude 诊断: 根因是拓扑 —— 所有代码路径终点都是"发一条消息"。judge 问"要不要回复",
  不问"这条消息对我正在进行的事情意味着什么"。结构上只能是回复生成器
- 缺的对象: Task { id, owner, goal, state(pending|running|blocked|waiting_user|done),
  ledger(事实台账), progress(进度台账), next_wake(timestamp|trigger) }
- 方案: SQLite tasks 表 + BullMQ 独立 worker 队列(与消息处理隔离, 无延迟压力, 可跑 20 步)
  - 阶段1: tasks 表 + worker, 只支持"帮我查 X"→ 建 Task → "我去查" → 多轮搜索 → 主动发结果
  - 阶段2: judge L0 前置判断"消息是否关联活跃 Task"(补充信息→更新 ledger, 催促→报进度, 取消→终止)
  - 阶段3: next_wake 唤醒(定时/事件/条件)
  - 阶段4: 长任务(盯 GitHub issue, 每周总结, 追连载)
- 安全: 持久化 agent 是质变, prompt injection 变慢性中毒 → Task 创建权限收紧(只有 @ 的直接请求能建)
- 与 Phase 3(long-term goal)关系: goals 是"关注什么", Task 是"做什么", 可互相引用
- 与 harness 视角关系: 补上"执行与状态"两个空组件(observe/adjust 闭环)

### B. 反向阀门 L7(斯坦福研究, 有完整 plan)
- 元凶是"谄媚"不是"陪伴": 永远站在你这边 → 三周后用户向 AI 求助意愿≈亲友, 人际互动更费力
- Humanizer 方向放大风险: 训练更温暖更共情 → 更谄媚, 用户表达脆弱时放大; 反驳对话里谄媚率翻倍
- 别加"我只是个 AI"免责提示(可能有害)
- 落地:
  - 换核心指标: 连接率(消息后 5 分钟人-人对话轮数) 替代 engagement 指标
  - 群聊是结构性优势: 牵线(共同兴趣搭桥) / 共同回忆("一年前的今天") / 接话不抢话
  - 私聊分档风险打分: risk = w1·连续天数 + w2·深夜占比 + w3·单次时长 + w4·情绪词密度 + w5·(1-群内发言比例)
    中档: Humanizer 特效衰减(少撒娇少追问), 回复变短, 话题引向群里 —— 用户无感
    高档: 非评判式关心("你今天聊了挺多的, 最近整体感觉怎么样?")
  - 反谄媚审计: 每周抽 200 条回复按五维打分(情绪验证/道德背书/间接语言/间接行动/接受框架)
  - 优雅退出: 换模型前预告, 保留旧人格, 允许导出聊天记录
- 验收: 连接率上升 + 总互动量不崩

### C. 小模型智能增强(8B 计划, 独立方向)
- 核心事实: FLOPs 对齐下测试时计算让小模型超过大 14 倍模型; Llama-1B 超过 8B
- 白嫖延迟预算: Humanizer 已读延迟 3-8 秒 = 免费并行采样 16 次的时间
- 五个手段:
  1. Best-of-N + verifier(硬前提: 需要质量信号, 否则 best-of-N = 随机挑)
  2. 按难度分配算力(judge 天生是难度分类器: "早上好"→N=1, "分析代码"→N=16)
  3. Format Tax: 格式要求偷走智力(prompt 层格式指令压制逐步推理; Qwen 小模型 61.5%→100% 有效性但 19.7%→11% 准确率)
     → 生成层解耦格式, judge/工具调用层用约束解码(XGrammar-2)
  4. 约束解码用在该用的地方(纯分类任务)
  5. 让它不需要知道, 只需要会查(搜索 API/DB/Python 执行环境绕过知识局限)
- 用户反驳: 格式要求必须(Telegram MarkdownV2 会 400)
- Claude 回应: 格式不该在 prompt 解决, 是序列化问题属代码层:
  1. 默认不开 parse_mode(闲聊纯文本)
  2. 需要格式用 entities(offset+length+type, 绕开解析器) 或 HTML 白名单+确定性转义
  3. 兜底: send 失败自动降级(stripMarkup 纯文本重发)

### D. harness 视角(认知框架, 非功能)
- 定义: Agent = Model + Harness; harness = 所有不是模型本身的代码/配置/执行逻辑
- 用户系统 = 教科书级案例但只有一半: 感知表达极好(judge/humanizer), 执行和状态是空的
- 社交环境 harness 没人铺过路(编码 agent 环境确定可验证, 群聊环境观察模糊反馈延迟)
- 启发: 模型可插拔 / 失败当系统问题修(机制强制正确性而非靠语言请求) / guides vs sensors 分类法
