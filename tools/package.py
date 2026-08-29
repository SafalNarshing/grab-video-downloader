"""Builds the installable extension zip.

    python tools/package.py

One package serves Chrome, Edge, and Firefox: the manifest carries both
background forms, and each browser ignores the one it does not understand.
The server, docs, and dev harness are left out — only what the browser loads
goes in.

The result is what you load unpacked, and what `web-ext sign` takes to produce
a signed Firefox .xpi.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Everything the browser actually loads.
INCLUDE_DIRS = ("icons", "src")
INCLUDE_FILES = ("manifest.json",)

# The preview harness uses inline <script>, which Firefox's default CSP blocks
# and web-ext lint flags. It is a dev tool and has no business shipping.
EXCLUDE_NAMES = {"preview.html", "context-url-test.html"}
EXCLUDE_SUFFIXES = {".pyc"}
EXCLUDE_PARTS = {"__pycache__", "node_modules"}


def wanted(path: pathlib.Path) -> bool:
    if path.name in EXCLUDE_NAMES or path.suffix in EXCLUDE_SUFFIXES:
        return False
    return not EXCLUDE_PARTS.intersection(path.parts)


def collect() -> list[pathlib.Path]:
    files = [ROOT / name for name in INCLUDE_FILES]
    for directory in INCLUDE_DIRS:
        files += [p for p in sorted((ROOT / directory).rglob("*")) if p.is_file() and wanted(p)]
    missing = [p for p in files if not p.exists()]
    if missing:
        raise SystemExit("missing: " + ", ".join(p.name for p in missing))
    return files


def main() -> None:
    version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    DIST.mkdir(exist_ok=True)
    target = DIST / f"grab-{version}.zip"
    unpacked = DIST / "unpacked"

    files = collect()

    # Deterministic order and no compression surprises, so rebuilds are stable.
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for path in files:
            z.write(path, path.relative_to(ROOT).as_posix())

    # The same tree unpacked: what `web-ext lint` and `web-ext sign` want, and
    # what you point Chrome at for "Load unpacked" when testing the real build.
    shutil.rmtree(unpacked, ignore_errors=True)
    for path in files:
        dest = unpacked / path.relative_to(ROOT)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)

    total = sum(p.stat().st_size for p in files)
    print(f"{target.relative_to(ROOT).as_posix()}  —  {len(files)} files, "
          f"{total / 1024:.0f} KB in, {target.stat().st_size / 1024:.0f} KB zipped")
    print(f"{unpacked.relative_to(ROOT).as_posix()}/  —  same tree, for web-ext and Load unpacked")


if __name__ == "__main__":
    main()
