import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

/** Domain tuple codecs (binary, not JSON-as-primary). */

/** 0=raw text 1=zstd text 2=raw JSON 3=zstd JSON (FormattedMessage envelope). */
export type ChatBodyFormat = 'text' | 'json';

export interface ChatTuple {
  messageId: number;
  ts: number;
  uid: number;
  role: number; // 0 user 1 assistant 2 system
  text: string;
  /** Set on encode to pick algo 2/3; set on decode from algo. Default text. */
  bodyFormat?: ChatBodyFormat;
}

export function encodeChatTuple(t: ChatTuple): Buffer {
  const textBuf = Buffer.from(t.text, 'utf8');
  const isJson = t.bodyFormat === 'json';
  let body = textBuf;
  let useZ = false;
  if (textBuf.length >= 64) {
    const compressed = zstdCompressSync(textBuf);
    // Never expand: native/TS zstd can grow Chinese text past page free space.
    if (compressed.length < textBuf.length) {
      body = compressed;
      useZ = true;
    }
  }
  const algo = isJson ? (useZ ? 3 : 2) : useZ ? 1 : 0;
  const buf = Buffer.alloc(1 + 4 + 8 + 4 + 1 + 4 + body.length);
  let o = 0;
  buf.writeUInt8(algo, o++);
  buf.writeUInt32LE(t.messageId >>> 0, o);
  o += 4;
  buf.writeBigUInt64LE(BigInt(t.ts), o);
  o += 8;
  buf.writeUInt32LE(t.uid >>> 0, o);
  o += 4;
  buf.writeUInt8(t.role, o++);
  buf.writeUInt32LE(body.length, o);
  o += 4;
  body.copy(buf, o);
  return buf;
}

export function decodeChatTuple(buf: Buffer): ChatTuple {
  let o = 0;
  const algo = buf.readUInt8(o++);
  const messageId = buf.readUInt32LE(o);
  o += 4;
  const ts = Number(buf.readBigUInt64LE(o));
  o += 8;
  const uid = buf.readUInt32LE(o);
  o += 4;
  const role = buf.readUInt8(o++);
  const len = buf.readUInt32LE(o);
  o += 4;
  const raw = buf.subarray(o, o + len);
  const compressed = algo === 1 || algo === 3;
  const text = (compressed ? zstdDecompressSync(raw) : raw).toString('utf8');
  const bodyFormat: ChatBodyFormat = algo === 2 || algo === 3 ? 'json' : 'text';
  return { messageId, ts, uid, role, text, bodyFormat };
}

export function encodeHot(key: string, value: Buffer, expiresAt: number): Buffer {
  const kb = Buffer.from(key, 'utf8');
  const buf = Buffer.alloc(2 + kb.length + 8 + 4 + value.length);
  buf.writeUInt16LE(kb.length, 0);
  kb.copy(buf, 2);
  buf.writeBigUInt64LE(BigInt(expiresAt), 2 + kb.length);
  buf.writeUInt32LE(value.length, 2 + kb.length + 8);
  value.copy(buf, 2 + kb.length + 12);
  return buf;
}

export function decodeHot(buf: Buffer): { key: string; value: Buffer; expiresAt: number } {
  const klen = buf.readUInt16LE(0);
  const key = buf.subarray(2, 2 + klen).toString('utf8');
  const expiresAt = Number(buf.readBigUInt64LE(2 + klen));
  const vlen = buf.readUInt32LE(2 + klen + 8);
  const value = Buffer.from(buf.subarray(2 + klen + 12, 2 + klen + 12 + vlen));
  return { key, value, expiresAt };
}

export interface ImpulseTuple {
  id: string;
  chatId: number;
  runAt: number;
  kind: string;
  payload: Buffer;
}

export function encodeImpulse(t: ImpulseTuple): Buffer {
  const idb = Buffer.from(t.id, 'utf8');
  const kb = Buffer.from(t.kind, 'utf8');
  const buf = Buffer.alloc(2 + idb.length + 8 + 8 + 2 + kb.length + 4 + t.payload.length);
  let o = 0;
  buf.writeUInt16LE(idb.length, o);
  o += 2;
  idb.copy(buf, o);
  o += idb.length;
  buf.writeBigInt64LE(BigInt(t.chatId), o);
  o += 8;
  buf.writeBigUInt64LE(BigInt(t.runAt), o);
  o += 8;
  buf.writeUInt16LE(kb.length, o);
  o += 2;
  kb.copy(buf, o);
  o += kb.length;
  buf.writeUInt32LE(t.payload.length, o);
  o += 4;
  t.payload.copy(buf, o);
  return buf;
}

export function decodeImpulse(buf: Buffer): ImpulseTuple {
  let o = 0;
  const idl = buf.readUInt16LE(o);
  o += 2;
  const id = buf.subarray(o, o + idl).toString('utf8');
  o += idl;
  const chatId = Number(buf.readBigInt64LE(o));
  o += 8;
  const runAt = Number(buf.readBigUInt64LE(o));
  o += 8;
  const kl = buf.readUInt16LE(o);
  o += 2;
  const kind = buf.subarray(o, o + kl).toString('utf8');
  o += kl;
  const pl = buf.readUInt32LE(o);
  o += 4;
  const payload = Buffer.from(buf.subarray(o, o + pl));
  return { id, chatId, runAt, kind, payload };
}

export interface BondTuple {
  uid: number;
  chatId: number;
  score: number;
  note: string;
}

export function encodeBond(t: BondTuple): Buffer {
  const nb = Buffer.from(t.note, 'utf8');
  const buf = Buffer.alloc(4 + 8 + 4 + 2 + nb.length);
  buf.writeUInt32LE(t.uid >>> 0, 0);
  buf.writeBigInt64LE(BigInt(t.chatId), 4);
  buf.writeFloatLE(t.score, 12);
  buf.writeUInt16LE(nb.length, 16);
  nb.copy(buf, 18);
  return buf;
}

export function decodeBond(buf: Buffer): BondTuple {
  const uid = buf.readUInt32LE(0);
  const chatId = Number(buf.readBigInt64LE(4));
  const score = buf.readFloatLE(12);
  const nlen = buf.readUInt16LE(16);
  const note = buf.subarray(18, 18 + nlen).toString('utf8');
  return { uid, chatId, score, note };
}

/** Recall vector: chatId + messageId + visibility u8 + 384 * float32 */
export const RECALL_DIM = 384;

export function encodeRecall(
  chatId: number,
  messageId: number,
  visibility: number,
  vector: Float32Array,
): Buffer {
  if (vector.length !== RECALL_DIM) throw new Error('recall dim');
  const buf = Buffer.alloc(8 + 4 + 1 + RECALL_DIM * 4);
  buf.writeBigInt64LE(BigInt(chatId), 0);
  buf.writeUInt32LE(messageId >>> 0, 8);
  buf.writeUInt8(visibility, 12);
  for (let i = 0; i < RECALL_DIM; i++) buf.writeFloatLE(vector[i]!, 13 + i * 4);
  return buf;
}

export function decodeRecall(buf: Buffer): {
  chatId: number;
  messageId: number;
  visibility: number;
  vector: Float32Array;
} {
  const chatId = Number(buf.readBigInt64LE(0));
  const messageId = buf.readUInt32LE(8);
  const visibility = buf.readUInt8(12);
  const vector = new Float32Array(RECALL_DIM);
  for (let i = 0; i < RECALL_DIM; i++) vector[i] = buf.readFloatLE(13 + i * 4);
  return { chatId, messageId, visibility, vector };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
