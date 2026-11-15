import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { getLabel, getUsage } from './labels.js';
import { acquireAiLease, getAiWorkload } from './workload.js';
import type { AiInFlightLease } from './workload.js';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
export type TranscriptionReason = 'disabled' | 'too_large' | 'unsupported_format' | 'configuration' | 'busy' | 'timeout' | 'aborted' | 'network' | 'http_error' | 'redirect' | 'invalid_response' | 'empty';
export type TranscriptionResult = { status: 'ok'; text: string; label: string }
  | { status: 'empty' | 'failed' | 'skipped'; reason: TranscriptionReason };
export interface TranscriptionInput { buffer: ArrayBuffer; mimeType: string; fileName: string; signal?: AbortSignal }

/** Preserve the configured provider origin and optional proxy prefix. */
export function transcriptionEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid transcription endpoint');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|audio\/transcriptions)$/, '');
  if (!path.endsWith('/v1')) path += '/v1';
  url.pathname = `${path}/audio/transcriptions`;
  return url.href;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  oga: 'audio/ogg', ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', flac: 'audio/flac',
};
const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/wave': 'wav', 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/flac': 'flac',
};
export function audioUploadMetadata(filePath: string, headerMime: string): { fileName: string; mimeType: string } | null {
  const originalName = filePath.split(/[\\/]/).at(-1)?.replace(/[^\p{L}\p{N}._-]/gu, '_') || 'audio';
  const extension = originalName.split('.').at(-1)?.toLowerCase() ?? '';
  const mime = headerMime.split(';')[0]?.trim().toLowerCase() ?? '';
  const mimeType = EXTENSION_BY_MIME[mime] ? mime : MIME_BY_EXTENSION[extension];
  if (!mimeType) return null;
  const fileName = MIME_BY_EXTENSION[extension] ? originalName : `${originalName}.${EXTENSION_BY_MIME[mimeType] ?? 'ogg'}`;
  return { fileName, mimeType };
}

function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Dedicated multipart transport: no chat messages, token budgets or reasoning flags. */
export async function transcribeAudio(input: TranscriptionInput): Promise<TranscriptionResult> {
  const config = env();
  if (!config.AUDIO_TRANSCRIBE_ENABLED) return { status: 'skipped', reason: 'disabled' };
  if (input.buffer.byteLength > MAX_AUDIO_BYTES) return { status: 'skipped', reason: 'too_large' };
  if (!input.buffer.byteLength) return { status: 'empty', reason: 'empty' };
  const metadata = audioUploadMetadata(input.fileName, input.mimeType);
  if (!metadata) return { status: 'skipped', reason: 'unsupported_format' };
  let usage;
  try { usage = getUsage('audio'); } catch { return { status: 'failed', reason: 'configuration' }; }
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, usage.timeout));
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let lastReason: TranscriptionReason = 'configuration';
  let sawEmpty = false;
  for (const labelName of [...new Set([usage.label, ...usage.backups])]) {
    let lease: AiInFlightLease | null = null;
    try {
      if (signal.aborted) throw signal.reason;
      const label = getLabel(labelName);
      const key = label.apiKeys.find((value) => value.trim());
      if (!key || label.apiFormat === 'claude') { lastReason = 'configuration'; continue; }
      let endpoint: string;
      try { endpoint = transcriptionEndpoint(label.endpoint); } catch { lastReason = 'configuration'; continue; }
      if (config.AI_WORKLOAD_BUDGET_ENABLED) {
        const pendingLease = acquireAiLease(getRedis(), {
          model: label.model, workload: getAiWorkload(), totalLimit: config.AI_MAX_INFLIGHT_PER_MODEL,
          backgroundLimit: config.AI_MAX_BACKGROUND_INFLIGHT_PER_MODEL, timeoutMs,
        }).then((value) => {
          // A Redis reply arriving after cancellation must not leak a fresh lease.
          if (signal.aborted) { void value?.release().catch(() => {}); return null; }
          lease = value;
          return value;
        });
        if (!await untilAbort(pendingLease, signal)) { lastReason = 'busy'; continue; }
      }
      const body = new FormData();
      body.set('model', label.model);
      body.set('response_format', 'json');
      body.set('file', new Blob([input.buffer], { type: metadata.mimeType }), metadata.fileName);
      const response = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body,
        signal, redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) { lastReason = 'redirect'; continue; }
      if (!response.ok) { lastReason = 'http_error'; continue; }
      const result = await response.json() as { text?: unknown } | null;
      if (!result || typeof result.text !== 'string') { lastReason = 'invalid_response'; continue; }
      const text = result.text.trim();
      if (!text) { sawEmpty = true; lastReason = 'empty'; continue; }
      return { status: 'ok', text, label: label.name };
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      lastReason = name === 'TimeoutError' ? 'timeout' : name === 'AbortError' || signal.aborted ? 'aborted'
        : error instanceof SyntaxError ? 'invalid_response' : 'network';
      if (signal.aborted) break;
    } finally {
      // Always release this token; a Redis outage is bounded and TTL is the backstop.
      const held = lease as AiInFlightLease | null;
      if (held) await untilAbort(held.release(), AbortSignal.timeout(1000)).catch(() => {});
    }
  }
  return sawEmpty && lastReason === 'empty' ? { status: 'empty', reason: 'empty' } : { status: 'failed', reason: lastReason };
}
