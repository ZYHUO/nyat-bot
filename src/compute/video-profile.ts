import { readFile, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import { sha256, validDigest, videoIdentity, VideoComputeError } from './video-contract.js';
import type { VideoIdentity } from './video-contract.js';

interface PinnedFile { path: string; sha256: string; mountPath?: string }
export interface VideoSandboxProfile {
  bwrap: PinnedFile; prlimit: PinnedFile; ffmpeg: PinnedFile; ffprobe: PinnedFile;
  runtimeFiles: PinnedFile[];
}
function pinned(value: unknown): value is PinnedFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as PinnedFile;
  return Object.keys(value).every(key => ['path', 'sha256', 'mountPath'].includes(key)) && typeof file.path === 'string' && isAbsolute(file.path)
    && normalize(file.path) === file.path && !/[\r\n\0]/.test(file.path) && validDigest(file.sha256);
}
/** Root-pinned exact ELF files only; never mount a host directory into a decoder. */
export async function validateVideoProfile(profile: VideoSandboxProfile): Promise<VideoIdentity> {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new VideoComputeError('video_frames_nonroot_linux_required');
  if (!profile || typeof profile !== 'object' || Object.keys(profile).length !== 5
    || ![profile.bwrap, profile.prlimit, profile.ffmpeg, profile.ffprobe].every(pinned)
    || !Array.isArray(profile.runtimeFiles) || profile.runtimeFiles.length > 128
    || !profile.runtimeFiles.every(pinned)) throw new VideoComputeError('video_frames_profile_invalid');
  if ([profile.bwrap, profile.prlimit, profile.ffmpeg, profile.ffprobe].some(file => file.mountPath !== undefined)
    || !profile.runtimeFiles.every(file => /^(?:lib[^/]+|ld[^/]*)\.so(?:\.[^/]+)*$/.test(basename(file.path))
      && (file.mountPath === undefined || (typeof file.mountPath === 'string' && normalize(file.mountPath) === file.mountPath
        && /^\/(?:lib(?:64)?|usr\/lib(?:64)?)(?:\/[A-Za-z0-9_-]+)*\/(?:lib[^/]+|ld[^/]*)\.so(?:\.[^/]+)*$/.test(file.mountPath))))) {
    throw new VideoComputeError('video_frames_profile_libraries_only');
  }
  const files = [profile.bwrap, profile.prlimit, profile.ffmpeg, profile.ffprobe, ...profile.runtimeFiles];
  if (new Set(files.map(file => file.path)).size !== files.length) throw new VideoComputeError('video_frames_profile_duplicate');
  const mounted = [profile.ffmpeg, profile.ffprobe, ...profile.runtimeFiles].map(file => file.mountPath ?? file.path);
  if (new Set(mounted).size !== mounted.length) throw new VideoComputeError('video_frames_profile_duplicate');
  for (const file of files) {
    if (await realpath(file.path) !== file.path) throw new VideoComputeError('video_frames_profile_noncanonical');
    for (let path = file.path;; path = dirname(path)) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new VideoComputeError('video_frames_profile_untrusted');
      if (path === dirname(path)) break;
    }
    const info = await lstat(file.path);
    if (!info.isFile() || info.size > 128 * 1024 * 1024 || (info.mode & 0o6000) !== 0) throw new VideoComputeError('video_frames_profile_invalid_file');
    const bytes = await readFile(file.path);
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || sha256(bytes) !== file.sha256) {
      throw new VideoComputeError('video_frames_profile_hash_invalid');
    }
  }
  return videoIdentity(sha256(Buffer.from(JSON.stringify([profile.ffmpeg.sha256, profile.ffprobe.sha256]))));
}
export function videoLaunchArgs(profile: VideoSandboxProfile, binary: string, args: string[], inputFile: string): string[] {
  if (![profile.ffmpeg.path, profile.ffprobe.path].includes(binary)) throw new VideoComputeError('video_frames_executable_denied');
  const launch = ['--as=1073741824:1073741824', '--cpu=15:15', '--nproc=64:64', '--nofile=64:64',
    '--fsize=0:0', '--core=0:0', '--', profile.bwrap.path,
    '--unshare-user', '--uid', '65534', '--gid', '65534', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL'];
  for (const file of [profile.ffmpeg, profile.ffprobe, ...profile.runtimeFiles]) launch.push('--ro-bind', file.path, file.mountPath ?? file.path);
  launch.push('--ro-bind', inputFile, '/input.bin', '--dev-bind', '/dev/null', '/dev/null',
    '--dir', '/tmp', '--chdir', '/', '--setenv', 'LANG', 'C', '--setenv', 'HOME', '/tmp',
    '--remount-ro', '/', '--', binary, ...args);
  return launch;
}
