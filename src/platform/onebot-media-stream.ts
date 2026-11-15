import { createHash, randomUUID } from 'node:crypto';

export type OneBotMediaKind = 'image' | 'voice' | 'video' | 'file';
export const ONEBOT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const ONEBOT_MEDIA_CHUNK_BYTES = 48 * 1024;
const HARD_MAX_BYTES = 64 * 1024 * 1024;

/** Never include provider bodies, paths, URL credentials or media bytes in errors. */
export class OneBotMediaError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'OneBotMediaError'; this.code = code; }
}

export interface OneBotTransferTransport {
  request(action: string, params: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown>;
  /** The transport checks echo/account/status; frames here are the response data. */
  streamAction(action: string, params: Record<string, unknown>, options: {
    onFrame: (data: unknown) => boolean;
    signal: AbortSignal;
  }): Promise<unknown>;
}

export interface OneBotTransferOptions { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; }
export interface OneBotDownloadedFile { bytes: Buffer; fileName: string; }
export interface OneBotUploadedFile { filePath: string; fileSize: number; sha256: string; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OneBotMediaError('qq_media_invalid_frame');
  return value as Record<string, unknown>;
}

export function oneBotMediaByteLimit(value = ONEBOT_MEDIA_MAX_BYTES): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_BYTES) throw new OneBotMediaError('qq_media_invalid_limit');
  return value;
}

