let currentPath = '';
let lastAnalyses = [];
let lastDashboard = null;
let expanded = new Set();
let analysisByPath = new Map();

let searchTimer = null;
let searchResults = [];

const searchFilters = {
  kind: '',
  container: '',
  videoCodec: '',
  audioCodec: '',
  resolution: '',
  name: '',
  scope: 'all'
};

const el = (id) => document.getElementById(id);

function setActiveTab(tabName) {
  const allPanels = Array.from(document.querySelectorAll('.tabPanel'));
  for (const p of allPanels) {
    p.classList.toggle('active', p.dataset.tab === tabName);
  }

  const byId = {
    dashboard: 'tabDashboard',
    search: 'tabSearch',
    browser: 'tabBrowser'
  };
  for (const [name, id] of Object.entries(byId)) {
    const b = el(id);
    if (b) b.classList.toggle('active', name === tabName);
  }
}

const STORAGE_FILE_LAYOUT_KEY = 'mediaanalyzer:fileLayout';
let fileLayout = 'list'; // 'list' | 'grid'

function loadFileLayoutFromStorage() {
  try {
    const v = localStorage.getItem(STORAGE_FILE_LAYOUT_KEY);
    if (v === 'grid' || v === 'list') fileLayout = v;
  } catch {
    // ignore
  }
}

function saveFileLayoutToStorage() {
  try {
    localStorage.setItem(STORAGE_FILE_LAYOUT_KEY, fileLayout);
  } catch {
    // ignore
  }
}

function applyFileLayoutUi() {
  const list = el('fileList');
  if (list) list.classList.toggle('grid', fileLayout === 'grid');

  const btn = el('btnToggleFileLayout');
  if (btn) btn.textContent = fileLayout === 'grid' ? 'List view' : 'Grid view';
}

function encodePathForUrl(relPath) {
  const p = (relPath ?? '').replace(/^\/+/, '');
  return p.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function mediaUrl(relPath) {
  return `/media/${encodePathForUrl(relPath)}`;
}

function thumbnailUrl(relPath, width = 96) {
  const w = Number.isFinite(width) ? Math.floor(width) : 96;
  return `/api/thumbnail?path=${encodeURIComponent(relPath)}&w=${encodeURIComponent(String(w))}`;
}

function baseNameFromPath(p) {
  const parts = (p ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.ts']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.opus']);

function guessKindFromPath(p) {
  const name = baseNameFromPath(p).toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return '';
}

function requestFullscreenSafe(targetEl) {
  const fn = targetEl?.requestFullscreen
    || targetEl?.webkitRequestFullscreen
    || targetEl?.msRequestFullscreen;

  if (!fn) {
    setStatus('Fullscreen is not supported in this browser.', false);
    return;
  }
  Promise.resolve(fn.call(targetEl)).catch((e) => {
    setStatus(e?.message || 'Failed to enter fullscreen.', false);
  });
}

let aframeLoadPromise = null;
function ensureAframeLoaded() {
  if (window.AFRAME) return Promise.resolve();
  if (aframeLoadPromise) return aframeLoadPromise;

  aframeLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-aframe="1"]');
    if (existing && window.AFRAME) return resolve();

    const s = document.createElement('script');
    s.src = '/vendor/aframe-master.min.js';
    s.async = true;
    s.dataset.aframe = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load VR viewer (A-Frame).'));
    document.head.appendChild(s);
  });

  return aframeLoadPromise;
}

