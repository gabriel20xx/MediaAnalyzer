import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolveWithinRoot } from './fsBrowse.js';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.ts']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.opus']);

function guessKindFromExtension(relPath) {
  const ext = path.posix.extname(relPath ?? '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'unknown';
}

function runFfprobe(fileAbsPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      fileAbsPath
    ];

    const child = spawn('ffprobe', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}: ${stderr.trim()}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe JSON: ${err?.message ?? err}`));
      }
    });
  });
}

function pickPrimaryVideoStream(streams) {
  return streams.find((s) => s.codec_type === 'video') ?? null;
}

function pickPrimaryAudioStream(streams) {
  return streams.find((s) => s.codec_type === 'audio') ?? null;
}

function toNumberMaybe(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeAnalysis(relPath, fileStats, ffprobeJson) {
  const format = ffprobeJson?.format ?? {};
  const streams = Array.isArray(ffprobeJson?.streams) ? ffprobeJson.streams : [];

  const video = pickPrimaryVideoStream(streams);
  const audio = pickPrimaryAudioStream(streams);

  const hasVideo = !!video;
  const hasAudio = !!audio;

  // Rough classification
  let kind = 'unknown';
  if (hasVideo && hasAudio) kind = 'video';
  else if (hasVideo && !hasAudio) kind = 'image';
  else if (!hasVideo && hasAudio) kind = 'audio';

  const width = toNumberMaybe(video?.width);
  const height = toNumberMaybe(video?.height);

  const durationSec = toNumberMaybe(format?.duration);
  const bitRate = toNumberMaybe(format?.bit_rate);

  return {
    path: relPath,
    name: path.posix.basename(relPath),
    kind,
    sizeBytes: fileStats.size,
    modifiedAt: fileStats.mtime.toISOString(),

    container: {
      formatName: format?.format_name ?? null,
      formatLongName: format?.format_long_name ?? null
    },

    video: {
      codec: video?.codec_name ?? null,
      codecLongName: video?.codec_long_name ?? null,
      width,
      height,
      pixelFormat: video?.pix_fmt ?? null,
      frameRate: video?.r_frame_rate ?? null
    },

    audio: {
      codec: audio?.codec_name ?? null,
      codecLongName: audio?.codec_long_name ?? null,
      sampleRate: toNumberMaybe(audio?.sample_rate),
      channels: toNumberMaybe(audio?.channels)
    },

    durationSec,
    bitRate,

    raw: {
      streamCount: streams.length
    }
  };
}

export async function analyzeFiles(mediaRoot, relPaths) {
  const results = [];

  for (const relPath of relPaths) {
    const { targetAbs, relative } = resolveWithinRoot(mediaRoot, relPath);

    const stats = await fs.stat(targetAbs);
    if (!stats.isFile()) {
      results.push({ path: relative, error: 'Not a file' });
      continue;
    }

    try {
      const ffprobeJson = await runFfprobe(targetAbs);
      results.push(normalizeAnalysis(relative, stats, ffprobeJson));
    } catch (err) {
      // Even when ffprobe fails, keep enough metadata so it can be persisted to DB.
      results.push({
        path: relative,
        name: path.posix.basename(relative),
        kind: guessKindFromExtension(relative),
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        error: err?.message ?? 'Analyze failed'
      });
    }
  }

  return results;
}
