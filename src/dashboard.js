function get(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function normalizeKey(value) {
  if (value === undefined || value === null) return '(unknown)';
  if (typeof value === 'string') {
    const s = value.trim();
    return s.length ? s : '(unknown)';
  }
  return String(value);
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = normalizeKey(keyFn(item));
    map.set(k, (map.get(k) ?? 0) + 1);
  }

  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function sum(items, valueFn) {
  let total = 0;
  for (const item of items) {
    const v = Number(valueFn(item));
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

function minMax(items, valueFn) {
  let min = null;
  let max = null;
  for (const item of items) {
    const v = Number(valueFn(item));
    if (!Number.isFinite(v)) continue;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return { min, max };
}

function resolutionKey(a) {
  const w = a?.video?.width;
  const h = a?.video?.height;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return `${w}x${h}`;
}

export function buildDashboard(analyses) {
  const all = Array.isArray(analyses) ? analyses : [];
  const ok = all.filter((a) => a && !a.error);
  const errors = all.filter((a) => a && a.error);

  const totalSizeBytes = sum(ok, (a) => a.sizeBytes);
  const totalDurationSec = sum(ok, (a) => a.durationSec);

  const bitRateMinMax = minMax(ok, (a) => a.bitRate);
  const durationMinMax = minMax(ok, (a) => a.durationSec);

  return {
    totals: {
      selectedCount: all.length,
      analyzedOkCount: ok.length,
      analyzedErrorCount: errors.length,
      totalSizeBytes,
      totalDurationSec,
      bitRate: {
        min: bitRateMinMax.min,
        max: bitRateMinMax.max
      },
      durationSec: {
        min: durationMinMax.min,
        max: durationMinMax.max
      }
    },

    counts: {
      kind: countBy(ok, (a) => a.kind),
      containerFormat: countBy(ok, (a) => get(a, 'container.formatName')),
      videoCodec: countBy(ok, (a) => get(a, 'video.codec')),
      audioCodec: countBy(ok, (a) => get(a, 'audio.codec')),
      resolution: countBy(ok, (a) => resolutionKey(a))
    }
  };
}
