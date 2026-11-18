/** In-memory Redis contract fixture for the atomic wait scripts. No network. */
export function timingWaitEval(store: Map<string, Record<string, string>>) {
  return async (script: string, keys: number, key: string, ...values: Array<string | number>): Promise<unknown> => {
    if (keys !== 1) throw new Error('Timing fixture expects one scoped key');
    const a = values.map(String);
    const h = store.get(key) ?? {};
    const remove = (...fields: string[]) => { for (const field of fields) delete h[field]; };
    const clear = () => remove('waitGeneration', 'waitScheduledAt', 'waitUntil', 'waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitTopicKey', 'waitThreadId');
    if (script.startsWith('-- timing-wait-begin-v1')) {
      const uids = h.state === 'WAIT' && (h.waitThreadId ?? '0') === a[6] ? (h.waitTriggerUids ?? '').split(',').filter(Boolean) : [];
      remove('waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitTopicKey');
      Object.assign(h, { state: 'WAIT', waitGeneration: a[0], waitScheduledAt: a[1], waitUntil: a[2],
        lastGateAt: a[1], lastGateAction: 'wait', gatePendingCount: '0', gatePendingSince: a[1], waitThreadId: a[6] });
      if (a[3]) h.waitAnchorMid = a[3];
      if (a[4]) { h.lastGateUid = a[4]; h.waitTriggerUids = [...new Set([...uids, a[4]])].join(','); }
      store.set(key, h); return 1;
    }
    if (script.startsWith('-- timing-wait-attach-v1')) {
      if (h.state !== 'WAIT' || h.waitGeneration !== a[0]) return 0;
      h.waitJobId = a[1]!; return 1;
    }
    if (script.startsWith('-- timing-wait-cancel-v1')) {
      if (h.waitGeneration !== a[0]) return 0;
      h.state = 'RUNNING'; clear(); return 1;
    }
    if (script.startsWith('-- timing-wait-cancel-scope-v1')) {
      if (!h.state) return 0;
      if ((h.waitThreadId ?? '0') !== a[0]) return 0;
      h.state = 'RUNNING'; clear(); store.set(key, h); return 1;
    }
    if (script.startsWith('-- timing-wait-claim-v1')) {
      if (h.state !== 'WAIT') return ['stale', '0'];
      if (!h.waitUntil || !Number.isFinite(Number(h.waitUntil))) return ['invalid', '0'];
      if (h.waitGeneration) {
        if (h.waitGeneration !== a[0] || Number(h.waitUntil) !== Number(a[1])) return ['stale', '0'];
        if (h.waitJobId && a[2] && h.waitJobId !== a[2]) return ['stale', '0'];
      } else if (a[0] || !a[2] || h.waitJobId !== a[2]) return ['stale', '0'];
      if ((h.waitAnchorMid ?? '') !== a[3]) return ['stale', '0'];
      const deadline = h.waitUntil;
      if (Number(a[4]) < Number(deadline)) return ['early', deadline];
      h.state = 'RUNNING';
      remove('waitScheduledAt', 'waitUntil', 'waitJobId', 'waitAnchorMid', 'waitTriggerUids', 'waitTopicKey');
      return ['claimed', deadline];
    }
    throw new Error('Unsupported Redis Lua in timing wait fixture');
  };
}
