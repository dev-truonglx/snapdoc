#!/usr/bin/env bash
#
# Restore the signing keys from secrets/*.enc back into ~/.tauri/.
# Prompts for the passphrase used by scripts/backup-keys.sh.
#
#   secrets/snapdoc-updater.key.enc   → ~/.tauri/snapdoc-updater.key
#   secrets/snapdoc-codesign.p12.enc  → ~/.tauri/snapdoc-codesign.p12
#
# After restoring, the macOS code-signing identity is re-imported into your
# keychain automatically on the next build/release (scripts/macos-codesign.sh
# reads the restored .p12).
set -euo pipefail
cd "$(dirname "$0")/.."

OPENSSL=/usr/bin/openssl
TAURI_DIR="$HOME/.tauri"
ENC_UPDATER="secrets/snapdoc-updater.key.enc"
ENC_CODESIGN="secrets/snapdoc-codesign.p12.enc"

[ -f "$ENC_UPDATER" ]  || { echo "ERROR: missing $ENC_UPDATER";  exit 1; }
[ -f "$ENC_CODESIGN" ] || { echo "ERROR: missing $ENC_CODESIGN"; exit 1; }
mkdir -p "$TAURI_DIR"

read -rs -p "Passphrase: " PASS; echo
[ -n "$PASS" ] || { echo "ERROR: empty passphrase"; exit 1; }

decrypt() { # $1 enc, $2 dest
  local enc="$1" dest="$2" ans
  if [ -f "$dest" ]; then
    read -r -p "$dest exists — overwrite? [y/N] " ans
    case "$ans" in y|Y) ;; *) echo "  skipped $dest"; return 0 ;; esac
  fi
  printf '%s\n' "$PASS" | "$OPENSSL" enc -d -aes-256-cbc -pbkdf2 -pass stdin -in "$enc" -out "$dest" \
    || { echo "ERROR: decryption failed (wrong passphrase?)"; rm -f "$dest"; exit 1; }
  chmod 600 "$dest"
  echo "  ✓ $dest"
}

echo "Restoring to $TAURI_DIR …"
decrypt "$ENC_UPDATER"  "$TAURI_DIR/snapdoc-updater.key"
decrypt "$ENC_CODESIGN" "$TAURI_DIR/snapdoc-codesign.p12"

echo
echo "Done. Next build/release will re-import the macOS identity from the .p12."
