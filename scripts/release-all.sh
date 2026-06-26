#!/usr/bin/env bash
#
# ONE-SHOT LOCAL RELEASE — builds macOS (native universal) + Windows (via Docker)
# and deploys both to the releases repo as a DRAFT GitHub release with a unified
# latest.json. No GitHub Actions needed. Publish the draft afterwards to ship.
#
# Usage:
#   scripts/release-all.sh v1.0.0
#
# Prerequisites (one-time):
#   • scripts/setup-keys.sh          (generate updater key + write pubkey to tauri.conf.json)
#   • gh auth login                  (account with push access to the releases repo)
#   • Docker Desktop running         (for Windows cross-build)
#   • macOS codesign identity at ~/.tauri/snapdoc-codesign.p12  (auto-created by dev-mac.sh)
#
# Output: a draft release at
#   https://github.com/dev-truonglx/snapdoc/releases
# with: SnapDoc_<ver>_universal.dmg, SnapDoc.app.tar.gz(+sig), SnapDoc_<ver>_x64-setup.exe(+sig), latest.json
# Publish it to trigger auto-update for all users.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

RELEASES_REPO="dev-truonglx/snapdoc"
TAG="${1:?usage: scripts/release-all.sh vX.Y.Z}"
VERSION="${TAG#v}"
KEYFILE="$HOME/.tauri/snapdoc-updater.key"

# ── Prerequisites ─────────────────────────────────────────────────────────────
command -v gh >/dev/null     || { echo "ERROR: gh not installed (brew install gh)"; exit 1; }
command -v node >/dev/null   || { echo "ERROR: node not found"; exit 1; }
command -v docker >/dev/null || { echo "ERROR: docker not installed"; exit 1; }
command -v rustup >/dev/null || { echo "ERROR: rustup not found"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: not logged in — run: gh auth login"; exit 1; }
docker info >/dev/null 2>&1    || { echo "ERROR: Docker daemon not running — start Docker Desktop."; exit 1; }
[ -f "$KEYFILE" ] || {
  echo "ERROR: updater signing key missing at $KEYFILE"
  echo "       Run: scripts/setup-keys.sh"
  exit 1
}
echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || {
  echo "ERROR: tag must be semver, e.g. v1.0.0"
  exit 1
}

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYFILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# ── 1) Sync version into the three manifests ──────────────────────────────────
echo "==> [1/6] Setting version to $VERSION"
VERSION="$VERSION" node -e '
  const fs = require("fs");
  const v = process.env.VERSION;

  // tauri.conf.json
  const cf = "src-tauri/tauri.conf.json";
  const j = JSON.parse(fs.readFileSync(cf));
  j.version = v;
  fs.writeFileSync(cf, JSON.stringify(j, null, 2) + "\n");

  // package.json
  const pf = "package.json";
  const p = JSON.parse(fs.readFileSync(pf));
  p.version = v;
  fs.writeFileSync(pf, JSON.stringify(p, null, 2) + "\n");

  // Cargo.toml — first [package] version only
  let c = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
  c = c.replace(/^version = "[^"]*"/m, "version = \"" + v + "\"");
  fs.writeFileSync("src-tauri/Cargo.toml", c);

  console.log("  version set to " + v + " in tauri.conf.json, package.json, Cargo.toml");
'

# ── 2) macOS universal (native, signed with the STABLE identity) ──────────────
# Sign with a fixed self-signed identity so the code-signing designated
# requirement stays constant across versions — that's what lets macOS keep
# the Screen Recording / Accessibility (TCC) grant when the app auto-updates.
echo "==> [2/6] Building macOS universal bundle (a few minutes)"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-SnapDoc Dev}"
bash scripts/macos-codesign.sh --ensure-only
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
npm install
npm run tauri build -- --target universal-apple-darwin

# Guard: refuse to ship if the updater payload is ad-hoc signed (that would
# break the TCC grant on every auto-update for all users).
MAC_DIR="src-tauri/target/universal-apple-darwin/release/bundle/macos"
MAC_APP="$MAC_DIR/SnapDoc.app"
MAC_TGZ="$MAC_DIR/SnapDoc.app.tar.gz"
DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"

