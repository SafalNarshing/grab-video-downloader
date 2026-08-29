/* Grab — popup controller. */

import { api, getApiBase, setApiBase } from '../lib/api.js';

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
const apibar = $('apibar');
const apiInput = $('api-input');
const serverDot = $('server-dot');
const btn = $('download');
const btnLabel = $('download-label');
const fillEl = $('fill');

let tabId = null;
let tabUrl = '';
let targetUrl = ''; // what we are actually downloading — the tab, or a pasted link
let server = { ok: false, base: '' };
let hero = null;
let options = [];
let source = 'local'; // 'server' when the options came from yt-dlp
let job = null;
let lastRemoteId = null;
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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
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

function setServerDot() {
  serverDot.dataset.state = server.ok ? 'ok' : 'down';
  $('api-toggle').title = server.ok
    ? `Server: ${server.base}`
    : `Server unreachable at ${server.base}`;
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
 * sites. It runs once, and only when nothing else offered a poster.
 */
async function tryFrameGrab() {
  if (posterTried || hero?.poster) return;
  posterTried = true;
  const res = await bg({ type: 'grabFrame' });
  if (res?.ok && res.dataUrl) setPoster(res.dataUrl);
}

function render() {
  const has = !!hero;
  emptyEl.hidden = has;
  heroEl.hidden = !has;

  if (!has) {
    qualityWrap.hidden = true;
    setButton('Nothing to download', { disabled: true, percent: 0 });
    return;
  }

  titleEl.textContent = hero.title || 'Untitled video';
  subEl.textContent = [hero.site, hero.height ? `${hero.height}p` : '', hero.live ? 'live' : '']
    .filter(Boolean)
    .join('  ·  ');

  setPoster(hero.poster);
  if (!hero.poster) tryFrameGrab();

  chipLive.hidden = !hero.live;
  chipTime.hidden = !!hero.live || !hero.duration;
  chipTime.textContent = formatDuration(hero.duration);

  qualityEl.replaceChildren();
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.key;
    opt.textContent = o.detail ? `${o.label} — ${o.detail}` : o.label;
    opt.disabled = !!o.disabled;
    qualityEl.append(opt);
  }
  qualityWrap.hidden = options.length === 0;

  if (!options.length) {
    setButton('No source yet', { disabled: true, percent: 0 });
    return;
  }

  setButton('Download', { disabled: false, percent: 0 });
  noteForChoice();
}

function currentChoice() {
  return options.find((o) => o.key === qualityEl.value) || options[0];
}

function noteForChoice() {
  const o = currentChoice();
  if (!o) return setNote('');
  if (source === 'server') {
    if (o.disabled) return setNote('Needs ffmpeg on the server’s PATH.', 'error');
    return setNote('');
  }
  if (o.stream) return setNote('Rebuilt in the browser. Separate audio saves as a second file.');
  if (/no audio/.test(o.detail || '')) return setNote('This resolution carries no audio — video only.');
  setNote('');
}

qualityEl.addEventListener('change', noteForChoice);

/* -------------------------------------------------------------- messaging */

function bg(msg) {
  return chrome.runtime.sendMessage({ tabId, ...msg }).catch((e) => ({ error: String(e?.message || e) }));
}

/** Server path: ask yt-dlp what the URL offers. */
async function loadFromServer(url) {
  setButton('Reading…', { disabled: true, percent: 0 });
  setNote('Asking the server what this offers…');

  const info = await api.info(url, server.base);
  source = 'server';
  targetUrl = info.webpage_url || url;
  hero = {
    title: info.title,
    poster: info.thumbnail,
    site: hostOf(info.webpage_url || url) || info.extractor,
    duration: info.duration,
    live: info.is_live,
    height: 0,
  };
  options = info.options || [];
  setNote('');
}

/** Fallback path: whatever the browser could see by itself. */
function loadFromPage(state) {
  source = 'local';
  const playing = state.playing;
  hero = playing?.hasVideo || state.qualities?.length
    ? {
        title: playing?.title || '',
        poster: playing?.poster || '',
        site: playing?.site || hostOf(tabUrl),
        duration: playing?.duration || 0,
        live: playing?.live || false,
        height: playing?.height || 0,
      }
    : null;
  options = state.qualities || [];
}