export function assertOneBotAssetId(value: string): void {
  // NapCat uses UUID/hash/file-name keys. Never promote a URL or a host path to
  // get_file's overloaded `file` input, including Windows and traversal paths.
  const plain = typeof value === 'string' && /^[A-Za-z0-9_{}.+-][A-Za-z0-9_{}.+-]{0,511}$/.test(value);
  // QQ group UUIDs can carry one leading slash; it is part of the cached ID,
  // never a host path. Native base64 IDs stay canonical, bounded and path-free.
  const groupUuid = typeof value === 'string' && /^\/(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(value);
  const base64 = typeof value === 'string' && value.length >= 24 && value.length <= 512 && value.length % 4 === 0 &&
    !value.startsWith('/') && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
  if ((!plain && !groupUuid && !base64) || value.includes('..') || value === '.') {
    throw new OneBotMediaError('qq_media_invalid_asset_id');
  }
}

export function sanitizeOneBotFileName(value: unknown, fallback = 'attachment.bin'): string {
  if (typeof value !== 'string') return fallback;
  const name = value.split(/[\\/]/).at(-1)?.replace(/[\p{Cc}\p{Bidi_Control}]/gu, '_').replace(/[<>:"|?*]/g, '_').trim().slice(0, 160);
  return !name || name === '.' || name === '..' ? fallback : name;
}

export function decodeOneBotBase64(value: unknown, maxBytes: number): Buffer {
  const limit = oneBotMediaByteLimit(maxBytes);
  if (typeof value !== 'string' || !value || value.length > 4 * Math.ceil(limit / 3) ||
    value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new OneBotMediaError('qq_media_invalid_base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== value) throw new OneBotMediaError('qq_media_invalid_base64');
  return bytes;
}

/** One overall deadline covers DNS/RPC/queue time, not one timeout per chunk. */
export async function withOneBotMediaDeadline<T>(options: OneBotTransferOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new OneBotMediaError('qq_media_invalid_timeout');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, timeout);
  timer.unref();
  let rejectAbort: (() => void) | undefined;
  try {
    if (controller.signal.aborted) throw new OneBotMediaError('qq_media_aborted');
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new OneBotMediaError('qq_media_aborted'));
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    return await Promise.race([fn(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}

/** NapCat 4.18.42 data frames; no duplicate, reordered or partial success. */
export class OneBotDownloadCollector {
  private chunks: Buffer[] = [];
  private byteCount = 0;
  private chunkCount = 0;
  private chunkSize = 0;
  private fileName = 'attachment.bin';
  private complete = false;
  private failed = false;
  private readonly maxBytes: number;

  constructor(maxBytes = ONEBOT_MEDIA_MAX_BYTES) { this.maxBytes = oneBotMediaByteLimit(maxBytes); }

  accept(value: unknown): boolean {
    try {
      if (this.complete || this.failed) throw new OneBotMediaError('qq_media_stream_closed');
      const frame = object(value);
      if (frame['type'] === 'stream' && frame['data_type'] === 'file_info') {
        const size = frame['file_size']; const chunk = frame['chunk_size'];
        if (this.chunkSize || !Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > this.maxBytes ||
          !Number.isSafeInteger(chunk) || Number(chunk) < 1 || Number(chunk) > 64 * 1024) throw new OneBotMediaError('qq_media_invalid_info');
        this.chunkSize = Number(chunk); this.fileName = sanitizeOneBotFileName(frame['file_name']);
        return false;
      }
      if (frame['type'] === 'stream' && frame['data_type'] === 'file_chunk') {
        if (!this.chunkSize || frame['index'] !== this.chunkCount || this.chunkCount >= 4096) throw new OneBotMediaError('qq_media_chunk_order');
        const bytes = decodeOneBotBase64(frame['data'], this.chunkSize);
        if (frame['size'] !== bytes.length || frame['base64_size'] !== (frame['data'] as string).length) throw new OneBotMediaError('qq_media_chunk_size');
        if (this.byteCount + bytes.length > this.maxBytes) throw new OneBotMediaError('qq_media_too_large');
        this.chunks.push(bytes); this.byteCount += bytes.length; this.chunkCount++;
        return false;
      }
      if (frame['type'] === 'response' && frame['data_type'] === 'file_complete') {
        // v4.18.42 get_record stream advertises ORIGINAL file_size before audio
        // conversion. The completion total, not that hint, proves completeness.
        if (!this.chunkSize || !this.byteCount || frame['total_chunks'] !== this.chunkCount || frame['total_bytes'] !== this.byteCount) {
          throw new OneBotMediaError('qq_media_incomplete_stream');
        }
        this.complete = true; return true;
      }
      throw new OneBotMediaError('qq_media_invalid_frame');
    } catch (error) {
      this.failed = true; this.chunks = [];
      throw error instanceof OneBotMediaError ? error : new OneBotMediaError('qq_media_invalid_frame');
    }
  }

  result(): OneBotDownloadedFile {
    if (!this.complete || this.failed) throw new OneBotMediaError('qq_media_incomplete_stream');
    return { bytes: Buffer.concat(this.chunks, this.byteCount), fileName: this.fileName };
  }
}

export async function downloadOneBotFile(fileId: string, kind: OneBotMediaKind, transport: OneBotTransferTransport,
  options: OneBotTransferOptions = {}): Promise<OneBotDownloadedFile> {
  assertOneBotAssetId(fileId);
  const collector = new OneBotDownloadCollector(options.maxBytes);
  return withOneBotMediaDeadline(options, async signal => {
    const action = kind === 'voice' ? 'download_file_record_stream' : kind === 'image' ? 'download_file_image_stream' : 'download_file_stream';
    await transport.streamAction(action, { file_id: fileId, chunk_size: ONEBOT_MEDIA_CHUNK_BYTES, ...(kind === 'voice' ? { out_format: 'mp3' } : {}) }, {
      signal, onFrame: frame => { if (signal.aborted) throw new OneBotMediaError('qq_media_aborted'); return collector.accept(frame); },
    });
    if (signal.aborted) throw new OneBotMediaError('qq_media_aborted');
    const result = collector.result();
    return kind === 'voice' ? { ...result, fileName: result.fileName.replace(/\.[^.]*$/, '') + '.mp3' } : result;
  });
}

/** Bounded sequential staging upload. This does NOT send a message to QQ. */
export async function uploadOneBotFile(input: Uint8Array, name: string, transport: OneBotTransferTransport,
  options: OneBotTransferOptions = {}): Promise<OneBotUploadedFile> {
  const maxBytes = oneBotMediaByteLimit(options.maxBytes);
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > maxBytes) throw new OneBotMediaError('qq_media_too_large');
  const bytes = Buffer.from(input); // Caller mutation cannot change a transfer after hashing.
  const streamId = randomUUID();
  const filename = `${streamId}-${sanitizeOneBotFileName(name)}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const count = Math.ceil(bytes.length / ONEBOT_MEDIA_CHUNK_BYTES);
  return withOneBotMediaDeadline(options, async signal => {
    for (let index = 0; index < count; index++) {
      if (signal.aborted) throw new OneBotMediaError('qq_media_aborted');
      const response = object(await transport.request('upload_file_stream', {
        stream_id: streamId, chunk_data: bytes.subarray(index * ONEBOT_MEDIA_CHUNK_BYTES, (index + 1) * ONEBOT_MEDIA_CHUNK_BYTES).toString('base64'),
        chunk_index: index, total_chunks: count, file_size: bytes.length, expected_sha256: sha256, filename, file_retention: 300000,
      }, { signal }));
      if (response['type'] !== 'stream' || response['stream_id'] !== streamId || response['status'] !== 'chunk_received' ||
        response['received_chunks'] !== index + 1 || response['total_chunks'] !== count) throw new OneBotMediaError('qq_media_upload_ack_invalid');
    }
    if (signal.aborted) throw new OneBotMediaError('qq_media_aborted');
    const final = object(await transport.request('upload_file_stream', { stream_id: streamId, is_complete: true }, { signal }));
    const filePath = final['file_path'];
    if (final['type'] !== 'response' || final['status'] !== 'file_complete' || final['stream_id'] !== streamId ||
      final['received_chunks'] !== count || final['total_chunks'] !== count || final['file_size'] !== bytes.length || final['sha256'] !== sha256 ||
      typeof filePath !== 'string' || filePath.length > 4096 || /[\x00-\x1f\x7f]/.test(filePath) || filePath.split(/[\\/]/).at(-1) !== filename) {
      throw new OneBotMediaError('qq_media_upload_receipt_invalid');
    }
    return { filePath, fileSize: bytes.length, sha256 };
  });
}
