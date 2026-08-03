import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PageType, SCHEMA_VERSION, WalType } from './format/constants.js';
import { Page } from './format/page.js';
import {
  encodeChatTuple,
  decodeChatTuple,
  encodeHot,
  decodeHot,
  encodeImpulse,
  decodeImpulse,
  encodeBond,
  decodeBond,
  encodeRecall,
  decodeRecall,
  cosine,
  RECALL_DIM,
  type ChatTuple,
  type ImpulseTuple,
  type BondTuple,
} from './format/codec.js';
import { BufferPool } from './storage/buffer-pool.js';
import { HeapFile } from './storage/heap.js';
import { RedoWal } from './storage/wal.js';
import { CompactMsgIndex, loadMsgIndex, saveMsgIndex } from './index/msg-index.js';

export interface ChatTip {
  head: number;
  tail: number;
  count: number;
}

export interface NyatDbOpenOptions {
  path: string;
  /** buffer pool frames (pages). Default 64 (~256KB). */
  poolFrames?: number;
  syncEvery?: number;
  /** In-memory recent messages kept per chat. Default 200. */
  chatRingMax?: number;
  /** CRC-scan all pages on open (slower). Default false. */
  verifyOnOpen?: boolean;
}

/**
 * NyatDB v2 — page-addressed engine with domain primitives.
 *
 * Not a Redis facade: ChatLog / HotState / Impulse / Bond / Recall
 * sit on slotted 4KB pages + redo WAL + buffer pool.
 */
export class NyatDb {
  readonly path: string;
  private heap: HeapFile;
  private wal: RedoWal;
  private pool: BufferPool;
  private lsn = 1n;
  private checkpointLsn = 0n;
  private appends = 0;
  private readonly syncEvery: number;
  private closed = false;

  /** chatId → tip */
  private chatTips = new Map<number, ChatTip>();
  /**
   * Decoded recent ring per chat — hot path for chatRecent (beats Redis LRANGE).
   * Survives only in-process; rebuilt from tail pages on open.
   */
  private chatRecentRing = new Map<number, ChatTuple[]>();
  private readonly chatRingMax: number;
  /** Secondary index: chatId → messageId → packed page/slot */
  private msgIndex = new CompactMsgIndex();
  /** hot key → pageId (value in that page's tuples) */
  private hotIndex = new Map<string, number>();
  private hotPageId = 0;
  private impulsePageId = 0;
  private bondPageId = 0;
  private recallPageId = 0;
  /** in-memory recall vectors for search (rebuilt from pages) */
  private recallMem: Array<{
    chatId: number;
    messageId: number;
    visibility: number;
    vector: Float32Array;
  }> = [];

  private constructor(
    path: string,
    heap: HeapFile,
    wal: RedoWal,
    pool: BufferPool,
    syncEvery: number,
    chatRingMax: number,
  ) {
    this.path = path;
    this.heap = heap;
    this.wal = wal;
    this.pool = pool;
    this.syncEvery = syncEvery;
    this.chatRingMax = Math.max(50, chatRingMax);
  }

