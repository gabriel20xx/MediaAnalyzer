let currentPath = '';
let selected = new Set();
let lastAnalyses = [];
let lastDashboard = null;
let analyzeTimer = null;
let expanded = new Set();
let analysisByPath = new Map();

const filters = {
  kind: '',
  container: '',
  videoCodec: '',
  audioCodec: '',
  resolution: '',
  name: ''
};

const el = (id) => document.getElementById(id);

function joinPath(base, name) {
  const b = (base ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  const n = (name ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!b) return n;
  if (!n) return b;
  return `${b}/${n}`;
}

function parentPath(p) {
  const parts = (p ?? '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function prettyBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function fmt(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function fmtResolution(a) {
  const w = a?.video?.width;
  const h = a?.video?.height;
  if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) return `${w}x${h}`;
  return '—';
}

function fmtDuration(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const minutes = Math.floor(sec / 60);
  const seconds = sec - minutes * 60;
  return `${minutes}m ${seconds.toFixed(0)}s`;
}

function dashKvRow(key, value) {
  const k = document.createElement('div');
  k.className = 'dashRowKey';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'dashRowVal';
  v.textContent = fmt(value);
  return [k, v];
}

function detailsKvRow(key, value) {
  const k = document.createElement('div');
  k.className = 'kvKey';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'kvVal';
  v.textContent = fmt(value);
  return [k, v];
}

function setSelectOptions(selectEl, values) {
  if (!selectEl) return;
  const prev = selectEl.value;
  selectEl.innerHTML = '';
  const optAny = document.createElement('option');
  optAny.value = '';
  optAny.textContent = 'Any';
  selectEl.appendChild(optAny);

  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  }
  selectEl.value = prev;
}

function renderAnalysisDetails(analysis) {
  const wrap = document.createElement('div');
  wrap.className = 'inlineDetails';

  if (!analysis) {
    wrap.textContent = 'No details available.';
    return wrap;
  }
  if (analysis.error) {
    const header = document.createElement('div');
    header.className = 'detailsHeader';
    const title = document.createElement('div');
    title.className = 'detailsTitle';
    title.textContent = analysis.path ?? 'File';
    const meta = document.createElement('div');
    meta.className = 'detailsMeta';
    meta.textContent = `Error: ${analysis.error}`;
    header.appendChild(title);
    header.appendChild(meta);
    wrap.appendChild(header);
    return wrap;
  }

  const header = document.createElement('div');
  header.className = 'detailsHeader';
  const title = document.createElement('div');
  title.className = 'detailsTitle';
  title.textContent = analysis.name ?? analysis.path ?? 'File';
  const meta = document.createElement('div');
  meta.className = 'detailsMeta';
  meta.textContent = `${fmt(analysis.kind)} • ${fmt(prettyBytes(analysis.sizeBytes))}`;
  header.appendChild(title);
  header.appendChild(meta);
  wrap.appendChild(header);

  const sections = document.createElement('div');
  sections.className = 'detailsSections';

  const basics = document.createElement('div');
  basics.className = 'detailsSection';
  const basicsTitle = document.createElement('div');
  basicsTitle.className = 'detailsSectionTitle';
  basicsTitle.textContent = 'Basics';
  const basicsKv = document.createElement('div');
  basicsKv.className = 'kv';
  basicsKv.append(...detailsKvRow('Path', analysis.path));
  basicsKv.append(...detailsKvRow('Type', analysis.kind));
  basicsKv.append(...detailsKvRow('Size', prettyBytes(analysis.sizeBytes)));
  basicsKv.append(...detailsKvRow('Modified', analysis.modifiedAt));
  basicsKv.append(...detailsKvRow('Duration', fmtDuration(analysis.durationSec)));
  basicsKv.append(...detailsKvRow('Bitrate', analysis.bitRate ? `${analysis.bitRate} bps` : '—'));
  basics.appendChild(basicsTitle);
  basics.appendChild(basicsKv);

  const container = document.createElement('div');
  container.className = 'detailsSection';
  const containerTitle = document.createElement('div');
  containerTitle.className = 'detailsSectionTitle';
  containerTitle.textContent = 'Container';
  const containerKv = document.createElement('div');
  containerKv.className = 'kv';
  containerKv.append(...detailsKvRow('Format', analysis.container?.formatName));
  containerKv.append(...detailsKvRow('Format (long)', analysis.container?.formatLongName));
  container.appendChild(containerTitle);
  container.appendChild(containerKv);

  const video = document.createElement('div');
  video.className = 'detailsSection';
  const videoTitle = document.createElement('div');
  videoTitle.className = 'detailsSectionTitle';
  videoTitle.textContent = 'Video';
  const videoKv = document.createElement('div');
  videoKv.className = 'kv';
  videoKv.append(...detailsKvRow('Codec', analysis.video?.codec));
  videoKv.append(...detailsKvRow('Codec (long)', analysis.video?.codecLongName));
  videoKv.append(...detailsKvRow('Resolution', fmtResolution(analysis)));
  videoKv.append(...detailsKvRow('Pixel format', analysis.video?.pixelFormat));
  videoKv.append(...detailsKvRow('Frame rate', analysis.video?.frameRate));
  video.appendChild(videoTitle);
  video.appendChild(videoKv);

  const audio = document.createElement('div');
  audio.className = 'detailsSection';
  const audioTitle = document.createElement('div');
  audioTitle.className = 'detailsSectionTitle';
  audioTitle.textContent = 'Audio';
  const audioKv = document.createElement('div');
  audioKv.className = 'kv';
  audioKv.append(...detailsKvRow('Codec', analysis.audio?.codec));
  audioKv.append(...detailsKvRow('Codec (long)', analysis.audio?.codecLongName));
  audioKv.append(...detailsKvRow('Sample rate', analysis.audio?.sampleRate ? `${analysis.audio.sampleRate} Hz` : '—'));
  audioKv.append(...detailsKvRow('Channels', analysis.audio?.channels));
  audio.appendChild(audioTitle);
  audio.appendChild(audioKv);

  sections.appendChild(basics);
  sections.appendChild(container);
  sections.appendChild(video);
  sections.appendChild(audio);
  wrap.appendChild(sections);

  return wrap;
}

