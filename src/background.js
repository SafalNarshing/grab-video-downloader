/**
 * Grab — background service worker.
 *
 * Two download paths meet here.
 *
 * The local yt-dlp server is the good one: it knows every site, picks real
 * formats, and muxes with ffmpeg. When it is running, downloads are its jobs
 * and this worker just watches them and hands the finished file to Chrome.
 *
 * When it is not running, the worker falls back to what the browser alone can
 * see — a per-tab index of media sniffed off the wire plus whatever the content
 * script reports — and assembles streams in an offscreen document, because
 * service workers have no URL.createObjectURL.
 */

import { api, getApiBase } from './lib/api.js';

const MAX_PER_TAB = 60;
const MIN_FILE_BYTES = 64 * 1024; // ignore sprite/ad-sized blips
const PROBE_TIMEOUT_MS = 12_000;

const EXT_RE = /\.(m3u8|mpd|mp4|webm|m4v|mov|mkv|flv|avi|mpg|mpeg|3gp|mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/i;
const SEGMENT_RE = /\.(ts|m4s|cmfv|cmfa|vtt)(?:[?#]|$)/i;
const MEDIA_CT_RE = /^(?:video|audio)\/|mpegurl|dash\+xml/i;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/i;

/**
 * YouTube labels its streams with an itag rather than anything readable. Only
 * the common ones are listed; anything else falls back to size and mime.
 */
const ITAG = {
  17: [144, 'mp4', true], 18: [360, 'mp4', true], 22: [720, 'mp4', true],
  37: [1080, 'mp4', true], 43: [360, 'webm', true], 59: [480, 'mp4', true],
  133: [240, 'mp4', false], 134: [360, 'mp4', false], 135: [480, 'mp4', false],
  136: [720, 'mp4', false], 137: [1080, 'mp4', false], 160: [144, 'mp4', false],
  264: [1440, 'mp4', false], 266: [2160, 'mp4', false],
  298: [720, 'mp4', false], 299: [1080, 'mp4', false],
  242: [240, 'webm', false], 243: [360, 'webm', false], 244: [480, 'webm', false],
  247: [720, 'webm', false], 248: [1080, 'webm', false], 271: [1440, 'webm', false],
  302: [720, 'webm', false], 303: [1080, 'webm', false], 313: [2160, 'webm', false],
  315: [2160, 'webm', false],
  139: [0, 'm4a', true], 140: [0, 'm4a', true], 141: [0, 'm4a', true],
  171: [0, 'webm', true], 249: [0, 'webm', true], 250: [0, 'webm', true], 251: [0, 'webm', true],
};

/** @type {Map<number, {media: Map<string, object>, state: object, meta: object, probes: Map<string, object>}>} */
const tabs = new Map();

/* ------------------------------------------------------------------ utils */

function headerOf(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h?.value || '';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function classify(url, contentType) {
  const ct = contentType || '';
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.m3u8') || /mpegurl/i.test(ct)) return 'hls';
  if (path.endsWith('.mpd') || /dash\+xml/i.test(ct)) return 'dash';
  if (/^audio\//i.test(ct) || AUDIO_EXT_RE.test(path)) return 'audio';
  return 'file';
}

/**
 * The same asset requested twice (fresh CDN token, another byte range) should
 * collapse onto one entry, so the query string is dropped. YouTube reuses a
 * single path for every stream, so its itag has to come back in.
 */
function keyFor(url) {
  try {
    const u = new URL(url);
    const itag = u.searchParams.get('itag');
    return u.origin + u.pathname + (itag ? '#' + itag : '');
  } catch {
    return url;
  }
}

function itagOf(url) {
  try {
    return parseInt(new URL(url).searchParams.get('itag') || '', 10) || 0;
  } catch {
    return 0;
  }
}

function sanitize(name) {
  const cleaned = (name || 'video')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'video';
}

function nameFrom(url, fallback) {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '').trim();
    if (stem.length > 2 && !/^[0-9a-f-]{16,}$/i.test(stem)) return stem;
  } catch {
    /* fall through */
  }
  return (fallback || 'video').trim();
}

function extFor(item) {
  if (item.kind === 'hls' || item.kind === 'dash') return 'mp4';
  const itag = ITAG[itagOf(item.url)];
  if (itag) return item.kind === 'audio' || !itag[0] ? (itag[1] === 'webm' ? 'webm' : 'm4a') : itag[1];
  const m = item.url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  if (m && !/^(m3u8|mpd)$/i.test(m[1])) return m[1].toLowerCase();
  if (/webm/i.test(item.mime || '')) return 'webm';
  return item.kind === 'audio' ? 'm4a' : 'mp4';
}

function tabFor(tabId) {
  let t = tabs.get(tabId);
  if (!t) tabs.set(tabId, (t = { media: new Map(), state: null, meta: null, probes: new Map() }));
  return t;
}

function refreshBadge(tabId) {
  const t = tabs.get(tabId);
  const on = !!t?.state?.hasVideo || (t?.media.size || 0) > 0;
  chrome.action.setBadgeText({ tabId, text: on ? '●' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3d6dff' }).catch(() => {});
}

function record(tabId, item) {
  const bucket = tabFor(tabId).media;
  const key = keyFor(item.url);
  const prev = bucket.get(key);
  if (prev) {
    // Keep the freshest URL (signed links expire) without losing what we knew.
    bucket.set(key, { ...prev, ...item, id: prev.id, found: prev.found });
  } else {
    if (bucket.size >= MAX_PER_TAB) return;
    bucket.set(key, { ...item, id: key, found: Date.now() });
  }
}

/* --------------------------------------------------------------- sniffing */

chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    if (d.tabId < 0 || !/^https?:/i.test(d.url)) return;

    const ct = headerOf(d.responseHeaders, 'content-type').split(';')[0].trim();
    const len = parseInt(headerOf(d.responseHeaders, 'content-length'), 10) || 0;

    if (!MEDIA_CT_RE.test(ct) && !EXT_RE.test(d.url)) return;
    if (/^video\/mp2t$/i.test(ct)) return; // a stream chunk, not an asset
    if (SEGMENT_RE.test(d.url) && !/mpegurl/i.test(ct)) return;

    const kind = classify(d.url, ct);
    // Playlists are tiny by nature; anything else that small is not the video.
    if (kind !== 'hls' && kind !== 'dash' && len && len < MIN_FILE_BYTES) return;

    // A ranged response reports only the slice size; the full length is in
    // content-range, and YouTube also puts it in the clen parameter.
    let size = len;
    const range = headerOf(d.responseHeaders, 'content-range').match(/\/(\d+)\s*$/);
    if (range) size = parseInt(range[1], 10) || size;

    record(d.tabId, { url: d.url, kind, mime: ct, size, origin: hostOf(d.url), source: 'network' });
    refreshBadge(d.tabId);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// A top-level navigation means everything we knew belongs to a page that is gone.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || d.frameId !== 0) return;
    tabs.delete(d.tabId);
    refreshBadge(d.tabId);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

/* -------------------------------------------------------------- offscreen */

let offscreenPending = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!offscreenPending) {
    offscreenPending = chrome.offscreen
      .createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Assemble stream segments into a downloadable file.',
      })
      .finally(() => {
        offscreenPending = null;
      });
  }
  await offscreenPending;
}

function askOffscreen(msg) {
  return ensureOffscreen().then(() => chrome.runtime.sendMessage({ target: 'offscreen', ...msg }));
}

/* --------------------------------------------------------------- qualities */

function labelForItem(item) {
  const itag = ITAG[itagOf(item.url)];
  if (itag && itag[0]) return `${itag[0]}p`;
  if (item.height) return `${item.height}p`;
  if (item.kind === 'audio' || (itag && !itag[0])) return 'Audio only';
  return (item.mime || '').split('/')[1]?.toUpperCase() || 'Original';
}

function heightForItem(item) {
  return ITAG[itagOf(item.url)]?.[0] || item.height || 0;
}

/** True when the source carries picture but no sound, so it needs muxing. */
function videoOnly(item) {
  const itag = ITAG[itagOf(item.url)];
  return !!itag && itag[0] > 0 && itag[2] === false;
}

/**
 * Folds every known source for a tab into one ranked list of choices. Stream
 * manifests are expanded into their renditions; probes are cached per tab
 * because each one costs a manifest fetch.
 */
async function qualitiesFor(tabId) {
  const t = tabs.get(tabId);
  if (!t) return [];

  const options = [];

  for (const item of t.media.values()) {
    if (item.kind === 'hls' || item.kind === 'dash') {
      let probe = t.probes.get(item.id);
      if (!probe) {
        try {
          probe = await askOffscreen({ type: 'variants', kind: item.kind, url: item.url });
        } catch (e) {
          probe = { error: String(e?.message || e) };
        }
        t.probes.set(item.id, probe);
      }
      if (probe?.error) continue;

      const variants = probe.variants || [];
      if (!variants.length) {
        options.push({
          key: item.id,
          itemId: item.id,
          variant: null,
          label: item.kind.toUpperCase() + ' stream',
          detail: 'assembled in browser',
          height: 0,
          stream: true,
        });
        continue;
      }
      for (const v of variants) {
        options.push({
          key: item.id + '|' + v.id,
          itemId: item.id,
          variant: v.id,
          label: v.height ? `${v.height}p` : v.label,
          detail: v.height ? v.label.replace(/^\d+p\s*·\s*/, '') : 'stream',
          height: v.height || 0,
          stream: true,
        });
      }
      continue;
    }

    options.push({
      key: item.id,
      itemId: item.id,
      variant: null,
      label: labelForItem(item),
      detail: [
        item.size ? formatSize(item.size) : '',
        videoOnly(item) ? 'no audio' : '',
      ].filter(Boolean).join(' · '),
      height: heightForItem(item),
      audioOnly: item.kind === 'audio' || labelForItem(item) === 'Audio only',
      stream: false,
    });
  }

  // Best picture first; audio-only choices sink to the bottom.
  options.sort(
    (a, b) => (a.audioOnly ? 1 : 0) - (b.audioOnly ? 1 : 0) || b.height - a.height || a.label.localeCompare(b.label)
  );

  // One entry per resolution — the first is already the best of its group.
  const seen = new Set();
  return options.filter((o) => {
    const k = o.label + (o.audioOnly ? 'a' : '') + (o.stream ? 's' : '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/* -------------------------------------------------------------- downloads */

const jobs = new Map(); // jobId -> { tabId, name, downloadId }
let jobSeq = 0;
let pollTimer = null;

function emit(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // the popup may be closed
}

/** downloads.onChanged carries state, not bytes, so progress has to be polled. */
function pollDirectDownloads() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const live = [...jobs.entries()].filter(([, j]) => j.downloadId != null);
    if (!live.length) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    for (const [jobId, job] of live) {
      const [d] = await chrome.downloads.search({ id: job.downloadId });
      if (!d || d.state !== 'in_progress') continue;
      emit({
        type: 'progress',
        jobId,
        phase: 'downloading',
        percent: d.totalBytes > 0 ? Math.round((d.bytesReceived / d.totalBytes) * 100) : null,
      });
    }
  }, 500);
}

async function startDownload({ tabId, itemId, variant, name }) {
  const t = tabs.get(tabId);
  const item = t?.media.get(itemId);
  if (!item) throw new Error('That source is gone — reopen the panel to rescan.');

  const jobId = 'job' + ++jobSeq;
  const base = sanitize(name || t?.state?.title || nameFrom(item.url, item.origin));

  if (item.kind === 'hls' || item.kind === 'dash') {
    jobs.set(jobId, { tabId, name: base });
    askOffscreen({ type: 'assemble', jobId, kind: item.kind, url: item.url, variant, name: base }).catch((e) =>
      emit({ type: 'progress', jobId, phase: 'error', error: String(e?.message || e) })
    );
    return { jobId, streaming: true };
  }

  const filename = base + '.' + extFor(item);
  try {
    const downloadId = await chrome.downloads.download({ url: item.url, filename, conflictAction: 'uniquify' });
    jobs.set(jobId, { tabId, name: base, downloadId });
    emit({ type: 'progress', jobId, phase: 'downloading', percent: 0 });
    pollDirectDownloads();
    return { jobId };
  } catch (e) {
    // Some CDNs reject a browser-initiated download but accept a fetch from the
    // page itself, cookies and referrer intact. Try that before giving up.
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'pageDownload', url: item.url, filename });
      if (res?.ok) {
        emit({ type: 'progress', jobId, phase: 'done' });
        return { jobId, viaPage: true };
      }
    } catch {
      /* content script unavailable — report the original failure */
    }
    throw e;
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  for (const [jobId, job] of jobs) {
    if (job.downloadId !== delta.id) continue;
    const state = delta.state?.current;
    if (state === 'complete') {
      emit({ type: 'progress', jobId, phase: 'done' });
      jobs.delete(jobId);
    } else if (state === 'interrupted') {
      emit({ type: 'progress', jobId, phase: 'error', error: delta.error?.current || 'interrupted' });
      jobs.delete(jobId);
    }
  }
});

