// ────────────────────────────────────────
// TTS Synthesis — edge-tts (free, local Python) → OGG/Opus for Telegram voice
// ────────────────────────────────────────
//
// Pipeline: `python3 -m edge_tts` synthesizes speech to MP3, then `ffmpeg`
// transcodes MP3 → OGG/Opus (the only container/codec Telegram accepts for
// voice messages). No API keys required — edge-tts streams from Microsoft's
// free Edge Read Aloud endpoint.
//
// Everything here is gated behind `TTS_ENABLED` (default OFF). Callers should
// additionally wrap calls in try/catch and fall back to a plain text send on
// any failure — TTS must never block or drop a reply.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { assertOutboundText } from '../shared/outbound-privacy.js';

/** Per-command timeout. Short replies synthesize in ~1-3s; this is a safe ceiling. */
const TTS_CMD_TIMEOUT_MS = 15_000;
const MAX_STDERR_CHARS = 8192;

/**
 * Synthesize `text` into an OGG/Opus buffer suitable for Telegram `sendVoice`.
 *
 * Uses the configured voice (`TTS_VOICE`, default `zh-CN-XiaoxiaoNeural`).
 *
 * @returns OGG/Opus `Buffer`, or `null` when TTS is disabled or the text is
 *          empty (non-error skips — caller falls through to text).
 * @throws  on edge-tts / ffmpeg failure (caller should catch → text fallback).
 */
export async function synthesizeVoice(text: string, voice?: string): Promise<Buffer | null> {
  const cfg = env();
  if (!cfg.TTS_ENABLED) return null;
  assertOutboundText(text);

  const clean = text.trim();
  if (!clean) return null;

  const useVoice = voice ?? cfg.TTS_VOICE;
  const dir = await mkdtemp(join(tmpdir(), 'nyat-tts-'));
  const mp3Path = join(dir, 'voice.mp3');
  const oggPath = join(dir, 'voice.ogg');

  try {
    // 1. edge-tts → MP3
    await runCmd(
      cfg.TTS_PYTHON_PATH,
      ['-m', 'edge_tts', '--voice', useVoice, '--text', clean, '--write-media', mp3Path],
      TTS_CMD_TIMEOUT_MS,
    );

    // 2. ffmpeg → OGG/Opus (Telegram voice requirement: OggS + Opus codec).
    //    `-application voip` tunes the Opus encoder for speech.
    await runCmd(
      cfg.TTS_FFMPEG_PATH,
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', mp3Path,
        '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k',
        '-application', 'voip', '-f', 'ogg', oggPath],
      TTS_CMD_TIMEOUT_MS,
    );

    const buf = await readFile(oggPath);
    const opusHeaderAt = buf.indexOf('OpusHead', 4, 'ascii');
    if (buf.length < 47 || buf.subarray(0, 4).toString('ascii') !== 'OggS' || opusHeaderAt < 0 || opusHeaderAt > 512) {
      throw new Error('TTS output is not an OGG/Opus audio file');
    }
    return buf;
  } finally {
    // Best-effort cleanup of the temp dir; never let it throw.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Never-throwing convenience wrapper: returns the OGG/Opus buffer, or `null`
 * when disabled **or** on any synthesis/conversion failure (logged at warn).
 *
 * Use this from the reply send path when you never want TTS to propagate an
 * error. Use {@link synthesizeVoice} directly when you need to distinguish
 * "disabled" (null) from "failed" (thrown).
 */
export async function maybeSynthesizeVoice(text: string, voice?: string): Promise<Buffer | null> {
  try {
    return await synthesizeVoice(text, voice);
  } catch (err) {
    logger.warn(
      { err, voice: voice ?? env().TTS_VOICE, textLen: text.length },
      'TTS synthesis failed — will fall back to text',
    );
    return null;
  }
}

/** Spawn a command, resolve on exit code 0, reject on non-zero/error/timeout. */
function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false, windowsHide: true });
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let killGrace: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      if (error) reject(error); else resolve();
    };
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-MAX_STDERR_CHARS);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); }
      catch { finish(new Error(`${cmd} timed out and could not be terminated`)); return; }
      // Usually close follows immediately. Wait for it before deleting the
      // temporary files; keep a bound if a broken child never emits close.
      if (!finished) killGrace = setTimeout(() => finish(new Error(`${cmd} timed out after ${timeoutMs}ms`)), 1000);
    }, timeoutMs);
    child.on('error', (err) => {
      finish(new Error(`Failed to spawn ${cmd}: ${err.message.slice(0, 500)}`));
    });
    child.on('close', (code) => {
      if (timedOut) finish(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      else if (code === 0) finish();
      else {
        const detail = stderr ? `: ${stderr.slice(-500)}` : '';
        finish(new Error(`${cmd} exited with code ${code}${detail}`));
      }
    });
  });
}
