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

  const parent = relative === '' ? null : relative.split('/').slice(0, -1).join('/');

  return {
    path: relative,
    parent,
    dirs,
    files
  };
}
