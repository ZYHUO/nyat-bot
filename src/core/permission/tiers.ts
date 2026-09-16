// ────────────────────────────────────────
// Core Permission — 动作三档分类（确定性规则，Phase 0 Task 0.4）
// L0/L1 管"要不要想一下"，permission gate 管"能不能动手"。
// ────────────────────────────────────────

export type Tier = 'readonly' | 'reversible_write' | 'irreversible';

const TOOL_TIERS: Record<string, Tier> = {
  // 只读：随便调
  'memory.search': 'readonly',
  'chats.recentMessages': 'readonly',
  'web.search': 'readonly',
  // 可逆写：需要 authorized_intent + scope 校验
  'telegram.sendText': 'reversible_write',
  'telegram.sendToChat': 'reversible_write',
  'computer.run': 'reversible_write', // 命令内容再细查（见下）
  // 不可逆：dry-run + 显式用户确认 + 备份/回滚检查 + L1 播报可中断
  'admin.deleteMessage': 'irreversible',
  'admin.mute': 'irreversible',
  'admin.pin': 'irreversible',
  'self.editPrompt': 'irreversible',
};

/** computer.run 的命令级覆盖：危险动词 → irreversible */
const IRREVERSIBLE_CMD_RE =
  /\b(drop|delete|truncate|format|shutdown|reboot|mkfs|dd\s+[^ ]*of=|rm\s+-[a-z]*r?f)\b/i;

function commandOf(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    for (const k of ['command', 'cmd', 'script', 'code']) {
      if (typeof a[k] === 'string') return a[k] as string;
    }
  }
  return '';
}

/** 纯函数：工具名 + 参数 → 档位。未知工具默认 irreversible（fail-closed）。 */
export function classify(tool: string, args: unknown): Tier {
  if (tool === 'computer.run' && IRREVERSIBLE_CMD_RE.test(commandOf(args))) {
    return 'irreversible';
  }
  return TOOL_TIERS[tool] ?? 'irreversible';
}
