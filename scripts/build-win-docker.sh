#!/usr/bin/env bash
#
# Cross-build the Windows NSIS installer for SnapDoc inside a Linux container —
# fully local, no GitHub Actions and no Windows machine. Use this because the
# macOS Homebrew `makensis` is broken on Apple Silicon; NSIS works correctly on Linux.
#
# Prerequisites: Docker Desktop running, and the updater signing key at
# ~/.tauri/snapdoc-updater.key (so the produced .exe gets its .sig).
#
# Usage:
#   scripts/build-win-docker.sh            # builds current version
# Output (host):  dist-win/SnapDoc_<ver>_x64-setup.exe (+ .sig)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="snapdoc-wincross"
KEYFILE="$HOME/.tauri/snapdoc-updater.key"

command -v docker >/dev/null || { echo "ERROR: docker not installed"; exit 1; }
docker info >/dev/null 2>&1   || { echo "ERROR: Docker daemon not running — start Docker Desktop and retry."; exit 1; }
[ -f "$KEYFILE" ] || { echo "ERROR: updater signing key missing at $KEYFILE"; exit 1; }

# Build the toolchain image once (cached afterwards).
echo "==> Building cross image (first run downloads the toolchain; cached after)"
docker build -t "$IMAGE" -f scripts/win-cross.Dockerfile scripts/

mkdir -p dist-win

# Copy the working tree into the container (excluding host-arch artifacts), build,
# and copy the installer + signature back out. The host node_modules/target are
# never touched.
echo "==> Cross-building Windows NSIS installer in container"
docker run --rm \
  -v "$PWD":/src:ro \
  -v "$PWD/dist-win":/out \
  -e TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYFILE")" \
  -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
  "$IMAGE" bash -lc '
    rsync -a --exclude target --exclude node_modules --exclude .git --exclude dist --exclude dist-win /src/ /app/
    cd /app
    npm ci
    npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
    cp src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe     /out/
    cp src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe.sig /out/
  '

echo
echo "==> Done. Artifacts in dist-win/:"
ls -lh dist-win/
