import { describe, expect, it } from 'vitest';

// round 3（新 goal）回归：群里举报广告的正常形状是「某人回复那条广告说举报」。
// 本条 #X 是那句"举报"，**广告是它回复的 #Y**。模型要发
// `/spam@nmnmfunbot`（回复式代罚）必须带 #Y，但 targetBlock 以前只给 #X。
//
// 这个测试锁住渲染出来的那两行长什么样——它是纯字符串函数，抽出来单测
// 比跑整条 CodeAct 链路可靠。

/** 与 src/subagent/executor.ts 里那段渲染保持一致的形状（改那边要同步改这里）。 */
function renderParentLine(
  replyAnchor: number,
  parent: { messageId: number; uid: number; fullName: string; textSnippet?: string } | undefined,
): string {
  if (!parent || parent.messageId <= 0) return '';
  return (
    `#${replyAnchor} 回复的是 #${parent.messageId} ${parent.fullName || `uid:${parent.uid}`}: ` +
    `${(parent.textSnippet || '（无正文，可能是图片/文件/ sticker）').slice(0, 160)}\n` +
    `   ↑ 要处理/举报**上面这条 #${parent.messageId}** 时` +
    `（例如 bots.command 的 /spam 回复式代罚），用这个 id。\n`
  );
}

describe('targetBlock 的 reply 父消息行', () => {
  it('① 本条是回复 → 给出父消息 #id 和内容', () => {
    const line = renderParentLine(86001, {
      messageId: 85943, uid: 136817688, fullName: 'Alejandra', textSnippet: '接单+V：xxx 稳定日结',
    });
    expect(line).toContain('#86001 回复的是 #85943');
    expect(line).toContain('Alejandra');
    expect(line).toContain('接单+V');
    // 关键：明确告诉模型这个 id 是给 /spam 回复式代罚用的
    expect(line).toContain('/spam');
    expect(line).toContain('用这个 id');
  });

  it('② 本条不是回复 → 不加这一行（不污染 prompt）', () => {
    expect(renderParentLine(86001, undefined)).toBe('');
  });

  it('③ 父消息无正文（图片/文件）→ 给占位说明，仍然给 #id', () => {
    const line = renderParentLine(86001, { messageId: 85943, uid: 1, fullName: '', textSnippet: '' });
    expect(line).toContain('#85943');
    expect(line).toContain('无正文');
    expect(line).toContain('uid:1'); // fullName 空时退回 uid
  });
});
