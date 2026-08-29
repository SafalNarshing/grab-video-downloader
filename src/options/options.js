/* Grab — options page. */

import { api, DEFAULT_API, getApiBase, normaliseBase, setApiBase } from '../lib/api.js';

const $ = (id) => document.getElementById(id);

const apiInput = $('api');
const statusEl = $('status');
const factsEl = $('facts');

function setStatus(text, tone) {
  statusEl.textContent = text;
  statusEl.hidden = !text;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

async function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-light').setAttribute('aria-pressed', String(theme === 'light'));
  $('theme-dark').setAttribute('aria-pressed', String(theme === 'dark'));
}

/** Asks the server what it is, and shows what it says. */
async function test(base) {
  setStatus('Checking…');
  factsEl.hidden = true;
  try {
    const h = await api.health(base);
    $('f-version').textContent = `${h.app} ${h.version}`;
    $('f-ytdlp').textContent = h.yt_dlp || '—';
    $('f-ffmpeg').textContent = h.ffmpeg ? 'found on PATH' : 'missing — no merged MP4 or MP3';
    $('f-dir').textContent = h.download_dir || '—';
    $('f-cookies').textContent = h.cookies ? `from ${h.cookies}` : 'not configured';
    factsEl.hidden = false;
    setStatus(
      h.ffmpeg ? 'Connected.' : 'Connected, but ffmpeg is missing — install it for MP4 merging and MP3.',
      h.ffmpeg ? 'ok' : 'error'
    );
  } catch (e) {
    setStatus(String(e?.message || e), 'error');
  }
}

$('save').addEventListener('click', async () => {
  const base = await setApiBase(apiInput.value);
  apiInput.value = base;
  await test(base);
});

$('test').addEventListener('click', () => test(normaliseBase(apiInput.value)));

$('reset').addEventListener('click', async () => {
  apiInput.value = await setApiBase(DEFAULT_API);
  await test(DEFAULT_API);
});

apiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('save').click();
});

for (const theme of ['light', 'dark']) {
  $(`theme-${theme}`).addEventListener('click', async () => {
    await chrome.storage.local.set({ theme });
    applyTheme(theme);
  });
}

(async () => {
  const { theme } = await chrome.storage.local.get('theme');
  applyTheme(theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  const base = await getApiBase();
  apiInput.value = base;
  await test(base);
})();
