import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { browsePath, resolveWithinRoot } from './fsBrowse.js';
import { analyzeFiles } from './analyze.js';
import { compareAnalyses } from './compare.js';
import { buildDashboard } from './dashboard.js';
import { createPool, ensureSchema, upsertAnalyses, isDbEnabled, getAnalysesByPaths, getSearchOptions, searchAnalysesPaged, getDashboardFromDb } from './db.js';
import chokidar from 'chokidar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Frontend vendor assets (served from node_modules). Used for VR/360 video playback.
app.use('/vendor', express.static(path.join(__dirname, '../node_modules/aframe/dist'), {
  fallthrough: true,
  etag: true,
  maxAge: '1h'
}));

const port = Number(process.env.PORT ?? 3000);
const mediaRoot = process.env.MEDIA_ROOT ?? '/media';
const dbPool = createPool();

// Serve mounted media for in-app preview/playback.
// express.static supports Range requests, which is important for video/audio streaming.
app.use('/media', express.static(mediaRoot, {
  fallthrough: false,
  dotfiles: 'deny',
  etag: true,
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
}));

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.ts']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

const thumbCache = new Map();
const thumbCacheOrder = [];
const THUMB_CACHE_MAX = Number(process.env.THUMB_CACHE_MAX ?? 250);

function setThumbCache(key, buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return;
  if (thumbCache.has(key)) return;
  thumbCache.set(key, buf);
  thumbCacheOrder.push(key);
  while (thumbCacheOrder.length > THUMB_CACHE_MAX) {
    const old = thumbCacheOrder.shift();
    if (old) thumbCache.delete(old);
  }
}

async function generateThumbnailJpeg({ absPath, isVideo, width }) {
  const w = Number.isFinite(width) && width > 0 ? width : 160;
  const vf = `scale=${w}:-2:force_original_aspect_ratio=decrease`;

  const args = [
    '-hide_banner',
    '-loglevel', 'error'
  ];
  if (isVideo) {
    // Grab a frame a little bit in for better thumbnails.
    args.push('-ss', '00:00:01');
  }
  args.push(
    '-i', absPath,
    '-vf', vf,
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '6',
    'pipe:1'
  );

  return await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { windowsHide: true });
    const chunks = [];
    let total = 0;
    let stderr = '';

    ff.stdout.on('data', (d) => {
      chunks.push(d);
      total += d.length;
      if (total > 6 * 1024 * 1024) {
        ff.kill('SIGKILL');
        reject(new Error('Thumbnail too large'));
      }
    });
    ff.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    ff.on('error', (e) => reject(e));
    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

app.get('/api/thumbnail', async (req, res) => {
  try {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!relPath) return res.status(400).json({ error: 'path is required' });

    const widthRaw = typeof req.query.w === 'string' ? Number(req.query.w) : 160;
    const width = Number.isFinite(widthRaw) ? Math.min(Math.max(Math.floor(widthRaw), 48), 512) : 160;

    const resolved = resolveWithinRoot(mediaRoot, relPath);
    const ext = path.extname(resolved.relative).toLowerCase();
    const isVideo = VIDEO_EXT.has(ext);
    const isImage = IMAGE_EXT.has(ext);
    if (!isVideo && !isImage) return res.status(415).json({ error: 'Unsupported media type for thumbnails' });

    const absPath = path.join(mediaRoot, ...resolved.relative.split('/'));
    const st = await fs.stat(absPath);
    if (!st.isFile()) return res.status(404).json({ error: 'Not a file' });

    const cacheKey = `${resolved.relative}|${width}|${st.mtimeMs}|${st.size}`;
    const cached = thumbCache.get(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(cached);
    }

    const jpeg = await generateThumbnailJpeg({ absPath, isVideo, width });
    if (!jpeg || jpeg.length === 0) return res.status(404).json({ error: 'Failed to generate thumbnail' });

    setThumbCache(cacheKey, jpeg);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(jpeg);
  } catch (err) {
    res.status(500).json({ error: err?.message ?? 'Thumbnail failed' });
  }
});

