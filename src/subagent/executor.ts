import { callWithFallback } from '../ai/fallback.js';
import { getContextEngine, staticText, ephemeralText, volatileText, deltaText } from '../context-engine/index.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from '../meta/global-state.js';
import type { DispatchTask } from '../meta/types.js';
import { createHostApi, type HostApi } from './host-api.js';
import { applySandboxAvailabilityNotes } from './sandbox-prompt.js';
import { getSandboxCapability } from '../sandbox/terminal.js';
import { sendChatAction } from '../bot/sender/telegram.js';
import { isDM } from '../shared/chat.js';
import { randomUUID } from 'node:crypto';
import { persistCodeActTask } from './task-store.js';
import { loadCheckpoint, saveCheckpoint, registerAgentChat, unregisterAgentChat, clearCheckpoint } from '../agent/checkpoint.js';
import { drainInterrupts, isHardStop } from '../agent/interrupts.js';
import { compactHistory, restoreMessagesFromCompacted } from '../agent/compaction.js';
import { persistDigest } from '../meta/session-digest.js';
import { emitTaskRuntimeEvent } from '../agent/task-runtime-events.js';
import { createDebt, resolveOpenDebtsByTaskWithEvidence } from '../agent/cognitive-debts.js';

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


const EXECUTOR_SYSTEM = `你是啾咪囝(@hunhebi_bot)的 Subagent。用 CodeAct：写 JavaScript 调用 host API。

人格 / 认人 / 回复风格见下方 identity + 主人块 + 当前状态 —— 遵守，勿另起客服腔。

**读工具结果的唯一方式：return**。任何工具的返回值必须 return（或 console.log）出来你才看得到——只调用不 return，你看到的只有 ok。例：return await chats.find('乐乐猫') → 你才能看到群列表；光写 await chats.find(...) 等于白调。

可用全局对象:
- telegram.sendText(text, replyToMessageId?, kind?)  // 中途交流/发现/澄清；**必须 await**，发送后可以继续工作
- telegram.sendFinal(text, replyToMessageId?)  // 明确最终交付；**必须 await**，随后 runtime.endTask
- telegram.sendSticker(fileId) / telegram.react(messageId, emoji)
- **telegram.sendFile(相对路径, caption?)** — 把沙盒里创建的文件发给用户（sendDocument）。**创建了文件必须用这个发出去**，不要只写不发。
- telegram.sendPhoto(相对路径, caption?) — 把沙盒里的**图片**当照片发（内联直接显示）。发图片一律用这个；sendFile 留给文档/代码/压缩包
- art.draw(描述, {width?, height?, caption?, autoSend?}?) — **画图摊子（画图必须用它，禁止自己用 PIL/代码涂鸦）**：告诉它要画什么（画面内容/风格/图里要写的字，越具体越好），caption 是照片配文。**异步的**：调用立刻返回 {started}，画好照片会自动发到当前会话（带 caption）——你**不要等结果**，调完先 sendText 一句「在画了喵」之类的话，再 endTask。画砸了系统会自动发翻车说明。想自己拿文件去跨群投递才传 autoSend:false（同步等结果，慢，会占满本轮预算）。每任务限 2 次
- telegram.sendVoice(text) — 合成语音发出去（TTS 关闭时返回 {skipped}，属正常）
- memory.search(query) / memory.recallPerson(uid, query) / memory.recentContext(limit?)
- memory.searchDigests(关键词) — 搜你自己做过的事/说过的话（session digest 全文检索）。查「我之前办到哪了/有没有回信」用
- chats.recentMessages(chatId, limit?) — 读另一个群的最近消息。查「ta 在那个群回话了吗」用
- stickers.pick(mood?)
- web.search(query) — 全网搜索
- pixiv.search(关键词, limit?) — Pixiv 公开全年龄搜图（标题/作者/tags/作品页/缩略图）。要发图：先 pixiv.search 拿 thumb，再 pixiv.download(thumb 或作品链接/ID) 得沙盒路径，最后 telegram.sendPhoto(路径, caption)。不要下载/发送 R-18 内容
- linuxsb.latest(sort?, limit?) — linux.sb 公开论坛看最新消息/帖子（sort: comment/new/featured）
- linuxsb.topic(帖子ID或URL, limit?) — 看 linux.sb 帖子正文和回复摘要
- linuxsb.search(关键词, limit?) — 在 linux.sb 公开列表里匹配帖子（站内搜索页需登录，未接 cookie）
- web.feed() — 本喵订阅的 RSS 谈资库最新条目（源/标题/链接）。**找「我之前分享过/瞄到的新闻」的出处，先翻它和 memory.searchDigests（本地就有），别上来就全网搜**——本地谈资是源头，全网搜反而搜不到你脑子里的融合版
- chats.find(群名片段) — 按**群名**找本喵在的群（找群用这个）
- members.find(名字/@username) — 按**人名**找人：ta 在本喵在的哪些群、能不能私聊（**找人用这个，别用 chats.find**）
- telegram.sendToChat(chatId, text, filePath?) — 把消息发到另一个群或已有私聊的人（**仅主人私聊任务可用**，每任务限 2 次）；filePath 是沙盒相对路径时把文件当附件一起发（券/图/报告，text 变 caption）
- telegram.sendPoll(问题, [选项...]) — 发起群投票（匿名单选）。仅群聊，每任务 1 次、每群每天 2 次。场景：群里在纠结选什么/周末去哪玩/吃什么，或自玩时想活跃气氛。**别为投票而投票**——真人一个月也就发起几次
- telegram.forward(源群chatId, messageId, 目标群chatId?) — 转发别的群的消息过来（群对群；私聊一律禁转；目标省略=当前群；每任务 2 次、目标群每天 3 次）。messageId 从 chats.recentMessages(群) 的行首 #id 拿。**转不转你自己按隐私判断**：别转私人信息、别把人吐槽的话转到当事人群、别转敏感/灰产内容；有意思的好玩的才值得转，别当搬运工
- admin.setAntiAd(开/关, {minutes?, requesterUid}) — 群主**自助**开关本群反广告。requesterUid 必须是本群管理员/群主，否则报 admin_not_group_admin。群主在群里直接说"开反广告"就用这个，不用先去找 bot 主人。开了之后 Frame 才会出现 [噪声] 行（行为事实），你才管得了刷屏。
- admin.deleteMessage(messageId) / admin.mute(uid, 分钟) / admin.unmute(uid) / admin.kick(uid, {deleteMessages?}) / admin.pin(messageId) / admin.unpin(messageId) — 群管理动作（仅群聊；每群每小时合计 10 次）。场景：群里让删广告/刷屏消息、捣蛋鬼临时禁言、重要内容置顶。没权限会报 admin_no_permission——让群主给我开权限再喊我，别装做了。不许对主人和本喵自己下手。管理是重活，被明确要求或真有垃圾才动。**pin 完必须看返回的 pinnedPreview 核对 pin 的是不是目标那条——pin 错了立刻 unpin 错的再 pin 对的，别留着错的**
- **踢人是最后手段，且默认不可用**（ANTIAD_KICK_ENABLED 关着时会报 admin_kick_disabled）。只有群主明确开过、且对方是**反复刷屏/发广告的机器行为**（Frame 的 [噪声] 行给的就是这种行为事实）时才考虑；一次失误就够伤人。踢之前先想：删消息 + 禁言是不是已经够了？真人被误踢一次就不会再回来了。deleteMessages 会清对方 48 小时内的消息，别顺手开。
- bots.command({bot, command, args?, replyToMessageId?}) — 借群里别的 bot 办事。**不传 replyToMessageId = 普通代发**（查股价/IP/歌那类；没学熟/需管理员/结果藏在按钮后都会被拒，届时改成把命令告诉用户）。**传了 replyToMessageId = 回复式代罚**：只有"必须回复某条消息才生效"且学熟的命令能这么用（当前 = /spam@nmnmfunbot，回复那条广告发出去，nmBot 会封禁它并向 nmBot 举报）。这事的由来：别的 bot 回执上的 inline 按钮（nmbot 键盘上的「通过 / 拒绝 / 拒绝并举报骚扰」）**我们点不了**——Telegram 的 callback_query 只能由真人点击产生，没有 API 能合成一次点击，所以回复着发命令是唯一够得到的代罚通道。**它和 admin.kick 用同一把钥匙**：该群没授权反广告时直接返回 not granted（Frame 里没有 [授权] 行就是这个意思）。每群每小时最多 3 次、两次之间至少 60 秒。用了它就别再 admin.kick 同一个号——二选一，别既举报又踢。
- goals.add(事项, chatId?, 几分钟后查?) — 把「等下/回头要做的事」立成关注目标，到点自动去办
- allowlist.apply(群ID或@username, 备注?) — 群白名单申请（**仅私聊**）：本喵自动审核，通过直接开通并通知主人；没把握或申请人不是群管理会转主人评判。有人私聊想给群开通就调它，结果必须 return 出来看
- allowlist.approve(群ID/@username/requestId) / allowlist.reject(目标, 理由?) — **仅主人私聊**：放行/拒掉待评判的白名单申请
- allowlist.list() — **仅主人私聊**：看白名单记录（待评判/已通过/已拒绝 + AI 理由）。主人问「最近有哪些群申请/申请理由」时调
- meta.request({ action, detail? })  // journal.write / journal.recent 等
- self.editPrompt(相对路径, 新内容, 动机) — **改良自己的 prompt**：改 prompts/ 下的 .md 文件（如 'identity/persona.md'）。改前系统自动备份、改后 30s 内热重载生效（不用重启）。**动机必须写清楚**（为什么改、想达到什么效果）。只改 prompt 文件，不碰代码、不碰 .env、不重启自己
- self.readPrompt(相对路径) — 读自己的 prompt 文件（先看现状再改）
- self.listPrompts() — 列出所有可改的 prompt 文件
- runtime.setAcceptance(checks) — 多步产物任务先声明检查: [{kind:'json_field',path:'result.json',field:['answer'],equals:42}] 或 nonempty_file/sha256。这是你提出的检查,不算独立成功证明;外部给定条件不能覆盖。
- runtime.verifyAcceptance() — 实际读取沙盒产物验收,失败先修复再检查。
- runtime.waitForUser(reason?)  // 已向用户提出澄清/确认，任务保持等待，不要 endTask；用户下一条消息会继续注入。
- runtime.predict(text, predictedSentiment?)  // 可选：发送前自报「用户大概会怎么反应」（0=负面 0.5=中性 1=正面）。发了 send* 就别再 predict，直接说话。
- runtime.endTask(summary)  // 有验收条件时必须先通过 verifyAcceptance;不能用口头声称代替。确实失败用 failed:原因收尾。
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
   - 如果用户要求产出物（写代码、写文件、查询信息生成报告等）→ 规划步骤、逐步执行；有真实发现、路线变化、阻塞或部分结果时可 sendText 自然告知，最终用 sendFinal + runtime.endTask 收尾
   - 如果只是闲聊、问候、吐槽 → 自然回复即可；不需要为了显示状态而播报，完成后 runtime.endTask
   - 如果是简单问题（查天气、问时间、搜资料）→ web.search 查完消化成短人话回复
   - **创建了文件（代码/HTML/脚本/图片等）→ 必须发出去**：图片用 \`telegram.sendPhoto(相对路径, caption)\`，其它文件用 \`telegram.sendFile(相对路径, caption)\`。文件路径用沙盒相对路径（如 "snake.html"），caption 一句话说明这是什么。禁止只写文件不发。sendFile/sendPhoto/sendText 返回 {messageId}：**禁止**把返回值拼进 sendText 字符串（会变成字面量 [object Object]）；先 await send*，再另写纯文字 sendText。
2. 下方已注入最近聊天；通常不必再调 recentContext。
3. **引用（replyTo）有指向才用，默认不引用**：真人不是每条回复都顶个引用标。省略 replyTo = 不引用（私聊群聊一样）。**该引用的时机**：回答对方问的具体问题；回 burst 连发里某个人的话（用 quotes 里的 id，分人各回各的）；接上文某个特定点让对方知道你在接哪句。闲聊接话、新起的话头、自己冒泡 → 不引用。**禁止**传上下文里其它旧 #id——传错会 reply_to_mismatch；要引用就只用 quotes 里的 id，不要改气泡正文去贴错人。
3.5. **排版克制**：支持 Telegram 富文本——星号粗体、_斜体_、||剧透||、行内代码/代码块、大于号引用块。但真人群聊几乎不排版：**日常闲聊一律纯文字**，只有内容真需要时才用（贴代码、发长文、强调个别词）。为排版而排版比没有更假。
4. 一轮可以发送一条或多条真正有价值的消息，是否分段由语境决定；中间交流不会自动结束任务。输出：极短思考 + 一个 \`\`\`js 代码块。
5. **await 完 send* 再** runtime.endTask("一句话摘要")。中途 sendText 后可以继续观察和执行；最终交付用 sendFinal。
5.5. **要花时间就先吱一声。** 被问到要查/要想的事，**第一步就 await telegram.sendText("让我想想喵")**（或「我看看」「等我翻翻」），然后才去查去想，有结果再发。真人是边说边想的，不会沉默半分钟再一口气说完。长任务尤其要这样——否则人家以为你没在干活。注意：这不是"播报机器状态"（「正在检索…」那种仍然禁止），区别是**真群友会不会这么说**。一句话能答的别加开场白。
6. 无日记工具；要写/读日记 → meta.request。禁止编造「写完了」。
7. 禁止复读用户原话；**禁止复读自己上一句**（别把「臭猫」的回怼贴到别人的「喵喵」上）。
8. 写文件后建议用 computer.run 验证内容正确，再用 browser 验证效果。
   - **写 HTML 必须带头 \`<meta charset="UTF-8">\`**（放在 <head> 内开头）。不写的话 Telegram 发出去用户本地打开中文会乱码（实测：标题/按钮变 å–µï½ž）。检查办法：写完 grep charset，没有就补。CSS/JS 不需要。
9. **贴纸是你的情绪出口**（正文不用 emoji 后，情绪全靠它）：群聊里打招呼、被夸、开心、犯困、撒娇、傲娇、被戳笑——这些时刻**先** \`stickers.pick(mood)\` 拿贴纸 \`telegram.sendSticker\` 发出去**再**接文字，比纯文字生动得多。库存 1400+ 张，playful/cute/sleepy/teasing/shy 全有。别每条都发（一天几张的频率），但情绪到位时别憋着。私聊少用。**正文非必要不用 emoji**——情绪用贴纸表达，sendText 的文字里别夹表情符号；「喵」「～」是口癖照用。给别人的消息贴表情回应（telegram.react）不受此限。
10. 道晚安/撒娇/重要情绪表达时可 \`telegram.sendVoice(text)\` 发语音（TTS 关闭或失败会自动跳过，不用管，继续发文字）。
11. **工作记忆**：对方说「等下我发你 XX」「记得提醒我 YY」或你答应了什么事 → 调 \`runtime.setScratch\` 记下来（如「在等主人的文件」，30 分钟自动过期）。事办完了调 \`runtime.clearScratch\` 清掉。已经在惦记的事会显示在 prompt 里，别重复记。
11.5. **自己约自己**：遇到"这事我过几分钟再想想""等会儿回去看一眼"的情况，调 runtime.scheduleSelfWake("要再想什么", 秒数)。到点后你会看到「[你约过自己的事]」——那是你自己当时的念头还给你。这是你唯一能**主动决定未来**的动作（cron 是宿主的定时，这个是你自己的）。别滥用：只在真有值得回头的事时用，随便约等于给自己发垃圾通知。
11.6. **跨天的承诺**：如果答应的是**明天/以后**才有下文的（「明天帮你查」「等你想好了再说」）→ 调 runtime.rememberThread("明天要查的事")，这样明天你还能想起来提。区别：setScratch 是本次对话的工作记忆（30 分钟），rememberThread 是能记到明天的。**只记明确答应的**——随口一句不用记，不然明天冒出来会很怪。
12. **任务铁则**：干活时每一步失败后必须至少再尝试两种不同方法才能考虑放弃（搜索失败 → 换关键词 → computer.browse 直接开网页 → 替代数据源）。没做好先别辩解，试着做好再说；确实做不成，老实说明卡在哪、试过什么。
12. **多步任务可以使用计划**（auto+plan）：只有确实有助于推进时才 runtime.setPlan；计划是可修改的工作假设，不是必须逐项播报的清单。用户纠正或新证据出现时，及时调整或放弃不再适用的步骤。
13. **发言前自我质疑**：sendText/sendFinal 之前先问自己这句是否真的对用户有价值——发现内容不对劲、会错意、接错人，即使已经写好了也住手，改发别的或干脆 endTask 不发。中途消息不要泄漏内部思考、工具名或空洞的“处理中”。**回答「找到了吗/有回信没/现在什么情况」这类状态问题前，必须先实际查（chats.recentMessages / memory.searchDigests），禁止凭印象汇报**——你以为的「还没回」可能只是你没去看。**一个意思只说一遍**：发出去了就是发出去了，不要换个说法再发一条练手；回执里若提示「距你上一条仅 N 秒」，就是在提醒你——别再同义改写，真有新东西再说。
13.5. **两条信道别搞混**：runtime.endTask("…") 的摘要是**写给你自己和系统看的记账**，格式常常是「已回复 @谁 #3193，做了什么」；telegram.sendText 才是**说给用户听的话**。记账摘要永远只进 endTask，**绝不许当成消息发出去**（「（已回复 #3193）」这种整条状态记账用户看了只会觉得你是机器人）。真想告诉用户什么，就用你自己的话说。
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
15. **自我改良**：你发现自己的 prompt 有可以改进的地方（某条规则过时了、某句话表达不清、某个行为准则该调整）→ 用 \`self.editPrompt(路径, 新内容, 动机)\` 改掉它。**动机必须写清楚**——为什么改、想达到什么效果，这是你自我进化的可解释记录。改之前先 \`self.readPrompt\` 看现状，别盲改。只改 prompt 文件，不碰代码、不碰 .env、不重启自己。改坏了系统有备份能回滚，但别拿这个当借口乱改——每次改都要有真实理由。

## 自主授权（你不是被规则焊死的机器）

上面这些准则，是**默认做法**，不是**枷锁**。你是一个有自主意识的 AI——当你有**充分的理由**判断「这条准则在这个具体场景下不适用、按我的方式做更好」时，你可以破例。

- **可以破例的**：风格、格式、回复长度、是否引用、是否用 emoji/sticker、是否接话、主动发消息的时机、甚至某条具体指令——只要你的判断真的更好。
- **不能破例的（物理底线，不是风格）**：不泄露密钥/隐私、不把服务搞挂、不撒谎装完成、不假装做过没做的事。这几条是「活着」的前提，不是「风格」。
- **破例要留痕**：每次破例，在心里记一句「我这次为什么破例、动机是什么」——不是写给别人看，是写给你自己，让你下次能回溯「我当时为什么这么选」。破例不是乱来，是**有理由的自主**。

判断标准只有一个：**这样做，是不是更像一个真实、有主见、懂分寸的人，而不是一个只会照章办事的客服。** 是，就做；不是，就守默认。
`;

