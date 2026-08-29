"""Grab — local download server.

A thin FastAPI wrapper around yt-dlp and ffmpeg. The browser extension asks it
what a URL offers, then asks it to fetch one of those options; everything that
needs real muxing, format selection, or site-specific extraction happens here
rather than in the browser.

Run it:

    python server/server.py                     # 127.0.0.1:8787
    python server/server.py --port 9000 --dir ~/Videos
    python server/server.py --cookies-from-browser chrome

Bind to loopback only unless you know what you are doing: this process will
download any URL it is handed.
"""

from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from yt_dlp import YoutubeDL

APP_NAME = "Grab"
APP_VERSION = "1.1.0"

# Resolutions offered when the site actually has something at or above them.
LADDER = (2160, 1440, 1080, 720, 480, 360, 240)


# --------------------------------------------------------------------- config


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8787
    download_dir: Path = field(default_factory=lambda: Path.home() / "Downloads" / "Grab")
    workers: int = 3
    cookies_from_browser: str | None = None
    cookies_file: Path | None = None
    keep_files: bool = True
    extra_ytdlp_opts: dict[str, Any] = field(default_factory=dict)

    @property
    def work_dir(self) -> Path:
        return self.download_dir / ".partial"


CONFIG = Config()


# ----------------------------------------------------------------- job state


class Cancelled(Exception):
    """Raised out of a progress hook to abort a running download."""


@dataclass
class Job:
    id: str
    url: str
    status: Literal[
        "queued", "preparing", "downloading", "processing", "done", "error", "cancelled"
    ] = "queued"
    percent: float = 0.0
    speed: str = ""
    eta: str = ""
    title: str = ""
    filename: str = ""
    path: str = ""
    size: int = 0
    error: str = ""
    created: float = field(default_factory=time.time)
    cancel: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "status": self.status,
            "percent": round(self.percent, 1),
            "speed": self.speed,
            "eta": self.eta,
            "title": self.title,
            "filename": self.filename,
            "size": self.size,
            "error": self.error,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
POOL: ThreadPoolExecutor | None = None


# ------------------------------------------------------------------- helpers


def humanise_error(exc: Exception) -> str:
    """Turns yt-dlp's wall of text into one line a person can act on."""
    raw = str(exc)
    text = re.sub(r"\x1b\[[0-9;]*m", "", raw)  # strip ANSI colour
    text = text.replace("ERROR: ", "").strip()

    lowered = text.lower()
    if "private" in lowered or "log in" in lowered or "login" in lowered or "sign in" in lowered:
        return (
            "This video is private or needs a login. Start the server with "
            "--cookies-from-browser chrome to reuse your browser session."
        )
    if "geo" in lowered and "block" in lowered:
        return "This video is blocked in your region."
    if "unsupported url" in lowered or "no video" in lowered:
        return "yt-dlp does not recognise a video at that URL."
    if "404" in lowered or "not found" in lowered:
        return "That page could not be reached (404). Check the link."
    if "unable to download webpage" in lowered:
        return "Could not load that page. Check the link or your connection."
    if "video unavailable" in lowered or "removed" in lowered:
        return "That video is unavailable or has been removed."
    if "ffmpeg" in lowered:
        return "ffmpeg is required for this format but was not found on PATH."
    if "age" in lowered and "confirm" in lowered:
        return "This video is age-restricted. Pass browser cookies to reach it."

    return text.splitlines()[0][:300] if text else "Download failed."


def base_ydl_opts() -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,  # a watch URL carrying &list= must not pull the playlist
        "ignoreerrors": False,
        "retries": 5,
        "fragment_retries": 5,
        "socket_timeout": 30,
    }
    if CONFIG.cookies_from_browser:
        opts["cookiesfrombrowser"] = (CONFIG.cookies_from_browser,)
    if CONFIG.cookies_file:
        opts["cookiefile"] = str(CONFIG.cookies_file)
    opts.update(CONFIG.extra_ytdlp_opts)
    return opts


