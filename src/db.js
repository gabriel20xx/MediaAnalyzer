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
