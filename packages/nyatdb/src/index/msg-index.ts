import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export interface MsgLoc {
  pageId: number;
  slot: number;
}

const MAGIC = Buffer.from('NIDX');
const SLOT_MASK = 0xffff;

/** Pack pageId+slot into one safe integer (pageId < 2^37). */
export function packLoc(pageId: number, slot: number): number {
  return pageId * 0x10000 + (slot & SLOT_MASK);
}

export function unpackLoc(packed: number): MsgLoc {
  return { pageId: (packed / 0x10000) | 0, slot: packed & SLOT_MASK };
}

/**
 * Compact secondary index: chatId → (messageId → packed page/slot).
 * No string keys, no per-entry objects — far less RAM than Map<string, MsgLoc>.
 */
export class CompactMsgIndex {
  private readonly byChat = new Map<number, Map<number, number>>();
  private _size = 0;

  get size(): number {
    return this._size;
  }

  clear(): void {
    this.byChat.clear();
    this._size = 0;
  }

  set(chatId: number, messageId: number, pageId: number, slot: number): void {
    let m = this.byChat.get(chatId);
    if (!m) {
      m = new Map();
      this.byChat.set(chatId, m);
    }
    if (!m.has(messageId)) this._size += 1;
    m.set(messageId, packLoc(pageId, slot));
  }

  /** Hot path: packed int or undefined. */
  getPacked(chatId: number, messageId: number): number | undefined {
    return this.byChat.get(chatId)?.get(messageId);
  }

  get(chatId: number, messageId: number): MsgLoc | undefined {
    const p = this.getPacked(chatId, messageId);
    return p === undefined ? undefined : unpackLoc(p);
  }

  delete(chatId: number, messageId: number): void {
    const m = this.byChat.get(chatId);
    if (!m) return;
    if (m.delete(messageId)) this._size -= 1;
    if (m.size === 0) this.byChat.delete(chatId);
  }

  deleteChat(chatId: number): void {
    const m = this.byChat.get(chatId);
    if (!m) return;
    this._size -= m.size;
    this.byChat.delete(chatId);
  }

  forEach(fn: (chatId: number, messageId: number, pageId: number, slot: number) => void): void {
    for (const [chatId, m] of this.byChat) {
      for (const [messageId, packed] of m) {
        fn(chatId, messageId, (packed / 0x10000) | 0, packed & SLOT_MASK);
      }
    }
  }
}

/** @deprecated prefer CompactMsgIndex */
export function msgKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId >>> 0}`;
}

/** Persist secondary index: (chatId, messageId) → page/slot. */
export function saveMsgIndex(
  dir: string,
  index: CompactMsgIndex,
  checkpointLsn: bigint,
): void {
  mkdirSync(join(dir, 'snap'), { recursive: true });
  const n = index.size;
  const body = Buffer.alloc(4 + 8 + 4 + n * 18);
  let o = 0;
  MAGIC.copy(body, o);
  o += 4;
  body.writeBigUInt64LE(checkpointLsn, o);
  o += 8;
  body.writeUInt32LE(n, o);
  o += 4;
  index.forEach((chatId, messageId, pageId, slot) => {
    body.writeBigInt64LE(BigInt(chatId), o);
    o += 8;
    body.writeUInt32LE(messageId >>> 0, o);
    o += 4;
    body.writeUInt32LE(pageId >>> 0, o);
    o += 4;
    body.writeUInt16LE(slot, o);
    o += 2;
  });
  const z = zstdCompressSync(body);
  const out = Buffer.alloc(1 + z.length);
  out.writeUInt8(1, 0);
  z.copy(out, 1);
  const path = join(dir, 'snap', 'msg.idx');
  const tmp = path + '.tmp';
  writeFileSync(tmp, out);
  renameSync(tmp, path);
}

export function loadMsgIndex(dir: string, expectLsn: bigint): CompactMsgIndex | null {
  const path = join(dir, 'snap', 'msg.idx');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path);
    const algo = raw.readUInt8(0);
    const body = algo === 1 ? zstdDecompressSync(raw.subarray(1)) : raw.subarray(1);
    if (!body.subarray(0, 4).equals(MAGIC)) return null;
    const lsn = body.readBigUInt64LE(4);
    if (lsn !== expectLsn) return null;
    const n = body.readUInt32LE(12);
    const map = new CompactMsgIndex();
    let o = 16;
    for (let i = 0; i < n; i++) {
      const chatId = Number(body.readBigInt64LE(o));
      o += 8;
      const messageId = body.readUInt32LE(o);
      o += 4;
      const pageId = body.readUInt32LE(o);
      o += 4;
      const slot = body.readUInt16LE(o);
      o += 2;
      map.set(chatId, messageId, pageId, slot);
    }
    return map;
  } catch {
    return null;
  }
}