function createVrViewer(pathValue) {
  const root = document.createElement('div');
  root.className = 'vrViewer';

  const vid = document.createElement('video');
  const id = `vrvid_${Math.random().toString(36).slice(2)}`;
  vid.id = id;
  vid.src = mediaUrl(pathValue);
  vid.preload = 'metadata';
  vid.crossOrigin = 'anonymous';
  vid.playsInline = true;
  vid.setAttribute('webkit-playsinline', '');
  vid.style.display = 'none';

  const scene = document.createElement('a-scene');
  scene.setAttribute('embedded', '');
  scene.setAttribute('vr-mode-ui', 'enabled: true');
  scene.setAttribute('renderer', 'antialias: true; colorManagement: true');
  scene.className = 'vrScene';
  scene.style.cursor = 'pointer';
  scene.title = 'Click to fullscreen';
  scene.addEventListener('click', () => requestFullscreenSafe(root));

  const assets = document.createElement('a-assets');
  assets.appendChild(vid);

  const sphere = document.createElement('a-videosphere');
  sphere.setAttribute('src', `#${id}`);
  sphere.setAttribute('rotation', '0 -90 0');

  const cam = document.createElement('a-entity');
  cam.setAttribute('camera', '');
  cam.setAttribute('look-controls', '');
  cam.setAttribute('position', '0 0 0');

  scene.appendChild(assets);
  scene.appendChild(sphere);
  scene.appendChild(cam);

  const actions = document.createElement('div');
  actions.className = 'previewActions';

  const playBtn = document.createElement('button');
  playBtn.className = 'btn';
  playBtn.textContent = 'Play/Pause';
  playBtn.onclick = () => {
    if (vid.paused) {
      vid.play().catch(() => setStatus('Click again to start playback.', false));
    } else {
      vid.pause();
    }
  };

  actions.appendChild(playBtn);

  root.appendChild(scene);
  root.appendChild(actions);

  return { root, videoEl: vid };
}

function renderThumb(relPath, kindHint = '') {
  const kind = kindHint || guessKindFromPath(relPath);
  if (kind === 'image' || kind === 'video') {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = kind;
    img.src = thumbnailUrl(relPath, 96);
    img.onerror = () => {
      img.style.display = 'none';
    };
    return img;
  }
  const ph = document.createElement('div');
  ph.className = 'thumbPh';
  ph.textContent = kind ? kind.toUpperCase() : 'FILE';
  return ph;
}

function renderMediaPreview(analysisOrPath) {
  const pathValue = typeof analysisOrPath === 'string' ? analysisOrPath : (analysisOrPath?.path ?? '');
  if (!pathValue) return null;

  const kindHint = typeof analysisOrPath === 'string' ? '' : (analysisOrPath?.kind ?? '');
  const kind = kindHint || guessKindFromPath(pathValue);

  if (!kind) return null;

  const preview = document.createElement('div');
  preview.className = 'preview';

  const media = (() => {
    if (kind === 'video') {
      const v = document.createElement('video');
      v.className = 'previewMedia';
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      v.src = mediaUrl(pathValue);
      return v;
    }
    if (kind === 'audio') {
      const a = document.createElement('audio');
      a.className = 'previewMedia';
      a.controls = true;
      a.preload = 'metadata';
      a.src = mediaUrl(pathValue);
      return a;
    }
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'previewMedia';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = baseNameFromPath(pathValue);
      img.src = mediaUrl(pathValue);
      img.style.cursor = 'pointer';
      img.title = 'Click to fullscreen';
      img.onclick = () => requestFullscreenSafe(img);
      return img;
    }
    return null;
  })();

  if (!media) return null;
  preview.appendChild(media);

  if (kind === 'video') {
    const actions = document.createElement('div');
    actions.className = 'previewActions';

    if (kind === 'video') {
      const vrBtn = document.createElement('button');
      vrBtn.className = 'btn';
      vrBtn.textContent = 'VR';

      let vr = null;
      let vrOn = false;
      vrBtn.onclick = async () => {
        try {
          if (!vrOn) {
            setStatus('Loading VR viewer…', true);
            await ensureAframeLoaded();
            if (typeof media.pause === 'function') media.pause();
            vr = createVrViewer(pathValue);
            preview.replaceChild(vr.root, media);
            vrBtn.textContent = 'Normal';
            vrOn = true;
            setStatus('', false);
          } else {
            if (vr?.videoEl && typeof vr.videoEl.pause === 'function') vr.videoEl.pause();
            preview.replaceChild(media, vr.root);
            vrBtn.textContent = 'VR';
            vrOn = false;
          }
        } catch (e) {
          setStatus(e?.message || 'Failed to start VR viewer.', false);
        } finally {
          setBusy(false);
        }
      };

      actions.appendChild(vrBtn);
    }

    preview.appendChild(actions);
  }

  return preview;
}

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

