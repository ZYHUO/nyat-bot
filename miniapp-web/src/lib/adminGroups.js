export function summarizeReason(reason = '', max = 48) {
  const text = String(reason || '').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function buildAdminSections({ manualQueue = [], aiApproved = [], groups = [] }) {
  return [
    { key: 'manual', title: '待你处理', items: manualQueue, defaultOpen: true },
    {
      key: 'ai',
      title: 'AI 自动通过',
      subtitle: '仅含 AI 自动放行；人工点「通过」的群只在下方「已放行群」',
      items: aiApproved,
      defaultOpen: false,
    },
    { key: 'groups', title: '已放行群', items: groups, defaultOpen: true },
  ];
}