/* ------------------------------------------------------------ pasted links */

/**
 * Works out whether a pasted URL is media we can fetch directly or a page that
 * has to be opened and watched. There is no page scraping here: a watch page
 * only yields its video once a real browser tab loads and plays it.
 */
async function resolveLink(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That does not look like a URL.');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http and https links work here.');

  if (EXT_RE.test(url)) return { type: 'media', kind: classify(url, ''), url };

  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (MEDIA_CT_RE.test(ct)) return { type: 'media', kind: classify(url, ct), url, mime: ct };
  } catch {
    /* HEAD is frequently blocked; fall through to treating it as a page */
  }
  return { type: 'page', url };
}

/** Opens a page in a background tab and waits for it to reveal its media. */
async function openAndDetect(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  const deadline = Date.now() + PROBE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const t = tabs.get(tab.id);
    if (t && (t.media.size > 0 || t.state?.hasVideo)) return { tabId: tab.id, found: true };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { tabId: tab.id, found: false };
}

/* ------------------------------------------------------------ server jobs */

const POLL_MS = 800;
const watching = new Map(); // jobId -> interval id

/**
 * Server jobs outlive the popup and can outlive this worker, so the little we
 * need to resume one is kept in session storage.
 */
async function rememberJob(jobId, rec) {
  const { serverJobs = {} } = await chrome.storage.session.get('serverJobs');
  serverJobs[jobId] = rec;
  await chrome.storage.session.set({ serverJobs });
}