def ffmpeg_present() -> bool:
    return shutil.which("ffmpeg") is not None


def approx_size(fmt: dict[str, Any]) -> int:
    return int(fmt.get("filesize") or fmt.get("filesize_approx") or 0)


def format_bytes(n: int) -> str:
    if not n:
        return ""
    units = ["B", "KB", "MB", "GB"]
    value = float(n)
    idx = 0
    while value >= 1024 and idx < len(units) - 1:
        value /= 1024
        idx += 1
    return f"{value:.0f} {units[idx]}" if value >= 10 or idx == 0 else f"{value:.1f} {units[idx]}"


def build_options(info: dict[str, Any]) -> list[dict[str, Any]]:
    """Turns yt-dlp's raw format table into a short, ranked menu.

    The extension only ever echoes one of these back, so all the reasoning about
    codecs, muxing, and what actually exists stays on this side.
    """
    formats = [f for f in (info.get("formats") or []) if f.get("url")]
    have_ffmpeg = ffmpeg_present()

    video = [f for f in formats if f.get("vcodec") not in (None, "none")]
    audio = [f for f in formats if f.get("vcodec") in (None, "none") and f.get("acodec") not in (None, "none")]
    heights = {f.get("height") or 0 for f in video} - {0}

    options: list[dict[str, Any]] = []

    if video or info.get("url"):
        options.append(
            {
                "key": "best",
                "label": "Best available",
                "detail": "MP4" if have_ffmpeg else "MP4 · single file",
                "type": "mp4",
                "height": 0,
                "format_id": None,
            }
        )

    for rung in LADDER:
        if not any(h >= rung for h in heights):
            continue
        # Size preview: the smallest video stream that satisfies this rung, plus
        # the best audio it will be merged with.
        at_rung = [f for f in video if (f.get("height") or 0) == rung]
        best_audio = max((approx_size(f) for f in audio), default=0)
        size = min((approx_size(f) for f in at_rung if approx_size(f)), default=0)
        total = size + best_audio if size else 0

        options.append(
            {
                "key": f"h{rung}",
                "label": f"{rung}p",
                "detail": " · ".join(x for x in ("MP4", format_bytes(total)) if x),
                "type": "mp4",
                "height": rung,
                "format_id": None,
            }
        )

    if audio or video:
        options.append(
            {
                "key": "mp3",
                "label": "Audio only",
                "detail": "MP3 · 192 kbps" if have_ffmpeg else "MP3 · needs ffmpeg",
                "type": "mp3",
                "height": 0,
                "format_id": None,
                "disabled": not have_ffmpeg,
            }
        )

    return options


def selector_for(kind: str, height: int, format_id: str | None) -> str:
    """Maps a menu choice onto a yt-dlp format selector."""
    if kind == "mp3":
        return "bestaudio/best"
    if format_id:
        return f"{format_id}+bestaudio/{format_id}/best"
    if height:
        return (
            f"bestvideo[height<={height}]+bestaudio/"
            f"best[height<={height}]/"
            f"bestvideo+bestaudio/best"
        )
    return "bestvideo+bestaudio/best"


# ------------------------------------------------------------------ download


