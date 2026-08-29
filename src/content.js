/**
 * Grab — content script.
 *
 * Two jobs: report the <video> elements the page has actually mounted (the
 * network sniffer misses anything served before the extension woke up), and
 * act as a fallback downloader for CDNs that only answer requests made from
 * the page's own origin.
 */

const seen = new Set();

function pageTitle() {
  const og = document.querySelector('meta[property="og:title"]')?.content;
  return (og || document.title || '').trim().slice(0, 120);
}

function absolute(url) {
  try {
    return new URL(url, location.href).href;
  } catch {
    return '';
  }
}

function collect() {
  const items = [];

  const push = (url, extra) => {
    const abs = absolute(url);
    // blob: and MediaSource URLs are page-local handles, not fetchable assets.
    if (!abs || !/^https?:/i.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    items.push({ url: abs, title: pageTitle(), ...extra });
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

  for (const sel of ['meta[property="og:video"]', 'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]']) {
    const c = document.querySelector(sel)?.content;
    if (c) push(c, {});
  }

  if (items.length) chrome.runtime.sendMessage({ type: 'pageMedia', items }).catch(() => {});
}

/* Pages mount players lazily, so keep looking — but cheaply. */
let queued = false;
function scheduleCollect() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    collect();
  }, 600);
}

collect();
new MutationObserver(scheduleCollect).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('play', scheduleCollect, true);
document.addEventListener('loadedmetadata', scheduleCollect, true);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'rescan') {
    seen.clear();
    collect();
    sendResponse({ ok: true });
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
