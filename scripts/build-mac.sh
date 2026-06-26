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