async function forgetJob(jobId) {
  const { serverJobs = {} } = await chrome.storage.session.get('serverJobs');
  delete serverJobs[jobId];
  await chrome.storage.session.set({ serverJobs });
}

async function activeJobFor(tabId) {
  const { serverJobs = {} } = await chrome.storage.session.get('serverJobs');
  const entries = Object.entries(serverJobs);
  // The detached window has no tab of its own, so it adopts whatever is running.
  const hit = tabId == null ? entries[0] : entries.find(([, r]) => r.tabId === tabId) || entries[0];
  return hit ? { jobId: hit[0], ...hit[1] } : null;
}

function stopWatching(jobId) {
  clearInterval(watching.get(jobId));
  watching.delete(jobId);
}

/**
 * Polls one server job to completion. The repeated fetch also keeps this
 * worker from being shut down mid-download.
 */
function watchJob(jobId, rec) {
  if (watching.has(jobId)) return;

  const tick = async () => {
    let p;
    try {
      p = await api.progress(rec.remoteId, rec.base);
    } catch (e) {
      stopWatching(jobId);
      await forgetJob(jobId);
      emit({ type: 'progress', jobId, phase: 'error', error: String(e?.message || e) });
      return;
    }

    if (p.status === 'error' || p.status === 'cancelled') {
      stopWatching(jobId);
      await forgetJob(jobId);
      setBusyBadge(rec.tabId, false);
      emit({
        type: 'progress',
        jobId,
        phase: p.status === 'cancelled' ? 'cancelled' : 'error',
        error: p.error || 'Download failed.',
      });
      return;
    }

    if (p.status === 'done') {
      stopWatching(jobId);
      setBusyBadge(rec.tabId, false);
      try {
        await chrome.downloads.download({
          url: api.fileUrl(rec.remoteId, rec.base),
          filename: p.filename || sanitize(p.title || rec.title) + '.mp4',
          conflictAction: 'uniquify',
        });
        emit({ type: 'progress', jobId, phase: 'done', filename: p.filename, remoteId: rec.remoteId });
      } catch (e) {
        emit({ type: 'progress', jobId, phase: 'error', error: `Saved on the server, but Chrome refused it: ${e?.message || e}` });
      }
      await forgetJob(jobId);
      return;
    }

    emit({
      type: 'progress',
      jobId,
      phase: p.status === 'processing' ? 'processing' : p.status === 'preparing' ? 'preparing' : 'downloading',
      percent: p.percent,
      detail: [p.speed, p.eta && p.eta !== '00:00' ? `ETA ${p.eta}` : ''].filter(Boolean).join(' · '),
    });
  };

  watching.set(jobId, setInterval(tick, POLL_MS));
  tick();
}

