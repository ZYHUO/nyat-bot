// ────────────────────────────────────────
// Timer API CRUD tool
// Port of PHP ToolService timer methods
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

interface AddTimerParams {
  name: string;
  cron_expression: string;
  one_time?: boolean;
  message?: string;
  chatId: number;
  userId: number;
}

export async function addTimer(params: AddTimerParams): Promise<string> {
  const e = env();
  if (!e.TIMER_API_URL || !e.TIMER_CALLBACK_URL) return '定时器工具未配置。';

  const body = {
    name: params.name,
    cron_expression: params.cron_expression,
    one_time: params.one_time ?? false,
    message: params.message,
    creator_chat_id: params.chatId,
    creator_user_id: params.userId,
    callback_url: e.TIMER_CALLBACK_URL,
  };

  try {
    const res = await fetch(`${e.TIMER_API_URL.replace(/\/+$/, '')}?action=create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': e.COMMON_API_KEY ?? '',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || !data.id) {
      return `创建定时器失败: ${String(data.error ?? 'API返回了无效的响应')} (状态码: ${res.status})`;
    }
    return `定时器 \`${escapeHtml(String(data.name ?? '无名氏'))}\` 已成功创建 (ID: ${data.id})。`;
  } catch (err) {
    logger.error({ err }, 'Add timer failed');
    return `创建定时器失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function listTimers(chatId: number): Promise<string> {
  const e = env();
  if (!e.TIMER_API_URL) return '定时器工具未配置。';

  try {
    const res = await fetch(`${e.TIMER_API_URL.replace(/\/+$/, '')}?action=list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': e.COMMON_API_KEY ?? '',
      },
      body: JSON.stringify({ creator_chat_id: chatId }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return `获取定时器列表失败: API返回状态码 ${res.status}`;

    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data) || data.length === 0) return '当前没有任何定时器。';

    let result = '当前激活的定时器列表:\n';
    for (const timer of data) {
      result += `- 名称: \`${escapeHtml(String(timer.name ?? '无名'))}\`\n  ID: \`${escapeHtml(String(timer.id ?? 'N/A'))}\`\n  Cron: \`${timer.cron_expression ?? 'N/A'}\`\n  一次性: ${timer.one_time ? '是' : '否'}\n\n`;
    }
    return result;
  } catch (err) {
    logger.error({ err }, 'List timers failed');
    return `获取定时器列表失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function deleteTimer(id: string): Promise<string> {
  const e = env();
  if (!e.TIMER_API_URL) return '定时器工具未配置。';

  try {
    const res = await fetch(`${e.TIMER_API_URL.replace(/\/+$/, '')}?action=delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': e.COMMON_API_KEY ?? '',
      },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await res.json()) as Record<string, unknown>;
    if (data.success) return `定时器 \`${data.id}\` 已成功删除。`;
    return `删除定时器 \`${id}\` 失败: ${String(data.error ?? '未知错误')}。`;
  } catch (err) {
    logger.error({ err }, 'Delete timer failed');
    return `删除定时器失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
