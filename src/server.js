import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browsePath, resolveWithinRoot } from './fsBrowse.js';
import { analyzeFiles } from './analyze.js';
import { compareAnalyses } from './compare.js';
import { buildDashboard } from './dashboard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const port = Number(process.env.PORT ?? 3000);
const mediaRoot = process.env.MEDIA_ROOT ?? '/media';

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
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

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`MediaAnalyzer listening on port ${port}`);
  // eslint-disable-next-line no-console
  console.log(`MEDIA_ROOT=${mediaRoot}`);
});
