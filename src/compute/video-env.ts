import { isAbsolute } from 'node:path';
import { validDigest } from './video-contract.js';

/** Standalone configuration: no dotenv, bot env, platform tokens or database. */
export function videoComputeEnv(source: NodeJS.ProcessEnv = process.env) {
  const token = source.VIDEO_COMPUTE_TOKEN ?? '', profile = source.VIDEO_COMPUTE_PROFILE ?? '';
  const decoderSha256 = source.VIDEO_COMPUTE_DECODER_SHA256 ?? '';
  const host = source.VIDEO_COMPUTE_HOST ?? '127.0.0.1';
  const port = Number(source.VIDEO_COMPUTE_PORT ?? '3033');
  const maxConcurrent = Number(source.VIDEO_COMPUTE_CONCURRENCY ?? '1');
  if (token.length < 32 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token) || !isAbsolute(profile)
    || !validDigest(decoderSha256) || !['127.0.0.1', '::1'].includes(host)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2) throw new Error('video_compute_configuration_invalid');
  return { token, profile, decoderSha256, host, port, maxConcurrent };
}