check_signed() { # $1 = .app path, $2 = label
  if codesign -dvvv "$1" 2>&1 | grep -q "Signature=adhoc"; then
    echo "ERROR: $2 is ad-hoc signed — Tauri did not apply '$APPLE_SIGNING_IDENTITY'."
    echo "       Check: security find-identity -p codesigning"
    exit 1
  fi
  codesign --verify --deep --strict "$1" >/dev/null 2>&1 \
    || { echo "ERROR: $2 failed signature verification."; exit 1; }
  echo "    OK ($2): $(codesign -dvvv "$1" 2>&1 | grep '^Authority=' | head -1)"
}

echo "==> Verifying macOS code signature (on-disk bundle + updater payload)"
check_signed "$MAC_APP" "on-disk .app"
VERIFY_TMP="$(mktemp -d)"
tar -xzf "$MAC_TGZ" -C "$VERIFY_TMP"
check_signed "$VERIFY_TMP/SnapDoc.app" "updater .app.tar.gz payload"
rm -rf "$VERIFY_TMP"

# ── 3) Windows installer (Docker cross-build) ─────────────────────────────────
echo "==> [3/6] Building Windows installer in Docker (a few minutes)"
bash scripts/build-win-docker.sh

# ── 4) Collect artifacts into release_dist/ ───────────────────────────────────
echo "==> [4/6] Collecting artifacts"
rm -rf release_dist && mkdir -p release_dist

MAC="$MAC_DIR/SnapDoc.app.tar.gz"
MAC_SIG="$MAC.sig"
DMG="$DMG_DIR/SnapDoc_${VERSION}_universal.dmg"
EXE="dist-win/SnapDoc_${VERSION}_x64-setup.exe"
EXE_SIG="$EXE.sig"

for f in "$MAC" "$MAC_SIG" "$DMG" "$EXE" "$EXE_SIG"; do
  [ -f "$f" ] || {
    echo "ERROR: missing artifact: $f"
    echo "       Check build logs above."
    exit 1
  }
done
cp "$MAC" "$MAC_SIG" "$DMG" "$EXE" "$EXE_SIG" release_dist/

# ── 5) Unified updater manifest (all platforms) ───────────────────────────────
echo "==> [5/6] Generating latest.json"
BASE="https://github.com/${RELEASES_REPO}/releases/download/${TAG}"
VERSION="$VERSION" BASE="$BASE" MAC="$MAC" MAC_SIG="$MAC_SIG" EXE="$EXE" EXE_SIG="$EXE_SIG" node -e '
  const fs = require("fs"), path = require("path");
  // GitHub release assets replace spaces with dots in the URL.
  const norm = s => s.replace(/ /g, ".");
  const url  = f => process.env.BASE + "/" + norm(path.basename(f));
  const macSig = fs.readFileSync(process.env.MAC_SIG, "utf8").trim();
  const winSig = fs.readFileSync(process.env.EXE_SIG, "utf8").trim();
  const mac = { signature: macSig, url: url(process.env.MAC) };
  const out = {
    version: process.env.VERSION,
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": mac,
      "darwin-x86_64":  mac,
      "windows-x86_64": { signature: winSig, url: url(process.env.EXE) },
    },
  };
  fs.writeFileSync("release_dist/latest.json", JSON.stringify(out, null, 2) + "\n");
  console.log("  platforms: " + Object.keys(out.platforms).join(", "));
'

# ── 6) Create the draft release and upload everything ─────────────────────────
echo "==> [6/6] Creating draft release + uploading assets"
if ! gh release view "$TAG" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
  gh release create "$TAG" \
    --repo "$RELEASES_REPO" \
    --draft \
    --title "SnapDoc $TAG" \
    --notes "## What's new

<!-- describe changes here before publishing -->

**Full Changelog**: https://github.com/${RELEASES_REPO}/commits/${TAG}"
fi

# Upload all artifacts. .sig files are NOT uploaded separately — the updater
# reads signatures inline from latest.json. The .dmg and .exe are for fresh
# installs; the .app.tar.gz is the auto-update payload.
gh release upload "$TAG" --repo "$RELEASES_REPO" --clobber \
  "release_dist/$(basename "$MAC")" \
  "release_dist/$(basename "$EXE")" \
  "release_dist/$(basename "$DMG")" \
  "release_dist/latest.json"

echo
echo "============================================================"
echo " DONE. Review and PUBLISH the draft release to ship the update:"
echo "   https://github.com/${RELEASES_REPO}/releases"
echo
echo " Auto-update endpoint:"
echo "   https://github.com/${RELEASES_REPO}/releases/latest/download/latest.json"
echo "============================================================"
