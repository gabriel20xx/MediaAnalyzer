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
  if (!pool) return { attempted: 0, stored: 0 };
  const items = Array.isArray(analyses) ? analyses : [];

  const rows = items.filter((a) => a && a.path);
  if (rows.length === 0) return { attempted: 0, stored: 0 };

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

  let stored = 0;
  for (const a of rows) {
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
    stored++;
  }

  return { attempted: rows.length, stored };
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

export async function searchAnalysesPaged(pool, filters, scopePrefix, { limit, offset } = {}) {
  if (!pool) return { items: [], total: 0, limit: 0, offset: 0 };

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
    where.push(`path LIKE $${i} ESCAPE E'\\\\'`);
    params.push(`${escapeLikePrefix(prefix)}%`);
    i++;
  }

  const max = Number(process.env.SEARCH_MAX_RESULTS ?? 2000);
  const maxLimit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2000;
  const limRaw = Number(limit);
  const offRaw = Number(offset);
  const safeLimit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), maxLimit) : Math.min(100, maxLimit);
  const safeOffset = Number.isFinite(offRaw) && offRaw > 0 ? Math.floor(offRaw) : 0;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalSql = `
    SELECT COUNT(*)::bigint AS c
    FROM media_analysis
    ${whereSql};
  `;
  const { rows: totalRows } = await pool.query(totalSql, params);
  const total = Number(totalRows?.[0]?.c ?? 0);

  const itemsSql = `
    SELECT data
    FROM media_analysis
    ${whereSql}
    ORDER BY path
    LIMIT $${i} OFFSET $${i + 1};
  `;
  const { rows } = await pool.query(itemsSql, [...params, safeLimit, safeOffset]);
  const items = rows.map((r) => r.data);
  return { items, total, limit: safeLimit, offset: safeOffset };
}

function escapeLikePrefix(prefix) {
  return prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export async function getDashboardFromDb(pool, scopePrefix = '') {
  if (!pool) {
    return {
      totals: {
        selectedCount: 0,
        analyzedOkCount: 0,
        analyzedErrorCount: 0,
        totalSizeBytes: 0,
        totalDurationSec: 0,
        bitRate: { min: null, max: null },
        durationSec: { min: null, max: null }
      },
      counts: {
        kind: [],
        containerFormat: [],
        videoCodec: [],
        pixelFormat: [],
        frameRate: [],
        audioCodec: [],
        audioSampleRate: [],
        audioChannels: [],
        resolution: []
      }
    };
  }

  const prefix = typeof scopePrefix === 'string' ? scopePrefix.trim() : '';
  const where = prefix ? "WHERE path LIKE $1 ESCAPE E'\\\\'" : '';
  const params = prefix ? [`${escapeLikePrefix(prefix)}%`] : [];

  const q = async (sql) => {
    const { rows } = await pool.query(sql, params);
    return rows;
  };

  const totalsSql = `
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN (data ? 'error') THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN NOT (data ? 'error') THEN 1 ELSE 0 END) AS ok_count,
      COALESCE(SUM(CASE WHEN NOT (data ? 'error') THEN size_bytes ELSE 0 END), 0) AS total_size_bytes,
      COALESCE(SUM(CASE WHEN NOT (data ? 'error') THEN duration_sec ELSE 0 END), 0) AS total_duration_sec,
      MIN(CASE WHEN NOT (data ? 'error') THEN bit_rate ELSE NULL END) AS bit_rate_min,
      MAX(CASE WHEN NOT (data ? 'error') THEN bit_rate ELSE NULL END) AS bit_rate_max,
      MIN(CASE WHEN NOT (data ? 'error') THEN duration_sec ELSE NULL END) AS duration_min,
      MAX(CASE WHEN NOT (data ? 'error') THEN duration_sec ELSE NULL END) AS duration_max
    FROM media_analysis
    ${where};
  `;

  const groupSql = (col, alias) => `
    SELECT ${col} AS key, COUNT(*)::int AS count
    FROM media_analysis
    ${where ? `${where} AND NOT (data ? 'error')` : 'WHERE NOT (data ? \'error\')'}
    AND ${col} IS NOT NULL
    GROUP BY ${col}
    ORDER BY count DESC, key ASC;
  `;

  const groupExprSql = (expr) => `
    SELECT ${expr} AS key, COUNT(*)::int AS count
    FROM media_analysis
    ${where ? `${where} AND NOT (data ? 'error')` : 'WHERE NOT (data ? \'error\')'}
    AND ${expr} IS NOT NULL
    AND ${expr} <> ''
    GROUP BY 1
    ORDER BY count DESC, key ASC;
  `;

  const resolutionSql = `
    SELECT (width::text || 'x' || height::text) AS key, COUNT(*)::int AS count
    FROM media_analysis
    ${where ? `${where} AND NOT (data ? 'error')` : 'WHERE NOT (data ? \'error\')'}
    AND width IS NOT NULL AND height IS NOT NULL
    GROUP BY width, height
    ORDER BY count DESC, key ASC;
  `;

  const [
    totalsRows,
    kindRows,
    containerRows,
    vcodecRows,
    pixfmtRows,
    frRows,
    acodecRows,
    asrRows,
    achRows,
    resRows
  ] = await Promise.all([
    q(totalsSql),
    q(groupSql('kind', 'kind')),
    q(groupSql('container_format', 'containerFormat')),
    q(groupSql('video_codec', 'videoCodec')),
    q(groupExprSql("(data->'video'->>'pixelFormat')")),
    q(groupExprSql("(data->'video'->>'frameRate')")),
    q(groupSql('audio_codec', 'audioCodec')),
    q(groupExprSql("(data->'audio'->>'sampleRate')")),
    q(groupExprSql("(data->'audio'->>'channels')")),
    q(resolutionSql)
  ]);

  const t = totalsRows?.[0] ?? {};
  const toInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const toNumOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    totals: {
      selectedCount: 0,
      analyzedOkCount: toInt(t.ok_count),
      analyzedErrorCount: toInt(t.error_count),
      totalSizeBytes: toInt(t.total_size_bytes),
      totalDurationSec: toNumOrNull(t.total_duration_sec) ?? 0,
      bitRate: {
        min: toNumOrNull(t.bit_rate_min),
        max: toNumOrNull(t.bit_rate_max)
      },
      durationSec: {
        min: toNumOrNull(t.duration_min),
        max: toNumOrNull(t.duration_max)
      }
    },
    counts: {
      kind: kindRows.map((r) => ({ key: r.key, count: r.count })),
      containerFormat: containerRows.map((r) => ({ key: r.key, count: r.count })),
      videoCodec: vcodecRows.map((r) => ({ key: r.key, count: r.count })),
      pixelFormat: pixfmtRows.map((r) => ({ key: r.key, count: r.count })),
      frameRate: frRows.map((r) => ({ key: r.key, count: r.count })),
      audioCodec: acodecRows.map((r) => ({ key: r.key, count: r.count })),
      audioSampleRate: asrRows.map((r) => ({ key: r.key, count: r.count })),
      audioChannels: achRows.map((r) => ({ key: r.key, count: r.count })),
      resolution: resRows.map((r) => ({ key: r.key, count: r.count }))
    }
  };
}

