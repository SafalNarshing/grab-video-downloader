/* Grab — popup controller. */

const $ = (id) => document.getElementById(id);

const emptyEl = $('empty');
const heroEl = $('hero');
const thumbImg = $('thumb-img');
const thumbBlank = $('thumb-blank');
const chipTime = $('chip-time');
const chipLive = $('chip-live');
const titleEl = $('title');
const subEl = $('sub');
const noteEl = $('note');
const qualityWrap = $('quality-wrap');
const qualityEl = $('quality');
const linkForm = $('link-form');
const linkInput = $('link-input');
const btn = $('download');
const btnLabel = $('download-label');
const fillEl = $('fill');

let tabId = null;
let playing = null;
let qualities = [];
let job = null;
let posterTried = false;

/* ----------------------------------------------------------------- theme */

async function initTheme() {
  const { theme } = await chrome.storage.local.get('theme');
  document.documentElement.dataset.theme =
    theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  chrome.storage.local.set({ theme: next });
});

/* ------------------------------------------------------------ formatting */

function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return mm >= 60 ? `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/* ------------------------------------------------------------- rendering */

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

function setPoster(url) {
  if (!url) {
    thumbImg.hidden = true;
    thumbBlank.hidden = false;
    return;
  }
  thumbImg.onload = () => {
    thumbImg.hidden = false;
    thumbBlank.hidden = true;
  };
  thumbImg.onerror = () => {
    thumbImg.hidden = true;
    thumbBlank.hidden = false;
  };
  thumbImg.src = url;
}

/**
 * Cross-origin video taints the canvas, so this only works on a minority of
 * sites. It runs once, and only when the page offered no poster of its own.
 */
async function tryFrameGrab() {
  if (posterTried || !playing || playing.poster) return;
  posterTried = true;
  const res = await send({ type: 'grabFrame' });
  if (res?.ok && res.dataUrl) setPoster(res.dataUrl);
}

function render() {
  const has = !!playing && (playing.hasVideo || qualities.length > 0);
  emptyEl.hidden = has;
  heroEl.hidden = !has;

  if (!has) {
    qualityWrap.hidden = true;
    setButton('Nothing to download', { disabled: true, percent: 0 });
    return;
  }

  titleEl.textContent = playing.title || 'Untitled video';
  // Duration already sits on the thumbnail chip, so the subtitle carries the
  // resolution the player is actually running at.
  subEl.textContent = [playing.site, playing.height ? `${playing.height}p` : '', playing.live ? 'live' : '']
    .filter(Boolean)
    .join('  ·  ');

  setPoster(playing.poster);
  if (!playing.poster) tryFrameGrab();

  chipLive.hidden = !playing.live;
  chipTime.hidden = playing.live || !playing.duration;
  chipTime.textContent = formatDuration(playing.duration);

  qualityEl.replaceChildren();
  for (const q of qualities) {
    const opt = document.createElement('option');
    opt.value = q.key;
    opt.textContent = q.detail ? `${q.label} — ${q.detail}` : q.label;
    qualityEl.append(opt);
  }
  qualityWrap.hidden = qualities.length === 0;

  if (!qualities.length) {
    setButton('No source yet', { disabled: true, percent: 0 });
    setNote(
      playing.live
        ? 'Live streams expose no finished file. Let it play, then rescan.'
        : 'Found the video but not its source yet. Let it play for a moment, then rescan.'
    );
    return;
  }

  setButton('Download', { disabled: false, percent: 0 });
  noteForChoice();
}

function currentChoice() {
  return qualities.find((q) => q.key === qualityEl.value) || qualities[0];
}

function noteForChoice() {
  const q = currentChoice();
  if (!q) return setNote('');
  if (q.stream) return setNote('Rebuilt segment by segment. Separate audio saves as a second file.');
  if (/no audio/.test(q.detail || '')) return setNote('This resolution carries no audio — it saves as video only.');
  setNote('');
}

qualityEl.addEventListener('change', noteForChoice);

/* -------------------------------------------------------------- messaging */

function send(msg) {
  return chrome.runtime.sendMessage({ tabId, ...msg }).catch((e) => ({ error: String(e?.message || e) }));
}

async function refresh() {
  const res = await send({ type: 'state' });
  if (res?.error) {
    setNote(res.error, 'error');
    return;
  }
  playing = res?.playing || null;
  qualities = res?.qualities || [];
  render();
}

/* --------------------------------------------------------------- actions */

btn.addEventListener('click', async () => {
  if (job) {
    await send({ type: 'cancel', jobId: job });
    return;
  }
  const q = currentChoice();
  if (!q) return;

  setButton('Starting…', { disabled: true, percent: 0, busy: true });
  const res = await send({ type: 'download', itemId: q.itemId, variant: q.variant, name: playing?.title || '' });

  if (res?.error) {
    job = null;
    setButton('Download', { disabled: false, percent: 0 });
    setNote(res.error, 'error');
    return;
  }

  job = res.jobId;
  setButton(res.streaming ? 'Preparing…' : 'Downloading…', { busy: true, percent: 0 });
});

linkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = linkInput.value.trim();
  if (!url) return;

  linkForm.classList.add('busy');
  setNote('Checking that link…');
  const res = await send({ type: 'link', url });
  linkForm.classList.remove('busy');

  if (res?.error) {
    setNote(res.error, 'error');
    return;
  }

  if (res.opened) {
    // A watch page only gives up its video once a real tab loads and plays it,
    // so the link is opened in the background and we read what that tab shows.
    tabId = res.tabId;
    await refresh();
    setNote(
      res.found
        ? 'Opened that page in a new tab and picked up its video.'
        : 'Opened it in a new tab, but nothing has played yet. Press play there, then rescan.',
      res.found ? undefined : 'error'
    );
    return;
  }

  linkInput.value = '';
  await refresh();
  setNote('Added that link as a source.');
});

$('rescan').addEventListener('click', async (e) => {
  const el = e.currentTarget;
  el.classList.remove('spinning');
  void el.offsetWidth; // restart the animation
  el.classList.add('spinning');

  posterTried = false;
  // The content script is missing on tabs that were open before install.
  await chrome.tabs.sendMessage(tabId, { type: 'rescan' }).catch(() =>
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content.js'] }).catch(() => {})
  );
  setTimeout(refresh, 500);
});

/* --------------------------------------------------------------- progress */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'progress' || msg.jobId !== job) return;

  switch (msg.phase) {
    case 'preparing':
      setButton('Preparing…', { busy: true, percent: 0 });
      break;
    case 'downloading':
      setButton(msg.percent != null ? `Downloading  ${msg.percent}%` : 'Downloading…', {
        busy: true,
        percent: msg.percent ?? null,
      });
      if (msg.detail) setNote(msg.detail);
      break;
    case 'done':
      job = null;
      setButton('Saved', { percent: 100 });
      setNote(msg.split ? 'Saved as separate video and audio files.' : 'Saved to your downloads.');
      setTimeout(() => setButton('Download', { percent: 0 }), 2200);
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
