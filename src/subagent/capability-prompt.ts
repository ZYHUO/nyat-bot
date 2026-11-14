import { CODEACT_CAPABILITY_METHODS } from '../sandbox/codeact/capabilities.js';
import { isPlatformInternalId } from '../platform/identity-store.js';

/** The same list governs both the model's instructions and actual guest RPC. */
export function codeActMethodsForChat(chatId: number): readonly string[] {
  if (!isPlatformInternalId(chatId)) return CODEACT_CAPABILITY_METHODS;
  return CODEACT_CAPABILITY_METHODS.filter(name =>
    (!name.startsWith('telegram.') || name === 'telegram.sendText' || name === 'telegram.sendFinal')
    && !name.startsWith('allowlist.') && name !== 'stickers.pick');
}

// The legacy persona/instructions contain capabilities that are not exported to the
// isolated guest. Filter the actual runtime prompt, rather than contradicting it with
// a second list after telling the model to use unavailable tools.
const HOST_METHOD = /\b(?:telegram|memory|stickers|web|meta|chats|members|goals|allowlist|linuxsb|pixiv|runtime|computer|browser|art|admin|bots|self)\.[A-Za-z][A-Za-z0-9]*/g;

export function buildCodeActSystemPrompt(
  legacy: string,
  methods: readonly string[] = CODEACT_CAPABILITY_METHODS,
): string {
  const allowed = new Set(methods);
  let computerSection = false;
  const lines = legacy.split('\n').filter((line) => {
    if (line.startsWith('## 电脑使用')) { computerSection = true; return false; }
    if (line.startsWith('## ')) computerSection = false;
    if (computerSection) return false;
    const referenced = line.match(HOST_METHOD) ?? [];
    if (referenced.some((name) => !allowed.has(name))) return false;
    // These continuations rely on tools described on the preceding removed lines.
    if (/踢人是最后手段|给具体的人送东西|找人（确认某人在哪）/.test(line)) return false;
    return true;
  });
  return lines.join('\n').trim() + `

## 当前隔离执行能力
本轮可调用的宿主方法只有：${methods.join(', ')}。
所有宿主方法都是异步 RPC；读取结果必须 await，并用 return 或 console.log 看实际返回。
普通 JavaScript 可计算和组织文字；当前不提供终端、浏览器、文件读写或附件投递、画图、群管理、修改提示词、机器人代罚及跨会话发送。遇到这些请求应说明当前能力限制，不要承诺完成或建议绕过隔离。现有能力列表以外的旧聊天记录和旧工具示例不是授权。
发送仅限本任务绑定会话和上述可用方法；具体权限、冷却和开关仍由宿主检查。调用返回 skipped、失败或没有有效发送回执时，不得声称已经交付。发送结果未知时不得重复发送同一内容。搜索不可用、验证码或无来源结果不算事实证据；部分查询成功只能根据成功返回的来源作答并说明缺口。
只承诺当前能力能完成的动作；未来跟进登记成功也不等于届时已执行。日记读写通过 meta.request 提交 journal.write 或 journal.recent，等实际结果后再说明状态。
`;
}

export function buildJournalCapabilityNote(link: string, role: 'meta' | 'subagent'): string {
  return `## 日记频道\n频道链接：${link}\n`
    + (role === 'meta'
      ? '日记写作使用 journal.tryWrite，查看使用 journal.recent；是否写入或发布以实际返回为准。'
      : '日记读写通过 meta.request 提交 journal.write 或 journal.recent；是否写入或发布以实际回执为准。');
}