function setBusyBadge(tabId, on) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text: on ? '↓' : '' }).catch(() => {});
}

async function startServerDownload({ tabId, url, option, title }) {
  const base = await getApiBase();
  const jobId = 'job' + ++jobSeq;

  emit({ type: 'progress', jobId, phase: 'preparing' });
  const res = await api.download(
    {
      url,
      type: option?.type || 'mp4',
      height: option?.height || 0,
      format_id: option?.format_id || null,
      title: title || '',
    },
    base
  );

  const rec = { remoteId: res.job_id, base, tabId: tabId ?? null, title: title || '', url };
  await rememberJob(jobId, rec);
  setBusyBadge(tabId, true);
  watchJob(jobId, rec);
  // remoteId goes back so the UI can poll the server itself and stay accurate
  // even when this worker is asleep.
  return { jobId, server: true, remoteId: res.job_id, base };
}

/** Re-attach to anything still running after the worker was restarted. */
async function resumeJobs() {
  const { serverJobs = {} } = await chrome.storage.session.get('serverJobs');
  for (const [jobId, rec] of Object.entries(serverJobs)) watchJob(jobId, rec);
}
resumeJobs();

/* ----------------------------------------------------------- context menu */

const MENU_CONTEXTS = ['page', 'video', 'audio', 'link', 'selection'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'grab', title: 'Download with Grab…', contexts: MENU_CONTEXTS });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  // A right-click on a video or link targets that; anywhere else means the page.
  const url = info.srcUrl || info.linkUrl || info.selectionText?.trim() || info.pageUrl;
  if (url) openDownloader(url);
});