async function listAllFilesRecursive(absRoot, relBase = '') {
  const absDir = path.join(absRoot, relBase);
  const entries = await fs.readdir(absDir, { withFileTypes: true });

  const files = [];
  for (const ent of entries) {
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      files.push(...await listAllFilesRecursive(absRoot, rel));
      continue;
    }
    if (ent.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function pickSearchFilters(body) {
  const f = body && typeof body === 'object' ? body : {};
  return {
    kind: typeof f.kind === 'string' ? f.kind : '',
    container: typeof f.container === 'string' ? f.container : '',
    videoCodec: typeof f.videoCodec === 'string' ? f.videoCodec : '',
    audioCodec: typeof f.audioCodec === 'string' ? f.audioCodec : '',
    resolution: typeof f.resolution === 'string' ? f.resolution : '',
    name: typeof f.name === 'string' ? f.name : '',
    scope: typeof f.scope === 'string' ? f.scope : 'all',
    basePath: typeof f.basePath === 'string' ? f.basePath : ''
  };
}

function parseNonNegInt(val, fallback) {
  const n = typeof val === 'string' ? Number(val) : Number(val);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 0 ? i : fallback;
}

function analysisMatchesFilters(a, filters) {
  if (!a || a.error) return false;
  if (filters.kind && a.kind !== filters.kind) return false;
  if (filters.container && (a.container?.formatName ?? '') !== filters.container) return false;
  if (filters.videoCodec && (a.video?.codec ?? '') !== filters.videoCodec) return false;
  if (filters.audioCodec && (a.audio?.codec ?? '') !== filters.audioCodec) return false;
  if (filters.resolution) {
    const w = a.video?.width;
    const h = a.video?.height;
    const res = (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) ? `${w}x${h}` : '';
    if (res !== filters.resolution) return false;
  }
  if (filters.name) {
    const q = filters.name.toLowerCase();
    const p = (a.path ?? '').toLowerCase();
    const n = (a.name ?? '').toLowerCase();
    if (!p.includes(q) && !n.includes(q)) return false;
  }
  return true;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbEnabled: isDbEnabled() });
});

app.get('/api/browse', async (req, res) => {
  try {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    const resolved = resolveWithinRoot(mediaRoot, relPath);

    // Only paginate the file list (dirs are usually small).
    // If fileLimit is omitted, keep backward-compatible behavior: return all files.
    const fileLimit = (typeof req.query.fileLimit === 'string') ? parseNonNegInt(req.query.fileLimit, null) : null;
    const fileOffset = (typeof req.query.fileOffset === 'string') ? parseNonNegInt(req.query.fileOffset, 0) : 0;

    const listing = await browsePath(mediaRoot, resolved.relative, {
      fileOffset,
      fileLimit
    });
    res.json({ mediaRoot: '/', path: listing.path, ...listing });
  } catch (err) {
    res.status(400).json({ error: err?.message ?? 'Bad request' });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'files must be a non-empty array of relative paths' });
    }

    const normalized = files.map((p) => {
      if (typeof p !== 'string') throw new Error('files must be an array of strings');
      return resolveWithinRoot(mediaRoot, p).relative;
    });

    const results = await analyzeFiles(mediaRoot, normalized);
    const dbWrite = await upsertAnalyses(dbPool, results);
    const dashboard = buildDashboard(results);
    res.json({ results, dashboard, db: dbWrite });
  } catch (err) {
    res.status(400).json({ error: err?.message ?? 'Bad request' });
  }
});

app.post('/api/db/analyses', async (req, res) => {
  try {
    if (!dbPool) {
      return res.status(400).json({ error: 'DATABASE_URL not set (DB disabled)' });
    }

    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'files must be a non-empty array of relative paths' });
    }

    const normalized = files.map((p) => {
      if (typeof p !== 'string') throw new Error('files must be an array of strings');
      return resolveWithinRoot(mediaRoot, p).relative;
    });

    const fromDb = await getAnalysesByPaths(dbPool, normalized);
    const found = new Map(fromDb.filter((a) => a && a.path).map((a) => [a.path, a]));

    const results = normalized.map((p) => {
      const hit = found.get(p);
      if (hit) return hit;
      return { path: p, error: 'Not analyzed yet (no DB entry)' };
    });

    const dashboard = buildDashboard(results);
    res.json({ results, dashboard });
  } catch (err) {
    res.status(400).json({ error: err?.message ?? 'Bad request' });
  }
});

