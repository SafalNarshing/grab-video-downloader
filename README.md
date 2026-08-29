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
3. Pin the extension so its badge stays visible — a dot means the tab has
   something to grab.

Requires Chrome or Edge 116+ (`chrome.runtime.getContexts` and the offscreen
document API).

## Use

Press play, then open the panel. It shows the one video the page is playing —
thumbnail, title, site, and length — not a list of every media URL that went
past. Pick a resolution and press **Download**.

- **Quality** lists every source found for that video, best picture first, one
  entry per resolution. Audio-only sinks to the bottom.
- While a download runs the glass button fills with progress; clicking it
  cancels.
- The circular arrow re-scans, which helps on tabs that were already open when
  the extension was installed, and after a single-page navigation.

### Pasting a link

The field at the bottom takes either kind of link:

- A **direct media link** (`.mp4`, `.m3u8`, `.mpd`, …) is adopted straight away
  and appears as a quality option.
- A **page link** is opened in a background tab, because a watch page only
  hands over its video once a real browser loads and plays it. Grab waits about
  twelve seconds for that tab to reveal something. If the site does not
  autoplay, press play in the tab it opened and hit rescan.

There is no page scraping and no URL-signature work behind this — it is the
browser doing what it would normally do, with the sniffer watching.

## How it works

| File | Role |
| --- | --- |
| `src/background.js` | Service worker. Watches responses via `webRequest`, keeps a per-tab index, and drives the downloads API. |
| `src/content.js` | Picks the video the user is watching — scored on size, visibility, and whether it is playing — and reports its title, poster, and length. Also acts as a fallback downloader using the page's own cookies and referrer. |
| `src/offscreen/offscreen.js` | Parses HLS playlists and DASH manifests, fetches segments (6 at a time), and concatenates them into a Blob. Lives in an offscreen document because service workers have no `URL.createObjectURL`. |
| `src/popup/` | The panel: hero card, theme toggle, quality selector, paste-a-link row, glass button. |
| `tools/make-icons.py` | Regenerates every icon from `logo.jpg` — the toolbar tiles plus the tinted header marks. Run with `python tools/make-icons.py`. |

Detection uses two independent paths because neither is sufficient alone: the
network sniffer catches streams the DOM never exposes, and the content script
catches players that loaded before the extension woke up. The two are folded
together per tab — the content script says *what* is playing, the sniffer says
*where it can be fetched from* — which is what turns a pile of URLs into one
video with a quality list.

Every frame reports independently, so an embedded player wins the video while
the top frame still supplies the page's title and thumbnail.

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
- **YouTube is partial.** Its progressive stream (360p) is usually grabbable
  with sound; higher qualities are adaptive and arrive as separate video and
  audio files with short-lived signed URLs, so they must be muxed and can
  expire mid-job. Those entries are marked `no audio` in the quality list so
  the trade-off is visible before you download. Sites that serve plain MP4 —
  Instagram, LinkedIn, Twitter/X, Reddit, most news and course sites — behave
  much better.
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
chrome src/popup/preview.html?theme=light&state=empty
chrome src/popup/preview.html?theme=dark&state=busy
```