/* ------------------------------------------------------- downloader window */

const WINDOW_SIZE = { width: 404, height: 660 };

/**
 * The toolbar popup is closed by the browser the moment it loses focus, which
 * is no good for watching a download. This is a real window instead: it stays
 * put until the user closes it.
 */
async function openDownloader(url) {
  const target = chrome.runtime.getURL(
    `src/popup/popup.html?surface=window${url ? `&url=${encodeURIComponent(url)}` : ''}`
  );
  const { downloaderWindowId } = await chrome.storage.session.get('downloaderWindowId');

  if (downloaderWindowId != null) {
    try {
      // Reuse the window that is already open rather than stacking up more.
      const win = await chrome.windows.get(downloaderWindowId, { populate: true });
      const tab = win.tabs?.[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { url: target });
        await chrome.windows.update(downloaderWindowId, { focused: true, drawAttention: true });
        return downloaderWindowId;
      }
    } catch {
      /* it was closed since we last looked */
    }
  }

  const win = await chrome.windows.create({ url: target, type: 'popup', focused: true, ...WINDOW_SIZE });
  await chrome.storage.session.set({ downloaderWindowId: win.id });
  return win.id;
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { downloaderWindowId } = await chrome.storage.session.get('downloaderWindowId');
  if (downloaderWindowId === windowId) await chrome.storage.session.remove('downloaderWindowId');
});

/* --------------------------------------------------------------- messages */

