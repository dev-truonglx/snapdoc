# Linux image that cross-builds the Windows NSIS installer for Screen Translator.
# Used because the macOS arm64 Homebrew `makensis` bottle is broken (crashes with
# std::bad_alloc), while Debian's NSIS works fine. The Rust half cross-compiles
# to x86_64-pc-windows-msvc via cargo-xwin (same as on macOS).
FROM node:22-bookworm

# unzip: scripts/fetch-ffmpeg.mjs cần giải nén .zip trong beforeBuildCommand
# (Debian's GNU tar không tự giải nén .zip như bsdtar trên macOS/Windows).
RUN apt-get update && apt-get install -y --no-install-recommends \
      nsis clang lld llvm pkg-config curl ca-certificates build-essential rsync unzip \
    && rm -rf /var/lib/apt/lists/*

# Rust + the Windows MSVC target + cargo-xwin (downloads the MS CRT/SDK at build).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup target add x86_64-pc-windows-msvc && cargo install cargo-xwin

# The Tauri CLI probes the Linux host for an appindicator library (tray-icon
# feature) even when cross-compiling to Windows, and panics if it's absent.
# Installed as a separate layer so it doesn't invalidate the cargo-xwin layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libayatana-appindicator3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
