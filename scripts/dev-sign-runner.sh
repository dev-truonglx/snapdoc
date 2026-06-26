#!/usr/bin/env bash
#
# Cargo "runner" used by `npm run dev:mac`. Cargo invokes this with the freshly
# built dev binary as $1; we deep-sign it with the STABLE self-signed identity
# and then exec it. This runs on EVERY `tauri dev` rebuild, so the dev binary
# always carries the same code-signing designated requirement — which is what
# lets the macOS Accessibility (TCC) grant persist across rebuilds instead of
# being revoked each time cargo re-links the binary.
#
# Not meant to be called directly; see scripts/dev-mac.sh.
set -euo pipefail

BIN="$1"
shift

IDENTITY="${APPLE_SIGNING_IDENTITY:-Screen Translator Dev}"

# Force the SAME code-signing identifier as the bundled `build:mac` app
# (CFBundleIdentifier, e.g. me.truonglx.screentranslate). The macOS Accessibility
# (TCC) grant is keyed by the designated requirement = identifier + certificate;
# matching both here lets the dev binary reuse the grant you already gave the
# bundled app, instead of being treated as a separate app. Passed in by
# scripts/dev-mac.sh from tauri.conf.json.
ID_ARGS=()
[ -n "${APP_IDENTIFIER:-}" ] && ID_ARGS=(-i "$APP_IDENTIFIER")

# --force replaces the ad-hoc signature cargo just produced. Failure is
# non-fatal: a missing identity shouldn't block running the app (it just means
# Accessibility won't persist this run).
if ! codesign --force ${ID_ARGS+"${ID_ARGS[@]}"} --sign "$IDENTITY" "$BIN" >/dev/null 2>&1; then
  echo "==> WARN: could not sign dev binary with '$IDENTITY' — Accessibility may not persist." >&2
fi

exec "$BIN" "$@"