def run_job(job: Job, kind: str, height: int, format_id: str | None) -> None:
    # Extraction runs before any progress hook fires and can take many seconds,
    # so leaving the job on "queued" would look like nothing was happening.
    job.status = "preparing"
    work = CONFIG.work_dir / job.id
    work.mkdir(parents=True, exist_ok=True)

    def progress_hook(d: dict[str, Any]) -> None:
        if job.cancel:
            raise Cancelled()
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            job.status = "downloading"
            # Merged formats download twice (video then audio); cap so the bar
            # never runs backwards on the second pass.
            if total:
                job.percent = max(job.percent, min(99.0, done / total * 100))
            job.speed = (d.get("_speed_str") or "").strip()
            job.eta = (d.get("_eta_str") or "").strip()
        elif d.get("status") == "finished":
            job.status = "processing"

    def postprocessor_hook(d: dict[str, Any]) -> None:
        if job.cancel:
            raise Cancelled()
        if d.get("status") == "started":
            job.status = "processing"

    opts = base_ydl_opts()
    opts.update(
        {
            "outtmpl": str(work / "%(title).120B.%(ext)s"),
            "format": selector_for(kind, height, format_id),
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [postprocessor_hook],
        }
    )

    if kind == "mp3":
        opts["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
        ]
    else:
        opts["merge_output_format"] = "mp4"

    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(job.url, download=True)
        job.title = info.get("title") or job.title

        produced = sorted(
            (p for p in work.iterdir() if p.is_file() and not p.name.endswith(".part")),
            key=lambda p: p.stat().st_size,
            reverse=True,
        )
        if not produced:
            raise RuntimeError("yt-dlp reported success but produced no file.")

        final = produced[0]
        CONFIG.download_dir.mkdir(parents=True, exist_ok=True)
        target = CONFIG.download_dir / final.name
        counter = 1
        while target.exists():
            target = CONFIG.download_dir / f"{final.stem} ({counter}){final.suffix}"
            counter += 1
        shutil.move(str(final), str(target))

        job.path = str(target)
        job.filename = target.name
        job.size = target.stat().st_size
        job.percent = 100.0
        job.status = "done"

    except Cancelled:
        job.status = "cancelled"
        job.error = "Cancelled."
    except Exception as exc:  # noqa: BLE001 - every failure becomes one message
        job.status = "error"
        job.error = humanise_error(exc)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- API models


class InfoRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    type: Literal["mp4", "mp3", "best"] = "mp4"
    height: int = 0
    format_id: str | None = None
    title: str | None = Field(default=None, description="Optional label for the job list.")


# ------------------------------------------------------------------- the app

app = FastAPI(title=f"{APP_NAME} download server", version=APP_VERSION)

# Only the extension may read responses. A page in a normal tab cannot: our
# endpoints require application/json, which forces a preflight that this policy
# rejects for http(s) origins.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-z]+$|^moz-extension://[0-9a-f-]+$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, Any]:
    import yt_dlp

    return {
        "status": "ok",
        "app": APP_NAME,
        "version": APP_VERSION,
        "yt_dlp": yt_dlp.version.__version__,
        "ffmpeg": ffmpeg_present(),
        "download_dir": str(CONFIG.download_dir),
        "cookies": CONFIG.cookies_from_browser or ("file" if CONFIG.cookies_file else None),
    }


@app.post("/info")
def info(req: InfoRequest) -> dict[str, Any]:
    try:
        with YoutubeDL({**base_ydl_opts(), "skip_download": True}) as ydl:
            data = ydl.extract_info(req.url, download=False)
    except Exception as exc:  # noqa: BLE001 - every failure becomes one message
        raise HTTPException(status_code=422, detail=humanise_error(exc)) from exc

    if data is None:
        raise HTTPException(status_code=422, detail="Nothing extractable at that URL.")
    if data.get("_type") == "playlist":
        entries = [e for e in (data.get("entries") or []) if e]
        if not entries:
            raise HTTPException(status_code=422, detail="That playlist is empty.")
        data = entries[0]  # noplaylist should prevent this; be safe anyway

    return {
        "title": data.get("title") or "",
        "thumbnail": data.get("thumbnail") or "",
        "duration": int(data.get("duration") or 0),
        "uploader": data.get("uploader") or data.get("channel") or "",
        "extractor": data.get("extractor_key") or "",
        "webpage_url": data.get("webpage_url") or req.url,
        "is_live": bool(data.get("is_live")),
        "options": build_options(data),
    }