function setStatus(msg) {
  el('status').textContent = msg;
}

function renderDashboard(dashboard) {
  lastDashboard = dashboard ?? null;

  const totalsEl = el('dashTotals');
  const kindEl = el('dashKind');
  const containerEl = el('dashContainer');
  const vcodecEl = el('dashVideoCodec');
  const acodecEl = el('dashAudioCodec');
  const resEl = el('dashResolution');

  if (!totalsEl) return;

  const dash = lastDashboard;

  const safeTotals = dash?.totals ?? {
    selectedCount: 0,
    analyzedOkCount: 0,
    analyzedErrorCount: 0,
    totalSizeBytes: 0,
    totalDurationSec: 0,
    bitRate: { min: null, max: null },
    durationSec: { min: null, max: null }
  };

  const bitRateRange = (safeTotals.bitRate?.min || safeTotals.bitRate?.max)
    ? `${fmt(safeTotals.bitRate?.min)} – ${fmt(safeTotals.bitRate?.max)} bps`
    : '—';

  const durationRange = (safeTotals.durationSec?.min || safeTotals.durationSec?.max)
    ? `${fmtDuration(safeTotals.durationSec?.min)} – ${fmtDuration(safeTotals.durationSec?.max)}`
    : '—';

  totalsEl.innerHTML = '';
  totalsEl.append(...dashKvRow('Selected', safeTotals.selectedCount));
  totalsEl.append(...dashKvRow('Analyzed OK', safeTotals.analyzedOkCount));
  totalsEl.append(...dashKvRow('Analyze errors', safeTotals.analyzedErrorCount));
  totalsEl.append(...dashKvRow('Total size', prettyBytes(safeTotals.totalSizeBytes) ?? '—'));
  totalsEl.append(...dashKvRow('Total duration', fmtDuration(safeTotals.totalDurationSec)));
  totalsEl.append(...dashKvRow('Duration range', durationRange));
  totalsEl.append(...dashKvRow('Bitrate range', bitRateRange));

  function renderCountList(targetEl, items) {
    if (!targetEl) return;
    targetEl.innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted small';
      empty.textContent = '—';
      targetEl.appendChild(empty);
      return;
    }
    for (const it of list.slice(0, 12)) {
      const row = document.createElement('div');
      row.className = 'dashItem';
      const key = document.createElement('div');
      key.className = 'dashItemKey';
      key.textContent = fmt(it.key);
      const pill = document.createElement('div');
      pill.className = 'dashPill';
      pill.textContent = fmt(it.count);
      row.appendChild(key);
      row.appendChild(pill);
      targetEl.appendChild(row);
    }
  }

  renderCountList(kindEl, dash?.counts?.kind);
  renderCountList(containerEl, dash?.counts?.containerFormat);
  renderCountList(vcodecEl, dash?.counts?.videoCodec);
  renderCountList(acodecEl, dash?.counts?.audioCodec);
  renderCountList(resEl, dash?.counts?.resolution);

  // Populate filter dropdowns from dashboard values
  setSelectOptions(el('filterKind'), (dash?.counts?.kind ?? []).map((x) => x.key));
  setSelectOptions(el('filterContainer'), (dash?.counts?.containerFormat ?? []).map((x) => x.key));
  setSelectOptions(el('filterVideoCodec'), (dash?.counts?.videoCodec ?? []).map((x) => x.key));
  setSelectOptions(el('filterAudioCodec'), (dash?.counts?.audioCodec ?? []).map((x) => x.key));
  setSelectOptions(el('filterResolution'), (dash?.counts?.resolution ?? []).map((x) => x.key));

  renderAnalyzedTable();
}

