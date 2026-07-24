# Security Policy

## Supported versions

SnapDoc is a rolling-release desktop app — only the latest published release
is supported. Please make sure you're on the latest version (Settings →
Check for updates) before reporting an issue.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report it privately via GitHub's
[private vulnerability reporting](../../security/advisories/new) feature on
this repository, or by emailing the maintainer directly. Include:

- A description of the vulnerability and its impact.
- Steps to reproduce (OS + version, SnapDoc version).
- Any relevant logs or proof-of-concept.

You should get an acknowledgement within a few days. Once a fix is available,
we'll coordinate disclosure timing with you and credit you in the release
notes (unless you prefer to stay anonymous).

## Scope notes specific to SnapDoc

A few areas are worth flagging explicitly since they're the highest-impact
attack surface for a desktop app like this:

- **Auto-update integrity**: releases are signed with a minisign keypair
  (`tauri-plugin-updater`); the public key is embedded in
  `src-tauri/tauri.conf.json` and update artifacts are fetched over HTTPS
  from GitHub Releases. The private signing key is never committed to this
  repository — see [BUILD.md](BUILD.md#signing-keys) — and is held only by
  maintainers. If you find a way to get the app to accept an update package
  that doesn't verify against the embedded public key, that's a critical
  report.
- **Clipboard / filesystem access**: SnapDoc writes captured images/video to
  disk and to the OS clipboard. Path handling for save locations and
  filenames (`src-tauri/src/storage/`) is in scope.
- **Local IPC surface**: the Tauri command surface (`src-tauri/src/commands.rs`
  and friends) is the boundary between the webview and native code —
  anything that lets webview-side content invoke a command outside its
  intended permissions is in scope.

Third-party dependency vulnerabilities (npm/cargo advisories) are welcome
too, but please check `npm audit` / `cargo audit` first so we're not
duplicating an already-tracked upstream issue.
