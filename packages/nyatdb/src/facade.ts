/**
 * Adapter: native napi handle → same call shape as TS `NyatDb` (dual-write / getNyatDb).
 */
import type { NyatDbNativeHandle } from './native.js';
import { RECALL_DIM } from './format/codec.js';

type ChatRole = 'user' | 'assistant' | 'system';

export class NyatDbNativeFacade {
  readonly backend = 'native-rust' as const;

  constructor(private readonly inner: NyatDbNativeHandle) {}

  chatAppend(
    chatId: number,
    msg: {
      messageId: number;
      ts: number;
      uid: number;
      role: ChatRole;
      text: string;
      bodyFormat?: 'text' | 'json';
    },
  ): void {
    this.inner.chatAppend(chatId, {
      messageId: msg.messageId,
      ts: msg.ts,
      uid: msg.uid,
      role: msg.role,
      text: msg.text,
      bodyFormat: msg.bodyFormat,
    });
  }

  chatRecent(chatId: number, limit = 50): Array<{
    messageId: number;
    ts: number;
    uid: number;
    role: number;
    roleName: string;
    text: string;
    bodyFormat?: string;
  }> {
    return this.inner.chatRecent(chatId, limit);
  }

  chatGet(chatId: number, messageId: number): {
    messageId: number;
    ts: number;
    uid: number;
    role: number;
    roleName: string;
    text: string;
    bodyFormat?: string;
  } | null {
    return this.inner.chatGet(chatId, messageId);
  }

  chatGetBatch(
    chatId: number,
    messageIds: number[],
  ): Array<{
    messageId: number;
    ts: number;
    uid: number;
    role: number;
    roleName: string;
    text: string;
    bodyFormat?: string;
  } | null> {
    return this.inner.chatGetBatch(chatId, messageIds);
  }

  chatTrimKeepLast(chatId: number, keep: number): void {
    this.inner.chatTrimKeepLast(chatId, keep);
  }

  hotSet(key: string, value: string | Buffer, ttlMs = 0): void {
    const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    this.inner.hotSet(key, buf, ttlMs);
  }

  hotGet(key: string): Buffer | null {
    return this.inner.hotGet(key);
  }

  hotGetString(key: string): string | null {
    return this.inner.hotGetString(key);
  }

  hotDel(key: string): void {
    this.inner.hotDel(key);
  }

  impulseSchedule(job: {
    id: string;
    chatId: number;
    runAt: number;
    kind: string;
    payload?: Buffer | string;
  }): void {
    const payload =
      typeof job.payload === 'string'
        ? Buffer.from(job.payload, 'utf8')
        : (job.payload ?? Buffer.alloc(0));
    this.inner.impulseSchedule(job.id, job.chatId, job.runAt, job.kind, payload);
  }

  impulseDue(now = Date.now(), limit = 32): Array<{
    id: string;
    chatId: number;
    runAt: number;
    kind: string;
    payload: number[];
  }> {
    return this.inner.impulseDue(now, limit);
  }

  impulseAck(id: string): void {
    this.inner.impulseAck(id);
  }

  bondUpsert(b: { uid: number; chatId: number; score: number; note: string }): void {
    this.inner.bondUpsert(b);
  }

  bondList(limit = 100): Array<{ uid: number; chatId: number; score: number; note: string }> {
    return this.inner.bondList(limit);
  }

  recallUpsert(opts: {
    chatId: number;
    messageId: number;
    visibility?: number;
    vector: Float32Array | Float64Array | number[];
  }): void {
    const vec =
      opts.vector instanceof Float64Array
        ? opts.vector
        : Float64Array.from(opts.vector as ArrayLike<number>);
    if (vec.length !== RECALL_DIM) throw new Error(`recall expects ${RECALL_DIM}-d`);
    this.inner.recallUpsert(opts.chatId, opts.messageId, vec, opts.visibility);
  }

  recallSearch(
    query: Float32Array | Float64Array | number[],
    opts?: { chatId?: number; topK?: number },
  ): Array<{ chatId: number; messageId: number; score: number }> {
    const q =
      query instanceof Float64Array ? query : Float64Array.from(query as ArrayLike<number>);
    return this.inner.recallSearch(q, opts?.chatId ?? null, opts?.topK);
  }

  checkpoint(): void {
    this.inner.checkpoint();
  }

  verify(): { pages: number; ok: true } {
    const pages = this.inner.verify();
    return { pages, ok: true };
  }

  stats(): {
    pages: number;
    pool: { cached: number; dirty: number };
    chats: number;
    recalls: number;
    indexed: number;
    lsn: string;
    backend?: string;
  } {
    const s = this.inner.stats();
    return {
      pages: s.pages,
      pool: { cached: s.poolCached, dirty: s.poolDirty },
      chats: s.chats,
      recalls: s.recalls,
      indexed: s.indexed,
      lsn: s.lsn,
      backend: s.backend,
    };
  }

  close(opts?: { skipCheckpoint?: boolean }): void {
    this.inner.close(opts?.skipCheckpoint ?? false);
  }
}