function matchesFilters(a) {
  if (!a || a.error) return false;
  if (filters.kind && a.kind !== filters.kind) return false;
  if (filters.container && (a.container?.formatName ?? '') !== filters.container) return false;
  if (filters.videoCodec && (a.video?.codec ?? '') !== filters.videoCodec) return false;
  if (filters.audioCodec && (a.audio?.codec ?? '') !== filters.audioCodec) return false;
  if (filters.resolution && fmtResolution(a) !== filters.resolution) return false;
  if (filters.name) {
    const n = (a.name ?? '').toLowerCase();
    const p = (a.path ?? '').toLowerCase();
    const q = filters.name.toLowerCase();
    if (!n.includes(q) && !p.includes(q)) return false;
  }
  return true;
}

function renderAnalyzedTable() {
  const table = el('analyzedTable');
  if (!table) return;
  table.innerHTML = '';

  const analyses = Array.isArray(lastAnalyses) ? lastAnalyses : [];
  const filtered = analyses.filter(matchesFilters);

  const summary = el('filterSummary');
  if (summary) {
    summary.textContent = filtered.length ? `${filtered.length}/${analyses.length} shown` : `0/${analyses.length} shown`;
  }

  const header = document.createElement('div');
  header.className = 'tableRow tableHeader';
  const headers = ['File', 'Kind', 'Size', 'Video', 'Audio', 'Res'];
  for (const h of headers) {
    const c = document.createElement('div');
    c.className = 'cell';
    c.textContent = h;
    header.appendChild(c);
  }
  table.appendChild(header);

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.style.padding = '10px';
    empty.textContent = 'No files match the current filters.';
    table.appendChild(empty);
    return;
  }

  for (const a of filtered) {
    const row = document.createElement('div');
    row.className = 'tableRow';
    row.style.cursor = 'pointer';
    row.onclick = () => {
      const p = a.path;
      if (!p) return;
      if (expanded.has(p)) expanded.delete(p);
      else expanded.add(p);
      browse(currentPath);
      renderAnalyzedTable();
    };

    const cells = [
      a.name ?? a.path,
      a.kind,
      prettyBytes(a.sizeBytes) ?? '—',
      a.video?.codec ?? '—',
      a.audio?.codec ?? '—',
      fmtResolution(a)
    ];
    for (const v of cells) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.textContent = fmt(v);
      row.appendChild(c);
    }
    table.appendChild(row);

    if (a.path && expanded.has(a.path)) {
      const detailsWrap = document.createElement('div');
      detailsWrap.style.padding = '0 10px 10px';
      detailsWrap.appendChild(renderAnalysisDetails(a));
      table.appendChild(detailsWrap);
    }
  }
}

