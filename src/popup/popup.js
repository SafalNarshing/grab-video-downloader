/* Grab — popup controller. */

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const emptyEl = $('empty');
const countEl = $('count');
const noteEl = $('note');
const qualityWrap = $('quality-wrap');
const qualityEl = $('quality');
const btn = $('download');
const btnLabel = $('download-label');
const fillEl = $('fill');

let tabId = null;
let items = [];
let selected = null;
let job = null;

/* ----------------------------------------------------------------- theme */

async function initTheme() {
  const { theme } = await chrome.storage.local.get('theme');
  const initial = theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = initial;
}

$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  chrome.storage.local.set({ theme: next });
});

/* ------------------------------------------------------------ formatting */

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const s = Math.round(seconds);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return mm >= 60 ? `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function badgeFor(item) {
  if (item.kind === 'hls') return 'HLS';
  if (item.kind === 'dash') return 'DASH';
  if (item.kind === 'audio') return 'AUDIO';
  const m = (item.url || '').split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  if (m) return m[1].toUpperCase();
  return (item.mime || '').split('/')[1]?.toUpperCase() || 'VIDEO';
}

function metaFor(item) {
  return [
    item.height ? `${item.height}p` : '',
    formatDuration(item.duration),
    formatSize(item.size),
    item.origin,
  ]
    .filter(Boolean)
    .join('  ·  ');
}

/* ------------------------------------------------------------- rendering */

function render() {
  for (const el of listEl.querySelectorAll('.item')) el.remove();

  countEl.hidden = items.length === 0;
  countEl.textContent = String(items.length);
  emptyEl.hidden = items.length > 0;

  for (const item of items) {
    const el = document.createElement('button');
    el.className = 'item';
    el.type = 'button';
    el.dataset.id = item.id;
    el.dataset.kind = item.kind;
    el.setAttribute('aria-selected', String(item.id === selected?.id));

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = badgeFor(item);

    const body = document.createElement('span');
    body.className = 'body';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = metaFor(item);

    body.append(name, meta);
    el.append(badge, body);
    el.addEventListener('click', () => select(item));
    listEl.append(el);
  }
}

function setNote(text, tone) {
  noteEl.textContent = text || '';
  noteEl.hidden = !text;
  if (tone) noteEl.dataset.tone = tone;
  else delete noteEl.dataset.tone;
}

function setButton(label, { disabled = false, percent = null, busy = false } = {}) {
  btnLabel.textContent = label;
  btn.disabled = disabled;
  btn.classList.toggle('busy', busy);
  btn.title = busy ? 'Click to cancel' : '';
  if (percent != null) fillEl.style.width = `${percent}%`;
}

/* ------------------------------------------------------------- selection */

async function select(item) {
  selected = item;
  render();

  const streaming = item.kind === 'hls' || item.kind === 'dash';
  qualityWrap.hidden = true;
  qualityEl.replaceChildren();

  setButton('Download', { disabled: false, percent: 0 });
  setNote(
    streaming ? 'Stream is rebuilt segment by segment. Separate audio saves as a second file.' : ''
  );

  if (!streaming) return;

  setNote('Reading stream manifest…');
  const res = await send({ type: 'variants', kind: item.kind, url: item.url });

  if (selected !== item) return; // user moved on while we were fetching
  if (res?.error) {
    setNote(res.error, 'error');
    return;
  }

  const variants = res?.variants || [];
  if (variants.length > 1) {
    for (const v of variants) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = v.label;
      qualityEl.append(opt);
    }
    qualityWrap.hidden = false;
  }
  setNote('Stream is rebuilt segment by segment. Separate audio saves as a second file.');
}

/* -------------------------------------------------------------- messages */

function send(msg) {
  return chrome.runtime.sendMessage({ tabId, ...msg }).catch((e) => ({ error: String(e?.message || e) }));
}

btn.addEventListener('click', async () => {
  if (!selected) return;

  if (job) {
    await send({ type: 'cancel', jobId: job });
    return;
  }

  setButton('Starting…', { disabled: true, percent: 0, busy: true });
  const res = await send({
    type: 'download',
    item: selected,
    variant: qualityWrap.hidden ? null : qualityEl.value,
    tabId,
  });

  if (res?.error) {
    job = null;
    setButton('Download', { disabled: false });
    setNote(res.error, 'error');
    return;
  }

  job = res.jobId;
  setButton(res.streaming ? 'Preparing…' : 'Downloading…', { busy: true, percent: 0 });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'progress' || msg.jobId !== job) return;

  switch (msg.phase) {
    case 'preparing':
      setButton('Preparing…', { busy: true, percent: 0 });
      break;
    case 'downloading':
      setButton(msg.percent != null ? `Downloading  ${msg.percent}%` : 'Downloading…', {
        busy: true,
        percent: msg.percent ?? 0,
      });
      if (msg.detail) setNote(msg.detail);
      break;
    case 'done':
      job = null;
      setButton('Saved', { percent: 100 });
      setNote(msg.split ? 'Saved as separate video and audio files.' : 'Saved to your downloads.');
      setTimeout(() => selected && setButton('Download', { percent: 0 }), 2200);
      break;
    case 'cancelled':
      job = null;
      setButton('Download', { percent: 0 });
      setNote('Cancelled.');
      break;
    case 'error':
      job = null;
      setButton('Download', { percent: 0 });
      setNote(msg.error || 'Download failed.', 'error');
      break;
  }
});

/* ----------------------------------------------------------------- setup */

async function refresh() {
  const res = await send({ type: 'list' });
  items = res?.items || [];
  if (selected) selected = items.find((i) => i.id === selected.id) || null;
  if (!selected) setButton('Select a file', { disabled: true, percent: 0 });
  render();
}

$('rescan').addEventListener('click', async (e) => {
  const el = e.currentTarget;
  el.classList.remove('spinning');
  void el.offsetWidth; // restart the animation
  el.classList.add('spinning');

  // The content script may not be injected on pages loaded before install.
  await chrome.tabs.sendMessage(tabId, { type: 'rescan' }).catch(async () => {
    await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, files: ['src/content.js'] })
      .catch(() => {});
  });
  setTimeout(refresh, 400);
});

(async () => {
  await initTheme();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  if (tabId == null) {
    setNote('No active tab.', 'error');
    return;
  }
  await refresh();
})();
