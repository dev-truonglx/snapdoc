# Contributing to SnapDoc

Thanks for your interest in contributing! This document covers how to get a
local dev environment running, coding conventions, and the PR process.

For how to install signing keys and produce a release build, see
[BUILD.md](BUILD.md). This file only covers day-to-day development (no
signing keys required).

## Prerequisites

- Node.js ≥ 20, npm
- Rust ≥ 1.80 (toolchain via [rustup](https://rustup.rs))
- macOS: grant **Screen Recording** permission (System Settings → Privacy &
  Security) to your terminal/app when running dev builds.
- Windows: no extra permission needed; requires the WebView2 runtime (usually
  preinstalled on Windows 10/11).

## Getting started

```bash
npm install
npm run app:dev      # = tauri dev — builds Rust + starts Vite with HMR
```

The app has no main window — it starts in the tray / menu bar.

### macOS: keeping Screen Recording permission across rebuilds

`tauri dev` produces an ad-hoc signed binary whose code identity changes on
every build, so macOS revokes the Screen Recording permission each time
(captures come back black). For UI-only iteration, `npm run app:dev` (with
HMR) is fine and you just re-grant permission when needed. If you're touching
capture/recording code and want the grant to persist across rebuilds, use:

```bash
npm run dev:mac       # builds a debug .app signed with a stable local identity
```

See [BUILD.md](BUILD.md#macos-dev-signing) for details — this does not
require the release signing keys, only a throwaway local identity that
`scripts/dev-mac.sh` creates automatically.

## Project structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full breakdown of the frontend
(`src/`) and backend (`src-tauri/`) layout, and the design rationale behind
the multi-window capture UX.

## Coding conventions

- **TypeScript/React**: functional components, hooks-based state
  (`zustand` for global state). Keep annotation tools in
  `src/features/annotation/tools/` — one file per tool.
- **Rust**: OS-specific capture code stays behind the platform module it
  belongs to (`capture/mac_sck.rs`, `capture/window.rs`, etc.) — don't
  branch on `cfg(target_os)` deep inside shared logic if it can live in a
  platform file instead.
- Run `npm run build` (`tsc --noEmit` + `vite build`) before opening a PR —
  it catches type errors that `vite dev` won't.
- No unrelated formatting/reflow changes in a PR — keep diffs focused on the
  change you're making.

## Commit messages

Keep them short and in the imperative mood ("fix scroll capture race", not
"fixed" or "fixes"). Reference the issue number when applicable.

## Submitting a pull request

1. Fork the repo and create a branch from `main`.
2. Make your change, with a focused diff and no unrelated changes.
3. Make sure `npm run build` passes and you've manually tested the affected
   flow (capture, record, editor, library, etc. — whichever you touched).
4. Open a PR describing **what** changed and **why**. Screenshots/recordings
   are very welcome for UI changes.
5. CI builds macOS + Windows on every PR. A maintainer will review; release
   builds (signed installers, auto-update artifacts) are only produced by
   maintainers from `main` — contributors don't need signing keys to develop
   or send PRs.

## Reporting bugs / requesting features

Use GitHub Issues. For bugs, include: OS + version, SnapDoc version, repro
steps, and (if relevant) whether it involves multi-monitor/HiDPI setups.

## Security issues

Please do **not** open a public issue for security vulnerabilities — see
[SECURITY.md](SECURITY.md) instead.
