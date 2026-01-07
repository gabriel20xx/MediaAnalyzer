import path from 'node:path';
import fs from 'node:fs/promises';

function normalizeRel(relPath) {
  const raw = (relPath ?? '').toString();
  const cleaned = raw.replace(/\\/g, '/');
  // Allow '' or paths like 'folder/sub'
  const trimmed = cleaned.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed;
}

export function resolveWithinRoot(mediaRoot, relPath) {
  const rel = normalizeRel(relPath);
  const rootAbs = path.resolve(mediaRoot);
  const targetAbs = path.resolve(rootAbs, rel);

  const rootWithSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  const isRoot = targetAbs === rootAbs;
  const isWithin = isRoot || targetAbs.startsWith(rootWithSep);
  if (!isWithin) {
    throw new Error('Path escapes MEDIA_ROOT');
  }

  return { rootAbs, targetAbs, relative: rel };
}

export async function browsePath(mediaRoot, relPath) {
  const { targetAbs, relative } = resolveWithinRoot(mediaRoot, relPath);

  const opts = arguments.length >= 3 && typeof arguments[2] === 'object' && arguments[2] ? arguments[2] : {};
  const fileOffsetRaw = typeof opts.fileOffset === 'number' ? opts.fileOffset : 0;
  const fileLimitRaw = typeof opts.fileLimit === 'number' ? opts.fileLimit : null;
  const fileOffset = Number.isFinite(fileOffsetRaw) && fileOffsetRaw > 0 ? Math.floor(fileOffsetRaw) : 0;
  const fileLimit = Number.isFinite(fileLimitRaw) && fileLimitRaw > 0 ? Math.floor(fileLimitRaw) : null;

  const dirEntries = await fs.readdir(targetAbs, { withFileTypes: true });

  const dirs = [];
  const files = [];

  for (const entry of dirEntries) {
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      dirs.push(entry.name);
      continue;
    }

    if (entry.isFile()) {
      files.push(entry.name);
    }
  }

  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));

  const totalFiles = files.length;
  const pagedFiles = fileLimit ? files.slice(fileOffset, fileOffset + fileLimit) : files;

  const parent = relative === '' ? null : relative.split('/').slice(0, -1).join('/');

  return {
    path: relative,
    parent,
    dirs,
    files: pagedFiles,
    totalFiles,
    fileOffset,
    fileLimit: fileLimit ?? totalFiles
  };
}
