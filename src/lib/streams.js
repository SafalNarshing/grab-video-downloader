/**
 * Grab — stream assembly.
 *
 * Parses HLS playlists and DASH manifests, fetches the segments, and
 * concatenates them into one file. Needs a DOM (DOMParser, Blob, object URLs),
 * so it runs in Chrome's offscreen document and directly in Firefox's
 * background page, which is a real document. It knows nothing about messaging:
 * callers pass onProgress and onAssembled.
 *
 * Scope note: only plain (unencrypted) streams are handled. Anything carrying
 * an EXT-X-KEY or a ContentProtection block is reported back as unsupported.
 */

const CONCURRENCY = 6;
const cancelled = new Set();

/* ------------------------------------------------------------------ utils */

const resolve = (url, base) => new URL(url, base).href;

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching manifest`);
  return res.text();
}

function attrs(line) {
  // Parses `KEY=VALUE,KEY="VALUE"` attribute lists used throughout HLS tags.
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

const labelFor = (v) =>
  (v.height ? `${v.height}p` : v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : 'stream') +
  (v.bandwidth && v.height ? ` · ${Math.round(v.bandwidth / 1000)} kbps` : '');

/* -------------------------------------------------------------------- HLS */

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audio = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(line);
      const uri = (lines[++i] || '').trim();
      if (!uri || uri.startsWith('#')) continue;
      const res = (a.RESOLUTION || '').split('x');
      variants.push({
        url: resolve(uri, base),
        bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10),
        width: parseInt(res[0] || '0', 10),
        height: parseInt(res[1] || '0', 10),
        audioGroup: a.AUDIO || '',
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line);
      if (a.TYPE === 'AUDIO' && a.URI) {
        audio.push({ url: resolve(a.URI, base), group: a['GROUP-ID'] || '', name: a.NAME || 'audio', def: a.DEFAULT === 'YES' });
      }
    }
  }

  variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
  return { variants, audio };
}

function parseMediaPlaylist(text, base) {
  const segments = [];
  let init = null;
  let encrypted = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY:')) {
      if (!/METHOD=NONE/.test(line)) encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line.slice('#EXT-X-MAP:'.length));
      if (a.URI) init = resolve(a.URI, base);
    } else if (!line.startsWith('#')) {
      segments.push(resolve(line, base));
    }
  }
  return { segments, init, encrypted };
}

async function hlsPlan(url, variantUrl) {
  const text = await fetchText(url);
  const isMaster = text.includes('#EXT-X-STREAM-INF');

  if (!isMaster) {
    const media = parseMediaPlaylist(text, url);
    return { ...media, tracks: [{ ...media, kind: 'video' }] };
  }

  const { variants, audio } = parseMaster(text, url);
  if (!variants.length) throw new Error('No playable variant in this playlist');

  const chosen = variants.find((v) => v.url === variantUrl) || variants[0];
  const video = parseMediaPlaylist(await fetchText(chosen.url), chosen.url);

  const tracks = [{ ...video, kind: 'video' }];

  // A variant that names an AUDIO group carries no audio of its own, so the
  // matching rendition has to be fetched as a second file.
  if (chosen.audioGroup) {
    const rendition = audio.find((a) => a.group === chosen.audioGroup && a.def) || audio.find((a) => a.group === chosen.audioGroup);
    if (rendition) {
      const parsed = parseMediaPlaylist(await fetchText(rendition.url), rendition.url);
      tracks.push({ ...parsed, kind: 'audio' });
    }
  }

  return { tracks, encrypted: tracks.some((t) => t.encrypted) };
}

/* ------------------------------------------------------------------- DASH */

function dashRepresentations(mpdText, base) {
  const doc = new DOMParser().parseFromString(mpdText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Malformed DASH manifest');
  if (doc.querySelector('ContentProtection')) throw new Error('This stream is DRM-protected');

  const mpd = doc.documentElement;
  const mpdBase = mpd.querySelector(':scope > BaseURL')?.textContent?.trim();
  const root = mpdBase ? resolve(mpdBase, base) : base;
  const totalSeconds = parseDuration(mpd.getAttribute('mediaPresentationDuration'));

  const out = [];
  for (const set of doc.querySelectorAll('AdaptationSet')) {
    const setBase = set.querySelector(':scope > BaseURL')?.textContent?.trim();
    const setRoot = setBase ? resolve(setBase, root) : root;
    const setMime = set.getAttribute('mimeType') || set.getAttribute('contentType') || '';

    for (const rep of set.querySelectorAll('Representation')) {
      const mime = rep.getAttribute('mimeType') || setMime;
      const kind = /audio/i.test(mime) || /audio/i.test(set.getAttribute('contentType') || '') ? 'audio' : 'video';
      const repBase = rep.querySelector(':scope > BaseURL')?.textContent?.trim();
      out.push({
        kind,
        mime,
        id: rep.getAttribute('id') || '',
        bandwidth: parseInt(rep.getAttribute('bandwidth') || '0', 10),
        width: parseInt(rep.getAttribute('width') || '0', 10),
        height: parseInt(rep.getAttribute('height') || '0', 10),
        base: repBase ? resolve(repBase, setRoot) : setRoot,
        node: rep,
        set,
        totalSeconds,
      });
    }
  }
  return out;
}

function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/^P(?:.*?T)?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

/** Turns one DASH Representation into a flat { init, segments } plan. */
function dashTrack(rep) {
  const pick = (tag) => rep.node.querySelector(':scope > ' + tag) || rep.set.querySelector(':scope > ' + tag);
  const fill = (tpl, n) =>
    tpl
      .replace(/\$RepresentationID\$/g, rep.id)
      .replace(/\$Bandwidth\$/g, String(rep.bandwidth))
      .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) => (pad ? String(n).padStart(+pad, '0') : String(n)))
      .replace(/\$\$/g, '$');

  const tpl = pick('SegmentTemplate');
  if (tpl) {
    const media = tpl.getAttribute('media');
    if (!media) throw new Error('DASH template has no media pattern');
    const start = parseInt(tpl.getAttribute('startNumber') || '1', 10);
    const initAttr = tpl.getAttribute('initialization');
    const init = initAttr ? resolve(fill(initAttr, start), rep.base) : null;

    const timeline = tpl.querySelector('SegmentTimeline');
    let count;
    if (timeline) {
      count = 0;
      for (const s of timeline.querySelectorAll('S')) count += 1 + (parseInt(s.getAttribute('r') || '0', 10) || 0);
    } else {
      const dur = parseInt(tpl.getAttribute('duration') || '0', 10);
      const scale = parseInt(tpl.getAttribute('timescale') || '1', 10) || 1;
      if (!dur || !rep.totalSeconds) throw new Error('Cannot determine DASH segment count');
      count = Math.ceil(rep.totalSeconds / (dur / scale));
    }

    const segments = [];
    for (let i = 0; i < count; i++) segments.push(resolve(fill(media, start + i), rep.base));
    return { init, segments };
  }

  const list = pick('SegmentList');
  if (list) {
    const initAttr = list.querySelector('Initialization')?.getAttribute('sourceURL');
    return {
      init: initAttr ? resolve(initAttr, rep.base) : null,
      segments: [...list.querySelectorAll('SegmentURL')].map((s) => resolve(s.getAttribute('media'), rep.base)),
    };
  }

  // No segmenting at all — the BaseURL is the whole file.
  return { init: null, segments: [rep.base] };
}

/* -------------------------------------------------------------- assembling */

/** Fetches every URL, keeping output order, with a bounded number in flight. */
async function fetchAll(urls, jobId, onTick) {
  const parts = new Array(urls.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < urls.length) {
      if (cancelled.has(jobId)) throw new Error('cancelled');
      const i = next++;
      const res = await fetch(urls[i], { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status} on segment ${i + 1}`);
      parts[i] = await res.arrayBuffer();
      onTick(++done);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return parts;
}

