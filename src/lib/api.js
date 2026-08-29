/**
 * Grab — client for the local yt-dlp server.
 *
 * Shared by the service worker, the popup, and the options page. Every call
 * fails with a plain Error whose message is safe to show a person.
 */

export const DEFAULT_API = 'http://127.0.0.1:8787';

/** Extraction can genuinely take half a minute on a slow site. */
const TIMEOUTS = { health: 4_000, info: 60_000, download: 15_000, progress: 8_000 };

/** Accepts "127.0.0.1:8787", "localhost", or a full URL; returns a clean origin. */
export function normaliseBase(value) {
  const raw = (value || '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_API;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    return u.origin;
  } catch {
    return DEFAULT_API;
  }
}

export async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get('apiBase');
  return normaliseBase(apiBase || DEFAULT_API);
}

export async function setApiBase(value) {
  const base = normaliseBase(value);
  await chrome.storage.local.set({ apiBase: base });
  return base;
}

async function call(path, { method = 'GET', body, timeout = 15_000, base } = {}) {
  const root = base || (await getApiBase());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(root + path, {
      method,
      signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // A refused connection and an abort are the same thing to the user: the
    // server is not answering at that address.
    throw new Error(
      e?.name === 'AbortError'
        ? 'The server took too long to answer.'
        : `Cannot reach the server at ${root}. Is it running?`
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body means something other than our server answered */
  }

  if (!res.ok) {
    const detail = data?.detail;
    throw new Error(typeof detail === 'string' ? detail : `Server error ${res.status}.`);
  }
  return data;
}

export const api = {
  health: (base) => call('/health', { timeout: TIMEOUTS.health, base }),
  info: (url, base) => call('/info', { method: 'POST', body: { url }, timeout: TIMEOUTS.info, base }),
  download: (payload, base) =>
    call('/download', { method: 'POST', body: payload, timeout: TIMEOUTS.download, base }),
  progress: (jobId, base) => call(`/progress/${jobId}`, { timeout: TIMEOUTS.progress, base }),
  cancel: (jobId, base) => call(`/cancel/${jobId}`, { method: 'POST', timeout: TIMEOUTS.progress, base }),
  reveal: (jobId, base) => call(`/reveal/${jobId}`, { method: 'POST', timeout: TIMEOUTS.progress, base }),
  fileUrl: (jobId, base) => `${base}/file/${jobId}`,
};
