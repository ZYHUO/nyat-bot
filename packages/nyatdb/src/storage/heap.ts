import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { PAGE_SIZE, PageType } from '../format/constants.js';
import { Page } from '../format/page.js';

/** Single-file page heap: pageId * PAGE_SIZE → bytes. */
export class HeapFile {
  readonly path: string;
  private fd: number;
  private pageCount: number;

  private constructor(path: string, fd: number, pageCount: number) {
    this.path = path;
    this.fd = fd;
    this.pageCount = pageCount;
  }

  static open(dir: string): HeapFile {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'heap.ndb');
    const fd = openSync(path, existsSync(path) ? 'r+' : 'w+');
    const size = fstatSync(fd).size;
    let pageCount = Math.floor(size / PAGE_SIZE);
    if (pageCount === 0) {
      const superPage = Page.alloc(0, PageType.Super);
      superPage.recomputeCrc();
      writeSync(fd, superPage.buf, 0, PAGE_SIZE, 0);
      fsyncSync(fd);
      pageCount = 1;
    }
    return new HeapFile(path, fd, pageCount);
  }

  get sizePages(): number {
    return this.pageCount;
  }

  readPage(pageId: number, opts?: { checkCrc?: boolean }): Page {
    if (pageId < 0 || pageId >= this.pageCount) {
      throw new Error(`heap: bad pageId ${pageId}`);
    }
    const buf = Buffer.allocUnsafe(PAGE_SIZE);
    readSync(this.fd, buf, 0, PAGE_SIZE, pageId * PAGE_SIZE);
    const page = new Page(buf);
    if (!page.verifyMagic()) throw new Error(`heap: bad magic page ${pageId}`);
    // CRC on every read is ~SQLite-BTree-costly; default off (use verify() / VERIFY_ON_OPEN).
    if (opts?.checkCrc && !page.checkCrc()) throw new Error(`heap: crc fail page ${pageId}`);
    return page;
  }

  writePage(pageId: number, page: Page): void {
    page.recomputeCrc();
    writeSync(this.fd, page.buf, 0, PAGE_SIZE, pageId * PAGE_SIZE);
  }

  appendPage(page: Page): number {
    const id = this.pageCount;
    page.setPageId(id);
    page.recomputeCrc();
    writeSync(this.fd, page.buf, 0, PAGE_SIZE, id * PAGE_SIZE);
    this.pageCount += 1;
    return id;
  }

  /** Reserve pageId by extending file (for WAL redo alloc). */
  ensurePageCount(n: number): void {
    while (this.pageCount < n) {
      const p = Page.alloc(this.pageCount, PageType.Free);
      this.appendPage(p);
    }
  }

  sync(): void {
    fsyncSync(this.fd);
  }

  close(): void {
    fsyncSync(this.fd);
    closeSync(this.fd);
  }
}
