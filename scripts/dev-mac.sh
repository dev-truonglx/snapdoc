#!/usr/bin/env bash
#
# Local macOS DEV build for SnapDoc, automatically signed with a STABLE
# self-signed identity so the Screen Recording (TCC) permission survives
# rebuilds — grant it ONCE, never re-grant.
#
# Why a bundle and not `tauri dev`?
#   `tauri dev` runs a bare, ad-hoc binary whose code identity changes every
#   build, so macOS keeps revoking Screen Recording (captures go black). A real,
#   stably-signed .app keeps the grant. This builds a DEBUG .app (fast: app
#   bundle only, no .dmg), signs it, and launches it. Frontend is bundled (no
#   HMR) — for pure UI iteration use `npm run app:dev` instead.
#
# Usage: scripts/dev-mac.sh [extra `tauri build` args]
set -euo pipefail
cd "$(dirname "$0")/.."

export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-SnapDoc Dev}"
APP="src-tauri/target/debug/bundle/macos/SnapDoc.app"

# 1) Make the stable identity available so Tauri signs the .app during bundling.
echo "==> [1/4] Ensuring stable signing identity"
bash scripts/macos-codesign.sh --ensure-only

# 2) Debug build, app bundle only (skip the slow .dmg). Tauri picks up
#    APPLE_SIGNING_IDENTITY and signs the bundle with it.
echo "==> [2/4] Building debug .app bundle"
npm run tauri build -- --debug --bundles app "$@"

# 3) Guarantee a valid deep signature regardless of how Tauri signed it, and
#    fail loudly if it somehow ended up ad-hoc (that would break the TCC grant).
echo "==> [3/4] Deep-signing with stable identity"
bash scripts/macos-codesign.sh "$APP"
if codesign -dvvv "$APP" 2>&1 | grep -q "Signature=adhoc"; then
  echo "ERROR: $APP is ad-hoc signed — the Screen Recording grant will NOT persist." >&2
  exit 1
fi

# 4) Relaunch a clean instance.
echo "==> [4/4] Launching SnapDoc"
pkill -f "SnapDoc.app/Contents/MacOS" >/dev/null 2>&1 || true
sleep 0.3

# A freshly (re)built debug bundle isn't in the LaunchServices database yet, so
# `open` fails with error -600 (procNotFound). Force-register it first.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" || true

if ! open "$APP" 2>/dev/null; then
  echo "    open failed — launching the bundle binary directly."
  EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || echo snapdoc)"
  "$APP/Contents/MacOS/$EXE_NAME" >/dev/null 2>&1 &
fi

echo
echo "============================================================"
echo " SnapDoc launched (signed: $APPLE_SIGNING_IDENTITY)."
echo " First run only: System Settings > Privacy & Security >"
echo " Screen Recording > enable SnapDoc, then quit & rerun this."
echo " Every later 'npm run dev:mac' keeps the grant."
echo "============================================================"
