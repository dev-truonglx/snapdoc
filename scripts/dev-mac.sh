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
KEYFILE="$HOME/.tauri/snapdoc-updater.key"

# Give the dev build its OWN bundle identifier + name, distinct from the
# release build's `com.snapdoc.app` / "SnapDoc" (see tauri.conf.json). That
# makes macOS treat it as a separate app: its own Dock icon/name, its own
# Screen Recording TCC grant, and its own app-data dir — so a dev build never
# collides with (or silently reuses permissions/data from) an installed
# release build. Passed via `--config` below so tauri.conf.json itself stays
# untouched — this only ever applies to this script's build.
DEV_IDENTIFIER="com.snapdoc.app.dev"
DEV_PRODUCT_NAME="SnapDoc Dev"
APP="src-tauri/target/debug/bundle/macos/$DEV_PRODUCT_NAME.app"

# 1) Make the stable identity available so Tauri signs the .app during bundling.
echo "==> [1/4] Ensuring stable signing identity"
bash scripts/macos-codesign.sh --ensure-only

# Load updater signing key nếu có — dev build cần key vì tauri.conf.json có pubkey.
# Không có key → disable createUpdaterArtifacts để build không fail.
if [ -f "$KEYFILE" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYFILE")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
fi

# 2) Debug build, app bundle only (skip the slow .dmg). Tauri picks up
#    APPLE_SIGNING_IDENTITY and signs the bundle with it.
#
#    Tauri's bundler can reuse a stale `externalBin` sidecar (e.g. ffmpeg)
#    copied into a PREVIOUS bundle output — confirmed by hand: after fixing a
#    broken ffmpeg in src-tauri/binaries/, `target/debug/bundle/.../ffmpeg`
#    kept the old broken bytes across rebuilds until every existing
#    `SnapDoc Dev.app` anywhere under target/ (debug, release, and the
#    separate universal-apple-darwin tree used for updater/universal builds)
#    was wiped first. Deleting only the current profile's `$APP` was NOT
#    enough — some other target/* bundle output still fed the stale copy in.
#    Sweep all of them so this can't come back regardless of which one is the
#    real cause. Only matches the dev product name — a release "SnapDoc.app"
#    built via build-mac.sh is untouched.
find src-tauri/target -type d -name "$DEV_PRODUCT_NAME.app" -prune -exec rm -rf {} +

# This script never passes --target, so cargo only ever writes into
# target/debug — the per-triple dirs below (aarch64-apple-darwin,
# x86_64-apple-darwin, universal-apple-darwin) only exist because
# scripts/release-all.sh built a universal release at some point. Left in
# place they just sit there unused (measured: 3.5GB combined) — safe to wipe
# every dev build; release-all.sh recompiles them fresh anyway when it runs.
rm -rf src-tauri/target/aarch64-apple-darwin src-tauri/target/x86_64-apple-darwin src-tauri/target/universal-apple-darwin

# cargo never deletes superseded incremental artifacts on its own — every
# dependency/profile change leaves the old .rlib/.o versions behind in
# target/debug/deps forever (measured: 28k+ files, ~10GB, after normal use).
#
# `cargo sweep --file` (stamp-before/sweep-after a single build) looks
# tempting but is WRONG here and was tried first: it deletes anything with an
# mtime older than the stamp, and cargo does NOT rewrite an unchanged
# dependency's .rlib when a build just reuses it — so it deleted every
# untouched-but-still-needed dep after one normal build, turning the very
# next `dev:mac` into a full from-scratch recompile (measured: 3m16s instead
# of ~3s). `--time <days>` instead only removes artifacts untouched for that
# many days, which can't catch anything from today's active incremental
# cache — confirmed via `--dry-run --time 3` cleaning nothing right after a
# fresh build, so this is safe to run on every invocation.
if ! command -v cargo-sweep >/dev/null 2>&1; then
  echo "==> Installing cargo-sweep (one-time, prunes stale target/ artifacts)"
  cargo install cargo-sweep
fi
cargo sweep --time 3 src-tauri

echo "==> [2/4] Building debug .app bundle ($DEV_PRODUCT_NAME / $DEV_IDENTIFIER)"
if [ -f "$KEYFILE" ]; then
  npm run tauri build -- --debug --bundles app \
    --config "{\"identifier\":\"$DEV_IDENTIFIER\",\"productName\":\"$DEV_PRODUCT_NAME\"}" "$@"
else
  echo "    (no updater key — building without updater artifacts)"
  npm run tauri build -- --debug --bundles app \
    --config "{\"identifier\":\"$DEV_IDENTIFIER\",\"productName\":\"$DEV_PRODUCT_NAME\",\"bundle\":{\"createUpdaterArtifacts\":false}}" "$@"
fi

# 3) Guarantee a valid deep signature regardless of how Tauri signed it, and
#    fail loudly if it somehow ended up ad-hoc (that would break the TCC grant).
echo "==> [3/4] Deep-signing with stable identity"
bash scripts/macos-codesign.sh "$APP"
if codesign -dvvv "$APP" 2>&1 | grep -q "Signature=adhoc"; then
  echo "ERROR: $APP is ad-hoc signed — the Screen Recording grant will NOT persist." >&2
  exit 1
fi

# 4) Relaunch a clean instance.
echo "==> [4/4] Launching $DEV_PRODUCT_NAME"
pkill -f "$DEV_PRODUCT_NAME.app/Contents/MacOS" >/dev/null 2>&1 || true
sleep 0.3

# `open` (below) detaches stdout/stderr from this terminal, so the app's own
# `eprintln!`/`println!` debug output would otherwise vanish. The debug binary
# redirects fd 1/2 to this file on startup (see redirect_stdio_to_dev_log in
# src-tauri/src/lib.rs, debug-only) — truncate it first so this run's tail
# doesn't echo back a previous session's stale output.
LOG_FILE="$HOME/Library/Logs/com.snapdoc.app/SnapDoc.log"
mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"

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
echo " $DEV_PRODUCT_NAME launched (signed: $APPLE_SIGNING_IDENTITY)."
echo " Separate identifier from the release build ($DEV_IDENTIFIER vs."
echo " the release's identifier in tauri.conf.json) — first run needs its"
echo " OWN grant: System Settings > Privacy & Security > Screen Recording"
echo " > enable $DEV_PRODUCT_NAME, then quit & rerun this."
echo " Every later 'npm run dev:mac' keeps that grant."
echo "============================================================"

# `open` detaches stdout from this terminal (its output goes nowhere useful),
# so tail the app's OWN log file instead — same eprintln!/println! debug
# output, just read from disk. Ctrl+C here only stops the tail, the app keeps
# running (quit it from the tray icon).
echo " Streaming logs from: $LOG_FILE"
echo " (Ctrl+C stops watching — the app keeps running)"
echo "============================================================"
echo
for _ in $(seq 1 20); do
  [ -s "$LOG_FILE" ] && break
  sleep 0.25
done
exec tail -n 50 -f "$LOG_FILE"