async function refresh() {
  const state = await bg({ type: 'state' });
  if (state?.error) {
    setNote(state.error, 'error');
    return;
  }

  server = state.server || { ok: false, base: '' };
  setServerDot();

  if (state.job && !job) {
    // A download started before this popup opened — re-attach to it.
    job = state.job.jobId;
    setButton('Downloading…', { busy: true });
  }

  const url = state.pendingUrl || targetUrl || tabUrl;

  if (server.ok && url && /^https?:/i.test(url)) {
    try {
      await loadFromServer(url);
      render();
      if (!server.ffmpeg) setNote('Server has no ffmpeg — merged MP4 and MP3 are unavailable.', 'error');
      return;
    } catch (e) {
      // The server is up but could not read this URL. Local detection may still
      // have something, so fall through rather than dead-ending.
      loadFromPage(state);
      render();
      setNote(String(e?.message || e), 'error');
      return;
    }
  }

  loadFromPage(state);
  render();
  if (!server.ok) {
    setNote(`No server at ${server.base} — using in-browser detection. Click the server icon to change it.`);
  }
}

/* --------------------------------------------------------------- actions */

btn.addEventListener('click', async () => {
  if (job) {
    await bg({ type: 'cancel', jobId: job });
    return;
  }
  const o = currentChoice();
  if (!o) return;

  setButton('Starting…', { disabled: true, percent: 0, busy: true });
  const res =
    source === 'server'
      ? await bg({ type: 'serverDownload', url: targetUrl, option: o, title: hero?.title || '' })
      : await bg({ type: 'download', itemId: o.itemId, variant: o.variant, name: hero?.title || '' });

  if (res?.error) {
    job = null;
    setButton('Download', { disabled: false, percent: 0 });
    setNote(res.error, 'error');
    return;
  }

  job = res.jobId;
  setButton('Preparing…', { busy: true, percent: 0 });
});

linkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = linkInput.value.trim();
  if (!url) return;

  linkForm.classList.add('busy');
  try {
    if (server.ok) {
      // With the server up this is the whole feature: hand it the link.
      await loadFromServer(url);
      render();
      linkInput.value = '';
      return;
    }

    // Without it, fall back to adopting a direct media link or opening the page.
    setNote('Checking that link…');
    const res = await bg({ type: 'link', url });
    if (res?.error) return setNote(res.error, 'error');

    if (res.opened) {
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
  } catch (err) {
    setNote(String(err?.message || err), 'error');
    setButton('Download', { disabled: options.length === 0 });
  } finally {
    linkForm.classList.remove('busy');
  }
});

$('rescan').addEventListener('click', async (e) => {
  const el = e.currentTarget;
  el.classList.remove('spinning');
  void el.offsetWidth; // restart the animation
  el.classList.add('spinning');

  posterTried = false;
  await chrome.tabs.sendMessage(tabId, { type: 'rescan' }).catch(() =>
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content.js'] }).catch(() => {})
  );
  setTimeout(refresh, 400);
});

/* ------------------------------------------------------------- server bar */

$('api-toggle').addEventListener('click', () => {
  const open = apibar.hidden;
  apibar.hidden = !open;
  $('api-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    apiInput.focus();
    apiInput.select();
  }
});

$('api-save').addEventListener('click', async () => {
  const base = await setApiBase(apiInput.value);
  apiInput.value = base;
  apibar.hidden = true;
  $('api-toggle').setAttribute('aria-expanded', 'false');
  targetUrl = '';
  await refresh();
});

apiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('api-save').click();
  if (e.key === 'Escape') apibar.hidden = true;
});

$('api-more').addEventListener('click', () => chrome.runtime.openOptionsPage());

/* --------------------------------------------------------------- progress */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'progress' || msg.jobId !== job) return;

  switch (msg.phase) {
    case 'preparing':
      setButton('Preparing…', { busy: true, percent: 0 });
      setNote('Reading the source…');
      break;
    case 'downloading':
      setButton(msg.percent ? `Downloading  ${Math.round(msg.percent)}%` : 'Downloading…', {
        busy: true,
        percent: msg.percent ?? null,
      });
      setNote(msg.detail || '');
      break;
    case 'processing':
      setButton('Merging…', { busy: true });
      setNote('ffmpeg is joining video and audio.');
      break;
    case 'done':
      job = null;
      lastRemoteId = msg.remoteId || null;
      setButton('Saved', { percent: 100 });
      setNote(
        msg.split
          ? 'Saved as separate video and audio files.'
          : lastRemoteId
            ? 'Saved. Click here to open the folder.'
            : 'Saved to your downloads.'
      );
      noteEl.classList.toggle('clickable', !!lastRemoteId);
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

noteEl.addEventListener('click', () => {
  if (lastRemoteId) bg({ type: 'reveal', remoteId: lastRemoteId });
});

/* ----------------------------------------------------------------- setup */

(async () => {
  await initTheme();
  apiInput.value = await getApiBase();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  tabUrl = tab?.url || '';
  if (tabId == null) {
    setNote('No active tab.', 'error');
    return;
  }
  await refresh();
})();
