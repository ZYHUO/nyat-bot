import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { getRedis } from '../db/redis.js';
import { resolvePublicAddress } from '../pipeline/tools/ssrf.js';
import { conversationKey, messageKey } from './identity.js';
import { findConversationRef, getOrCreateMessageId } from './identity-store.js';
import { isOneBotMessageRecalled } from './onebot-notices.js';
import type { MessageRef } from './types.js';
import {
  assertOneBotAssetId, downloadOneBotFile, OneBotMediaError, oneBotMediaByteLimit,
  sanitizeOneBotFileName, withOneBotMediaDeadline,
} from './onebot-media-stream.js';
import type { OneBotMediaKind, OneBotTransferOptions, OneBotTransferTransport } from './onebot-media-stream.js';
import { assertOneBotMediaUrl } from './onebot-media-policy.js';
export { assertOneBotMediaUrl } from './onebot-media-policy.js';

export type { OneBotMediaKind } from './onebot-media-stream.js';
export interface OneBotMediaDescriptor {
  message: MessageRef;
  kind: OneBotMediaKind;
  assetId?: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}
export interface ResolvedOneBotMedia {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  /** Host-only. Recheck the source immediately before exposing/sending its bytes. */
  readonly assertAvailable: () => void;
}
const PREFIX = 'xxb:onebot:media:';
export const ONEBOT_MEDIA_TTL_SEC = 24 * 60 * 60;
const HANDLE_PATTERN = /^qq-media:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const factories = new Map<string, () => OneBotTransferTransport>();
const KINDS = new Set(['image', 'voice', 'video', 'file']);

/** Factory captures one authenticated connection for the entire transfer. */
export function setOneBotMediaTransport(accountId: string, factory: () => OneBotTransferTransport): () => void {
  if (!accountId || typeof factory !== 'function') throw new OneBotMediaError('qq_media_invalid_transport');
  factories.set(accountId, factory);
  return () => { if (factories.get(accountId) === factory) factories.delete(accountId); };
}

function validateDescriptor(input: unknown): OneBotMediaDescriptor {
  try {
    if (!input || typeof input !== 'object') throw new Error();
    const value = input as OneBotMediaDescriptor;
    if (!value.message || value.message.conversation.platform !== 'qq' ||
      value.message.conversation.idNamespace !== 'qq-number' || !KINDS.has(value.kind)) throw new Error();
    if (messageKey(value.message).length > 2048) throw new Error();
    let assetId: string | undefined;
    if (value.assetId !== undefined) { assertOneBotAssetId(value.assetId); assetId = value.assetId; }
    const url = value.url === undefined ? undefined : assertOneBotMediaUrl(value.url).href;
    if (!assetId && !url) throw new Error();
    if (value.fileSize !== undefined && (!Number.isSafeInteger(value.fileSize) || value.fileSize < 0)) throw new Error();
    return {
      message: { conversation: { ...value.message.conversation }, id: value.message.id }, kind: value.kind,
      ...(assetId ? { assetId } : {}), ...(url ? { url } : {}),
      ...(value.fileName ? { fileName: sanitizeOneBotFileName(value.fileName) } : {}),
      ...(typeof value.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mimeType)
        ? { mimeType: value.mimeType.toLowerCase() } : {}),
      ...(value.fileSize !== undefined ? { fileSize: value.fileSize } : {}),
    };
  } catch { throw new OneBotMediaError('qq_media_invalid_descriptor'); }
}

/** Called only after authenticated, allowlisted ingress. Stores metadata, never bytes. */
export async function registerOneBotMedia(input: OneBotMediaDescriptor): Promise<string> {
  const descriptor = validateDescriptor(input);
  const id = randomUUID();
  const value = JSON.stringify({ version: 1, expiresAt: Date.now() + ONEBOT_MEDIA_TTL_SEC * 1000, descriptor });
  if (Buffer.byteLength(value) > 8192) throw new OneBotMediaError('qq_media_invalid_descriptor');
  try {
    if (await getRedis().set(PREFIX + id, value, 'EX', ONEBOT_MEDIA_TTL_SEC, 'NX') !== 'OK') throw new Error();
  } catch { throw new OneBotMediaError('qq_media_registry_unavailable'); }
  return `qq-media:${id}`;
}

function sniffMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const first = bytes.subarray(0, 12).toString('ascii');
  if (first.startsWith('GIF87a') || first.startsWith('GIF89a')) return 'image/gif';
  if (first.startsWith('RIFF') && first.endsWith('WEBP')) return 'image/webp';
  if (first.startsWith('RIFF') && first.endsWith('WAVE')) return 'audio/wav';
  if (first.startsWith('OggS')) return 'audio/ogg';
  if (first.startsWith('fLaC')) return 'audio/flac';
  if (first.startsWith('ID3') || (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)) return 'audio/mpeg';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm';
  if (first.startsWith('%PDF-')) return 'application/pdf';
  return undefined;
}

function resolved(bytes: Buffer, descriptor: OneBotMediaDescriptor, fileName: string, assertAvailable: () => void): ResolvedOneBotMedia {
  const mime = sniffMime(bytes);
  if (descriptor.kind === 'image' && !mime?.startsWith('image/')) throw new OneBotMediaError('qq_media_image_type_refused');
  // A document MIME hint never upgrades bytes into an executable/HTML/image URL.
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  const documentMime: Record<string, string> = { txt: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  const mimeType = mime ?? (descriptor.kind === 'voice' ? 'audio/mpeg' :
    descriptor.kind === 'video' ? 'video/mp4' : descriptor.mimeType ?? documentMime[extension] ?? 'application/octet-stream');
  assertAvailable();
  return { bytes, mimeType, fileName: sanitizeOneBotFileName(fileName), assertAvailable };
}

function sourceAvailability(message: MessageRef, chatId: number, expiresAt: number): () => void {
  // Do not bind this to the reply/task anchor: another task can hold a handle
  // for an earlier source message, whose recall must still revoke the bytes.
  const source = structuredClone(message);
  const sourceConversation = conversationKey(source.conversation);
  let sourceId: number | undefined;
  return () => {
    try {
      if (Date.now() >= expiresAt) throw new OneBotMediaError('qq_media_expired');
      const current = findConversationRef(chatId);
      if (!current || conversationKey(current) !== sourceConversation) throw new OneBotMediaError('qq_media_wrong_context');
      const mappedId = getOrCreateMessageId(source);
      // A mapping changing underneath an already resolved capability is not
      // proof of availability; never silently bind it to a new internal ID.
      if (sourceId !== undefined && mappedId !== sourceId) throw new OneBotMediaError('qq_media_availability_unknown');
      sourceId = mappedId;
      if (isOneBotMessageRecalled(chatId, mappedId)) throw new OneBotMediaError('qq_media_source_recalled');
    } catch (error) {
      if (error instanceof OneBotMediaError) throw error;
      throw new OneBotMediaError('qq_media_availability_unknown');
    }
  };
}

/** Resolves only in the source conversation, even when a handle is copied elsewhere. */
export async function resolveOneBotMedia(handle: string, contextChatId?: number,
  options: OneBotTransferOptions = {}): Promise<ResolvedOneBotMedia> {
  if (!Number.isSafeInteger(contextChatId) || !contextChatId) throw new OneBotMediaError('qq_media_context_required');
  const match = HANDLE_PATTERN.exec(handle);
  if (!match) throw new OneBotMediaError('qq_media_invalid_handle');
  const maxBytes = oneBotMediaByteLimit(options.maxBytes);
  return withOneBotMediaDeadline(options, async signal => {
    try {
      const raw = await getRedis().get(PREFIX + match[1]);
      if (signal.aborted) throw new OneBotMediaError('qq_media_aborted');
      if (!raw || Buffer.byteLength(raw) > 8192) throw new OneBotMediaError('qq_media_expired');
      const stored = JSON.parse(raw) as { version?: unknown; expiresAt?: unknown; descriptor?: unknown };
      if (stored.version !== 1 || typeof stored.expiresAt !== 'number' || !Number.isSafeInteger(stored.expiresAt) || stored.expiresAt <= Date.now()) {
        throw new OneBotMediaError('qq_media_expired');
      }
      const descriptor = validateDescriptor(stored.descriptor);
      const context = findConversationRef(contextChatId!);
      if (!context || conversationKey(context) !== conversationKey(descriptor.message.conversation)) throw new OneBotMediaError('qq_media_wrong_context');
      const assertAvailable = sourceAvailability(descriptor.message, contextChatId!, stored.expiresAt);
      assertAvailable();
      if (descriptor.fileSize !== undefined && descriptor.fileSize > maxBytes) throw new OneBotMediaError('qq_media_too_large');
      const factory = factories.get(context.accountId);
      if (descriptor.assetId && factory) {
        const transport = factory(); // Bind once; a reconnect cannot splice a transfer.
        const file = await downloadOneBotFile(descriptor.assetId, descriptor.kind, transport, { ...options, maxBytes, signal });
        return resolved(file.bytes, descriptor, descriptor.kind === 'voice' ? file.fileName : descriptor.fileName ?? file.fileName, assertAvailable);
      }
      if (!descriptor.url) throw new OneBotMediaError('qq_media_transport_unavailable');
      const bytes = await downloadOneBotMediaUrl(descriptor.url, { ...options, maxBytes, signal });
      return resolved(bytes, descriptor, descriptor.fileName ?? 'attachment.bin', assertAvailable);
    } catch (error) {
      if (error instanceof OneBotMediaError) throw error;
      throw new OneBotMediaError('qq_media_resolution_failed');
    }
  });
}

/** Binary counterpart to web-fetch: fail on overflow instead of truncating. */
export async function downloadOneBotMediaUrl(input: string, options: OneBotTransferOptions = {}): Promise<Buffer> {
  const maxBytes = oneBotMediaByteLimit(options.maxBytes);
  return withOneBotMediaDeadline(options, async signal => {
    let current = input;
    for (let hop = 0; hop <= 3; hop++) {
      const url = assertOneBotMediaUrl(current);
      let address: string; let family: 4 | 6;
      try { ({ address, family } = await resolvePublicAddress(url.hostname)); }
      catch { throw new OneBotMediaError('qq_media_address_refused'); }
      if (signal.aborted) throw new OneBotMediaError('qq_media_aborted');
      const result = await requestBinary(url, address, family, maxBytes, signal);
      if (!result.location) return result.bytes;
      if (hop === 3) throw new OneBotMediaError('qq_media_redirect_limit');
      try { current = new URL(result.location, url).href; }
      catch { throw new OneBotMediaError('qq_media_url_refused'); }
    }
    throw new OneBotMediaError('qq_media_redirect_limit');
  });
}

function requestBinary(url: URL, address: string, family: 4 | 6, maxBytes: number, signal: AbortSignal): Promise<{ bytes: Buffer; location?: string }> {
  return new Promise((resolve, reject) => {
    let done = false;
    let incoming: http.IncomingMessage | undefined;
    const finish = (error?: OneBotMediaError, value?: { bytes: Buffer; location?: string }) => {
      if (done) return;
      done = true; signal.removeEventListener('abort', abort);
      if (error) { incoming?.destroy(); request.destroy(); reject(error); }
      else resolve(value!);
    };
    const abort = () => finish(new OneBotMediaError('qq_media_aborted'));
    const request = (url.protocol === 'https:' ? https : http).request({
      protocol: url.protocol, hostname: address, family, port: url.protocol === 'https:' ? 443 : 80,
      method: 'GET', path: url.pathname + url.search, headers: { Host: url.hostname, 'Accept-Encoding': 'identity' },
      ...(url.protocol === 'https:' ? { servername: url.hostname, rejectUnauthorized: true } : {}),
      agent: false,
    }, response => {
      incoming = response;
      if (done) { response.destroy(); return; }
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        if (!location || location.length > 4096) { finish(new OneBotMediaError('qq_media_url_refused')); return; }
        response.destroy(); finish(undefined, { bytes: Buffer.alloc(0), location }); return;
      }
      if (status !== 200) { finish(new OneBotMediaError('qq_media_http_failed')); return; }
      const length = response.headers['content-length'];
      const encoding = response.headers['content-encoding'];
      if ((length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) || (encoding && encoding !== 'identity')) {
        finish(new OneBotMediaError('qq_media_too_large')); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { finish(new OneBotMediaError('qq_media_too_large')); return; }
        chunks.push(chunk);
      });
      response.on('error', () => finish(new OneBotMediaError('qq_media_http_failed')));
      response.on('aborted', () => finish(new OneBotMediaError('qq_media_incomplete_stream')));
      response.on('end', () => {
        if (!bytes || !response.complete || (length !== undefined && Number(length) !== bytes)) finish(new OneBotMediaError('qq_media_incomplete_stream'));
        else finish(undefined, { bytes: Buffer.concat(chunks, bytes) });
      });
      response.on('close', () => { if (!done) finish(new OneBotMediaError('qq_media_incomplete_stream')); });
    });
    request.on('error', () => finish(new OneBotMediaError('qq_media_http_failed')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else request.end();
  });
}