async function buildTrack({ init, segments }, jobId, name, ext, progress, onAssembled) {
  const urls = init ? [init, ...segments] : segments;
  if (!urls.length) throw new Error('Stream contains no segments');

  const parts = await fetchAll(urls, jobId, (n) => progress(n, urls.length));
  const blob = new Blob(parts, { type: ext === 'mp4' ? 'video/mp4' : 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);

  await onAssembled({ jobId, blobUrl, name, ext });
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10 * 60_000);
  return blob.size;
}

export async function assemble({ jobId, kind, url, variant, name }, { onProgress, onAssembled }) {
  cancelled.delete(jobId);
  onProgress(jobId, 'preparing');

  let tracks;
  if (kind === 'hls') {
    const plan = await hlsPlan(url, variant);
    if (plan.encrypted) throw new Error('This stream is encrypted and is not supported');
    tracks = plan.tracks;
  } else {
    const reps = dashRepresentations(await fetchText(url), url);
    if (!reps.length) throw new Error('No representations in this manifest');

    const video = reps
      .filter((r) => r.kind === 'video')
      .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    const audio = reps.filter((r) => r.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);

    const chosenVideo = video.find((r) => r.id === variant) || video[0];
    tracks = [];
    if (chosenVideo) tracks.push({ ...dashTrack(chosenVideo), kind: 'video' });
    if (audio[0]) tracks.push({ ...dashTrack(audio[0]), kind: 'audio' });
  }

  // Video and audio arrive as separate files when the stream keeps them apart;
  // there is no muxer in the browser, so say so rather than dropping the audio.
  const split = tracks.length > 1;
  const totals = tracks.map((t) => (t.init ? 1 : 0) + t.segments.length);
  const grand = totals.reduce((a, b) => a + b, 0);
  let carried = 0;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const isAudio = t.kind === 'audio';
    const ext = isAudio ? 'm4a' : 'mp4';
    const label = split ? `${name} (${t.kind})` : name;

    await buildTrack(t, jobId, label, ext, (n, total) => {
      onProgress(jobId, 'downloading', {
        percent: Math.round(((carried + n) / grand) * 100),
        detail: `${carried + n} / ${grand} segments`,
      });
      if (n === total) carried += total;
    }, onAssembled);
  }

  onProgress(jobId, 'done', { split });
}

/* ------------------------------------------------------------------ public */

export async function variants({ kind, url }) {
  if (kind === 'hls') {
    const text = await fetchText(url);
    if (!text.includes('#EXT-X-STREAM-INF')) return { variants: [] };
    const { variants: list } = parseMaster(text, url);
    return { variants: list.map((v) => ({ id: v.url, label: labelFor(v), height: v.height })) };
  }
  if (kind === 'dash') {
    const reps = dashRepresentations(await fetchText(url), url)
      .filter((r) => r.kind === 'video')
      .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    return { variants: reps.map((r) => ({ id: r.id, label: labelFor(r), height: r.height })) };
  }
  return { variants: [] };
}

export function cancel(jobId) {
  cancelled.add(jobId);
}
