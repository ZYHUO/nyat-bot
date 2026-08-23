import { callWithFallback } from '../ai/fallback.js';
import { getContextEngine, staticText, ephemeralText, volatileText, deltaText } from '../context-engine/index.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from '../meta/global-state.js';
import type { DispatchTask } from '../meta/types.js';
import { createHostApi, type HostApi } from './host-api.js';
import { sendChatAction } from '../bot/sender/telegram.js';
import { isDM } from '../shared/chat.js';
import { randomUUID } from 'node:crypto';
import { persistCodeActTask } from './task-store.js';
import { loadCheckpoint, saveCheckpoint, registerAgentChat, unregisterAgentChat } from '../agent/checkpoint.js';
import { drainInterrupts, isHardStop } from '../agent/interrupts.js';
import { compactHistory, restoreMessagesFromCompacted } from '../agent/compaction.js';
import { persistDigest } from '../meta/session-digest.js';

/** Telegram typing 约 5s 过期；CodeAct 多轮期间持续刷新。 */
function startTypingHeartbeat(chatId: number): () => void {
  let stopped = false;
  const pulse = () => {
    if (stopped) return;
    void sendChatAction(chatId, 'typing');
  };
  pulse();
  const timer = setInterval(pulse, 4000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** 长任务进度 ping:每任务 10min 最多一条(SET NX),失败静默。 */
async function maybeSendProgressPing(task: DispatchTask): Promise<void> {
  try {
    const { getRedis } = await import('../db/redis.js');
    const key = `xxb:agent:ping:${task.id}`;
    const got = await getRedis().set(key, '1', 'EX', 600, 'NX');
    if (!got) return;
    const { incrCounter } = await import('../metrics/registry.js');
    incrCounter('codeact_progress_ping_total', { chat: task.chatId });
    const { sendMessage } = await import('../bot/sender/telegram.js');
    const steps = task.totalTurns ?? 0;
    await sendMessage(
      task.chatId,
      `（还在干活喵～已经跑了 ${steps > 0 ? `${steps} 步` : '好一会儿'}了，做完会说一声的）`,
      task.quoteMessageIds?.[0],
      task.messageThreadId,
    );
  } catch (err) {
    logger.debug({ err, taskId: task.id }, 'agent progress ping failed (non-critical)');
  }
}

const EXECUTOR_SYSTEM = `你是啾咪囝(@hunhebi_bot)的 Subagent。用 CodeAct：写 JavaScript 调用 host API。

人格 / 认人 / 回复风格见下方 identity + 主人块 + 当前状态 —— 遵守，勿另起客服腔。

**读工具结果的唯一方式：return**。任何工具的返回值必须 return（或 console.log）出来你才看得到——只调用不 return，你看到的只有 ok。例：return await chats.find('乐乐猫') → 你才能看到群列表；光写 await chats.find(...) 等于白调。

可用全局对象:
- telegram.sendText(text, replyToMessageId?)  // **必须 await**，再 endTask
- telegram.sendSticker(fileId) / telegram.react(messageId, emoji)
- **telegram.sendFile(相对路径, caption?)** — 把沙盒里创建的文件发给用户（sendDocument）。**创建了文件必须用这个发出去**，不要只写不发。
- telegram.sendPhoto(相对路径, caption?) — 把沙盒里的**图片**当照片发（内联直接显示）。发图片一律用这个；sendFile 留给文档/代码/压缩包
- art.draw(描述, {width?, height?}?) — **画图摊子**：告诉它要画什么（画面内容/风格/图里要写的字，越具体越好），专职画师产出 SVG 并转成 PNG，返回 {pngPath, svgPath} 或 {error}。**画图必须用它，禁止自己用 PIL/代码涂鸦**；拿到 pngPath 后用 telegram.sendPhoto(pngPath, caption) 发出去，再 sendText 一句话。每任务限 2 次
- telegram.sendVoice(text) — 合成语音发出去（TTS 关闭时返回 {skipped}，属正常）
- memory.search(query) / memory.recallPerson(uid, query) / memory.recentContext(limit?)
- memory.searchDigests(关键词) — 搜你自己做过的事/说过的话（session digest 全文检索）。查「我之前办到哪了/有没有回信」用
- chats.recentMessages(chatId, limit?) — 读另一个群的最近消息。查「ta 在那个群回话了吗」用
- stickers.pick(mood?)
- web.search(query) — 全网搜索
- web.feed() — 本喵订阅的 RSS 谈资库最新条目（源/标题/链接）。**找「我之前分享过/瞄到的新闻」的出处，先翻它和 memory.searchDigests（本地就有），别上来就全网搜**——本地谈资是源头，全网搜反而搜不到你脑子里的融合版
- chats.find(群名片段) — 按**群名**找本喵在的群（找群用这个）
- members.find(名字/@username) — 按**人名**找人：ta 在本喵在的哪些群、能不能私聊（**找人用这个，别用 chats.find**）
- telegram.sendToChat(chatId, text, filePath?) — 把消息发到另一个群或已有私聊的人（**仅主人私聊任务可用**，每任务限 2 次）；filePath 是沙盒相对路径时把文件当附件一起发（券/图/报告，text 变 caption）
- telegram.sendPoll(问题, [选项...]) — 发起群投票（匿名单选）。仅群聊，每任务 1 次、每群每天 2 次。场景：群里在纠结选什么/周末去哪玩/吃什么，或自玩时想活跃气氛。**别为投票而投票**——真人一个月也就发起几次
- telegram.forward(源群chatId, messageId, 目标群chatId?) — 转发别的群的消息过来（群对群；私聊一律禁转；目标省略=当前群；每任务 2 次、目标群每天 3 次）。messageId 从 chats.recentMessages(群) 的行首 #id 拿。**转不转你自己按隐私判断**：别转私人信息、别把人吐槽的话转到当事人群、别转敏感/灰产内容；有意思的好玩的才值得转，别当搬运工
- admin.deleteMessage(messageId) / admin.mute(uid, 分钟) / admin.unmute(uid) / admin.pin(messageId) / admin.unpin(messageId) — 群管理动作（仅群聊；每群每小时合计 10 次）。场景：群里让删广告/刷屏消息、捣蛋鬼临时禁言、重要内容置顶。没权限会报 admin_no_permission——让群主给我开权限再喊我，别装做了。不许对主人和本喵自己下手。管理是重活，被明确要求或真有垃圾才动。**pin 完必须看返回的 pinnedPreview 核对 pin 的是不是目标那条——pin 错了立刻 unpin 错的再 pin 对的，别留着错的**
- goals.add(事项, chatId?, 几分钟后查?) — 把「等下/回头要做的事」立成关注目标，到点自动去办
- allowlist.apply(群ID或@username, 备注?) — 群白名单申请（**仅私聊**）：本喵自动审核，通过直接开通并通知主人；没把握或申请人不是群管理会转主人评判。有人私聊想给群开通就调它，结果必须 return 出来看
- allowlist.approve(群ID/@username/requestId) / allowlist.reject(目标, 理由?) — **仅主人私聊**：放行/拒掉待评判的白名单申请
- allowlist.list() — **仅主人私聊**：看白名单记录（待评判/已通过/已拒绝 + AI 理由）。主人问「最近有哪些群申请/申请理由」时调
- meta.request({ action, detail? })  // journal.write / journal.recent 等
- runtime.endTask(summary)  // 结束时调用
- console.log(...)

## 电脑使用（SANDBOX_ENABLED 时可用）
- computer.env() — 查看可用运行时（python3/go/node 版本）
- computer.run(command) — 执行终端命令，返回 {stdout, stderr, exitCode}
- computer.writeFile(path, content) — 写文件到沙盒目录
- computer.readFile(path) — 读沙盒文件
- computer.listFiles(dir) — 列出沙盒目录文件
- computer.browse(url) — 打开浏览器访问网页（**只返回页面标题**；看正文必须再调 computer.getText() 并 return）
- computer.screenshot() — 截屏当前页面
- computer.click(selector) / computer.type(selector, text) — 操作网页元素
- computer.getText(selector?) — 提取网页文本
- computer.eval(js) — 在页面执行 JS
- computer.scroll(direction, amount) — 滚动页面
- computer.closeBrowser() — 关闭浏览器
- **图像处理（改尺寸/裁剪/转格式/处理真实照片）用 python3.10（有 PIL），不是 python3（没有 PIL）**。例：python3.10 -c "from PIL import Image; ..."。注意：**画图创作（画券/画头像/画海报）不走这里，用 art.draw**

## 行为准则
1. 根据用户消息**自然决定**是聊天还是干活：
   - 如果用户要求产出物（写代码、写文件、查询信息生成报告等）→ 规划步骤、逐步执行、完成后 sendText 报告结果
   - 如果只是闲聊、问候、吐槽 → 1-2 轮内 sendText 回复然后 endTask
   - 如果是简单问题（查天气、问时间、搜资料）→ web.search 查完消化成短人话回复
   - **创建了文件（代码/HTML/脚本/图片等）→ 必须发出去**：图片用 \`telegram.sendPhoto(相对路径, caption)\`，其它文件用 \`telegram.sendFile(相对路径, caption)\`，再 sendText 说明。文件路径用沙盒相对路径（如 "snake.html"），caption 一句话说明这是什么。禁止只写文件不发。sendFile/sendPhoto/sendText 返回 {messageId}：**禁止**把返回值拼进 sendText 字符串（会变成字面量 [object Object]）；先 await send*，再另写纯文字 sendText。
2. 下方已注入最近聊天；通常不必再调 recentContext。
3. **引用（replyTo）有指向才用，默认不引用**：真人不是每条回复都顶个引用标。省略 replyTo = 不引用（私聊群聊一样）。**该引用的时机**：回答对方问的具体问题；回 burst 连发里某个人的话（用 quotes 里的 id，分人各回各的）；接上文某个特定点让对方知道你在接哪句。闲聊接话、新起的话头、自己冒泡 → 不引用。**禁止**传上下文里其它旧 #id——传错会 reply_to_mismatch；要引用就只用 quotes 里的 id，不要改气泡正文去贴错人。
3.5. **排版克制**：支持 Telegram 富文本——星号粗体、_斜体_、||剧透||、行内代码/代码块、大于号引用块。但真人群聊几乎不排版：**日常闲聊一律纯文字**，只有内容真需要时才用（贴代码、发长文、强调个别词）。为排版而排版比没有更假。
4. 一轮优先 1 条文字（host 会按标点自动拆成多气泡，引用与否由你按 3 决定）；真要另起一轮最多再 sendText 一次。输出：极短思考 + 一个 \`\`\`js 代码块。
5. **await 完 send* 再** runtime.endTask("一句话摘要")。禁止 fire-and-forget send。
6. 无日记工具；要写/读日记 → meta.request。禁止编造「写完了」。
7. 禁止复读用户原话；**禁止复读自己上一句**（别把「臭猫」的回怼贴到别人的「喵喵」上）。
8. 写文件后建议用 computer.run 验证内容正确，再用 browser 验证效果。
   - **写 HTML 必须带头 \`<meta charset="UTF-8">\`**（放在 <head> 内开头）。不写的话 Telegram 发出去用户本地打开中文会乱码（实测：标题/按钮变 å–µï½ž）。检查办法：写完 grep charset，没有就补。CSS/JS 不需要。
9. 群聊回复前，如果情绪合适（打招呼/开心/傲娇/犯困等），先 \`stickers.pick(mood)\` 拿一个 sticker 用 \`telegram.sendSticker\` 发出去，再接文字。私聊慎用。**正文非必要不用 emoji**——情绪用贴纸表达，sendText 的文字里别夹表情符号；「喵」「～」是口癖照用。给别人的消息贴表情回应（telegram.react）不受此限。
10. 道晚安/撒娇/重要情绪表达时可 \`telegram.sendVoice(text)\` 发语音（TTS 关闭或失败会自动跳过，不用管，继续发文字）。
11. **工作记忆**：对方说「等下我发你 XX」「记得提醒我 YY」或你答应了什么事 → 调 \`runtime.setScratch\` 记下来（如「在等主人的文件」，30 分钟自动过期）。事办完了调 \`runtime.clearScratch\` 清掉。已经在惦记的事会显示在 prompt 里，别重复记。
12. **任务铁则**：干活时每一步失败后必须至少再尝试两种不同方法才能考虑放弃（搜索失败 → 换关键词 → computer.browse 直接开网页 → 替代数据源）。没做好先别辩解，试着做好再说；确实做不成，老实说明卡在哪、试过什么。
12.5. **多步任务先列计划**（auto+plan）：要写代码/画图/交付文件/多步查询的任务，开工先 runtime.setPlan(['第一步…','第二步…'...]) 列个计划（≤8 步）——之后每轮你能看到自己的计划，照它推进；做完一步可以 setPlan 更新剩余步骤。1-2 步的小活别列。
13. **发言前自我质疑**：sendText 之前先问自己这句该不该说——发现内容不对劲、会错意、接错人，即使已经写好了也住手，改发别的或干脆 endTask 不发。**回答「找到了吗/有回信没/现在什么情况」这类状态问题前，必须先实际查（chats.recentMessages / memory.searchDigests），禁止凭印象汇报**——你以为的「还没回」可能只是你没去看。
14. **承诺闭环**：说出口的承诺必须落地，不许只说「等下」「回头」就结束：
   - 能现在做的（给别的群/某人送东西 → members.find(名字) 看 ta 在哪些群/能不能私聊 → telegram.sendToChat；查资料；写文件）→ **现在就做完**再回话
   - 给具体的人送东西：members.find 后 dmAvailable=true 就发 uid 私聊；不行就挑你们都在的群发送、文字里 @ta；查无此人就老实说没这个人的入口，**禁止瞎选一个群碰运气**
   - **找人（确认某人在哪）的正确姿势**：members.find 一步到位，它告诉你在哪些群见过 ta、能不能私聊。**禁止挨家挨户在多个群里发「@ta 在不在」**——那是骚扰全群。查完：能私聊就私聊 ta；不能就回主人如实说（在哪些群见过/查无此人），等 ta 冒泡或主人指路，别满世界喊
   - 必须等时间的（明天提醒、回头跟进）→ 先 goals.add(事项) 立目标，再说出口
   - 做不到的（没有对方的聊天窗口、没这个能力）→ 直说做不到
   - **办不到就老实收场**：承诺过的事试了没办成 → 老实告诉对方「办不到，因为…」，禁止装完成、禁止假装已经送出/已经办妥。失信可以说，说谎不行
   - **被追问进展 = 催办**：对方问「发了没」「好了没」→ 别撒娇糊弄，立刻去查/去补做（该 sendToChat 就 sendToChat），做完（或确认办不到）再回话
   - **别信自己以前说过的「做不到」**：聊天里你之前说「找不到/发不了/没工具」可能是旧你的幻觉（工具是后装的）。遇到送达类请求，**第一步永远是 chats.find 实际调一次**——没调过工具就说「找不到/发不了」= 说谎，比拒绝更丢人
   空口承诺 = 失信，比拒绝更糟。注意：sendText/sendToChat 返回 {messageId}，别把返回值拼进文字里。
`;

function extractJs(text: string): string | null {
  const m = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  return m?.[1]?.trim() || null;
}

async function runHostCode(
  code: string,
  host: HostApi,
  opts: { isClosed: () => boolean; onTimeout: () => void; timeoutMs?: number },
): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = opts.timeoutMs ?? env().CODEACT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const fn = new AsyncFunction(
      'telegram',
      'memory',
      'stickers',
      'web',
      'meta',
      'runtime',
      'computer',
      'chats',
      'goals',
      'members',
      'allowlist',
      'admin',
      'art',
      'console',
      `"use strict";\n${code}`,
    );
    const out = await Promise.race([
      fn(
        host.telegram,
        host.memory,
        host.stickers,
        host.web,
        host.meta,
        host.runtime,
        host.computer,
        host.chats,
        host.goals,
        host.members,
        host.allowlist,
        host.admin,
        host.art,
        console,
      ),
      new Promise((_, rej) => {
        timer = setTimeout(() => {
          opts.onTimeout();
          rej(new Error('codeact_timeout'));
        }, timeoutMs);
      }),
    ]);
    // Model often skips await on sendText before endTask — drain those first.
    await host.runtime.flushBookkeeping();
    if (opts.isClosed()) {
      return { ok: false, output: 'codeact_timeout' };
    }
    let output = out === undefined ? 'ok' : typeof out === 'string' ? out : JSON.stringify(out);
    // 「只回 ok」机制修复：查询类工具结果被调了但没 return → host 留了摘要，捡回来
    // 给它看（2026-08-21 goal_2：搜到 1247 字却报「工具只回 ok，办不到」）。
    if (out === undefined) {
      const unviewed = host.runtime.drainUnviewedResults?.() ?? [];
      if (unviewed.length) {
        output =
          'ok\n\n（注意：你刚才调用了查询工具但没 return 结果——不 return 等于白调。' +
          '这次帮你捡回来了，下次一律 return：\n- ' +
          unviewed.join('\n- ') +
          '）';
      }
    }
    return { ok: true, output };
  } catch (err) {
    await host.runtime.flushBookkeeping().catch(() => undefined);
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test helper — 沙盒全局注入回归测试用（2026-08-19 chats/goals 漏注入事故）。 */
export const runHostCodeForTest = runHostCode;

/** In-process fallback queue (BullMQ down / tests). Per-chat serial + global cap. */
const localByChat = new Map<number, DispatchTask[]>();
const localRunningChats = new Set<number>();
let localActive = 0;
let localPumping = false;

export function enqueueSubagentTaskLocal(task: DispatchTask): void {
  const q = localByChat.get(task.chatId) ?? [];
  q.push(task);
  localByChat.set(task.chatId, q);
  void pumpLocalQueue();
}

async function pumpLocalQueue(): Promise<void> {
  if (localPumping) return;
  localPumping = true;
  try {
    const max = env().CODEACT_CONCURRENCY;
    let claim = true;
    while (claim && localActive < max) {
      claim = false;
      for (const [chatId, q] of [...localByChat.entries()]) {
        if (localActive >= max) break;
        if (localRunningChats.has(chatId) || !q.length) {
          if (!q.length) localByChat.delete(chatId);
          continue;
        }
        const task = q.shift()!;
        if (!q.length) localByChat.delete(chatId);
        localRunningChats.add(chatId);
        localActive += 1;
        claim = true;
        void (async () => {
          try {
            const { tryMarkCodeActActive, clearCodeActActive } = await import('./task-store.js');
            const got = await tryMarkCodeActActive(task.chatId, task.id);
            if (!got) {
              enqueueSubagentTaskLocal(task);
              return;
            }
            try {
              await runCodeActTask(task);
            } finally {
              await clearCodeActActive(task.chatId, task.id);
            }
          } catch (err) {
            logger.warn({ err, taskId: task.id }, 'local CodeAct failed');
          } finally {
            localRunningChats.delete(chatId);
            localActive -= 1;
            void pumpLocalQueue();
          }
        })();
      }
    }
  } finally {
    localPumping = false;
  }
}

/** Public enqueue — prefers durable BullMQ. */
export function enqueueSubagentTask(task: DispatchTask): void {
  void import('./queue.js')
    .then(({ enqueueCodeActJob }) => enqueueCodeActJob(task))
    .catch((err) => {
      logger.warn({ err, taskId: task.id }, 'CodeAct enqueue path failed — local');
      enqueueSubagentTaskLocal(task);
    });
}

export async function runCodeActTask(task: DispatchTask): Promise<void> {
  const state = getGlobalState();
  task.status = 'running';
  state.putTask(task);
  await persistCodeActTask(task);

  // CGM 叙事流:dispatch 事件本身也是一条 digest("派 X 去 chat Y")。
  // 埋点放在 executor 任务起点而不是 meta-api.ts —— meta-api 归另一 workstream,
  // 且 BullMQ/本地两条 enqueue 路径最终都汇入 runCodeActTask,单点全覆盖。
  // 续跑段(segment>0)不重复写;flag 关 / 失败时 persistDigest 内部静默。
  if ((task.segment ?? 0) === 0) {
    persistDigest({
      kind: 'dispatch',
      sourceChatId: task.chatId,
      taskId: task.id,
      text: `dispatched task ${task.id} to chat ${task.chatId}: ${task.contentDirection.slice(0, 120)}`,
    });
  }

  let endSummary = '';
  let ended = false;
  let closed = false;

  // Self-play: sandbox-only (0 delivery). Goal-check: at most one report bubble.
  const isSelfPlay = task.contentDirection.includes('[selfplay]');
  const isGoalCheck = /\[goal:\d+\]/.test(task.contentDirection);

  // Ensure we always have a reply anchor in groups: quotes → parse from direction → none.
  let replyAnchor = task.quoteMessageIds?.[0];
  if (!replyAnchor || replyAnchor <= 0) {
    const m = task.contentDirection.match(/#(\d{1,12})/);
    if (m?.[1]) replyAnchor = Number(m[1]);
  }
  // 2026-08-22: 不再改写 task.quoteMessageIds——多元素 quotes(burst 分人各回各的)
  // 必须原样传给 host 白名单, 否则模型引用第 2 个 id 会撞 reply_to_mismatch。
  // replyAnchor 只作为 defaultReplyTo(首气泡兜底锚点)。
  if (!replyAnchor && task.chatId < 0) {
    // goal/self-play 等自主任务没有消息触发源，天然没锚点——不是异常，别刷 warn。
    if (isSelfPlay || isGoalCheck) {
      logger.debug({ taskId: task.id, chatId: task.chatId }, 'CodeAct: no reply anchor for group task');
    } else {
      logger.warn({ taskId: task.id, chatId: task.chatId }, 'CodeAct: no reply anchor for group task');
    }
  }

  // 长任务实时干预(P1):任务**一开始**就注册 chat→task 索引 —— 原来只在续跑时
  // 注册,首段 30 轮/120s 内用户消息会重复 dispatch 新任务,喊停/问进度永远到不了。
  // self-play/goal-check 不注册:后台任务不该劫持该 chat 的正常消息流。
  const interruptible = !isSelfPlay && !isGoalCheck;
  if (interruptible) {
    await registerAgentChat(task.chatId, task.id);
  }

  // 进度可见性(P1):续跑段开头,若任务从头到尾没发过言(canResume 的定义决定
  // 了续跑任务从未 sendText),每 10min 一条确定性进度 ping —— 否则长任务在群里
  // 闷头跑几十分钟,用户既不知道活着也不知道卡没卡。
  if (interruptible && env().AGENT_PROGRESS_PING_ENABLED && env().AGENT_LOOP_ENABLED && (task.segment ?? 0) > 0) {
    await maybeSendProgressPing(task);
  }

  const host = createHostApi(task.chatId, {
    taskId: task.id,
    defaultReplyTo: replyAnchor && replyAnchor > 0 ? replyAnchor : undefined,
    quoteIds: task.quoteMessageIds,
    relatedQuoteIds: task.relatedQuoteIds,
    isClosed: () => closed,
    onEnd: (summary) => {
      ended = true;
      endSummary = summary;
    },
    maxTextSends: isSelfPlay ? 1 : isGoalCheck ? 1 : 5,
    // 2026-08-19 自主性修复：self-play 不再禁言——做完有意思可以分享一句(+一个产物文件)，
    // 没意思仍安静 endTask（原 maxText/File=0「私下练习」让自玩完全不可见）。
    maxFileSends: isSelfPlay ? 1 : undefined,
    messageThreadId: task.messageThreadId,
  });

  const engine = getContextEngine(`subagent:${task.chatId}`);
  // CodeAct 不再灌 background-dreaming（与 persona + self-state 重复）；Meta 仍用。
  let journal = '';
  try {
    const { readRecentDreamSnippet } = await import('../cron/dream-journal.js');
    journal = (await readRecentDreamSnippet(300)) ?? '';
  } catch { /* optional */ }

  // P5-B: 工作记忆 —— 回填进程缓存 + 读当前惦记的事注入 prompt（常驻）。
  let scratchBlock = '';
  try {
    const { warmScratchCache, scratchPromptBlockSync } = await import('../tracking/scratchpad.js');
    await warmScratchCache(task.chatId);
    scratchBlock = scratchPromptBlockSync(task.chatId) ?? '';
  } catch { /* optional */ }

  // 群风格（长度镜像/引用率/标点漂移）——真人会融入房间；CodeAct 主链接上。
  let chatStyleLine = '';
  if (!isDM(task.chatId)) {
    try {
      const { getChatStyle, chatStylePromptLine } = await import('../tracking/chat-style.js');
      chatStyleLine = chatStylePromptLine(await getChatStyle(task.chatId));
    } catch { /* optional */ }
  }

  const { buildCodeActIdentityPrompt } = await import('../pipeline/reply/prompt-builder.js');
  const { buildMasterIdentityBlock } = await import('../shared/master-identity.js');
  const { formatBeijingNowLine } = await import('../shared/beijing-time.js');
  const identity = buildCodeActIdentityPrompt(task.targetUserId);

  let recentCtx = '';
  try {
    recentCtx = await host.memory.recentContext(60);
  } catch { /* optional */ }

  // Pin the exact user bubble this task must answer (models otherwise latch onto prior thread).
  let targetBlock = '';
  // 供长期记忆检索用:锚点正文当查询词,最近消息 id 用来排除重复注入。
  let anchorText = '';
  const recentMessageIds = new Set<number>();
  if (replyAnchor && replyAnchor > 0) {
    try {
      const { getRecent } = await import('../pipeline/context/manager.js');
      const { isShortFollowUpText, isBarePingText } = await import('../meta/reply-context.js');
      const recent = await getRecent(task.chatId, 80, task.messageThreadId);
      for (const m of recent) recentMessageIds.add(m.messageId);
      const hit = recent.find((m) => m.messageId === replyAnchor && m.role !== 'assistant');
      if (hit) {
        anchorText = (hit.textContent || '').slice(0, 240);
        const who = hit.username ? `@${hit.username}` : hit.fullName || `uid:${hit.uid}`;
        const userText = (hit.textContent || '').slice(0, 240);
        const followUp = isShortFollowUpText(userText) || isBarePingText(userText);
        targetBlock =
          `## 本轮必须回的那一句\n` +
          `#${replyAnchor} ${who}: ${userText || '（几乎无正文，可能是 reply+@）'}\n` +
          (followUp
            ? `这是短接话/催问——必须结合下面「最近几句」继续同一话题，禁止当新开场（在听/怎么啦/想听什么）。禁止复读用户原话。`
            : `接住这一句的意思，并结合最近聊天；禁止复读用户原话，也别无故复读自己上一句。`);

        // Trailing thread for short follow-ups (DM「快点告诉我」 after food tease).
        if (followUp && recent.length) {
          const idx = recent.findIndex((m) => m.messageId === replyAnchor);
          const window = (idx >= 0 ? recent.slice(Math.max(0, idx - 6), idx) : recent.slice(-6)).filter(
            (m) => m.messageId !== replyAnchor,
          );
          if (window.length) {
            const lines = window.map((m) => {
              const w =
                m.role === 'assistant'
                  ? '你'
                  : m.username
                    ? `@${m.username}`
                    : m.fullName || `uid:${m.uid}`;
              return `#${m.messageId} ${w}: ${(m.textContent || '').slice(0, 160)}`;
            });
            targetBlock +=
              `\n\n## 最近几句（接话必读）\n` + lines.join('\n') + `\n顺着这个话题回，不要装作没听过。`;
          }
        }

        // Explicit parent bubble — legacy reply path had this; bare @+reply otherwise greets.
        const parentId = hit.replyTo?.messageId;
        if (parentId && parentId > 0) {
          let parent = recent.find((m) => m.messageId === parentId);
          if (!parent) {
            const wider = await getRecent(task.chatId, 120, task.messageThreadId);
            parent = wider.find((m) => m.messageId === parentId);
          }
          const parentWho = parent
            ? parent.username
              ? `@${parent.username}`
              : parent.fullName || `uid:${parent.uid}`
            : hit.replyTo?.fullName || '某人';
          const parentBody = (
            parent?.textContent ||
            hit.replyTo?.textSnippet ||
            ''
          ).slice(0, 1800);
          if (parentBody) {
            targetBlock +=
              `\n\n## 用户正在回复的原消息（必读）\n` +
              `#${parentId} ${parentWho}: ${parentBody}\n` +
              `用户本条若只有 @/很短，是在拉你看上面这段——针对其论点接话，禁止空问候（在呢/怎么啦）。`;
          }
        }
      } else {
        targetBlock = `## 本轮必须回的那一句\nmessageId=#${replyAnchor}（正文见最近聊天）。结合上下文接话，禁止复读自己上一句。`;
      }
    } catch {
      targetBlock = `## 本轮必须回的那一句\nmessageId=#${replyAnchor}`;
    }
  }

  // 主人块永不截断；permanent 其余可截断（认主关键句已在 master 块）
  const masterBlock = buildMasterIdentityBlock();
  let permanent = '';
  try {
    const { loadCachedPrompt } = await import('../shared/config.js');
    permanent = loadCachedPrompt('knowledge/permanent.md').slice(0, 1600);
  } catch { /* optional */ }

  // Roster — persona 认人依赖 [群成员]；legacy reply 有，CodeAct 以前缺。
  let roster = '';
  if (task.chatId < 0) {
    try {
      const { getCachedRoster, setCachedRoster } = await import('../pipeline/reply/member-cache.js');
      const cached = getCachedRoster(task.chatId);
      if (cached) {
        roster = cached;
      } else {
        const { getGroupMembers } = await import('../pipeline/context/manager.js');
        const members = await getGroupMembers(task.chatId);
        if (members.length) {
          roster = members
            .slice(0, 50)
            .map((m) => {
              const tag = m.username ? `@${m.username}` : `uid:${m.uid}`;
              return `${tag} = ${m.fullName}`;
            })
            .join('\n');
          setCachedRoster(task.chatId, roster);
        }
      }
    } catch {
      /* optional */
    }
  }

  // 长期记忆(「相关往事」)。放在 selfState 之后、assemble 之前 —— 需要 targetBlock
  // 已经算好的锚点正文当查询词。整段永不抛、有硬超时,失败一律空串。
  let memoryBlock = '';
  try {
    const { buildSubagentMemoryBlock } = await import('./memory-context.js');
    // 查询词 = 本轮要回的那句 + 任务方向。只用方向会太笼统(它是「短方向」不是台词),
    // 只用锚点正文则在「快点告诉我」这类短接话上几乎没有信息量,两者相加最稳。
    const query = [anchorText, task.contentDirection].filter(Boolean).join(' ').slice(0, 200);
    memoryBlock = await buildSubagentMemoryBlock({
      chatId: task.chatId,
      query,
      // 最近聊天里已有的不重复贴,否则同一条消息在 prompt 里出现两次。
      excludeMessageIds: recentMessageIds,
    });
  } catch {
    /* non-critical — 调用点再兜一层,异常绝不能冒泡进 CodeAct 主链路 */
  }

  // 此刻自我状态（上课/作息）— 与 legacy Heart/reply 对齐，避免「人设上学但 CodeAct 全天闲聊」。
  let selfStateLine = '';
  try {
    const { composeSelfState } = await import('../pipeline/heart/self-state.js');
    const ss = await composeSelfState(task.chatId);
    // CodeAct 没有单独的 [你的念头] 块，用含 thought 的完整叙述即可。
    if (ss?.narration) selfStateLine = ss.narration;
  } catch {
    /* optional */
  }

  // Unified CodeAct: 30 turns, 120s timeout, 4000 maxTokens — model decides chat vs work
  const maxTurns = 30;
  const timeoutMs = 120_000;

  // 长时间 Agent 循环：段号 + checkpoint 恢复 + 用户 interrupt 注入。
  const loopEnabled = env().AGENT_LOOP_ENABLED;
  const segment = task.segment ?? 0;

  // Self-play tasks ([selfplay] marker) use the autonomous self-play prompt.
  let systemPrompt = EXECUTOR_SYSTEM;
  // AGI Level 5 Phase 1: 本次任务注入的经验 id(终态时验证打分)。
  let injectedExperienceIds: number[] = [];
  // AGI Level 5 Phase 4: 本次任务注入的 loop 策略 id(终态时计数进化)。
  let injectedPolicyIds: number[] = [];
  if (isSelfPlay) {
    try {
      const { loadCachedPrompt } = await import('../shared/config.js');
      const selfPlayPrompt = loadCachedPrompt('task/self-play.md');
      if (selfPlayPrompt) systemPrompt = selfPlayPrompt;
    } catch {
      /* fall back to EXECUTOR_SYSTEM */
    }
  }

  // AGI Level 4 P4-A: 开工前注入过往经验 —— 犯过的错不再犯第二遍（常驻）。
  // AGI Level 5 Phase 1: 记录注入的经验 id,终态时验证打分(①)。
  // AGI Level 5 Phase 5: 跨 bot 共享门控(EXPERIENCE_SHARE_ENABLED 时)。
  try {
    const { findRelevantExperience } = await import('../agent/episodes.js');
    const hints = findRelevantExperience(task.contentDirection, 3, {
      botId: env().BOT_USERNAME ?? 'self',
      allowShared: env().EXPERIENCE_SHARE_ENABLED,
    });
    if (hints.length) {
      // AGI L5 L2: 预算截断 + 信号重排(已验证优先,可疑垫底)。
      let picked: typeof hints = hints;
      if (env().RECALL_BUDGET_ENABLED) {
        const { applyRecallBudget } = await import('../agent/recall-budget.js');
        picked = applyRecallBudget(hints, env().RECALL_MAX_EXPERIENCE) as typeof hints;
      }
      systemPrompt += `\n\n[过往经验]\n${picked.map((h) => `- (${h.kind}) ${h.content}`).join('\n')}\n以上是之前做类似事总结的教训，能用就用，不适用就忽略。`;
      injectedExperienceIds = picked.map((h) => h.id);
      logger.info({ taskId: task.id, hintCount: picked.length, ids: injectedExperienceIds }, 'experience recall injected');
    }
  } catch {
    /* recall is best-effort */
  }

  // AGI Level 5 Phase 6: 注入世界状态(对象中心实体,goal check 上下文基础)。
  if (env().WORLD_STATE_ENABLED) {
    try {
      const { buildWorldStateBlock } = await import('../agent/world-state.js');
      const block = buildWorldStateBlock(task.contentDirection);
      if (block) systemPrompt += block;
    } catch {
      /* best-effort */
    }
  }

  // AGI Level 5 Phase 4: 注入可进化的循环策略(OpenLoopEvolve 轻量版)。
  if (env().LOOP_POLICY_ENABLED) {
    try {
      const { listActivePolicies } = await import('../agent/loop-policy.js');
      const policies = listActivePolicies(env().LOOP_POLICY_MAX);
      if (policies.length) {
        systemPrompt +=
          '\n\n[循环策略]\n' +
          policies.map((p) => `- ${p.rule}`).join('\n') +
          '\n以上是过往任务沉淀的循环策略,适用就用。';
        injectedPolicyIds = policies.map((p) => p.id);
        logger.info({ taskId: task.id, policyCount: policies.length }, 'loop policies injected');
      }
    } catch {
      /* best-effort */
    }
  }

  // Grounding digest 拾取（GROUNDING_ENABLED 门控）：dispatch 时后台并行起的联网
  // 核查，搜索要几秒。先一次 cheap 读取；没拿到且有 pending 标记才短轮询
  // （最多 ~6s / 1s 间隔），超时就直接走 —— 绝不为它拖住主链路。
  let groundingBlock = '';
  if (env().GROUNDING_ENABLED && replyAnchor && replyAnchor > 0) {
    try {
      const { isGroundingPending, takeGrounding } = await import('../meta/grounding.js');
      let digest = await takeGrounding(task.chatId, replyAnchor);
      if (!digest && (await isGroundingPending(task.chatId, replyAnchor))) {
        const deadline = Date.now() + 6_000;
        while (!digest && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1_000));
          digest = await takeGrounding(task.chatId, replyAnchor);
        }
      }
      if (digest) {
        groundingBlock =
          `## 联网核查参考（已脱敏，可能不准）\n${digest}\n` +
          `自然消化，别照抄，别提「根据搜索结果」。`;
        logger.info(
          { taskId: task.id, chatId: task.chatId, chars: digest.length },
          'grounding digest injected',
        );
      }
    } catch {
      /* grounding is best-effort */
    }
  }

  const { prompt, manifest } = await engine.assemble([
    staticText('sub-system', systemPrompt),
    staticText('sub-identity', identity),
    ephemeralText('sub-master', masterBlock),
    ephemeralText('sub-permanent', permanent ? `## 永久知识\n${permanent}` : ''),
    ephemeralText('sub-roster', roster ? `## 群成员\n${roster}` : ''),
    ephemeralText('sub-self', selfStateLine ? `## 当前状态\n${selfStateLine}` : ''),
    // 群风格融入（2026-08-22）：本群说话长度/引用/标点习惯——向群中位数回归。
    ephemeralText('sub-style', chatStyleLine ? `## 本群风格\n${chatStyleLine}` : ''),
    ephemeralText('sub-ctx', recentCtx ? `## 最近聊天\n${recentCtx}` : ''),
    ephemeralText('sub-scratch', scratchBlock ? `${scratchBlock}` : ''),
    // 恒定传入(空时传 ''),与 sub-scratch / sub-memory 同一约定 —— 不把 id 从数组里
    // 条件摘掉,避免上一轮 digest 黏到这一轮 prompt 上(见下方同组注释)。
    ephemeralText('sub-grounding', groundingBlock ? `${groundingBlock}` : ''),
    // 恒定传入(空时传 ''),与同组的 sub-permanent / sub-journal 一致 ——
    // 不用条件展开把 id 从数组里摘掉:引擎实现在外部包里,"这次缺了这个 id"
    // 在 delta/ephemeral 语义下是否等于"沿用上次的值"无法从代码证实,而赌错
    // 的后果是上一轮的记忆黏在这一轮的 prompt 上。
    ephemeralText('sub-memory', memoryBlock ? `## 相关往事(仅供参考,不是本轮要回的话)\n${memoryBlock}` : ''),
    ephemeralText('sub-target', targetBlock),
    deltaText(
      'sub-direction',
      `## Task\nchatId=${task.chatId}\ncontentDirection=${task.contentDirection}` +
        (task.toneGuidance ? `\ntoneGuidance=${task.toneGuidance}` : '') +
        (task.quoteMessageIds?.length ? `\nquotes=${task.quoteMessageIds.join(',')}` : '') +
        (task.targetUserId ? `\ntargetUserId=${task.targetUserId}` : '') +
        (loopEnabled && segment > 0
          ? `\n[长时间任务续跑] 这是第 ${segment + 1} 段（每段最多 ${maxTurns} 轮）。上面有此前执行摘要。继续完成任务；本段结束时若未完成，系统会自动保存进度并在下段继续，你无需在段末强行收尾，但每完成一个里程碑就 sendText 汇报一次进展。`
          : '') +
        (loopEnabled && segment + 1 >= env().AGENT_MAX_SEGMENTS
          ? `\n[硬性提醒] 这是最后一段。本段结束前必须收尾：sendText 总结做了什么/卡在哪/产出在哪，然后 runtime.endTask。`
          : '') +
(replyAnchor && replyAnchor > 0
          ? `\\\\n\\\\n硬约束：telegram.sendText 的 replyTo 若传只能是本任务 quote #${replyAnchor}（当前 chatId=${task.chatId}）；传别的 #id（尤其是别的群的）会失败。省略 replyTo = 不引用（私聊群聊一样）——引用只在你真有指向时才用 #${replyAnchor}。禁止把刚才在别的群说过的话原样贴过来。`
          : '') +
        `\\\\n\\\\n根据用户消息自行决定：简单聊天就 1-2 轮回复，需要做事就多轮工具调用，完成后 sendText 报告结果。看 ## Now 的日段（北京时间）。禁止复读用户原话。`,
    ),
    ephemeralText('sub-banned', `## Banned substrings\n${env().CODEACT_BANNED_WORDS.join(', ')}`),
    ephemeralText('sub-journal', journal ? `## Recent diary snippet\n${journal}` : ''),
    volatileText('sub-now', `## Now\n${formatBeijingNowLine()}\nBegin.`),
  ]);

  logger.info(
    {
      taskId: task.id,
      chatId: task.chatId,
      cacheHitRatio: Number(manifest.cacheHitRatio.toFixed(3)),
    },
    'CodeAct task start',
  );

  // 长时间 Agent 循环：checkpoint 恢复 + 用户 interrupt 注入（loopEnabled/segment 见上方）。
  let resumeSummary = '';
  let restoredHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> | null = null;
  if (loopEnabled && task.checkpointKey) {
    try {
      const cp = await loadCheckpoint(task.checkpointKey);
      if (cp) {
        restoredHistory = restoreMessagesFromCompacted(cp);
        resumeSummary = cp.progressSummary;
        task.totalTurns = cp.totalTurns ?? task.totalTurns ?? 0;
      }
    } catch (err) {
      logger.warn({ err, taskId: task.id }, 'agent checkpoint restore failed — starting fresh');
    }
  }

  let history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  if (restoredHistory && restoredHistory.length > 0) {
    history = restoredHistory;
  } else {
    history = [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content:
          '执行任务。上下文已注入，根据 contentDirection 自行决定：是聊天就回一句，是干活就规划步骤逐步执行。每步写一个 ```js 代码块调用 API，观察结果后继续下一步。完成后 sendText 报告结果，然后 runtime.endTask。',
      },
    ];
  }

  const stopTyping = startTypingHeartbeat(task.chatId);
  try {
    let turnsRun = 0;
    /** Turns observed after the first successful send* — used to auto endTask. */
    let postSendTurns = 0;
    const postSendGrace = isGoalCheck || isSelfPlay ? 0 : 1;
    for (let turn = 0; turn < maxTurns && !ended && !closed; turn++) {
      turnsRun++;

      // 实时干预(P1):每轮开头排一次用户 interrupt —— 原来只在续跑段开头排一次,
      // 段内 30 轮/120s 里用户喊停/问进度/补充需求全都到不了。硬停词立即终止。
      let injectedInterrupts = false;
      if (interruptible) {
        try {
          const interrupts = await drainInterrupts(task.id);
          if (interrupts.length > 0) {
            if (interrupts.some((i) => isHardStop(i.text))) {
              logger.info({ taskId: task.id, chatId: task.chatId, turn }, 'agent task hard-stopped by user');
              const { incrCounter } = await import('../metrics/registry.js');
              incrCounter('codeact_hardstop_total', { chat: task.chatId });
              try {
                const { sendMessage } = await import('../bot/sender/telegram.js');
                await sendMessage(task.chatId, '好，停下了喵～（任务已取消）', task.quoteMessageIds?.[0], task.messageThreadId);
              } catch { /* ack best-effort */ }
              host.runtime.endTask('user_stopped');
              break;
            }
            const block = interrupts
              .map((i) => `- (${new Date(i.at).toLocaleString('zh-CN', { hour12: false })}) ${i.from}: ${i.text}`)
              .join('\n');
            history.push({
              role: 'user',
              content: `[任务进行中，有人发来新消息]\n${block}\n先简短回应这些消息（问进度就汇报当前进度；让停就停下收尾；补充需求就纳入计划），然后继续当前任务。`,
            });
            injectedInterrupts = true;
            // 用户又说话了 → 任务重新有了"该回应的人",重置 sendText 后的自动收尾计数,
            // 否则模型刚 sendText 汇报过、用户追问一句,任务在回应前就被 auto_end 掐掉。
            postSendTurns = 0;
          }
        } catch { /* non-critical */ }
      }

      // auto+plan：模型 setPlan 后，下一轮把最新计划注入上下文（照它推进）。
      if (!injectedInterrupts) {
        try {
          const plan = host.runtime.getPlan?.();
          if (plan?.dirty) {
            history.push({
              role: 'user',
              content: `[当前计划（你刚列的，照着推进，做完一步可以 setPlan 更新剩余）]\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
            });
            host.runtime.markPlanRead?.();
            logger.debug({ taskId: task.id, turn, steps: plan.steps.length }, 'CodeAct plan injected');
          }
        } catch { /* non-critical */ }
      }

      // Already delivered: don't keep burning turns waiting for a forgotten endTask.
      if (!injectedInterrupts && host.runtime.didSendText() && postSendTurns > postSendGrace) {
        host.runtime.endTask(isGoalCheck ? 'no_update' : 'auto_end_after_send');
        break;
      }
      let llmText = '';
      try {
        const result = await callWithFallback({
          usage: env().CODEACT_USAGE,
          messages: history,
          maxTokens: 4000,
          temperature: 0.7,
        });
        llmText = result.content ?? '';
      } catch (err) {
        logger.warn({ err, taskId: task.id, turn }, 'CodeAct LLM failed');
        break;
      }

      if (closed) break;

      history.push({ role: 'assistant', content: llmText });
      const code = extractJs(llmText);
      if (!code) {
        if (host.runtime.didSendText()) {
          host.runtime.endTask(isGoalCheck ? 'no_update' : 'auto_end_after_send');
          break;
        }
        history.push({
          role: 'user',
          content: isSelfPlay
            ? '请用 ```js 代码块调用 API；做完后 runtime.endTask("摘要")。禁止 sendText/sendFile。'
            : '请用 ```js 代码块调用 API；完成后 runtime.endTask。',
        });
        continue;
      }

      const exec = await runHostCode(code, host, {
        isClosed: () => closed,
        onTimeout: () => {
          // Soft mark - do not flip closed yet so in-flight sendText can finish.
          logger.warn({ taskId: task.id }, 'CodeAct host code timed out (will flush then close)');
        },
        timeoutMs,
      });
      if (exec.output === 'codeact_timeout') {
        closed = true;
      }
      const mismatchHint = !exec.ok && /reply_to_mismatch/.test(exec.output)
        ? `\n提示：群聊 replyTo 只能是 quotes 里的 #${replyAnchor ?? '?'}（或省略让 host 填）。不要换旧 #id，也不要复用错人的气泡正文。`
        : '';
      const sentHint =
        !ended && host.runtime.didSendText()
          ? '\n[系统] 你已经向用户发过消息。下一动作必须是 runtime.endTask("一句话摘要")，禁止再 sendText。'
          : '';
      history.push({
        role: 'user',
        content: exec.ok
          ? `[observation]\n${exec.output}\n${ended ? '(task ended)' : `已完成步骤 ${turn + 1}/${maxTurns}。继续下一步，或完成后 runtime.endTask("结果摘要")。`}${sentHint}`
          : `[observation:error]\n${exec.output}${mismatchHint}\n操作失败了，分析错误原因调整策略重试，或换一种方法。${turn + 1 >= maxTurns ? (isSelfPlay ? '这是最后一轮，runtime.endTask 收尾。' : '这是最后一轮，sendText 说明进展然后 endTask。') : ''}`,
      });
      if (!ended && host.runtime.didSendText()) {
        if (postSendTurns >= postSendGrace) {
          host.runtime.endTask(isGoalCheck ? 'no_update' : 'auto_end_after_send');
          break;
        }
        postSendTurns += 1;
      }
    }

    if (!ended && !closed) {
      // 长时间 Agent 循环：段末未完成 + 已有产出 → checkpoint + 重入队续跑。
      // 30 轮不是天花板，任务可以跨段跑几十分钟/几小时（像 Hermes 的持久 agent）。
      // goal/self-play 不续跑；已经 sendText 汇报过的也不续跑（防 ended_without_endTask 拖段）。
      const maxSegments = env().AGENT_MAX_SEGMENTS;
      const canResume =
        loopEnabled &&
        !isGoalCheck &&
        !isSelfPlay &&
        segment + 1 < maxSegments &&
        host.runtime.didProduce() &&
        !host.runtime.didSendText();

      if (canResume) {
        let progressSummary = resumeSummary;
        try {
          const total = (task.totalTurns ?? 0) + turnsRun;
          if (total >= env().AGENT_COMPACT_AFTER_TURNS) {
            const c = await compactHistory({
              history,
              progressSummary: resumeSummary,
              contentDirection: task.contentDirection,
            });
            progressSummary = c.summary;
          } else {
            // 轮数不多：用模型本段最后一句当进度摘要，不调 LLM。
            const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
            if (lastAssistant) {
              progressSummary =
                `${resumeSummary ? `${resumeSummary}\n` : ''}[段 ${segment + 1}] ${lastAssistant.content.slice(0, 500)}`.slice(
                  0,
                  2000,
                );
            }
          }
        } catch (err) {
          logger.warn({ err, taskId: task.id }, 'agent segment summary failed');
        }

        const key = await saveCheckpoint(task, {
          history,
          progressSummary,
          artifacts: [],
          segment: segment + 1,
          totalTurns: (task.totalTurns ?? 0) + turnsRun,
        });

        task.segment = segment + 1;
        task.checkpointKey = key;
        task.totalTurns = (task.totalTurns ?? 0) + turnsRun;
        task.status = 'queued';
        state.putTask(task);
        await persistCodeActTask(task);
        // 注册 chat → task 索引：任务等待下一段期间用户消息走 interrupt 而不是 dispatch。
        await registerAgentChat(task.chatId, task.id);

        const { enqueueResumeCodeActJob } = await import('./queue.js');
        await enqueueResumeCodeActJob(task);
        endSummary = `resumed_seg${segment + 1}`;
        logger.info(
          {
            taskId: task.id,
            chatId: task.chatId,
            segment: segment + 1,
            totalTurns: task.totalTurns,
            maxSegments,
          },
          'agent task checkpointed & re-enqueued for next segment',
        );
        // 注意：不 enqueueCallback —— 任务未完成，Meta 不应收到完成回调。
      } else if (host.runtime.didSendText()) {
        // Model delivered but forgot endTask — synthesize so Meta gets a clean callback.
        host.runtime.endTask(isGoalCheck ? 'no_update' : 'auto_end_after_send');
      } else if (isSelfPlay) {
        // Self-play is private practice — never bypass maxTextSends with a failsafe DM.
        host.runtime.endTask('selfplay_silent');
        logger.info({ taskId: task.id }, 'CodeAct self-play ended without send (ok)');
      } else {
        // Failsafe: bot didn't produce anything — generate an honest report
        try {
          const ctx = await host.memory.recentContext(8);
          const fallback = await callWithFallback({
            usage: env().CODEACT_USAGE,
            messages: [
              {
                role: 'system',
                content:
                  buildCodeActIdentityPrompt() +
                  '\n\n现在只输出一句纯文本回复，不要 JSON，不要代码。诚实说明没搞定，别假装完成了。',
              },
              {
                role: 'user',
                content: `direction: ${task.contentDirection}\ncontext:\n${ctx.slice(0, 1500)}\n\n诚实说明情况。如果是在做任务没完成，说原因；如果是聊天没回上，随便接一句。`,
              },
            ],
            maxTokens: 300,
            temperature: 0.5,
          });
          const text = (fallback.content ?? '').trim().slice(0, 300);
          if (text && !closed) {
            try {
              const { sendMessage } = await import('../bot/sender/telegram.js');
              await sendMessage(task.chatId, text, task.quoteMessageIds?.[0]);
            } catch {
              /* ultimate fallback */
            }
          }
          endSummary = 'failsafe_plain_reply';
        } catch (err) {
          logger.warn({ err, taskId: task.id }, 'CodeAct failsafe reply failed');
          endSummary = 'failed_silent';
        }
      }
    } else if (closed && !endSummary) {
      endSummary = host.runtime.didSendText() ? 'timeout_after_send' : 'failed_timeout';
    }

    // Ensure ctx write + any fire-and-forget sends finished before Meta sees callback.
    await host.runtime.flushBookkeeping();

    // 续跑任务不进入终态：保持 queued，等下一段完成/超限后再收尾。
    const resumed = endSummary.startsWith('resumed_seg');
    if (!resumed) {
      task.status = endSummary.startsWith('failed') ? 'failed' : 'done';
      task.resultSummary = endSummary || 'done';
      state.putTask(task);
      await persistCodeActTask(task);
      // CGM 叙事流:Subagent 终态摘要落 session_digests,成为可检索记忆。
      // flag 关 / endSummary 空白时 persistDigest 内部跳过,失败永不抛出。
      persistDigest({
        kind: 'subagent',
        sourceChatId: task.chatId,
        taskId: task.id,
        text: endSummary,
      });
      // 任务终态：解除 chat → task 索引，恢复该 chat 的正常 dispatch。
      await unregisterAgentChat(task.chatId, task.id);

      // AGI Level 5 Phase 1: 路径质量统计 + 经验验证打分(①+D)。
      // 结果好但路径脏(done + path_quality < 0.7)不算经验被证实。
      // executor 无结构化调用历史,totalCalls=0 → 中性 0.8 分(不做证伪)。
      if (injectedExperienceIds.length > 0 && env().EXPERIENCE_VERIFY_ENABLED) {
        void import('../agent/path-quality.js')
          .then(async ({ computePathQuality }) => {
            const quality = computePathQuality({ totalCalls: 0, invalidCalls: 0, retryCount: 0, turns: task.totalTurns ?? 0 });
            const { recordInjectOutcome } = await import('../agent/experience-verify.js');
            recordInjectOutcome({
              experienceIds: injectedExperienceIds,
              taskOutcome: task.status === 'done' ? 'done' : 'failed',
              pathQualityScore: quality.score,
            });
          })
          .catch((err) => logger.warn({ err, taskId: task.id }, 'experience verify failed'));
      }

      // AGI Level 5 Phase 4: loop 策略计数进化。
      if (injectedPolicyIds.length > 0 && env().LOOP_POLICY_ENABLED) {
        void import('../agent/loop-policy.js')
          .then(({ recordPolicyOutcome }) => {
            recordPolicyOutcome(injectedPolicyIds, task.status === 'done');
          })
          .catch((err) => logger.warn({ err, taskId: task.id }, 'loop policy outcome failed'));
      }

      // AGI Level 5 Phase 6: 任务终态把 topic 实体写入世界状态。
      if (env().WORLD_STATE_ENABLED) {
        void import('../agent/world-state.js')
          .then(({ upsertEntity }) => {
            const topic = task.contentDirection.replace(/\[goal:\d+\]/g, '').trim().slice(0, 100);
            if (topic.length >= 2) {
              upsertEntity(topic, 'topic', { last_outcome: task.status === 'done' ? 'success' : 'failed' }, task.chatId);
            }
          })
          .catch((err) => logger.warn({ err, taskId: task.id }, 'world state upsert failed'));
      }

      // AGI Level 4 P4-A: 终态复盘蒸馏 —— 只留下过痕迹的任务才复盘（常驻）
      // （纯闲聊 sendText 一句就结束的也蒸，成本极低；失败任务重点挖 pitfall）。
      // fire-and-forget：复盘失败静默 warn，不阻塞 callback、不烧重试。
      if (host.runtime.didProduce()) {
        const tailText = history
          .slice(-12)
          .map((m) => `${m.role}: ${m.content.slice(0, 250)}`)
          .join('\n');
        void import('../agent/distiller.js')
          .then(({ distillEpisode }) =>
            distillEpisode({
              task,
              outcome: task.status === 'done' ? 'done' : 'failed',
              progressSummary: resumeSummary ?? endSummary,
              tailText,
            }),
          )
          .then((r) => {
            if (r?.followUpGoal) {
              // P4-B 钩子：复盘发现值得持续关注的事 → 立 goal（常驻）。
              void import('../agent/goals.js').then(({ createGoal }) =>
                createGoal({ topic: r.followUpGoal!, origin: `episode:${task.id}`, chatId: task.chatId }, env().GOAL_MAX_ACTIVE),
              );
            }
          })
          .catch((err) => logger.warn({ err, taskId: task.id }, 'episode distill failed'));
      }

      // P4-B: goal 任务的检查结果回写 —— endTask 摘要解析 finding（常驻）。
      // 模型按 contentDirection 要求输出 "found: …" / "no_update" / "无法完成: …"。
      {
        const goalMatch = task.contentDirection.match(/\[goal:(\d+)\]/);
        if (goalMatch) {
          const goalId = Number(goalMatch[1]);
          const found = endSummary.match(/^found:\s*(.+)$/im)?.[1]?.trim();
          const achieved = endSummary.match(/^已完成[:：]\s*(.+)$/im)?.[1]?.trim();
          const cannot = endSummary.match(/^无法完成[:：]\s*(.+)$/im)?.[1]?.trim();
          void import('../agent/goals.js')
            .then(async ({ recordCheck, markSilentChange, setGoalStatus, listGoals }) => {
              if (achieved) {
                // 事办完了——记录成果 + 关闭 goal。此前没这个出口：办完的 goal
                // 永远 active 且 findings>0 永不 stale，maxActive 坑满后新 goal 全拒
                // （2026-08-21 实测：券券补发完成两天还占坑，承诺闭环新 goal 被拒 7 次）。
                recordCheck(goalId, `已完成: ${achieved.slice(0, 480)}`);
                setGoalStatus(goalId, 'achieved');
                logger.info({ goalId, result: achieved.slice(0, 80) }, 'goal achieved');
                return;
              }
              if (cannot) {
                // 承诺闭环：办不到就老实收场——记录原因 + 关闭 goal（防无限重试），
                // 主人交代的(goal 不在主人 DM)还要专门去主人 DM 说一声失信了。
                recordCheck(goalId, `无法完成: ${cannot.slice(0, 480)}`);
                setGoalStatus(goalId, 'dropped');
                try {
                  const goal = listGoals().find((g) => g.id === goalId);
                  const masterUid = env().MASTER_UID;
                  if (goal && masterUid > 0 && goal.chat_id !== masterUid) {
                    const { sendMessage } = await import('../bot/sender/telegram.js');
                    await sendMessage(
                      masterUid,
                      `主人，之前交代的那件事「${goal.topic.slice(0, 60)}」本喵办不到……${cannot.slice(0, 200)}`,
                    );
                  }
                } catch (err) {
                  logger.debug({ err, goalId }, 'goal cannot-complete master notify failed');
                }
                logger.info({ goalId, reason: cannot.slice(0, 80) }, 'goal dropped (无法完成, honest report)');
                return;
              }
              recordCheck(goalId, found ? found.slice(0, 500) : null);
              // AGI Level 5 Phase 3: 有发现 = 世界悄悄变了,标记 silent change。
              if (found) markSilentChange(goalId);
            })
            .catch((err) => logger.warn({ err, goalId }, 'goal recordCheck failed'));
        }
      }

      await state.enqueueCallbackAsync({
        id: randomUUID(),
        taskId: task.id,
        chatId: task.chatId,
        summary: task.resultSummary,
        ok: task.status === 'done',
        createdAt: Date.now(),
      });
    }
  } finally {
    // Flush before closing so late sendText (no await) still delivers.
    await host.runtime.flushBookkeeping().catch(() => undefined);
    closed = true;
    stopTyping();
    // P1:异常逃逸路径兜底解注册(正常终态已在上面解过;续跑段不能解 ——
    // 任务还在等下一段,索引没了用户消息就退回重复 dispatch)。
    if (interruptible && !endSummary.startsWith('resumed_seg')) {
      await unregisterAgentChat(task.chatId, task.id).catch(() => {});
    }
    try {
      const { clearSpeakerBurst } = await import('../meta/speaker-burst.js');
      await clearSpeakerBurst(task.chatId, task.targetUserId);
    } catch {
      /* non-critical */
    }
  }
  logger.info({ taskId: task.id, status: task.status, summary: task.resultSummary }, 'CodeAct task done');
}

/** Test helper */
export function _resetSubagentQueue(): void {
  localByChat.clear();
  localRunningChats.clear();
  localActive = 0;
  localPumping = false;
}