  static open(opts: NyatDbOpenOptions): NyatDb {
    mkdirSync(opts.path, { recursive: true });
    const heap = HeapFile.open(opts.path);
    const metaPath = join(opts.path, 'ENGINE.json');
    let startLsn = 1n;
    let checkpointLsn = 0n;
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
        lsn: string;
        checkpointLsn: string;
        schema: number;
      };
      startLsn = BigInt(meta.lsn);
      checkpointLsn = BigInt(meta.checkpointLsn ?? '0');
    }

    const poolFrames = opts.poolFrames ?? 64;
    const syncEvery = opts.syncEvery ?? 8;
    const chatRingMax = opts.chatRingMax ?? 200;

    const pool = new BufferPool({
      maxFrames: poolFrames,
      onRead: (id) => heap.readPage(id),
      onFlush: (id, page) => heap.writePage(id, page),
    });

    const wal = RedoWal.open(join(opts.path, 'wal'), startLsn);
    const db = new NyatDb(opts.path, heap, wal, pool, syncEvery, chatRingMax);
    db.lsn = startLsn;
    db.checkpointLsn = checkpointLsn;
    db.bootstrapRoots();
    db.rebuildFromHeap();
    const loaded = loadMsgIndex(opts.path, checkpointLsn);
    if (loaded && loaded.size > 0) {
      db.msgIndex = loaded;
    } else {
      db.rebuildMsgIndex();
    }
    db.replayWal();
    db.warmChatRings();
    if (opts.verifyOnOpen) db.verify();
    return db;
  }

  private bootstrapRoots(): void {
    const types = [PageType.Super, PageType.Hot, PageType.Impulse, PageType.Bond, PageType.Recall];
    while (this.heap.sizePages < 5) {
      const id = this.heap.sizePages;
      const p = Page.alloc(id, types[id] ?? PageType.Free);
      this.heap.appendPage(p);
    }
    this.hotPageId = 1;
    this.impulsePageId = 2;
    this.bondPageId = 3;
    this.recallPageId = 4;
  }

  private rebuildFromHeap(): void {
    this.chatTips.clear();
    this.hotIndex.clear();
    this.recallMem = [];

    for (let id = 1; id < this.heap.sizePages; id++) {
      let page: Page;
      try {
        page = this.heap.readPage(id);
      } catch {
        continue;
      }
      if (page.type === PageType.Chat) {
        // scan will fill tips via chain — collect all chat pages by reading next links from orphans
        // We store chatId in reserved bytes 32..35 of chat pages
        const chatId = Number(page.buf.readBigInt64LE(32));
        const tip = this.chatTips.get(chatId) ?? { head: id, tail: id, count: 0 };
        if (id < tip.head || tip.head === 0) tip.head = tip.head || id;
        tip.tail = id;
        tip.count += page.nslots;
        this.chatTips.set(chatId, tip);
      } else if (page.type === PageType.Hot) {
        for (const tup of page.allTuples()) {
          const h = decodeHot(tup);
          this.hotIndex.set(h.key, id);
        }
      } else if (page.type === PageType.Recall) {
        for (const tup of page.allTuples()) {
          this.recallMem.push(decodeRecall(tup));
        }
      }
    }

    // Fix chat tips: prefer true head by following — rebuild chains properly
    const byChat = new Map<number, number[]>();
    for (let id = 1; id < this.heap.sizePages; id++) {
      try {
        const page = this.heap.readPage(id);
        if (page.type !== PageType.Chat) continue;
        const chatId = Number(page.buf.readBigInt64LE(32));
        const arr = byChat.get(chatId) ?? [];
        arr.push(id);
        byChat.set(chatId, arr);
      } catch {
        /* skip */
      }
    }
    for (const [chatId, ids] of byChat) {
      ids.sort((a, b) => a - b);
      let count = 0;
      for (const id of ids) count += this.heap.readPage(id).nslots;
      this.chatTips.set(chatId, { head: ids[0]!, tail: ids[ids.length - 1]!, count });
      // relink next pointers
      for (let i = 0; i < ids.length; i++) {
        const f = this.pool.get(ids[i]!);
        f.page.setNext(i + 1 < ids.length ? ids[i + 1]! : 0);
        this.pool.unpin(ids[i]!, true);
      }
    }
  }

  /** Full secondary index rebuild from chat pages (open fallback). */
  private rebuildMsgIndex(): void {
    this.msgIndex.clear();
    for (let id = 1; id < this.heap.sizePages; id++) {
      let page: Page;
      try {
        page = this.heap.readPage(id);
      } catch {
        continue;
      }
      if (page.type !== PageType.Chat) continue;
      const chatId = Number(page.buf.readBigInt64LE(32));
      for (let slot = 0; slot < page.nslots; slot++) {
        const t = page.getTuple(slot);
        if (!t) continue;
        const msg = decodeChatTuple(t);
        this.msgIndex.set(chatId, msg.messageId, id, slot);
      }
    }
  }

  private freelistHead(): number {
    const f = this.pool.get(0);
    const head = f.page.buf.readUInt32LE(32);
    this.pool.unpin(0, false);
    return head;
  }

  private setFreelistHead(head: number): void {
    const f = this.pool.get(0);
    f.page.buf.writeUInt32LE(head >>> 0, 32);
    this.pool.unpin(0, true);
  }

  private allocPage(type: PageType): number {
    const head = this.freelistHead();
    if (head > 0) {
      const f = this.pool.get(head);
      const next = f.page.nextPageId;
      const fresh = Page.alloc(head, type);
      f.page.buf.set(fresh.buf);
      this.pool.unpin(head, true);
      this.setFreelistHead(next);
      return head;
    }
    const p = Page.alloc(this.heap.sizePages, type);
    return this.heap.appendPage(p);
  }

  private freePage(pageId: number): void {
    if (pageId <= 4) return; // never free roots
    const head = this.freelistHead();
    const f = this.pool.get(pageId);
    const fresh = Page.alloc(pageId, PageType.Free);
    fresh.setNext(head);
    f.page.buf.set(fresh.buf);
    this.pool.unpin(pageId, true);
    this.setFreelistHead(pageId);
  }

  private replayWal(): void {
    const records = RedoWal.replay(join(this.path, 'wal', 'redo.wal'));
    for (const rec of records) {
      if (rec.lsn < this.checkpointLsn) continue;
      this.applyWal(rec.type, rec.payload, rec.lsn, false);
      if (rec.lsn + 1n > this.lsn) this.lsn = rec.lsn + 1n;
    }
  }

  private applyWal(type: WalType, payload: Buffer, lsn: bigint, _fromLive: boolean): void {
    switch (type) {
      case WalType.InsertTuple: {
        // payload: pageId u32 | chatId i64 | tuple
        const pageId = payload.readUInt32LE(0);
        const chatId = Number(payload.readBigInt64LE(4));
        const tuple = payload.subarray(12);
        this.heap.ensurePageCount(pageId + 1);
        const f = this.pool.get(pageId);
        if (f.page.type === PageType.Free || f.page.nslots === 0) {
          f.page.setType(PageType.Chat);
          f.page.buf.writeBigInt64LE(BigInt(chatId), 32);
        }
        // idempotent-ish: only insert if not already present same messageId
        const msgId = decodeChatTuple(tuple).messageId;
        let slot = -1;
        for (let s = 0; s < f.page.nslots; s++) {
          const t = f.page.getTuple(s);
          if (t && decodeChatTuple(t).messageId === msgId) {
            slot = s;
            break;
          }
        }
        if (slot < 0) {
          slot = f.page.insert(tuple);
        }
        if (slot >= 0) this.msgIndex.set(chatId, msgId, pageId, slot);
        f.page.setLsn(lsn);
        this.pool.unpin(pageId, true);
        break;
      }
      case WalType.LinkChatPage: {
        // payload: chatId i64 | pageId u32 | prevTail u32
        const chatId = Number(payload.readBigInt64LE(0));
        const pageId = payload.readUInt32LE(8);
        const prevTail = payload.readUInt32LE(12);
        this.heap.ensurePageCount(pageId + 1);
        const f = this.pool.get(pageId);
        f.page.setType(PageType.Chat);
        f.page.buf.writeBigInt64LE(BigInt(chatId), 32);
        f.page.setLsn(lsn);
        this.pool.unpin(pageId, true);
        if (prevTail) {
          const pf = this.pool.get(prevTail);
          pf.page.setNext(pageId);
          this.pool.unpin(prevTail, true);
        }
        const tip = this.chatTips.get(chatId) ?? { head: pageId, tail: pageId, count: 0 };
        if (!tip.head) tip.head = pageId;
        tip.tail = pageId;
        this.chatTips.set(chatId, tip);
        break;
      }
      case WalType.SetHot: {
        const { key, value, expiresAt } = decodeHot(payload);
        this.writeHotLocal(key, value, expiresAt, lsn);
        break;
      }
      case WalType.DelHot: {
        const key = payload.toString('utf8');
        this.deleteHotLocal(key, lsn);
        break;
      }
      case WalType.AckImpulse: {
        const id = payload.toString('utf8');
        this.removeImpulseLocal(id, lsn);
        break;
      }
      case WalType.TrimChat: {
        const chatId = Number(payload.readBigInt64LE(0));
        const keep = payload.readUInt32LE(8);
        this.trimChatLocal(chatId, keep);
        break;
      }
      case WalType.EnqueueImpulse: {
        this.insertIntoChain(this.impulsePageId, PageType.Impulse, payload, lsn);
        break;
      }
      case WalType.UpsertBond: {
        this.insertIntoChain(this.bondPageId, PageType.Bond, payload, lsn);
        break;
      }
      case WalType.UpsertRecall: {
        const r = decodeRecall(payload);
        this.recallMem = this.recallMem.filter(
          (x) => !(x.chatId === r.chatId && x.messageId === r.messageId),
        );
        this.recallMem.push(r);
        this.insertIntoChain(this.recallPageId, PageType.Recall, payload, lsn);
        break;
      }
      case WalType.Checkpoint:
        this.checkpointLsn = lsn + 1n;
        break;
      default:
        break;
    }
  }

  private writeHotLocal(key: string, value: Buffer, expiresAt: number, lsn: bigint): void {
    const tup = encodeHot(key, value, expiresAt);
    const pageId = this.hotPageId;

    // Phase 1: Walk the full page chain, collect all non-matching tuples,
    // and clear every page in the chain. The old MVP code only looked at page 1
    // and dropped all other keys on overflow — a silent data-loss bug.
    const kept: Buffer[] = [];
    const chainPageIds: number[] = [];
    let chainPageId = pageId;
    for (;;) {
      const cf = this.pool.get(chainPageId);
      chainPageIds.push(chainPageId);
      for (const t of cf.page.allTuples()) {
        const h = decodeHot(t);
        if (h.key !== key) kept.push(t);
      }
      const next = cf.page.nextPageId;
      // Clear the page and break the chain link.
      const cleared = Page.alloc(chainPageId, PageType.Hot);
      cf.page.buf.set(cleared.buf);
      cf.page.setLsn(lsn);
      this.pool.unpin(chainPageId, true);
      if (!next) break;
      chainPageId = next;
    }

    // Phase 2: Re-insert all kept tuples + the new tuple via insertIntoChain
    // starting from the first page. This naturally distributes across overflow
    // pages (reusing the cleared chain pages or allocating new ones).
    const allTuples = [...kept, tup];
    for (const t of allTuples) {
      this.insertIntoChain(pageId, PageType.Hot, t, lsn);
    }

    // Update hot_index: the key is now somewhere in the chain.
    // We don't track per-key page placement (MVP), but hotGet walks the chain.
    this.hotIndex.set(key, pageId);
  }

  private insertIntoChain(rootId: number, type: PageType, tuple: Buffer, lsn: bigint): number {
    let pageId = rootId;
    for (;;) {
      const f = this.pool.get(pageId);
      if (f.page.type === PageType.Free) f.page.setType(type);
      const slot = f.page.insert(tuple);
      if (slot >= 0) {
        f.page.setLsn(lsn);
        this.pool.unpin(pageId, true);
        return pageId;
      }
      const next = f.page.nextPageId;
      this.pool.unpin(pageId, false);
      if (next) {
        pageId = next;
        continue;
      }
      // alloc
      const newId = this.allocPage(type);
      const pf = this.pool.get(pageId);
      pf.page.setNext(newId);
      this.pool.unpin(pageId, true);
      const nf = this.pool.get(newId);
      nf.page.insert(tuple);
      nf.page.setLsn(lsn);
      this.pool.unpin(newId, true);
      return newId;
    }
  }

  private log(type: WalType, payload: Buffer): bigint {
    const lsn = this.wal.append(type, payload);
    this.lsn = lsn + 1n;
    this.appends += 1;
    if (this.appends >= this.syncEvery) {
      this.wal.sync();
      this.appends = 0;
    }
    return lsn;
  }

  private persistMeta(): void {
    const p = join(this.path, 'ENGINE.json');
    const tmp = p + '.tmp';
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          schema: SCHEMA_VERSION,
          lsn: this.lsn.toString(),
          checkpointLsn: this.checkpointLsn.toString(),
        },
        null,
        2,
      ),
    );
    renameSync(tmp, p);
  }

  // ── ChatLog ──

  chatAppend(
    chatId: number,
    msg: {
      messageId: number;
      ts: number;
      uid: number;
      role: 'user' | 'assistant' | 'system';
      text: string;
      bodyFormat?: 'text' | 'json';
    },
  ): void {
    if (this.closed) throw new Error('nyatdb_closed');
    const role = msg.role === 'assistant' ? 1 : msg.role === 'system' ? 2 : 0;
    const tuple = encodeChatTuple({
      messageId: msg.messageId,
      ts: msg.ts,
      uid: msg.uid,
      role,
      text: msg.text,
      bodyFormat: msg.bodyFormat ?? 'text',
    });

    let tip = this.chatTips.get(chatId);
    if (!tip) {
      const pageId = this.allocPage(PageType.Chat);
      const f0 = this.pool.get(pageId);
      f0.page.buf.writeBigInt64LE(BigInt(chatId), 32);
      this.pool.unpin(pageId, true);
      const link = Buffer.alloc(16);
      link.writeBigInt64LE(BigInt(chatId), 0);
      link.writeUInt32LE(pageId, 8);
      link.writeUInt32LE(0, 12);
      const lsn = this.log(WalType.LinkChatPage, link);
      this.applyWal(WalType.LinkChatPage, link, lsn, true);
      tip = this.chatTips.get(chatId)!;
    }

    let pageId = tip.tail;
    let f = this.pool.get(pageId);
    let slot = f.page.insert(tuple);
    if (slot < 0) {
      this.pool.unpin(pageId, false);
      const newId = this.allocPage(PageType.Chat);
      const nf = this.pool.get(newId);
      nf.page.buf.writeBigInt64LE(BigInt(chatId), 32);
      this.pool.unpin(newId, true);
      const link = Buffer.alloc(16);
      link.writeBigInt64LE(BigInt(chatId), 0);
      link.writeUInt32LE(newId, 8);
      link.writeUInt32LE(pageId, 12);
      const lsnLink = this.log(WalType.LinkChatPage, link);
      this.applyWal(WalType.LinkChatPage, link, lsnLink, true);
      pageId = newId;
      f = this.pool.get(pageId);
      slot = f.page.insert(tuple);
    }
    this.pool.unpin(pageId, true);
    if (slot < 0) throw new Error('nyatdb: chat insert failed');

    const payload = Buffer.alloc(12 + tuple.length);
    payload.writeUInt32LE(pageId, 0);
    payload.writeBigInt64LE(BigInt(chatId), 4);
    tuple.copy(payload, 12);
    const lsn = this.log(WalType.InsertTuple, payload);
    const f2 = this.pool.get(pageId);
    f2.page.setLsn(lsn);
    this.pool.unpin(pageId, true);

    tip = this.chatTips.get(chatId)!;
    tip.count += 1;
    tip.tail = pageId;
    this.chatTips.set(chatId, tip);
    this.msgIndex.set(chatId, msg.messageId, pageId, slot);
    this.pushChatRing(chatId, decodeChatTuple(tuple));
  }

  private pushChatRing(chatId: number, rec: ChatTuple): void {
    let ring = this.chatRecentRing.get(chatId);
    if (!ring) {
      ring = [];
      this.chatRecentRing.set(chatId, ring);
    }
    ring.push(rec);
    if (ring.length > this.chatRingMax) {
      ring.splice(0, ring.length - this.chatRingMax);
    }
  }

  /** Walk from tail pages to fill recent ring after open. */
  private warmChatRings(): void {
    this.chatRecentRing.clear();
    for (const [chatId, tip] of this.chatTips) {
      const collected: ChatTuple[] = [];
      // walk chain from head but only keep last chatRingMax (cheap enough at open)
      let pageId = tip.head;
      const guard = new Set<number>();
      while (pageId && !guard.has(pageId)) {
        guard.add(pageId);
        const f = this.pool.get(pageId);
        for (const t of f.page.allTuples()) collected.push(decodeChatTuple(t));
        const next = f.page.nextPageId;
        this.pool.unpin(pageId, false);
        pageId = next;
      }
      this.chatRecentRing.set(
        chatId,
        collected.length > this.chatRingMax
          ? collected.slice(-this.chatRingMax)
          : collected,
      );
    }
  }

  chatRecent(chatId: number, limit = 50): Array<ChatTuple & { roleName: string }> {
    const want = limit > 0 ? limit : this.chatRingMax;
    let all: ChatTuple[] = [];
    const ring = this.chatRecentRing.get(chatId);
    if (ring && ring.length > 0 && want <= ring.length) {
      all = ring.slice();
    } else {
      const tip = this.chatTips.get(chatId);
      if (!tip) return [];
      let pageId = tip.head;
      const guard = new Set<number>();
      while (pageId && !guard.has(pageId)) {
        guard.add(pageId);
        const f = this.pool.get(pageId);
        for (const t of f.page.allTuples()) all.push(decodeChatTuple(t));
        const next = f.page.nextPageId;
        this.pool.unpin(pageId, false);
        pageId = next;
      }
    }
    // Hole backfills may append out of arrival order — order by time/id for recent.
    all.sort((a, b) => a.ts - b.ts || a.messageId - b.messageId);
    this.chatRecentRing.set(
      chatId,
      all.length > this.chatRingMax ? all.slice(-this.chatRingMax) : all,
    );
    const slice = want > 0 ? all.slice(-want) : all;
    return slice.map((t) => ({
      ...t,
      roleName: t.role === 1 ? 'assistant' : t.role === 2 ? 'system' : 'user',
    }));
  }

  /** Secondary-index point lookup O(1) memory + 1 page touch. */
  chatGet(chatId: number, messageId: number): (ChatTuple & { roleName: string }) | null {
    const packed = this.msgIndex.getPacked(chatId, messageId);
    if (packed === undefined) return null;
    const pageId = (packed / 0x10000) | 0;
    const slot = packed & 0xffff;
    const page = this.pool.peek(pageId);
    const tup = page.getTupleView(slot);
    if (!tup) return null;
    const t = decodeChatTuple(tup);
    if (t.messageId !== messageId) return null;
    return {
      messageId: t.messageId,
      ts: t.ts,
      uid: t.uid,
      role: t.role,
      text: t.text,
      roleName: t.role === 1 ? 'assistant' : t.role === 2 ? 'system' : 'user',
    };
  }

  /**
   * Keep only the last `keep` messages for a chat; free older pages.
   * Updates secondary index + ring.
   */
  chatTrimKeepLast(chatId: number, keep: number): void {
    if (this.closed) throw new Error('nyatdb_closed');
    const payload = Buffer.alloc(12);
    payload.writeBigInt64LE(BigInt(chatId), 0);
    payload.writeUInt32LE(Math.max(0, keep) >>> 0, 8);
    const lsn = this.log(WalType.TrimChat, payload);
    void lsn;
    this.trimChatLocal(chatId, keep);
  }

  private trimChatLocal(chatId: number, keep: number): void {
    const tip = this.chatTips.get(chatId);
    if (!tip || tip.count <= keep) return;

    // 1) Collect all messages in order
    const all: ChatTuple[] = [];
    const oldPages: number[] = [];
    let pageId = tip.head;
    const guard = new Set<number>();
    while (pageId && !guard.has(pageId)) {
      guard.add(pageId);
      oldPages.push(pageId);
      const f = this.pool.get(pageId);
      for (const t of f.page.allTuples()) all.push(decodeChatTuple(t));
      const next = f.page.nextPageId;
      this.pool.unpin(pageId, false);
      pageId = next;
    }

    const kept = keep > 0 ? all.slice(-keep) : [];
    // Drop index entries for this chat
    this.msgIndex.deleteChat(chatId);

    // 2) Free old pages
    for (const pid of oldPages) this.freePage(pid);

    // 3) Rewrite kept messages into a fresh chain
    if (!kept.length) {
      this.chatTips.delete(chatId);
      this.chatRecentRing.delete(chatId);
      return;
    }

    let head = 0;
    let tail = 0;
    let count = 0;
    let cur = this.allocPage(PageType.Chat);
    {
      const f = this.pool.get(cur);
      f.page.buf.writeBigInt64LE(BigInt(chatId), 32);
      this.pool.unpin(cur, true);
    }
    head = cur;
    tail = cur;

    for (const m of kept) {
      const tuple = encodeChatTuple(m);
      let f = this.pool.get(cur);
      let slot = f.page.insert(tuple);
      if (slot < 0) {
        this.pool.unpin(cur, false);
        const nextId = this.allocPage(PageType.Chat);
        const nf = this.pool.get(nextId);
        nf.page.buf.writeBigInt64LE(BigInt(chatId), 32);
        this.pool.unpin(nextId, true);
        const pf = this.pool.get(cur);
        pf.page.setNext(nextId);
        this.pool.unpin(cur, true);
        cur = nextId;
        tail = cur;
        f = this.pool.get(cur);
        slot = f.page.insert(tuple);
      }
      this.pool.unpin(cur, true);
      if (slot >= 0) {
        this.msgIndex.set(chatId, m.messageId, cur, slot);
        count += 1;
      }
    }

    this.chatTips.set(chatId, { head, tail, count });
    this.chatRecentRing.set(
      chatId,
      kept.length > this.chatRingMax ? kept.slice(-this.chatRingMax) : kept,
    );
  }

  // ── HotState ──

  hotSet(key: string, value: string | Buffer, ttlMs = 0): void {
    const v = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : 0;
    const tup = encodeHot(key, v, expiresAt);
    const lsn = this.log(WalType.SetHot, tup);
    this.applyWal(WalType.SetHot, tup, lsn, true);
  }

  hotGet(key: string): Buffer | null {
    const startPageId = this.hotIndex.get(key) ?? this.hotPageId;
    // Walk the page chain — the key may be on an overflow page.
    let pageId = startPageId;
    for (;;) {
      const f = this.pool.get(pageId);
      for (const t of f.page.allTuples()) {
        const h = decodeHot(t);
        if (h.key === key) {
          if (h.expiresAt > 0 && h.expiresAt <= Date.now()) {
            this.pool.unpin(pageId, false);
            return null;
          }
          this.pool.unpin(pageId, false);
          return h.value;
        }
      }
      const next = f.page.nextPageId;
      this.pool.unpin(pageId, false);
      if (!next) break;
      pageId = next;
    }
    return null;
  }

  hotGetString(key: string): string | null {
    const b = this.hotGet(key);
    return b ? b.toString('utf8') : null;
  }

  hotDel(key: string): void {
    const payload = Buffer.from(key, 'utf8');
    const lsn = this.log(WalType.DelHot, payload);
    this.applyWal(WalType.DelHot, payload, lsn, true);
  }

  private deleteHotLocal(key: string, lsn: bigint): void {
    const startPageId = this.hotIndex.get(key) ?? this.hotPageId;
    // Walk the full chain and remove the key from whichever page it's on.
    let pageId = startPageId;
    for (;;) {
      const f = this.pool.get(pageId);
      let found = false;
      const kept: Buffer[] = [];
      for (const t of f.page.allTuples()) {
        const h = decodeHot(t);
        if (h.key === key) {
          found = true;
        } else {
          kept.push(t);
        }
      }
      if (found) {
        const fresh = Page.alloc(pageId, PageType.Hot);
        for (const t of kept) fresh.insert(t);
        f.page.buf.set(fresh.buf);
        f.page.setLsn(lsn);
      }
      const next = f.page.nextPageId;
      this.pool.unpin(pageId, found);
      if (!next) break;
      pageId = next;
    }
    this.hotIndex.delete(key);
  }

  // ── Impulse ──

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
    const tup = encodeImpulse({
      id: job.id,
      chatId: job.chatId,
      runAt: job.runAt,
      kind: job.kind,
      payload,
    });
    const lsn = this.log(WalType.EnqueueImpulse, tup);
    this.applyWal(WalType.EnqueueImpulse, tup, lsn, true);
  }

  impulseDue(now = Date.now(), limit = 32): ImpulseTuple[] {
    const out: ImpulseTuple[] = [];
    let pageId = this.impulsePageId;
    const guard = new Set<number>();
    while (pageId && !guard.has(pageId) && out.length < limit) {
      guard.add(pageId);
      const f = this.pool.get(pageId);
      for (const t of f.page.allTuples()) {
        const job = decodeImpulse(t);
        if (job.runAt <= now) out.push(job);
      }
      const next = f.page.nextPageId;
      this.pool.unpin(pageId, false);
      pageId = next;
    }
    return out.sort((a, b) => a.runAt - b.runAt).slice(0, limit);
  }

  impulseAck(id: string): void {
    const payload = Buffer.from(id, 'utf8');
    const lsn = this.log(WalType.AckImpulse, payload);
    this.applyWal(WalType.AckImpulse, payload, lsn, true);
  }

  private removeImpulseLocal(id: string, lsn: bigint): void {
    let pageId = this.impulsePageId;
    const guard = new Set<number>();
    while (pageId && !guard.has(pageId)) {
      guard.add(pageId);
      const f = this.pool.get(pageId);
      const kept: Buffer[] = [];
      for (const t of f.page.allTuples()) {
        const job = decodeImpulse(t);
        if (job.id !== id) kept.push(t);
      }
      const next = f.page.nextPageId;
      const fresh = Page.alloc(pageId, PageType.Impulse);
      fresh.setNext(next);
      for (const t of kept) fresh.insert(t);
      f.page.buf.set(fresh.buf);
      f.page.setLsn(lsn);
      this.pool.unpin(pageId, true);
      pageId = next;
    }
  }

  // ── Bond ──

  bondUpsert(b: BondTuple): void {
    const tup = encodeBond(b);
    const lsn = this.log(WalType.UpsertBond, tup);
    this.applyWal(WalType.UpsertBond, tup, lsn, true);
  }

  bondList(limit = 100): BondTuple[] {
    const out: BondTuple[] = [];
    let pageId = this.bondPageId;
    const guard = new Set<number>();
    while (pageId && !guard.has(pageId)) {
      guard.add(pageId);
      const f = this.pool.get(pageId);
      for (const t of f.page.allTuples()) out.push(decodeBond(t));
      const next = f.page.nextPageId;
      this.pool.unpin(pageId, false);
      pageId = next;
    }
    return out.slice(0, limit);
  }

  // ── Recall ──

  recallUpsert(opts: {
    chatId: number;
    messageId: number;
    visibility?: number;
    vector: Float32Array | number[];
  }): void {
    const vector =
      opts.vector instanceof Float32Array
        ? opts.vector
        : Float32Array.from(opts.vector);
    if (vector.length !== RECALL_DIM) throw new Error(`recall expects ${RECALL_DIM}-d`);
    const tup = encodeRecall(opts.chatId, opts.messageId, opts.visibility ?? 1, vector);
    const lsn = this.log(WalType.UpsertRecall, tup);
    this.applyWal(WalType.UpsertRecall, tup, lsn, true);
  }

  recallSearch(
    query: Float32Array | number[],
    opts?: { chatId?: number; topK?: number; minVisibility?: number },
  ): Array<{ chatId: number; messageId: number; score: number }> {
    const q = query instanceof Float32Array ? query : Float32Array.from(query);
    const topK = opts?.topK ?? 5;
    // visibility: 0=private, 1=contextual, 2=public. Higher = more accessible.
    // minVisibility filters OUT memories below the threshold. Default 1
    // excludes private (0) — cross-context callers shouldn't see private
    // memories from other chats. Set to 0 to include everything (admin/debug).
    const minVis = opts?.minVisibility ?? 1;
    const scored = this.recallMem
      .filter((r) => r.visibility >= minVis)
      .filter((r) => (opts?.chatId === undefined ? true : r.chatId === opts.chatId))
      .map((r) => ({
        chatId: r.chatId,
        messageId: r.messageId,
        score: cosine(q, r.vector),
      }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  checkpoint(): void {
    this.pool.flushAll();
    this.heap.sync();
    const lsn = this.log(WalType.Checkpoint, Buffer.alloc(0));
    this.wal.sync();
    this.checkpointLsn = lsn + 1n;
    saveMsgIndex(this.path, this.msgIndex, this.checkpointLsn);
    this.persistMeta();
    this.wal.rotate();
  }

  /** CRC-check every page; throws on corruption. */
  verify(): { pages: number; ok: true } {
    for (let id = 0; id < this.heap.sizePages; id++) {
      this.heap.readPage(id, { checkCrc: true });
    }
    return { pages: this.heap.sizePages, ok: true };
  }

  stats(): {
    pages: number;
    pool: { cached: number; dirty: number };
    chats: number;
    recalls: number;
    indexed: number;
    lsn: string;
  } {
    return {
      pages: this.heap.sizePages,
      pool: this.pool.stats(),
      chats: this.chatTips.size,
      recalls: this.recallMem.length,
      indexed: this.msgIndex.size,
      lsn: this.lsn.toString(),
    };
  }

  close(opts?: { skipCheckpoint?: boolean }): void {
    if (this.closed) return;
    if (!opts?.skipCheckpoint) this.checkpoint();
    this.wal.close();
    this.heap.close();
    this.closed = true;
  }
}
