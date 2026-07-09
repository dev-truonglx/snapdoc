#!/usr/bin/env bash
#
# Local macOS build that is automatically code-signed with the stable
# self-signed identity, so Screen Recording / Accessibility permission
# survives rebuilds.
#
# CI is unaffected: it never runs this script and never sets the identity, so
# release builds keep their current (unsigned/Developer-ID) behaviour.
#
# Usage: scripts/build-mac.sh [extra tauri build args]
set -euo pipefail

cd "$(dirname "$0")/.."

export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-SnapDoc Dev}"

# tauri.conf.json enables updater artifacts (createUpdaterArtifacts) + a pubkey,
# so bundling needs the updater SIGNING key. If the local key exists, use it and
# produce signed updater artifacts (matches CI). Otherwise disable updater
# artifacts for this local build so it doesn't fail — a dev install for testing
# doesn't need them.
KEYFILE="$HOME/.tauri/snapdoc-updater.key"

# Tauri's bundler can reuse a stale `externalBin` sidecar (e.g. ffmpeg) copied
# into a PREVIOUS bundle output — confirmed by hand: after fixing a broken
# ffmpeg in src-tauri/binaries/, `target/release/bundle/.../ffmpeg` kept the
# old broken bytes across rebuilds until every existing `SnapDoc.app` anywhere
# under target/ (debug, release, and the separate universal-apple-darwin tree
# used for updater/universal builds) was wiped first — deleting only this
# profile's bundle was NOT enough. Sweep all of them so this can't come back
# regardless of which one is the real cause.
find src-tauri/target -type d -name "SnapDoc.app" -prune -exec rm -rf {} +

# cargo never deletes superseded incremental artifacts on its own — every
# dependency/profile change leaves the old .rlib/.o versions behind in
# target/release forever.
#
# `cargo sweep --file` (stamp-before/sweep-after a single build) looks
# tempting but is WRONG here: it deletes anything with an mtime older than
# the stamp, and cargo does NOT rewrite an unchanged dependency's .rlib when
# a build just reuses it — so it deletes every untouched-but-still-needed dep
# after one normal build, turning the next build into a full from-scratch
# recompile (measured: 3m16s instead of ~3s, see dev-mac.sh for the repro).
# `--time <days>` only removes artifacts untouched for that many days, which
# can't catch anything from today's active incremental cache.
if ! command -v cargo-sweep >/dev/null 2>&1; then
  echo "==> Installing cargo-sweep (one-time, prunes stale target/ artifacts)"
  cargo install cargo-sweep
fi
cargo sweep --time 3 src-tauri

if [ -f "$KEYFILE" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYFILE")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  echo "==> Using updater signing key: $KEYFILE"
  npm run tauri build -- "$@"
else
  echo "==> No updater key at $KEYFILE — building without updater artifacts."
  echo "    Run scripts/setup-keys.sh to generate keys first."
  npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"
fi

# Tauri picks up APPLE_SIGNING_IDENTITY during bundling; the explicit re-sign in
# macos-codesign.sh then guarantees a valid deep signature regardless.
bash scripts/macos-codesign.sh
