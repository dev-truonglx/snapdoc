#!/usr/bin/env bash
#
# Encrypt the two signing keys to secrets/*.enc so they can be committed to git
# SAFELY. The RAW keys must NEVER be committed — only the encrypted .enc files.
#
#   ~/.tauri/snapdoc-updater.key    → secrets/snapdoc-updater.key.enc
#   ~/.tauri/snapdoc-codesign.p12   → secrets/snapdoc-codesign.p12.enc
#
# You are prompted for ONE passphrase (AES-256, PBKDF2). Store it in a password
# manager — it is the ONLY thing protecting these keys and it is NOT in git.
# Restore with scripts/restore-keys.sh.
#
# ⚠️  The updater key is the auto-update trust root: whoever can decrypt it can
#     push a malicious update to ALL users. Use a STRONG passphrase.
set -euo pipefail
cd "$(dirname "$0")/.."

OPENSSL=/usr/bin/openssl   # LibreSSL on macOS; supports -pbkdf2
TAURI_DIR="$HOME/.tauri"
SRC_UPDATER="$TAURI_DIR/snapdoc-updater.key"
SRC_CODESIGN="$TAURI_DIR/snapdoc-codesign.p12"

[ -f "$SRC_UPDATER" ]  || { echo "ERROR: missing $SRC_UPDATER  (run scripts/setup-keys.sh first)"; exit 1; }
[ -f "$SRC_CODESIGN" ] || { echo "ERROR: missing $SRC_CODESIGN (run scripts/dev-mac.sh once first to create it)"; exit 1; }
mkdir -p secrets

read -rs -p "Passphrase (won't echo): " PASS; echo
read -rs -p "Confirm passphrase:      " PASS2; echo
[ -n "$PASS" ]         || { echo "ERROR: empty passphrase"; exit 1; }
[ "$PASS" = "$PASS2" ] || { echo "ERROR: passphrases do not match"; exit 1; }

# Encrypt, then immediately decrypt-and-compare to catch a bad write/typo before
# you rely on the backup. Passphrase is fed via stdin (never argv/env).
encrypt_verify() { # $1 src, $2 out
  local src="$1" out="$2" tmp
  printf '%s\n' "$PASS" | "$OPENSSL" enc -aes-256-cbc -pbkdf2 -salt -pass stdin -in "$src" -out "$out"
  tmp="$(mktemp)"
  printf '%s\n' "$PASS" | "$OPENSSL" enc -d -aes-256-cbc -pbkdf2 -pass stdin -in "$out" -out "$tmp"
  cmp -s "$src" "$tmp" || { rm -f "$tmp" "$out"; echo "ERROR: verify failed for $src"; exit 1; }
  rm -f "$tmp"
  echo "  ✓ $out"
}

echo "Encrypting…"
encrypt_verify "$SRC_UPDATER"  "secrets/snapdoc-updater.key.enc"
encrypt_verify "$SRC_CODESIGN" "secrets/snapdoc-codesign.p12.enc"

echo
echo "Done. Commit the encrypted backups:"
echo "  git add secrets/*.enc && git commit -m 'chore: encrypted key backups'"
echo "Keep the passphrase in a password manager — without it the backups are useless."
