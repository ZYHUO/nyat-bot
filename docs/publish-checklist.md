# Publish checklist — 离开本机的三件事，每件 5 分钟

这些我一样都做不了（会离开本机），所以写成分步清单。
每件都标了**批准后你要点什么**，以及**做完怎么验证真的生效**。

---

## ① 挂 GitHub Pages（最高杠杆，5 分钟）

页已经在仓库里了：`website/index.html`，单文件、零依赖、8 个站内相对链接
（已用 `tests/unit/docs/landing-page-links.test.ts` 验过解析得到）。

**点这些：**

```
github.com/ZYHUO/nyat-bot → Settings → Pages
  Source:        Deploy from a branch
  Branch:        nyatos        ← 不是 main（main 落后 425 个 commit）
  Folder:        /website
  Save
```

等 30-60 秒，然后访问：

```
https://zyhuo.github.io/nyat-bot/
```

**验证生效：** 页面能打开，且页尾的 `Docs` / `Code tour` / `Voice tuning` 三个链接
点得进去（它们指向 `../docs/...`，Pages 会 serving 整个分支所以能跳）。

**如果 404：** 九成是 Branch 选了 `main`。`website/` 只在我推的 `nyatos` 上。

**做完之后：** README 首屏和落地页本身都该把那个 URL 挂上——
现在两处都只有相对链接，外面点不到。那是下一轮的事（你回复 URL 我就加）。

---

## ② 发一帖（HN / Reddit / X）

需要你选一个地方发。我写文案，你审，你发。

**Reddit 的三个版，按匹配度排：**

| 版 | 为什么匹配 | 注意 |
|---|---|---|
| r/selfhosted | 它跑在自己机器上、数据不出门、有 install 脚本 | 先看该版规则，多数要 account karma |
| r/LocalLLaMA | provider 池可换、本地 ONNX embedding | 版内对"套壳"敏感，**别用 marketing 语气** |
| r/telegram | 平台直接相关 | 流量小但精准 |

**HN 的标题是关键**（Show HN）。三个备选，我推荐第一个：

```
Show HN: NyatBot – a Telegram group agent that decides when to stay silent
Show HN: NyatBot – group-chat agent where silence is a first-class decision
Show HN: I built a Telegram bot that only speaks 12% of the time, on purpose
```

HN 的规矩：标题里别用形容词，别用 "AI-powered"，正文第一段就说它做什么、
和别的有什么不同，第二段贴 `npm run demo` 的输出。

**要防的一件事：** 评论区第一个问题几乎一定是"它能干过 ChatGPT 吗"。
诚实答案是不比——它的卖点是**它决定不说话**，不是答得更好。
`docs/voice-tuning.md` 里那份实测（包括没生效的改动）是最好的回答材料。

---

## ③ 往 awesome-list 投 PR

现成的列表（需要你确认后我去提，或者你自己提）：

- `awesome-telegram-bots`
- `awesome-ai-agents`
- `awesome-selfhosted`

**每条 PR 的内容：** 一行 + 一句话描述，指向仓库根。
不要贴功能清单——列表维护者烦那个。一句话：

> A Telegram group-chat agent that participates rather than responds: per-chat
> cognition turns, silence as a logged decision, behavioural anti-ad with
> group-owner opt-in.

**语气**：MIT、164k 行 TypeScript、生产在跑 24 个群——这些是事实，可以写；
"revolutionary" 之类一个都不要。

---

## 三件都做完之后

star 会动。**但在它动之前，先量一次基线**：

```bash
npm run measure:voice:compare -- 2026-09-22 2026-09-23
```

载荷差 >25% 的时候它自己会说不许下结论——那时候别读数的變化当成效。