function renderSelected() {
  const list = el('selectedList');
  list.innerHTML = '';

  const summary = el('selectionSummary');
  if (summary) {
    const selectedPaths = Array.from(selected.values());
    const known = selectedPaths.map((p) => analysisByPath.get(p)).filter(Boolean);
    const ok = known.filter((a) => a && !a.error);
    const err = known.filter((a) => a && a.error);
    const totalSize = ok.reduce((sum, a) => sum + (typeof a.sizeBytes === 'number' ? a.sizeBytes : 0), 0);
    const totalDur = ok.reduce((sum, a) => sum + (typeof a.durationSec === 'number' ? a.durationSec : 0), 0);

    const parts = [];
    parts.push(`Selected: ${selectedPaths.length}`);
    if (known.length > 0) {
      parts.push(`Analyzed OK: ${ok.length}`);
      if (err.length) parts.push(`Errors: ${err.length}`);
      if (totalSize) parts.push(`Size: ${prettyBytes(totalSize)}`);
      if (totalDur) parts.push(`Duration: ${fmtDuration(totalDur)}`);
    }
    summary.textContent = parts.join(' • ');
  }

  const items = Array.from(selected.values()).sort((a, b) => a.localeCompare(b));
  for (const p of items) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'itemName';
    name.textContent = p;
    li.appendChild(name);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Remove';
    btn.onclick = () => {
      selected.delete(p);
      renderSelected();
      scheduleAnalyze();
    };

    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function analyzeAllFolders() {
  setStatus('Analyzing all media (all folders)…');
  const resp = await fetch('/api/analyze-all', { method: 'POST' });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Analyze-all failed');
  const analyzed = typeof data.analyzed === 'number' ? data.analyzed : 0;
  const errors = typeof data.errors === 'number' ? data.errors : 0;
  setStatus(`Analyze-all complete: ${analyzed} analyzed, ${errors} errors.`);
}

async function analyzeOne(filePath) {
  const resp = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [filePath] })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Analyze failed');

  const result = Array.isArray(data.results) ? data.results[0] : null;
  if (result && result.path) {
    analysisByPath.set(result.path, result);
  }
  return result;
}

function renderBrowse(data) {
  currentPath = data.path ?? '';
  el('currentPath').textContent = '/' + currentPath;

  const dirList = el('dirList');
  const fileList = el('fileList');
  dirList.innerHTML = '';
  fileList.innerHTML = '';

  for (const d of data.dirs ?? []) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'itemName';
    name.textContent = d;
    li.appendChild(name);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Open';
    btn.onclick = () => browse(joinPath(currentPath, d));

    li.appendChild(btn);
    dirList.appendChild(li);
  }

  for (const f of data.files ?? []) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'itemName';
    name.textContent = f;
    li.appendChild(name);

    const p = joinPath(currentPath, f);

    const btnDetails = document.createElement('button');
    btnDetails.className = 'btn';
    btnDetails.textContent = expanded.has(p) ? 'Hide' : 'Details';
    btnDetails.onclick = async () => {
      if (expanded.has(p)) {
        expanded.delete(p);
        browse(currentPath);
        return;
      }

      expanded.add(p);
      setStatus('Analyzing file…');
      try {
        if (!analysisByPath.has(p)) {
          await analyzeOne(p);
        }
        setStatus('');
      } catch (e) {
        setStatus(e.message);
      }
      browse(currentPath);
    };

    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = selected.has(p) ? 'Selected' : 'Select';
    btn.onclick = () => {
      if (selected.has(p)) selected.delete(p);
      else selected.add(p);
      renderSelected();
      browse(currentPath); // refresh button labels
      scheduleAnalyze();
    };

    li.appendChild(btnDetails);
    li.appendChild(btn);
    fileList.appendChild(li);

    if (expanded.has(p)) {
      const analysis = analysisByPath.get(p);
      const detailsRow = document.createElement('li');
      detailsRow.className = 'detailsRow';
      detailsRow.appendChild(renderAnalysisDetails(analysis ?? { path: p, error: 'Not analyzed yet' }));
      fileList.appendChild(detailsRow);
    }
  }
}