app.get('/api/db/dashboard', async (req, res) => {
  try {
    if (!dbPool) {
      return res.status(400).json({ error: 'DATABASE_URL not set (DB disabled)' });
    }

    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'all';
    const basePath = typeof req.query.basePath === 'string' ? req.query.basePath : '';

    const scopePrefix = (() => {
      if (scope !== 'current') return '';
      const resolved = resolveWithinRoot(mediaRoot, basePath || '');
      return resolved.relative ? `${resolved.relative}/` : '';
    })();

    const dashboard = await getDashboardFromDb(dbPool, scopePrefix);
    res.json({ dashboard });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? 'Failed to load DB dashboard' });
  }
});

app.get('/api/search/options', async (req, res) => {
  try {
    const options = await getSearchOptions(dbPool);
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: err?.message ?? 'Failed to load search options' });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const filters = pickSearchFilters(req.body);
    const nameQ = filters.name.trim().toLowerCase();

    const limit = parseNonNegInt(req.body?.limit, 100);
    const offset = parseNonNegInt(req.body?.offset, 0);

    const max = Number(process.env.SEARCH_MAX_RESULTS ?? 2000);
    const maxLimit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2000;
    const safeLimit = Math.max(1, Math.min(limit || 100, maxLimit));
    const safeOffset = Math.max(0, offset || 0);

    const needsMeta = Boolean(filters.kind || filters.container || filters.videoCodec || filters.audioCodec || filters.resolution);

    // Avoid returning the entire library by default (can be huge).
    // Require at least one filter (name or metadata) to perform a search.
    if (!nameQ && !needsMeta) {
      return res.json({ results: [], total: 0, limit: safeLimit, offset: safeOffset });
    }

    const scopePrefix = (() => {
      if (filters.scope !== 'current') return '';
      const resolved = resolveWithinRoot(mediaRoot, filters.basePath || '');
      return resolved.relative ? `${resolved.relative}/` : '';
    })();

    // When metadata filters are used, search the DB directly (analyzed files only).
    if (needsMeta) {
      if (!dbPool) return res.json({ results: [], total: 0, limit: safeLimit, offset: safeOffset });

      const paged = await searchAnalysesPaged(dbPool, filters, scopePrefix, { limit: safeLimit, offset: safeOffset });
      const results = (paged.items ?? [])
        .filter((a) => a && a.path)
        .map((a) => ({ ...a, analyzed: true }));

      return res.json({ results, total: paged.total ?? results.length, limit: paged.limit ?? safeLimit, offset: paged.offset ?? safeOffset });
    }

    const allFiles = await listAllFilesRecursive(mediaRoot);
    let candidates = allFiles;

    if (scopePrefix) {
      candidates = candidates.filter((p) => p.startsWith(scopePrefix));
    }

    if (nameQ) {
      candidates = candidates.filter((p) => p.toLowerCase().includes(nameQ));
    }

    const total = candidates.length;
    const page = candidates.slice(safeOffset, safeOffset + safeLimit);

    if (!dbPool) {
      // Without DB, we can only return name matches (no metadata filtering possible).
      return res.json({
        results: page.map((p) => ({ path: p, name: path.posix.basename(p), analyzed: false })),
        total,
        limit: safeLimit,
        offset: safeOffset
      });
    }

    // Fetch analyses for current page in chunks to avoid oversized parameter payloads.
    const chunkSize = Number(process.env.SEARCH_DB_CHUNK_SIZE ?? 2000);
    const chunks = chunkArray(page, Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : 2000);
    const found = new Map();
    for (const c of chunks) {
      const analyses = await getAnalysesByPaths(dbPool, c);
      for (const a of analyses) {
        if (a && a.path) found.set(a.path, a);
      }
    }

    const results = [];
    for (const p of page) {
      const a = found.get(p);
      if (needsMeta) {
        if (a && analysisMatchesFilters(a, filters)) {
          results.push({ ...a, analyzed: true });
        }
        continue;
      }

      // No metadata filters: include all files, attach analysis if we have it.
      if (a) results.push({ ...a, analyzed: true });
      else results.push({ path: p, name: path.posix.basename(p), analyzed: false });
    }

    res.json({ results, total, limit: safeLimit, offset: safeOffset });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? 'Search failed' });
  }
});

