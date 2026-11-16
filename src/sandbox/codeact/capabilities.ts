export type CodeActCapability = (...args: unknown[]) => unknown | Promise<unknown>;
export type CodeActCapabilities = ReadonlyMap<string, CodeActCapability>;

// Explicit allowlists: host bookkeeping, arbitrary code, file access, prompt
// mutation and browser eval are deliberately absent from this first boundary.
export const CODEACT_CAPABILITY_METHODS = [
  'telegram.sendText', 'telegram.sendFinal', 'telegram.sendSticker', 'telegram.sendVoice', 'telegram.react', 'telegram.sendPoll',
  'memory.search', 'memory.recallPerson', 'memory.recentContext', 'memory.searchDigests',
  'stickers.pick', 'web.search', 'web.feed', 'meta.request',
  'chats.find', 'chats.recentMessages', 'chats.previewAssignment', 'chats.assignmentStatus', 'members.find', 'goals.add',
  'allowlist.apply', 'allowlist.approve', 'allowlist.reject', 'allowlist.list',
  'linuxsb.latest', 'linuxsb.topic', 'linuxsb.search', 'pixiv.search',
  'runtime.endTask', 'runtime.setAcceptance', 'runtime.verifyAcceptance', 'runtime.waitForUser',
  'runtime.predict', 'runtime.setScratch', 'runtime.clearScratch', 'runtime.rememberThread',
  'runtime.scheduleSelfWake', 'runtime.setPlan',
] as const;

export const META_CAPABILITY_METHODS = [
  'dispatch.taskToGroup', 'dispatch.getTask', 'dispatch.listTasks',
  'journal.tryWrite', 'journal.recent', 'todo.add', 'todo.list', 'todo.remove',
  'journal.config', 'journal.previewConfig',
  'agents.listStatus', 'conversations.query', 'memory.searchEntities',
  'cognition.proposeMission', 'cognition.proposeSensor', 'cognition.proposeValue',
  'cognition.proposeAffect', 'cognition.proposeCircuit',
] as const;

export function validCapabilityName(name: string): boolean {
  return /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(name)
    && !name.split('.').some(part => ['constructor', 'prototype', '__proto__'].includes(part));
}

/** Own data properties only: never traverse prototypes, getters or model paths. */
export function selectCodeActCapabilities(api: object, allowed: readonly string[]): CodeActCapabilities {
  const capabilities = new Map<string, CodeActCapability>();
  for (const name of allowed) {
    if (!validCapabilityName(name)) throw new Error('invalid_capability_name');
    const [namespace, member] = name.split('.') as [string, string];
    const object = Object.getOwnPropertyDescriptor(api, namespace)?.value as unknown;
    if (!object || typeof object !== 'object') continue;
    const fn = Object.getOwnPropertyDescriptor(object, member)?.value as unknown;
    if (typeof fn !== 'function') continue;
    capabilities.set(name, (...args) => Reflect.apply(fn, object, args));
  }
  return capabilities;
}

export interface WireValue { kind: 'undefined' | 'json'; value?: unknown; display?: string }
export function packCodeActValue(value: unknown): WireValue {
  if (value === undefined) return { kind: 'undefined' };
  const display = value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<symbol, unknown>)[Symbol.toPrimitive] === 'function' ? String(value) : undefined;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024) throw new Error('capability_result_not_serializable_or_too_large');
  return { kind: 'json', value: JSON.parse(encoded) as unknown,
    ...(display === undefined ? {} : { display: display.slice(0, 4000) }) };
}

export function unpackCodeActValue(wire: WireValue): unknown {
  if (wire.kind === 'undefined') return undefined;
  if (typeof wire.display === 'string' && wire.value && typeof wire.value === 'object') {
    Object.defineProperty(wire.value, Symbol.toPrimitive, { value: () => wire.display });
  }
  return wire.value;
}
