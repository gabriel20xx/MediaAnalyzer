function get(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function normalizeForCompare(value) {
  if (value === undefined) return null;
  if (value === '') return null;
  return value;
}

export function compareAnalyses(analyses) {
  // Compare a small, useful set of fields (kept intentionally simple)
  const fields = [
    'kind',
    'sizeBytes',
    'container.formatName',
    'video.codec',
    'video.width',
    'video.height',
    'audio.codec',
    'audio.sampleRate',
    'audio.channels',
    'durationSec',
    'bitRate'
  ];

  const items = analyses.map((a) => ({
    path: a?.path ?? null,
    name: a?.name ?? null,
    analysis: a
  }));

  const similarities = {};
  const differences = {};

  for (const field of fields) {
    const values = items.map((it) => normalizeForCompare(get(it.analysis, field)));
    const first = values[0];
    const allSame = values.every((v) => v === first);

    if (allSame) {
      similarities[field] = first;
    } else {
      differences[field] = items.map((it, idx) => ({
        path: it.path,
        value: values[idx]
      }));
    }
  }

  return {
    count: items.length,
    files: items.map((it) => ({ path: it.path, name: it.name })),
    similarities,
    differences
  };
}
