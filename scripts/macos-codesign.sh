#!/usr/bin/env bash
#
# Deep-sign the SnapDoc macOS .app with a STABLE self-signed code-signing
# identity so the Screen Recording (TCC) permission the user grants PERSISTS
# across rebuilds. An ad-hoc / unsigned bundle gets a NEW code identity every
# build, so macOS revokes the grant and the app can only capture a black image
# until the user re-grants. A fixed self-signed cert gives a constant designated
# requirement, so the grant sticks.
#
# Usage:
#   scripts/macos-codesign.sh [path/to/SnapDoc.app]
#   scripts/macos-codesign.sh --ensure-only   # just make the identity available
#
# With no argument it signs the most recent SnapDoc.app under src-tauri/target.
# Identity name can be overridden with APPLE_SIGNING_IDENTITY.
set -euo pipefail

IDENTITY="${APPLE_SIGNING_IDENTITY:-SnapDoc Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# The identity is PERSISTED here as a PKCS#12 so EVERY build signs with the SAME
# key. That keeps the code-signing *designated requirement* stable, which is what
# lets macOS keep a Screen Recording (TCC) grant across rebuilds. If this key
# ever changes, you must re-grant Screen Recording — so back it up, never delete.
PERSIST_P12="${APPLE_SIGNING_P12:-$HOME/.tauri/snapdoc-codesign.p12}"
# Transport/at-rest password for the PKCS#12. Fixed so the file is reusable; this
# is a low-value self-signed dev identity (no Apple trust), so a static pass is OK.
P12PASS="${APPLE_SIGNING_P12_PASSWORD:-tauri-dev}"

create_and_persist() {
  echo "==> Creating + persisting self-signed code-signing identity: $IDENTITY"
  # Use the system openssl (LibreSSL). A Homebrew/Conda OpenSSL 3 writes a
  # PKCS#12 MAC that macOS `security import` rejects ("MAC verification failed").
  local OPENSSL=openssl
  [ -x /usr/bin/openssl ] && OPENSSL=/usr/bin/openssl
  local tmp
  tmp="$(mktemp -d)"
  cat > "$tmp/ext.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF
  "$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/ext.cnf" >/dev/null 2>&1
  "$OPENSSL" pkcs12 -export -out "$tmp/id.p12" \
    -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -passout "pass:$P12PASS" >/dev/null 2>&1
  mkdir -p "$(dirname "$PERSIST_P12")"
  cp "$tmp/id.p12" "$PERSIST_P12"
  chmod 600 "$PERSIST_P12"
  rm -rf "$tmp"
  echo "    persisted to $PERSIST_P12 — BACK THIS UP; reuse for all future builds."
}

# Guarantee the keychain holds EXACTLY the persisted identity (cert + private
# key). The persisted PKCS#12 is the single source of truth.
ensure_identity() {
  if [ ! -f "$PERSIST_P12" ]; then
    security delete-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1 || true
    create_and_persist
    # -A lets codesign use the key non-interactively.
    security import "$PERSIST_P12" -k "$KEYCHAIN" -P "$P12PASS" -A >/dev/null
    return 0
  fi
  if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY"; then
    return 0
  fi
  security delete-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1 || true
  security import "$PERSIST_P12" -k "$KEYCHAIN" -P "$P12PASS" -A >/dev/null
}

# `--ensure-only`: make the identity available (used before `tauri build` so
# Tauri signs the bundle with it), then exit without signing anything here.
if [ "${1:-}" = "--ensure-only" ]; then
  ensure_identity
  echo "==> Identity '$IDENTITY' ready."
  exit 0
fi

# Match BOTH debug and release bundle layouts.
find_app() {
  find src-tauri/target -maxdepth 6 -type d -path '*/bundle/macos/*.app' 2>/dev/null | head -1
}

APP="${1:-$(find_app)}"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "App bundle not found. Build it first (npm run dev:mac) or pass the .app path." >&2
  exit 1
fi

ensure_identity
echo "==> Signing: $APP"
codesign --force --deep --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "==> OK: signed with '$IDENTITY' and signature verified."
echo
echo "Next: grant Screen Recording once (System Settings > Privacy & Security >"
echo "Screen Recording), fully quit SnapDoc (pkill -f SnapDoc.app), then relaunch."
echo "The grant now persists across future signed builds."
