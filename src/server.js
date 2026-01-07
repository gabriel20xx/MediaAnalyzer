import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browsePath, resolveWithinRoot } from './fsBrowse.js';
import { analyzeFiles } from './analyze.js';
import { compareAnalyses } from './compare.js';
import { buildDashboard } from './dashboard.js';
import { createPool, ensureSchema, upsertAnalyses, isDbEnabled } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const port = Number(process.env.PORT ?? 3000);
const mediaRoot = process.env.MEDIA_ROOT ?? '/media';
const dbPool = createPool();

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbEnabled: isDbEnabled() });
});

app.get('/api/browse', async (req, res) => {
  try {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    const resolved = resolveWithinRoot(mediaRoot, relPath);
    const listing = await browsePath(mediaRoot, resolved.relative);
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
    await upsertAnalyses(dbPool, results);
    const dashboard = buildDashboard(results);
    res.json({ results, dashboard });
  } catch (err) {
    res.status(400).json({ error: err?.message ?? 'Bad request' });
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
  });
}

start();