export async function getDashboardMatchesPaged(pool, match, scopePrefix = '', { limit, offset } = {}) {
  if (!pool) return { items: [], total: 0, limit: 0, offset: 0 };

  const m = match && typeof match === 'object' ? match : {};
  const key = typeof m.key === 'string' ? m.key.trim() : '';
  const value = typeof m.value === 'string' ? m.value : '';
  const status = typeof m.status === 'string' ? m.status.trim() : '';

  const where = [];
  const params = [];
  let i = 1;

  const prefix = typeof scopePrefix === 'string' ? scopePrefix.trim() : '';
  if (prefix) {
    where.push(`path LIKE $${i} ESCAPE E'\\\\'`);
    params.push(`${escapeLikePrefix(prefix)}%`);
    i++;
  }

  const applyStatus = (s) => {
    if (s === 'ok') where.push(`NOT (data ? 'error')`);
    else if (s === 'error') where.push(`(data ? 'error')`);
  };

  if (status) applyStatus(status);
  else if (key && key !== 'status' && key !== 'all') {
    // Dashboard counts exclude errors by design.
    where.push(`NOT (data ? 'error')`);
  }

  const addEq = (sqlExpr, val) => {
    if (val === null || val === undefined || val === '') return;
    where.push(`${sqlExpr} = $${i}`);
    params.push(val);
    i++;
  };

  if (key === 'all') {
    // no-op
  } else if (key === 'status') {
    applyStatus(value);
  } else if (key === 'kind') {
    addEq('kind', value);
  } else if (key === 'containerFormat') {
    addEq('container_format', value);
  } else if (key === 'videoCodec') {
    addEq('video_codec', value);
  } else if (key === 'audioCodec') {
    addEq('audio_codec', value);
  } else if (key === 'pixelFormat') {
    addEq("(data->'video'->>'pixelFormat')", value);
  } else if (key === 'frameRate') {
    addEq("(data->'video'->>'frameRate')", value);
  } else if (key === 'audioSampleRate') {
    addEq("(data->'audio'->>'sampleRate')", value);
  } else if (key === 'audioChannels') {
    addEq("(data->'audio'->>'channels')", value);
  } else if (key === 'resolution') {
    const res = typeof value === 'string' ? value : '';
    const mm = /^\s*(\d+)x(\d+)\s*$/.exec(res);
    if (mm) {
      where.push(`width = $${i}`);
      params.push(Number(mm[1]));
      i++;
      where.push(`height = $${i}`);
      params.push(Number(mm[2]));
      i++;
    }
  }

  const max = Number(process.env.SEARCH_MAX_RESULTS ?? 2000);
  const maxLimit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 2000;
  const limRaw = Number(limit);
  const offRaw = Number(offset);
  const safeLimit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), maxLimit) : Math.min(100, maxLimit);
  const safeOffset = Number.isFinite(offRaw) && offRaw > 0 ? Math.floor(offRaw) : 0;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalSql = `
    SELECT COUNT(*)::bigint AS c
    FROM media_analysis
    ${whereSql};
  `;
  const { rows: totalRows } = await pool.query(totalSql, params);
  const total = Number(totalRows?.[0]?.c ?? 0);

  const itemsSql = `
    SELECT data
    FROM media_analysis
    ${whereSql}
    ORDER BY path
    LIMIT $${i} OFFSET $${i + 1};
  `;
  const { rows } = await pool.query(itemsSql, [...params, safeLimit, safeOffset]);
  const items = rows.map((r) => r.data);
  return { items, total, limit: safeLimit, offset: safeOffset };
}
