/**
 * Grab — background service worker.
 *
 * Watches network responses for media, keeps a per-tab index of what it found,
 * and drives downloads. Stream assembly (HLS/DASH) happens in an offscreen
 * document because service workers have no URL.createObjectURL.
 */

const MAX_PER_TAB = 80;
const MIN_FILE_BYTES = 64 * 1024; // ignore sprite/ad-sized blips

const EXT_RE = /\.(m3u8|mpd|mp4|webm|m4v|mov|mkv|flv|avi|mpg|mpeg|3gp|mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/i;
const SEGMENT_RE = /\.(ts|m4s|cmfv|cmfa|vtt)(?:[?#]|$)/i;
const MEDIA_CT_RE = /^(?:video|audio)\/|mpegurl|dash\+xml/i;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)/i;

/** @type {Map<number, Map<string, object>>} tabId -> key -> media item */
const index = new Map();

/* ------------------------------------------------------------------ utils */

function headerOf(headers, name) {
  if (!headers) return '';
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value || '' : '';
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
 * collapse onto one row, so the query string is dropped from the key. YouTube
 * reuses a single path for every stream, so its itag has to come back in.
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

function nameFrom(url, fallback) {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '').trim();
    if (stem.length > 2 && !/^[0-9a-f-]{16,}$/i.test(stem)) return stem;
  } catch {
    /* fall through to the caller's fallback */
  }
  return (fallback || 'video').trim();
}

function sanitize(name) {
  const cleaned = (name || 'video')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'video';
}

function extFor(item) {
  if (item.kind === 'hls' || item.kind === 'dash') return 'mp4';
  const path = item.url.split(/[?#]/)[0];
  const m = path.match(/\.([a-z0-9]{2,5})$/i);
  if (m && !/^(m3u8|mpd)$/i.test(m[1])) return m[1].toLowerCase();
  if (/webm/i.test(item.mime || '')) return 'webm';
  if (item.kind === 'audio') return 'm4a';
  return 'mp4';
}

function bucketFor(tabId) {
  let b = index.get(tabId);
  if (!b) index.set(tabId, (b = new Map()));
  return b;
}

function refreshBadge(tabId) {
  const n = index.get(tabId)?.size || 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3d6dff' }).catch(() => {});
}

function record(tabId, item) {
  const bucket = bucketFor(tabId);
  const key = keyFor(item.url);
  const prev = bucket.get(key);
  if (prev) {
    // Keep the freshest URL (signed links expire) without losing what we knew.
    bucket.set(key, { ...prev, ...item, id: prev.id, found: prev.found });
  } else {
    if (bucket.size >= MAX_PER_TAB) return;
    bucket.set(key, { ...item, id: key, found: Date.now() });
  }
  refreshBadge(tabId);
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
    // Playlists are tiny by nature; everything else that small is a sprite or a
    // stream chunk that slipped past the extension check.
    if (kind !== 'hls' && kind !== 'dash' && len && len < MIN_FILE_BYTES) return;

    record(d.tabId, {
      url: d.url,
      kind,
      mime: ct,
      size: len,
      source: 'network',
      origin: hostOf(d.url),
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// A top-level navigation means the old list belongs to a page that is gone.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || d.frameId !== 0) return;
    index.delete(d.tabId);
    refreshBadge(d.tabId);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.tabs.onRemoved.addListener((tabId) => index.delete(tabId));

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

/* -------------------------------------------------------------- downloads */

const jobs = new Map(); // jobId -> { tabId, name, downloadId }
let jobSeq = 0;
let pollTimer = null;

function emit(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // the popup may be closed
}

/**
 * downloads.onChanged reports state transitions but not byte progress, so the
 * percentage has to be polled while a direct download is in flight.
 */
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
      const [item] = await chrome.downloads.search({ id: job.downloadId });
      if (!item || item.state !== 'in_progress') continue;
      const percent = item.totalBytes > 0 ? Math.round((item.bytesReceived / item.totalBytes) * 100) : null;
      emit({ type: 'progress', jobId, phase: 'downloading', percent });
    }
  }, 500);
}

async function startDownload({ item, variant, tabId }) {
  const jobId = 'job' + ++jobSeq;
  const base = sanitize(item.name || nameFrom(item.url, item.origin));

  if (item.kind === 'hls' || item.kind === 'dash') {
    jobs.set(jobId, { tabId, name: base });
    await ensureOffscreen();
    chrome.runtime
      .sendMessage({
        target: 'offscreen',
        type: 'assemble',
        jobId,
        kind: item.kind,
        url: item.url,
        variant: variant || null,
        name: base,
      })
      .catch((e) => emit({ type: 'progress', jobId, phase: 'error', error: String(e) }));
    return { jobId, streaming: true };
  }

  const filename = base + '.' + extFor(item);
  try {
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename,
      conflictAction: 'uniquify',
    });
    jobs.set(jobId, { tabId, name: base, downloadId });
    emit({ type: 'progress', jobId, phase: 'downloading', percent: 0 });
    pollDirectDownloads();
    return { jobId };
  } catch (e) {
    // Some CDNs reject a browser-initiated download but accept a fetch from the
    // page itself (cookies and referrer intact). Try that before giving up.
    if (tabId != null) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'pageDownload', url: item.url, filename });
        if (res?.ok) {
          emit({ type: 'progress', jobId, phase: 'done' });
          return { jobId, viaPage: true };
        }
      } catch {
        /* content script unavailable — report the original failure */
      }
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

/* --------------------------------------------------------------- messages */

const handlers = {
  async pageMedia(msg, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return {};
    for (const m of msg.items || []) {
      record(tabId, {
        url: m.url,
        kind: classify(m.url, m.mime),
        mime: m.mime || '',
        size: 0,
        width: m.width,
        height: m.height,
        duration: m.duration,
        title: m.title,
        source: 'page',
        origin: hostOf(m.url),
      });
    }
    return {};
  },

  async list(msg) {
    const bucket = index.get(msg.tabId);
    const items = bucket ? [...bucket.values()] : [];
    items.sort(
      (a, b) =>
        (a.kind === 'audio' ? 1 : 0) - (b.kind === 'audio' ? 1 : 0) ||
        (b.size || 0) - (a.size || 0) ||
        a.found - b.found
    );
    return { items: items.map((it) => ({ ...it, name: it.title || nameFrom(it.url, it.origin) })) };
  },

  async clear(msg) {
    index.delete(msg.tabId);
    refreshBadge(msg.tabId);
    return {};
  },

  async variants(msg) {
    await ensureOffscreen();
    return chrome.runtime.sendMessage({ target: 'offscreen', type: 'variants', kind: msg.kind, url: msg.url });
  },

  download: (msg) => startDownload(msg),

  async cancel(msg) {
    const job = jobs.get(msg.jobId);
    if (job?.downloadId != null) {
      await chrome.downloads.cancel(job.downloadId).catch(() => {});
      jobs.delete(msg.jobId);
      emit({ type: 'progress', jobId: msg.jobId, phase: 'cancelled' });
    }
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', jobId: msg.jobId }).catch(() => {});
    return {};
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
