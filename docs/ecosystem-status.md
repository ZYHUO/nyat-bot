# Ecosystem status — 这个 goal 做出来的每一样东西

一张表，替掉"散在 50 个 commit message 里"。每样都在仓库里，
每样都跑过。**这张表本身也是一次验收**——下面"证据"列的号都能复现。

## 给陌生人的（降低理解成本）

| 东西 | 在哪 | 它解决什么 | 证据 |
|---|---|---|---|
| 落地页 | `website/index.html` | 10 秒看懂这是什么；含"诚实回答"段（把不利的数字也放上） | 8 节，6 个 og/twitter meta，相对链接全通、零孤岛 |
| `npm run demo` | `scripts/demo.mts` | **零凭据看到它怎么决定不说话** | 5 条测试锁住"真的演出一次未发送" |
| 代码导览 | `docs/code-tour.md` | 新人一小时走通一条消息的一生 | 六个文件按序，每步标了"回答的问题" |
| prompt 地图 | `prompts/README.md` | 25 个 task prompt 按"我想改什么行为"索引 | 每条给了加载它的代码 |
| Node 版本警告 | `README.md` Quick start | 新人第一道门（`better-sqlite3` 在 Node 24/26 上炸） | `engines` 写着 `<23` 但 npm 只警告 |

## 给想扩展的人的（生态）

| 东西 | 在哪 | 它解决什么 | 证据 |
|---|---|---|---|
| Skill 教程 | `docs/skills.md` | "一个 JSON 文件就是一个 skill" | 194 行，含 POST 模板和内置工具重叠说明 |
| 7 个可跑示例 | `skills/*.json` | 抄一个就能用；全免费、零配置 | live 测试真打通过（6 条） |
| POST 链路样板 | `skills/ECHO_BACK.json` | 仓库原来**没有一个能跑的 POST skill** | 回显 body 验证过 |
| `/help` 动态列 skill | `src/bot/handlers/help.ts` | **功能加了 16 轮，群里没人知道** | 真跑过，列出 7 个 |
| 行为报告模板 | `.github/ISSUE_TEMPLATE/behaviour.yml` | 这个仓库最该收到的反馈没有入口 | 7 个字段，含"该看的数是哪个" |

## 给想改行为的人的（可复现）

| 东西 | 在哪 | 它解决什么 | 证据 |
|---|---|---|---|
| 调校记录 | `docs/voice-tuning.md` | 试过什么、哪些没生效、为什么 | 含 5 次尝试的完整数字 |
| 操作手册 | 同上 | 拧哪个螺丝、代价是什么、按代价分 4 档 | 每档标了动的是判据还是机制 |
| `npm run measure:voice` | `scripts/measure-voice.mts` | 体感变数字 | 5 口径 + 6 层漏斗 + 编辑重放单列 |
| `npm run measure:voice:compare` | `scripts/voice-compare.mjs` | 两个时段能不能比 | 载荷差 >25% 禁结论；空窗口没得比 |
| `npm run voice:phase` | `scripts/voice-phase.mjs` | 现在该不该量 | 3 态退出码（0 可量/1 相不对/2 没样本） |
| cron 记账 | `scripts/voice-daily.sh` | 该量的那天有数 | 每天北京 23:00，幂等安装/卸载 |

## 社区基建

`CONTRIBUTING.md`（5 条规矩）· 4 个 issue 模板 · PR 模板 · Discussions

## 四个行为问题的状态

| 问题 | 状态 | 证据 |
|---|---|---|
| ② 不会用别的 bot 的指令 | ✅ 已修 | 撞名守卫；生产拦住两次真误代发（用户闲聊提"签到"→ 真去按 nmnmfunbot 的 /checkin） |
| ③ 重复回复 | ✅ 已修 | 最惨的锚点 5-6 次 → 2 次；全天重复率 1.9% |
| ④ 架构问题多 | ✅ 已修 | 同一个病 7 处全清；部署后 53 分钟 0 次截断（全天 952 次是修前的） |
| ① 太爱说话 | ⏳ 诊断完成，干预待拍板 | 真因是条/小时不是占比；回复率口径修正后早上 36.4%；host 侧上限在手册第 3 档（动立场，要批准） |

## 还没做到的

**Star 仍是 9。** 本机侧能做的都做了——`docs/publish-checklist.md` 里三件事
（挂 Pages / 发一帖 / 投 awesome-list）每件 5 分钟，都需要人批准。