async function loadSearchOptions() {
  const resp = await fetch('/api/search/options');
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to load search options');

  setSelectOptions(el('searchKind'), data.kind ?? []);
  setSelectOptions(el('searchContainer'), data.containerFormat ?? []);
  setSelectOptions(el('searchVideoCodec'), data.videoCodec ?? []);
  setSelectOptions(el('searchAudioCodec'), data.audioCodec ?? []);
  setSelectOptions(el('searchResolution'), data.resolution ?? []);
}

function renderAnalysisDetails(analysis, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'inlineDetails';

  const includePreview = opts?.includePreview !== false;

  if (!analysis) {
    wrap.textContent = 'No details available.';
    return wrap;
  }

  if (includePreview) {
    const preview = renderMediaPreview(analysis);
    if (preview) wrap.appendChild(preview);
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

function setBusy(isBusy) {
  const p = el('progress');
  if (!p) return;
  p.classList.toggle('hidden', !isBusy);
}

function setStatus(msg, busy = null) {
  const s = el('status');
  if (s) s.textContent = msg;
  if (busy !== null) setBusy(Boolean(busy));
}

function renderDashboard(dashboard) {
  lastDashboard = dashboard ?? null;

  const totalsEl = el('dashTotals');
  const kindEl = el('dashKind');
  const containerEl = el('dashContainer');
  const vcodecEl = el('dashVideoCodec');
  const pixfmtEl = el('dashPixelFormat');
  const frEl = el('dashFrameRate');
  const acodecEl = el('dashAudioCodec');
  const asrEl = el('dashAudioSampleRate');
  const achEl = el('dashAudioChannels');
  const resEl = el('dashResolution');

  if (!totalsEl) return;

  const dash = lastDashboard;

  const safeTotals = dash?.totals ?? {
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
  totalsEl.append(...dashKvRow('Analyzed OK', safeTotals.analyzedOkCount));
  totalsEl.append(...dashKvRow('Analyze errors', safeTotals.analyzedErrorCount));
  totalsEl.append(...dashKvRow('Total size', prettyBytes(safeTotals.totalSizeBytes) ?? '—'));
  totalsEl.append(...dashKvRow('Total duration', fmtDuration(safeTotals.totalDurationSec)));
  totalsEl.append(...dashKvRow('Duration range', durationRange));
  totalsEl.append(...dashKvRow('Bitrate range', bitRateRange));

  function renderCountList(targetEl, items, keyFormatter = (v) => fmt(v)) {
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
      key.textContent = keyFormatter(it.key);
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
  renderCountList(pixfmtEl, dash?.counts?.pixelFormat);
  renderCountList(frEl, dash?.counts?.frameRate);
  renderCountList(acodecEl, dash?.counts?.audioCodec);
  renderCountList(asrEl, dash?.counts?.audioSampleRate, (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${n} Hz` : fmt(v);
  });
  renderCountList(achEl, dash?.counts?.audioChannels, (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${n} ch` : fmt(v);
  });
  renderCountList(resEl, dash?.counts?.resolution);
}

function renderSearchTable() {
  const table = el('searchTable');
  if (!table) return;
  table.innerHTML = '';

  const items = Array.isArray(searchResults) ? searchResults : [];

  const summary = el('searchSummary');
  if (summary) {
    summary.textContent = `${items.length} file(s)`;
  }

  const header = document.createElement('div');
  header.className = 'tableRow tableHeader';
  const headers = ['Preview', 'File', 'Kind', 'Size', 'Video', 'Audio', 'Res'];
  for (const h of headers) {
    const c = document.createElement('div');
    c.className = 'cell';
    c.textContent = h;
    header.appendChild(c);
  }
  table.appendChild(header);

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.style.padding = '10px';
    empty.textContent = 'No matches.';
    table.appendChild(empty);
    return;
  }

  for (const a of items) {
    const p = a?.path;
    const row = document.createElement('div');
    row.className = 'tableRow';
    row.style.cursor = 'pointer';
    row.onclick = () => {
      if (!p) return;
      if (expanded.has(p)) expanded.delete(p);
      else expanded.add(p);
      renderSearchTable();
    };

    const kindHint = a?.kind ?? '';
    const thumbCell = document.createElement('div');
    thumbCell.className = 'cell';
    if (p) thumbCell.appendChild(renderThumb(p, kindHint));
    row.appendChild(thumbCell);

    const cells = [
      a?.name ?? a?.path,
      a?.kind,
      prettyBytes(a?.sizeBytes) ?? '—',
      a?.video?.codec ?? '—',
      a?.audio?.codec ?? '—',
      fmtResolution(a)
    ];
    for (const v of cells) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.textContent = fmt(v);
      row.appendChild(c);
    }

    table.appendChild(row);

    if (p && expanded.has(p)) {
      const detailsWrap = document.createElement('div');
      detailsWrap.style.padding = '0 10px 10px';
      detailsWrap.appendChild(renderAnalysisDetails(a?.analyzed ? a : { path: p, error: 'Not analyzed yet' }));
      table.appendChild(detailsWrap);
    }
  }
}

async function runSearch() {
  const body = {
    kind: searchFilters.kind,
    container: searchFilters.container,
    videoCodec: searchFilters.videoCodec,
    audioCodec: searchFilters.audioCodec,
    resolution: searchFilters.resolution,
    name: searchFilters.name,
    scope: searchFilters.scope,
    basePath: currentPath
  };
  const resp = await fetch('/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Search failed');
  searchResults = Array.isArray(data.results) ? data.results : [];
  // Keep cache updated so details can use DB data.
  for (const r of searchResults) {
    if (r && r.path && r.analyzed && !r.error) analysisByPath.set(r.path, r);
  }
  renderSearchTable();
}

function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    runSearch().catch((e) => {
      const summary = el('searchSummary');
      if (summary) summary.textContent = e.message;
    });
  }, 350);
}

