import { describe, expect, it } from 'vitest';
import { summarizeReason, buildAdminSections } from './adminGroups';

describe('admin group helpers', () => {
  it('summarizes long ai reason', () => {
    expect(summarizeReason('这是一条很长很长的审核理由，用于测试折叠摘要。', 8)).toBe('这是一条很长很…');
  });

  it('builds unified sections', () => {
    const sections = buildAdminSections({
      manualQueue: [{ request_id: 'r1' }],
      aiApproved: [{ chat_id: -1001 }],
      groups: [{ chat_id: -1002 }],
    });

    expect(sections.map((section) => section.key)).toEqual(['manual', 'ai', 'groups']);
  });
});