const handlers = {
  /** The content script describing what its frame is playing. */
  async pageState(msg, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    const t = tabFor(tabId);

    for (const m of msg.items || []) {
      record(tabId, {
        url: m.url,
        kind: classify(m.url, m.mime),
        mime: m.mime || '',
        size: 0,
        height: m.height,
        duration: m.duration,
        origin: hostOf(m.url),
        source: 'page',
      });
    }

    // The top frame owns the page's title and poster; the winning frame owns
    // the playback facts. An embedded player splits those across two reports.
    if (sender.frameId === 0) t.meta = msg.state;

    // The frame that owns the video keeps updating itself; another frame takes
    // over only by scoring higher. Frame 0 must not win on score alone — with
    // an embedded player it holds the page but not the video.
    const sameFrame = t.state?.frameId === sender.frameId;
    if (!t.state || sameFrame || msg.state.score >= t.state.score) {
      t.state = { ...msg.state, frameId: sender.frameId };
    }
    refreshBadge(tabId);
    return {};
  },

  async state(msg) {
    const t = tabs.get(msg.tabId);
    const state = t?.state || null;
    const meta = t?.meta || null;

    const playing = state
      ? {
          ...state,
          title: meta?.title || state.title || '',
          poster: meta?.poster || state.poster || '',
          site: meta?.site || state.site || '',
          pageUrl: meta?.pageUrl || state.pageUrl || '',
        }
      : null;

    // The server is the preferred path, so report whether it answered. Local
    // sniffing is only worth computing when it is the fallback in play.
    const base = await getApiBase();
    let server = { ok: false, base };
    try {
      const h = await api.health(base);
      server = { ok: true, base, ffmpeg: !!h.ffmpeg, version: h.version, dir: h.download_dir };
    } catch (e) {
      server = { ok: false, base, error: String(e?.message || e) };
    }

    const { pendingUrl } = await chrome.storage.session.get('pendingUrl');
    if (pendingUrl) await chrome.storage.session.remove('pendingUrl');

    return {
      playing,
      server,
      pendingUrl: pendingUrl || null,
      job: await activeJobFor(msg.tabId),
      qualities: server.ok ? [] : await qualitiesFor(msg.tabId),
    };
  },

  /** Popup asked the server to fetch something; the job outlives the popup. */
  serverDownload: (msg) =>
    startServerDownload({ tabId: msg.tabId, url: msg.url, option: msg.option, title: msg.title }),

  /** Detach into a window that the browser will not close behind you. */
  async openWindow(msg) {
    const id = await openDownloader(msg.url || '');
    return { windowId: id };
  },

  async reveal(msg) {
    const base = await getApiBase();
    return api.reveal(msg.remoteId, base);
  },

  async grabFrame(msg) {
    const frameId = tabs.get(msg.tabId)?.state?.frameId ?? 0;
    return chrome.tabs
      .sendMessage(msg.tabId, { type: 'grabFrame' }, { frameId })
      .catch(() => ({ ok: false }));
  },

  async clear(msg) {
    tabs.delete(msg.tabId);
    refreshBadge(msg.tabId);
    return {};
  },

  download: (msg) => startDownload(msg),

  async cancel(msg) {
    const { serverJobs = {} } = await chrome.storage.session.get('serverJobs');
    const rec = serverJobs[msg.jobId];
    if (rec) {
      stopWatching(msg.jobId);
      await forgetJob(msg.jobId);
      setBusyBadge(rec.tabId, false);
      await api.cancel(rec.remoteId, rec.base).catch(() => {});
      emit({ type: 'progress', jobId: msg.jobId, phase: 'cancelled' });
      return {};
    }

    const job = jobs.get(msg.jobId);
    if (job?.downloadId != null) {
      await chrome.downloads.cancel(job.downloadId).catch(() => {});
      jobs.delete(msg.jobId);
      emit({ type: 'progress', jobId: msg.jobId, phase: 'cancelled' });
    }
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', jobId: msg.jobId }).catch(() => {});
    return {};
  },

  /** Paste-a-link: either adopt the media directly or open the page and watch. */
  async link(msg) {
    const resolved = await resolveLink(msg.url.trim());

    if (resolved.type === 'page') {
      const { tabId, found } = await openAndDetect(resolved.url);
      return { opened: true, tabId, found };
    }

    // Park it on the current tab so it flows through the normal download path.
    const tabId = msg.tabId;
    record(tabId, {
      url: resolved.url,
      kind: resolved.kind,
      mime: resolved.mime || '',
      size: 0,
      origin: hostOf(resolved.url),
      source: 'link',
    });
    const t = tabFor(tabId);
    if (!t.state?.hasVideo) {
      t.state = {
        ...(t.state || {}),
        hasVideo: true,
        fromLink: true,
        title: nameFrom(resolved.url, hostOf(resolved.url)),
        site: hostOf(resolved.url),
        poster: '',
        duration: 0,
      };
    }
    refreshBadge(tabId);
    return { adopted: true, qualities: await qualitiesFor(tabId) };
  },

  /** Offscreen finished building a blob; hand it to the downloads API. */
  async assembled(msg) {
    const job = jobs.get(msg.jobId) || {};
    const filename = sanitize(msg.name || job.name) + '.' + (msg.ext || 'mp4');
    const downloadId = await chrome.downloads.download({ url: msg.blobUrl, filename, conflictAction: 'uniquify' });
    jobs.set(msg.jobId, { ...job, downloadId });
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return; // addressed elsewhere
  const handler = handlers[msg?.type];
  if (!handler) return;

  Promise.resolve(handler(msg, sender)).then(sendResponse, (e) =>
    sendResponse({ error: String(e?.message || e) })
  );
  return true; // async response
});
