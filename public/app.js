let currentPath = '';
let selected = new Set();
let lastAnalyses = [];

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

function setStatus(msg) {
  el('status').textContent = msg;
}

function renderSelected() {
  const list = el('selectedList');
  list.innerHTML = '';

  const items = Array.from(selected.values()).sort((a, b) => a.localeCompare(b));
  for (const p of items) {
    const li = document.createElement('li');
    li.textContent = p;

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Remove';
    btn.onclick = () => {
      selected.delete(p);
      renderSelected();
    };

    li.appendChild(btn);
    list.appendChild(li);
  }
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
    li.textContent = d;

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Open';
    btn.onclick = () => browse(joinPath(currentPath, d));

    li.appendChild(btn);
    dirList.appendChild(li);
  }

  for (const f of data.files ?? []) {
    const li = document.createElement('li');
    li.textContent = f;

    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = selected.has(joinPath(currentPath, f)) ? 'Selected' : 'Select';
    btn.onclick = () => {
      const p = joinPath(currentPath, f);
      if (selected.has(p)) selected.delete(p);
      else selected.add(p);
      renderSelected();
      browse(currentPath); // refresh button labels
    };

    li.appendChild(btn);
    fileList.appendChild(li);
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
browse('').catch((e) => {
  setStatus(`Browse failed: ${e.message}`);
});
