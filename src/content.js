/**
 * Grab — content script.
 *
 * Reports what the page is actually playing (one video, not a list of every
 * media URL that flew past) plus any media sources visible in the DOM. Also
 * acts as a fallback downloader for CDNs that only answer requests made from
 * the page's own origin.
 */

const seen = new Set();

/* ---------------------------------------------------------------- page meta */

function meta(...selectors) {
  for (const sel of selectors) {
    const c = document.querySelector(sel)?.content?.trim();
    if (c) return c;
  }
  return '';
}

function absolute(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return '';
  }
}

function pageTitle() {
  const og = meta('meta[property="og:title"]', 'meta[name="twitter:title"]');
  if (og) return og.slice(0, 160);

  // Site chrome in <title> ("… - YouTube", "… on Vimeo") is noise in a filename.
  const raw = (document.title || '').trim();
  return raw.replace(/\s*[|–—-]\s*[^|–—-]{2,24}$/, '').slice(0, 160);
}

function pagePoster(video) {
  const og = meta(
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]'
  );
  if (og) return absolute(og);
  if (video?.poster) return absolute(video.poster);
  const link = document.querySelector('link[rel="image_src"]')?.href;
  return link ? absolute(link) : '';
}

function siteName() {
  return meta('meta[property="og:site_name"]') || location.hostname.replace(/^www\./, '');
}

/* ------------------------------------------------------- the playing video */

/**
 * Picks the video the user is most likely watching: big, on screen, and
 * playing beats small, scrolled away, and untouched.
 */
function primaryVideo() {
  let best = null;
  let bestScore = 0;

  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < 4000) continue; // inline thumbnails and hidden warm-up players

    const onScreen = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    let score = area;
    if (!v.paused && !v.ended) score *= 8;
    if (v.currentTime > 0) score *= 2;
    if (!onScreen) score *= 0.1;

    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best ? { video: best, score: bestScore } : null;
}

function describe() {
  const found = primaryVideo();
  const v = found?.video;

  return {
    score: found?.score || 0,
    title: pageTitle(),
    poster: pagePoster(v),
    site: siteName(),
    pageUrl: location.href,
    duration: v && Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
    position: v ? Math.round(v.currentTime) : 0,
    width: v?.videoWidth || 0,
    height: v?.videoHeight || 0,
    playing: !!v && !v.paused && !v.ended,
    live: !!v && v.duration === Infinity,
    hasVideo: !!v,
  };
}

/* -------------------------------------------------------- media in the DOM */

function domSources() {
  const items = [];

  const push = (url, extra) => {
    const abs = absolute(url);
    // blob: and MediaSource handles are page-local, not fetchable assets.
    if (!abs || !/^https?:/i.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    items.push({ url: abs, ...extra });
  };

  for (const v of document.querySelectorAll('video')) {
    const extra = {
      width: v.videoWidth || 0,
      height: v.videoHeight || 0,
      duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
    };
    if (v.currentSrc) push(v.currentSrc, extra);
    if (v.src) push(v.src, extra);
    for (const s of v.querySelectorAll('source')) push(s.src, { ...extra, mime: s.type || '' });
  }

  for (const a of document.querySelectorAll('audio[src], audio source[src]')) push(a.src, {});

  const ogVideo = meta('meta[property="og:video:secure_url"]', 'meta[property="og:video"]', 'meta[name="twitter:player:stream"]');
  if (ogVideo) push(ogVideo, {});

  return items;
}

function report() {
  chrome.runtime
    .sendMessage({ type: 'pageState', state: describe(), items: domSources() })
    .catch(() => {}); // the worker may be asleep between navigations
}

/* Players mount lazily and SPAs swap videos in place, so keep looking cheaply. */
let queued = false;
function scheduleReport() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    report();
  }, 500);
}

report();
new MutationObserver(scheduleReport).observe(document.documentElement, { childList: true, subtree: true });
for (const evt of ['play', 'pause', 'loadedmetadata', 'durationchange', 'seeked']) {
  document.addEventListener(evt, scheduleReport, true);
}

/* ------------------------------------------------------------------ inbound */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'rescan') {
    seen.clear();
    report();
    sendResponse({ ok: true });
    return;
  }

  /**
   * Last resort for a poster: pull a frame straight off the video. Cross-origin
   * media taints the canvas, so this throws more often than it succeeds.
   */
  if (msg?.type === 'grabFrame') {
    try {
      const v = primaryVideo()?.video;
      if (!v || !v.videoWidth) throw new Error('no frame available');
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(640, v.videoWidth);
      canvas.height = Math.round((canvas.width / v.videoWidth) * v.videoHeight);
      canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
      sendResponse({ ok: true, dataUrl: canvas.toDataURL('image/jpeg', 0.7) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return;
  }

  if (msg?.type === 'pageDownload') {
    (async () => {
      const res = await fetch(msg.url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = msg.filename || 'video.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    })().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true; // async response
  }
});
