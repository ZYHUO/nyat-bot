import { readFile, realpath, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { videoComputeEnv } from './video-env.js';
import { validateVideoProfile } from './video-profile.js';
import type { VideoSandboxProfile } from './video-profile.js';
import { decodeVideoFrames, preflightVideoSandbox } from './video-decoder.js';
import { createVideoServer } from './video-server.js';

async function main(): Promise<void> {
  const config = videoComputeEnv();
  if (await realpath(config.profile) !== config.profile) throw new Error('profile_noncanonical');
  for (let file = config.profile;; file = dirname(file)) {
    const info = await lstat(file);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('profile_untrusted');
    if (file === dirname(file)) break;
  }
  const info = await lstat(config.profile);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('profile_invalid');
  const profile = JSON.parse(await readFile(config.profile, 'utf8')) as VideoSandboxProfile;
  const identity = await validateVideoProfile(profile);
  if (identity.decoderSha256 !== config.decoderSha256) throw new Error('decoder_identity_mismatch');
  await preflightVideoSandbox(profile);
  const runtime = createVideoServer({ token: config.token, identity, maxConcurrent: config.maxConcurrent,
    decode: (bytes, maxDuration, signal) => decodeVideoFrames(bytes, profile, maxDuration, signal) });
  runtime.server.on('error', () => { process.stderr.write('video_compute_server_failed\n'); process.exit(1); });
  runtime.server.listen(config.port, config.host, () => {
    process.stdout.write(JSON.stringify({ event: 'video_compute_ready', identity, port: config.port, maxConcurrent: config.maxConcurrent }) + '\n');
  });
  let stopping = false;
  for (const name of ['SIGTERM', 'SIGINT'] as const) process.once(name, () => {
    if (stopping) return; stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    void runtime.stop().then(() => { clearTimeout(deadline); process.exit(0); });
  });
}
void main().catch(() => { process.stderr.write('video_compute_start_failed\n'); process.exit(1); });
