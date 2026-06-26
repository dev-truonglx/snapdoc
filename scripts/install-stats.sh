#!/usr/bin/env bash
#
# Install / usage stats from GitHub Release download counts. No telemetry in the
# app — this only reads public download_count from the releases repo API.
#
# Usage:
#   scripts/install-stats.sh [--json] [owner/repo]
#
# Env:
#   GITHUB_TOKEN   optional; raises the API rate limit (60 -> 5000/h) and is
#                  required if the releases repo is private.
#   RELEASES_REPO  override the default repo (or pass it as the last argument).
set -euo pipefail

JSON=0
REPO_ARG=""
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    *) REPO_ARG="$a" ;;
  esac
done

REPO="${REPO_ARG:-${RELEASES_REPO:-dev-truonglx/snapdoc}}"
if [ -z "${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  export GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
fi
JSON="$JSON" REPO="$REPO" TOKEN="${GITHUB_TOKEN:-}" python3 - <<'PY'
import json, os, sys, urllib.request, urllib.error

repo = os.environ["REPO"]
token = os.environ.get("TOKEN", "")
as_json = os.environ.get("JSON") == "1"

def api(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "install-stats",
        **({"Authorization": f"Bearer {token}"} if token else {}),
    })
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r), r.headers
    except urllib.error.HTTPError as e:
        sys.stderr.write(f"GitHub API error {e.code} for {url}\n{e.read().decode()[:300]}\n")
        if e.code in (403, 401):
            sys.stderr.write("Hint: set GITHUB_TOKEN to raise the rate limit / access a private repo.\n")
        sys.exit(1)

# Paginate releases.
releases = []
page = 1
while True:
    batch, _ = api(f"https://api.github.com/repos/{repo}/releases?per_page=100&page={page}")
    if not batch:
        break
    releases.extend(batch)
    if len(batch) < 100:
        break
    page += 1

def classify(name):
    n = name.lower()
    if n.endswith(".dmg"):           return "dmg"          # mac fresh install
    if n.endswith(".msi"):           return "msi"          # win fresh install (MSI)
    if n.endswith("-setup.exe"):     return "exe"          # win install + auto-update
    if n.endswith(".exe"):           return "exe"
    if n.endswith(".app.tar.gz"):    return "mac_update"   # mac auto-update artifact
    if n == "latest.json":           return "checks"       # update poll ~ launches
    if n.endswith(".sig"):           return "sig"
    return "other"

per_release = []
tot = {k: 0 for k in ("dmg", "msi", "exe", "mac_update", "checks", "sig", "other")}
for r in releases:
    counts = {k: 0 for k in tot}
    for a in r.get("assets", []):
        counts[classify(a["name"])] += a.get("download_count", 0)
    for k in tot:
        tot[k] += counts[k]
    per_release.append({
        "tag": r.get("tag_name"),
        "draft": r.get("draft"),
        "prerelease": r.get("prerelease"),
        "counts": counts,
    })

installs_clean = tot["dmg"] + tot["msi"]
installs_with_exe = installs_clean + tot["exe"]

if as_json:
    print(json.dumps({
        "repo": repo,
        "installs_clean": installs_clean,        # dmg + msi (updater never touches these)
        "windows_exe": tot["exe"],               # fresh installs + auto-updates mixed
        "installs_approx_total": installs_with_exe,
        "mac_updates": tot["mac_update"],
        "update_checks": tot["checks"],          # ~ launches / active machines
        "totals": tot,
        "releases": per_release,
    }, indent=2))
    sys.exit(0)

W = 10
def row(label, c):
    print(f"  {label:<26} dmg={c['dmg']:<4} msi={c['msi']:<4} exe={c['exe']:<5} "
          f"mac_upd={c['mac_update']:<4} checks={c['checks']:<4}")

print(f"\nInstall / usage stats — {repo}\n" + "=" * 60)
for pr in per_release:
    flags = []
    if pr["draft"]: flags.append("draft")
    if pr["prerelease"]: flags.append("prerelease")
    tag = pr["tag"] + (f" [{','.join(flags)}]" if flags else "")
    print(f"\n{tag}")
    row("", pr["counts"])

print("\n" + "=" * 60)
print(f"  Cài mới SẠCH (dmg+msi, không lẫn update) : {installs_clean}")
print(f"  Windows -setup.exe (cài mới + update)     : {tot['exe']}")
print(f"  → Lượt cài gần đúng (gồm exe)            : {installs_with_exe}")
print(f"  Auto-update macOS (.app.tar.gz)          : {tot['mac_update']}")
print(f"  Lượt check update (~ lượt mở/máy active) : {tot['checks']}")
print("\nLưu ý: đây là LƯỢT TẢI, không phải máy duy nhất (tải lại/mirror/bot đều tính).")
print("'-setup.exe' lẫn cài mới + auto-update nên không tách bạch tuyệt đối được.")
print("Muốn đếm máy duy nhất cần telemetry (đã loại theo lựa chọn).")
PY
