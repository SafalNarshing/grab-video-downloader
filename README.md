# Grab — Video Downloader

A Chrome/Edge extension (Manifest V3) that finds the video and audio a page is
playing and saves it to disk. Progressive files download directly; HLS and DASH
streams are rebuilt segment by segment in the browser.

The panel is deliberately square — no rounded corners anywhere — with a near
black dark theme, a grey-white light theme, and a single liquid-glass action
button.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this folder.
3. Pin the extension so the badge (which counts what was found) stays visible.

Requires Chrome or Edge 116+ (`chrome.runtime.getContexts` and the offscreen
document API).

## Use

Play the video first — detection is driven by what the page actually requests.
Then open the panel, pick a row, and press **Download**.

- The badge shows how many media items the current tab has offered.
- Streams (`HLS` / `DASH` badges) show a **Quality** selector when the manifest
  advertises more than one rendition.
- While a download runs, the glass button fills with progress; clicking it
  cancels.
- The circular-arrow button re-scans the page, which helps on tabs that were
  already open when the extension was installed.

## How it works

| File | Role |
| --- | --- |
| `src/background.js` | Service worker. Watches responses via `webRequest`, keeps a per-tab index, and drives the downloads API. |
| `src/content.js` | Reads `<video>`/`<source>`/`og:video` from the DOM, and acts as a fallback downloader using the page's own cookies and referrer. |
| `src/offscreen/offscreen.js` | Parses HLS playlists and DASH manifests, fetches segments (6 at a time), and concatenates them into a Blob. Lives in an offscreen document because service workers have no `URL.createObjectURL`. |
| `src/popup/` | The panel: list, theme toggle, quality selector, glass button. |
| `tools/make-icons.py` | Regenerates every icon from `logo.jpg` — the toolbar tiles plus the tinted header marks. Run with `python tools/make-icons.py`. |

Detection uses two independent paths because neither is sufficient alone: the
network sniffer catches streams the DOM never exposes, and the content script
catches players that loaded before the extension woke up.

## Branding

`logo.jpg` is the single source of truth for artwork. `tools/make-icons.py`
crops it to the mark and emits both families it is used in: the toolbar icons
keep the logo's own light tile so they stay legible on any toolbar, while the
popup header uses a background-removed copy tinted per theme — dark ink on the
light panel, white on the black one.

## Limits worth knowing

These are real constraints, not TODOs:

- **No muxing.** When a stream keeps video and audio in separate tracks — which
  DASH almost always does, and HLS often does — you get two files, labelled
  `(video)` and `(audio)`. Joining them needs a tool like `ffmpeg`:
  `ffmpeg -i in.video.mp4 -i in.audio.m4a -c copy out.mp4`.
- **No encrypted or DRM streams.** Playlists carrying `EXT-X-KEY`, and DASH
  manifests with a `ContentProtection` block, are reported as unsupported. This
  extension does not decrypt anything.
- **YouTube is partial.** Its progressive stream (360p) is usually grabbable;
  higher qualities are adaptive and arrive as separate video and audio files
  with short-lived signed URLs, so they must be muxed and can expire mid-job.
  Sites that serve plain MP4 — Instagram, LinkedIn, Twitter/X, Reddit, most
  news and course sites — behave much better.
- **Streams are assembled in memory.** A long, high-bitrate stream can use a lot
  of RAM before it reaches disk. Progressive files stream straight to disk and
  are unaffected.
- **Live streams** download only the window the playlist currently advertises.

Downloading is subject to the terms of the site you are on and to copyright.
Use it on material you have the right to keep.

## Developing the UI

`src/popup/preview.html` renders the panel in a normal browser tab with stub
data, so you can iterate on the CSS without reloading the extension. It is not
referenced by the manifest.

```
chrome src/popup/preview.html?theme=dark
chrome src/popup/preview.html?theme=light&state=busy
```