async function analyzeAllFolders() {
  setStatus('Analyzing all media (all folders)…', true);
  try {
    const resp = await fetch('/api/analyze-all', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Analyze-all failed');
    const analyzed = typeof data.analyzed === 'number' ? data.analyzed : 0;
    const errors = typeof data.errors === 'number' ? data.errors : 0;
    setStatus(`Analyze-all complete: ${analyzed} analyzed, ${errors} errors.`, false);
    await loadDashboardFromDb();
  } catch (e) {
    setStatus(e.message, false);
    throw e;
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
  // Keep the dashboard current when analyzing on-demand.
  loadDashboardFromDb().catch(() => {
    // ignore
  });
  return result;
}

async function loadFromDb(files) {
  const resp = await fetch('/api/db/analyses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'DB load failed');
  return data;
}

async function loadDashboardFromDb() {
  const scope = 'all';
  const q = `scope=${encodeURIComponent(scope)}&basePath=${encodeURIComponent(currentPath ?? '')}`;
  const resp = await fetch(`/api/db/dashboard?${q}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'DB dashboard load failed');
  renderDashboard(data.dashboard);
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
    const p = joinPath(currentPath, f);

    if (fileLayout === 'grid') {
      li.className = 'gridItem';

      const kind = guessKindFromPath(p);
      const media = (() => {
        if (kind === 'image') {
          const img = document.createElement('img');
          img.className = 'gridMedia';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.alt = f;
          img.src = mediaUrl(p);
          img.style.cursor = 'pointer';
          img.title = 'Click to fullscreen';
          img.onclick = () => requestFullscreenSafe(img);
          return img;
        }
        if (kind === 'video') {
          const v = document.createElement('video');
          v.className = 'gridMedia';
          v.controls = true;
          v.preload = 'metadata';
          v.playsInline = true;
          v.src = mediaUrl(p);
          return v;
        }
        if (kind === 'audio') {
          const a = document.createElement('audio');
          a.className = 'gridMedia';
          a.controls = true;
          a.preload = 'metadata';
          a.src = mediaUrl(p);
          return a;
        }
        const ph = document.createElement('div');
        ph.className = 'gridPlaceholder';
        ph.textContent = kind ? kind.toUpperCase() : 'FILE';
        return ph;
      })();

      li.appendChild(media);

      const title = document.createElement('div');
      title.className = 'gridTitle';
      title.textContent = f;
      li.appendChild(title);

      const actions = document.createElement('div');
      actions.className = 'gridActions';

      const btnDetails = document.createElement('button');
      btnDetails.className = 'btn';
      btnDetails.textContent = expanded.has(p) ? 'Hide' : 'Details';
      btnDetails.onclick = async () => {
        if (expanded.has(p)) {
          expanded.delete(p);
          browse(currentPath);
          return;
            }

              setStatus('Analyzing file…');
              await analyzeOne(p);
            }
          }
          setStatus('');
        } catch (e) {
          setStatus(e.message);
        }
        browse(currentPath);
      };

      actions.appendChild(btnDetails);
      li.appendChild(actions);

      if (expanded.has(p)) {
        const analysis = analysisByPath.get(p);
        const details = renderAnalysisDetails(analysis ?? { path: p, error: 'Not analyzed yet' }, { includePreview: false });
        li.appendChild(details);
      }
      fileList.appendChild(li);
      continue;
    }

    const name = document.createElement('span');
    name.className = 'itemName';
    name.textContent = f;
    li.appendChild(name);

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
      setStatus('Loading details…');
      try {
        if (!analysisByPath.has(p)) {
          // Prefer DB if available
          try {
            const data = await loadFromDb([p]);
            const r = Array.isArray(data.results) ? data.results[0] : null;
            if (r && r.path && !r.error) {
              analysisByPath.set(r.path, r);
            }
          } catch {
            // ignore; fall back to on-demand analyze
          }

          if (!analysisByPath.has(p)) {
            setStatus('Analyzing file…');
            await analyzeOne(p);
          }
        }
        setStatus('');
      } catch (e) {
        setStatus(e.message);
      }
      browse(currentPath);
    };

    li.appendChild(btnDetails);
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
  setStatus('Loading directory…', true);
  const q = encodeURIComponent(pathRel ?? '');
  const resp = await fetch(`/api/browse?path=${q}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Browse failed');
  renderBrowse(data);
  setStatus('', false);
}

async function analyzeAllInCurrentFolder() {
  setStatus('Loading folder…', true);
  const q = encodeURIComponent(currentPath ?? '');
  const resp = await fetch(`/api/browse?path=${q}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Browse failed');
  const files = Array.isArray(data.files) ? data.files : [];
  if (files.length === 0) {
    setStatus('No files in this folder.', false);
    return;
  }
  const filePaths = files.map((f) => joinPath(currentPath, f));
  setStatus(`Analyzing ${filePaths.length} file(s)…`, true);
  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: filePaths })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Analyze failed');
    lastAnalyses = data.results ?? [];
    for (const r of lastAnalyses) {
      if (r && r.path) analysisByPath.set(r.path, r);
    }
    await loadDashboardFromDb();
    setStatus('Analyze complete.', false);
  } catch (e) {
    setStatus(e.message, false);
    throw e;
  }
}

async function compare() {
  if (!Array.isArray(lastAnalyses) || lastAnalyses.length < 2) {
    setStatus('Analyze at least 2 files first.', false);
    return;
  }

  const good = lastAnalyses.filter((a) => !a.error);
  if (good.length < 2) {
    setStatus('Need at least 2 successfully analyzed files.', false);
    return;
  }

  setStatus('Comparing…', true);

  const resp = await fetch('/api/compare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ analyses: good })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Compare failed');

  el('output').textContent = JSON.stringify(data, null, 2);
  setStatus('Compare complete.', false);
}

function wire() {
  const tabDashboard = el('tabDashboard');
  const tabSearch = el('tabSearch');
  const tabBrowser = el('tabBrowser');
  if (tabDashboard) tabDashboard.onclick = () => setActiveTab('dashboard');
  if (tabSearch) tabSearch.onclick = () => setActiveTab('search');
  if (tabBrowser) tabBrowser.onclick = () => setActiveTab('browser');

  const btnRefresh = el('btnRefresh');
  if (btnRefresh) btnRefresh.onclick = () => browse(currentPath);

  const btnUp = el('btnUp');
  if (btnUp) btnUp.onclick = () => browse(parentPath(currentPath));
  const btnCompare = el('btnCompare');
  if (btnCompare) btnCompare.onclick = () => compare().catch((e) => setStatus(e.message));

  const btnAnalyzeAll = el('btnAnalyzeAll');
  if (btnAnalyzeAll) {
    btnAnalyzeAll.onclick = () => analyzeAllInCurrentFolder().catch((e) => setStatus(e.message));
  }

  const btnAnalyzeAllGlobal = el('btnAnalyzeAllGlobal');
  if (btnAnalyzeAllGlobal) {
    btnAnalyzeAllGlobal.onclick = () => analyzeAllFolders().catch((e) => setStatus(e.message));
  }

  const btnToggleLayout = el('btnToggleFileLayout');
  if (btnToggleLayout) {
    btnToggleLayout.onclick = () => {
      fileLayout = fileLayout === 'grid' ? 'list' : 'grid';
      saveFileLayoutToStorage();
      applyFileLayoutUi();
      browse(currentPath).catch((e) => setStatus(e.message, false));
    };
  }

  const bindSearch = (id, key) => {
    const node = el(id);
    if (!node) return;
    const on = () => {
      searchFilters[key] = node.value ?? '';
      scheduleSearch();
    };
    node.addEventListener('input', on);
    node.addEventListener('change', on);
  };

  bindSearch('searchKind', 'kind');
  bindSearch('searchContainer', 'container');
  bindSearch('searchVideoCodec', 'videoCodec');
  bindSearch('searchAudioCodec', 'audioCodec');
  bindSearch('searchResolution', 'resolution');
  bindSearch('searchName', 'name');

  const scopeNode = el('searchScope');
  if (scopeNode) {
    scopeNode.value = 'all';
    scopeNode.addEventListener('change', () => {
      searchFilters.scope = scopeNode.value ?? 'all';
      scheduleSearch();
    });
  }

  const clear = el('btnClearSearch');
  if (clear) {
    clear.onclick = () => {
      searchFilters.kind = '';
      searchFilters.container = '';
      searchFilters.videoCodec = '';
      searchFilters.audioCodec = '';
      searchFilters.resolution = '';
      searchFilters.name = '';
      searchFilters.scope = 'all';

      const ids = ['searchKind', 'searchContainer', 'searchVideoCodec', 'searchAudioCodec', 'searchResolution', 'searchName', 'searchScope'];
      for (const id of ids) {
        const n = el(id);
        if (n) n.value = '';
      }

      const s = el('searchScope');
      if (s) s.value = 'all';
      scheduleSearch();
    };
  }
}

function init() {
  try {
    wire();
    setActiveTab('dashboard');
    loadFileLayoutFromStorage();
    applyFileLayoutUi();

    renderDashboard(null);
    loadDashboardFromDb().catch(() => {
      // ignore
    });

    browse('').catch((e) => {
      setStatus(`Browse failed: ${e.message}`, false);
    });

    loadSearchOptions()
      .then(() => {
        const summary = el('searchSummary');
        if (summary) summary.textContent = 'Set a filter to search';
        renderSearchTable();
      })
      .catch(() => {
        // Search panel is optional if DB is disabled/unreachable.
      });
  } catch (e) {
    setStatus(`Startup failed: ${e?.message ?? e}`, false);
  }
}

init();
