import pg from 'pg';

const { Pool } = pg;

export function isDbEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export function createPool() {
  if (!isDbEnabled()) return null;

  return new Pool({
    connectionString: process.env.DATABASE_URL
  });
}

export async function ensureSchema(pool) {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_analysis (
      id BIGSERIAL PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NULL,
      size_bytes BIGINT NULL,
      modified_at TIMESTAMPTZ NULL,
      analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      container_format TEXT NULL,
      video_codec TEXT NULL,
      audio_codec TEXT NULL,
      width INT NULL,
      height INT NULL,
      duration_sec DOUBLE PRECISION NULL,
      bit_rate BIGINT NULL,
      data JSONB NOT NULL
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_media_analysis_kind ON media_analysis(kind);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_media_analysis_container_format ON media_analysis(container_format);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_media_analysis_video_codec ON media_analysis(video_codec);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_media_analysis_audio_codec ON media_analysis(audio_codec);
  `);
}

export async function upsertAnalyses(pool, analyses) {
  if (!pool) return;
  const items = Array.isArray(analyses) ? analyses : [];

  const ok = items.filter((a) => a && !a.error && a.path);
  if (ok.length === 0) return;

  const sql = `
    INSERT INTO media_analysis (
      path, kind, size_bytes, modified_at, analyzed_at,
      container_format, video_codec, audio_codec, width, height,
      duration_sec, bit_rate, data
    )
    VALUES (
      $1,$2,$3,$4,NOW(),
      $5,$6,$7,$8,$9,
      $10,$11,$12
    )
    ON CONFLICT (path)
    DO UPDATE SET
      kind = EXCLUDED.kind,
      size_bytes = EXCLUDED.size_bytes,
      modified_at = EXCLUDED.modified_at,
      analyzed_at = NOW(),
      container_format = EXCLUDED.container_format,
      video_codec = EXCLUDED.video_codec,
      audio_codec = EXCLUDED.audio_codec,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      duration_sec = EXCLUDED.duration_sec,
      bit_rate = EXCLUDED.bit_rate,
      data = EXCLUDED.data;
  `;

  for (const a of ok) {
    await pool.query(sql, [
      a.path,
      a.kind ?? null,
      a.sizeBytes ?? null,
      a.modifiedAt ? new Date(a.modifiedAt) : null,
      a.container?.formatName ?? null,
      a.video?.codec ?? null,
      a.audio?.codec ?? null,
      a.video?.width ?? null,
      a.video?.height ?? null,
      a.durationSec ?? null,
      a.bitRate ?? null,
      a
    ]);
  }
}

export async function getAnalysesByPaths(pool, paths) {
  if (!pool) return [];
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.length) : [];
  if (list.length === 0) return [];

  const { rows } = await pool.query(
    `SELECT path, data
     FROM media_analysis
     WHERE path = ANY($1::text[]);`,
    [list]
  );

  // data is the normalized analysis JSON we stored
  return rows.map((r) => r.data);
}

export async function getSearchOptions(pool) {
  if (!pool) {
    return {
      kind: [],
      containerFormat: [],
      videoCodec: [],
      audioCodec: [],
      resolution: []
    };
  }

  const q = async (sql) => {
    const { rows } = await pool.query(sql);
    return rows.map((r) => r.v).filter(Boolean);
  };

  const [kind, containerFormat, videoCodec, audioCodec, resolution] = await Promise.all([
    q('SELECT DISTINCT kind AS v FROM media_analysis WHERE kind IS NOT NULL ORDER BY v;'),
    q('SELECT DISTINCT container_format AS v FROM media_analysis WHERE container_format IS NOT NULL ORDER BY v;'),
    q('SELECT DISTINCT video_codec AS v FROM media_analysis WHERE video_codec IS NOT NULL ORDER BY v;'),
    q('SELECT DISTINCT audio_codec AS v FROM media_analysis WHERE audio_codec IS NOT NULL ORDER BY v;'),
    q("SELECT DISTINCT (width::text || 'x' || height::text) AS v FROM media_analysis WHERE width IS NOT NULL AND height IS NOT NULL ORDER BY v;")
  ]);

  return { kind, containerFormat, videoCodec, audioCodec, resolution };
}

export async function searchAnalyses(pool, filters, scopePrefix) {
  if (!pool) return [];

  const f = filters && typeof filters === 'object' ? filters : {};
  const where = [];
  const params = [];
  let i = 1;

  const addEq = (col, val) => {
    if (!val) return;
    where.push(`${col} = $${i}`);
    params.push(val);
    i++;
  };

  addEq('kind', typeof f.kind === 'string' ? f.kind : '');
  addEq('container_format', typeof f.container === 'string' ? f.container : '');
  addEq('video_codec', typeof f.videoCodec === 'string' ? f.videoCodec : '');
  addEq('audio_codec', typeof f.audioCodec === 'string' ? f.audioCodec : '');

  const res = typeof f.resolution === 'string' ? f.resolution : '';
  if (res) {
    const m = /^\s*(\d+)x(\d+)\s*$/.exec(res);
    if (m) {
      where.push(`width = $${i}`);
      params.push(Number(m[1]));
      i++;
      where.push(`height = $${i}`);
      params.push(Number(m[2]));
      i++;
    }
  }

  const name = typeof f.name === 'string' ? f.name.trim() : '';
  if (name) {
    where.push(`path ILIKE $${i}`);
    params.push(`%${name}%`);
    i++;
  }

  const prefix = typeof scopePrefix === 'string' ? scopePrefix.trim() : '';
  if (prefix) {
    where.push(`path LIKE $${i}`);
    params.push(`${prefix.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
    i++;
  }

  const max = Number(process.env.SEARCH_MAX_RESULTS ?? 2000);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2000;

  const sql = `
    SELECT data
    FROM media_analysis
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY path
    LIMIT ${limit};
  `;

  const { rows } = await pool.query(sql, params);
  return rows.map((r) => r.data);
}
