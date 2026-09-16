import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { WAL_MAGIC, WalType } from '../format/constants.js';
import { crc32 } from '../format/crc32.js';

export interface WalRecord {
  lsn: bigint;
  type: WalType;
  payload: Buffer;
}

/**
 * Binary redo WAL.
 * Frame: magic(4) | lsn u64 | type u8 | len u32 | payload | crc32
 */
export class RedoWal {
  readonly path: string;
  private fd: number;
  private lsn: bigint;
  private readonly dir: string;

  private constructor(dir: string, path: string, fd: number, lsn: bigint) {
    this.dir = dir;
    this.path = path;
    this.fd = fd;
    this.lsn = lsn;
  }

  static open(dir: string, startLsn: bigint): RedoWal {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'redo.wal');
    const fd = openSync(path, existsSync(path) ? 'a' : 'w');
    return new RedoWal(dir, path, fd, startLsn);
  }

  get nextLsn(): bigint {
    return this.lsn;
  }

  append(type: WalType, payload: Buffer): bigint {
    const lsn = this.lsn;
    this.lsn = lsn + 1n;
    const header = Buffer.alloc(4 + 8 + 1 + 4);
    WAL_MAGIC.copy(header, 0);
    header.writeBigUInt64LE(lsn, 4);
    header.writeUInt8(type, 12);
    header.writeUInt32LE(payload.length, 13);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(crc32(Buffer.concat([header, payload])));
    writeSync(this.fd, Buffer.concat([header, payload, crc]));
    return lsn;
  }

  sync(): void {
    fsyncSync(this.fd);
  }

  close(): void {
    fsyncSync(this.fd);
    closeSync(this.fd);
  }

  /** After checkpoint: drop old frames, start a fresh WAL at current LSN. */
  rotate(): void {
    this.sync();
    closeSync(this.fd);
    const bak = join(this.dir, `redo-${Date.now()}.wal.bak`);
    try {
      renameSync(this.path, bak);
    } catch {
      try {
        unlinkSync(this.path);
      } catch {
        /* empty */
      }
    }
    this.fd = openSync(this.path, 'w');
    try {
      unlinkSync(bak);
    } catch {
      /* keep bak if unlink fails */
    }
  }

  static replay(path: string): WalRecord[] {
    if (!existsSync(path)) return [];
    const buf = readFileSync(path);
    const out: WalRecord[] = [];
    let i = 0;
    while (i + 17 <= buf.length) {
      if (!buf.subarray(i, i + 4).equals(WAL_MAGIC)) break;
      const start = i;
      const lsn = buf.readBigUInt64LE(i + 4);
      const type = buf.readUInt8(i + 12) as WalType;
      const len = buf.readUInt32LE(i + 13);
      i += 17;
      if (i + len + 4 > buf.length) break;
      const payload = Buffer.from(buf.subarray(i, i + len));
      i += len;
      const want = buf.readUInt32LE(i);
      i += 4;
      const got = crc32(buf.subarray(start, i - 4));
      if (want !== got) break;
      out.push({ lsn, type, payload });
    }
    return out;
  }
}