async function browse(pathRel) {
  setStatus('Loading directory…');
  const q = encodeURIComponent(pathRel ?? '');
  const resp = await fetch(`/api/browse?path=${q}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Browse failed');
  renderBrowse(data);
  setStatus('');
}

async function analyzeSelected() {
  const files = Array.from(selected.values());
  if (files.length === 0) {
    setStatus('Select one or more files first.');
    return;
  }

  setStatus(`Analyzing ${files.length} file(s)…`);

  const resp = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Analyze failed');

  lastAnalyses = data.results ?? [];
  analysisByPath = new Map(
    lastAnalyses
      .filter((a) => a && a.path)
      .map((a) => [a.path, a])
  );
  renderDashboard(data.dashboard);
  renderSelected();

  // show a compact view plus raw
  const compact = lastAnalyses.map((a) => {
    if (a.error) return a;
    return {
      path: a.path,
      kind: a.kind,
      size: prettyBytes(a.sizeBytes),
      container: a.container?.formatName,
      video: a.video?.codec,
      resolution: a.video?.width && a.video?.height ? `${a.video.width}x${a.video.height}` : null,
      audio: a.audio?.codec,
      durationSec: a.durationSec,
      bitRate: a.bitRate
    };
  });

  el('output').textContent = JSON.stringify({ compact, raw: lastAnalyses }, null, 2);
  setStatus('Analyze complete.');
}

async function analyzeAllInCurrentFolder() {
  setStatus('Loading folder…');
  const q = encodeURIComponent(currentPath ?? '');
  const resp = await fetch(`/api/browse?path=${q}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Browse failed');
  const files = Array.isArray(data.files) ? data.files : [];
  if (files.length === 0) {
    setStatus('No files in this folder.');
    return;
  }
  selected = new Set(files.map((f) => joinPath(currentPath, f)));
  expanded = new Set();
  renderSelected();
  setStatus(`Analyzing ${files.length} file(s)…`);
  await analyzeSelected();
}

function scheduleAnalyze() {
  if (analyzeTimer) {
    clearTimeout(analyzeTimer);
  }
  analyzeTimer = setTimeout(() => {
    analyzeSelected().catch((e) => setStatus(e.message));
  }, 450);
}

async function compare() {
  if (!Array.isArray(lastAnalyses) || lastAnalyses.length < 2) {
    setStatus('Analyze at least 2 files first.');
    return;
  }

  const good = lastAnalyses.filter((a) => !a.error);
  if (good.length < 2) {
    setStatus('Need at least 2 successfully analyzed files.');
    return;
  }

  setStatus('Comparing…');

  const resp = await fetch('/api/compare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ analyses: good })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Compare failed');

  el('output').textContent = JSON.stringify(data, null, 2);
  setStatus('Compare complete.');
}

function wire() {
  el('btnRefresh').onclick = () => browse(currentPath);
  el('btnUp').onclick = () => browse(parentPath(currentPath));
  el('btnAnalyze').onclick = () => analyzeSelected().catch((e) => setStatus(e.message));
  el('btnCompare').onclick = () => compare().catch((e) => setStatus(e.message));

  const btnAnalyzeAll = el('btnAnalyzeAll');
  if (btnAnalyzeAll) {
    btnAnalyzeAll.onclick = () => analyzeAllInCurrentFolder().catch((e) => setStatus(e.message));
  }

  const btnAnalyzeAllGlobal = el('btnAnalyzeAllGlobal');
  if (btnAnalyzeAllGlobal) {
    btnAnalyzeAllGlobal.onclick = () => analyzeAllFolders().catch((e) => setStatus(e.message));
  }

  const bindFilter = (id, key) => {
    const node = el(id);
    if (!node) return;
    node.addEventListener('input', () => {
      filters[key] = node.value ?? '';
      renderAnalyzedTable();
    });
    node.addEventListener('change', () => {
      filters[key] = node.value ?? '';
      renderAnalyzedTable();
    });
  };

  bindFilter('filterKind', 'kind');
  bindFilter('filterContainer', 'container');
  bindFilter('filterVideoCodec', 'videoCodec');
  bindFilter('filterAudioCodec', 'audioCodec');
  bindFilter('filterResolution', 'resolution');
  bindFilter('filterName', 'name');

  const clear = el('btnClearFilters');
  if (clear) {
    clear.onclick = () => {
      filters.kind = '';
      filters.container = '';
      filters.videoCodec = '';
      filters.audioCodec = '';
      filters.resolution = '';
      filters.name = '';

      const ids = ['filterKind', 'filterContainer', 'filterVideoCodec', 'filterAudioCodec', 'filterResolution', 'filterName'];
      for (const id of ids) {
        const n = el(id);
        if (n) n.value = '';
      }
      renderAnalyzedTable();
    };
  }
}

wire();
renderSelected();
renderDashboard(null);
browse('').catch((e) => {
  setStatus(`Browse failed: ${e.message}`);
});
