import { Page } from '../format/page.js';
import { PAGE_SIZE } from '../format/constants.js';

export interface Frame {
  page: Page;
  dirty: boolean;
  pin: number;
  /** clock hand bit */
  ref: boolean;
}

/**
 * Fixed-size buffer pool over a heap file.
 * Eviction: clock algorithm; dirty pages flushed via onFlush.
 */
export class BufferPool {
  private readonly frames = new Map<number, Frame>();
  private readonly maxFrames: number;
  private clockKey = 0;
  private readonly onFlush: (pageId: number, page: Page) => void;
  private readonly onRead: (pageId: number) => Page;

  constructor(opts: {
    maxFrames: number;
    onRead: (pageId: number) => Page;
    onFlush: (pageId: number, page: Page) => void;
  }) {
    this.maxFrames = Math.max(8, opts.maxFrames);
    this.onRead = opts.onRead;
    this.onFlush = opts.onFlush;
  }

  get(pageId: number): Frame {
    let f = this.frames.get(pageId);
    if (f) {
      f.ref = true;
      f.pin += 1;
      return f;
    }
    this.evictIfNeeded();
    const page = this.onRead(pageId);
    f = { page, dirty: false, pin: 1, ref: true };
    this.frames.set(pageId, f);
    return f;
  }

  /**
   * Single-threaded read path: load/touch page without pin accounting.
   * Safe only when no concurrent mutate of the same pageId on this pool.
   */
  peek(pageId: number): Page {
    let f = this.frames.get(pageId);
    if (f) {
      f.ref = true;
      return f.page;
    }
    this.evictIfNeeded();
    const page = this.onRead(pageId);
    this.frames.set(pageId, { page, dirty: false, pin: 0, ref: true });
    return page;
  }

  newPage(pageId: number, page: Page): Frame {
    this.evictIfNeeded();
    const f: Frame = { page, dirty: true, pin: 1, ref: true };
    this.frames.set(pageId, f);
    return f;
  }

  unpin(pageId: number, dirty = false): void {
    const f = this.frames.get(pageId);
    if (!f) return;
    if (dirty) f.dirty = true;
    f.pin = Math.max(0, f.pin - 1);
  }

  markDirty(pageId: number): void {
    const f = this.frames.get(pageId);
    if (f) f.dirty = true;
  }

  flushAll(): void {
    for (const [id, f] of this.frames) {
      if (f.dirty) {
        f.page.recomputeCrc();
        this.onFlush(id, f.page);
        f.dirty = false;
      }
    }
  }

  private evictIfNeeded(): void {
    while (this.frames.size >= this.maxFrames) {
      const keys = [...this.frames.keys()];
      if (!keys.length) return;
      let victim = -1;
      for (let n = 0; n < keys.length * 2; n++) {
        this.clockKey = (this.clockKey + 1) % keys.length;
        const id = keys[this.clockKey]!;
        const f = this.frames.get(id)!;
        if (f.pin > 0) continue;
        if (f.ref) {
          f.ref = false;
          continue;
        }
        victim = id;
        break;
      }
      if (victim < 0) {
        // all pinned — allow growth past max temporarily
        return;
      }
      const f = this.frames.get(victim)!;
      if (f.dirty) {
        f.page.recomputeCrc();
        this.onFlush(victim, f.page);
      }
      this.frames.delete(victim);
    }
  }

  /** approx memory */
  stats(): { cached: number; dirty: number } {
    let dirty = 0;
    for (const f of this.frames.values()) if (f.dirty) dirty++;
    return { cached: this.frames.size, dirty };
  }

  pageBytes(): number {
    return this.frames.size * PAGE_SIZE;
  }
}