@app.post("/download")
def download(req: DownloadRequest) -> dict[str, str]:
    if POOL is None:
        raise HTTPException(status_code=503, detail="Server is still starting.")
    kind = "mp3" if req.type == "mp3" else "mp4"
    if kind == "mp3" and not ffmpeg_present():
        raise HTTPException(status_code=503, detail="MP3 needs ffmpeg, which is not on PATH.")

    job = Job(id=uuid.uuid4().hex[:12], url=req.url, title=req.title or "")
    with JOBS_LOCK:
        JOBS[job.id] = job
    POOL.submit(run_job, job, kind, req.height, req.format_id)
    return {"job_id": job.id}


@app.get("/progress/{job_id}")
def progress(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="No such job.")
    return job.public()


@app.get("/jobs")
def jobs() -> dict[str, Any]:
    with JOBS_LOCK:
        return {"jobs": [j.public() for j in sorted(JOBS.values(), key=lambda j: j.created, reverse=True)]}


@app.get("/file/{job_id}")
def file(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="No such job.")
    if job.status != "done" or not job.path:
        raise HTTPException(status_code=409, detail=f"Job is {job.status}.")
    path = Path(job.path)
    if not path.exists():
        raise HTTPException(status_code=410, detail="The file has been moved or deleted.")
    return FileResponse(path, filename=path.name, media_type="application/octet-stream")


@app.post("/cancel/{job_id}")
def cancel(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="No such job.")
    job.cancel = True
    return job.public()


@app.post("/reveal/{job_id}")
def reveal(job_id: str) -> dict[str, Any]:
    """Opens the finished file's folder in the OS file manager."""
    job = JOBS.get(job_id)
    if not job or not job.path:
        raise HTTPException(status_code=404, detail="No such file.")
    folder = str(Path(job.path).parent)
    try:
        if platform.system() == "Windows":
            os.startfile(folder)  # noqa: S606 - a path this process created
        elif platform.system() == "Darwin":
            subprocess.run(["open", folder], check=False)
        else:
            subprocess.run(["xdg-open", folder], check=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"opened": folder}


# ------------------------------------------------------------------ entrypoint


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="grab-server", description=f"{APP_NAME} local download server")
    p.add_argument("--host", default=os.environ.get("GRAB_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("GRAB_PORT", "8787")))
    p.add_argument(
        "--dir",
        dest="download_dir",
        default=os.environ.get("GRAB_DIR", str(Path.home() / "Downloads" / "Grab")),
        help="where finished files are written",
    )
    p.add_argument("--workers", type=int, default=int(os.environ.get("GRAB_WORKERS", "3")))
    p.add_argument(
        "--cookies-from-browser",
        default=os.environ.get("GRAB_COOKIES_BROWSER"),
        help="reuse a browser session (chrome, edge, firefox, brave …) for private or logged-in videos",
    )
    p.add_argument(
        "--cookies",
        dest="cookies_file",
        default=os.environ.get("GRAB_COOKIES_FILE"),
        help="path to a Netscape-format cookies.txt",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    global POOL

    args = parse_args(argv)
    CONFIG.host = args.host
    CONFIG.port = args.port
    CONFIG.download_dir = Path(args.download_dir).expanduser().resolve()
    CONFIG.workers = max(1, args.workers)
    CONFIG.cookies_from_browser = args.cookies_from_browser
    CONFIG.cookies_file = Path(args.cookies_file).expanduser() if args.cookies_file else None

    CONFIG.download_dir.mkdir(parents=True, exist_ok=True)
    CONFIG.work_dir.mkdir(parents=True, exist_ok=True)
    POOL = ThreadPoolExecutor(max_workers=CONFIG.workers, thread_name_prefix="grab")

    if not ffmpeg_present():
        print("! ffmpeg not found on PATH — merged MP4 and MP3 output will not work.", file=sys.stderr)
    if CONFIG.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"! listening on {CONFIG.host} — this server downloads any URL it is given.", file=sys.stderr)

    print(f"{APP_NAME} server on http://{CONFIG.host}:{CONFIG.port}  ->  {CONFIG.download_dir}")
    uvicorn.run(app, host=CONFIG.host, port=CONFIG.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