app.post('/api/compare', async (req, res) => {
  try {
    const analyses = Array.isArray(req.body?.analyses) ? req.body.analyses : null;
    if (!analyses || analyses.length < 2) {
      return res.status(400).json({ error: 'analyses must be an array with at least 2 items' });
    }

    const comparison = compareAnalyses(analyses);
    res.json(comparison);
  } catch (err) {
    res.status(400).json({ error: err?.message ?? 'Bad request' });
  }
});

app.post('/api/analyze-all', async (req, res) => {
  try {
    const allFiles = await listAllFilesRecursive(mediaRoot);
    if (allFiles.length === 0) {
      return res.json({ analyzed: 0, errors: 0 });
    }

    const batchSize = Number(process.env.ANALYZE_ALL_BATCH_SIZE ?? 25);
    const batches = chunkArray(allFiles, Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 25);

    let analyzedOk = 0;
    let analyzedErr = 0;
    let stored = 0;
    for (const batch of batches) {
      const results = await analyzeFiles(mediaRoot, batch);
      const dbWrite = await upsertAnalyses(dbPool, results);
      stored += dbWrite?.stored ?? 0;
      for (const r of results) {
        if (r?.error) analyzedErr++;
        else analyzedOk++;
      }
    }

    res.json({ analyzed: analyzedOk, errors: analyzedErr, db: { stored } });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? 'Analyze-all failed' });
  }
});

function startMediaWatcher() {
  const enabled = String(process.env.WATCH_MEDIA ?? '1') !== '0';
  if (!enabled) return;

  const debounceMs = Number(process.env.WATCH_DEBOUNCE_MS ?? 2000);
  const delayMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 2000;
  const pending = new Map();
  const lastSignatureByRelPath = new Map();

  const schedule = (absPath) => {
    if (!absPath) return;
    const prev = pending.get(absPath);
    if (prev) clearTimeout(prev);
    const t = setTimeout(async () => {
      pending.delete(absPath);

      try {
        const rel = path.relative(mediaRoot, absPath).split(path.sep).join('/');
        // Ensure it's still within root
        const resolved = resolveWithinRoot(mediaRoot, rel);

        // Deduplicate noisy watcher events: if the file didn't change (size/mtime), skip.
        // Some filesystems can emit repeated "change" events even for reads.
        const st = await fs.stat(absPath);
        if (!st.isFile()) return;
        const sig = { mtimeMs: st.mtimeMs, size: st.size };
        const prev = lastSignatureByRelPath.get(resolved.relative);
        if (prev && prev.mtimeMs === sig.mtimeMs && prev.size === sig.size) {
          return;
        }
        lastSignatureByRelPath.set(resolved.relative, sig);

        const results = await analyzeFiles(mediaRoot, [resolved.relative]);
        const dbWrite = await upsertAnalyses(dbPool, results);
        // eslint-disable-next-line no-console
        console.log(`Auto-analyzed: ${resolved.relative} (db stored: ${dbWrite?.stored ?? 0})`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`Auto-analyze failed for ${absPath}: ${err?.message ?? err}`);
      }
    }, delayMs);
    pending.set(absPath, t);
  };

  const watcher = chokidar.watch(mediaRoot, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: delayMs,
      pollInterval: 200
    }
  });

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`Media watcher error: ${err?.message ?? err}`);
  });

  // eslint-disable-next-line no-console
  console.log(`Media watcher enabled (root=${mediaRoot}, debounce=${delayMs}ms)`);
}

async function start() {
  // Postgres may not be ready when the container starts; retry a bit.
  if (dbPool) {
    const maxAttempts = Number(process.env.DB_INIT_MAX_ATTEMPTS ?? 30);
    const delayMs = Number(process.env.DB_INIT_DELAY_MS ?? 500);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await ensureSchema(dbPool);
        // eslint-disable-next-line no-console
        console.log(`Database schema ready (attempt ${attempt}/${maxAttempts})`);
        break;
      } catch (err) {
        const isLast = attempt === maxAttempts;
        // eslint-disable-next-line no-console
        console.error(
          `DB init attempt ${attempt}/${maxAttempts} failed: ${err?.message ?? err}`
        );
        if (isLast) {
          process.exit(1);
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`MediaAnalyzer listening on port ${port}`);
    // eslint-disable-next-line no-console
    console.log(`MEDIA_ROOT=${mediaRoot}`);
    // eslint-disable-next-line no-console
    console.log(`DB=${isDbEnabled() ? 'enabled' : 'disabled'}`);

    startMediaWatcher();
  });
}

start();
