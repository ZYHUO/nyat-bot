// ────────────────────────────────────────
// 控制指令分类 — 取代旧的 L0 关键词 regex(闭嘴/别理我/记住/忘掉…)
// ────────────────────────────────────────
//
// 对「点名/回复本喵」的**短**群消息,用一次廉价 LLM 判断是不是控制指令
// (mute/unmute/remember/forget)。命中 → 投递层静默执行 + emoji ack,不 typing 不回复。
// 放在 typing 之前跑(所以不触发 typing);非指令(none)→ 走正常回复。
// CONTROL_DIRECTIVE_ENABLED 关 → 跳过(回退正常回复)。

import { callWithFallback } from '../ai/fallback.js';
import { loadPrompt, getConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import type { ControlAction } from './control-actions.js';

interface DirectiveJson {
  directive?: string;
  target?: string;
  content?: string;
  minutes?: number;
}

/** 判断一条指向本喵的短消息是否控制指令;是则返回动作,否则 null。 */
export async function classifyDirective(text: string): Promise<ControlAction | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const prompt = loadPrompt('task/directive.md', getConfig().promptsDir);
    const r = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: trimmed },
      ],
      maxTokens: 80,
      temperature: 0,
    });
    const raw = r.content.trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    const d = JSON.parse(raw.slice(start, end + 1)) as DirectiveJson;
    const dir = d.directive;

    if (dir === 'mute' || dir === 'unmute') {
      const tgt = (d.target ?? '').trim();
      const isUser = tgt.length > 0 && tgt !== 'self' && tgt !== 'me' && tgt !== '我';
      const action: ControlAction = { action: dir, controlTarget: isUser ? 'user' : 'self' };
      if (isUser) action.controlContent = tgt.slice(0, 64);
      if (dir === 'mute' && typeof d.minutes === 'number' && d.minutes > 0) action.muteMinutes = d.minutes;
      return action;
    }
    if (dir === 'remember' || dir === 'forget') {
      const content = (d.content ?? '').trim();
      if (!content) return null;
      return { action: dir, controlContent: content.slice(0, 200) };
    }
    return null; // none / 未知
  } catch (err) {
    logger.debug({ err }, 'classifyDirective failed (non-critical)');
    return null;
  }
}
