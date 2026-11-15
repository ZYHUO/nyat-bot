/**
 * 工具**调用**语法泄漏的守卫测试。
 *
 * 2026-09-20 生产事故：bot 把
 *   <web.search><args><query>Anthropic Claude new version pricing 2025</query></args></web.search>
 * 原样发进群。原守卫的 TOOL_PLACEHOLDERS 全是**结果**占位符（(invalid chatId) 等），
 * 兜底正则只认 `(invalid …)` / `(… unavailable)`，调用语法整类漏掉。
 * 而且日志里看不见：sendText 的 preview 只截 60 字符，调用标签在后面被截掉。
 */
import { describe, it, expect } from 'vitest';
import { findToolPlaceholder } from '../../../src/subagent/host-api.js';

describe('工具调用语法泄漏（2026-09-20 事故类）', () => {
  it('整条就是工具调用 → 判为泄漏', () => {
    const leak = '<web.search><args><query>Anthropic Claude pricing</query><topk>5</topk></args></web.search>';
    expect(findToolPlaceholder(leak)).not.toBeNull();
  });

  it('调用嵌在句子里 → 判为泄漏且能按字面剥掉', () => {
    const text = '我查一下<web.search><args><query>x</query></args></web.search>然后告诉你';
    const hit = findToolPlaceholder(text);
    expect(hit).not.toBeNull();
    // 调用方按字面剥离，所以返回值必须是真的匹配串
    expect(text.includes(hit as string)).toBe(true);
    const stripped = text.split(hit as string).join('').trim();
    expect(stripped).toBe('我查一下然后告诉你');
    expect(stripped).not.toContain('web.search');
  });

  it('别的工具名同样覆盖（chats.recentMessages / computer.run）', () => {
    expect(findToolPlaceholder('<chats.recentMessages><args><chatId>-100</chatId></args></chats.recentMessages>')).not.toBeNull();
    expect(findToolPlaceholder('<computer.run><args><command>ls</command></args></computer.run>')).not.toBeNull();
  });

  it('裸 <args> 也拦', () => {
    expect(findToolPlaceholder('<args><query>x</query>')).not.toBeNull();
  });

  it('原有的结果占位符仍拦（不回归）', () => {
    expect(findToolPlaceholder('(invalid chatId)')).toBe('(invalid chatId)');
    expect(findToolPlaceholder('(empty query)')).toBe('(empty query)');
    expect(findToolPlaceholder('前面(invalid uid)后面')).toBe('(invalid uid)');
  });

  it('不误杀合法 HTML 标签（工具名必须带点）', () => {
    expect(findToolPlaceholder('他说<b>很重要</b>这件事')).toBeNull();
    expect(findToolPlaceholder('<i>斜体</i>和<u>下划线</u>')).toBeNull();
    expect(findToolPlaceholder('代码是 <div>hello</div> 这样')).toBeNull();
  });

  it('不误杀正常聊天', () => {
    expect(findToolPlaceholder('今天天气不错啊喵')).toBeNull();
    expect(findToolPlaceholder('3 < 5 而且 5 > 3')).toBeNull();
    expect(findToolPlaceholder('他说<不重要>然后走了')).toBeNull();
    expect(findToolPlaceholder('我用 a<b 这种写法')).toBeNull();
  });
});