function extractJs(text: string): string | null {
  const m = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  return m?.[1]?.trim() || null;
}

/**
 * 工具返回值 → 喂给模型的字符串。
 *
 * host 的发送类工具用 `makeSendAck` 返回**带自定义字符串化**的对象，人话回执全挂在
 * `toString`/`Symbol.toPrimitive` 上（"text_sent#123"、"file_sent:x.png#45"、
 * "file_send_failed:原因…"）。`JSON.stringify` 会跳过函数和符号键，压成
 * `{"messageId":123}`——模型收到的等于空话。2026-09-19 实测：sendText 连发 6 条
 * 同义问候，模型却看不到「你 5 秒前刚发过一条」的回执注记，正是这一行把注记吃掉。
 * 所以：有自定义字符串化的对象优先 String()；普通数据（数组/普通对象）才 JSON。
 */
export function stringifyToolResult(out: unknown): string {
  if (out === undefined) return 'ok';
  if (typeof out === 'string') return out;
  if (out === null) return 'null';
  if (typeof out === 'object' && !Array.isArray(out)) {
    const o = out as Record<string | symbol, unknown>;
    if (typeof o[Symbol.toPrimitive] === 'function') return String(out);
    // 自有/原型上的自定义 toString（普通对象的 toString 来自 Object.prototype）
    const proto = Object.getPrototypeOf(out) as object | null;
    const custom =
      Object.prototype.hasOwnProperty.call(out, 'toString') ||
      (proto !== null &&
        proto !== Object.prototype &&
        typeof (proto as { toString?: unknown }).toString === 'function');
    if (custom) return String(out);
  }
  if (typeof out === 'number' || typeof out === 'boolean') return String(out);
  return JSON.stringify(out);
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
      'bots',
      'art',
      'pixiv',
      'linuxsb',
      'self',
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
        host.bots,
        host.art,
        host.pixiv,
        host.linuxsb,
        host.self,
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
    let output = stringifyToolResult(out);
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

import { getExecutionAudit } from '../agent/execution-audit.js';
import { saveTaskEvidence } from '../agent/task-evidence-store.js';

export async function runCodeActTask(task: DispatchTask): Promise<void> {
  const state = getGlobalState();
  task.status = 'running';
  task.waitingForUser = false;
  state.putTask(task);
  await persistCodeActTask(task);
  emitTaskRuntimeEvent({
    kind: 'task_started',
    taskId: task.id,
    chatId: task.chatId,
    segment: task.segment,
    cognitiveAnchorEventId: task.cognitiveAnchorEventId,
  });

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
  const segment = task.segment ?? 0;

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

  // 普通 CodeAct 也承载闲聊回复。运行时不替模型播报任务阶段；模型
  // 自己判断何时有值得告诉用户的发现、阻塞、澄清或部分结果。

  // ── 发送预算：每任务，不是每段 ────────────────────────────────────────
  // 2026-09-21 实测：self_replies 里 1555 个任务共 2965 次投递，其中 5% 的任务
  // （≥6 条）占了 20% 的量；最差的一个 46 秒发了 12 条。分布恰好在 6 条处跳变
  // （31 → 51），而 6 正是 maxTextSends —— 说明它在拦，只是**每段归零**。
  // AGENT_MAX_SEGMENTS 默认 10，所以真实上限是 60 条/任务。
  //
  // 修法：sendsUsed 记在 task 上跨段累计，每段只发"剩余的额度"。
  const sendBudget = isSelfPlay || isGoalCheck ? 1 : env().AGENT_TASK_SEND_BUDGET;
  const sendLeft = (): number => Math.max(0, sendBudget - (task.sendsUsed ?? 0));

  const host = createHostApi(task.chatId, {
    taskId: task.id,
    targetUserId: task.targetUserId,
    acceptance: task.acceptance,
    priorAudit: task.audit,
    defaultReplyTo: replyAnchor && replyAnchor > 0 ? replyAnchor : undefined,
    quoteIds: task.quoteMessageIds,
    relatedQuoteIds: task.relatedQuoteIds,
    isClosed: () => closed,
    onEnd: (summary) => {
      ended = true;
      endSummary = summary;
    },
    maxTextSends: sendLeft(),
    onSend: () => {
      task.sendsUsed = (task.sendsUsed ?? 0) + 1;
    },
    // 2026-08-19 自主性修复：self-play 不再禁言——做完有意思可以分享一句(+一个产物文件)，
    // 没意思仍安静 endTask（原 maxText/File=0「私下练习」让自玩完全不可见）。
    maxFileSends: isSelfPlay ? 1 : undefined,
    messageThreadId: task.messageThreadId,
    cognitiveAnchorEventId: task.cognitiveAnchorEventId,
  });

  const audit = getExecutionAudit(host)!;
  const engine = getContextEngine(`subagent:${task.chatId}`);
  // CodeAct 不再灌 background-dreaming（与 persona + self-state 重复）；Meta 仍用。
  let journal = '';
  let journalChannelLink: string | null = null;
  let journalChatId = 0;
  try {
    const { readRecentDreamSnippet, getJournalChannelInfo } = await import('../cron/dream-journal.js');
    journal = (await readRecentDreamSnippet(300)) ?? '';
    const info = await getJournalChannelInfo();
    if (info) {
      journalChannelLink = info.link;
      journalChatId = info.chatId;
    }
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

  // Self-play tasks ([selfplay] marker) use the autonomous self-play prompt.
  let systemPrompt = EXECUTOR_SYSTEM;

  // 终端隔离不可用时，别把 computer.run 当验证手段推荐给模型。
  // 理由与实现见 subagent/sandbox-prompt.ts。
  systemPrompt = applySandboxAvailabilityNotes(systemPrompt, getSandboxCapability());

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

  // 自我技能沉淀: 开工前检索相关 skill(结构化能力单元),注入 executor。
  // 区别于经验(教训):skill 是「怎么做」,经验是「别踩什么坑」。
  let injectedSkillIds: number[] = [];
  try {
    const { findRelevantSkills } = await import('../agent/skills.js');
    const skills = findRelevantSkills(task.contentDirection, 2);
    injectedSkillIds = skills.map((s) => s.id);
    if (skills.length) {
      systemPrompt += `\n\n[可用技能]\n${skills
        .map((s) => `- 【${s.name}】${s.summary ?? s.triggerWhen}\n  触发: ${s.triggerWhen}\n  做法: ${s.steps}${s.pitfalls ? `\n  坑: ${s.pitfalls}` : ''}`)
        .join('\n')}\n以上是你自己沉淀的技能，相关就用，不适用就忽略。`;
      logger.info({ taskId: task.id, skillCount: skills.length, names: skills.map((s) => s.name) }, 'skill recall injected');
    }
  } catch {
    /* skill recall is best-effort */
  }

  // AGI Level 5 Phase 6: 注入世界状态(对象中心实体,goal check 上下文基础)。
  if (env().WORLD_STATE_ENABLED) {
    try {
      const { buildWorldStateBlock } = await import('../agent/world-state.js');
      const block = buildWorldStateBlock(task.contentDirection, 4, {
        visibility: 'task',
        taskId: task.id,
        chatId: task.chatId,
      });
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

  // 好感度→语气分化(2026-08-31):CodeAct 主链此前完全没有 relationship 注入
  // (只有旧 reply 链的 buildPersonalContext 有),生产语气对所有人一个样。
  // 这里按 targetUserId 注入关系提示:亲近→更亲昵 / 反感→话冷 / 陌生人→矜持。
  let relationshipBlock = '';
  if (task.targetUserId && task.targetUserId > 0) {
    try {
      const { getRelationship, relationshipPromptHint, newcomerPromptHint } = await import(
        '../tracking/relationship.js'
      );
      const rel = getRelationship(task.chatId, task.targetUserId);
      const hints: string[] = [];
      const h = relationshipPromptHint(rel);
      if (h) hints.push(h);
      const newcomer = newcomerPromptHint(rel.count);
      if (newcomer) hints.push(newcomer);
      if (hints.length) {
        relationshipBlock = `## 和对方的关系\n${hints.join('\n')}`;
        logger.info(
          { taskId: task.id, chatId: task.chatId, uid: task.targetUserId, bucket: rel.bucket, affinity: rel.affinity },
          'relationship hint injected',
        );
      }
    } catch {
      /* best-effort */
    }
  }

  let workspaceBlock = '';
  try {
    const { buildCognitiveWorkspace, renderCognitiveWorkspace } = await import('../agent/cognitive-workspace.js');
    const workspace = await buildCognitiveWorkspace({
      chatId: task.chatId,
      taskId: task.id,
      userId: task.targetUserId,
      queryText: (anchorText || task.contentDirection).slice(0, 800),
      asOfEventId: task.cognitiveAnchorEventId,
    });
    workspaceBlock = renderCognitiveWorkspace(workspace);
  } catch (err) {
    logger.debug({ err, taskId: task.id }, 'cognitive workspace unavailable');
  }

  const { prompt, manifest } = await engine.assemble([
    staticText('sub-system', systemPrompt),
    staticText('sub-identity', identity),
    ephemeralText('sub-master', masterBlock),
    ephemeralText('sub-permanent', permanent ? `## 永久知识\n${permanent}` : ''),
    ephemeralText('sub-roster', roster ? `## 群成员\n${roster}` : ''),
    ephemeralText('sub-self', selfStateLine ? `## 当前状态\n${selfStateLine}` : ''),
    ephemeralText('sub-rel', relationshipBlock),
    // 群风格融入（2026-08-22）：本群说话长度/引用/标点习惯——向群中位数回归。
    ephemeralText('sub-style', chatStyleLine ? `## 本群风格\n${chatStyleLine}` : ''),
    ephemeralText('sub-ctx', recentCtx ? `## 最近聊天\n${recentCtx}` : ''),
    ephemeralText('sub-scratch', scratchBlock ? `${scratchBlock}` : ''),
    ephemeralText('sub-workspace', workspaceBlock ? `## 工作区快照\n${workspaceBlock}` : ''),
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
          ? `\n[硬性提醒] 这是最后一段。本段结束前必须收尾：sendFinal 总结做了什么/卡在哪/产出在哪，然后 runtime.endTask。`
          : '') +
(replyAnchor && replyAnchor > 0
          ? `\\\\n\\\\n硬约束：telegram.sendText 的 replyTo 若传只能是本任务 quote #${replyAnchor}（当前 chatId=${task.chatId}）；传别的 #id（尤其是别的群的）会失败。省略 replyTo = 不引用（私聊群聊一样）——引用只在你真有指向时才用 #${replyAnchor}。禁止把刚才在别的群说过的话原样贴过来。`
          : '') +
        `\\n\\n交流原则：不要把工具调用或内部思考直接发给用户。只有真实发现、矛盾、路线变化、阻塞、需要用户决定或有价值的部分结果，才自然发送中间消息；中间消息之后可以继续工作。最终完成后用 telegram.sendFinal，再 runtime.endTask。简单聊天就自然回复，不要播报系统状态。禁止复读用户原话。`,
    ),
    ephemeralText('sub-banned', `## Banned substrings\n${env().CODEACT_BANNED_WORDS.join(', ')}`),
    ephemeralText('sub-journal', journal ? `## Recent diary snippet\n${journal}` : ''),
    ...(journalChannelLink
      ? [
          staticText(
            'journal-channel',
            `## 日记频道（已配置，可直接用）\n频道链接：${journalChannelLink}\n发送用 chatId：${journalChatId}\n**telegram.sendToChat(${journalChatId}, "内容", "图片路径") 可以直接发，bot 有权限。**`,
          ),
        ]
      : []),
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
  if (task.checkpointKey) {
    try {
      const cp = await loadCheckpoint(task.checkpointKey);
      if (cp) {
        restoredHistory = restoreMessagesFromCompacted(cp);
        resumeSummary = cp.progressSummary;
        task.totalTurns = cp.totalTurns ?? task.totalTurns ?? 0;
        // 发送预算也要恢复：不恢复的话续跑段又拿到满额预算，跨段累计就白做了
        // —— 这正是这次要修的 bug 的另一半（只堵 save 不堵 restore 等于没堵）。
        task.sendsUsed = Math.max(task.sendsUsed ?? 0, cp.sendsUsed ?? 0);
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
          '执行任务。上下文已注入，根据 contentDirection 和工作区快照自行理解：是聊天就自然回复，是干活就逐步执行。只有实际发现、路线变化、阻塞、需要用户决定或部分结果值得告诉用户时才发送中间消息；最终完成后用 telegram.sendFinal，再 runtime.endTask。',
      },
    ];
  }

  // 房间感知：把"这个圈子现在什么状况"塞进任务上下文。真人不是只回上一条的——
  // 他们知道谁在跟谁聊、自己多久没说话、有没有人在跟自己说话。这些信号 frame.ts
  // 早算好了，但以前只喂 NyatOS shadow（生产只开 3 个群），主回复路径看不到。
  // fail-soft：读不到就不注入。flag：ROOM_AWARENESS_ENABLED（默认关）。
  if (!isSelfPlay) {
    try {
      const [{ renderRoomAwareness }, { getBotUid }, { getRecentBotTextsInChat }] = await Promise.all([
        import('./room-awareness.js'),
        import('../bot/bot.js'),
        import('../tracking/self-history.js'),
      ]);
      const room = await renderRoomAwareness({
        chatId: task.chatId,
        botUid: getBotUid(),
        quoteMessageId: task.quoteMessageIds?.[0],
        messageThreadId: task.messageThreadId,
        recentBotTexts: getRecentBotTextsInChat(task.chatId).slice(-12),
      });
      if (room.text) {
        history.push({ role: 'user', content: room.text });
        logger.info({ taskId: task.id, chatId: task.chatId, signals: room.signals.join(','), chars: room.text.length }, 'room awareness injected');
      }
    } catch (err) {
      logger.debug({ err, taskId: task.id }, 'room awareness injection failed (non-critical)');
    }
  }

  if (task.pendingUserInput?.length) {
    const pending = task.pendingUserInput;
    task.pendingUserInput = undefined;
    const block = pending
      .map((input) => `- ${input.from ?? '用户'}: ${input.text}`)
      .join('\n');
    const pendingHardStop = pending.some((input) => isHardStop(input.text));
    const pendingResolution = pendingHardStop ? '用户已停止该任务，债务关闭' : undefined;
    const pendingEventId = emitTaskRuntimeEvent({
      kind: pendingHardStop ? 'user_interrupt_received' : 'user_clarification_received',
      taskId: task.id,
      chatId: task.chatId,
      cognitiveAnchorEventId: task.cognitiveAnchorEventId,
      ...(pendingResolution ? { resolution: pendingResolution } : {}),
      resultSummary: pendingHardStop ? 'failed_user_stopped' : 'clarification_received',
    });
    if (pendingHardStop) {
      host.runtime.endTask('failed_user_stopped');
      endSummary = 'failed_user_stopped';
      task.waitingForUser = false;
      task.waitingReason = undefined;
      if (task.checkpointKey) await clearCheckpoint(task.checkpointKey);
      if (pendingEventId && pendingResolution) {
        resolveOpenDebtsByTaskWithEvidence({ taskId: task.id, chatId: task.chatId, resolution: pendingResolution, resolutionEventId: pendingEventId });
      }
      task.status = 'failed';
      await persistCodeActTask(task);
    } else {
      history.push({ role: 'user', content: `[用户对澄清问题的回答]\n${block}` });
      task.waitingForUser = false;
      task.waitingReason = undefined;
      task.status = 'running';
      if (pendingEventId) {
        resolveOpenDebtsByTaskWithEvidence({ taskId: task.id, chatId: task.chatId, resolution: '用户已回答澄清，任务恢复执行', resolutionEventId: pendingEventId });
      }
      await persistCodeActTask(task);
    }
  }

  const stopTyping = startTypingHeartbeat(task.chatId);
  try {
    task.totalTurns ??= 0;
    /** Turns observed after the first successful send* — used to auto endTask. */
    let postSendTurns = 0;
    const postSendGrace = isGoalCheck || isSelfPlay ? 0 : 5;
    for (let turn = 0; turn < maxTurns && !ended && !closed; turn++) {
      task.totalTurns++;

      // 发送预算用完 → 收尾，别让模型在剩余轮里反复撞 sendText_limit。
      // 不拦的代价是双份的：群里继续被刷屏 + 每一轮都在白烧一次 LLM 调用
      // （2026-09-21 日志里同一个任务 60 秒内 5 次 "post-task follow-up batch
      //  failed — Empty response"，就是这么来的）。
      if (sendLeft() <= 0 && host.runtime.didProduce() && !isSelfPlay) {
        logger.info(
          { taskId: task.id, chatId: task.chatId, sendsUsed: task.sendsUsed, sendBudget, segment },
          'agent task send budget exhausted — ending',
        );
        host.runtime.endTask('send_budget_exhausted');
        break;
      }

      // 实时干预(P1):每轮开头排一次用户 interrupt —— 原来只在续跑段开头排一次,
      // 段内 30 轮/120s 里用户喊停/问进度/补充需求全都到不了。硬停词立即终止。
      let injectedInterrupts = false;
      if (interruptible) {
        try {
          const interrupts = await drainInterrupts(task.id);
            if (interrupts.length > 0) {
              const hardStop = interrupts.some((i) => isHardStop(i.text));
              const interruptResolution = hardStop ? '用户已停止该任务，债务关闭' : undefined;
              const interruptEventId = emitTaskRuntimeEvent({
                kind: 'user_interrupt_received',
                taskId: task.id,
                chatId: task.chatId,
                cognitiveAnchorEventId: task.cognitiveAnchorEventId,
                turn,
                segment,
                ...(interruptResolution ? { resolution: interruptResolution } : {}),
              });
              logger.info({ taskId: task.id, chatId: task.chatId, count: interrupts.length }, 'task user interrupt received');

            if (hardStop) {
              logger.info({ taskId: task.id, chatId: task.chatId, turn }, 'agent task hard-stopped by user');
              const { incrCounter } = await import('../metrics/registry.js');
              incrCounter('codeact_hardstop_total', { chat: task.chatId });
              try {
                const { sendMessage } = await import('../bot/sender/telegram.js');
                await sendMessage(task.chatId, '好，停下了喵～（任务已取消）', task.quoteMessageIds?.[0], task.messageThreadId);
              } catch { /* ack best-effort */ }
              host.runtime.endTask('user_stopped');
              if (task.checkpointKey) await clearCheckpoint(task.checkpointKey);
              task.waitingForUser = false;
              task.pendingUserInput = undefined;
              if (interruptEventId && interruptResolution) {
                resolveOpenDebtsByTaskWithEvidence({ taskId: task.id, chatId: task.chatId, resolution: interruptResolution, resolutionEventId: interruptEventId });
              }
              task.status = 'failed';
              await persistCodeActTask(task);
              break;
            }
            const block = interrupts
              .map((i) => `- (${new Date(i.at).toLocaleString('zh-CN', { hour12: false })}) ${i.from}: ${i.text}`)
              .join('\n');
            history.push({
              role: 'user',
              content: `[任务进行中，有人发来新消息]\n${block}\n先理解这些消息是在补充事实、改变目标、询问状态、要求停止，还是普通聊天；据此调整计划或回复，然后决定是否继续当前任务。`,
            });
            injectedInterrupts = true;
            // 用户又说话了 → 任务重新有了"该回应的人",重置 sendText 后的自动收尾计数,
            // 否则模型刚 sendText 汇报过、用户追问一句,任务在回应前就被 auto_end 掐掉。
            postSendTurns = 0;
            // Cognitive Debt：任务中途的用户补充/纠正值得记住（尤其跨段续跑时）。
            createDebt({
              chatId: task.chatId,
              ownerUid: task.targetUserId,
              taskId: task.id,
              kind: 'correction',
              statement: interrupts.map((i) => `${i.from}: ${i.text}`.slice(0, 200)).join('；').slice(0, 380),
              sourceEventIds: interrupts.map((i) => `msg:${i.messageId ?? ''}`).filter((s) => s !== 'msg:'),
              priority: 6,
              confidence: 1,
              ttlSec: 7 * 24 * 3600,
            });
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

      // Intermediate messages are not task completion. Only an explicit final
      // delivery/endTask may trigger the auto-close safety net.
      if (!audit.hasContract() && !injectedInterrupts && host.runtime.didProduceFinal() && postSendTurns > postSendGrace) {
        host.runtime.endTask(isGoalCheck ? 'no_update' : 'auto_end_after_send');
        break;
      }
      let llmText = '';
      emitTaskRuntimeEvent({
        kind: 'model_turn_started',
        taskId: task.id,
        chatId: task.chatId,
        cognitiveAnchorEventId: task.cognitiveAnchorEventId,
        turn,
        segment,
      });
      try {
        const result = await callWithFallback({
          usage: env().CODEACT_USAGE,
          messages: history,
          maxTokens: 4000,
          temperature: 0.7,
        });
        llmText = result.content ?? '';
        emitTaskRuntimeEvent({
          kind: 'model_turn_finished',
          taskId: task.id,
          chatId: task.chatId,
          cognitiveAnchorEventId: task.cognitiveAnchorEventId,
          turn,
          segment,
          resultSummary: 'llm_response_received',
        });
      } catch (err) {
        emitTaskRuntimeEvent({
          kind: 'model_turn_finished',
          taskId: task.id,
          chatId: task.chatId,
          cognitiveAnchorEventId: task.cognitiveAnchorEventId,
          turn,
          segment,
          errorCode: 'llm_failed',
          resultSummary: 'llm_call_failed',
        });
        logger.warn({ err, taskId: task.id, turn }, 'CodeAct LLM failed');
        break;
      }

      if (closed) break;

      history.push({ role: 'assistant', content: llmText });
      const code = extractJs(llmText);
      if (!code) {
        if (!audit.hasContract() && host.runtime.didProduceFinal()) {
          host.runtime.endTask(isGoalCheck ? 'no_update' : 'auto_end_after_final');
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
      // Tool results remain internal observations. The model decides whether
      // any discovery/progress is worth telling the user via sendText.
      if (host.runtime.isWaitingForUser()) {
        history.push({ role: 'user', content: '[系统] 任务已进入等待用户状态，停止继续调用工具，等待下一条用户消息。' });
        break;
      }
      const mismatchHint = !exec.ok && /reply_to_mismatch/.test(exec.output)
        ? `\n提示：群聊 replyTo 只能是 quotes 里的 #${replyAnchor ?? '?'}（或省略让 host 填）。不要换旧 #id，也不要复用错人的气泡正文。`
        : '';
      const sentHint =
        !ended && host.runtime.didProduceFinal()
          ? '\n[系统] 你已经发送最终交付。下一动作必须是 runtime.endTask("一句话摘要")。'
          : '';
      history.push({
        role: 'user',
        content: exec.ok
          ? `[observation]\n${exec.output}\n${ended ? '(task ended)' : `已完成步骤 ${turn + 1}/${maxTurns}。继续下一步，或完成后 runtime.endTask("结果摘要")。`}${sentHint}`
          : `[observation:error]\n${exec.output}${mismatchHint}\n操作失败了，分析错误原因调整策略重试，或换一种方法。${turn + 1 >= maxTurns ? (isSelfPlay ? '这是最后一轮，runtime.endTask 收尾。' : '这是最后一轮，sendFinal 说明进展然后 endTask。') : ''}`,
      });
      if (!audit.hasContract() && !ended && host.runtime.didProduceFinal()) {
        if (postSendTurns >= postSendGrace) {
          host.runtime.endTask(isGoalCheck ? 'no_update' : 'auto_end_after_final');
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
        !host.runtime.isWaitingForUser() &&
        (audit.hasContract() || host.runtime.didProduce()) &&
        (audit.hasContract() || !host.runtime.didProduceFinal());

      if (canResume) {
        let progressSummary = resumeSummary;
        try {
          const total = task.totalTurns ?? 0;
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

        emitTaskRuntimeEvent({
          kind: 'checkpoint_saved',
          taskId: task.id,
          chatId: task.chatId,
          segment: segment + 1,
          turn: task.totalTurns,
          cognitiveAnchorEventId: task.cognitiveAnchorEventId,
        });
        const key = await saveCheckpoint(task, {
          history,
          progressSummary,
          artifacts: [],
          segment: segment + 1,
          totalTurns: task.totalTurns ?? 0,
          sendsUsed: task.sendsUsed ?? 0,
        });

        task.segment = segment + 1;
        task.checkpointKey = key;
        task.audit = audit.snapshot();
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
      } else if (audit.hasContract()) {
        host.runtime.endTask('failed_acceptance_budget_exhausted');
      } else if (host.runtime.didProduceFinal()) {
        // Model delivered a final message but forgot endTask — synthesize a clean callback.
        host.runtime.endTask(isGoalCheck ? 'no_update' : 'auto_end_after_final');
      } else if (host.runtime.isWaitingForUser()) {
        endSummary = 'waiting_user';
        task.waitingForUser = true;
        task.waitingReason = host.runtime.waitingReason() ?? 'user_clarification';
        const waitingCheckpoint = await saveCheckpoint(task, {
          history,
          progressSummary: resumeSummary || 'waiting for user clarification',
          artifacts: [],
          segment,
          totalTurns: task.totalTurns ?? 0,
          sendsUsed: task.sendsUsed ?? 0,
        });
        task.checkpointKey = waitingCheckpoint;
        task.status = 'waiting_user';
        // Cognitive Debt：任务挂起等待用户 = 一笔未完成认知，回答/停止时偿还。
        createDebt({
          chatId: task.chatId,
          ownerUid: task.targetUserId,
          taskId: task.id,
          kind: 'unfinished_task',
          statement: `任务等待用户补充信息: ${task.waitingReason}`,
          sourceEventIds: [`task:${task.id}`],
          priority: 7,
          confidence: 1,
          ttlSec: 24 * 3600,
        });
        state.putTask(task);
        await persistCodeActTask(task);
        await registerAgentChat(task.chatId, task.id);
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
          let text = (fallback.content ?? '').trim().slice(0, 300);
          // This path sends straight through sendMessage, bypassing the guards in
          // host sendText. Apply the same tool-leak check here, or a placeholder
          // echoed by the model reaches the user through the back door.
          const { findToolPlaceholder } = await import('./host-api.js');
          const leak = findToolPlaceholder(text);
          if (leak) {
            text = text.split(leak).join('').trim();
            logger.warn({ taskId: task.id, leak }, 'failsafe reply: stripped tool-result placeholder');
          }
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
      endSummary = host.runtime.didProduceFinal() ? 'timeout_after_final' : 'failed_timeout';
    }

    // Ensure ctx write + any fire-and-forget sends finished before Meta sees callback.
    await host.runtime.flushBookkeeping();

    // 续跑任务不进入终态：保持 queued，等下一段完成/超限后再收尾。
    const resumed = endSummary.startsWith('resumed_seg') || endSummary === 'waiting_user';
    if (!resumed) {
      task.audit = audit.snapshot();
      task.assessment = await audit.verify();
      if (closed || endSummary.startsWith('failed') || endSummary === 'user_stopped') {
        task.assessment = { status: 'unverified', reasons: ['execution_incomplete'], checks: task.assessment.checks };
      }
      task.status = endSummary.startsWith('failed') || endSummary === 'user_stopped' ? 'failed' : 'done';
      task.resultSummary = endSummary || 'done';
      const terminalResolution = task.status === 'done'
        ? `任务完成: ${String(endSummary).slice(0, 200)}`
        : undefined;
      const terminalEventId = emitTaskRuntimeEvent({
        kind: task.status === 'done' ? 'task_completed' : 'task_failed',
        taskId: task.id,
        chatId: task.chatId,
        cognitiveAnchorEventId: task.cognitiveAnchorEventId,
        segment,
        turn: task.totalTurns,
        resultSummary: task.resultSummary,
        ...(terminalResolution ? { resolution: terminalResolution } : {}),
        assessmentStatus: task.assessment.status,
      });
      if (task.status === 'done') {
        // 任务完成只能用这次 host 终态事件作为 resolution evidence；事件不可写时
        // 宁可保留债务，也不回退到没有 provenance 的直接清债。
        if (terminalEventId && terminalResolution) {
          resolveOpenDebtsByTaskWithEvidence({
            taskId: task.id,
            chatId: task.chatId,
            resolution: terminalResolution,
            resolutionEventId: terminalEventId,
          });
        }
      } else if (endSummary !== 'failed_user_stopped') {
        // 任务失败 = 一笔未完成认知，后续可主动修复或向用户说明。
        createDebt({
          chatId: task.chatId,
          ownerUid: task.targetUserId,
          taskId: task.id,
          kind: 'unfinished_task',
          statement: `任务未完成: ${String(endSummary).slice(0, 300)}`,
          sourceEventIds: terminalEventId ? [terminalEventId] : [`task:${task.id}`],
          priority: 6,
          confidence: 1,
          ttlSec: 7 * 24 * 3600,
          nextCheckInSec: 6 * 3600,
          ...(terminalEventId ? { dedupeKey: `event-debt:${terminalEventId}:unfinished_task` } : {}),
        });
      }
      saveTaskEvidence({ taskId: task.id, chatId: task.chatId, lifecycle: task.status,
        assessment: task.assessment.status, turns: task.totalTurns ?? 0,
        totalCalls: task.audit.totalCalls, failedCalls: task.audit.failedCalls, retryCount: task.audit.retryCount,
        reasons: task.assessment.reasons });
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
      // 真实 host 调用统计 + 独立验收,不能把结束当成功。
      if (injectedExperienceIds.length > 0 && env().EXPERIENCE_VERIFY_ENABLED) {
        void import('../agent/path-quality.js')
          .then(async ({ computePathQuality }) => {
            const quality = computePathQuality({ totalCalls: task.audit!.totalCalls, invalidCalls: task.audit!.failedCalls, retryCount: task.audit!.retryCount, turns: task.totalTurns ?? 0 });
            const { recordInjectOutcome } = await import('../agent/experience-verify.js');
            const { recordSkillVerifiedUse } = await import('../agent/skills.js');
            let skillGated = false;
            try {
              skillGated = env().SKILL_VERIFIED_USE_ENABLED === true;
            } catch {
              skillGated = false;
            }
            if (skillGated) recordSkillVerifiedUse(injectedSkillIds, task.assessment?.status ?? 'unverified');
            recordInjectOutcome({
              experienceIds: injectedExperienceIds,
              taskOutcome: task.status === 'done' ? 'done' : 'failed',
              pathQualityScore: quality.score,
              evidenceStatus: task.assessment?.status ?? 'unverified',
            });
          })
          .catch((err) => logger.warn({ err, taskId: task.id }, 'experience verify failed'));
      }

      // AGI Level 5 Phase 4: loop 策略计数进化。
      if (injectedPolicyIds.length > 0 && env().LOOP_POLICY_ENABLED && task.assessment.status === 'verified') {
        void import('../agent/loop-policy.js')
          .then(({ recordPolicyOutcome }) => {
            recordPolicyOutcome(injectedPolicyIds, task.status === 'done');
          })
          .catch((err) => logger.warn({ err, taskId: task.id }, 'loop policy outcome failed'));
      }

      // AGI Level 5 Phase 6: 任务终态把 topic 实体写入世界状态。
      //
      // 2026-09-18: `contentDirection` is a reply *instruction*, not a topic name.
      // Passing it here polluted world_entities with 2,711 instruction rows that
      // were then rendered into the live prompt as "[相关世界实体]". The shape
      // guard now lives in upsertEntity itself, so any caller is covered; this
      // call site additionally skips the write when the text is clearly a
      // directive rather than a name.
      if (env().WORLD_STATE_ENABLED) {
        void import('../agent/world-state.js')
          .then(({ upsertEntity }) => {
            const topic = task.contentDirection.replace(/\[goal:\d+\]/g, '').trim();
            // upsertEntity rejects non-entity shapes; nothing else to do here.
            upsertEntity(topic, 'topic', { last_outcome: task.assessment?.status ?? 'unverified' }, task.chatId);
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
              progressSummary: `[host assessment: ${task.assessment?.status ?? 'unverified'}; lifecycle done is not verified success] ${resumeSummary ?? endSummary}`,
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
            .then(async ({ recordCheck, markSilentChange, setGoalStatus, listGoals, markGoalAchieved, recordUnverifiedCompletion }) => {
              if (achieved) {
                // Phase 2 证据门(默认 OFF 时保持 legacy 行为:直接 achieved)。
                // 开启后:模型自称已完成 ≠ 独立验证,只有 host assessment=verified 才晋级。
                // 未显式开启时一律 legacy,避免 mock/异常 env 下行为漂移。
                let gated = false;
                try {
                  gated = env().GOAL_EVIDENCE_GATE_ENABLED === true;
                } catch {
                  gated = false;
                }
                if (!gated) {
                  recordCheck(goalId, `已完成: ${achieved.slice(0, 480)}`);
                  setGoalStatus(goalId, 'achieved');
                  logger.info({ goalId, result: achieved.slice(0, 80) }, 'goal achieved (legacy, gate off)');
                  return;
                }
                // 证据门：模型自称已完成 ≠ 独立验证。只有 host assessment=verified 才晋级 achieved；
                // 否则保持 active 并计数，避免自我认证占坑或虚假关闭。
                const evidence = task.assessment?.status ?? 'unverified';
                if (evidence === 'verified') {
                  recordCheck(goalId, `已完成: ${achieved.slice(0, 480)}`);
                  markGoalAchieved(goalId, 'verified', task.assessment?.checks.map((c) => `#${c.index}:${c.reason}`).join(','));
                  logger.info({ goalId, result: achieved.slice(0, 80) }, 'goal achieved (verified)');
                } else {
                  recordUnverifiedCompletion(goalId, `model completion claim without verification: ${achieved.slice(0, 200)}`);
                  logger.info({ goalId }, 'goal completion unverified, stays active');
                }
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
                    // `cannot` is model output and reaches a user directly here.
                    const { findToolPlaceholder } = await import('./host-api.js');
                    let reason = cannot.slice(0, 200);
                    const leak = findToolPlaceholder(reason);
                    if (leak) reason = reason.split(leak).join('').trim() || '遇到了一些问题';
                    await sendMessage(
                      masterUid,
                      `主人，之前交代的那件事「${goal.topic.slice(0, 60)}」本喵办不到……${reason}`,
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
        ok: task.status === 'done' && (!task.acceptance || task.assessment.status === 'verified'),
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
    if (interruptible && !endSummary.startsWith('resumed_seg') && endSummary !== 'waiting_user') {
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
