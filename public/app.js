let currentPath = '';
let selected = new Set();
let lastAnalyses = [];
let lastDashboard = null;
let analyzeTimer = null;
let expanded = new Set();
let analysisByPath = new Map();

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

function kvRow(key, value) {
  const k = document.createElement('div');
  k.className = 'dashRowKey';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'dashRowVal';
  v.textContent = fmt(value);
  return [k, v];
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
  basicsKv.append(...kvRow('Path', analysis.path));
  basicsKv.append(...kvRow('Type', analysis.kind));
  basicsKv.append(...kvRow('Size', prettyBytes(analysis.sizeBytes)));
  basicsKv.append(...kvRow('Modified', analysis.modifiedAt));
  basicsKv.append(...kvRow('Duration', fmtDuration(analysis.durationSec)));
  basicsKv.append(...kvRow('Bitrate', analysis.bitRate ? `${analysis.bitRate} bps` : '—'));
  basics.appendChild(basicsTitle);
  basics.appendChild(basicsKv);

  const container = document.createElement('div');
  container.className = 'detailsSection';
  const containerTitle = document.createElement('div');
  containerTitle.className = 'detailsSectionTitle';
  containerTitle.textContent = 'Container';
  const containerKv = document.createElement('div');
  containerKv.className = 'kv';
  containerKv.append(...kvRow('Format', analysis.container?.formatName));
  containerKv.append(...kvRow('Format (long)', analysis.container?.formatLongName));
  container.appendChild(containerTitle);
  container.appendChild(containerKv);

  const video = document.createElement('div');
  video.className = 'detailsSection';
  const videoTitle = document.createElement('div');
  videoTitle.className = 'detailsSectionTitle';
  videoTitle.textContent = 'Video';
  const videoKv = document.createElement('div');
  videoKv.className = 'kv';
  videoKv.append(...kvRow('Codec', analysis.video?.codec));
  videoKv.append(...kvRow('Codec (long)', analysis.video?.codecLongName));
  videoKv.append(...kvRow('Resolution', fmtResolution(analysis)));
  videoKv.append(...kvRow('Pixel format', analysis.video?.pixelFormat));
  videoKv.append(...kvRow('Frame rate', analysis.video?.frameRate));
  video.appendChild(videoTitle);
  video.appendChild(videoKv);

  const audio = document.createElement('div');
  audio.className = 'detailsSection';
  const audioTitle = document.createElement('div');
  audioTitle.className = 'detailsSectionTitle';
  audioTitle.textContent = 'Audio';
  const audioKv = document.createElement('div');
  audioKv.className = 'kv';
  audioKv.append(...kvRow('Codec', analysis.audio?.codec));
  audioKv.append(...kvRow('Codec (long)', analysis.audio?.codecLongName));
  audioKv.append(...kvRow('Sample rate', analysis.audio?.sampleRate ? `${analysis.audio.sampleRate} Hz` : '—'));
  audioKv.append(...kvRow('Channels', analysis.audio?.channels));
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
  totalsEl.append(...kvRow('Selected', safeTotals.selectedCount));
  totalsEl.append(...kvRow('Analyzed OK', safeTotals.analyzedOkCount));
  totalsEl.append(...kvRow('Analyze errors', safeTotals.analyzedErrorCount));
  totalsEl.append(...kvRow('Total size', prettyBytes(safeTotals.totalSizeBytes) ?? '—'));
  totalsEl.append(...kvRow('Total duration', fmtDuration(safeTotals.totalDurationSec)));
  totalsEl.append(...kvRow('Duration range', durationRange));
  totalsEl.append(...kvRow('Bitrate range', bitRateRange));

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
}

function renderSelected() {
  const list = el('selectedList');
  list.innerHTML = '';

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
}

wire();
renderDashboard(null);
browse('').catch((e) => {
  setStatus(`Browse failed: ${e.message}`);
});
