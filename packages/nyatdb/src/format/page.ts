import { PAGE_HEADER_SIZE, PAGE_MAGIC, PAGE_SIZE, PageType } from './constants.js';
import { crc32 } from './crc32.js';

/**
 * Slotted page layout (4096B):
 *
 *  0..3   magic NYP1
 *  4      pageType
 *  5      flags
 *  6..9   pageId u32 LE
 *  10..17 lsn u64 LE
 *  18..19 nslots u16
 *  20..21 lower u16  (first free byte after header / tuples grow up)
 *  22..23 upper u16  (first byte of slot dir; dir grows down)
 *  24..27 crc32 (header+body with this field zeroed)
 *  28..31 nextPageId u32 (0 = none) — chain for ChatLog / lists
 *  32..63 reserved
 *  64..lower-1  tuple bytes
 *  upper..4095  slot directory: [offset u16][len u16] * nslots (slot0 at end)
 */

export class Page {
  readonly buf: Buffer;

  constructor(buf?: Buffer) {
    this.buf = buf ?? Buffer.alloc(PAGE_SIZE);
    if (!buf) {
      PAGE_MAGIC.copy(this.buf, 0);
      this.buf.writeUInt16LE(PAGE_HEADER_SIZE, 20); // lower
      this.buf.writeUInt16LE(PAGE_SIZE, 22); // upper
    }
  }

  static alloc(pageId: number, type: PageType): Page {
    const p = new Page();
    p.setPageId(pageId);
    p.setType(type);
    p.setLsn(0n);
    p.setNext(0);
    p.recomputeCrc();
    return p;
  }

  get type(): PageType {
    return this.buf.readUInt8(4) as PageType;
  }
  setType(t: PageType): void {
    this.buf.writeUInt8(t, 4);
  }

  get pageId(): number {
    return this.buf.readUInt32LE(6);
  }
  setPageId(id: number): void {
    this.buf.writeUInt32LE(id >>> 0, 6);
  }

  get lsn(): bigint {
    return this.buf.readBigUInt64LE(10);
  }
  setLsn(lsn: bigint): void {
    this.buf.writeBigUInt64LE(lsn, 10);
  }

  get nslots(): number {
    return this.buf.readUInt16LE(18);
  }
  private setNslots(n: number): void {
    this.buf.writeUInt16LE(n, 18);
  }

  get lower(): number {
    return this.buf.readUInt16LE(20);
  }
  private setLower(v: number): void {
    this.buf.writeUInt16LE(v, 20);
  }

  get upper(): number {
    return this.buf.readUInt16LE(22);
  }
  private setUpper(v: number): void {
    this.buf.writeUInt16LE(v, 22);
  }

  get nextPageId(): number {
    return this.buf.readUInt32LE(28);
  }
  setNext(id: number): void {
    this.buf.writeUInt32LE(id >>> 0, 28);
  }

  freeSpace(): number {
    return this.upper - this.lower - 4; // need 4B for new slot entry
  }

  /** Insert tuple; returns slot index or -1 if full. */
  insert(tuple: Buffer): number {
    const need = tuple.length + 4;
    if (this.freeSpace() < tuple.length) return -1;
    if (this.upper - this.lower < need) return -1;
    const off = this.lower;
    tuple.copy(this.buf, off);
    const newLower = off + tuple.length;
    const newUpper = this.upper - 4;
    this.buf.writeUInt16LE(off, newUpper);
    this.buf.writeUInt16LE(tuple.length, newUpper + 2);
    this.setLower(newLower);
    this.setUpper(newUpper);
    const slot = this.nslots;
    this.setNslots(slot + 1);
    return slot;
  }

  getTuple(slot: number): Buffer | null {
    const view = this.getTupleView(slot);
    return view ? Buffer.from(view) : null;
  }

  /** Zero-copy view into page buffer (valid until page is mutated/evicted). */
  getTupleView(slot: number): Buffer | null {
    if (slot < 0 || slot >= this.nslots) return null;
    const dir = PAGE_SIZE - (slot + 1) * 4;
    const off = this.buf.readUInt16LE(dir);
    const len = this.buf.readUInt16LE(dir + 2);
    if (off < PAGE_HEADER_SIZE || off + len > this.lower) return null;
    return this.buf.subarray(off, off + len);
  }

  allTuples(): Buffer[] {
    const out: Buffer[] = [];
    for (let i = 0; i < this.nslots; i++) {
      const t = this.getTuple(i);
      if (t) out.push(t);
    }
    return out;
  }

  verifyMagic(): boolean {
    return this.buf.subarray(0, 4).equals(PAGE_MAGIC);
  }

  recomputeCrc(): void {
    this.buf.writeUInt32LE(0, 24);
    const c = crc32(this.buf);
    this.buf.writeUInt32LE(c, 24);
  }

  checkCrc(): boolean {
    const stored = this.buf.readUInt32LE(24);
    this.buf.writeUInt32LE(0, 24);
    const c = crc32(this.buf);
    this.buf.writeUInt32LE(stored, 24);
    return c === stored;
  }
}
