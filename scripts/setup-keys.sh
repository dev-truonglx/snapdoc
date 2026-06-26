#!/usr/bin/env bash
#
# One-time setup: generate the Tauri updater signing key pair for SnapDoc and
# write the public key into tauri.conf.json. Run this ONCE on a new machine or
# when bootstrapping a fresh project.
#
# Output:
#   ~/.tauri/snapdoc-updater.key   (private key — NEVER commit this)
#   ~/.tauri/snapdoc-updater.key.pub   (public key — embedded in the app)
#
# The public key is written automatically to tauri.conf.json under
#   plugins.updater.pubkey
#
# Usage:
#   scripts/setup-keys.sh
#
# After running: commit tauri.conf.json (it now contains the public key).
# Backup the private key with scripts/backup-keys.sh.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

TAURI_DIR="$HOME/.tauri"
PRIV_KEY="$TAURI_DIR/snapdoc-updater.key"
PUB_KEY="$TAURI_DIR/snapdoc-updater.key.pub"
CONF="src-tauri/tauri.conf.json"

mkdir -p "$TAURI_DIR"

# ── 1) Generate keys if they don't exist ──────────────────────────────────────
if [ -f "$PRIV_KEY" ]; then
  echo "==> Private key already exists at $PRIV_KEY — skipping generation."
  echo "    Delete it first if you want to rotate keys (will break auto-update for existing users)."
else
  echo "==> Generating Tauri updater key pair…"
  # tauri signer generate -w <path> --ci (no password for local dev convenience)
  # The public key is written to <path>.pub automatically.
  npm run tauri -- signer generate -w "$PRIV_KEY" --ci

  echo "==> Key pair generated:"
  echo "    private: $PRIV_KEY"
  echo "    public:  $PUB_KEY"
fi

# ── 2) Read the public key ────────────────────────────────────────────────────
if [ ! -f "$PUB_KEY" ]; then
  echo "ERROR: Public key not found at $PUB_KEY" >&2
  echo "       Run: npm run tauri -- signer generate --output $PRIV_KEY" >&2
  exit 1
fi
PUBKEY_VALUE="$(cat "$PUB_KEY")"

# ── 3) Write public key into tauri.conf.json ──────────────────────────────────
echo "==> Writing public key into $CONF"
node -e '
  const fs = require("fs");
  const conf = JSON.parse(fs.readFileSync("'"$CONF"'", "utf8"));
  conf.plugins = conf.plugins || {};
  conf.plugins.updater = conf.plugins.updater || {};
  conf.plugins.updater.pubkey = '"$(printf '%s' "$PUBKEY_VALUE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"';
  fs.writeFileSync("'"$CONF"'", JSON.stringify(conf, null, 2) + "\n");
  console.log("pubkey written.");
'

echo
echo "============================================================"
echo " Done. Next steps:"
echo "  1. Commit tauri.conf.json (public key is safe to commit):"
echo "       git add src-tauri/tauri.conf.json"
echo "       git commit -m \"chore: add updater public key\""
echo "  2. Backup your private key:"
echo "       scripts/backup-keys.sh"
echo "  3. Build and release:"
echo "       scripts/release-all.sh v0.1.0"
echo
echo " ⚠  NEVER commit ~/.tauri/snapdoc-updater.key"
echo "============================================================"
